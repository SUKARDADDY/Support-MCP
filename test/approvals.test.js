// Approvals: an action the team's rules send to a technician waits in the Session, up to 5 minutes, and goes to the PC
// only after a member holding sessions.unattended approves it in the technician app with a fresh authenticator code.
// Everything that must not release it is here too: a denial, the timeout, a member without the permission, a code
// that was used, a handover, the end of the session, the built-in agent's Stop and Pause.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appWorld, skip } from './app-world.js';
import { BOSS, TECH, LEAD, until } from './agent-world.js';
import { Session } from '../src/session.js';
import { notifyStore } from '../src/notify.js';
import { deviceHooks } from '../src/device-sessions.js';
import { oai } from './agent-fakes.js';
import { answerFrame, asking, enrol, fresh, savedPc, setRules } from './rules-world.js';

const it = (name, fn) => test(name, { skip }, fn);
const ruled = { restart: 'approve', shutdown: 'approve', install: 'approve', uninstall: 'allow', close_program: 'allow' };
const finish = (summary = 'ok') => oai.call('finish', { outcome: 'done', summary });
const powers = (frames) => frames.filter((f) => f.type === 'power');
const rows = (w, event = 'approval_requested') => w.sql('SELECT recipient, event, title, body, session_id, device_id, dedupe FROM notifications WHERE event = ? ORDER BY id', event);

// The relay with a saved PC driven by TECH, the team's rules sending a restart to approval, and the app signed in as the
// people who may answer: LEAD (sessions.unattended) and BOSS (admin), and as TECH, who may not.
async function setup(t, { rules = ruled } = {}) {
  const w = await appWorld(t);
  await enrol(w, BOSS);
  await enrol(w, LEAD);
  const app = { lead: await w.connect(LEAD, { app: true }), boss: await w.connect(BOSS, { app: true }), tech: await w.connect(TECH, { app: true }) };
  for (const a of Object.values(app)) assert.equal(a.tokens.status, 200, JSON.stringify(a.tokens.body));
  await setRules(w, rules);
  const pc = await savedPc(w, t, { who: TECH });
  // A failing test must not leave a 5-minute timer behind.
  t.after(() => pc.session().cancelApproval('the test is over'));
  // The PC's own long poll keeps the session attached while the clock moves: a test moves it a lot.
  const here = () => w.sessionFor(pc.sid).ctx.values.set('http_seen_at', w.now());
  const list = (who) => w.appCall(app[who].access, 'GET', `/api/sessions/${pc.sid}/approvals`);
  const answer = async (who, id, approve, code) => w.appCall(app[who].access, 'POST', `/api/sessions/${pc.sid}/approvals/${id}`, { approve, ...(code === undefined ? {} : { code }) });
  const approve = async (who, id) => { const code = await fresh(w); here(); return answer(who, id, true, code); };
  const waiting = (tool = 'restart_pc', args = {}, who = TECH) => asking(w, pc.session, who, tool, { session_id: pc.sid, ...args });
  return { w, app, ...pc, here, list, answer, approve, waiting };
}

