// The hourly run (a Cron Trigger, `scheduled` in src/app.js). It does two things.
//
// It raises "missing" for each saved PC that crossed 7 days without a check-in: its
// last_seen is older than 7 days and its doorbell is not connected. The people who
// watch the PC hear of it (src/notify.js). The dedupe key is the PC plus its last_seen,
// so a PC that stays missing is told of once, and one that returns and goes quiet
// again is told of again. A PC that crossed more than MISSING_WINDOW_MS ago is left
// out, so a PC that has been gone for months does not fill every run.
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

export async function sweep(env, now = Date.now()) {
  const notify = notifyStore(env.DB, teamFromEnv(env));
  const { results } = await env.DB.prepare(
    "SELECT workspace, id, name, last_seen FROM devices WHERE status = 'active' AND last_seen < ? AND last_seen >= ? ORDER BY workspace, last_seen LIMIT ?",
  ).bind(now - MISSING_MS, now - MISSING_MS - MISSING_WINDOW_MS, PCS_PER_RUN).all();
  const byWorkspace = new Map();
  for (const pc of results) byWorkspace.set(pc.workspace, [...(byWorkspace.get(pc.workspace) ?? []), pc]);
  for (const [workspace, pcs] of byWorkspace) {
    try {
      const online = await deviceHooks(env).online(workspace);
      if (online === null) continue;
      for (const pc of pcs.filter((p) => !online.has(p.id))) {
        await notify.write(workspace, await notify.rows(workspace, 'device_missing', { watching: pc.id }, {
          device_id: pc.id, title: 'A PC has not been seen for 7 days', body: pc.name, dedupe: `missing:${pc.id}:${pc.last_seen}`,
        }));
      }
    } catch (_) { /* this workspace waits for the next run */ }
  }
  await notify.prune(now);
}
