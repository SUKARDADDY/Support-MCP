// Session Durable Object (SQLite-backed), one per pairing code (DO name = code).
// State machine: pending -> consumed -> attached -> ended (terminal).
// Uses the WebSocket Hibernation API for the agent socket and a DO alarm for
// expiry. In-flight MCP command fetches keep the DO awake, so the in-memory
// pending-result map survives for the duration of each await.
//
// Sockets are tagged with an attach generation (`g<n>`); storage `ws_tag` names
// the current one. Commands go only to the current socket; end/expire reach
// every socket so a half-dead predecessor can never swallow them.
//
// A session has a Windows mode, fixed at creation. `powershell` sessions use the
// WebSocket above. `app` sessions (the downloaded Windows app) use authenticated
// HTTPS polling on /agent instead: one long poll per client, one command in
// flight per lane, and an `http<n>` generation tag in place of the socket tag.
//
// An app client that reports the `lanes` cap runs two lanes at once: `cmd`
// (run, put_file, get_file) and `screen` (screen and control frames). An older
// client without it keeps one lane and cannot do screen work. The `cmd` lane also takes the `power` and
// `programs` frames of restart_pc, shutdown_pc and the program tools, on a saved PC only.
//
// A saved-PC session (created with a device_id) is a third kind. It starts in
// `waiting` (the PC must pick it up and the person at it answer within 510 s),
// then `attached`, then `ended`. It has no attach key: the Worker authenticates
// the PC's device key against the database and forwards each /agent request
// with the device id, which this object checks against the one stored at create.
// One technician drives at a time (`driver`); a command from anyone else is
// refused, and /takeover moves the driver. The session lasts 24 hours from the
// first hello with no idle timeout. When it ends it clears the PC's session
// pointer and writes the team log row, retrying from its alarm until that works.
// /consume and /j/ refuse it.
//
// A one-off link session made by a team member has a driver too: its creator. It is
// stored like a saved PC's, and the same refusal applies to everyone else's commands. The
// driver is never sent to the PC (poll answers and the welcome carry it for a saved PC only),
// so the person at a one-off PC keeps seeing the generic notice and never a technician's
// name. A session whose storage has no driver key (made before this rule, or in open mode)
// keeps today's behaviour: any holder of sessions.control may command it.
//
// A session also keeps who else is on it: people the driver invited (`invited`), those who
// joined (`watcher`), one pending offer of control, and the last handover. Those live in
// this object's storage and end with the session. The last full screenshot is held in
// memory only (this.frame), never in storage, replaced by no zoom, and dropped when the
// session ends or the object is evicted.
//
// On a saved PC, the team's rules (src/rules.js) are enforced here before a command is queued. For each
// guarded command (restart_pc, shutdown_pc, install_program, uninstall_program, close_program, put_file,
// get_file) the Session reads the rules in force for that PC from the database, every time and never cached,
// and decides: refuse with a code, allow, or wait for a technician's approval. The decision is made before the
// command lane is taken, so a waiting approval blocks nothing else. Every guarded frame carries rules_tag (the
// PC compares it with its own), decided_at (the relay's time of the decision, Unix seconds) and, when a
// technician approved it, approved_by. One approval waits at a time. It is kept in this object's storage and
// in memory, answered through /approvals (src/approvals.js checks who may answer), and cancelled by a handover,
// a take-over, the end of the session or the built-in agent's Stop or Pause. An object restart drops it unsent.
//
// A session belongs to the team workspace that created it (`workspace`, stored
// at create; a session without one is in "default"). Operator calls to
// /status, /command and /end name their workspace, and a call from another
// workspace gets exactly the answer for a session that does not exist. Calls
// that name none (the download page, consume, the app) skip the check.

import { registryName } from './registry.js';
import { identityKind, normalizeIdentity, teamFromEnv } from './workspace.js';
import { ID_RE, MIN_SESSION_VERSION, devicesFromEnv } from './devices.js';
import { notifyStore } from './notify.js';
import { accountStore } from './accounts.js';
import { assertPersonActive, assertSecondFactor } from './oauth.js';
import { agentStoreFromEnv } from './agent-store.js';
import { UNATTENDED_PERMISSION } from './permissions.js';
import { compareVersions, validVersion } from './release.js';
import { REFUSALS, decide, installArgsProblem, installerProblem, isAppProgramId, localAbsolutePath } from './rules.js';
import { OPERATOR_END_REASONS } from './device-sessions.js';
import { VERSION_PATTERN } from './version.js';
import {
  LANES, auditText, decodeCaps, decodeControl, decodeControlResult, decodePollReport,
  decodeScreenResult, normalizeAction,
} from './screen.js';