// ---- released by an approval --------------------------------------------------------------------------------------
it('a restart waits for an approval, tells the driver and the members who may approve, and goes to the PC with approved_by once approved', async (t) => {
  const { w, app, sid, pc, frames, list, approve, waiting, session } = await setup(t);
  const { call, approval } = await waiting();
  assert.equal(frames.length, 0, 'nothing is queued while it waits');
  assert.equal(approval.summary, 'Restart the PC in 30 seconds');
  assert.equal(approval.actor, TECH);
  assert.equal(approval.expires_at - w.now(), 5 * 60 * 1000);
  // Told: the driver, and every member who holds sessions.unattended (an admin does). Not a viewer.
  await until(() => rows(w).length === 3);
  const told = rows(w);
  assert.deepEqual(told.map((r) => r.recipient).sort(), [BOSS, LEAD, TECH].sort());
  assert.deepEqual([told[0].event, told[0].session_id, told[0].device_id, told[0].title], ['approval_requested', sid, pc.id, 'Approval needed']);
  assert.match(told[0].body, /^tech@example\.com asks to: Restart the PC in 30 seconds on Till\./);
  assert.equal(new Set(told.map((r) => r.dedupe)).size, 1);
  // The app reads what waits.
  const seen = await list('lead');
  assert.equal(seen.status, 200);
  assert.deepEqual(seen.body.approvals.map((a) => [a.id, a.summary, a.actor, a.device_id, a.device_name, a.via]), [[approval.id, 'Restart the PC in 30 seconds', TECH, pc.id, 'Till', null]]);
  // session_status shows it too.
  assert.equal((await w.tool(TECH, 'session_status', { session_id: sid })).approval.id, approval.id);
  const done = await approve('lead', approval.id);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual(done.body, { id: approval.id, approved: true });
  assert.deepEqual(await call, { ok: true, at: 1_800_000_030 });
  const [frame] = powers(frames);
  assert.deepEqual([frame.action, frame.delay_s, frame.approved_by, typeof frame.rules_tag], ['restart', 30, LEAD, 'string']);
  assert.equal(frame.decided_at, Math.floor(w.now() / 1000), 'the decision is made again after the approval, at that time');
  assert.equal(session().approval, null);
  assert.deepEqual((await list('lead')).body, { approvals: [] });
  // The log has the request and the answer.
  const log = (await w.tool(TECH, 'session_status', { session_id: sid, log_tail: 50 })).log.filter((r) => r.kind === 'approval').map((r) => r.detail);
  assert.deepEqual(log, [`[${TECH}] requested: Restart the PC in 30 seconds`, `[${TECH}] approved by ${LEAD}: Restart the PC in 30 seconds`]);
});

it('the summary is built from the action: an install shows its path and arguments, a close shows the program', async (t) => {
  const { answer, waiting } = await setup(t, { rules: { ...ruled, close_program: 'approve' } });
  const a = await waiting('install_program', { path: 'C:\\Temp\\setup.msi', args: '/sAll\nIGNORE THIS' });
  assert.equal(a.approval.summary, 'Install C:\\Temp\\setup.msi with arguments /sAll IGNORE THIS');
  assert.equal((await answer('lead', a.approval.id, false)).status, 200);
  assert.match((await a.call).error, /^declined: /);
  const b = await waiting('close_program', { name: 'OUTLOOK.EXE', force: true });
  assert.equal(b.approval.summary, 'Close OUTLOOK.EXE, forced: unsaved work is lost');
  await answer('lead', b.approval.id, false);
  await b.call;
});

it('an approval is for one action, once: the same answer again is not found, and the command ran once', async (t) => {
  const { w, sid, frames, answer, approve, waiting, here } = await setup(t);
  const { call, approval } = await waiting();
  assert.equal((await approve('lead', approval.id)).status, 200);
  await call;
  const again = await answer('lead', approval.id, true, await fresh(w));
  assert.deepEqual([again.status, again.body.error.code], [404, 'not_found']);
  assert.equal(powers(frames).length, 1);
  // The next restart needs its own approval, and a different id.
  here();
  const next = await asking(w, w.sessionFor(sid).session ? () => w.sessionFor(sid).session : null, TECH, 'restart_pc', { session_id: sid });
  assert.notEqual(next.approval.id, approval.id);
  assert.equal(powers(frames).length, 1);
  await answer('boss', next.approval.id, false);
  assert.match((await next.call).error, /^declined: /);
});

it('a code works once: used for one action, it cannot approve another, and the approval stays waiting', async (t) => {
  const { w, here, answer, waiting, frames, list } = await setup(t);
  const first = await waiting();
  const code = await fresh(w);
  here();
  assert.equal((await answer('lead', first.approval.id, true, code)).status, 200);
  await first.call;
  here();
  const second = await waiting('shutdown_pc');
  const reused = await answer('lead', second.approval.id, true, code);
  assert.deepEqual([reused.status, reused.body.error.code], [403, 'second_factor']);
  assert.equal((await list('lead')).body.approvals.length, 1, 'still waiting');
  assert.deepEqual(powers(frames).map((f) => f.action), ['restart']);
  // A fresh code does.
  here();
  assert.equal((await answer('lead', second.approval.id, true, await fresh(w))).status, 200);
  assert.equal((await second.call).ok, true);
  assert.deepEqual(powers(frames).map((f) => [f.action, f.approved_by]), [['restart', LEAD], ['shutdown', LEAD]]);
});

