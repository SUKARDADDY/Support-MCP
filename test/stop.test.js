// Stopping a workspace, resuming it, and the relay-wide EMERGENCY_STOP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, BOSS, TECH, VIEW, LEAD } from './device-sessions-world.js';

const tick = () => new Promise((r) => setImmediate(r));
const until = async (fn) => { for (let i = 0; i < 200 && !fn(); i++) await tick(); assert.ok(fn(), 'timed out waiting'); };
const stopReads = (w, from) => w.db.seen.slice(from).filter((s) => /MAX\(seq\)[\s\S]*workspace_stopped/.test(s.sql)).length;

// ---- the routes ---------------------------------------------------------------------------
test('stop needs sessions.end, resume needs members.manage, and both are rows in the team log', async (t) => {
  const w = await world(t);
  const denied = await w.api(VIEW, 'POST', '/stop', {});
  assert.deepEqual([denied.status, denied.body.error.code], [403, 'permission_denied']);
  assert.match(denied.body.error.message, /sessions\.end/);
  assert.equal((await w.api('stranger@example.com', 'POST', '/stop', {})).body.error.code, 'not_member');
  assert.deepEqual((await w.api(VIEW, 'GET', '/stop')).body, { stopped: false });

  const stopped = await w.api(TECH, 'POST', '/stop', {});
  assert.deepEqual([stopped.status, stopped.body], [200, { stopped: true, sessions_ended: 0 }]);
  assert.deepEqual((await w.api(VIEW, 'GET', '/stop')).body, { stopped: true });
  // A technician stops it but cannot resume it.
  const refused = await w.api(TECH, 'DELETE', '/stop', {});
  assert.deepEqual([refused.status, refused.body.error.code], [403, 'permission_denied']);
  assert.match(refused.body.error.message, /members\.manage/);
  assert.equal((await w.api(LEAD, 'DELETE', '/stop', {})).status, 403);
  assert.deepEqual((await w.api(BOSS, 'DELETE', '/stop', {})).body, { stopped: false });
  assert.deepEqual((await w.api(VIEW, 'GET', '/stop')).body, { stopped: false });

  const rows = (await w.log()).filter((r) => r.kind.startsWith('workspace_'));
  assert.deepEqual(rows.map((r) => [r.kind, r.actor]), [['workspace_stopped', TECH], ['workspace_resumed', BOSS]]);
  const audit = await w.team.readAudit('default', { limit: 500, full: true });
  assert.equal(audit.verified, true, 'the chain verifies');
  // The route admits only GET, POST and DELETE, and nothing after /stop.
  assert.equal((await w.api(BOSS, 'PATCH', '/stop', {})).status, 405);
  assert.equal((await w.api(BOSS, 'POST', '/stop/x', {})).status, 404);
});

test('the state is the newest of the stop and resume rows by seq; stopping twice or resuming a running workspace adds no row', async (t) => {
  const w = await world(t);
  await w.api(BOSS, 'POST', '/stop', {});
  await w.api(BOSS, 'POST', '/stop', {});
  assert.equal((await w.kinds()).filter((k) => k === 'workspace_stopped').length, 1);
  await w.api(BOSS, 'DELETE', '/stop', {});
  await w.api(BOSS, 'DELETE', '/stop', {});
  assert.equal((await w.kinds()).filter((k) => k === 'workspace_resumed').length, 1);
  await w.api(BOSS, 'POST', '/stop', {});
  assert.deepEqual((await w.team.stopState('default')), { stopped: true });
  await w.api(BOSS, 'DELETE', '/stop', {});
  assert.deepEqual((await w.team.stopState('default')), { stopped: false });
  // The read touches only the stop and resume rows, and names the workspace.
  const from = w.db.seen.length;
  await w.team.stopState('default');
  const read = w.db.seen.slice(from);
  assert.equal(read.length, 1);
  assert.match(read[0].sql, /workspace = \?/);
  assert.deepEqual(read[0].params, ['default', 'default']);
});

