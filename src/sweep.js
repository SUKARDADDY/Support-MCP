// The hourly run (a Cron Trigger, `scheduled` in src/app.js). It does three things.
//
// It raises "missing" for each saved PC that crossed 7 days without contact: its last
// contact is older than 7 days and its doorbell is not connected. Last contact is the
// PC's last_seen, which a doorbell that closes also moves forward (src/registry.js), or
// its pairing time when last_seen is empty. The people who watch the PC hear of it
// (src/notify.js). The dedupe key is the PC plus that time, so a PC that stays missing is
// told of once, and one that returns and goes quiet again is told of again.
//
// Only work still to do is a candidate: a PC is picked only while some person who watches
// it, and has not switched the event off, lacks the row for that absence. A PC already told
// of costs nothing on later runs, so a crowd that goes quiet together is worked through
// over the hours, oldest absence first, instead of being revisited. A PC that crossed more
// than MISSING_WINDOW_MS ago is left out, so a PC that has been gone for months does not
// fill every run. The window is wide so that a backlog drains inside it, and it ends well
// before the 30 days after which the rows are deleted: past that, the deleted row would make
// the same absence look new.
//
// A run stays under the free plan's 50 subrequests (D1 queries and Registry calls). The
// teams with a candidate are taken in turn, and the first team moves every hour, so one big
// team cannot crowd out the rest. For each team the run asks its Registry which doorbells are
// connected, then picks that team's candidates with those PCs left out inside the query, and
// no more than the budget can handle: a PC that is connected can never fill the list ahead
// of a PC that is missing.
//
// It rings the saved PCs that are due an update: connected, active, below the release this relay
// serves, in the share of PCs the rollout offers it to (offerAtCheckIn, src/release.js), and not seen
// for an hour (a PC that checked in lately was offered the update then). A deploy does not make PCs
// reconnect, so without a ring a connected PC would hear of a release only at its next check-in, up
// to 6 hours later. The run finds the teams with such PCs in one query, takes a few in turn like the
// missing-PC pass does, lists each one's candidates in one query, and rings up to RING_PC_MAX of them
// in one call to the team's Registry. Nothing is stored: a PC that cannot update is rung once an
// hour, which costs it one small check-in. No ring is sent under EMERGENCY_STOP or without a release.
// The same pass runs from POST /api/v1/deployment/ring-updates (ringUpdates, below) right after a deploy.
//
// It deletes notifications older than 30 days.
//
// A workspace whose Registry cannot be read is skipped this hour: a PC is not called
// missing when we cannot tell whether its doorbell is connected.
import { teamFromEnv } from './workspace.js';
import { deviceHooks } from './device-sessions.js';
import { CHECK_IN_REFRESH_MS } from './devices.js';
import { notifyStore } from './notify.js';
import { offerAtCheckIn, releaseFrom } from './release.js';

export const MISSING_MS = 7 * 24 * 60 * 60 * 1000;
// MISSING_MS plus this must stay under KEEP_MS (src/notify.js) by more than a run's gap.
export const MISSING_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
// Of the 50: the query for the teams and the prune take two, and SUBREQUESTS are shared by the two
// passes. The ring pass keeps RING_SUBREQUESTS (its query for teams, then a team costs one query and,
// when it has PCs to ring, one Registry call), and the missing-PC pass has the rest. A team costs the
// missing-PC pass two (its doorbells, and its candidates), and a PC costs two (who hears of it, and the write).
export const SUBREQUESTS = 46;
export const RING_SUBREQUESTS = 9;
const TEAM_COST = 2;
// Connected ids go to the query as one JSON parameter. D1 allows 100 KB a statement, so a
// longer list is not sent: the query then reads that many extra rows, which can hold every
// connected PC, and the run drops them.
const ONLINE_PARAM_MAX = 60_000;
const PC_COST = 2;