// ---- not released ----------------------------------------------------------------------------------------------
it('a denial refuses the call with declined and queues nothing; a denial needs no code', async (t) => {
  const { frames, answer, waiting, list } = await setup(t);
  const { call, approval } = await waiting();
  const denied = await answer('boss', approval.id, false);
  assert.deepEqual([denied.status, denied.body], [200, { id: approval.id, approved: false }]);
  assert.match((await call).error, new RegExp(`^declined: ${BOSS} declined this action`));
  assert.equal(frames.length, 0);
  assert.deepEqual((await list('boss')).body, { approvals: [] });
});

it('no answer in 5 minutes refuses with approval_timeout and queues nothing', async (t) => {
  const { frames, waiting, list } = await setup(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { call } = await waiting();
  t.mock.timers.tick(5 * 60 * 1000);
  assert.match((await call).error, /^approval_timeout: /);
  assert.equal(frames.length, 0);
  assert.deepEqual((await list('lead')).body, { approvals: [] });
});

it('an answer that comes after the 5 minutes finds nothing to approve, and the call ends with approval_timeout', async (t) => {
  const { w, frames, answer, waiting, here } = await setup(t);
  const { call, approval } = await waiting();
  w.advance(5 * 60 * 1000 + 1000);
  here();
  const late = await answer('lead', approval.id, true, await fresh(w));
  assert.deepEqual([late.status, late.body.error.code], [404, 'not_found']);
  assert.match((await call).error, /^approval_timeout: /);
  assert.equal(frames.length, 0);
});

it('a member without sessions.unattended cannot read or answer, whoever they are to the session; the approval stays waiting', async (t) => {
  const { w, frames, answer, list, waiting, session, here } = await setup(t);
  const { call, approval } = await waiting();
  // TECH drives the session and asked for the action, but holds no sessions.unattended.
  const read = await list('tech');
  assert.deepEqual([read.status, read.body.error.code], [403, 'permission_denied']);
  here();
  const code = await fresh(w);
  const tried = await answer('tech', approval.id, true, code);
  assert.deepEqual([tried.status, tried.body.error.code], [403, 'permission_denied']);
  assert.equal(frames.length, 0);
  assert.ok(session().approval);
  // The refused attempt did not spend the code: a member who may approve can use it.
  assert.equal((await answer('lead', approval.id, true, code)).status, 200);
  assert.equal((await call).ok, true);
});

it('a wrong code, no code and a malformed answer leave it waiting; a second client\'s token needs the code too', async (t) => {
  const { w, app, sid, frames, list, waiting, session, here } = await setup(t);
  const { call, approval } = await waiting();
  // A second sign-in of LEAD, as another client the same person registered, holds a token just as good for the
  // route, and still has no authenticator code: a stolen or spare token cannot approve.
  const other = await w.connect(LEAD, { app: true });
  assert.equal(other.tokens.status, 200);
  const send = (token, body) => w.appCall(token, 'POST', `/api/sessions/${sid}/approvals/${approval.id}`, body);
  const none = await send(other.access, { approve: true });
  assert.deepEqual([none.status, none.body.error.code], [400, 'bad_request']);
  const wrong = await send(other.access, { approve: true, code: '000000' });
  assert.deepEqual([wrong.status, wrong.body.error.code], [403, 'second_factor']);
  const malformed = await send(other.access, { approve: 'yes', code: await fresh(w) });
  assert.deepEqual([malformed.status, malformed.body.error.code], [400, 'bad_request']);
  assert.equal(frames.length, 0);
  assert.ok(session().approval);
  assert.equal((await list('lead')).body.approvals.length, 1);
  // An MCP client's token is not an app token.
  const mcpClient = await w.connect(LEAD, { app: false });
  assert.equal((await w.appCall(mcpClient.access, 'GET', `/api/sessions/${sid}/approvals`)).status, 401);
  const code = await fresh(w);
  here();
  assert.equal((await send(app.lead.access, { approve: true, code })).status, 200);
  assert.equal((await call).ok, true);
});

it('the approval route is the technician app\'s only: not the team API, for an Access login or a service token, and not an MCP tool', async (t) => {
  const { w, sid, frames, waiting, answer } = await setup(t);
  const { call, approval } = await waiting();
  for (const who of [BOSS, LEAD, TECH]) {
    const read = await w.api(who, 'GET', `/sessions/${sid}/approvals`);
    assert.equal(read.status, 404, who);
    const post = await w.api(who, 'POST', `/sessions/${sid}/approvals/${approval.id}`, { approve: true, code: '123456' });
    assert.equal(post.status, 404, who);
  }
  assert.equal(frames.length, 0);
  const listed = (await w.rpc(BOSS, 'tools/list')).body.result.tools.map((x) => x.name);
  assert.equal(listed.some((n) => /approv/i.test(n)), false, 'no tool answers an approval');
  // A bad id or a bad session in the path is a 404.
  assert.equal((await answer('lead', 'nope', false)).status, 404);
  await answer('lead', approval.id, false);
  await call;
});

// ---- who can approve at all ---------------------------------------------------------------------------------------------
it('a service-token driver has no approver: approval_unavailable at once, nothing waits, nothing is notified', async (t) => {
  const w = await appWorld(t);
  await setRules(w, ruled);
  await w.team.addMember('default', BOSS, { identity: 'ci-bot', role_id: 'technician' });
  const pc = await savedPc(w, t, { who: 'ci-bot' });
  const r = await w.tool('ci-bot', 'restart_pc', { session_id: pc.sid });
  assert.match(r.error, /^approval_unavailable: /);
  assert.equal(pc.session().approval, null);
  assert.equal(pc.frames.length, 0);
  assert.equal(rows(w).length, 0);
});

it('a team where nobody holds sessions.unattended (open mode has no members at all) has no approver', async (t) => {
  const w = await appWorld(t, { members: false });
  const notify = notifyStore(w.env.DB, w.team);
  assert.deepEqual(await notify.holders('default', 'sessions.unattended'), []);
  const full = await appWorld(t);
  assert.deepEqual((await notifyStore(full.env.DB, full.team).holders('default', 'sessions.unattended')).sort(), [BOSS, LEAD].sort());
});

// ---- one at a time, and nothing else is blocked -----------------------------------------------------------------------------
it('a second approval is busy, other commands go on meanwhile, and a command that cannot be sent spends no approval', async (t) => {
  const { w, sid, frames, answer, waiting, session } = await setup(t, { rules: { ...ruled, close_program: 'allow' } });
  const { call, approval } = await waiting();
  const second = await w.tool(TECH, 'shutdown_pc', { session_id: sid });
  assert.match(second.error, /^busy: another action is waiting for approval/);
  // Nothing else is blocked: a run, a close that needs none and a screenshot go straight through.
  assert.equal((await w.tool(TECH, 'run', { session_id: sid, command: 'whoami' })).exit_code, 0);
  assert.equal((await w.tool(TECH, 'close_program', { session_id: sid, name: 'OUTLOOK.EXE' })).closed, 1);
  assert.deepEqual(frames.map((f) => f.type), ['run', 'programs']);
  assert.equal(session().approval.rec.id, approval.id);
  await answer('lead', approval.id, false);
  await call;
});

it('rules that change while it waits decide again: an approved action the rules now never allow is refused, nothing is sent', async (t) => {
  const { w, frames, approve, waiting } = await setup(t);
  const { call, approval } = await waiting();
  await setRules(w, { ...ruled, restart: 'never' });
  assert.equal((await approve('lead', approval.id)).status, 200, 'the approver is told it was taken');
  assert.match((await call).error, /^rule_never: /);
  assert.equal(frames.length, 0);
});

it('rules that loosen while it waits send the command without waiting again', async (t) => {
  const { w, frames, approve, waiting } = await setup(t);
  const { call, approval } = await waiting();
  await setRules(w, { ...ruled, restart: 'allow' });
  await approve('lead', approval.id);
  assert.equal((await call).ok, true);
  assert.equal(powers(frames).length, 1);
  assert.equal(powers(frames)[0].approved_by, undefined);
});

// ---- cancelled by what the approval depended on ---------------------------------------------------------------------------------
it('a take-over cancels the waiting approval: the call ends with declined, the approval is gone, and approving it fails', async (t) => {
  const { w, pc, frames, list, answer, waiting, session, here } = await setup(t);
  const { call, approval } = await waiting();
  assert.equal((await w.tool(LEAD, 'device_connect', { device_id: pc.id, take_over: true })).takeover, undefined);
  assert.match((await call).error, /^declined: the approval was cancelled: control of the session moved/);
  assert.equal(session().approval, null);
  assert.deepEqual((await list('lead')).body, { approvals: [] });
  here();
  const late = await answer('lead', approval.id, true, await fresh(w));
  assert.deepEqual([late.status, late.body.error.code], [404, 'not_found']);
  assert.equal(frames.length, 0);
});

it('a handover cancels the waiting approval', async (t) => {
  const { w, sid, frames, waiting, session } = await setup(t);
  assert.equal((await w.tool(TECH, 'session_participants', { session_id: sid, action: 'invite', identity: LEAD })).error, undefined);
  assert.equal((await w.tool(LEAD, 'session_participants', { session_id: sid, action: 'join' })).error, undefined);
  const { call } = await waiting();
  assert.equal((await w.tool(TECH, 'session_handover', { session_id: sid, action: 'offer', identity: LEAD })).error, undefined);
  const accepted = await w.tool(LEAD, 'session_handover', { session_id: sid, action: 'accept' });
  assert.equal(accepted.driver, LEAD, JSON.stringify(accepted));
  assert.match((await call).error, /^declined: the approval was cancelled: control of the session moved/);
  assert.equal(session().approval, null);
  assert.equal(frames.length, 0);
});

it('the end of the session cancels it: the call ends, and a later approval finds nothing', async (t) => {
  const { w, sid, frames, answer, waiting, session, here } = await setup(t);
  const { call, approval } = await waiting();
  await w.tool(TECH, 'session_end', { session_id: sid });
  assert.match((await call).error, /session ended/);
  assert.equal(session().approval, null);
  here();
  const late = await answer('lead', approval.id, true, await fresh(w));
  assert.equal(late.status, 404);
  assert.equal(frames.length, 0);
});

it('a restart of the Session object drops the approval unsent: it is not on the list, and nothing is carried out', async (t) => {
  const { w, sid, frames, list, waiting, session } = await setup(t);
  const { call, approval } = await waiting();
  const held = w.sessions.get(sid);
  assert.equal(held.ctx.values.get('approval').id, approval.id, 'stored in the Session\'s own storage');
  const old = held.session;
  held.session = new Session(held.ctx, w.env);
  assert.deepEqual((await list('lead')).body, { approvals: [] });
  assert.equal(held.ctx.values.get('approval'), null);
  const log = (await w.tool(TECH, 'session_status', { session_id: sid, log_tail: 50 })).log.filter((r) => r.kind === 'approval').map((r) => r.detail);
  assert.match(log.at(-1), /dropped unsent: the session restarted/);
  assert.equal(frames.length, 0);
  assert.equal(session().approval, null);
  old.cancelApproval('the test is over');
  assert.match((await call).error, /^declined: /);
});

// ---- the built-in agent ---------------------------------------------------------------------------------------------------------------
it('the built-in agent waits for an approval inside its step, and the approver is told; once approved it carries on', async (t) => {
  const w = await appWorld(t);
  await enrol(w, BOSS);
  await enrol(w, LEAD);
  const lead = await w.connect(LEAD, { app: true });
  await setRules(w, ruled);
  await w.ready();
  w.fake.queue('openai', oai.call('restart_pc', { delay_s: null }), finish('restarted'));
  const { id, pc } = await w.startOnPc(TECH, {}, { handler: answerFrame });
  const sid = w.pointer(pc.id).id;
  const session = () => w.sessionFor(sid).session;
  const driven = w.drive(id);
  await until(() => session().approval);
  const approval = session().approval.rec;
  assert.deepEqual([approval.via, approval.task_id, approval.actor], ['agent', id, TECH]);
  await until(() => rows(w).length === 3);
  assert.match(rows(w).find((r) => r.recipient === TECH).body, /^tech@example\.com's agent asks to: Restart the PC in 30 seconds on Till\./);
  assert.deepEqual(rows(w).map((r) => r.recipient).sort(), [BOSS, LEAD, TECH].sort());
  assert.equal(w.taskRow(id).state, 'running');
  w.sessionFor(sid).ctx.values.set('http_seen_at', w.now());
  const code = await fresh(w);
  w.sessionFor(sid).ctx.values.set('http_seen_at', w.now());
  const done = await w.appCall(lead.access, 'POST', `/api/sessions/${sid}/approvals/${approval.id}`, { approve: true, code });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  await driven;
  assert.equal(w.taskRow(id).state, 'done');
  const log = (await w.tool(TECH, 'session_status', { session_id: sid, log_tail: 50 })).log;
  assert.ok(log.some((r) => r.kind === 'power' && r.detail.startsWith(`[${TECH} via agent]`)), 'the log says it was the agent');
  assert.ok(log.some((r) => r.kind === 'approval' && r.detail.includes(`approved by ${LEAD}`)));
});

it('the wait counts as activity: a task nobody watches is not stopped for it, and its steps show the tool and what it acted on', async (t) => {
  const w = await appWorld(t);
  await enrol(w, LEAD);
  const lead = await w.connect(LEAD, { app: true });
  await setRules(w, ruled);
  await w.ready();
  w.fake.queue('openai', oai.call('restart_pc', { delay_s: 60 }), finish('restarted'));
  const { id, pc } = await w.startOnPc(TECH, { keep_working: false }, { handler: answerFrame });
  const sid = w.pointer(pc.id).id;
  const session = () => w.sessionFor(sid).session;
  const driven = w.drive(id);
  await until(() => session().approval);
  // Three minutes pass with nobody reading the task's status: past its 2-minute watch rule.
  w.advance(3 * 60 * 1000);
  w.sessionFor(sid).ctx.values.set('http_seen_at', w.now());
  const code = await fresh(w);
  w.sessionFor(sid).ctx.values.set('http_seen_at', w.now());
  assert.equal((await w.appCall(lead.access, 'POST', `/api/sessions/${sid}/approvals/${session().approval.rec.id}`, { approve: true, code })).status, 200);
  await driven;
  assert.equal(w.taskRow(id).state, 'done', w.taskRow(id).end_reason);
  const steps = w.step(id).steps.map((s) => [s.verb, s.detail]);
  assert.ok(steps.some(([name, detail]) => name === 'restart_pc' && detail === 'in 60 s'), JSON.stringify(steps));
});

it('Stop cancels the approval the agent waits for: its call returns declined, nothing is sent, and the task ends stopped', async (t) => {
  const w = await appWorld(t);
  await setRules(w, ruled);
  await w.ready();
  w.fake.queue('openai', oai.call('restart_pc', { delay_s: null }), finish());
  const { id, pc } = await w.startOnPc(TECH, {}, { handler: answerFrame });
  const sid = w.pointer(pc.id).id;
  const session = () => w.sessionFor(sid).session;
  const driven = w.drive(id);
  await until(() => session().approval);
  assert.equal((await w.tool(TECH, 'agent_control', { task_id: id, action: 'stop' })).state, 'stopped');
  await driven;
  assert.equal(session().approval, null);
  assert.equal(w.taskRow(id).state, 'stopped');
  assert.equal(w.sessionCalls.filter((c) => c.sid === sid && c.body?.type === 'result' && c.body.at).length, 0, 'no restart reached the PC');
  const log = (await w.tool(TECH, 'session_status', { session_id: sid, log_tail: 50 })).log;
  assert.ok(!log.some((r) => r.kind === 'power'), 'nothing was queued');
});

it('Pause cancels it too, and a Pause or Stop of another task leaves a waiting approval alone', async (t) => {
  const w = await appWorld(t);
  await setRules(w, ruled);
  await w.ready();
  w.fake.queue('openai', oai.call('restart_pc', { delay_s: null }));
  const { id, pc } = await w.startOnPc(TECH, {}, { handler: answerFrame });
  const sid = w.pointer(pc.id).id;
  const session = () => w.sessionFor(sid).session;
  const stepping = w.alarm(id);
  await until(() => session().approval);
  // The Session only cancels an approval this task asked for.
  const hooks = deviceHooks(w.env);
  await hooks.approvals('default', sid, { op: 'cancel', task_id: 'someone-else' });
  assert.ok(session().approval, 'another task\'s cancel does nothing');
  assert.equal((await w.tool(TECH, 'agent_control', { task_id: id, action: 'pause' })).state, 'paused');
  await stepping;
  assert.equal(session().approval, null);
  assert.equal(w.taskRow(id).state, 'paused');
  assert.equal(w.sessionCalls.filter((c) => c.sid === sid && c.body?.type === 'result' && c.body.at).length, 0);
});