test('a stopped workspace answers no tool call, tells a non-member nothing, and tools/list still works; resume restores it', async (t) => {
  const w = await world(t);
  const pc = await w.addPc();
  await w.tool(BOSS, 'device_list');
  await w.api(TECH, 'POST', '/stop', {});
  const message = 'this workspace is stopped; someone who can manage members must resume it';
  for (const [name, args] of [['session_list', {}], ['session_create', {}], ['device_list', {}], ['device_connect', { device_id: pc.id }], ['run', { session_id: 'a'.repeat(64), command: 'x' }], ['session_end', { session_id: 'a'.repeat(64) }]]) {
    assert.equal((await w.tool(BOSS, name, args)).error, message, name);
  }
  assert.equal((await w.tool('stranger@example.com', 'session_list')).error, 'you are not a member of this team');
  assert.equal((await w.tool(VIEW, 'device_connect', { device_id: pc.id })).error, 'your role does not allow sessions.control', 'the role check comes first');
  assert.equal((await w.rpc(BOSS, 'tools/list')).body.result.tools.length, 24, 'tools/list is static and still answers');
  assert.equal(w.pointer(pc.id), null, 'no session was started');
  await w.api(BOSS, 'DELETE', '/stop', {});
  assert.equal((await w.tool(BOSS, 'device_connect', { device_id: pc.id })).state, 'waiting');
});

test('stopping one workspace leaves another running', async (t) => {
  const w = await world(t);
  await w.team.createWorkspace(BOSS, { slug: 'acme', name: 'Acme' });
  await w.api(BOSS, 'POST', '/stop', {}, 'acme');
  assert.equal((await w.tool(BOSS, 'session_list', {}, '/w/acme/mcp')).error, 'this workspace is stopped; someone who can manage members must resume it');
  assert.deepEqual(await w.tool(BOSS, 'session_list'), { sessions: [] });
  assert.deepEqual((await w.api(BOSS, 'GET', '/stop')).body, { stopped: false });
  assert.deepEqual((await w.api(BOSS, 'GET', '/stop', undefined, 'acme')).body, { stopped: true });
});

test('while the default workspace is open anyone admitted may stop it, but resuming needs a first admin', async (t) => {
  const w = await world(t, { members: false });
  assert.equal((await w.api('anyone@example.com', 'POST', '/stop', {})).status, 200);
  assert.deepEqual((await w.api('anyone@example.com', 'GET', '/stop')).body, { stopped: true });
  const resume = await w.api('anyone@example.com', 'DELETE', '/stop', {});
  assert.deepEqual([resume.status, resume.body.error.code], [409, 'first_member']);
  assert.equal((await w.tool('anyone@example.com', 'session_list')).error, 'this workspace is stopped; someone who can manage members must resume it');
  await w.api(BOSS, 'POST', '/members', { identity: BOSS, role_id: 'admin' });
  assert.equal((await w.api(BOSS, 'DELETE', '/stop', {})).status, 200);
});

// ---- ending sessions ------------------------------------------------------------------------
test('a stop ends every live session in the list (saved PC and link), clears the PC, and rings every doorbell', async (t) => {
  const w = await world(t);
  const a = await w.addPc({ name: 'A' });
  const b = await w.addPc({ name: 'B' });
  const idle = await w.addPc({ name: 'Idle' });
  const attached = await w.attach(a, TECH);
  const waiting = await w.tool(TECH, 'device_connect', { device_id: b.id });
  const link = await w.tool(BOSS, 'session_create', {});
  const old = await w.tool(BOSS, 'session_create', {});
  await w.tool(BOSS, 'session_end', { session_id: old.session_id });
  const bells = [a, b, idle].map((pc) => w.ringSocket(pc.id));

  const res = await w.api(TECH, 'POST', '/stop', {});
  assert.deepEqual(res.body, { stopped: true, sessions_ended: 3 }, 'the session that had already ended is not counted');
  for (const sid of [attached.sid, waiting.session_id, link.session_id]) {
    assert.deepEqual([w.stateOf(sid), w.reasonOf(sid)], ['ended', 'stopped'], sid.slice(0, 8));
  }
  assert.equal(w.reasonOf(old.session_id), 'ended_by_operator', 'an earlier end is left as it was');
  assert.deepEqual([w.pointer(a.id), w.pointer(b.id)], [null, null]);
  for (const bell of bells) assert.deepEqual(bell.sent, ['{"type":"ring"}'], 'every doorbell is rung once');
  const ended = (await w.log()).filter((r) => r.kind === 'device_session_ended');
  assert.deepEqual(ended.map((r) => [r.actor, r.detail.split(' ').pop()]).sort(), [[TECH, 'stopped'], [TECH, 'stopped']]);
  // A second stop finds nothing live.
  assert.equal((await w.api(TECH, 'POST', '/stop', {})).body.sessions_ended, 0);
});