// At most this many PCs are rung per team per pass, so a release does not start a wave of downloads.
export const RING_PC_MAX = 100;
// A team's candidates are read in one query, and are named in one Registry call (RING_LIST_MAX in
// src/registry.js is the same 500). A PC the rollout does not reach yet is read and dropped.
const RING_CANDIDATES = 500;
// The hourly run leaves PCs seen within the hour alone. The deploy-time route leaves the PCs that checked in
// within the last 5 minutes, which were offered the release then. Five minutes is the check-in's refresh
// time (CHECK_IN_REFRESH_MS): a PC seen more recently than that does not write last_seen when it checks in,
// so a PC rung while its last_seen was 2 to 5 minutes old would stay "due" and be rung again by every call.
export const RING_IDLE_MS = HOUR_MS;
export const RING_ROUTE_IDLE_MS = CHECK_IN_REFRESH_MS;
// The route's own budget, under the 50 a request may make (Access's key fetch and the caller's checks use a few).
export const RING_ROUTE_SUBREQUESTS = 40;

// The list started at `turn` places along, wrapping round.
const rotated = (list, turn) => (list.length ? [...list.slice(turn % list.length), ...list.slice(0, turn % list.length)] : list);

// True where a person of the team watches the PC `d`, has not switched device_missing off and
// has no row for the absence ending at `seen`. It reads members.notify the way readNotify
// (src/notify.js) does: damaged text, a watch that is not a list and an event that is not
// false all count as the defaults.
const UNTOLD = `EXISTS (
  SELECT 1 FROM members m, json_each(CASE WHEN json_valid(m.notify) AND json_type(m.notify, '$.watch') = 'array' THEN m.notify ELSE '{"watch":[]}' END, '$.watch') w
  WHERE m.workspace = d.workspace AND m.kind = 'person' AND w.value = d.id
    AND COALESCE(CASE WHEN json_valid(m.notify) THEN json_type(m.notify, '$.events.device_missing') END, '') <> 'false'
    AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.workspace = d.workspace AND n.recipient = m.identity AND n.dedupe = 'missing:' || d.id || ':' || COALESCE(d.last_seen, d.paired_at)))`;

// Ring the PCs due an update. Returns { rung, teams_left, next }: how many doorbells were rung, how many
// teams with candidates this pass did not reach, and where to go on. The hourly run takes the teams in turn
// (`turn`, where in the rotation to start) and has no next. The deploy-time route passes `after` (the next of
// its last answer, '' for the first call): it takes the teams in name order from the one after that, so a team
// it has passed is never visited again by the same round and the calls end when next is null, however many PCs
// are stuck below the release. teams_left counts only the teams after the cursor that have a PC below the
// release not seen lately: the PCs a pass rang check in, so they drop out of later rounds, and the ones that
// cannot update are passed once. budget is the subrequests this pass may make; idleMs the quiet a PC needs.
export async function ringUpdates(env, now, appBundle, { budget = RING_SUBREQUESTS, idleMs = RING_IDLE_MS, turn = 0, after = null } = {}) {
  if (String(env.EMERGENCY_STOP ?? '') !== '') return { rung: 0, teams_left: 0, next: null };
  const release = await releaseFrom(appBundle, env);
  if (!release) return { rung: 0, teams_left: 0, next: null };
  const quiet = now - idleMs;
  const cursor = after !== null;
  const teams = (await env.DB.prepare(
    `SELECT DISTINCT workspace FROM devices WHERE status = 'active' AND app_version <> '' AND app_version <> ? AND COALESCE(last_seen, paired_at) < ?${cursor ? ' AND workspace > ?' : ''} ORDER BY workspace`,
  ).bind(release.version, quiet, ...(cursor ? [after] : [])).all()).results.map((r) => r.workspace);
  const hooks = deviceHooks(env);
  let left = budget - 1;
  let rung = 0;
  let reached = 0;
  let last = null;
  for (const workspace of cursor ? teams : rotated(teams, turn)) {
    // A team costs its query and, with PCs to ring, one call to its Registry.
    if (left < 2) break;
    left -= 1;
    reached++;
    last = workspace;
    try {
      // Most recently seen first: a PC that is gone for good is last and never crowds out one that answers.
      const { results } = await env.DB.prepare(
        `SELECT id, workspace, status, app_version FROM devices WHERE workspace = ? AND status = 'active' AND app_version <> '' AND app_version <> ?
           AND COALESCE(last_seen, paired_at) < ? ORDER BY COALESCE(last_seen, paired_at) DESC, id LIMIT ?`,
      ).bind(workspace, release.version, quiet, RING_CANDIDATES).all();
      const due = [];
      for (const pc of results) if (await offerAtCheckIn(release, pc, env.UPDATE_ROLLOUT, now)) due.push(pc.id);
      if (!due.length) continue;
      left -= 1;
      // One call names every due PC (up to RING_CANDIDATES) and the Registry rings the first RING_PC_MAX with a
      // doorbell open, so PCs that are not connected cannot use up the share.
      rung += await hooks.ringMany(workspace, due, { max: RING_PC_MAX });
    } catch (_) { /* this team waits for the next pass */ }
  }
  const remaining = teams.length - reached;
  return { rung, teams_left: remaining, next: cursor && remaining > 0 ? last : null };
}

