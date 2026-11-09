// The hourly run (a Cron Trigger, `scheduled` in src/app.js). It does two things.
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
// It deletes notifications older than 30 days.
//
// A workspace whose Registry cannot be read is skipped this hour: a PC is not called
// missing when we cannot tell whether its doorbell is connected.
import { teamFromEnv } from './workspace.js';
import { deviceHooks } from './device-sessions.js';
import { notifyStore } from './notify.js';

export const MISSING_MS = 7 * 24 * 60 * 60 * 1000;
// MISSING_MS plus this must stay under KEEP_MS (src/notify.js) by more than a run's gap.
export const MISSING_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
// Of the 50: the query for the teams and the prune take two, a team costs two (its
// doorbells, and its candidates), and a PC costs two (who hears of it, and the write).
export const SUBREQUESTS = 46;
const TEAM_COST = 2;
// Connected ids go to the query as one JSON parameter. D1 allows 100 KB a statement, so a
// longer list is not sent: the query then reads that many extra rows, which can hold every
// connected PC, and the run drops them.
const ONLINE_PARAM_MAX = 60_000;
const PC_COST = 2;

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

export async function sweep(env, now = Date.now()) {
  const notify = notifyStore(env.DB, teamFromEnv(env));
  const turn = Math.floor(now / HOUR_MS);
  const hooks = deviceHooks(env);
  const crossed = now - MISSING_MS;
  const oldest = crossed - MISSING_WINDOW_MS;
  const teams = (await env.DB.prepare(
    `SELECT DISTINCT workspace FROM devices d WHERE d.status = 'active' AND COALESCE(d.last_seen, d.paired_at) < ? AND COALESCE(d.last_seen, d.paired_at) >= ? AND ${UNTOLD} ORDER BY workspace`,
  ).bind(crossed, oldest).all()).results.map((r) => r.workspace);
  let left = SUBREQUESTS;
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
  await notify.prune(now);
}
