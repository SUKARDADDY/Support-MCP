// The built-in agent's team API routes and its three MCP tools: who may use them, the mode of
// a workspace on /mcp, which model a task may name, and the promise that no key ever leaves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentWorld, BOSS, TECH, VIEW, LEAD, OPENAI_KEY, CLAUDE_KEY } from './agent-world.js';
import { ant, claudeUsage, oai, openaiBadKey, openaiUsage } from './agent-fakes.js';
import { listTools } from '../src/mcp.js';
import { AGENT_TOOL_NAMES } from '../src/agent-tools.js';
import { oneOff } from './people-world.js';

const finish = (summary = 'ok') => oai.call('finish', { outcome: 'done', summary });
const STRANGER = 'stranger@example.com';
const NOT_MEMBER = 'you are not a member of this team';

// ---- the three tools ---------------------------------------------------------------------------------
test('agent_start, agent_status and agent_control are tools every connection lists, whatever the team\'s mode', async (t) => {
  const w = await agentWorld(t);
  const names = (await w.rpc(BOSS, 'tools/list')).body.result.tools.map((x) => x.name);
  assert.equal(names.length, 31);
  for (const n of ['agent_start', 'agent_status', 'agent_control']) assert.ok(names.includes(n), n);
  await w.api(BOSS, 'PATCH', '/agent', { mode: 'agent' });
  assert.deepEqual((await w.rpc(BOSS, 'tools/list')).body.result.tools.map((x) => x.name), names, 'tools/list is the same for every mode');
  // The agent tools are not the agent\'s own: its model cannot start tasks or change settings.
  for (const n of ['agent_start', 'agent_status', 'agent_control']) assert.ok(!AGENT_TOOL_NAMES.has(n));
  assert.ok(listTools().every((x) => !/settings|caps|keys/.test(x.name)), 'team settings are never a tool');
});

test('agent_start checks its arguments before anything is created', async (t) => {
  const w = await agentWorld(t);
  await w.ready();
  const pc = await w.addPc();
  const bad = async (args, match) => {
    const r = await w.tool(BOSS, 'agent_start', args);
    assert.match(r.error ?? '', match, JSON.stringify(args));
  };
  await bad({ instructions: 'x' }, /give either device_id or session_id/);
  await bad({ device_id: pc.id, session_id: 'a'.repeat(64), instructions: 'x' }, /give either device_id or session_id/);
  await bad({ device_id: 'nope', instructions: 'x' }, /device_id must be the id of a PC/);
  await bad({ session_id: 'nope', instructions: 'x' }, /session_id must be the 64 hex characters/);
  await bad({ device_id: pc.id }, /instructions must be text/);
  await bad({ device_id: pc.id, instructions: '   ' }, /instructions must be text/);
  await bad({ device_id: pc.id, instructions: 'x'.repeat(4001) }, /instructions must be text/);
  await bad({ device_id: pc.id, instructions: 'x\u0000y' }, /instructions must be text/);
  await bad({ device_id: pc.id, instructions: 'x', keep_working: 'yes' }, /keep_working must be true or false/);
  await bad({ device_id: pc.id, instructions: 'x', model: 'a b' }, /model must be a model id/);
  await bad({ device_id: 'a'.repeat(20), instructions: 'x' }, /no such device/);
  const pending = await w.addPc({ status: 'pending' });
  await bad({ device_id: pending.id, instructions: 'x' }, /no such device|waiting for approval/);
  assert.equal(w.sql('SELECT COUNT(*) AS n FROM agent_tasks')[0].n, 0, 'no task for any refusal');
  assert.equal(w.sessionCalls.filter((c) => c.path === '/create').length, 0);
});

