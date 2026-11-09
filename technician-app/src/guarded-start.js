// How a task is started (App's startAgentTask): the open session tabs on the same PC or session
// stop their screenshots first, and each holds exactly once and lets go exactly once. A guard is
// what a tab registers: { account, deviceId(), sessionId(), ended(), liveSession(), hold(), release(), follow(taskId) }.

// The relay's refusals that mean the session we picked is not usable now (the app learns a
// session's state only every few seconds, so it can be stale).
const STALE_SESSION = new Set(['session_ended', 'driven']);

// Tabs whose session has ended are left out: a task started on the PC makes a new session, which is a
// new tab, not the ended one.
export const guardsFor = (all, accountId, body) => [...all].filter((g) => g.account === accountId && !g.ended()
  && ((body.session_id && g.sessionId() === body.session_id) || (body.device_id && g.deviceId() === body.device_id)));

// Starts the task with `send(body)`. A start by PC goes to the session of an open tab that is
// connected and driven by this person, because the relay refuses to connect again to a PC whose
// session this app has open; if the relay then says that session is gone or taken, the start is
// tried once more by PC, with the holds still taken. Every guard is released once: by `follow`
// when the task started (a follow that throws is skipped, it does not undo the start), or here
// when it did not.
export async function guardedStart({ guards, body, send }) {
  const holding = new Set(guards);
  try {
    await Promise.all(guards.map((g) => g.hold()));
    const live = body.device_id ? guards.map((g) => g.liveSession()).find(Boolean) : null;
    const first = live ? { instructions: body.instructions, keep_working: body.keep_working, ...(body.model ? { model: body.model } : {}), session_id: live } : body;
    let started;
    try {
      started = await send(first);
    } catch (e) {
      if (first === body || !STALE_SESSION.has(e?.code)) throw e;
      started = await send(body);
    }
    for (const g of guards) {
      holding.delete(g);
      try {
        g.follow(started.task_id);
      } catch (_) {
        // the tab could not follow it; the task is running all the same
      }
    }
    return started;
  } catch (e) {
    for (const g of holding) g.release();
    throw e;
  }
}
