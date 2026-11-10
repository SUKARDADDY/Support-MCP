// The six tools the team's rules govern (restart_pc, shutdown_pc, list_programs, install_program, uninstall_program,
// close_program), and the checks the Session makes before it queues a command on a saved PC: the rule's own
// refusals, hours, protected programs and folders, limited control, one-off sessions, and what every guarded frame
// carries. Approvals are in test/approvals.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentWorld, BOSS, TECH, VIEW } from './agent-world.js';
import { attachedLink } from './people-world.js';
import { HOURS, savedPc, setRules } from './rules-world.js';
import { REFUSAL_CODES, listTools } from '../src/mcp.js';
import { permissionForTool } from '../src/permissions.js';

const RULED = ['restart_pc', 'shutdown_pc', 'list_programs', 'install_program', 'uninstall_program', 'close_program'];
const ALLOW = { restart: 'allow', shutdown: 'allow', install: 'allow', uninstall: 'allow', close_program: 'allow' };
// A call of each guarded tool with arguments that pass its schema.
const CALLS = {
  restart_pc: {}, shutdown_pc: {}, install_program: { path: 'C:\\Temp\\setup.msi' }, uninstall_program: { program_id: 'acrobat' }, close_program: { name: 'OUTLOOK.EXE' },
};
const ofType = (frames, type) => frames.filter((f) => f.type === type);