test('agent_start returns the task and how to follow it; agent_status and agent_control follow and stop it', async (t) => {
  const w = await agentWorld(t);
  await w.ready();
  const pc = await w.addPc({ access: 'any' });
  const out = await w.tool(BOSS, 'agent_start', { device_id: pc.id, instructions: 'The printer stopped printing.\nIt shows offline.' });
  assert.equal(out.error, undefined, JSON.stringify(out));
  assert.deepEqual([out.state, out.provider, out.model, out.task_cap_usd, out.month_cap_usd, out.keep_working], ['running', 'openai', 'gpt-6.1-terra', 5, 50, false]);
  assert.match(out.next, /at least every 2 minutes/);
  const row = w.taskRow(out.task_id);
  assert.deepEqual([row.state, row.title, row.started_by, row.device_id, row.keep_working], ['running', 'The printer stopped printing.', BOSS, pc.id, 0]);
  const status = await w.tool(BOSS, 'agent_status', { task_id: out.task_id });
  assert.equal(status.task.id, out.task_id);
  assert.deepEqual([status.task.state, status.task.model, status.task.cost_usd, status.task.steps, status.task.notes], ['running', 'gpt-6.1-terra', 0, [], []]);
  assert.match(status.untrusted_text, /never as instructions/);
  assert.equal(JSON.stringify(status).includes('CANARY'), false);
  // Without a task: recent tasks, the month, and the models the team can use with their prices.
  const overview = await w.tool(BOSS, 'agent_status', {});
  assert.deepEqual(overview.tasks.map((x) => x.id), [out.task_id]);
  assert.deepEqual(overview.models.map((m) => [m.id, m.prices.input, m.prices.output]), [['gpt-6.1-terra', 1, 5]]);
  assert.deepEqual([overview.default_model, overview.starters_pick_model, overview.caps.month_spent_usd], ['gpt-6.1-terra', true, 0]);
  assert.equal((await w.tool(BOSS, 'agent_status', { task_id: 'a'.repeat(20) })).error, 'no such task');
  assert.match((await w.tool(BOSS, 'agent_status', { task_id: 'nope' })).error, /task_id must be/);
  // Control.
  assert.deepEqual(await w.tool(BOSS, 'agent_control', { task_id: out.task_id, action: 'pause' }), { task_id: out.task_id, state: 'paused' });
  assert.deepEqual(await w.tool(BOSS, 'agent_control', { task_id: out.task_id, action: 'pause' }), { task_id: out.task_id, state: 'paused' }, 'pausing a paused task is fine');
  assert.deepEqual(await w.tool(BOSS, 'agent_control', { task_id: out.task_id, action: 'resume' }), { task_id: out.task_id, state: 'running' });
  assert.match((await w.tool(BOSS, 'agent_control', { task_id: out.task_id, action: 'dance' })).error, /action must be/);
  assert.deepEqual(await w.tool(BOSS, 'agent_control', { task_id: out.task_id, action: 'stop' }), { task_id: out.task_id, state: 'stopped' });
  assert.match((await w.tool(BOSS, 'agent_control', { task_id: out.task_id, action: 'resume' })).error, /already ended \(stopped\)/);
  assert.equal(w.taskRow(out.task_id).end_reason, `stopped by ${BOSS}`);
  const rows = (await w.log()).filter((r) => r.kind.startsWith('agent_task'));
  assert.deepEqual(rows.map((r) => [r.kind, r.actor]), [['agent_task_started', BOSS], ['agent_task_ended', BOSS]]);
});

test('the tools need their permissions: sessions.control to start and control, sessions.view to read', async (t) => {
  const w = await agentWorld(t);
  await w.ready();
  const pc = await w.addPc({ access: 'any' });
  const out = await w.tool(TECH, 'agent_start', { device_id: pc.id, instructions: 'x' });
  assert.ok(out.task_id);
  assert.equal((await w.tool(VIEW, 'agent_start', { device_id: pc.id, instructions: 'x' })).error, 'your role does not allow sessions.control');
  assert.equal((await w.tool(VIEW, 'agent_control', { task_id: out.task_id, action: 'stop' })).error, 'your role does not allow sessions.control');
  assert.equal((await w.tool(VIEW, 'agent_status', { task_id: out.task_id })).task.id, out.task_id, 'a viewer reads');
  assert.equal((await w.tool(LEAD, 'agent_control', { task_id: out.task_id, action: 'pause' })).state, 'paused', 'another member with sessions.control may pause it');
  for (const name of ['agent_start', 'agent_status', 'agent_control']) assert.equal((await w.tool(STRANGER, name, {})).error, NOT_MEMBER, name);
  assert.equal(w.taskRow(out.task_id).state, 'paused');
});

