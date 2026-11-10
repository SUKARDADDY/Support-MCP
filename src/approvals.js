// The approvals a team's rules ask for, as the technician app reaches them: list the one waiting on a session, and
// answer it. The state is in the Session (src/session.js), which holds the approval, decides when it is over and
// cancels it. This file is the relay's side: it names the Session, and turns its refusals into TeamErrors.
// Who may answer, and the authenticator code, are checked in src/api.js before an answer is passed on.
import { TeamError } from './workspace.js';
import { deviceHooks } from './device-sessions.js';

const STATUS = { not_found: 404, bad_request: 400 };

export function approvalService(env) {
  const hooks = deviceHooks(env);

  async function call(slug, sid, body) {
    const r = await hooks.approvals(slug, sid, body);
    if (!r) throw new TeamError(503, 'unavailable', 'could not reach that session; try again');
    if (!r.ok) throw new TeamError(STATUS[r.code] ?? 400, r.code ?? 'bad_request', String(r.error ?? 'refused'));
    return r;
  }

  return {
    // The approval waiting on a session: { approvals: [] } or one { id, summary, actor, via, action, created_at,
    // expires_at, device_id, device_name }. The summary was built by the relay from the command.
    async list(slug, sid) {
      return { approvals: (await call(slug, sid, { op: 'list' })).approvals };
    },
    // Approve or deny the waiting approval `id`, as `approver`. A used, cancelled or timed-out one is 404.
    async answer(slug, sid, id, approve, approver) {
      await call(slug, sid, { op: 'answer', id, approve, approver });
      return { id, approved: approve };
    },
  };
}
