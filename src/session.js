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
// client without it keeps one lane and cannot do screen work.
//
// A session belongs to the team workspace that created it (`workspace`, stored
// at create; a session without one is in "default"). Operator calls to
// /status, /command and /end name their workspace, and a call from another
// workspace gets exactly the answer for a session that does not exist. Calls
// that name none (the download page, consume, the app) skip the check.

import { registryName } from './registry.js';
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
const RESULT_SLACK_MS = 15 * 1000; // relay waits timeout_s + this
const HTTP_SEEN_MS = 60 * 1000; // app mode: a client counts as attached this long after its last request
const POLL_PARK_MS = 25 * 1000; // app mode: a long poll with nothing to send ends after this long
const REDELIVER_MS = 5 * 1000; // app mode: a frame already sent is not sent again sooner than this
const SCREEN_WAIT_MS = 30 * 1000; // screen frame: base wait for the app's result
const CONTROL_WAIT_MS = 120 * 1000; // request_full_control: UAC and the customer's dialogs
const LANE_OF = { run: 'cmd', put_file: 'cmd', get_file: 'cmd', screen: 'screen', control: 'screen' };
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
    this.httpCommands = { cmd: null, screen: null }; // app mode: per lane, {frame, tag, sent_at} waiting for its result
    this.httpPoll = null; // app mode: the parked long poll, if any, {resolve, timer, busy}
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
      await this.expire(DEADLINES[state][1]);
      return true;
    }
    return false;
  }

  // ---- routing -------------------------------------------------------------
  async fetch(request) {
    const url = new URL(request.url);
    const p = url.pathname;
    await this.loadTtlOverride();
    try {
      if (p === '/create') return await this.doCreate(request);
      if (p === '/consume') return await this.doConsume(request);
      if (p === '/agent') return await this.doAgent(request);
      if (p === '/ws') return await this.doWs(request);
      if (p === '/status') return await this.doStatus(url);
      if (p === '/command') return await this.doCommand(request);
      if (p === '/end') return await this.doEnd(request);
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
    this._ttlOverride = Number(b.ttl_ms) > 0 ? Number(b.ttl_ms) : 0;
    const codeExpiry = now + this.ttlMs(CODE_TTL_MS);
    await this.setMany({
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
      await this.ctx.storage.setAlarm(expiresAt);
    } else {
      // reattach: do NOT extend expiry
      await this.setMany({ ws_gen: gen, ws_tag: tag });
      this.logRow('attached', `reattach ${tag}`);
    }

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
      'windows_mode', 'transport', 'http_seen_at', 'elevated', 'caps', 'control', 'agent', 'desktop',
      'paused_until', 'input_blocked_until',
    ]);
    const rows = tail
      ? this.sql.exec(`SELECT ts,kind,detail FROM log ORDER BY ts DESC LIMIT ?`, tail).toArray().reverse()
      : [];
    const attached = s.get('transport') === 'https-poll'
      ? s.get('state') === 'attached' && Date.now() - (s.get('http_seen_at') || 0) < HTTP_SEEN_MS
      : !!(await this.currentSocket());
    return Response.json(statusBody(s, rows, attached));
  }

  async doCommand(request) {
    const b = await request.json();
    if (await this.otherWorkspace(b.workspace)) return Response.json({ ok: false, error: 'session ended' });
    await this.expireIfDue();
    const state = await this.get('state');
    if (state === 'ended' || state === undefined) return Response.json({ ok: false, error: 'session ended' });
    const lane = Object.hasOwn(LANE_OF, b.op) ? LANE_OF[b.op] : null;
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
    // From this check to the reservation below there is no await, so two
    // concurrent calls can't both take the same lane.
    if (isHttp && this.httpCommands[lane]) return Response.json({ ok: false, error: 'agent busy; wait for the current operation' });

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
      this.logRow('run', (as === 'system' ? '(system) ' : '') + truncate(String(b.command ?? ''), 512), b.actor);
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
      this.logRow('put_file', `${frame.path} (${bytes} bytes${frame.append ? ', append' : ''})`, b.actor);
    } else if (b.op === 'get_file') {
      let len = Number(b.length);
      if (!Number.isFinite(len) || len <= 0 || len > GET_FILE_MAX) len = GET_FILE_MAX;
      len = Math.floor(len);
      const off = Number(b.offset) > 0 ? Math.floor(Number(b.offset)) : 0;
      frame = { type: 'get_file', id, lane, path: String(b.path ?? ''), offset: off, length: len };
      waitMs = 60 * 1000 + RESULT_SLACK_MS;
      this.logRow('get_file', `${frame.path} (@${off}+${len})`, b.actor);
    } else if (b.op === 'screen') {
      try { action = normalizeAction(b.action); } catch (e) { return Response.json({ ok: false, error: e.message }); }
      // These two work only through the SYSTEM service, so a normal-mode app never sees them.
      if (FULL_ONLY.includes(action.name) && control !== 'full') return Response.json({ ok: false, error: `${action.name} needs full control` });
      frame = { type: 'screen', id, lane, action };
      waitMs = SCREEN_WAIT_MS + RESULT_SLACK_MS
        + (action.name === 'wait' ? action.seconds * 1000 : 0)
        + (action.text ? action.text.length * TYPE_MS_PER_CHAR : 0);
      // A screenshot is logged below, once its size is known. type_secret logs a bare name.
      if (action.name !== 'screenshot') this.logRow('screen', auditText(action), b.actor);
    } else {
      if (b.action !== 'request_full_control') return Response.json({ ok: false, error: 'bad action' });
      frame = { type: 'control', id, lane, action: 'request_full_control' };
      waitMs = CONTROL_WAIT_MS + RESULT_SLACK_MS;
      this.logRow('control', 'request_full_control', b.actor);
    }

    let target = ws;
    if (isHttp) {
      this.httpCommands[lane] = { frame, tag, sent_at: null };
      target = { send: () => this.dispatchHttp(lane) };
    }
    const result = await this.awaitResult(id, target, isHttp ? tag : this.socketTag(ws), frame, waitMs,
      b.op === 'control' ? { control_request: true } : {});
    if (b.op === 'control' || b.op === 'screen') return Response.json(await this.finishScreen(result, action, b.actor));
    return Response.json(result);
  }

  // Last touches on a screen or control result, before the operator sees it.
  async finishScreen(result, action, actor) {
    if (action?.name === 'screenshot') {
      const display = action.display ? ` display ${action.display}` : '';
      this.logRow('screen', result.ok ? `screenshot ${result.width}x${result.height}${display}` : `screenshot failed${display}`, actor);
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
    poll.resolve(Response.json(frame));
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
    const key = request.headers.get('X-Attach-Key') || '';
    if (state === 'pending' || (await this.get('windows_mode', 'powershell')) !== 'app'
      || (await sha256Hex(key)) !== (await this.get('key_hash'))) {
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    }
    let b;
    try { b = await request.json(); } catch (_) { return Response.json({ error: 'invalid JSON' }, { status: 400 }); }
    if (!b || typeof b !== 'object' || Array.isArray(b)) return Response.json({ error: 'invalid message' }, { status: 400 });
    // Recheck after hashing and body parsing, both of which can let an end or
    // expiry request run. A delayed hello must never resurrect ended access.
    await this.expireIfDue();
    state = await this.get('state');
    if (!state || state === 'ended') return Response.json({ type: 'end' }, { status: 410 });
    if (b.type === 'hello') {
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
      const firstAttach = state === 'consumed';
      const expiresAt = firstAttach ? now + this.ttlMs(ATTACHED_LIFE_MS) : await this.get('expires_at');
      const machine = truncate(String(b.machine ?? ''), 100) || null;
      const user = truncate(String(b.user ?? ''), 100) || null;
      const ps = truncate(String(b.ps ?? ''), 40) || null;
      const agent = truncate(String(b.agent ?? ''), 40) || null;
      const elevated = typeof b.elevated === 'boolean' ? b.elevated : null;
      const caps = decodeCaps(b.caps);
      await this.setMany({
        state: 'attached', transport: 'https-poll', http_generation: generation, http_seen_at: now,
        expires_at: expiresAt, machine, user, ps, elevated, agent, caps, control,
        desktop: null, paused_until: null, input_blocked_until: null,
        ...(firstAttach ? { attached_first_at: now } : {}),
      });
      this.logRow('attached', `${firstAttach ? '' : 'reattach '}http${generation} elevated=${elevated ?? 'unknown'}`);
      this.logRow('hello', `${machine ?? '?'}\\${user ?? '?'} ps=${ps ?? '?'} agent=${agent ?? '?'} control=${control ?? '?'} caps=${caps.join(',')}`);
      await this.ctx.storage.setAlarm(expiresAt);
      await this.pushRegistry();
      return Response.json({ type: 'welcome', generation, expires_at: expiresAt, server_time: now });
    }
    const generation = await this.get('http_generation');
    if (state !== 'attached' || b.generation !== generation) return Response.json({ type: 'end', reason: 'replaced' }, { status: 409 });
    await this.setMany({ http_seen_at: Date.now() });
    if (b.type === 'end') {
      this.logRow('detached', 'customer end');
      this.closeAll({ type: 'end', reason: 'customer' }, 'customer end');
      this.failPending(() => true, 'session ended by customer');
      await this.markEnded('customer');
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
      if (lanes.every((l) => busy.has(l))) return Response.json({ type: 'idle' });
      for (const lane of lanes) {
        const c = this.httpCommands[lane];
        // A frame sent a moment ago is still the client's. Its next poll may
        // have left before the lane showed busy, and a repeat would run it twice.
        if (c && !busy.has(lane) && (c.sent_at === null || Date.now() - c.sent_at >= REDELIVER_MS)) {
          c.sent_at = Date.now();
          return Response.json(c.frame);
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
    try {
      ({ actor = null, workspace } = await request.json());
    } catch (_) {}
    if (await this.otherWorkspace(workspace)) return Response.json({ ended: true });
    await this.expireIfDue();
    const state = await this.get('state');
    if (state === 'ended' || state === undefined) return Response.json({ ended: true });
    this.closeAll({ type: 'end', reason: 'ended_by_operator' }, 'ended');
    this.failPending(() => true, 'session ended');
    await this.markEnded('ended_by_operator', actor);
    return Response.json({ ended: true });
  }

  async markEnded(reason, actor = null) {
    await this.setMany({
      state: 'ended',
      ended_reason: reason,
      ended_at: Date.now(),
      expires_at: (await this.get('expires_at')) ?? Date.now(),
    });
    this.logRow('ended', reason, actor);
    await this.ctx.storage.deleteAlarm();
    await this.pushRegistry();
  }

  async expire(reason) {
    this.closeAll({ type: 'end', reason: 'expired' }, 'expired');
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
      await this.setMany({ machine, user, ps, agent, hello_tag: this.socketTag(ws) });
      this.logRow('hello', `${machine ?? '?'}\\${user ?? '?'} ps=${ps ?? '?'} agent=${agent ?? '?'}`);
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
    const dl = await this.deadlineFor(state);
    if (dl === null) return; // ended (or never created): nothing to do
    if (Date.now() >= dl) {
      await this.expire(DEADLINES[state][1]);
    } else {
      // fired early (clock skew / rescheduling): re-arm for the real deadline
      await this.ctx.storage.setAlarm(dl);
    }
  }
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// The /status answer. A session that does not exist is statusBody(new Map(), [], false).
function statusBody(s, rows, attached) {
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
    client_version: s.get('agent') ?? null,
    expires_at: s.get('expires_at') ?? null,
    startup_expires_at: s.get('state') === 'consumed' ? s.get('consumed_expires_at') ?? null : null,
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
  if (op === 'put_file') {
    if (!Number.isSafeInteger(b.bytes) || b.bytes < 0 || b.bytes > PUT_B64_MAX) throw new Error('bad bytes');
    return { ok: true, bytes: b.bytes };
  }
  if (typeof b.data_b64 !== 'string' || b.data_b64.length > 699052 || !Number.isSafeInteger(b.size) || b.size < 0 || typeof b.eof !== 'boolean') {
    throw new Error('bad file result');
  }
  return { ok: true, data_b64: b.data_b64, size: b.size, eof: b.eof };
}