// ---- the tools ----------------------------------------------------------------------------------------
test('the six tools take a session_id, need sessions.control, and say what the model must know', () => {
  const tools = listTools();
  for (const name of RULED) {
    const tool = tools.find((x) => x.name === name);
    assert.ok(tool, name);
    assert.ok(tool.inputSchema.required.includes('session_id'), name);
    assert.equal(permissionForTool(name), 'sessions.control', name);
  }
  for (const name of RULED.filter((n) => n !== 'list_programs')) {
    const text = tools.find((x) => x.name === name).description;
    assert.match(text, /follow the team's rules/, name);
    assert.match(text, /technician's approval in the technician app/, name);
    assert.match(text, /waits up to 5 minutes/, name);
    assert.match(text, /raw command through run/, name);
    for (const code of REFUSAL_CODES) assert.ok(text.includes(code), `${name} names ${code}`);
  }
  for (const name of ['restart_pc', 'shutdown_pc']) {
    const text = tools.find((x) => x.name === name).description;
    assert.match(text, /answers \{ ok: true, at \} straight away, before the PC acts/, name);
    assert.match(text, /Do not call it again/, name);
    assert.deepEqual([tools.find((x) => x.name === name).inputSchema.properties.delay_s.minimum, tools.find((x) => x.name === name).inputSchema.properties.delay_s.maximum], [5, 600]);
  }
  assert.deepEqual(REFUSAL_CODES, ['rule_never', 'business_hours', 'declined', 'approval_timeout', 'approval_unavailable', 'busy', 'rules_stale', 'protected_program', 'protected_folder', 'needs_full_control', 'not_found', 'not_saved_pc', 'needs_update']);
});

// ---- allowed: the frames ------------------------------------------------------------------------------------
test('an allowed restart and shutdown queue the pinned power frame, answered before the PC acts, with the tag and the decision time', async (t) => {
  const w = await agentWorld(t);
  const { pc, sid, frames } = await savedPc(w, t);
  await setRules(w, ALLOW);
  const tag = (await w.hello(pc.key)).body.rules_tag;
  assert.match(tag, /^[0-9a-f]{16}$/);
  const restart = await w.tool(TECH, 'restart_pc', { session_id: sid });
  assert.deepEqual(restart, { ok: true, at: 1_800_000_030 });
  const shutdown = await w.tool(TECH, 'shutdown_pc', { session_id: sid, delay_s: 120 });
  assert.deepEqual(shutdown, { ok: true, at: 1_800_000_120 });
  const [a, b] = ofType(frames, 'power');
  assert.deepEqual({ ...a, id: 'x' }, { type: 'power', id: 'x', lane: 'cmd', action: 'restart', delay_s: 30, rules_tag: tag, decided_at: 1_800_000_000, driver: TECH });
  assert.deepEqual([b.action, b.delay_s, b.rules_tag, b.approved_by], ['shutdown', 120, tag, undefined]);
  // The relay logs what it did.
  const log = (await w.tool(TECH, 'session_status', { session_id: sid, log_tail: 50 })).log.map((r) => r.kind);
  assert.equal(log.filter((k) => k === 'power').length, 2);
});

test('the delay is brought into 5 to 600 seconds, and a list, an install, an uninstall and a close queue the pinned programs frames', async (t) => {
  const w = await agentWorld(t);
  const { sid, frames } = await savedPc(w, t);
  await setRules(w, ALLOW);
  assert.equal((await w.tool(TECH, 'restart_pc', { session_id: sid, delay_s: 1 })).at, 1_800_000_005);
  assert.equal((await w.tool(TECH, 'restart_pc', { session_id: sid, delay_s: 99999 })).at, 1_800_000_600);
  assert.deepEqual(ofType(frames, 'power').map((f) => f.delay_s), [5, 600]);

  const list = await w.tool(TECH, 'list_programs', { session_id: sid });
  assert.deepEqual(list.installed.map((p) => p.id), ['acrobat', 'qb2024']);
  assert.deepEqual(list.running.map((p) => p.pid), [4120, 7000]);
  assert.deepEqual(await w.tool(TECH, 'install_program', { session_id: sid, path: 'C:\\Temp\\setup.msi', args: '/sAll', timeout_s: 9999 }), { ok: true, exit_code: 0 });
  assert.deepEqual(await w.tool(TECH, 'uninstall_program', { session_id: sid, program_id: 'acrobat' }), { ok: true, exit_code: 3010 });
  assert.deepEqual(await w.tool(TECH, 'close_program', { session_id: sid, name: 'OUTLOOK.EXE', force: true }), { ok: true, closed: 1 });
  assert.deepEqual(await w.tool(TECH, 'close_program', { session_id: sid, pid: 4120 }), { ok: true, closed: 1 });
  const [l, i, u, c1, c2] = ofType(frames, 'programs');
  assert.deepEqual([l.action, l.lane, l.rules_tag, l.decided_at], ['list', 'cmd', undefined, undefined], 'a list reads nothing and carries nothing');
  assert.deepEqual([i.action, i.path, i.args, i.timeout_s], ['install', 'C:\\Temp\\setup.msi', '/sAll', 600]);
  assert.deepEqual([u.action, u.program_id, u.timeout_s], ['uninstall', 'acrobat', 300]);
  assert.deepEqual([c1.action, c1.name, c1.pid, c1.force], ['close', 'OUTLOOK.EXE', undefined, true]);
  assert.deepEqual([c2.action, c2.name, c2.pid, c2.force], ['close', undefined, 4120, false]);
  for (const f of [i, u, c1, c2]) assert.ok(f.rules_tag && f.decided_at, f.action);
});

test('a bad call is refused with what to fix, before anything is queued', async (t) => {
  const w = await agentWorld(t);
  const { sid, frames } = await savedPc(w, t);
  await setRules(w, ALLOW);
  for (const [name, args, match] of [
    ['install_program', { path: '' }, /path is required/],
    ['install_program', { path: 'C:\\a.msi', args: 5 }, /args must be text/],
    ['uninstall_program', { program_id: '' }, /program_id is required/],
    ['close_program', {}, /either name or pid/],
    ['close_program', { name: 'a.exe', pid: 4 }, /either name or pid/],
    ['close_program', { pid: -4 }, /pid must be/],
    ['close_program', { name: 'a.exe', force: 'yes' }, /force must be/],
  ]) {
    assert.match((await w.tool(TECH, name, { session_id: sid, ...args })).error, match, `${name} ${JSON.stringify(args)}`);
  }
  assert.equal(frames.length, 0);
});

// ---- refused: nothing is queued -------------------------------------------------------------------------------
test('a never action is refused with its code and queues no frame, for every guarded tool', async (t) => {
  const w = await agentWorld(t);
  const { sid, frames, session } = await savedPc(w, t);
  await setRules(w, { restart: 'never', shutdown: 'never', install: 'never', uninstall: 'never', close_program: 'never' });
  for (const [name, args] of Object.entries(CALLS)) {
    const r = await w.tool(TECH, name, { session_id: sid, ...args });
    assert.match(r.error, /^rule_never: /, name);
  }
  assert.equal(frames.length, 0, 'no frame reached the PC');
  assert.deepEqual([session().httpCommands.cmd, session().httpCommands.screen], [null, null], 'no lane was taken');
  // The refusal is in the session log, and a list is still allowed: it only reads.
  assert.equal((await w.tool(TECH, 'list_programs', { session_id: sid })).installed.length, 2);
  const log = (await w.tool(TECH, 'session_status', { session_id: sid, log_tail: 50 })).log;
  assert.equal(log.filter((r) => r.kind === 'rules' && /refused restart in 30 s: rule_never/.test(r.detail)).length, 1);
});

test('the rules are read on every command: a change takes effect on the next call, and the frame carries the new tag', async (t) => {
  const w = await agentWorld(t);
  const { pc, sid, frames } = await savedPc(w, t);
  await setRules(w, { restart: 'never' });
  assert.match((await w.tool(TECH, 'restart_pc', { session_id: sid })).error, /^rule_never/);
  await setRules(w, { restart: 'allow' });
  assert.equal((await w.tool(TECH, 'restart_pc', { session_id: sid })).ok, true);
  const first = ofType(frames, 'power')[0].rules_tag;
  await setRules(w, { restart: 'allow', protected_programs: ['outlook'] });
  assert.equal((await w.tool(TECH, 'restart_pc', { session_id: sid })).ok, true);
  const second = ofType(frames, 'power')[1].rules_tag;
  assert.notEqual(first, second);
  assert.equal((await w.hello(pc.key)).body.rules_tag, second, 'the PC and the frame agree on the tag');
  // A customer's override changes the rules of that customer's PCs only.
  const customer = (await w.api(BOSS, 'POST', '/customers', { name: 'Acme Ltd' })).body.customer.id;
  const site = (await w.api(BOSS, 'POST', '/sites', { name: 'Main', customer_id: customer })).body.site.id;
  await w.api(BOSS, 'PATCH', `/devices/${pc.id}`, { site_id: site });
  await setRules(w, { restart: 'never' }, customer);
  assert.match((await w.tool(TECH, 'restart_pc', { session_id: sid })).error, /^rule_never/);
  assert.equal(frames.filter((f) => f.type === 'power').length, 2);
});

test('hours: outside_hours refuses during business hours, approve_in_hours needs no approval outside them', async (t) => {
  const w = await agentWorld(t);
  const { sid, frames } = await savedPc(w, t);
  // Friday 08:00 UTC is inside 07:00 to 18:00 in UTC, and 21:00 the same day, outside them, in Auckland.
  const rules = { hours: HOURS, restart: 'outside_hours', shutdown: 'approve_in_hours', install: 'allow', uninstall: 'allow', close_program: 'allow' };
  await setRules(w, { ...rules, time_zone: 'UTC' });
  assert.match((await w.tool(TECH, 'restart_pc', { session_id: sid })).error, /^business_hours: /);
  assert.equal(frames.length, 0);
  await setRules(w, { ...rules, time_zone: 'Pacific/Auckland' });
  assert.equal((await w.tool(TECH, 'restart_pc', { session_id: sid })).ok, true);
  const shut = await w.tool(TECH, 'shutdown_pc', { session_id: sid });
  assert.equal(shut.ok, true, 'approve_in_hours allows outside business hours without an approval');
  const [r, s] = ofType(frames, 'power');
  assert.equal(r.decided_at, 1_800_000_000);
  assert.equal(s.approved_by, undefined);
  // The hours are the relay's own reckoning at each call: back in UTC the same restart is refused again.
  await setRules(w, { ...rules, time_zone: 'UTC' });
  assert.match((await w.tool(TECH, 'restart_pc', { session_id: sid })).error, /^business_hours: /);
  assert.equal(ofType(frames, 'power').length, 2);
});

test('protected programs: a name the rules protect cannot be closed or uninstalled, by name, by pid or by the id of a listed program', async (t) => {
  const w = await agentWorld(t);
  const { sid, frames } = await savedPc(w, t);
  await setRules(w, { ...ALLOW, protected_programs: ['QBW.EXE', 'QuickBooks Desktop 2024'] });
  // Names from the PC's own list are what the relay compares for an id or a pid.
  await w.tool(TECH, 'list_programs', { session_id: sid });
  const sent = frames.length;
  for (const [name, args] of [
    ['close_program', { name: 'qbw.exe' }], ['close_program', { name: 'QBW' }], ['close_program', { pid: 7000 }], ['uninstall_program', { program_id: 'qb2024' }],
  ]) {
    assert.match((await w.tool(TECH, name, { session_id: sid, ...args })).error, /^protected_program: /, `${name} ${JSON.stringify(args)}`);
  }
  assert.equal(frames.length, sent, 'nothing was queued');
  // Another program is not protected. An id the relay does not know is left to the PC, which checks it again.
  assert.equal((await w.tool(TECH, 'close_program', { session_id: sid, name: 'OUTLOOK.EXE' })).closed, 1);
  assert.equal((await w.tool(TECH, 'uninstall_program', { session_id: sid, program_id: 'acrobat' })).ok, true);
  assert.equal((await w.tool(TECH, 'uninstall_program', { session_id: sid, program_id: 'unknown-id' })).ok, true);
});

test('protected folders: put_file, get_file and an installer inside one are refused, a sibling folder is not', async (t) => {
  const w = await agentWorld(t);
  const { sid, frames } = await savedPc(w, t);
  await setRules(w, { ...ALLOW, protected_folders: ['C:\\Data', 'D:\\Payroll\\'] });
  for (const [name, args] of [
    ['put_file', { path: 'C:\\Data\\notes.txt', data_b64: 'eA==' }],
    ['put_file', { path: 'c:/data/sub/../notes.txt', data_b64: 'eA==' }],
    ['get_file', { path: 'D:\\Payroll\\2026.xlsx' }],
    ['install_program', { path: 'C:\\Data\\setup.msi' }],
  ]) {
    assert.match((await w.tool(TECH, name, { session_id: sid, ...args })).error, /^protected_folder: /, `${name} ${args.path}`);
  }
  assert.equal(frames.length, 0);
  assert.equal((await w.tool(TECH, 'put_file', { session_id: sid, path: 'C:\\Database\\notes.txt', data_b64: 'eA==' })).bytes, 3);
  assert.equal((await w.tool(TECH, 'get_file', { session_id: sid, path: 'C:\\Temp\\a.txt' })).size, 3);
  // A raw run is not screened by the relay: the PC screens it.
  assert.equal((await w.tool(TECH, 'run', { session_id: sid, command: 'type C:\\Data\\notes.txt' })).exit_code, 0);
  assert.deepEqual(frames.map((f) => f.type), ['put_file', 'get_file', 'run']);
});

test('limited control: restart, shutdown, install and uninstall need full control, and closing a program does not', async (t) => {
  const w = await agentWorld(t);
  const { sid, frames } = await savedPc(w, t, { control: 'normal' });
  await setRules(w, ALLOW);
  for (const name of ['restart_pc', 'shutdown_pc', 'install_program', 'uninstall_program']) {
    assert.match((await w.tool(TECH, name, { session_id: sid, ...CALLS[name] })).error, /^needs_full_control: /, name);
  }
  assert.equal(frames.length, 0);
  assert.equal((await w.tool(TECH, 'close_program', { session_id: sid, name: 'OUTLOOK.EXE' })).closed, 1);
  assert.equal((await w.tool(TECH, 'list_programs', { session_id: sid })).installed.length, 2);
});

test('a one-off link session refuses the tools with not_saved_pc, queues nothing, and still runs commands without the tag', async (t) => {
  const w = await agentWorld(t);
  await setRules(w, ALLOW);
  const { sid, key, generation } = await attachedLink(w, TECH);
  const p = w.pump({ sid, key: null, generation, headers: { 'x-attach-key': key }, handler: (f) => (f.type === 'run' ? null : { ok: false, error: 'bad op' }) });
  t.after(() => p.stop());
  for (const name of RULED) {
    const r = await w.tool(TECH, name, { session_id: sid, ...(CALLS[name] ?? {}) });
    assert.match(r.error, /^not_saved_pc: /, name);
  }
  assert.equal(p.frames.length, 0);
  assert.equal((await w.tool(TECH, 'run', { session_id: sid, command: 'whoami' })).exit_code, 0);
  assert.equal(p.frames[0].type, 'run');
  assert.equal(p.frames[0].rules_tag, undefined);
  assert.equal(p.frames[0].decided_at, undefined);
});

test('a PC older than 1.0.0 is told to update: needs_update, nothing queued', async (t) => {
  const w = await agentWorld(t);
  const { sid, frames } = await savedPc(w, t, { version: '0.9.0' });
  await setRules(w, ALLOW);
  for (const name of RULED) assert.match((await w.tool(TECH, name, { session_id: sid, ...(CALLS[name] ?? {}) })).error, /^needs_update: /, name);
  assert.equal(frames.length, 0);
  // The old commands still work on it, untagged by nothing it cannot read.
  assert.equal((await w.tool(TECH, 'run', { session_id: sid, command: 'whoami' })).exit_code, 0);
});

// ---- what every guarded frame carries ------------------------------------------------------------------------
test('run, put_file and get_file frames on a saved PC carry rules_tag and decided_at; the tag is the PC\'s own', async (t) => {
  const w = await agentWorld(t);
  const { pc, sid, frames } = await savedPc(w, t);
  await setRules(w, { protected_folders: ['C:\\Data'] });
  const tag = (await w.hello(pc.key)).body.rules_tag;
  await w.tool(TECH, 'run', { session_id: sid, command: 'whoami' });
  await w.tool(TECH, 'put_file', { session_id: sid, path: 'C:\\Temp\\a.txt', data_b64: 'eA==' });
  await w.tool(TECH, 'get_file', { session_id: sid, path: 'C:\\Temp\\a.txt' });
  assert.deepEqual(frames.map((f) => [f.type, f.rules_tag, f.decided_at]), ['run', 'put_file', 'get_file'].map((type) => [type, tag, 1_800_000_000]));
  // A screenshot is not guarded.
  await w.tool(TECH, 'screenshot', { session_id: sid });
  assert.equal(frames.at(-1).type, 'screen');
  assert.equal(frames.at(-1).rules_tag, undefined);
});

test('rules that cannot be read refuse a guarded command with rules_stale, and a raw run still goes, untagged', async (t) => {
  const w = await agentWorld(t);
  const { sid, frames } = await savedPc(w, t);
  await setRules(w, ALLOW);
  const prepare = w.db.prepare;
  w.db.prepare = (sql) => {
    if (/^SELECT d\.id AS id, /.test(sql)) throw new Error('D1 is down');
    return prepare(sql);
  };
  try {
    assert.match((await w.tool(TECH, 'restart_pc', { session_id: sid })).error, /^rules_stale: /);
    assert.match((await w.tool(TECH, 'put_file', { session_id: sid, path: 'C:\\a', data_b64: 'eA==' })).error, /^rules_stale: /);
    assert.equal((await w.tool(TECH, 'run', { session_id: sid, command: 'whoami' })).exit_code, 0);
  } finally {
    w.db.prepare = prepare;
  }
  assert.deepEqual(frames.map((f) => [f.type, f.rules_tag]), [['run', undefined]]);
});

// ---- status, driving and the agent-mode gate ---------------------------------------------------------------------
test('session_status of a saved PC shows the rules in force and no approval; a one-off session shows neither', async (t) => {
  const w = await agentWorld(t);
  const { sid } = await savedPc(w, t);
  await setRules(w, { restart: 'never', protected_programs: ['qbw'] });
  const st = await w.tool(TECH, 'session_status', { session_id: sid });
  assert.equal(st.approval, null);
  assert.equal(st.rules.restart, 'never');
  assert.equal(st.rules.close_program, 'allow');
  assert.deepEqual(st.rules.protected_programs, ['qbw']);
  assert.equal(st.rules.rev, 1);
  const link = await attachedLink(w, TECH);
  const one = await w.tool(TECH, 'session_status', { session_id: link.sid });
  assert.equal(Object.hasOwn(one, 'rules'), false);
  assert.equal(Object.hasOwn(one, 'approval'), false);
});

test('only the driver commands the tools; a viewer is refused by role', async (t) => {
  const w = await agentWorld(t);
  const { sid, frames } = await savedPc(w, t);
  await setRules(w, ALLOW);
  assert.match((await w.tool(BOSS, 'restart_pc', { session_id: sid })).error, /is driving this session/);
  assert.match((await w.tool(VIEW, 'restart_pc', { session_id: sid })).error, /sessions\.control/);
  assert.equal(frames.length, 0);
});

test('a team on the built-in agent only refuses the six tools for an MCP client', async (t) => {
  const w = await agentWorld(t);
  const { sid, frames } = await savedPc(w, t);
  await setRules(w, ALLOW);
  await w.api(BOSS, 'PATCH', '/agent', { mode: 'agent' });
  for (const name of RULED) {
    const r = await w.tool(TECH, name, { session_id: sid, ...(CALLS[name] ?? {}) });
    assert.match(r.error, /^this team uses the built-in agent/, name);
  }
  assert.equal(frames.length, 0);
  await w.api(BOSS, 'PATCH', '/agent', { mode: 'both' });
  assert.equal((await w.tool(TECH, 'restart_pc', { session_id: sid })).ok, true);
});