test('a stop ends at most 40 sessions directly; the rest end by their own check', async (t) => {
  const w = await world(t);
  const sids = [];
  for (let i = 0; i < 43; i++) sids.push((await w.tool(BOSS, 'session_create', {})).session_id);
  const res = await w.api(BOSS, 'POST', '/stop', {});
  assert.equal(res.body.sessions_ended, 40);
  assert.equal(sids.filter((sid) => w.stateOf(sid) !== 'ended').length, 3);
});

test('a session notices a stop on a poll even when the list missed it, checks at most every 20 seconds, and fails open', async (t) => {
  const w = await world(t);
  const pc = await w.addPc();
  const { sid, welcome } = await w.attach(pc, TECH);
  const poll = () => w.agent(sid, pc.key, { type: 'poll', generation: welcome.body.generation, busy_lanes: ['cmd', 'screen'] });
  assert.equal((await poll()).status, 200);
  // Stopped directly in the team log: the session list and the sessions were not told.
  await w.team.stopWorkspace('default', BOSS);
  let from = w.db.seen.length;
  w.advance(5000);
  for (let i = 0; i < 3; i++) assert.equal((await poll()).status, 200, 'inside the 20 seconds nobody looks');
  assert.equal(stopReads(w, from), 0);
  w.advance(15_000);
  from = w.db.seen.length;
  const res = await poll();
  assert.deepEqual([res.status, res.body], [410, { type: 'end', reason: 'stopped' }]);
  assert.equal(stopReads(w, from), 1);
  assert.deepEqual([w.stateOf(sid), w.reasonOf(sid)], ['ended', 'stopped']);
  assert.equal(w.pointer(pc.id), null);
});

test('an unreadable stop state does not end a session: a read error fails open', async (t) => {
  const w = await world(t);
  const pc = await w.addPc();
  const { sid, welcome } = await w.attach(pc, TECH);
  const prepare = w.db.prepare;
  w.db.prepare = (text) => {
    if (/workspace_stopped/.test(text)) throw new Error('D1 is down');
    return prepare(text);
  };
  w.advance(60_000);
  const res = await w.agent(sid, pc.key, { type: 'poll', generation: welcome.body.generation, busy_lanes: ['cmd', 'screen'] });
  w.db.prepare = prepare;
  assert.equal(res.status, 200, 'the stop read failed and the poll went on');
  assert.deepEqual(res.body, { type: 'idle', driver: TECH });
  assert.equal(w.stateOf(sid), 'attached');
});

test('a link session ends on its first request after a stop, and its stop check is also at most every 20 seconds', async (t) => {
  const w = await world(t);
  const link = await w.tool(BOSS, 'session_create', {});
  const ctx = w.sessionFor(link.session_id);
  // Make it a consumed app session with a known key.
  const consumed = await (await ctx.session.fetch(new Request('https://do/consume', { method: 'POST', body: JSON.stringify({ windows_mode: 'app' }) }))).json();
  const hello = (extra = {}) => ctx.session.fetch(new Request('https://do/agent', { method: 'POST', headers: { 'x-attach-key': consumed.key }, body: JSON.stringify({ type: 'hello', control: 'full', caps: [], ...extra }) }));
  assert.equal((await hello()).status, 200);
  await w.team.stopWorkspace('default', BOSS);
  w.advance(20_000);
  const res = await hello();
  assert.deepEqual([res.status, (await res.json()).reason], [410, 'stopped']);
  assert.equal(w.reasonOf(link.session_id), 'stopped');
});