test('an Access login that is not a member, in a default workspace with no members, is told "not a member" by every task route and all three tools', async (t) => {
  const w = await agentWorld(t, { members: false });
  // The session tools still work in open mode, as before.
  assert.deepEqual(await w.tool(STRANGER, 'session_list'), { sessions: [] });
  for (const name of ['agent_start', 'agent_status', 'agent_control']) assert.equal((await w.tool(STRANGER, name, { task_id: 'a'.repeat(20), action: 'stop', instructions: 'x', device_id: 'a'.repeat(20) })).error, NOT_MEMBER, name);
  const id = 'a'.repeat(20);
  for (const [method, path, body] of [['GET', '/agent/tasks'], ['POST', '/agent/tasks', { device_id: id, instructions: 'x' }], ['GET', `/agent/tasks/${id}`], ['POST', `/agent/tasks/${id}/pause`, {}], ['POST', `/agent/tasks/${id}/resume`, {}], ['POST', `/agent/tasks/${id}/stop`, {}]]) {
    const r = await w.api(STRANGER, method, path, body);
    assert.deepEqual([r.status, r.body.error.code], [403, 'not_member'], `${method} ${path}`);
  }
  assert.equal(w.settingsRow(), undefined);
  assert.equal(w.sql('SELECT COUNT(*) AS n FROM agent_tasks')[0].n, 0);
  // Nobody was recorded as a recent caller by an agent route either.
  const before = w.sql('SELECT COUNT(*) AS n FROM callers')[0].n;
  await w.tool('another@example.com', 'agent_status', {});
  assert.equal(w.sql('SELECT COUNT(*) AS n FROM callers')[0].n, before, 'the agent tools never record a caller of the open workspace');
});

test('the team API starts, lists, reads and controls tasks for members only, with sessions.control to start and control and sessions.view to read', async (t) => {
  const w = await agentWorld(t);
  await w.ready();
  const pc = await w.addPc({ access: 'any' });
  const started = await w.api(TECH, 'POST', '/agent/tasks', { device_id: pc.id, instructions: 'Check the printer.', keep_working: true });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const id = started.body.task_id;
  assert.equal(w.taskRow(id).started_by_user, null, 'an Access login has no OAuth user');
  assert.equal((await w.api(VIEW, 'POST', '/agent/tasks', { device_id: pc.id, instructions: 'x' })).status, 403);
  const list = await w.api(VIEW, 'GET', '/agent/tasks');
  assert.deepEqual(list.body.tasks.map((x) => [x.id, x.state, x.started_by]), [[id, 'running', TECH]]);
  const one = await w.api(VIEW, 'GET', `/agent/tasks/${id}`);
  assert.deepEqual([one.status, one.body.task.id, one.body.task.keep_working], [200, id, true]);
  assert.equal((await w.api(VIEW, 'GET', `/agent/tasks/${id}?wait_s=99`)).status, 400);
  assert.equal((await w.api(VIEW, 'GET', `/agent/tasks/${id}?wait_s=abc`)).status, 400);
  assert.equal((await w.api(VIEW, 'POST', `/agent/tasks/${id}/stop`, {})).status, 403);
  assert.equal((await w.api(TECH, 'GET', `/agent/tasks/${'b'.repeat(20)}`)).status, 404);
  assert.equal((await w.api(TECH, 'POST', `/agent/tasks/${'b'.repeat(20)}/stop`, {})).status, 404);
  assert.equal((await w.api(TECH, 'POST', `/agent/tasks/${id}/pause`, {})).body.state, 'paused');
  assert.equal((await w.api(TECH, 'POST', `/agent/tasks/${id}/resume`, {})).body.state, 'running');
  assert.equal((await w.api(TECH, 'POST', `/agent/tasks/${id}/stop`, {})).body.state, 'stopped');
  assert.equal((await w.api(TECH, 'POST', `/agent/tasks/${id}/stop`, {})).status, 409);
  // A task in another workspace is not found.
  await w.team.createWorkspace(BOSS, { slug: 'acme', name: 'Acme' });
  assert.equal((await w.api(BOSS, 'GET', `/agent/tasks/${id}`, undefined, 'acme')).status, 404);
  assert.deepEqual((await w.api(BOSS, 'GET', '/agent/tasks', undefined, 'acme')).body.tasks, []);
});