const CODE_TTL_MS = 10 * 60 * 1000; // pending -> consume window
// consumed -> first attach window. src/agent.ps1 writes the same two hours into
// config.json as `connect_by`, so an agent that never connects also stops itself.
// Change both together.
const CONSUMED_TTL_MS = 2 * 60 * 60 * 1000;
const ATTACHED_LIFE_MS = 24 * 60 * 60 * 1000; // attach -> expiry, fixed
const WAITING_MS = 510 * 1000; // saved PC: create -> the PC has picked it up and answered
const STOP_CHECK_MS = 20 * 1000; // at most this often a poll reads whether the workspace is stopped
const STOP_ALARM_MS = 30 * 1000; // an attached PowerShell session wakes this often to check, since a quiet socket sends nothing
const SCREENSHOT_FOLD_MS = 60 * 1000; // a screenshot this soon after the same person's last one joins its log row
const CLEANUP_RETRY_MS = 30 * 1000; // a saved-PC session retries clearing its pointer this often
const OFFER_MS = 2 * 60 * 1000; // an offer of control lasts this long
const ACCEPTING_MS = 30 * 1000; // an accept or a claim holds the session this long while the PC's record changes
const PEOPLE_MAX = 20; // people on a session besides its driver, invited or watching
const DECLINE_REASONS = ['declined', 'nobody', 'busy']; // what a PC may say before hello
const RESULT_SLACK_MS = 15 * 1000; // relay waits timeout_s + this
const HTTP_SEEN_MS = 60 * 1000; // app mode: a client counts as attached this long after its last request
const POLL_PARK_MS = 25 * 1000; // app mode: a long poll with nothing to send ends after this long
const REDELIVER_MS = 5 * 1000; // app mode: a frame already sent is not sent again sooner than this
const SCREEN_WAIT_MS = 30 * 1000; // screen frame: base wait for the app's result
const CONTROL_WAIT_MS = 120 * 1000; // request_full_control: UAC and the customer's dialogs
const LANE_OF = { run: 'cmd', put_file: 'cmd', get_file: 'cmd', power: 'cmd', programs: 'cmd', screen: 'screen', control: 'screen' };
const APPROVAL_MS = 5 * 60 * 1000; // a technician has this long to answer an approval
const CATCH_UP_MS = 15 * 1000; // the PC may spend this long on a check-in before it decides a frame that carries a rules tag (Rules.CatchUpMs)
const LANE_STEP_MS = 100; // how often a waiting approved command looks at its lane
const LANE_WAIT_MS = 60 * 1000; // an approved command waits this long for a busy lane before it gives the approval up
const PROGRAM_NAME_MAX = 260;
const PROGRAMS_TTL_MS = 10 * 60 * 1000; // how long a list_programs result stands in for the PC's programs
const CONTROL_TEXT = /[\u0000-\u001f\u007f]/;
// Refusals the rules do not make: the codes of the other checks of the tools (src/mcp.js REFUSAL_CODES).
const EXTRA_REFUSALS = {
  declined: 'a technician declined this action',
  approval_timeout: 'no technician answered within 5 minutes',
  approval_unavailable: 'nobody can approve this here',
  busy: 'the PC is busy with another command',
  rules_stale: 'the team\'s rules could not be read; try again',
  not_found: 'no such approval',
  not_saved_pc: 'this tool works only in a session on a saved PC, and the team\'s rules apply there only',
  needs_update: `this PC runs an older Support app than ${MIN_SESSION_VERSION}; it updates itself, then connect again`,
};
const NO_SCREEN_PS = 'the PowerShell fallback has no screen access';
const NO_SCREEN_OLD = 'this support app is too old for screen control';
const NO_SCREEN_CONSENT = 'the customer has not approved screen control for this session';
// The app types one character every 20 ms (Screen.TypeGapMs in src/agent-app.cs) and measures about 21 ms per
// character. Windows 11 can ignore the app's 1 ms timer request, for example for a minimized window, and then a
// character takes about 31 ms. The relay waits 35 ms for each.
const TYPE_MS_PER_CHAR = 35;
const FULL_ONLY = ['block_input', 'send_sas'];
const DEFAULT_WORKSPACE = 'default';
const WORKSPACE_RE = /^[a-z0-9-]{1,40}$/;
export const GET_FILE_MAX = 524288; // bytes per get_file chunk
export const PUT_B64_MAX = 700000; // data_b64 chars per put_file chunk (~512 KiB)

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hex32() {
  const u = new Uint8Array(32);
  crypto.getRandomValues(u);
  return [...u].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Which stored deadline governs each live state, and the `ended` reason used
// when it passes.
const DEADLINES = {
  waiting: ['waiting_expires_at', 'timed_out'],
  pending: ['code_expires_at', 'code TTL'],
  consumed: ['consumed_expires_at', 'consume TTL'],
  attached: ['expires_at', 'expired'],
};

export class Session {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.pending = new Map(); // uuid -> {resolve, tag}
    this.held = new Set(); // approved commands not yet sent: from the technician's answer to the send, so a cancel reaches them (see holdApproved)
    this.laneWaitMs = LANE_WAIT_MS; // how long an approved command waits for a busy lane (a test may shorten it)
    this.httpCommands = { cmd: null, screen: null }; // app mode: per lane, {frame, tag, sent_at} waiting for its result
    this.httpPoll = null; // app mode: the parked long poll, if any, {resolve, timer, busy}
    this.gen = 0; // the driver generation (see applyDriver); read with the driver
    this.driver = undefined; // who drives (undefined: not read yet, null: nobody; a one-off session may have none)
    this.device = false; // a saved-PC session (read with the driver)
    this.people = undefined; // participants, offer, accepting, handed_over: read once, then kept here and in storage
    this.frame = null; // the last full screenshot { rev, at, mime, data }, in memory only: never in storage
    this.frameRev = 0;
    this.over = false; // the session ended: no picture is kept after that
    this.approval = undefined; // the waiting approval { rec, resolve, timer } (undefined: not read yet, null: none); memory only, see loadDriver
    this.programs = { byId: new Map(), byPid: new Map(), at: 0 }; // names from the last list_programs result: for the rules' name checks and the approval summary
    this.stopCheckedAt = 0; // when a poll last read whether the workspace is stopped
    this.sql.exec(`CREATE TABLE IF NOT EXISTS log(ts INTEGER, kind TEXT, detail TEXT)`);
  }

  // ---- state helpers -------------------------------------------------------
  async get(k, d) {
    const v = await this.ctx.storage.get(k);
    return v === undefined ? d : v;
  }
  async setMany(obj) {
    await this.ctx.storage.put(obj);
  }
  logRow(kind, detail = '', actor = null) {
    const d = actor ? `[${actor}] ${detail}`.trimEnd() : detail;
    this.sql.exec(`INSERT INTO log(ts,kind,detail) VALUES(?,?,?)`, Date.now(), kind, d);
  }

  // A screenshot for the session log. The app takes one every few seconds while a tab
  // is open, so a screenshot that is the same person's, of the same size and display, and
  // follows the log's last row (itself such a screenshot) within a minute is added to
  // that row's count instead of a new row: "screenshot 1280x800 (x3)". The row's time
  // moves to the latest one. Nothing else is ever merged.
  logScreenshot(text, actor) {
    const base = `${actor ? `[${actor}] ` : ''}${text}`;
    const now = Date.now();
    const [last] = this.sql.exec(`SELECT ts,kind,detail FROM log ORDER BY rowid DESC LIMIT ?`, 1).toArray();
    const rest = last && last.kind === 'screen' && now - last.ts <= SCREENSHOT_FOLD_MS && last.detail.startsWith(base) ? last.detail.slice(base.length) : null;
    const folded = rest === '' ? 1 : rest === null ? null : /^ \(x(\d+)\)$/.exec(rest);
    if (folded === null || folded === undefined) {
      this.logRow('screen', text, actor);
      return;
    }
    const count = (folded === 1 ? 1 : Number(folded[1])) + 1;
    this.sql.exec(`UPDATE log SET ts = ?, detail = ? WHERE rowid = (SELECT MAX(rowid) FROM log)`, now, `${base} (x${count})`);
  }

  async pushRegistry() {
    const s = await this.ctx.storage.get([
      'code', 'sid', 'label', 'state', 'machine', 'user', 'expires_at', 'created_at', 'workspace',
    ]);
    try {
      // The session reports to its own workspace's Registry object.
      const registry = this.env.REGISTRY.idFromName(registryName(s.get('workspace') ?? DEFAULT_WORKSPACE));
      await this.env.REGISTRY.get(registry).fetch(
        'https://do/update',
        {
          method: 'POST',
          body: JSON.stringify({
            code: s.get('code'), sid: s.get('sid'), label: s.get('label'),
            state: s.get('state'), machine: s.get('machine'), user: s.get('user'),
            expires_at: s.get('expires_at'), created_at: s.get('created_at'),
          }),
        },
      );
    } catch (_) {
      // registry is best-effort; never fail a session op because of it
    }
  }

  // The socket of the latest attach, or null. Never an older generation.
  async currentSocket() {
    const tag = await this.get('ws_tag');
    if (!tag) return null;
    const list = this.ctx.getWebSockets(tag);
    return list.length ? list[0] : null;
  }

  socketTag(ws) {
    try {
      const tags = this.ctx.getTags(ws);
      return tags && tags.length ? tags[0] : null;
    } catch (_) {
      return null;
    }
  }

  // Send `frame` to EVERY socket (current and stale) and close them all.
  closeAll(frame, reason) {
    this.replyToPoll(frame || { type: 'end', reason });
    const txt = frame ? JSON.stringify(frame) : null;
    for (const ws of this.ctx.getWebSockets()) {
      if (txt) {
        try {
          ws.send(txt);
        } catch (_) {}
      }
      try {
        ws.close(1000, reason);
      } catch (_) {}
    }
  }

  // Resolve pending MCP requests with an error. pred(entry) selects which.
  failPending(pred, error) {
    for (const [id, p] of this.pending) {
      if (pred(p)) {
        this.pending.delete(id);
        p.resolve({ ok: false, error });
        this.clearCommand(id);
      }
    }
  }

  clearCommand(id) {
    for (const lane of LANES) if (this.httpCommands[lane]?.frame.id === id) this.httpCommands[lane] = null;
  }

  ttlMs(def) {
    // dev override, gated by the Worker at /create time (localhost only)
    return this._ttlOverride && this._ttlOverride > 0 ? this._ttlOverride : def;
  }

  async loadTtlOverride() {
    if (this._ttlOverride === undefined) this._ttlOverride = (await this.get('ttl_ms', 0)) || 0;
    return this._ttlOverride;
  }

  // True when an operator call names a workspace other than this session's.
  async otherWorkspace(workspace) {
    if (workspace === undefined || workspace === null) return false;
    return workspace !== (await this.get('workspace', DEFAULT_WORKSPACE));
  }

  async deadlineFor(state) {
    const d = DEADLINES[state];
    if (!d) return null;
    const v = await this.get(d[0]);
    return typeof v === 'number' ? v : null;
  }

  // Inline expiry: if the current state's deadline has passed, end the
  // session now (the alarm may not have fired yet). Returns true if ended.
  async expireIfDue() {
    const state = await this.get('state');
    const dl = await this.deadlineFor(state);
    if (dl !== null && Date.now() >= dl) {
      await this.expire(await this.expiryReason(state));
      return true;
    }
    return false;
  }

  // Why a state's deadline ended the session. A saved PC's 24 hours is max_time.
  async expiryReason(state) {
    return state === 'attached' && (await this.get('device_id', null)) ? 'max_time' : DEADLINES[state][1];
  }

  // ---- routing -------------------------------------------------------------
  async fetch(request) {
    const url = new URL(request.url);
    const p = url.pathname;
    await this.loadTtlOverride();
    await this.loadDriver();
    try {
      if (p === '/create') return await this.doCreate(request);
      if (p === '/consume') return await this.doConsume(request);
      if (p === '/agent') return await this.doAgent(request);
      if (p === '/ws') return await this.doWs(request);
      if (p === '/status') return await this.doStatus(url);
      if (p === '/command') return await this.doCommand(request);
      if (p === '/end') return await this.doEnd(request);
      if (p === '/takeover') return await this.doTakeover(request);
      if (p === '/watch') return await this.doWatch(url);
      if (p === '/people') return await this.doPeople(request);
      if (p === '/handover') return await this.doHandover(request);
      if (p === '/approvals') return await this.doApprovals(request);
      if (p === '/frame') return await this.doFrame(url);
    } catch (e) {
      return Response.json({ ok: false, error: String(e && e.message ? e.message : e) }, { status: 500 });
    }
    return new Response('not found', { status: 404 });
  }

  async doCreate(request) {
    const b = await request.json();
    const windowsMode = b.windows_mode ?? 'powershell';
    if (!['powershell', 'app'].includes(windowsMode)) {
      return Response.json({ ok: false, error: 'bad windows mode' }, { status: 400 });
    }
    // A DO name is a fresh 80-bit code, so existing state means a collision or
    // a replay; never overwrite a live or ended session.
    if ((await this.get('state')) !== undefined) {
      return Response.json({ ok: false, error: 'session already exists' }, { status: 409 });
    }
    const workspace = b.workspace ?? DEFAULT_WORKSPACE;
    if (typeof workspace !== 'string' || !WORKSPACE_RE.test(workspace)) {
      return Response.json({ ok: false, error: 'bad workspace' }, { status: 400 });
    }
    const now = Date.now();
    this.people.created_at = now;
    this._ttlOverride = Number(b.ttl_ms) > 0 ? Number(b.ttl_ms) : 0;
    // A saved PC's session: no link, no key, no consume. It waits for the PC.
    const device = b.device_id !== undefined;
    if (device) {
      if (typeof b.device_id !== 'string' || !ID_RE.test(b.device_id) || typeof b.driver !== 'string' || !b.driver || windowsMode !== 'app') {
        return Response.json({ ok: false, error: 'bad device session' }, { status: 400 });
      }
      const waitingUntil = now + this.ttlMs(WAITING_MS);
      this.driver = sameIdentity(b.driver);
      this.device = true;
      this.people.driver_since = now;
      await this.setMany({
        code: b.code, sid: b.sid, label: b.label ?? null, state: 'waiting', created_at: now, created_by: b.actor ?? null,
        workspace, waiting_expires_at: waitingUntil, ttl_ms: this._ttlOverride, machine: null, user: null, ps: null,
        windows_mode: 'app', transport: null, http_generation: 0, http_seen_at: 0, elevated: null, expires_at: null, ws_gen: 0,
        device_id: b.device_id, device_name: truncate(String(b.device_name ?? ''), 100), driver: this.driver, driver_since: now,
        // The built-in agent task whose connect made this session, so a task finds its own after a crash.
        opened_by_task: typeof b.opened_by_task === 'string' ? truncate(b.opened_by_task, 64) : null,
      });
      this.logRow('created', `device ${b.device_id}`, b.actor);
      await this.ctx.storage.setAlarm(waitingUntil);
      await this.pushRegistry();
      return Response.json({ ok: true, sid: b.sid, waiting_until: waitingUntil });
    }
    const codeExpiry = now + this.ttlMs(CODE_TTL_MS);
    // A link session made by a team member is driven by its creator. A caller that names no driver (open
    // mode) leaves the key out, and the session stays open to anyone who holds sessions.control.
    const driver = typeof b.driver === 'string' && sameIdentity(b.driver) ? sameIdentity(b.driver) : null;
    this.driver = driver;
    if (driver) this.people.driver_since = now;
    await this.setMany({
      ...(driver ? { driver, driver_since: now } : {}),
      code: b.code,
      sid: b.sid,
      label: b.label ?? null,
      state: 'pending',
      created_at: now,
      created_by: b.actor ?? null,
      workspace,
      code_expires_at: codeExpiry,
      ttl_ms: this._ttlOverride,
      machine: null,
      user: null,
      ps: null,
      windows_mode: windowsMode,
      transport: null,
      http_generation: 0,
      http_seen_at: 0,
      elevated: null,
      expires_at: null,
      ws_gen: 0,
    });
    this.logRow('created', b.label ? `label=${truncate(String(b.label), 200)}` : '', b.actor);
    await this.ctx.storage.setAlarm(codeExpiry);
    await this.pushRegistry();
    return Response.json({ ok: true, sid: b.sid, code_expires_at: codeExpiry });
  }

  async doConsume(request) {
    // A saved PC's session has no link to use up.
    if (await this.get('device_id', null)) return Response.json({ ok: false, reason: 'not-pending' });
    let windowsMode = 'powershell';
    try { windowsMode = (await request.json()).windows_mode ?? 'powershell'; } catch (_) {}
    // Hash first. Hashing yields to other requests, so doing it between the state
    // check and the write would let two concurrent consumes both see `pending`
    // and both mint a key. From the state read to the write there is only
    // storage I/O, which does not interleave.
    const key = hex32();
    const keyHash = await sha256Hex(key);
    if (await this.expireIfDue()) return Response.json({ ok: false, reason: 'expired' });
    const state = await this.get('state');
    if (state !== 'pending') return Response.json({ ok: false, reason: 'not-pending' });
    // The PowerShell script and the downloaded app are separate clients. A code
    // minted for one can't be used up by the other.
    if (windowsMode !== (await this.get('windows_mode', 'powershell'))) {
      return Response.json({ ok: false, reason: 'wrong-client' });
    }
    const now = Date.now();
    const deadline = now + this.ttlMs(CONSUMED_TTL_MS);
    await this.setMany({
      state: 'consumed',
      key_hash: keyHash,
      consumed_at: now,
      consumed_expires_at: deadline,
    });
    this.logRow('consumed');
    await this.ctx.storage.setAlarm(deadline);
    await this.pushRegistry();
    return Response.json({ ok: true, key, startup_expires_at: deadline });
  }

  async doWs(request) {
    // Order matters: the agent's reconnect probe is a plain GET (no Upgrade) and
    // relies on 410 (ended) / 401 (pending or bad key) to mean "session over"
    // and 426 to mean "alive, please upgrade". So check state and key first.
    await this.expireIfDue();
    let state = await this.get('state');
    if (state === 'ended' || state === undefined) return new Response('gone', { status: 410 });
    if (state === 'pending') return new Response('unauthorized', { status: 401 });
    if ((await this.get('windows_mode', 'powershell')) === 'app') return new Response('wrong transport', { status: 401 });
    // EMERGENCY_STOP ends a session that reaches this object instead of serving it.
    if (String(this.env.EMERGENCY_STOP ?? '') !== '') {
      await this.endStopped();
      return new Response('gone', { status: 410 });
    }
    const key = request.headers.get('X-Attach-Key') || '';
    const wantHash = await this.get('key_hash');
    if (!wantHash || (await sha256Hex(key)) !== wantHash) {
      return new Response('unauthorized', { status: 401 });
    }
    // Hashing yields to other requests. An operator end or alarm during that
    // await must remain terminal, so a late attach can't resurrect the session.
    await this.expireIfDue();
    state = await this.get('state');
    if (state === 'ended' || state === undefined) return new Response('gone', { status: 410 });
    // A workspace's stop ends this session here too, for the reconnect probe as
    // well as the upgrade. Read at most every 20 seconds; a failed read fails open.
    if (await this.stopped()) {
      await this.endStopped();
      return new Response('gone', { status: 410 });
    }
    // The stop read awaits D1, which lets other requests run: an end that landed
    // meanwhile must stay terminal, so read the state again.
    state = await this.get('state');
    if (state === 'ended' || state === undefined) return new Response('gone', { status: 410 });
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }

    const now = Date.now();
    let expiresAt = await this.get('expires_at');
    const gen = (await this.get('ws_gen', 0)) + 1;
    const tag = `g${gen}`;

    // Replace: every older socket is closed and its in-flight requests fail now.
    this.closeAll(null, 'replaced');
    this.failPending(() => true, 'agent disconnected');

    const firstAttach = state === 'consumed';
    if (firstAttach) {
      expiresAt = now + this.ttlMs(ATTACHED_LIFE_MS);
      await this.setMany({ state: 'attached', attached_first_at: now, expires_at: expiresAt, ws_gen: gen, ws_tag: tag });
      this.logRow('attached', tag);
    } else {
      // reattach: do NOT extend expiry
      await this.setMany({ ws_gen: gen, ws_tag: tag });
      this.logRow('attached', `reattach ${tag}`);
    }
    await this.ctx.storage.setAlarm(this.wakeFor(expiresAt));

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [tag]);
    server.send(JSON.stringify({ type: 'welcome', expires_at: expiresAt }));
    // The registry push is a network call that yields. It runs after the accept,
    // so an end that lands during it also closes this socket. Before the accept
    // it could not, and the socket would join an ended session.
    if (firstAttach) await this.pushRegistry();
    return new Response(null, { status: 101, webSocket: client });
  }

  async doStatus(url) {
    // Another workspace sees what a session that does not exist shows.
    if (await this.otherWorkspace(url.searchParams.get('workspace'))) return Response.json(statusBody(new Map(), [], false));
    await this.expireIfDue();
    const tail = Math.max(0, Math.min(500, Number(url.searchParams.get('log_tail') || 20) || 0));
    const s = await this.ctx.storage.get([
      'state', 'machine', 'user', 'expires_at', 'ps', 'code', 'ended_reason', 'consumed_expires_at',
      'windows_mode', 'transport', 'http_seen_at', 'elevated', 'caps', 'control', 'agent', 'version', 'desktop',
      'paused_until', 'input_blocked_until', 'device_id', 'driver', 'waiting_expires_at',
    ]);
    const rows = tail
      ? this.sql.exec(`SELECT ts,kind,detail FROM log ORDER BY ts DESC LIMIT ?`, tail).toArray().reverse()
      : [];
    const attached = s.get('transport') === 'https-poll'
      ? s.get('state') === 'attached' && Date.now() - (s.get('http_seen_at') || 0) < HTTP_SEEN_MS
      : !!(await this.currentSocket());
    // An ended session has no people: its roster, offer and picture go with it.
    const over = s.get('state') === 'ended';
    const body = statusBody(s, rows, attached, {
      participants: over ? [] : this.roster(), offer: over ? null : this.offerView(), frame_rev: this.frame ? this.frame.rev : null, frame_at: this.frame ? this.frame.at : null,
    });
    // A saved PC also shows the approval waiting on it and, when asked (session_status), the rules in force.
    if (s.get('device_id')) {
      body.approval = over ? null : this.approvalView();
      if (!over && url.searchParams.get('rules') === '1') body.rules = await this.rulesView();
    }
    return Response.json(body);
  }

  async doCommand(request) {
    return this.command(await request.json(), null);
  }

  // One command from a technician (or the built-in agent as its starter). `approved` is set only when this call
  // already waited for a technician's approval and got it: { hash, by }. The command then starts again from the
  // top, so the state, the driver, the actor, the PC's attachment and the rules are all read again after the wait.
  async command(b, approved) {
    try {
      return await this.commandOnce(b, approved);
    } finally {
      // The approved record lives until the command is sent or refused, however many times it started over.
      if (approved?.held) this.held.delete(approved.held);
    }
  }

  async commandOnce(b, approved) {
    if (await this.otherWorkspace(b.workspace)) return Response.json({ ok: false, error: 'session ended' });
    await this.expireIfDue();
    const state = await this.get('state');
    if (state === 'ended' || state === undefined) return Response.json({ ok: false, error: 'session ended' });
    // One technician drives at a time: a saved PC's session, and a one-off session that has a driver.
    if (this.driver && sameIdentity(b.actor) !== this.driver) {
      return Response.json({ ok: false, error: `${this.driver} is driving this session; ${this.device
        ? 'use device_connect with take_over'
        : 'ask them to offer control with session_handover, or an admin can take over with session_handover'}` });
    }
    await this.noteActor(b.actor);
    // The built-in agent acts as the person who started its task. The log says so,
    // and the actor stays that person for every check.
    const who = b.actor && b.via === 'agent' ? `${b.actor} via agent` : b.actor;
    const lane = Object.hasOwn(LANE_OF, b.op) ? LANE_OF[b.op] : null;
    // The tools the team's rules govern need a saved PC: a one-off link session runs the older app, which has none of them.
    const ruled = b.op === 'power' || b.op === 'programs';
    if (ruled && !this.device) return codedRefusal('not_saved_pc', EXTRA_REFUSALS.not_saved_pc);
    if (lane === 'screen' && (await this.get('windows_mode', 'powershell')) !== 'app') {
      return Response.json({ ok: false, error: NO_SCREEN_PS });
    }
    const ws = state === 'attached' ? await this.currentSocket() : null;
    const isHttp = state === 'attached' && (await this.get('transport')) === 'https-poll'
      && Date.now() - (await this.get('http_seen_at', 0)) < HTTP_SEEN_MS;
    if (!ws && !isHttp) return Response.json({ ok: false, error: 'agent not attached' });
    if (!lane) return Response.json({ ok: false, error: 'bad op' });
    const caps = isHttp ? await this.get('caps', []) : [];
    const control = isHttp ? await this.get('control', null) : null;
    const lanesClient = caps.includes('lanes');
    if (lane === 'screen' && !lanesClient) return Response.json({ ok: false, error: NO_SCREEN_OLD });
    if (lane === 'screen' && !caps.includes('screen')) return Response.json({ ok: false, error: NO_SCREEN_CONSENT });
    const tag = isHttp ? `http${await this.get('http_generation')}` : null;
    // The rules: decide before the lane is taken. A command that needs a technician's approval waits here, and
    // starts again from the top once it has it.
    let guard = null;
    let prepared = null;
    if (ruled) {
      const version = await this.get('version', null);
      if (!validVersion(version) || compareVersions(version, MIN_SESSION_VERSION) < 0) return codedRefusal('needs_update', EXTRA_REFUSALS.needs_update);
      prepared = await this.prepareRuled(b);
      if (prepared.error) return Response.json({ ok: false, error: prepared.error });
      if (prepared.refuse) {
        this.logRow('rules', `refused ${b.op === 'power' ? b.action : `programs ${b.action}`}: ${prepared.refuse}`, who);
        return codedRefusal(prepared.refuse, prepared.text);
      }
    }
    if (this.device && (ruled || ['run', 'put_file', 'get_file'].includes(b.op))) {
      const g = await this.guardCommand(b, prepared, { control, lane, isHttp, who, approved });
      if (g.response) return g.response;
      if (g.approved) return this.command(b, g.approved);
      guard = g;
    }
    // An approved command is sent only to someone who may still send it, for a task that still runs, and only if
    // nothing cancelled it since the technician said yes. The last await is here: the lane check below follows
    // at once.
    if (approved) {
      const stale = await this.recheckRequester(b);
      if (stale) return stale;
      const gone = this.heldRefusal(approved.held);
      if (gone) return gone;
    }
    // From this check to the reservation below there is no await, so two
    // concurrent calls can't both take the same lane.
    if (isHttp && this.httpCommands[lane]) {
      // A command a technician has approved waits for its lane, up to laneWaitMs, instead of throwing the approval
      // away. It then starts over (the state, the rules and the lane are all read again), with the wait spent. The
      // wait is part of the approved record, so a cancel (the agent's Pause or Stop, a handover, a take-over, the
      // end of the session) ends it at once.
      if (approved && !approved.waited) {
        const free = await this.laneFree(lane, this.laneWaitMs, approved.held);
        const gone = this.heldRefusal(approved.held);
        if (gone) return gone;
        if (free) return this.command(b, { ...approved, waited: true });
      }
      if (approved) {
        return codedRefusal('busy', `${approved.by}'s approval was used: the PC stayed busy with another command for ${Math.round(this.laneWaitMs / 1000)} seconds, so this one did not run. Ask again, and a technician must approve it again`);
      }
      return ruled ? codedRefusal('busy', 'agent busy; wait for the current operation') : Response.json({ ok: false, error: 'agent busy; wait for the current operation' });
    }

    const id = crypto.randomUUID();
    let frame;
    let waitMs;
    let action = null; // the normalized screen action, if any
    if (b.op === 'run') {
      let t = Number(b.timeout_s);
      if (!Number.isFinite(t) || t < 1) t = 60;
      if (t > 600) t = 600;
      t = Math.floor(t);
      const as = b.as ?? 'user';
      if (as !== 'user' && as !== 'system') return Response.json({ ok: false, error: 'as must be user or system' });
      if (as === 'system' && !isHttp) return Response.json({ ok: false, error: 'the PowerShell fallback cannot run as system' });
      if (as === 'system' && !lanesClient) return Response.json({ ok: false, error: 'this support app is too old to run as system' });
      // Only full control (the SYSTEM service) can run as SYSTEM. A normal-mode app would run it as the user.
      if (as === 'system' && control !== 'full') return Response.json({ ok: false, error: 'as: "system" needs full control' });
      frame = { type: 'run', id, lane, command: String(b.command ?? ''), timeout_s: t };
      // Only a client that reports lanes knows the field; the app enforces it.
      if (lanesClient) frame.as = as;
      waitMs = t * 1000 + RESULT_SLACK_MS;
      this.logRow('run', (as === 'system' ? '(system) ' : '') + truncate(String(b.command ?? ''), 512), who);
    } else if (b.op === 'put_file') {
      const data = String(b.data_b64 ?? '');
      if (data.length > PUT_B64_MAX) {
        return Response.json({
          ok: false,
          error: `data_b64 is ${data.length} chars; max ${PUT_B64_MAX} per call. Send the first chunk with append:false and the rest with append:true.`,
        });
      }
      frame = { type: 'put_file', id, lane, path: String(b.path ?? ''), data_b64: data, append: !!b.append };
      waitMs = 60 * 1000 + RESULT_SLACK_MS;
      const bytes = Math.floor((data.length * 3) / 4);
      this.logRow('put_file', `${frame.path} (${bytes} bytes${frame.append ? ', append' : ''})`, who);
    } else if (b.op === 'get_file') {
      let len = Number(b.length);
      if (!Number.isFinite(len) || len <= 0 || len > GET_FILE_MAX) len = GET_FILE_MAX;
      len = Math.floor(len);
      const off = Number(b.offset) > 0 ? Math.floor(Number(b.offset)) : 0;
      frame = { type: 'get_file', id, lane, path: String(b.path ?? ''), offset: off, length: len };
      waitMs = 60 * 1000 + RESULT_SLACK_MS;
      this.logRow('get_file', `${frame.path} (@${off}+${len})`, who);
    } else if (ruled) {
      frame = { type: b.op, id, lane, ...prepared.fields };
      waitMs = prepared.waitMs;
      this.logRow(b.op, prepared.log, who);
    } else if (b.op === 'screen') {
      try { action = normalizeAction(b.action); } catch (e) { return Response.json({ ok: false, error: e.message }); }
      // These two work only through the SYSTEM service, so a normal-mode app never sees them.
      if (FULL_ONLY.includes(action.name) && control !== 'full') return Response.json({ ok: false, error: `${action.name} needs full control` });
      frame = { type: 'screen', id, lane, action };
      waitMs = SCREEN_WAIT_MS + RESULT_SLACK_MS
        + (action.name === 'wait' ? action.seconds * 1000 : 0)
        + (action.text ? action.text.length * TYPE_MS_PER_CHAR : 0);
      // A screenshot is logged below, once its size is known. type_secret logs a bare name.
      if (action.name !== 'screenshot') this.logRow('screen', auditText(action), who);
    } else {
      if (b.action !== 'request_full_control') return Response.json({ ok: false, error: 'bad action' });
      frame = { type: 'control', id, lane, action: 'request_full_control' };
      waitMs = CONTROL_WAIT_MS + RESULT_SLACK_MS;
      this.logRow('control', 'request_full_control', who);
    }

    // What the PC needs to hold the relay's decision against its own rules (src/agent-app.cs).
    if (guard?.tag) {
      // The PC may spend up to CATCH_UP_MS on a check-in before it decides this frame, so the relay waits that much longer.
      waitMs += CATCH_UP_MS;
      frame.rules_tag = guard.tag;
      frame.decided_at = Math.floor(guard.at / 1000);
      if (guard.approvedBy) frame.approved_by = guard.approvedBy;
    }
    let target = ws;
    if (isHttp) {
      this.httpCommands[lane] = { frame, tag, sent_at: null };
      target = { send: () => this.dispatchHttp(lane) };
    }
    const result = await this.awaitResult(id, target, isHttp ? tag : this.socketTag(ws), frame, waitMs,
      b.op === 'control' ? { control_request: true } : {});
    if (b.op === 'control' || b.op === 'screen') {
      const out = await this.finishScreen(result, action, who);
      this.holdFrame(action, out);
      return Response.json(out);
    }
    if (b.op === 'programs' && b.action === 'list' && result.ok) this.rememberPrograms(result);
    return Response.json(result);
  }

  // ---- the team's rules, and the approvals they ask for ---------------------------------
  // A restart_pc, shutdown_pc, list_programs, install_program, uninstall_program or close_program command as the
  // frame fields it becomes, or { error }. Numbers outside their range are brought into it, as for run. Returns
  // { fields, ruleAction, program, path, log, summary, waitMs, hash }: ruleAction is the rule that governs it
  // (none for a list), program and path are what the rules' name and folder checks compare, summary is what an
  // approver reads, built here from the frame and never from text the caller supplies apart from the action's
  // own arguments, and hash binds an approval to exactly this action on this PC.
  async prepareRuled(b) {
    const num = (v, def, lo, hi) => {
      const n = v === undefined || v === null ? NaN : Number(v);
      return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.floor(n))) : def;
    };
    const plain = (v, max) => truncate(String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim(), max);
    const out = { fields: null, ruleAction: null, program: undefined, path: undefined, log: '', summary: '', waitMs: 60 * 1000 + RESULT_SLACK_MS };
    if (b.op === 'power') {
      if (b.action !== 'restart' && b.action !== 'shutdown') return { error: 'action must be restart or shutdown' };
      const delay = num(b.delay_s, 30, 5, 600);
      out.fields = { action: b.action, delay_s: delay };
      out.ruleAction = b.action;
      out.log = `${b.action} in ${delay} s`;
      out.summary = `${b.action === 'restart' ? 'Restart' : 'Shut down'} the PC in ${delay} seconds`;
    } else if (b.action === 'list') {
      out.fields = { action: 'list' };
      out.log = 'list';
    } else if (b.action === 'install') {
      // The same checks as the PC's, before a technician is asked: a path it would refuse, a file that is not an
      // installer, or arguments that restart or uninstall are refused here and spend no approval.
      const path = localAbsolutePath(b.path) ?? '';
      if (!path || path.length > 1000 || CONTROL_TEXT.test(path)) return { error: 'path is required: the absolute path of the installer on the PC, such as C:\\Temp\\setup.exe' };
      if (b.args !== undefined && b.args !== null && (typeof b.args !== 'string' || b.args.length > 1000 || CONTROL_TEXT.test(b.args))) return { error: 'args must be text of at most 1000 characters, with no line breaks' };
      const args = typeof b.args === 'string' ? b.args.trim() : '';
      const installer = installerProblem(path) ?? installArgsProblem(path, args);
      if (installer) return { error: installer };
      const timeout = num(b.timeout_s, 300, 10, 600);
      out.fields = { action: 'install', path, ...(args ? { args } : {}), timeout_s: timeout };
      out.ruleAction = 'install';
      out.path = path;
      out.waitMs = timeout * 1000 + RESULT_SLACK_MS;
      out.log = `install ${truncate(path, 300)}${args ? ` ${truncate(args, 100)}` : ''}`;
      out.summary = `Install ${plain(path, 200)}${args ? ` with arguments ${plain(args, 200)}` : ''}`;
    } else if (b.action === 'uninstall') {
      const id = typeof b.program_id === 'string' ? b.program_id.trim() : '';
      if (!id || id.length > 200) return { error: 'program_id is required: an id from list_programs' };
      if (isAppProgramId(id)) return { refuse: 'protected_program', text: 'the Support app is never uninstalled through its own tools' };
      const timeout = num(b.timeout_s, 300, 10, 600);
      const name = this.knownProgram('byId', id);
      out.fields = { action: 'uninstall', program_id: id, timeout_s: timeout };
      out.ruleAction = 'uninstall';
      out.program = name ?? id;
      out.waitMs = timeout * 1000 + RESULT_SLACK_MS;
      out.log = `uninstall ${truncate(id, 200)}`;
      out.summary = `Uninstall ${name ? plain(name, 200) : `the program with id ${plain(id, 100)}`}`;
    } else if (b.action === 'close') {
      const hasName = b.name !== undefined && b.name !== null && b.name !== '';
      const hasPid = b.pid !== undefined && b.pid !== null;
      if (hasName === hasPid) return { error: 'give either name or pid of the program to close' };
      if (hasName && (typeof b.name !== 'string' || !b.name.trim() || b.name.length > PROGRAM_NAME_MAX)) return { error: `name must be a program name of at most ${PROGRAM_NAME_MAX} characters` };
      if (hasPid && (!Number.isSafeInteger(b.pid) || b.pid <= 0)) return { error: 'pid must be a process id from list_programs' };
      if (b.force !== undefined && b.force !== null && typeof b.force !== 'boolean') return { error: 'force must be true or false' };
      const force = b.force === true;
      const known = hasPid ? this.knownProgram('byPid', b.pid) : undefined;
      out.fields = { action: 'close', ...(hasName ? { name: b.name.trim() } : { pid: b.pid }), force };
      out.ruleAction = 'close_program';
      out.program = hasName ? b.name.trim() : known;
      out.log = `close ${hasName ? truncate(b.name.trim(), 100) : `pid ${b.pid}`}${force ? ' (force)' : ''}`;
      out.summary = `Close ${hasName ? plain(b.name, 100) : known ? `${plain(known, 100)} (process ${b.pid})` : `process ${b.pid}`}${force ? ', forced: unsaved work is lost' : ''}`;
    } else {
      return { error: 'action must be list, install, uninstall or close' };
    }
    out.hash = await sha256Hex(JSON.stringify([await this.get('sid', null), await this.get('device_id', null), out.ruleAction, out.fields]));
    return out;
  }

  // The rules' answer to a command on a saved PC, before its lane is taken. Reads the rules in force for the PC
  // from the database every time. Returns { response } to refuse (or fail), { approved } when the call waited for
  // a technician and got the go (the command then starts over), or { tag, at, approvedBy? } to send it. A
  // restart, shutdown, install, uninstall, close, put_file and get_file are decided; a raw run is not (the PC
  // screens it) but carries the tag; a list carries nothing and reads nothing.
  async guardCommand(b, prepared, { control, lane, isHttp, who, approved }) {
    if (b.op === 'programs' && b.action === 'list') return {};
    const slug = await this.get('workspace', DEFAULT_WORKSPACE);
    const decided = b.op !== 'run';
    let read = null;
    try {
      read = await devicesFromEnv(this.env).rulesFor(slug, await this.get('device_id', null));
    } catch (_) { /* handled below */ }
    if (!read) return decided ? { response: codedRefusal('rules_stale', EXTRA_REFUSALS.rules_stale) } : {};
    const at = Date.now();
    const base = { tag: read.tag, at };
    if (!decided) return base;
    const ruleAction = prepared ? prepared.ruleAction : b.op;
    const verdict = decide(read.rules, ruleAction, {
      nowMs: at, hours: read.hours, control: control === 'full' ? 'full' : 'limited', program: prepared?.program,
      path: prepared ? prepared.path : String(b.path ?? ''),
      // A restart or shutdown that waits is judged over the whole wait, not only at this moment.
      delay_s: b.op === 'power' ? prepared.fields.delay_s : undefined,
    });
    if (verdict.refuse) {
      this.logRow('rules', `refused ${prepared ? prepared.log : b.op}: ${verdict.refuse}`, who);
      return { response: codedRefusal(verdict.refuse, verdict.text ?? REFUSALS[verdict.refuse]) };
    }
    if (!verdict.approve) return base;
    // Approved already by this very call: the checks above ran again, on today's rules, and this still needs it.
    if (approved) {
      return approved.hash === prepared.hash ? { ...base, approvedBy: approved.by }
        : { response: codedRefusal('declined', 'the approval was for a different action') };
    }
    // A command that cannot be sent anyway does not spend a technician's approval.
    if (isHttp && this.httpCommands[lane]) return { response: codedRefusal('busy', 'agent busy; wait for the current operation') };
    const asked = await this.requestApproval(b, prepared, who);
    return asked.response ? asked : { approved: asked.approved };
  }

  // Ask the people who may approve, and wait up to APPROVAL_MS for the answer. One approval waits per session; a
  // second request is busy. Nobody can approve for a caller that is not a person (a service token) or in a team
  // where no member holds sessions.unattended (open mode included): approval_unavailable, at once.
  async requestApproval(b, prepared, who) {
    const slug = await this.get('workspace', DEFAULT_WORKSPACE);
    const actor = sameIdentity(b.actor);
    const unavailable = (text) => ({ response: codedRefusal('approval_unavailable', text) });
    if (identityKind(actor) !== 'person') return unavailable('this caller is not a team member, so nobody can approve for it');
    const notify = notifyStore(this.env.DB, teamFromEnv(this.env));
    let holders;
    try {
      holders = await notify.holders(slug, UNATTENDED_PERMISSION);
    } catch (_) {
      return unavailable('could not look up who can approve; try again');
    }
    if (!holders.length) return unavailable(`no member of this team holds ${UNATTENDED_PERMISSION}, so nobody can approve`);
    // From here to the record there is no await: the one-at-a-time check and the driver check hold.
    if (this.approval) return { response: codedRefusal('busy', 'another action is waiting for approval on this session') };
    if (this.driver && actor !== this.driver) return { response: Response.json({ ok: false, error: `${this.driver} is driving this session` }) };
    const now = Date.now();
    const rec = {
      id: hex32().slice(0, 32), hash: prepared.hash, action: prepared.ruleAction, summary: prepared.summary, actor,
      via: b.via === 'agent' ? 'agent' : null, task_id: typeof b.task_id === 'string' ? truncate(b.task_id, 64) : null,
      created_at: now, expires_at: now + this.ttlMs(APPROVAL_MS), device_id: await this.get('device_id', null), device_name: await this.get('device_name', ''),
    };
    const waiting = new Promise((resolve) => {
      const timer = setTimeout(() => this.finishApproval(rec.id, { refuse: 'approval_timeout', text: EXTRA_REFUSALS.approval_timeout }), rec.expires_at - now);
      this.approval = { rec, resolve, timer };
    });
    this.logRow('approval', `requested: ${rec.summary}`, who);
    try {
      await this.setMany({ approval: rec });
      const name = rec.device_name;
      const sid = await this.get('sid', null);
      const asker = rec.via === 'agent' ? `${actor}'s agent` : actor;
      const people = [...new Set([actor, ...holders])];
      const rows = (await Promise.all(people.map((to) => notify.direct(slug, 'approval_requested', to, {
        device_id: rec.device_id, session_id: sid, title: 'Approval needed',
        body: `${asker} asks to: ${rec.summary}${name ? ` on ${name}` : ''}. Approve or deny it in the app.`,
        dedupe: `approval:${rec.id}`,
      })))).flat();
      await notify.write(slug, rows);
    } catch (_) {
      // Nobody could be told, so nobody could answer: refuse now instead of waiting for nothing.
      this.finishApproval(rec.id, { refuse: 'approval_unavailable', text: 'could not tell the technicians; try again' });
    }
    const outcome = await waiting;
    if (outcome.approved) {
      this.logRow('approval', `approved by ${outcome.approver}: ${rec.summary}`, who);
      return { approved: { hash: rec.hash, by: outcome.approver, held: outcome.held } };
    }
    if (outcome.ended) return { response: Response.json({ ok: false, error: 'session ended' }) };
    this.logRow('approval', `${outcome.refuse}: ${rec.summary}`, who);
    return { response: codedRefusal(outcome.refuse, outcome.text ?? EXTRA_REFUSALS[outcome.refuse]) };
  }

  // Wait until the lane has no command waiting for its result, up to about ms. True when it is free. The wait is
  // counted in steps, not timed, so a test with a frozen clock still ends.
  // `held` (the approved record) ends the wait early when it is cancelled.
  async laneFree(lane, ms, held = null) {
    for (let left = Math.ceil(ms / LANE_STEP_MS); this.httpCommands[lane]; left--) {
      if (left <= 0 || held?.cancelled) return false;
      await new Promise((resolve) => {
        if (held) held.wake = resolve;
        setTimeout(resolve, LANE_STEP_MS);
      });
    }
    return !held?.cancelled;
  }

  // ---- an approved command before it is sent ---------------------------------------------------------------
  // A technician's yes does not end the command's wait: it may still wait for its lane, and it starts over from
  // the top. From the moment of the answer to the send (or the refusal) the command has a record in this.held, so
  // the cancels that stop a waiting approval stop it as well: the agent's Pause or Stop (for its own task), a
  // handover or take-over, and the end of the session. The record is made in the same step that resolves the
  // approval, with no await in between, so no cancel can fall in a gap.
  holdApproved(rec) {
    const held = { task_id: rec.task_id, via: rec.via, actor: rec.actor, cancelled: null, ended: false, wake: null };
    this.held.add(held);
    return held;
  }

  // Cancel the approved commands (all of them, or those of one agent task) with a reason, and wake any that wait for a lane.
  cancelHeld(why, taskId = null, { ended = false } = {}) {
    for (const h of this.held) {
      if (taskId !== null && h.task_id !== taskId) continue;
      // The first reason stays, and a command whose session ended stays ended: a later cancel (a task's stop) must
      // not turn "session ended" back into "declined".
      h.cancelled ??= why;
      h.ended = h.ended || ended;
      h.wake?.();
    }
  }

  // The refusal for an approved command whose record was cancelled, or null.
  heldRefusal(held) {
    if (!held?.cancelled) return null;
    if (held.ended) return Response.json({ ok: false, error: 'session ended' });
    return codedRefusal('declined', `the approval was cancelled: ${held.cancelled}`);
  }

  // The requester's standing now, read from the database, just before an approved command is sent. The router
  // checked it when the command was asked for, which may be minutes ago. A command goes only to a person who is
  // still a member holding sessions.control, whose sign-in is not disabled, in a workspace and a relay that are
  // not stopped. The same checks the router makes for the kind of caller it was: an OAuth caller (b.oauth, set by the
  // router) must still exist, be enabled and be invited (assertPersonActive), and the authenticator their grant was made
  // with must still be theirs (assertSecondFactor, for sessions.control). The built-in agent's task must still be running
  // (not paused, not ended) and have been started by this person, whose account must still be active; it needs no second
  // factor here, since the person passed it when starting the task (the router makes the same exception for `person`).
  // An Access login has no grant to check. Fails closed: a database that cannot answer refuses. Returns a refusal or null.
  async recheckRequester(b) {
    const slug = await this.get('workspace', DEFAULT_WORKSPACE);
    const actor = sameIdentity(b.actor);
    const no = (why) => codedRefusal('declined', `the approval was cancelled: ${why}`);
    if (String(this.env.EMERGENCY_STOP ?? '') !== '') return no('this relay was stopped by its operator');
    // assertPersonActive says one thing for a person who is gone; any other error is the database failing.
    const gone = async (userId) => {
      try {
        await assertPersonActive(this.env, team, { userId, email: actor });
        return null;
      } catch (e) {
        if (e?.message === 'you are not a member of this team') return no(`${actor} is no longer an active member of this team`);
        throw e;
      }
    };
    let team;
    try {
      team = teamFromEnv(this.env);
      const a = await team.authorize(slug, actor, 'sessions.control', { membersOnly: true });
      if (!a.ok) return no(a.reason === 'not_member' ? `${actor} is no longer a member of this team` : `${actor}'s role no longer allows sessions.control`);
      const accounts = accountStore(this.env.DB, { secret: this.env.AUTH_SECRET });
      const user = await accounts.userByEmail(actor);
      if (user?.disabled_at) return no(`${actor}'s account was disabled`);
      if ((await team.stopState(slug)).stopped) return no('the workspace was stopped');
      if (b.oauth) {
        if (!user || user.id !== b.oauth.user_id) return no(`${actor}'s account is no longer the one that signed in`);
        const left = await gone(user.id);
        if (left) return left;
        try {
          await assertSecondFactor(this.env, { userId: user.id, factor: b.oauth.factor ?? null }, 'sessions.control');
        } catch (e) {
          if (String(e?.message).startsWith('a second factor is required')) return no(`${actor}'s authenticator changed; connect the client again and enter the authenticator code`);
          throw e;
        }
      }
      if (b.via === 'agent') {
        const task = typeof b.task_id === 'string' ? await agentStoreFromEnv(this.env, team).getTask(slug, b.task_id) : null;
        if (!task || task.ended_at !== null) return no('the agent task ended');
        if (task.state !== 'running') return no(`the agent task is ${task.state}`);
        if (sameIdentity(task.started_by) !== actor) return no('the agent task was started by someone else');
        if (task.started_by_user) {
          const owner = await accounts.userById(task.started_by_user);
          if (!owner || owner.disabled_at) return no('the account that started the agent task was disabled');
          const left = await gone(task.started_by_user);
          if (left) return left;
        }
      }
    } catch (_) {
      return no('could not check that the requester may still do this; try again');
    }
    return null;
  }

  // The waiting approval is over, one way: { approved, approver } or { refuse, text } or { ended }. Nothing happens
  // for an approval that is not the one waiting, so an answer that comes twice, or after a timeout, is a no-op.
  finishApproval(id, outcome) {
    const a = this.approval;
    if (!a || a.rec.id !== id) return false;
    clearTimeout(a.timer);
    this.approval = null;
    this.setMany({ approval: null }).catch(() => {});
    // The answer and the record of the approved command are made together, so a cancel cannot fall between them.
    a.resolve(outcome.approved ? { ...outcome, held: this.holdApproved(a.rec) } : outcome);
    return true;
  }

  // Cancel the waiting approval because something it depended on changed (control moved, the agent was stopped).
  // `taskId` limits it to what that agent task asked for. It also reaches a command already approved that has not
  // been sent yet (see holdApproved).
  cancelApproval(why, taskId = null) {
    if (this.approval && (taskId === null || this.approval.rec.task_id === taskId)) {
      this.finishApproval(this.approval.rec.id, { refuse: 'declined', text: `the approval was cancelled: ${why}` });
    }
    this.cancelHeld(why, taskId);
  }

  approvalView() {
    const a = this.approval;
    if (!a || a.rec.expires_at <= Date.now()) return null;
    const { id, summary, actor, via, action, created_at, expires_at, device_id, device_name } = a.rec;
    return { id, summary, actor, via, action, created_at, expires_at, device_id, device_name };
  }

  // The approval's routes, for the relay (src/approvals.js), which has checked who is asking: list the waiting
  // approval, answer it (the approver is named by the relay), or cancel it (the built-in agent was stopped or paused).
  async doApprovals(request) {
    const b = await request.json().catch(() => ({}));
    const gone = await this.peopleGate(b);
    if (gone) return gone;
    if (!this.device) return refusal('not_found', 'approvals are for saved PCs');
    const lapsed = this.approval && this.approval.rec.expires_at <= Date.now();
    if (lapsed) this.finishApproval(this.approval.rec.id, { refuse: 'approval_timeout', text: EXTRA_REFUSALS.approval_timeout });
    if (b.op === 'list') return Response.json({ ok: true, approvals: this.approval ? [this.approvalView()] : [] });
    if (b.op === 'answer') {
      if (!this.approval || this.approval.rec.id !== b.id) return refusal('not_found', 'that approval is not waiting: it was answered or cancelled, or it timed out');
      const approver = sameIdentity(b.approver);
      if (typeof b.approve !== 'boolean' || !approver) return refusal('bad_request', 'approve (true or false) and the approver are required');
      this.finishApproval(b.id, b.approve ? { approved: true, approver } : { refuse: 'declined', text: `${approver} declined this action` });
      return Response.json({ ok: true, approved: b.approve });
    }
    if (b.op === 'cancel') {
      this.cancelApproval(typeof b.why === 'string' ? truncate(b.why, 100) : 'it was withdrawn', typeof b.task_id === 'string' ? b.task_id : null);
      return Response.json({ ok: true });
    }
    return refusal('bad_request', 'op must be list, answer or cancel');
  }

  // A name from the last list_programs result, or undefined when the list is older than PROGRAMS_TTL_MS: a pid is reused
  // and a program is removed, so an old list must not stand in for what is on the PC now. The PC decides again by what it finds.
  knownProgram(kind, key) {
    return Date.now() - this.programs.at < PROGRAMS_TTL_MS ? this.programs[kind].get(key) : undefined;
  }

  // The names in a list_programs result, kept in memory for the rules' name checks and the approval summary.
  rememberPrograms(result) {
    const byId = new Map();
    const byPid = new Map();
    for (const p of result.installed ?? []) byId.set(p.id, p.name);
    for (const r of result.running ?? []) byPid.set(r.pid, r.name);
    this.programs = { byId, byPid, at: Date.now() };
  }

  // The rules in force for this saved PC, as session_status shows them, or null when they cannot be read.
  async rulesView() {
    try {
      return (await devicesFromEnv(this.env).rulesFor(await this.get('workspace', DEFAULT_WORKSPACE), await this.get('device_id', null)))?.rules ?? null;
    } catch (_) {
      return null;
    }
  }

  // Keep the picture a screen action returned, for the people watching, if it is a full screenshot: a
  // zoom is a piece of the screen and never replaces it, and nothing is kept for type_secret, whose
  // picture may show what was typed. Memory only: this is never written to storage, and nothing is
  // kept once the session has ended. rev only ever grows, also across a restart of this object, so a
  // reader that has a picture can tell a new one by its rev.
  holdFrame(action, result) {
    if (!action || this.over || !result?.ok || typeof result.image_b64 !== 'string') return;
    if (action.name === 'zoom' || action.name === 'type_secret') return;
    this.frameRev = Math.max(this.frameRev + 1, Date.now());
    this.frame = { rev: this.frameRev, at: Date.now(), mime: result.mime, data: result.image_b64 };
  }

  // Last touches on a screen or control result, before the operator sees it.
  async finishScreen(result, action, actor) {
    if (action?.name === 'screenshot') {
      const display = action.display ? ` display ${action.display}` : '';
      if (result.ok) this.logScreenshot(`screenshot ${result.width}x${result.height}${display}`, actor);
      else this.logRow('screen', `screenshot failed${display}`, actor);
    }
    if (result.ok) {
      if (result.control === undefined) result.control = (await this.get('control', null));
    }
    // The typed secret never comes back, even if the app echoes it.
    if (action?.name === 'type_secret') {
      delete result.text;
      if (typeof result.error === 'string') result.error = result.error.split(action.text).join('[redacted]');
    }
    return result;
  }

  awaitResult(id, ws, tag, frame, waitMs, extra = {}) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          this.clearCommand(id);
          resolve({ ok: false, error: 'timeout waiting for agent', timed_out: true });
        }
      }, waitMs);
      this.pending.set(id, {
        tag,
        ...extra,
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
      });
      try {
        ws.send(JSON.stringify(frame));
      } catch (e) {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          this.clearCommand(id);
          clearTimeout(timer);
          resolve({ ok: false, error: 'agent disconnected' });
        }
      }
    });
  }

  // ---- app mode: HTTPS polling ----------------------------------------------
  replyToPoll(frame) {
    if (!this.httpPoll) return;
    const poll = this.httpPoll;
    this.httpPoll = null;
    clearTimeout(poll.timer);
    poll.resolve(Response.json(this.withDriver(frame)));
  }

  // A saved-PC session adds the driver to every poll answer, so the PC's corner
  // window can show a take-over. A one-off session's frames are unchanged even when it has a
  // driver: the person at that PC sees the generic notice, never a technician's name.
  withDriver(frame) {
    return this.device && this.driver ? { ...frame, driver: this.driver } : frame;
  }

  async loadDriver() {
    if (this.driver === undefined) {
      this.driver = (await this.get('driver', null)) || null;
      this.gen = (await this.get('driver_gen', 0)) || 0;
      this.device = !!(await this.get('device_id', null));
    }
    if (this.approval === undefined) {
      // A stored approval with nobody waiting on it: the object restarted, and the call that asked is gone. It is
      // dropped unsent, never carried out later.
      this.approval = null;
      const stored = await this.get('approval', null);
      if (stored) {
        await this.setMany({ approval: null });
        this.logRow('approval', `dropped unsent: the session restarted (${truncate(String(stored.summary ?? ''), 120)})`, stored.actor);
      }
    }
    if (this.people === undefined) {
      const s = await this.ctx.storage.get(['participants', 'offer', 'accepting', 'handed_over', 'driver_since', 'created_at']);
      this.people = {
        participants: s.get('participants') ?? {}, offer: s.get('offer') ?? null, accepting: s.get('accepting') ?? null,
        handed_over: s.get('handed_over') ?? null, driver_since: s.get('driver_since') ?? null, created_at: s.get('created_at') ?? null,
      };
    }
  }

  // ---- who is on the session -------------------------------------------------------
  // The people of the session as the team sees them: the driver, then everyone else. `name` is filled in
  // by the relay from the team's members; this object does not know it.
  roster() {
    const p = this.people;
    const out = [];
    if (this.driver) out.push({ identity: this.driver, name: null, role: 'driver', since: p.driver_since ?? p.created_at });
    for (const [identity, who] of Object.entries(p.participants)) out.push({ identity, name: null, role: who.role, since: who.since });
    return out;
  }

  // The offer of control that can still be accepted: not past its 2 minutes, unless its accept is in
  // progress. null when there is none.
  currentOffer() {
    const { offer, accepting } = this.people;
    if (!offer) return null;
    return offer.expires_at > Date.now() || (accepting && accepting.until > Date.now() && accepting.to === offer.to) ? offer : null;
  }

  currentAccepting() {
    const a = this.people.accepting;
    return a && a.until > Date.now() ? a : null;
  }

  offerView() {
    const o = this.currentOffer();
    return o ? { to: o.to, by: o.by, expires_at: o.expires_at } : null;
  }

  savePeople() {
    const { participants, offer, accepting, handed_over: handedOver, driver_since: driverSince } = this.people;
    return this.setMany({ participants, offer, accepting, handed_over: handedOver, driver_since: driverSince });
  }

  // The answer for a person's call to /people or /handover that cannot go on: a session of another
  // workspace and one that has ended both answer "no such live session".
  async peopleGate(b) {
    if (await this.otherWorkspace(b.workspace)) return refusal('not_found', 'no such live session');
    await this.expireIfDue();
    const state = await this.get('state');
    if (state === undefined || state === 'ended') return refusal('not_found', 'no such live session');
    return null;
  }

  // invite, join, leave and remove. The driver invites and removes; an invited person joins; a watcher leaves.
  async doPeople(request) {
    const b = await request.json().catch(() => ({}));
    const gone = await this.peopleGate(b);
    if (gone) return gone;
    const actor = sameIdentity(b.actor);
    const who = sameIdentity(b.identity);
    const p = this.people;
    const now = Date.now();
    const done = (extra = {}) => Response.json({ ok: true, participants: this.roster(), ...extra });
    if (b.action === 'invite' || b.action === 'remove') {
      if (!this.driver || actor !== this.driver) return refusal('not_driver', this.driver ? `${this.driver} is driving this session; only the driver can ${b.action}` : 'this session has no driver');
      if (!who) return refusal('bad_request', 'identity is required');
      if (who === this.driver) return refusal('bad_request', 'that person is the driver');
    }
    if (b.action === 'invite') {
      if (Object.hasOwn(p.participants, who)) return done({ changed: false, since: p.participants[who].since });
      if (Object.keys(p.participants).length >= PEOPLE_MAX) return refusal('bad_request', `a session holds at most ${PEOPLE_MAX} people besides its driver`);
      p.participants[who] = { role: 'invited', since: now, by: actor };
      await this.savePeople();
      this.logRow('invited', who, actor);
      return done({ changed: true, since: now });
    }
    if (b.action === 'remove') {
      if (!Object.hasOwn(p.participants, who)) return refusal('not_invited', 'that person is not on this session');
      this.dropPerson(who);
      await this.savePeople();
      this.logRow('removed', who, actor);
      return done({ changed: true });
    }
    if (b.action === 'join') {
      if (actor && actor === this.driver) return done({ changed: false });
      const me = Object.hasOwn(p.participants, actor) ? p.participants[actor] : null;
      if (!me) return refusal('not_invited', 'you were not invited to this session');
      if (me.role === 'watcher') return done({ changed: false });
      p.participants[actor] = { role: 'watcher', since: now, by: me.by };
      await this.savePeople();
      this.logRow('joined', '', actor);
      return done({ changed: true });
    }
    if (b.action === 'leave') {
      if (actor && actor === this.driver) return refusal('not_invited', 'you are driving this session; offer control to someone, or end the session');
      if (!Object.hasOwn(p.participants, actor)) return refusal('not_invited', 'you are not on this session');
      this.dropPerson(actor);
      await this.savePeople();
      this.logRow('left', '', actor);
      return done({ changed: true });
    }
    return refusal('bad_request', 'action must be invite, join, leave or remove');
  }

  // Take a person off the session, and any offer made to them.
  dropPerson(identity) {
    const p = this.people;
    delete p.participants[identity];
    if (p.offer && p.offer.to === identity) p.offer = null;
    if (p.accepting && p.accepting.to === identity) p.accepting = null;
  }

  // The offer, its answer, and the three steps of moving control (see src/session-people.js). Control
  // moves with `complete` only: `accepting` is the reservation made before the PC's record changes.
  async doHandover(request) {
    const b = await request.json().catch(() => ({}));
    const gone = await this.peopleGate(b);
    if (gone) return gone;
    const actor = sameIdentity(b.actor);
    const p = this.people;
    const now = Date.now();
    const state = await this.get('state');
    const notDriver = () => refusal('not_driver', this.driver ? `${this.driver} is driving this session` : 'this session has no driver');
    const ok = (extra = {}) => Response.json({ ok: true, driver: this.driver, participants: this.roster(), offer: this.offerView(), ...extra });

    if (b.op === 'offer') {
      if (!this.driver || actor !== this.driver) return notDriver();
      const to = sameIdentity(b.to);
      if (!to || to === this.driver) return refusal('bad_request', 'offer control to someone else on the session');
      if (p.participants[to]?.role !== 'watcher') return refusal('not_invited', 'that person has not joined this session');
      const pending = this.currentOffer();
      if (this.currentAccepting()) return refusal('busy', 'control is being handed over right now');
      if (pending && pending.to !== to) return refusal('offer_pending', `an offer to ${pending.to} is still open; cancel it first`);
      if (!pending) {
        p.offer = { to, by: actor, at: now, expires_at: now + OFFER_MS };
        await this.savePeople();
        this.logRow('offer', to, actor);
      }
      return ok({ changed: !pending, offer_at: this.currentOffer().at });
    }
    if (b.op === 'cancel') {
      if (!this.driver || actor !== this.driver) return notDriver();
      if (!this.currentOffer() || this.currentAccepting()) return refusal('no_offer', this.currentAccepting() ? 'that offer is being accepted' : 'there is no offer to cancel');
      p.offer = null;
      await this.savePeople();
      this.logRow('offer cancelled', '', actor);
      return ok();
    }
    if (b.op === 'decline') {
      const offer = this.currentOffer();
      if (!offer) return refusal('no_offer', 'there is no offer');
      if (offer.to !== actor) return refusal('not_offered_to_you', 'that offer is not for you');
      if (this.currentAccepting()) return refusal('no_offer', 'that offer is being accepted');
      p.offer = null;
      await this.savePeople();
      this.logRow('offer declined', '', actor);
      return ok();
    }
    if (b.op === 'accepting') {
      if (state !== 'attached') return refusal('not_attached', 'control moves only once the PC has let the session in');
      if (!this.driver) return notDriver();
      if (actor === this.driver) return refusal('bad_request', 'you are already the driver');
      const held = this.currentAccepting();
      if (held && held.to !== actor) return b.claim && held.claim
        ? refusal('already_claimed', 'someone else is claiming this session right now')
        : refusal('busy', 'control is being handed over to someone else right now');
      if (b.claim && b.claim.expect_driver !== undefined) {
        // A claim takes control from the person who escalated, and only while they still drive.
        if (sameIdentity(b.claim.expect_driver) !== this.driver) return notDriver();
      } else {
        const offer = this.currentOffer();
        if (!offer) return refusal('no_offer', 'there is no offer');
        if (offer.to !== actor) return refusal('not_offered_to_you', 'that offer is not for you');
        if (offer.by !== this.driver) return refusal('no_offer', 'that offer is out of date');
      }
      p.accepting = { to: actor, from: this.driver, until: now + ACCEPTING_MS, claim: !!b.claim };
      await this.savePeople();
      return ok({ from: this.driver, gen: this.gen, device_id: await this.get('device_id', null) });
    }
    if (b.op === 'release') {
      if (p.accepting && p.accepting.to === actor) {
        p.accepting = null;
        await this.savePeople();
      }
      return ok();
    }
    if (b.op === 'complete') {
      // Three outcomes, so it can be repeated: the driver and the generation are those the step began from, so `actor`
      // takes over; `actor` drives already, so nothing changes; anything else drives or has driven since (a take-over
      // landed in between, even one by the same person who drove before), so it stops and the later change stands.
      // `from_gen` is the generation the accept or claim marked, and `gen` the one the move gives (a saved PC's
      // pointer has already taken it, and the Session adopts that number: it never makes one up). A call with no
      // `from_gen` compares the driver only.
      const to = actor;
      if (!to) return refusal('bad_request', 'actor is required');
      if (this.driver === to) {
        if (p.accepting && p.accepting.to === to) {
          p.accepting = null;
          await this.savePeople();
        }
        return ok({ changed: false });
      }
      const takeOver = b.kind === 'take_over';
      const checked = Number.isInteger(b.from_gen);
      if (!this.driver || (!takeOver && this.driver !== sameIdentity(b.from)) || (checked && this.gen !== b.from_gen)) return notDriver();
      if (checked && !(Number.isInteger(b.gen) && b.gen > this.gen)) return notDriver();
      await this.applyDriver(to, { kind: takeOver ? 'take_over' : b.kind === 'claim' ? 'claim' : 'accept', gen: Number.isInteger(b.gen) ? b.gen : undefined });
      return ok({ changed: true });
    }
    return refusal('bad_request', 'op must be offer, cancel, decline, accepting, release or complete');
  }

  // `next` becomes the driver. The one who drove watches now, `next` leaves the lists they were on, any offer
  // is gone, and a saved PC is told at once so its corner window shows the new name. A handover (accept
  // or claim) is recorded for the built-in agent, which stops quietly when its starter handed over; a
  // take-over clears that record, so the agent raises its notice.
  async applyDriver(next, { kind, gen }) {
    const p = this.people;
    const previous = this.driver;
    const now = Date.now();
    if (previous) p.participants[previous] = { role: 'watcher', since: now, by: next };
    delete p.participants[next];
    p.offer = null;
    p.accepting = null;
    p.handed_over = kind === 'take_over' ? null : { from: previous, to: next, at: now };
    p.driver_since = now;
    // A waiting approval was asked for the old driver.
    this.cancelApproval('control of the session moved');
    this.driver = next;
    this.gen = Number.isInteger(gen) && gen > this.gen ? gen : this.gen + 1;
    await this.setMany({ driver: next, driver_gen: this.gen });
    await this.savePeople();
    this.logRow(kind === 'take_over' ? 'driver' : 'handover', `${previous} to ${next}`);
    if (this.device) this.replyToPoll({ type: 'idle' });
  }

  // The last full screenshot, to the driver or a person who joined, as { rev, at, mime, data }. The relay
  // has already checked the person's role, second factor and the access rule; this object checks that they
  // are on the session. A session of another workspace is no session, and an ended one has no picture.
  async doFrame(url) {
    const gone = await this.peopleGate({ workspace: url.searchParams.get('workspace') });
    if (gone) return Response.json((await gone.json()), { status: 404 });
    const actor = sameIdentity(url.searchParams.get('actor'));
    const joined = this.people.participants[actor]?.role === 'watcher';
    if (!actor || (actor !== this.driver && !joined)) {
      return Response.json({ ok: false, code: 'not_invited', error: 'you are not on this session' }, { status: 403 });
    }
    if (!this.frame) return Response.json({ ok: false, code: 'no_frame', error: 'there is no picture yet' }, { status: 404 });
    return Response.json({ rev: this.frame.rev, at: this.frame.at, mime: this.frame.mime, data: this.frame.data });
  }

  // Is this relay or this workspace stopped? EMERGENCY_STOP (any non-empty value)
  // stops everything and costs no read. The workspace's own stop is read from the
  // team log at most every 20 s; a read that fails counts as not stopped, because
  // the stop also ends sessions directly.
  async stopped() {
    if (String(this.env.EMERGENCY_STOP ?? '') !== '') return true;
    const now = Date.now();
    if (now - this.stopCheckedAt < STOP_CHECK_MS) return false;
    this.stopCheckedAt = now;
    try {
      return (await teamFromEnv(this.env).stopState(await this.get('workspace', DEFAULT_WORKSPACE))).stopped;
    } catch (_) {
      return false;
    }
  }

  // The relay or the workspace is stopped: tell every socket and poll, fail what
  // is waiting, and end with reason "stopped".
  async endStopped() {
    // The stop read awaits D1, so an end may have landed meanwhile: keep its reason.
    if ((await this.get('state')) === 'ended') return;
    this.closeAll({ type: 'end', reason: 'stopped' }, 'stopped');
    this.failPending(() => true, 'session ended');
    await this.markEnded('stopped');
  }

  // When this session's alarm next fires. An attached PowerShell session (a
  // websocket) can sit quiet for hours, so it wakes every STOP_ALARM_MS to check
  // for a stop; its deadline still ends it on time.
  wakeFor(deadline) {
    return Math.min(deadline, Date.now() + STOP_ALARM_MS);
  }

  // A command was queued for `lane`. Hand it to the parked poll if that poll
  // says the lane is free. Otherwise the next poll that does will pick it up.
  dispatchHttp(lane) {
    const c = this.httpCommands[lane];
    if (!c || !this.httpPoll || this.httpPoll.busy.has(lane)) return;
    c.sent_at = Date.now();
    this.replyToPoll(c.frame);
  }

  // How long to park a poll. A frame that went to a poll the app had already
  // aborted (Wake) is held back by the redelivery guard until it is REDELIVER_MS
  // old. Waiting the full 25 s for the poll to end would add that to the delay, so
  // the poll ends when the guard window does and the frame goes out then.
  parkMs(busy) {
    let ms = POLL_PARK_MS;
    for (const lane of LANES) {
      const c = this.httpCommands[lane];
      if (c && !busy.has(lane) && c.sent_at !== null) ms = Math.min(ms, Math.max(0, c.sent_at + REDELIVER_MS - Date.now()));
    }
    return ms;
  }

  // The parked poll ran out its time: send a frame the guard no longer holds back, else idle.
  releasePoll() {
    const poll = this.httpPoll;
    if (!poll) return;
    for (const lane of LANES) {
      const c = this.httpCommands[lane];
      if (c && !poll.busy.has(lane) && (c.sent_at === null || Date.now() - c.sent_at >= REDELIVER_MS)) {
        c.sent_at = Date.now();
        this.replyToPoll(c.frame);
        return;
      }
    }
    this.replyToPoll({ type: 'idle' });
  }

  async doAgent(request) {
    if (request.method !== 'POST') return Response.json({ error: 'method not allowed' }, { status: 405 });
    await this.expireIfDue();
    let state = await this.get('state');
    if (!state || state === 'ended') return Response.json({ type: 'end' }, { status: 410 });
    // A saved PC's session has no attach key: the Worker already checked the PC's
    // device key and says which device this is. A link session needs its key.
    const deviceId = await this.get('device_id', null);
    const key = request.headers.get('X-Attach-Key') || '';
    const authorized = deviceId
      ? request.headers.get('X-Device-Id') === deviceId
      : state !== 'pending' && (await this.get('windows_mode', 'powershell')) === 'app'
        && (await sha256Hex(key)) === (await this.get('key_hash'));
    if (!authorized) return Response.json({ error: 'unauthorized' }, { status: 401 });
    let b;
    try { b = await request.json(); } catch (_) { return Response.json({ error: 'invalid JSON' }, { status: 400 }); }
    if (!b || typeof b !== 'object' || Array.isArray(b)) return Response.json({ error: 'invalid message' }, { status: 400 });
    // Recheck after hashing and body parsing, both of which can let an end or
    // expiry request run. A delayed hello must never resurrect ended access.
    await this.expireIfDue();
    state = await this.get('state');
    if (!state || state === 'ended') return Response.json({ type: 'end' }, { status: 410 });
    // A stopped relay or workspace ends the session at the next request, and a
    // workspace's stop is read at most every 20 seconds.
    if (await this.stopped()) {
      await this.endStopped();
      return Response.json({ type: 'end', reason: 'stopped' }, { status: 410 });
    }
    // The stop read awaits D1: an end that landed meanwhile stays terminal.
    state = await this.get('state');
    if (!state || state === 'ended') return Response.json({ type: 'end' }, { status: 410 });
    // A PC says no before it says hello: the person declined, nobody was there
    // to ask, or the PC was busy. The session ends with that reason. A PC that
    // restarts during a limited session and finds nobody to ask, or several
    // Remote Desktop users to choose from (busy), says so after the hello, so
    // those two reasons are taken while attached too. "declined" is not.
    if (b.type === 'decline') {
      const allowed = state === 'waiting' || (state === 'attached' && (b.reason === 'nobody' || b.reason === 'busy'));
      if (!deviceId || !allowed || !DECLINE_REASONS.includes(b.reason)) return Response.json({ error: 'invalid message' }, { status: 400 });
      this.logRow('declined', b.reason);
      this.failPending(() => true, 'session ended');
      this.closeAll({ type: 'end', reason: b.reason }, b.reason);
      await this.markEnded(b.reason);
      return Response.json({ type: 'end' });
    }
    if (b.type === 'hello') {
      // A limited PC never runs a full-control session, whatever its hello says.
      if (deviceId && request.headers.get('X-Device-Control') === 'limited' && decodeControl(b.control) === 'full') {
        return Response.json({ error: 'this PC is limited; it cannot run a full-control session' }, { status: 403 });
      }
      this.closeAll({ type: 'end', reason: 'replaced' }, 'replaced');
      const control = decodeControl(b.control);
      // A request_full_control in flight ends with a new hello, because the
      // service takes the connection over. A full-control hello means it worked.
      for (const [id, p] of this.pending) {
        if (!p.control_request) continue;
        this.pending.delete(id);
        this.clearCommand(id);
        p.resolve(control === 'full'
          ? { ok: true, control, text: 'full control is on' }
          : { ok: false, error: 'the app restarted without full control' });
      }
      this.failPending(() => true, 'agent replaced');
      const now = Date.now();
      const generation = (await this.get('http_generation', 0)) + 1;
      const firstAttach = state === 'consumed' || (deviceId !== null && state === 'waiting');
      const expiresAt = firstAttach ? now + this.ttlMs(ATTACHED_LIFE_MS) : await this.get('expires_at');
      const machine = truncate(String(b.machine ?? ''), 100) || null;
      const user = truncate(String(b.user ?? ''), 100) || null;
      const ps = truncate(String(b.ps ?? ''), 40) || null;
      const agent = truncate(String(b.agent ?? ''), 40) || null;
      const version = decodeVersion(b.version);
      const elevated = typeof b.elevated === 'boolean' ? b.elevated : null;
      const caps = decodeCaps(b.caps);
      await this.setMany({
        state: 'attached', transport: 'https-poll', http_generation: generation, http_seen_at: now,
        expires_at: expiresAt, machine, user, ps, elevated, agent, version, caps, control,
        desktop: null, paused_until: null, input_blocked_until: null,
        ...(firstAttach ? { attached_first_at: now } : {}),
      });
      this.logRow('attached', `${firstAttach ? '' : 'reattach '}http${generation} elevated=${elevated ?? 'unknown'}`);
      this.logRow('hello', `${machine ?? '?'}\\${user ?? '?'} ps=${ps ?? '?'} agent=${agent ?? '?'} version=${version ?? '?'} control=${control ?? '?'} caps=${caps.join(',')}`);
      await this.ctx.storage.setAlarm(expiresAt);
      await this.pushRegistry();
      // The PC's pointer carried the latest possible end; now the exact one is known.
      if (deviceId && firstAttach) await this.pinPointerEnd(deviceId, expiresAt);
      return Response.json({ type: 'welcome', generation, expires_at: expiresAt, server_time: now, ...(deviceId ? { driver: this.driver } : {}) });
    }
    const generation = await this.get('http_generation');
    if (state !== 'attached' || b.generation !== generation) return Response.json({ type: 'end', reason: 'replaced' }, { status: 409 });
    await this.setMany({ http_seen_at: Date.now() });
    if (b.type === 'end') {
      // At a saved PC the person ending it is its owner.
      const reason = deviceId ? 'owner' : 'customer';
      this.logRow('detached', deviceId ? 'owner end' : 'customer end');
      this.closeAll({ type: 'end', reason }, deviceId ? 'owner end' : 'customer end');
      this.failPending(() => true, deviceId ? 'session ended by the owner' : 'session ended by customer');
      await this.markEnded(reason);
      return Response.json({ type: 'end' });
    }
    if (b.type === 'poll') {
      // A client without the `lanes` cap has the one lane. It sends `busy`, and
      // a lanes client sends `busy_lanes`. A busy lane already has its command,
      // so the relay does not send that lane's frame again.
      const lanesClient = (await this.get('caps', [])).includes('lanes');
      const lanes = lanesClient ? LANES : ['cmd'];
      const busy = new Set(lanesClient && Array.isArray(b.busy_lanes) ? b.busy_lanes.filter((l) => lanes.includes(l)) : b.busy ? ['cmd'] : []);
      const report = decodePollReport(b);
      if (Object.keys(report).length) await this.setMany(report);
      // Every lane busy: a sign of life only. Answer at once and park nothing.
      // The client waits for its operations between these, so this is not a
      // tight loop. A client with one lane free keeps long-polling instead.
      if (lanes.every((l) => busy.has(l))) return Response.json(this.withDriver({ type: 'idle' }));
      for (const lane of lanes) {
        const c = this.httpCommands[lane];
        // A frame sent a moment ago is still the client's. Its next poll may
        // have left before the lane showed busy, and a repeat would run it twice.
        if (c && !busy.has(lane) && (c.sent_at === null || Date.now() - c.sent_at >= REDELIVER_MS)) {
          c.sent_at = Date.now();
          return Response.json(this.withDriver(c.frame));
        }
      }
      // One long poll per client. A retry releases its predecessor. The MCP
      // request and this fetch keep the in-memory result and poll state alive.
      this.replyToPoll({ type: 'idle' });
      return new Promise((resolve) => {
        const timer = setTimeout(() => this.releasePoll(), this.parkMs(busy));
        this.httpPoll = { resolve, timer, busy };
      });
    }
    if (b.type === 'result') {
      const pending = this.pending.get(b.id);
      const command = LANES.map((l) => this.httpCommands[l]).find((c) => c?.frame.id === b.id);
      if (pending && pending.tag === `http${generation}` && command) {
        let result;
        try { result = decodeHttpResult(b, command.frame); }
        catch (_) { return Response.json({ error: 'invalid result' }, { status: 400 }); }
        this.pending.delete(b.id);
        this.httpCommands[command.frame.lane] = null;
        // The lane is free now, so a parked poll that called it busy must not
        // hold back the next command for it.
        this.httpPoll?.busy.delete(command.frame.lane);
        pending.resolve(result);
        if (result.desktop) await this.setMany({ desktop: result.desktop });
        // A block_input result says at once whether input is blocked now, without waiting for the next poll.
        if (result.ok && command.frame.action?.name === 'block_input') await this.setMany({ input_blocked_until: result.input_blocked_until ?? null });
      }
      // Retried results are acknowledged without running anything again.
      return Response.json({ type: 'ack' });
    }
    return Response.json({ error: 'unknown message' }, { status: 400 });
  }

  async doEnd(request) {
    let actor = null;
    let workspace;
    let reason = null;
    let discard = false;
    let expectDriver = null;
    try {
      ({ actor = null, workspace, reason = null, discard = false, expect_driver: expectDriver = null } = await request.json());
    } catch (_) {}
    if (await this.otherWorkspace(workspace)) return Response.json({ ended: true });
    await this.expireIfDue();
    const state = await this.get('state');
    if (state === 'ended' || state === undefined) return Response.json({ ended: true });
    const deviceId = await this.get('device_id', null);
    // The built-in agent ends only a session its starter still drives. Once someone else
    // has taken it over, the session is theirs and this leaves it alone.
    if (expectDriver !== null && deviceId && this.driver !== sameIdentity(expectDriver)) {
      return Response.json({ ended: false, driver: this.driver });
    }
    // The team ends a session for a reason of its own (a stop, a removal). A
    // saved-PC session ended by a technician says so; a link session keeps its old reason.
    const why = OPERATOR_END_REASONS.includes(reason) ? reason : deviceId ? 'technician' : 'ended_by_operator';
    // A session made but never claimed (a lost race) ends without a trace.
    const quiet = discard === true && deviceId !== null && state === 'waiting';
    this.closeAll({ type: 'end', reason: why }, 'ended');
    this.failPending(() => true, 'session ended');
    await this.markEnded(why, actor, { quiet });
    return Response.json({ ended: true });
  }

  // Who has sent this session a command, and when (the last 10 people). The built-in
  // agent reads it to end its task when someone other than its starter takes over a
  // session that has no driver. Every command past the driver check counts.
  async noteActor(actor) {
    const who = sameIdentity(actor);
    if (!who) return;
    const seen = await this.get('actors', {});
    const next = { ...seen, [who]: Date.now() };
    const names = Object.keys(next).sort((a, b) => next[a] - next[b]);
    for (const old of names.slice(0, Math.max(0, names.length - 10))) delete next[old];
    await this.setMany({ actors: next });
  }

  // For the built-in agent: the session's state, its driver and who has commanded it.
  // Another workspace sees what a session that does not exist shows.
  async doWatch(url) {
    if (await this.otherWorkspace(url.searchParams.get('workspace'))) return Response.json({ state: 'unknown', actors: [] });
    await this.expireIfDue();
    const s = await this.ctx.storage.get(['state', 'device_id', 'device_name', 'driver', 'ended_reason', 'actors', 'opened_by_task']);
    return Response.json({
      state: s.get('state') ?? 'unknown',
      opened_by_task: s.get('opened_by_task') ?? null,
      ended_reason: s.get('ended_reason') ?? null,
      device_id: s.get('device_id') ?? null,
      device_name: s.get('device_id') ? s.get('device_name') ?? null : null,
      // A one-off session shows its driver here too (never to the PC), or null when it has none.
      driver: s.get('driver') ?? null,
      gen: this.gen,
      // The reservation made before the PC's record changes, for the queue to tell a claim that is still finishing.
      accepting: this.currentAccepting() ? { to: this.people.accepting.to, claim: !!this.people.accepting.claim } : null,
      handed_over: this.people.handed_over,
      participants: this.roster(),
      offer: this.offerView(),
      actors: Object.entries(s.get('actors') ?? {}).map(([actor, ts]) => ({ actor, ts })),
    });
  }

  // The team makes `actor` the driver of a live saved-PC session. The parked poll
  // is answered at once, so the corner window shows the new name.
  async doTakeover(request) {
    let actor = null;
    let workspace;
    let gen = null;
    try {
      ({ actor = null, workspace, gen = null } = await request.json());
    } catch (_) {}
    if (await this.otherWorkspace(workspace)) return Response.json({ ok: false });
    await this.expireIfDue();
    const state = await this.get('state');
    const next = sameIdentity(actor);
    if (!(await this.get('device_id', null)) || !['waiting', 'attached'].includes(state) || !next) return Response.json({ ok: false });
    // Every take-over is a new generation, also by the person who drives already (a pointer taken back from an accept
    // that has not finished): what began before it can no longer apply. `gen` is the one the PC's pointer took. An
    // older one than the session's own is a late delivery of a take-over that a newer change has passed.
    const to = Number.isInteger(gen) ? gen : this.gen + 1;
    // A take-over that is not above the session's own generation and names someone else does not apply, and says so: the
    // PC's pointer took the number first, so the session has passed it, and the caller must not be told they drive.
    if (to <= this.gen && !(to === this.gen && this.driver === next)) return Response.json({ ok: false, stale: true });
    if (to > this.gen) {
      if (this.driver !== next) {
        await this.applyDriver(next, { kind: 'take_over', gen: to });
      } else {
        const p = this.people;
        // An open offer ends with the take-over, and the log says so (applyDriver's own row covers a change of driver).
        if (p.offer) this.logRow('offer cancelled', 'by a take-over', next);
        p.offer = null;
        p.accepting = null;
        p.handed_over = null;
        this.cancelApproval('the session was taken over');
        this.gen = to;
        await this.setMany({ driver_gen: to });
        await this.savePeople();
      }
    }
    return Response.json({ ok: true, state, driver: this.driver });
  }

  // A saved-PC session pins its pointer's end to the real one at the first hello.
  // Best effort: the pointer's own bound still holds if this fails.
  async pinPointerEnd(deviceId, expiresAt) {
    try {
      await devicesFromEnv(this.env).pinSessionEnd(await this.get('workspace', DEFAULT_WORKSPACE), deviceId, await this.get('sid'), expiresAt);
    } catch (_) { /* best effort */ }
  }

  async markEnded(reason, actor = null, { quiet = false } = {}) {
    // Nothing is kept of the screen once the session is over, and nothing waits for an approval.
    this.over = true;
    this.frame = null;
    if (this.approval) this.finishApproval(this.approval.rec.id, { ended: true });
    this.cancelHeld('the session ended', null, { ended: true });
    const device = await this.get('device_id', null);
    await this.setMany({
      state: 'ended',
      ended_reason: reason,
      ended_at: Date.now(),
      expires_at: (await this.get('expires_at')) ?? Date.now(),
      ...(device && !quiet ? { cleanup_pending: true, cleanup_reason: reason, cleanup_actor: actor } : {}),
    });
    this.logRow('ended', reason, actor);
    await this.ctx.storage.deleteAlarm();
    await this.pushRegistry();
    if (device && !quiet) await this.runCleanup();
  }

  // A saved-PC session that ended writes device_session_ended and clears the PC's
  // pointer (devices.session), in one change. If the database is unreachable the
  // alarm tries again until it works, so a PC is never left looking busy.
  async runCleanup() {
    const s = await this.ctx.storage.get(['device_id', 'device_name', 'sid', 'workspace', 'cleanup_reason', 'cleanup_actor', 'driver', 'opened_by_task']);
    try {
      const deviceId = s.get('device_id');
      const reason = s.get('cleanup_reason');
      const actor = s.get('cleanup_actor') ?? (['owner', ...DECLINE_REASONS].includes(reason) ? `pc ${deviceId}` : 'relay');
      await devicesFromEnv(this.env).sessionEnded(s.get('workspace') ?? DEFAULT_WORKSPACE, {
        deviceId, sid: s.get('sid'), name: s.get('device_name') ?? '', reason, actor, driver: s.get('driver') ?? null, openedByTask: s.get('opened_by_task') ?? null,
      });
      await this.setMany({ cleanup_pending: false });
    } catch (_) {
      await this.ctx.storage.setAlarm(Date.now() + CLEANUP_RETRY_MS);
    }
  }

  async expire(reason) {
    this.closeAll({ type: 'end', reason: (await this.get('device_id', null)) ? reason : 'expired' }, 'expired');
    this.failPending(() => true, 'session ended');
    await this.markEnded(reason);
  }

  // ---- websocket (hibernation) --------------------------------------------
  async webSocketMessage(ws, data) {
    let msg;
    try {
      msg = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data));
    } catch (_) {
      return;
    }
    // A message from a socket of a stopped workspace ends the session, results
    // included, with an end frame to every socket. Read at most every 20 seconds;
    // a failed read fails open.
    if ((await this.get('state')) !== 'ended' && (await this.stopped())) {
      await this.endStopped();
      return;
    }
    if (msg.type === 'result' && msg.id) {
      const p = this.pending.get(msg.id);
      if (p && p.tag === this.socketTag(ws)) {
        this.pending.delete(msg.id);
        p.resolve(msg);
      }
      return;
    }
    if (this.socketTag(ws) !== await this.get('ws_tag')) return;
    const state = await this.get('state');
    if (state === 'ended') {
      try {
        ws.close(1000, 'ended');
      } catch (_) {}
      return;
    }
    if (msg.type === 'hello') {
      // One hello per socket. The tag names the socket's attach generation, so
      // `hello_tag` records which socket has already introduced itself. It sits
      // in storage, not memory, so it survives hibernation. A reattach gets a
      // new tag and may say hello once more.
      if ((await this.get('hello_tag')) === this.socketTag(ws)) return;
      const machine = truncate(String(msg.machine ?? ''), 100) || null;
      const user = truncate(String(msg.user ?? ''), 100) || null;
      const ps = truncate(String(msg.ps ?? ''), 40) || null;
      const agent = truncate(String(msg.agent ?? ''), 40) || null;
      const version = decodeVersion(msg.version);
      await this.setMany({ machine, user, ps, agent, version, hello_tag: this.socketTag(ws) });
      this.logRow('hello', `${machine ?? '?'}\\${user ?? '?'} ps=${ps ?? '?'} agent=${agent ?? '?'} version=${version ?? '?'}`);
      await this.pushRegistry();
      return;
    }
    if (msg.type === 'end') {
      this.logRow('detached', 'customer end');
      this.closeAll({ type: 'end', reason: 'customer' }, 'customer end');
      this.failPending(() => true, 'session ended by customer');
      await this.markEnded('customer');
    }
  }

  async webSocketClose(ws, code, reason) {
    const tag = this.socketTag(ws);
    this.failPending((p) => p.tag === tag, 'agent disconnected');
    try {
      ws.close(1000, 'bye');
    } catch (_) {}
    this.logRow('detached', `${tag ?? '?'} code=${code}`);
  }

  async webSocketError(ws) {
    const tag = this.socketTag(ws);
    this.failPending((p) => p.tag === tag, 'agent disconnected');
    this.logRow('detached', `${tag ?? '?'} error`);
  }

  async alarm() {
    await this.loadTtlOverride();
    const state = await this.get('state');
    // An ended saved-PC session whose pointer is not cleared yet tries again.
    if (state === 'ended' && (await this.get('cleanup_pending', false))) await this.runCleanup();
    const dl = await this.deadlineFor(state);
    if (dl === null) return; // ended (or never created): nothing to do
    if (Date.now() >= dl) {
      await this.expire(await this.expiryReason(state));
      return;
    }
    // An attached PowerShell session may have no traffic to check the stop on, so
    // the alarm does it. An app session checks on each of its polls.
    const ps = state === 'attached' && (await this.get('windows_mode', 'powershell')) === 'powershell';
    if (ps && (await this.stopped())) {
      await this.endStopped();
      return;
    }
    // An end during the stop read leaves nothing to wake for.
    if ((await this.get('state')) === 'ended') return;
    // Re-arm: for the next stop check, or (fired early, clock skew) the real deadline.
    await this.ctx.storage.setAlarm(ps ? this.wakeFor(dl) : dl);
  }
}