// ---- EMERGENCY_STOP ------------------------------------------------------------------------
test('EMERGENCY_STOP refuses every tool call and every connect, whoever asks, but tools/list still answers', async (t) => {
  const w = await world(t);
  const pc = await w.addPc();
  w.env.EMERGENCY_STOP = '1';
  const message = 'this relay is stopped by its operator';
  for (const [name, args] of [['session_list', {}], ['session_create', {}], ['device_list', {}], ['device_connect', { device_id: pc.id }], ['run', { session_id: 'a'.repeat(64), command: 'x' }]]) {
    assert.equal((await w.tool(BOSS, name, args)).error, message, name);
  }
  assert.equal((await w.tool('stranger@example.com', 'session_list')).error, message, 'whoever asks');
  assert.equal(w.pointer(pc.id), null);
  assert.equal(w.sessionCalls.length, 0);
  assert.equal((await w.rpc(BOSS, 'tools/list')).body.result.tools.length, 24, 'tools/list is static and still answers');
  // The PC wire still answers its check-in (it must learn the session is gone).
  assert.equal((await w.hello(pc.key)).status, 200);
});

test('any non-empty EMERGENCY_STOP counts; an empty one or none does not', async (t) => {
  const w = await world(t);
  for (const value of ['', undefined]) {
    w.env.EMERGENCY_STOP = value;
    assert.deepEqual(await w.tool(BOSS, 'session_list'), { sessions: [] }, String(value));
  }
  for (const value of ['1', 'true', 'yes please', ' ', '0']) {
    w.env.EMERGENCY_STOP = value;
    assert.equal((await w.tool(BOSS, 'session_list')).error, 'this relay is stopped by its operator', JSON.stringify(value));
  }
});

test('EMERGENCY_STOP ends live sessions on their next request: saved PC, link session and PowerShell socket', async (t) => {
  const w = await world(t);
  const pc = await w.addPc();
  const { sid, welcome } = await w.attach(pc, TECH);
  const link = await w.tool(BOSS, 'session_create', {});
  const linkCtx = w.sessionFor(link.session_id);
  const consumed = await (await linkCtx.session.fetch(new Request('https://do/consume', { method: 'POST', body: JSON.stringify({ windows_mode: 'app' }) }))).json();
  const ps = await w.tool(BOSS, 'session_create', { windows_mode: 'powershell' });
  const psCtx = w.sessionFor(ps.session_id);
  const psKey = (await (await psCtx.session.fetch(new Request('https://do/consume', { method: 'POST', body: JSON.stringify({ windows_mode: 'powershell' }) }))).json()).key;

  w.env.EMERGENCY_STOP = '1';
  const poll = await w.agent(sid, pc.key, { type: 'poll', generation: welcome.body.generation, busy_lanes: [] });
  assert.deepEqual([poll.status, poll.body], [410, { type: 'end', reason: 'stopped' }]);
  assert.deepEqual([w.stateOf(sid), w.reasonOf(sid)], ['ended', 'stopped']);
  assert.equal(w.pointer(pc.id), null);

  const res = await linkCtx.session.fetch(new Request('https://do/agent', { method: 'POST', headers: { 'x-attach-key': consumed.key }, body: JSON.stringify({ type: 'hello', control: 'full', caps: [] }) }));
  assert.equal(res.status, 410);
  assert.equal(w.reasonOf(link.session_id), 'stopped');

  const sock = await psCtx.session.fetch(new Request('https://do/ws', { headers: { 'x-attach-key': psKey, upgrade: 'websocket' } }));
  assert.equal(sock.status, 410);
  assert.equal(w.reasonOf(ps.session_id), 'stopped');
});

test('a connect started before a stop cannot be claimed after it: the tool checks first', async (t) => {
  const w = await world(t);
  const pc = await w.addPc();
  await w.api(BOSS, 'POST', '/stop', {});
  assert.equal((await w.tool(TECH, 'device_connect', { device_id: pc.id })).error, 'this workspace is stopped; someone who can manage members must resume it');
  assert.equal((await w.tool(BOSS, 'device_connect', { device_id: pc.id, take_over: true })).error, 'this workspace is stopped; someone who can manage members must resume it');
  assert.equal(w.sessionCalls.filter((c) => c.path === '/create').length, 0);
});