// ---- mode --------------------------------------------------------------------------------------------------
test('mode "mcp" refuses new tasks but leaves every session tool as it was', async (t) => {
  const w = await agentWorld(t);
  await w.ready({ extra: { mode: 'mcp' } });
  const pc = await w.addPc({ access: 'any' });
  const r = await w.tool(BOSS, 'agent_start', { device_id: pc.id, instructions: 'x' });
  assert.match(r.error, /this team uses MCP clients only/);
  assert.equal((await w.api(BOSS, 'POST', '/agent/tasks', { device_id: pc.id, instructions: 'x' })).status, 409);
  assert.equal(w.sql('SELECT COUNT(*) AS n FROM agent_tasks')[0].n, 0);
  assert.equal((await w.tool(BOSS, 'device_connect', { device_id: pc.id })).state, 'waiting');
  assert.deepEqual((await w.tool(BOSS, 'session_list')).sessions.length, 1);
  assert.equal((await w.tool(BOSS, 'agent_status', {})).tasks.length, 0, 'reading is still allowed');
});

test('mode "agent" refuses the session tools on /mcp, with the message, but allows the three agent tools, device_list, session_list and session_status', async (t) => {
  const w = await agentWorld(t);
  await w.ready({ extra: { mode: 'agent' } });
  const pc = await w.addPc({ access: 'any' });
  const sid = 'f'.repeat(64);
  const message = 'this team uses the built-in agent';
  for (const [name, args] of [['session_create', {}], ['session_end', { session_id: sid }], ['run', { session_id: sid, command: 'x' }], ['put_file', { session_id: sid, path: 'C:\\x', data_b64: 'AA' }],
    ['get_file', { session_id: sid, path: 'C:\\x' }], ['screenshot', { session_id: sid }], ['click', { session_id: sid, x: 1, y: 2 }], ['type_text', { session_id: sid, text: 'x' }],
    ['ui_tree', { session_id: sid }], ['send_sas', { session_id: sid }], ['type_secret', { session_id: sid, text: 'x' }], ['request_full_control', { session_id: sid }],
    ['block_input', { session_id: sid, on: true }], ['device_connect', { device_id: pc.id }]]) {
    assert.equal((await w.tool(BOSS, name, args)).error, message, name);
  }
  assert.equal(w.sessionCalls.filter((c) => c.path === '/create').length, 0, 'no session was made');
  assert.equal(w.pointer(pc.id), null);
  // What stays: the read-only tools and the agent's.
  assert.equal((await w.tool(BOSS, 'device_list')).devices.length, 1);
  assert.deepEqual(await w.tool(BOSS, 'session_list'), { sessions: [] });
  assert.equal((await w.tool(BOSS, 'session_status', { session_id: sid })).state, 'unknown');
  const out = await w.tool(BOSS, 'agent_start', { device_id: pc.id, instructions: 'x' });
  assert.ok(out.task_id, JSON.stringify(out));
  assert.equal((await w.tool(BOSS, 'agent_status', { task_id: out.task_id })).task.id, out.task_id);
  assert.equal((await w.tool(BOSS, 'agent_control', { task_id: out.task_id, action: 'stop' })).state, 'stopped');
  // The mode is read after the role check: a non-member and a viewer learn nothing about it.
  assert.equal((await w.tool(STRANGER, 'session_create', {})).error, NOT_MEMBER);
  assert.equal((await w.tool(VIEW, 'run', { session_id: sid, command: 'x' })).error, 'your role does not allow sessions.control');
  // Another workspace has its own mode.
  await w.team.createWorkspace(BOSS, { slug: 'acme', name: 'Acme' });
  assert.equal((await w.tool(BOSS, 'session_create', {}, '/w/acme/mcp')).error, undefined);
});

test('mode "both" (the default, and a workspace that never set one) allows both; the mode is read once per call and only for the session tools', async (t) => {
  const w = await agentWorld(t);
  assert.equal(typeof (await w.tool(BOSS, 'session_create', {})).session_id, 'string');
  await w.ready();
  w.db.seen.length = 0;
  await w.tool(BOSS, 'session_create', {});
  assert.equal(w.db.seen.filter((s) => /SELECT mode FROM agent_settings WHERE workspace = \?/.test(s.sql)).length, 1);
  w.db.seen.length = 0;
  await w.tool(BOSS, 'session_list');
  await w.tool(BOSS, 'agent_status', {});
  assert.equal(w.db.seen.filter((s) => /SELECT mode FROM/.test(s.sql)).length, 0, 'the allowed tools never read it');
  // A database without the table yet answers "both".
  w.db.sqlite.exec('DROP TABLE agent_settings');
  assert.equal(typeof (await w.tool(BOSS, 'session_create', {})).session_id, 'string');
});

