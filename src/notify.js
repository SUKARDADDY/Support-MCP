// Notifications for the technician app: who hears about what, the rows, the feed
// and each member's settings. Every query is here, and every one filters by
// workspace, so one team never reads another's rows.
//
// A notification is one row per person per event (migrations/0007_notify.sql).
// When an event comes with a change to the team's data, its rows go into the same
// batch as that change (notifyStore.statements, built on the `cond` the guarded
// change hands to change()), so they exist exactly when the change does. An event
// with no change of its own (a PC coming online, the hourly check, a cleanup that
// gave up) is written alone (notifyStore.write). Either way a row carries a
// `dedupe` key, and the insert ignores a row whose key the person already has, so a
// retried change or a second run adds nothing.
//
// Only members who are people get rows: a service token never receives one. The
// team log is not touched. Title and body may repeat text from a customer's PC and
// are shown as text.
//
// Three events are not switchable: session_invited ("you were invited to a session"),
// control_offered ("someone offered you control") and approval_requested ("an action waits for
// your approval"). They are addressed to one named person and
// always reach them, whatever their settings say, so a person cannot miss that a colleague is
// waiting on them. They have their own write path (direct) and are not in EVENTS. The queue's
// events (escalation_opened, escalation_claimed) are switchable like the first six.
import { ADMIN_ROLE } from './permissions.js';
import { TeamError, normalizeIdentity } from './workspace.js';

export const EVENTS = Object.freeze([
  'task_finished', 'task_problem', 'session_declined', 'device_online', 'device_missing', 'device_waiting', 'escalation_opened', 'escalation_claimed',
]);
// Addressed to one named person and always delivered: no switch, and no recipients() lookup.
export const DIRECT_EVENTS = Object.freeze(['session_invited', 'control_offered', 'approval_requested']);
export const WATCH_MAX = 500;
export const FEED_LIMIT = 50;
export const KEEP_MS = 30 * 24 * 60 * 60 * 1000;
// A feed request may wait this long for a new row, checking the database every POLL_MS.
export const WAIT_MAX_S = 25;
export const POLL_MS = 2000;
// A saved PC's id (src/devices.js ID_RE, repeated here so the two files do not import each other).
const ID_RE = /^[a-z2-7]{20}$/;
const TITLE_MAX = 120;
const BODY_MAX = 300;