// A refusal of a command by the rules or the approval: ok false, the code, and an error that starts with it
// ("<code>: <text>"), which is how the tools show it.
function codedRefusal(code, text) {
  return Response.json({ ok: false, code, error: `${code}: ${text}` });
}

// A refusal from /people, /handover or /frame: the relay turns `code` into the tool's error code.
function refusal(code, error) {
  return Response.json({ ok: false, code, error });
}

// An identity as the session compares it: trimmed and lowercased. Empty when absent.
function sameIdentity(v) {
  return String(v ?? '').trim().toLowerCase();
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// The release version a hello may carry: SemVer, 32 characters at most. Anything else is dropped.
function decodeVersion(v) {
  return typeof v === 'string' && v.length <= 32 && VERSION_PATTERN.test(v) ? v : null;
}

// The /status answer. A session that does not exist is statusBody(new Map(), [], false).
function statusBody(s, rows, attached, people = { participants: [], offer: null, frame_rev: null, frame_at: null }) {
  const app = s.get('windows_mode') === 'app';
  return {
    state: s.get('state') ?? 'unknown',
    machine: s.get('machine') ?? null,
    user: s.get('user') ?? null,
    ps: s.get('ps') ?? null,
    windows_mode: s.get('windows_mode') ?? 'powershell',
    ...(app ? {
      elevated: s.get('elevated') ?? null,
      control: s.get('control') ?? null,
      caps: s.get('caps') ?? [],
      desktop: s.get('desktop') ?? null,
      // A deadline that has passed no longer says anything.
      paused_until: future(s.get('paused_until')),
      input_blocked_until: future(s.get('input_blocked_until')),
    } : {}),
    client_version: s.get('version') ?? s.get('agent') ?? null,
    client_agent: s.get('agent') ?? null,
    expires_at: s.get('expires_at') ?? null,
    startup_expires_at: s.get('state') === 'consumed' ? s.get('consumed_expires_at') ?? null
      : s.get('state') === 'waiting' ? s.get('waiting_expires_at') ?? null : null,
    ...(s.get('device_id') ? { device_id: s.get('device_id'), driver: s.get('driver') ?? null } : s.get('driver') ? { driver: s.get('driver') } : {}),
    participants: people.participants,
    offer: people.offer,
    frame_rev: people.frame_rev,
    frame_at: people.frame_at,
    ended_reason: s.get('ended_reason') ?? null,
    attached,
    log: rows,
  };
}

// A deadline in the future, or null. Status never reports one that has passed.
function future(ms) {
  return typeof ms === 'number' && ms > Date.now() ? ms : null;
}

function decodeHttpResult(b, frame) {
  // The app's error text is dropped for type_secret, so a secret can never come back in an error.
  if (b.ok === false && frame.action?.name === 'type_secret') return { ok: false, error: 'type_secret failed' };
  if (b.ok === false) return { ok: false, error: truncate(String(b.error || 'agent operation failed'), 1000) };
  const op = frame.type;
  if (op === 'screen') return decodeScreenResult(b, frame.action.name);
  if (op === 'control') return decodeControlResult(b);
  if (op === 'run') {
    const decode = (data, clipped) => {
      if (typeof data !== 'string' || data.length > 90000) throw new Error('bad output');
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      return new TextDecoder().decode(bytes) + (clipped ? '\n[truncated]' : '');
    };
    return {
      ok: true,
      exit_code: Number.isInteger(b.exit_code) ? b.exit_code : null,
      stdout: decode(b.stdout_b64, b.stdout_truncated),
      stderr: decode(b.stderr_b64, b.stderr_truncated),
      timed_out: b.timed_out === true,
    };
  }
  if (op === 'power') {
    if (!Number.isSafeInteger(b.at) || b.at < 0) throw new Error('bad at');
    return { ok: true, at: b.at };
  }
  if (op === 'programs') return decodePrograms(b, frame.action);
  if (op === 'put_file') {
    if (!Number.isSafeInteger(b.bytes) || b.bytes < 0 || b.bytes > PUT_B64_MAX) throw new Error('bad bytes');
    return { ok: true, bytes: b.bytes };
  }
  if (typeof b.data_b64 !== 'string' || b.data_b64.length > 699052 || !Number.isSafeInteger(b.size) || b.size < 0 || typeof b.eof !== 'boolean') {
    throw new Error('bad file result');
  }
  return { ok: true, data_b64: b.data_b64, size: b.size, eof: b.eof };
}

// The result of a programs frame. A list is checked entry by entry and its text clipped: it comes from the PC.
function decodePrograms(b, action) {
  if (action === 'list') {
    const rows = (v, max) => {
      if (!Array.isArray(v) || v.length > max) throw new Error('bad list');
      return v;
    };
    const text = (v, n) => truncate(typeof v === 'string' ? v : '', n);
    const installed = rows(b.installed, 2000).map((p) => {
      if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !p.id) throw new Error('bad program');
      return { id: truncate(p.id, 200), name: text(p.name, PROGRAM_NAME_MAX), version: text(p.version, 100), publisher: text(p.publisher, PROGRAM_NAME_MAX) };
    });
    const running = rows(b.running, 2000).map((r) => {
      if (!r || typeof r !== 'object' || !Number.isSafeInteger(r.pid)) throw new Error('bad process');
      return { name: text(r.name, PROGRAM_NAME_MAX), pid: r.pid, session: Number.isSafeInteger(r.session) ? r.session : null };
    });
    return { ok: true, installed, running };
  }
  // A close may also say how many programs it could not close (still_running), and an install or uninstall what
  // the installer wrote to its error output or what was stopped after it (detail). Both are passed on when present.
  if (action === 'close') {
    if (!Number.isSafeInteger(b.closed) || b.closed < 0) throw new Error('bad closed');
    return { ok: true, closed: b.closed, ...(Number.isSafeInteger(b.still_running) && b.still_running > 0 ? { still_running: b.still_running } : {}) };
  }
  const detail = typeof b.detail === 'string' && b.detail ? { detail: truncate(b.detail, 300) } : {};
  return { ok: true, exit_code: Number.isInteger(b.exit_code) ? b.exit_code : null, ...detail };
}