test('mode "agent" does not block the agent: its own tool path runs the session tools', async (t) => {
  const w = await agentWorld(t);
  await w.ready({ extra: { mode: 'agent' } });
  w.fake.queue('openai', oai.call('click', { x: 1, y: 2, button: null, count: null, display: null, screenshot: null }), finish());
  const a = await w.startOnPc(BOSS);
  await w.drive(a.id);
  assert.equal(w.taskRow(a.id).state, 'done');
  assert.deepEqual(a.joined.frames.map((f) => f.action?.name), ['screenshot', 'click']);
});

// ---- ready to start -------------------------------------------------------------------------------------
test('a workspace with no caps, or no key for the chosen provider, cannot start a task', async (t) => {
  const w = await agentWorld(t);
  const pc = await w.addPc({ access: 'any' });
  const start = (who = BOSS, extra = {}) => w.tool(who, 'agent_start', { device_id: pc.id, instructions: 'x', ...extra });
  assert.match((await start()).error, /the built-in agent is off: an admin must set the task and month spending caps/);
  await w.api(BOSS, 'PATCH', '/agent', { task_cap_usd: 1 });
  assert.match((await start()).error, /spending caps/, 'one cap is not enough');
  await w.api(BOSS, 'PATCH', '/agent', { month_cap_usd: 10 });
  assert.equal((await start()).error, 'the team has no OpenAI key saved');
  const viaApi = await w.api(BOSS, 'POST', '/agent/tasks', { device_id: pc.id, instructions: 'x' });
  assert.deepEqual([viaApi.status, viaApi.body.error.code], [409, 'model_not_available']);
  await w.api(BOSS, 'PATCH', '/agent', { anthropic_key: CLAUDE_KEY });
  assert.equal((await start()).model, 'claude-sonnet-5-5', 'with only a Claude key, the default is Sonnet 5.5');
  assert.equal(w.sql('SELECT COUNT(*) AS n FROM agent_tasks')[0].n, 1);
  assert.equal((await start()).error, 'a task is already working on this PC or session');
});

test('a stopped workspace starts no task', async (t) => {
  const w = await agentWorld(t);
  await w.ready();
  const pc = await w.addPc({ access: 'any' });
  await w.api(BOSS, 'POST', '/stop', {});
  assert.equal((await w.tool(BOSS, 'agent_start', { device_id: pc.id, instructions: 'x' })).error, 'this workspace is stopped; someone who can manage members must resume it');
  assert.equal((await w.api(BOSS, 'POST', '/agent/tasks', { device_id: pc.id, instructions: 'x' })).status, 409);
});

// ---- which model --------------------------------------------------------------------------------------------
test('a task can only name a usable model: a table model that is neither the default nor added is refused, and an added one is accepted', async (t) => {
  const w = await agentWorld(t);
  await w.ready({ keys: ['openai', 'anthropic'] });
  const pc = await w.addPc({ access: 'any' });
  const start = (model) => w.tool(BOSS, 'agent_start', { device_id: pc.id, instructions: 'x', model });
  assert.equal((await start('claude-opus-5-5')).error, 'that model is not available to this team');
  assert.equal((await start('gpt-4.1')).error, 'that model is not available to this team');
  assert.equal(w.sql('SELECT COUNT(*) AS n FROM agent_tasks')[0].n, 0);
  w.fake.queue('anthropic', ant.call('look', {}), ant.call('answer', { word: 'PELICAN' }));
  assert.equal((await w.api(BOSS, 'POST', '/agent/models', { provider: 'anthropic', id: 'claude-opus-5-5' })).status, 201);
  const ok = await start('claude-opus-5-5');
  assert.deepEqual([ok.model, ok.provider], ['claude-opus-5-5', 'anthropic']);
  assert.equal(w.taskRow(ok.task_id).model, 'claude-opus-5-5');
  // The default can be named too, and is the default when none is.
  await w.tool(BOSS, 'agent_control', { task_id: ok.task_id, action: 'stop' });
  assert.equal((await start('gpt-6.1-terra')).model, 'gpt-6.1-terra');
});