const clip = (v, n) => {
  const t = String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const bad = (message) => new TeamError(400, 'bad_request', message);

// A member's stored settings as { events: {<event>: bool}, watch: [ids] }, with every
// event named and the defaults filled in. A damaged value is the defaults.
export function readNotify(text) {
  let stored = null;
  try { stored = text ? JSON.parse(text) : null; } catch (_) { /* damaged: the defaults */ }
  const events = Object.fromEntries(EVENTS.map((e) => [e, !(stored && stored.events && stored.events[e] === false)]));
  const watch = stored && Array.isArray(stored.watch) ? stored.watch.filter((id) => typeof id === 'string' && ID_RE.test(id)) : [];
  return { events, watch };
}

// db: the D1 database. team: the team store (src/workspace.js), for the roles.
export function notifyStore(db, team) {
  const q = (sql, ...params) => db.prepare(sql).bind(...params);
  const COLUMNS = 'workspace, recipient, event, created_at, device_id, task_id, session_id, title, body, dedupe';
  // A person whose sign-in account is disabled (users.disabled_at, set by hand to lock someone out) hears nothing
  // and cannot be asked to approve. A member with no account row, such as an Access login, is active.
  const ACTIVE = 'NOT EXISTS (SELECT 1 FROM users u WHERE u.email = members.identity AND u.disabled_at IS NOT NULL)';
  const values = (slug, r) => [slug, r.recipient, r.event, r.created_at, r.device_id, r.task_id, r.session_id, r.title, r.body, r.dedupe];

  // The people an event goes to, as identities. `to` names people (the starter, the
  // driver), `watching` a PC id (those who watch it), `holding` a permission (those
  // whose role holds it). Someone whose own settings switch the event off is left out, and so is
  // anyone in `except` (the person who caused the event hears nothing of it).
  async function recipients(slug, event, { to = [], watching = null, holding = null, except = [] } = {}) {
    if (!EVENTS.includes(event)) throw new TypeError('unknown notification event');
    const named = new Set(to.map(normalizeIdentity));
    const skip = new Set(except.map(normalizeIdentity));
    if (!named.size && !watching && !holding) return [];
    const { results } = await q(`SELECT identity, role_id, notify FROM members WHERE workspace = ? AND kind = 'person' AND ${ACTIVE}`, slug).all();
    const roles = holding ? new Map((await team.listRoles(slug)).map((r) => [r.id, r.permissions])) : null;
    const out = [];
    for (const m of results) {
      const mine = readNotify(m.notify);
      const hit = named.has(m.identity)
        || (watching !== null && mine.watch.includes(watching))
        || (holding !== null && (m.role_id === ADMIN_ROLE || (roles.get(m.role_id) ?? []).includes(holding)));
      if (hit && mine.events[event] && !skip.has(m.identity)) out.push(m.identity);
    }
    return out;
  }

  // The people (never service tokens, never a disabled account) whose role holds `permission`, as identities. Admins hold every one.
  async function holders(slug, permission) {
    const { results } = await q(`SELECT identity, role_id FROM members WHERE workspace = ? AND kind = 'person' AND ${ACTIVE}`, slug).all();
    const roles = new Map((await team.listRoles(slug)).map((r) => [r.id, r.permissions]));
    return results.filter((m) => m.role_id === ADMIN_ROLE || (roles.get(m.role_id) ?? []).includes(permission)).map((m) => m.identity);
  }

  // The rows for one event, one per recipient. what: { device_id, task_id, session_id,
  // title, body, dedupe }. Nothing is written.
  async function rows(slug, event, who, what) {
    const at = Date.now();
    return (await recipients(slug, event, who)).map((recipient) => ({
      recipient, event, created_at: at,
      device_id: what.device_id ?? null, task_id: what.task_id ?? null, session_id: what.session_id ?? null,
      title: clip(what.title, TITLE_MAX), body: clip(what.body, BODY_MAX), dedupe: String(what.dedupe),
    }));
  }

  // The row for a direct event (session_invited, control_offered, approval_requested): one named member who is a person,
  // whatever their settings say. Nothing for a name that is not such a member. Nothing is written.
  async function direct(slug, event, to, what) {
    if (!DIRECT_EVENTS.includes(event)) throw new TypeError('unknown direct notification event');
    const who = normalizeIdentity(to);
    const found = await q(`SELECT identity FROM members WHERE workspace = ? AND identity = ? AND kind = 'person' AND ${ACTIVE}`, slug, who).first('identity');
    if (!found) return [];
    return [{
      recipient: who, event, created_at: Date.now(),
      device_id: what.device_id ?? null, task_id: what.task_id ?? null, session_id: what.session_id ?? null,
      title: clip(what.title, TITLE_MAX), body: clip(what.body, BODY_MAX), dedupe: String(what.dedupe),
    }];
  }

  // The statements that add `list` inside a guarded change: each runs only where the
  // change's own condition `[sql, params]` holds. Pass them from change().
  const statements = (slug, list, [cond, params]) => list.map((r) => q(
    `INSERT OR IGNORE INTO notifications(${COLUMNS}) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${cond}`, ...values(slug, r), ...params,
  ));

  // Adds `list` on its own, for an event that comes with no change of its own.
  async function write(slug, list) {
    if (!list.length) return;
    await db.batch(list.map((r) => q(`INSERT OR IGNORE INTO notifications(${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, ...values(slug, r))));
  }

  // One person's rows after `after`, oldest first. next is the id to ask after next time.
  async function feed(slug, identity, { after = 0, limit = FEED_LIMIT } = {}) {
    const { results } = await q(
      `SELECT id, event, created_at AS at, title, body, device_id, task_id, session_id FROM notifications
       WHERE workspace = ? AND recipient = ? AND id > ? ORDER BY id LIMIT ?`,
      slug, normalizeIdentity(identity), after, limit).all();
    return { items: results, next: results.length ? results.at(-1).id : after };
  }

  async function settings(slug, identity) {
    const text = await q('SELECT notify FROM members WHERE workspace = ? AND identity = ?', slug, normalizeIdentity(identity)).first('notify');
    return readNotify(text);
  }

  // body: { events?: {<event>: bool}, watch?: [device ids] }. A PATCH may send part of
  // it: events not named keep their value, and a watch list replaces the old one. The
  // write is one statement (json_patch), so two PATCHes at once both stay.
  async function patchSettings(slug, identity, body) {
    for (const k of Object.keys(body)) if (k !== 'events' && k !== 'watch') throw bad(`unknown setting: ${k.slice(0, 40)}`);
    if (!Object.hasOwn(body, 'events') && !Object.hasOwn(body, 'watch')) throw bad('send events, watch or both');
    const patch = {};
    if (Object.hasOwn(body, 'events')) {
      const e = body.events;
      if (e === null || typeof e !== 'object' || Array.isArray(e)) throw bad('events must be an object of event name to true or false');
      for (const [name, on] of Object.entries(e)) {
        if (!EVENTS.includes(name)) throw bad(`unknown event: ${name.slice(0, 40)}`);
        if (typeof on !== 'boolean') throw bad(`${name} must be true or false`);
      }
      patch.events = e;
    }
    if (Object.hasOwn(body, 'watch')) {
      const w = body.watch;
      if (!Array.isArray(w) || w.length > WATCH_MAX) throw bad(`watch must be a list of at most ${WATCH_MAX} PC ids`);
      if (w.some((id) => typeof id !== 'string' || !ID_RE.test(id))) throw bad('watch must hold PC ids from this team');
      const ids = [...new Set(w)];
      const found = ids.length ? await q('SELECT COUNT(*) AS n FROM devices WHERE workspace = ? AND id IN (SELECT value FROM json_each(?))', slug, JSON.stringify(ids)).first('n') : 0;
      if (found !== ids.length) throw bad('watch must hold PC ids from this team');
      patch.watch = ids;
    }
    const who = normalizeIdentity(identity);
    const r = await q("UPDATE members SET notify = json_patch(COALESCE(notify, '{}'), ?) WHERE workspace = ? AND identity = ? AND kind = 'person'", JSON.stringify(patch), slug, who).run();
    if (r.meta.changes !== 1) throw new TeamError(403, 'not_member', 'you are not a member of this team');
    return settings(slug, who);
  }

  // Deletes rows older than KEEP_MS, in every workspace. Returns how many.
  async function prune(now = Date.now()) {
    const r = await q('DELETE FROM notifications WHERE created_at < ?', now - KEEP_MS).run();
    return r.meta.changes;
  }

  return { recipients, holders, rows, direct, statements, write, feed, settings, patchSettings, prune };
}

// The feed, held open: the rows after `after` if there are any, otherwise a check every
// pollMs until there are or waitS seconds have passed (then an empty page). The waits are
// counted, not timed, so a test with a frozen clock still ends. tuning is for tests:
// { pollMs, sleep } (the handler's notify option also takes maxWaitS).
export async function waitForFeed(store, slug, identity, { after, waitS }, { pollMs = POLL_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let page = await store.feed(slug, identity, { after });
  for (let left = Math.floor((waitS * 1000) / pollMs); !page.items.length && left > 0; left--) {
    await sleep(pollMs);
    page = await store.feed(slug, identity, { after });
  }
  return page;
}
