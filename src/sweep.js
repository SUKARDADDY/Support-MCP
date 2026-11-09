// The hourly run (a Cron Trigger, `scheduled` in src/app.js). It does two things.
//
// It raises "missing" for each saved PC that crossed 7 days without contact: its last
// contact is older than 7 days and its doorbell is not connected. Last contact is the
// PC's last_seen, which a doorbell that closes also moves forward (src/registry.js), or
// its pairing time when last_seen is empty. The people who watch the PC hear of it
// (src/notify.js). The dedupe key is the PC plus that time, so a PC that stays missing is
// told of once, and one that returns and goes quiet again is told of again. A PC that
// crossed more than MISSING_WINDOW_MS ago is left out, so a PC that has been gone for
// months does not fill every run.
//
// A run stays under the free plan's 50 subrequests (D1 queries and Registry calls). The
// PCs are taken one team at a time, and a team's PCs one at a time, in turn: the candidates
// are interleaved across teams, so one big team cannot crowd out the rest, and the starting
// point moves every hour, so what one run has no budget for the next one reaches.
//
// It deletes notifications older than 30 days.
//
// A workspace whose Registry cannot be read is skipped this hour: a PC is not called
// missing when we cannot tell whether its doorbell is connected.
import { teamFromEnv } from './workspace.js';
import { deviceHooks } from './device-sessions.js';
import { notifyStore } from './notify.js';

export const MISSING_MS = 7 * 24 * 60 * 60 * 1000;
const MISSING_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;
const PCS_PER_RUN = 500;
const HOUR_MS = 60 * 60 * 1000;
// Of the 50: the candidate query and the prune take two, a team costs one (its doorbells),
// and a PC costs two (who hears of it, and the write).
export const SUBREQUESTS = 46;
const TEAM_COST = 1;
const PC_COST = 2;

// The list started at `turn` places along, wrapping round.
const rotated = (list, turn) => (list.length ? [...list.slice(turn % list.length), ...list.slice(0, turn % list.length)] : list);

export async function sweep(env, now = Date.now()) {
  const notify = notifyStore(env.DB, teamFromEnv(env));
  const turn = Math.floor(now / HOUR_MS);
  // The first PC of each team, then the second of each, and so on.
  const { results } = await env.DB.prepare(
    `SELECT workspace, id, name, seen FROM (
       SELECT workspace, id, name, COALESCE(last_seen, paired_at) AS seen,
         ROW_NUMBER() OVER (PARTITION BY workspace ORDER BY COALESCE(last_seen, paired_at), id) AS n
       FROM devices WHERE status = 'active' AND COALESCE(last_seen, paired_at) < ? AND COALESCE(last_seen, paired_at) >= ?
     ) ORDER BY n, workspace LIMIT ?`,
  ).bind(now - MISSING_MS, now - MISSING_MS - MISSING_WINDOW_MS, PCS_PER_RUN).all();
  const byWorkspace = new Map();
  for (const pc of results) byWorkspace.set(pc.workspace, [...(byWorkspace.get(pc.workspace) ?? []), pc]);
  let left = SUBREQUESTS;
  for (const [workspace, pcs] of rotated([...byWorkspace], turn)) {
    if (left < TEAM_COST + PC_COST) break;
    left -= TEAM_COST;
    try {
      const online = await deviceHooks(env).online(workspace);
      if (online === null) continue;
      for (const pc of rotated(pcs.filter((p) => !online.has(p.id)), turn)) {
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