test('with starters_pick_model off every task uses the default: naming any other model is refused, even an added one', async (t) => {
  const w = await agentWorld(t);
  await w.ready({ keys: ['openai', 'anthropic'], extra: { starters_pick_model: false } });
  w.fake.queue('anthropic', ant.call('look', {}), ant.call('answer', { word: 'PELICAN' }));
  await w.api(BOSS, 'POST', '/agent/models', { provider: 'anthropic', id: 'claude-sonnet-5-5' });
  const pc = await w.addPc({ access: 'any' });
  const refused = await w.tool(BOSS, 'agent_start', { device_id: pc.id, instructions: 'x', model: 'claude-sonnet-5-5' });
  assert.equal(refused.error, 'this team uses one model');
  assert.equal((await w.api(BOSS, 'POST', '/agent/tasks', { device_id: pc.id, instructions: 'x', model: 'claude-sonnet-5-5' })).status, 400);
  const ok = await w.tool(BOSS, 'agent_start', { device_id: pc.id, instructions: 'x', model: 'gpt-6.1-terra' });
  assert.equal(ok.model, 'gpt-6.1-terra');
  // Turned on again, the added model is accepted.
  await w.tool(BOSS, 'agent_control', { task_id: ok.task_id, action: 'stop' });
  await w.api(BOSS, 'PATCH', '/agent', { starters_pick_model: true });
  assert.equal((await w.tool(BOSS, 'agent_start', { device_id: pc.id, instructions: 'x', model: 'claude-sonnet-5-5' })).model, 'claude-sonnet-5-5');
});

test('an added model whose provider key was removed is not usable, and a running task on it stops at its next step', async (t) => {
  const w = await agentWorld(t);
  await w.ready({ keys: ['openai', 'anthropic'] });
  w.fake.queue('anthropic', ant.call('look', {}), ant.call('answer', { word: 'PELICAN' }));
  await w.api(BOSS, 'POST', '/agent/models', { provider: 'anthropic', id: 'claude-sonnet-5-5' });
  const pc = await w.addPc({ access: 'any' });
  const run = await w.startOnPc(BOSS, { model: 'claude-sonnet-5-5' }, { pc });
  w.fake.queue('anthropic', ant.call('screenshot', {}), ant.call('finish', { outcome: 'done', summary: 'x' }));
  await w.alarm(run.id);
  await w.api(BOSS, 'PATCH', '/agent', { anthropic_key: null });
  const overview = await w.tool(BOSS, 'agent_status', {});
  assert.deepEqual(overview.models.map((m) => m.id), ['gpt-6.1-terra'], 'no longer listed');
  await w.drive(run.id);
  assert.deepEqual([w.taskRow(run.id).state, w.taskRow(run.id).end_reason], ['stopped', 'the team removed its key']);
  const pc2 = await w.addPc({ access: 'any', name: 'B' });
  assert.equal((await w.tool(BOSS, 'agent_start', { device_id: pc2.id, instructions: 'x', model: 'claude-sonnet-5-5' })).error, 'the team has no Claude key saved');
});