// appBundle is the app this relay serves (null when it serves none: then nothing is rung).
export async function sweep(env, now = Date.now(), appBundle = null) {
  const notify = notifyStore(env.DB, teamFromEnv(env));
  const turn = Math.floor(now / HOUR_MS);
  const hooks = deviceHooks(env);
  const crossed = now - MISSING_MS;
  const oldest = crossed - MISSING_WINDOW_MS;
  const teams = (await env.DB.prepare(
    `SELECT DISTINCT workspace FROM devices d WHERE d.status = 'active' AND COALESCE(d.last_seen, d.paired_at) < ? AND COALESCE(d.last_seen, d.paired_at) >= ? AND ${UNTOLD} ORDER BY workspace`,
  ).bind(crossed, oldest).all()).results.map((r) => r.workspace);
  let left = SUBREQUESTS - RING_SUBREQUESTS;
  for (const workspace of rotated(teams, turn)) {
    if (left < TEAM_COST + PC_COST) break;
    left -= 1;
    try {
      const online = await hooks.online(workspace);
      if (online === null) continue;
      left -= 1;
      const ids = JSON.stringify([...online]);
      const inQuery = ids.length <= ONLINE_PARAM_MAX;
      const { results } = await env.DB.prepare(
        `SELECT id, name, COALESCE(d.last_seen, d.paired_at) AS seen FROM devices d
         WHERE d.workspace = ? AND d.status = 'active' AND COALESCE(d.last_seen, d.paired_at) < ? AND COALESCE(d.last_seen, d.paired_at) >= ?
           AND d.id NOT IN (SELECT value FROM json_each(?)) AND ${UNTOLD}
         ORDER BY COALESCE(d.last_seen, d.paired_at), d.id LIMIT ?`,
      ).bind(workspace, crossed, oldest, inQuery ? ids : '[]', Math.floor(left / PC_COST) + (inQuery ? 0 : online.size)).all();
      for (const pc of results.filter((p) => !online.has(p.id))) {
        if (left < PC_COST) break;
        left -= PC_COST;
        await notify.write(workspace, await notify.rows(workspace, 'device_missing', { watching: pc.id }, {
          device_id: pc.id, title: 'A PC has not been seen for 7 days', body: pc.name, dedupe: `missing:${pc.id}:${pc.seen}`,
        }));
      }
    } catch (_) { /* this workspace waits for the next run */ }
  }
  try {
    await ringUpdates(env, now, appBundle, { turn });
  } catch (_) { /* the PCs hear of the release at their next check-in */ }
  await notify.prune(now);
}