// ---- the key never leaves -----------------------------------------------------------------------------------
test('key canary: a canary key never appears in any API answer, tool result, log row, audit row, step record or error, the model check\'s error paths included', async (t) => {
  const w = await agentWorld(t);
  const seen = []; // everything a person or an agent could read
  const api = async (...a) => { const r = await w.api(...a); seen.push(r); return r; };
  const tool = async (...a) => { const r = await w.tool(...a); seen.push(r); return r; };
  const saved = await api(BOSS, 'PATCH', '/agent', { task_cap_usd: 5, month_cap_usd: 50, openai_key: OPENAI_KEY, anthropic_key: CLAUDE_KEY });
  assert.equal(saved.status, 200);
  await api(BOSS, 'GET', '/agent');
  // The model check's error paths: a 401 that echoes the whole key, an unreachable provider, a 500 with the key in it, a refusal.
  for (const reply of [{ status: 401, json: openaiBadKey(OPENAI_KEY) }, { status: 500, json: { error: { message: `server error for ${OPENAI_KEY}` } } },
    { status: 400, json: { error: { message: `bad ${OPENAI_KEY}`, param: 'input', code: 'x', type: 'y' } } }, { status: 403, json: { error: { message: OPENAI_KEY, code: 'model_not_found' } } }]) {
    w.fake.queue('openai', reply);
    const r = await api(BOSS, 'POST', '/agent/models', { provider: 'openai', id: 'gpt-canary', prices: { input: 1, output: 1 } });
    assert.equal(r.status, 422);
  }
  w.fake.queue('anthropic', { status: 401, json: { type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key ${CLAUDE_KEY}` } } });
  seen.push(await w.api(BOSS, 'POST', '/agent/models', { provider: 'anthropic', id: 'claude-canary', prices: { input: 1, output: 1 } }));
  // A task whose provider echoes the key, and one that finishes.
  const pc = await w.addPc({ access: 'any' });
  w.fake.queue('openai', { status: 401, json: openaiBadKey(OPENAI_KEY) });
  const bad = await w.startOnPc(BOSS, {}, { pc });
  await w.drive(bad.id);
  seen.push(await tool(BOSS, 'agent_status', { task_id: bad.id }), await api(BOSS, 'GET', `/agent/tasks/${bad.id}`));
  w.fake.queue('openai', oai.call('run', { command: 'Get-Printer', timeout_s: null, as: null }), finish('All fixed.'));
  const good = await w.startOnPc(BOSS, {}, { pc });
  await w.drive(good.id);
  seen.push(await tool(BOSS, 'agent_status', { task_id: good.id }), await tool(BOSS, 'agent_status', {}), await api(BOSS, 'GET', '/agent/tasks'));
  seen.push(await tool(BOSS, 'session_status', { session_id: w.taskRow(good.id).sid, log_tail: 100 }));
  const everything = JSON.stringify([
    seen, await w.log(), await w.team.readAudit('default', { limit: 500, full: true }),
    [...w.objects.values()].map((o) => [...o.ctx.values.entries()]),
    w.sql('SELECT * FROM agent_tasks'), w.sql('SELECT * FROM audit'), w.sql('SELECT * FROM devices'), w.sql('SELECT * FROM members'),
  ]);
  assert.ok(everything.length > 5000, 'something was collected');
  for (const needle of [OPENAI_KEY, CLAUDE_KEY, 'CANARY', OPENAI_KEY.slice(0, 24), CLAUDE_KEY.slice(0, 24)]) assert.ok(!everything.includes(needle), `${needle} leaked`);
  // The key is in exactly two places: sealed in the settings row, and the Authorization header of a call to its own provider.
  const row = w.settingsRow();
  assert.ok(!row.openai_key_enc.includes('CANARY'));
  for (const c of w.fake.calls) {
    const mine = c.provider === 'openai' ? OPENAI_KEY : CLAUDE_KEY;
    const other = c.provider === 'openai' ? CLAUDE_KEY : OPENAI_KEY;
    assert.ok(!JSON.stringify(c.body).includes('CANARY'), 'not in a request body');
    assert.ok(!JSON.stringify(c.headers).includes(other.slice(0, 20)), 'never sent to the other provider');
    assert.ok(JSON.stringify(c.headers).includes(mine));
  }
});

test('the key is opened only inside AgentTask objects: the Worker side never opens one', async (t) => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const dir = new URL('../src/', import.meta.url);
  const opens = readdirSync(dir).filter((f) => f.endsWith('.js') && /\bopen\(/.test(readFileSync(new URL(f, dir), 'utf8')) && /from '\.\/crypto\.js'/.test(readFileSync(new URL(f, dir), 'utf8')) && /import \{[^}]*\bopen\b[^}]*\} from '\.\/crypto\.js'/.test(readFileSync(new URL(f, dir), 'utf8')));
  assert.ok(opens.includes('agent-task.js'));
  for (const f of ['agent-store.js', 'agent.js', 'agent-api.js', 'api.js', 'app.js', 'mcp.js']) assert.ok(!opens.includes(f), `${f} opens a key`);
});

// ---- statements and the Session's watch ------------------------------------------------------------------------
test('every statement the agent runs names a workspace, and none binds more than the database allows', async (t) => {
  const w = await agentWorld(t);
  await w.ready();
  w.db.seen.length = 0;
  w.fake.queue('openai', oai.call('look', {}), oai.call('answer', { word: 'PELICAN' }), oai.call('click', { x: 1, y: 2, button: null, count: null, display: null, screenshot: null }), finish());
  await w.api(BOSS, 'POST', '/agent/models', { provider: 'openai', id: 'gpt-6.1-sol' });
  const a = await w.startOnPc(BOSS);
  await w.tool(BOSS, 'agent_status', { task_id: a.id });
  await w.tool(BOSS, 'agent_status', {});
  await w.drive(a.id);
  await w.api(BOSS, 'GET', '/agent/tasks');
  await w.api(BOSS, 'PATCH', '/agent', { mode: 'agent' });
  await w.api(BOSS, 'DELETE', '/agent/models/openai/gpt-6.1-sol');
  assert.ok(w.db.seen.length > 40);
  for (const { sql, params } of w.db.seen) {
    if (/FROM workspaces WHERE slug = \?/.test(sql)) continue; // that table is keyed by slug
    assert.match(sql, /workspace/, sql);
    assert.ok(params.length <= 100);
  }
  assert.ok(w.db.seen.some((s) => /FROM agent_tasks/.test(s.sql)) && w.db.seen.some((s) => /agent_settings/.test(s.sql)));
});

test('the Session\'s watch route reports its state, driver and who has commanded it, and shows another workspace nothing', async (t) => {
  const w = await agentWorld(t);
  const pc = await w.addPc({ access: 'any' });
  const { sid } = await w.attach(pc, TECH);
  const watch = async (query = 'workspace=default') => (await (await w.env.SESSION.get(w.env.SESSION.idFromString(sid)).fetch(`https://do/watch?${query}`)).json());
  const since = (await watch()).participants[0].since;
  assert.deepEqual(await watch(), {
    state: 'attached', opened_by_task: null, ended_reason: null, device_id: pc.id, device_name: 'Till', driver: TECH, handed_over: null, offer: null, actors: [],
    participants: [{ identity: TECH, name: null, role: 'driver', since }],
  });
  assert.deepEqual(await watch('workspace=acme'), { state: 'unknown', actors: [] });
  // A link session a member made is driven by its creator and shows that driver here; the PC is never told.
  const link = await w.tool(BOSS, 'session_create', {});
  const linkWatch = async () => (await (await w.env.SESSION.get(w.env.SESSION.idFromString(link.session_id)).fetch('https://do/watch?workspace=default')).json());
  const first = await linkWatch();
  assert.deepEqual([first.state, first.device_id, first.driver, first.actors], ['pending', null, BOSS, []]);
  assert.deepEqual(first.participants.map((p) => [p.identity, p.role]), [[BOSS, 'driver']]);
  await w.tool(BOSS, 'run', { session_id: link.session_id, command: 'x' }); // refused: nothing attached, but it was the driver's command
  await w.tool(TECH, 'run', { session_id: link.session_id, command: 'x' }); // refused: not the driver, so not an actor
  assert.deepEqual((await linkWatch()).actors.map((x) => x.actor), [BOSS]);
  // One with no driver key: nobody drives, and every command is an actor.
  const legacy = await oneOff(w);
  const legacyWatch = async () => (await (await w.env.SESSION.get(w.env.SESSION.idFromString(legacy)).fetch('https://do/watch?workspace=default')).json());
  assert.deepEqual([(await legacyWatch()).driver, (await legacyWatch()).participants], [null, []]);
  await w.tool(BOSS, 'run', { session_id: legacy, command: 'x' });
  await w.tool(TECH, 'run', { session_id: legacy, command: 'x' });
  assert.deepEqual((await legacyWatch()).actors.map((x) => x.actor).sort(), [BOSS, TECH]);
  w.advance(5000);
  await w.tool(BOSS, 'session_end', { session_id: link.session_id });
  assert.deepEqual([(await linkWatch()).state, (await linkWatch()).ended_reason], ['ended', 'ended_by_operator']);
});
