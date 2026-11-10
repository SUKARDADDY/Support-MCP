// Notifications: who hears of what, and that each row is written with the event that
// caused it. The eight switchable events (task finished, task problem, session declined, PC online,
// PC missing, PC waiting, queue item opened, queue item claimed), the two that are not (invited,
// offered control), the settings that switch them off, the isolation between teams, the hourly
// run, and the 30-day pruning.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentWorld, BOSS, TECH, VIEW, LEAD, OTHER } from './agent-world.js';
import { appWorld, skip } from './app-world.js';
import { socket } from './device-sessions-world.js';
import { oai } from './agent-fakes.js';
import { DIRECT_EVENTS, EVENTS, KEEP_MS, notifyStore, readNotify } from '../src/notify.js';
import { sweep, MISSING_MS, MISSING_WINDOW_MS } from '../src/sweep.js';
import { ONLINE_AFTER_MS } from '../src/registry.js';

const shotCall = () => oai.call('screenshot', { display: null });
const finish = (outcome = 'done', summary = 'ok') => oai.call('finish', { outcome, summary });
const DAY = 24 * 3600_000;

const rowsOf = (w, where = '', ...params) => w.sql(`SELECT workspace, recipient, event, device_id, task_id, session_id, title, body, dedupe FROM notifications ${where} ORDER BY id`, ...params).map((r) => ({ ...r }));
const who = (rows) => rows.map((r) => r.recipient).sort();

// A second team that TECH and OTHER belong to, with its own PC.
async function acme(w) {
  w.db.sqlite.prepare("INSERT INTO workspaces(slug, name, created_by, created_at) VALUES ('acme', 'Acme', ?, 1)").run(BOSS);
  for (const [identity, role] of [[BOSS, 'admin'], [TECH, 'technician'], [OTHER, 'technician']]) {
    w.db.sqlite.prepare("INSERT INTO members(workspace, identity, kind, name, role_id, added_at, added_by) VALUES ('acme', ?, 'person', NULL, ?, 1, 'test')").run(identity, role);
  }
}

// ---- task finished and task problem -------------------------------------------------------------
test('a task that finishes tells its starter, and nobody else', async (t) => {
  const w = await agentWorld(t);
  await w.ready();
  const a = await w.startOnPc(TECH, { keep_working: true });
  w.fake.queue('openai', shotCall(), finish('done', 'printer fixed'));
  await w.drive(a.id);
  assert.equal(w.taskRow(a.id).state, 'done');
  const rows = rowsOf(w);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    workspace: 'default', recipient: TECH, event: 'task_finished', device_id: a.pc.id, task_id: a.id, session_id: w.taskRow(a.id).sid,
    title: 'Task finished', body: 'The printer stopped printing.', dedupe: `task:${a.id}:ended`,
  });
  assert.ok(!JSON.stringify(rows).includes('printer fixed'), 'the agent\'s own summary is not in the notification');
});

test('a task that gets stuck, needs a person, fails or is stopped by the relay tells its starter it needs attention; one a person stops does not', async (t) => {
  const w = await agentWorld(t);
  await w.ready();
  const cases = [];
  const run = async (label, queue, finishWith) => {
    const pc = await w.addPc({ access: 'any', name: label });
    const a = await w.startOnPc(TECH, { keep_working: true }, { pc });
    queue?.(a);
    await finishWith(a);
    cases.push([label, a.id]);
    return a;
  };
  await run('stuck', () => w.fake.queue('openai', shotCall(), finish('stuck', 'tried everything')), (a) => w.drive(a.id));
  await run('needs', () => w.fake.queue('openai', shotCall(), finish('needs_human', 'a password is needed')), (a) => w.drive(a.id));
  await run('failed', () => w.fake.queue('openai', { status: 401, json: { error: { message: 'no', type: 'invalid_request_error', code: 'invalid_api_key' } } }), (a) => w.drive(a.id));
  // Not watched for 2 minutes: the relay stops it.
  const pc4 = await w.addPc({ access: 'any', name: 'unwatched' });
  const unwatched = await w.startOnPc(TECH, { keep_working: false }, { pc: pc4 });
  w.fake.queue('openai', shotCall(), shotCall(), shotCall());
  await w.alarm(unwatched.id);
  w.advance(121_000);
  await w.alarm(unwatched.id);
  assert.equal(w.taskRow(unwatched.id).state, 'stopped');
  cases.push(['unwatched', unwatched.id]);
  // A person stops their own task: they know.
  const pc5 = await w.addPc({ access: 'any', name: 'mine' });
  const mine = await w.startOnPc(TECH, { keep_working: true }, { pc: pc5 });
  w.fake.queue('openai', shotCall());
  await w.alarm(mine.id);
  assert.equal((await w.tool(TECH, 'agent_control', { task_id: mine.id, action: 'stop' })).state, 'stopped');
  await w.drive(mine.id);

  // The task that needs a person also tells the others who control sessions that the queue has an item (tested in escalations.test.js).
  assert.deepEqual(rowsOf(w).filter((r) => r.event === 'escalation_opened').map((r) => r.task_id), [cases[1][1], cases[1][1]]);
  const rows = rowsOf(w).filter((r) => r.event !== 'escalation_opened');
  assert.deepEqual(rows.map((r) => [r.event, r.recipient, r.task_id]), cases.map(([, id]) => ['task_problem', TECH, id]));
  assert.ok(rows.every((r) => r.title === 'Task needs attention'));
  assert.match(rows[0].body, /: finished: stuck$/);
  assert.match(rows[1].body, /: finished: needs a person$/);
  assert.match(rows[2].body, /^The printer stopped printing\.: /);
  assert.match(rows[3].body, /: nobody asked for its status for 2 minutes$/);
  assert.equal(rowsOf(w, 'WHERE task_id = ?', mine.id).length, 0, 'no notification for a stop by the person themselves');
});

test('a service token that starts a task gets no notification, and a settings switch keeps a person from one', async (t) => {
  const w = await agentWorld(t);
  await w.ready();
  w.db.sqlite.prepare("INSERT INTO members(workspace, identity, kind, name, role_id, added_at, added_by) VALUES ('default', 'svc-client-id', 'service', NULL, 'technician', 1, 'test')").run();
  const svc = await w.startOnPc('svc-client-id', { keep_working: true });
  w.fake.queue('openai', shotCall(), finish());
  await w.drive(svc.id);
  assert.equal(w.taskRow(svc.id).state, 'done');
  assert.equal(rowsOf(w).length, 0, 'service tokens never receive notifications');

  const notify = notifyStore(w.db, w.team);
  await notify.patchSettings('default', TECH, { events: { task_finished: false } });
  const mine = await w.startOnPc(TECH, {}, { pc: await w.addPc({ access: 'any', name: 'Two' }) });
  w.fake.queue('openai', shotCall(), finish());
  await w.drive(mine.id);
  assert.equal(w.taskRow(mine.id).state, 'done');
  assert.equal(rowsOf(w).length, 0, 'finished is switched off for TECH');
});

test('the end of a task and its notification commit together: a task already ended raises nothing again', async (t) => {
  const w = await agentWorld(t);
  await w.ready();
  const a = await w.startOnPc(TECH, { keep_working: true });
  w.fake.queue('openai', shotCall(), finish());
  await w.drive(a.id);
  assert.equal(rowsOf(w).length, 1);
  const store = (await import('../src/agent-store.js')).agentStoreFromEnv(w.env);
  assert.deepEqual(await store.endTask('default', a.id, { state: 'failed', reason: 'again', actor: 'relay' }), { ended: false });
  assert.equal(rowsOf(w).length, 1);
  assert.equal(w.sql("SELECT COUNT(*) AS n FROM audit WHERE kind = 'agent_task_ended'")[0].n, 1);
});

test('a task whose cleanup gives up tells its starter in a write of its own, once', async (t) => {
  const w = await agentWorld(t);
  await w.ready();
  const a = await w.startOnPc(BOSS);
  w.fake.queue('openai', shotCall(), shotCall(), finish());
  await w.alarm(a.id);
  const sid = w.taskRow(a.id).sid;
  w.hooks.endFails = Infinity;
  await w.tool(BOSS, 'agent_control', { task_id: a.id, action: 'stop' });
  assert.equal(rowsOf(w).length, 0, 'a stop by the person is not a notification');
  await w.drive(a.id);
  assert.equal(w.taskObject(a.id).ctx.values.get('st').done, true);
  const rows = rowsOf(w);
  assert.deepEqual(rows.map((r) => [r.recipient, r.event, r.task_id, r.session_id, r.dedupe]), [[BOSS, 'task_problem', a.id, sid, `task:${a.id}:cleanup`]]);
  assert.match(rows[0].body, /Could not confirm that the PC's session ended/);
  assert.equal(w.sql("SELECT COUNT(*) AS n FROM audit WHERE detail LIKE '%cleanup%'")[0].n, 0, 'nothing went into the team log');
});

// ---- session declined ------------------------------------------------------------------------------
test('a PC that declines, finds nobody, is busy, or whose owner ends the session tells the driver', async (t) => {
  const w = await agentWorld(t);
  for (const reason of ['declined', 'nobody', 'busy']) {
    const pc = await w.addPc({ name: `PC ${reason}` });
    const started = await w.tool(TECH, 'device_connect', { device_id: pc.id });
    assert.equal((await w.agent(started.session_id, pc.key, { type: 'decline', reason })).status, 200);
  }
  const owner = await w.addPc({ name: 'PC owner' });
  const { sid, welcome } = await w.attach(owner, LEAD);
  assert.equal((await w.agent(sid, owner.key, { type: 'end', generation: welcome.body.generation })).status, 200);
  const rows = rowsOf(w);
  assert.deepEqual(rows.map((r) => [r.recipient, r.event]), [[TECH, 'session_declined'], [TECH, 'session_declined'], [TECH, 'session_declined'], [LEAD, 'session_declined']]);
  assert.deepEqual(rows.map((r) => r.body), [
    'PC declined: the person at the PC declined', 'PC nobody: nobody was signed in at the PC', 'PC busy: the PC was busy', 'PC owner: the PC\'s owner ended the session',
  ]);
  assert.ok(rows.every((r) => r.title === 'Session ended early' && r.dedupe === `declined:${r.session_id}`));
});

test('a session the team ends, or that times out, raises no "declined"', async (t) => {
  const w = await agentWorld(t);
  const pc = await w.addPc();
  const { sid } = await w.attach(pc, TECH);
  assert.equal((await w.tool(TECH, 'session_end', { session_id: sid })).ended, true);
  assert.equal(w.reasonOf(sid), 'technician');
  assert.equal(rowsOf(w).length, 0);
});

test('a declined PC with a live task raises only the task\'s problem', async (t) => {
  const w = await agentWorld(t);
  await w.ready();
  const pc = await w.addPc({ access: 'any', name: 'Till' });
  const a = await w.startOnPc(TECH, { keep_working: true }, { pc, join: false });
  const sid = w.taskRow(a.id).sid;
  assert.ok(sid, 'the task opened a session');
  assert.equal((await w.agent(sid, pc.key, { type: 'decline', reason: 'declined' })).status, 200);
  assert.equal(w.reasonOf(sid), 'declined');
  assert.equal(rowsOf(w).length, 0, 'the session ended while the task held it: no "declined"');
  await w.alarm(a.id);
  assert.equal(w.taskRow(a.id).state, 'failed');
  const rows = rowsOf(w);
  assert.deepEqual(rows.map((r) => [r.recipient, r.event, r.body]), [[TECH, 'task_problem', 'The printer stopped printing.: the person at the PC declined']]);
});

test('a session a task opened raises no "declined" before the task records its sid, nor on a cleanup retried after the task ended', async (t) => {
  const w = await agentWorld(t);
  await w.ready();
  for (const [label, hold] of [['before the task records the sid', 'sid = NULL'], ['after the task ended', "ended_at = 1, state = 'failed'"]]) {
    const pc = await w.addPc({ access: 'any', name: label });
    const a = await w.startOnPc(TECH, { keep_working: true }, { pc, join: false });
    const sid = w.taskRow(a.id).sid;
    assert.ok(sid, 'the task opened a session');
    // The agent_tasks row no longer shows a running task on this sid: only the Session knows.
    w.db.sqlite.prepare(`UPDATE agent_tasks SET ${hold} WHERE id = ?`).run(a.id);
    assert.equal((await w.agent(sid, pc.key, { type: 'decline', reason: 'declined' })).status, 200, label);
    assert.equal(w.reasonOf(sid), 'declined', label);
    assert.equal(rowsOf(w, 'WHERE session_id = ?', sid).length, 0, `${label}: no "declined"`);
  }
});

// ---- a PC waiting, and a PC that left ---------------------------------------------------------------------
test('a PC that asks to join tells the people who can approve it, and no one else', async (t) => {
  const w = await agentWorld(t);
  w.db.sqlite.prepare("INSERT INTO members(workspace, identity, kind, name, role_id, added_at, added_by) VALUES ('default', 'svc-client-id', 'service', NULL, 'admin', 1, 'test')").run();
  const pc = await w.addPc({ status: 'pending', name: 'Front desk' });
  const rows = rowsOf(w);
  assert.deepEqual(who(rows), [BOSS, LEAD, TECH].sort(), 'holders of devices.manage: an admin, a lead and a technician, not the viewer or the token');
  assert.ok(rows.every((r) => r.event === 'device_waiting' && r.device_id === pc.id && r.title === 'A PC is waiting for approval' && r.body === 'Front desk' && r.dedupe === `waiting:${pc.id}`));
  assert.ok(!who(rows).includes(VIEW));
  // The row is part of the request's one batch: a refused request leaves none.
  const before = rowsOf(w).length;
  for (let i = 0; i < 25; i++) await w.devs.requestJoin({ protocol: 1, workspace: 'default', name: `Extra ${i}` }).catch(() => {});
  const waiting = w.sql("SELECT COUNT(*) AS n FROM devices WHERE status = 'pending'")[0].n;
  assert.equal(rowsOf(w).length, before + (waiting - 1) * 3, 'three rows for each PC that was accepted, none for one that was refused');
});

test('a PC that leaves tells its watchers and the people who manage PCs; a waiting PC that leaves tells no one', async (t) => {
  const w = await agentWorld(t);
  const pc = await w.addPc({ name: 'Till' });
  const notify = notifyStore(w.db, w.team);
  await notify.patchSettings('default', VIEW, { watch: [pc.id] });
  const left = await w.send('/device/leave', { method: 'POST', headers: { 'content-type': 'application/json', ...w.bearer(pc.key) }, body: JSON.stringify({ protocol: 1 }) });
  assert.equal(left.status, 200);
  const rows = rowsOf(w);
  assert.deepEqual(who(rows), [BOSS, LEAD, TECH, VIEW].sort());
  assert.ok(rows.every((r) => r.event === 'device_missing' && r.device_id === pc.id && r.title === 'A PC left the team' && r.body === 'Till'));
  // A waiting PC that gives up is not a PC the team knew.
  const waiting = await w.addPc({ status: 'pending' });
  const before = rowsOf(w).length;
  await w.send('/device/leave', { method: 'POST', headers: { 'content-type': 'application/json', ...w.bearer(waiting.key) }, body: JSON.stringify({ protocol: 1 }) });
  assert.equal(rowsOf(w).length, before, 'no new rows');
});

// ---- a PC online ---------------------------------------------------------------------------------------
const WORKSPACE_DOOR = (w, id, slug = 'default') => w.registryFor(slug === 'default' ? 'registry' : `registry:${slug}`).registry
  .fetch(new Request(`https://do/doorbell?device=${id}&workspace=${slug}`, { headers: { upgrade: 'websocket' } }));
function upgradeResponses(t) {
  const Real = globalThis.Response;
  const realPair = globalThis.WebSocketPair;
  globalThis.Response = class extends Real {
    constructor(body, init) { super(init && init.status === 101 ? null : body, init && init.status === 101 ? { ...init, status: 200 } : init); if (init && init.status === 101) Object.defineProperty(this, 'status', { value: 101 }); }
  };
  globalThis.WebSocketPair = class { constructor() { this[0] = { client: true }; this[1] = socket([]); } };
  t.after(() => { globalThis.Response = Real; globalThis.WebSocketPair = realPair; });
}

test('a doorbell that returns after 10 minutes away tells the PC\'s watchers; a short blip, a first connection and a replaced socket do not', async (t) => {
  const w = await agentWorld(t);
  upgradeResponses(t);
  const pc = await w.addPc({ name: 'Till' });
  const notify = notifyStore(w.db, w.team);
  await notify.patchSettings('default', TECH, { watch: [pc.id] });
  await notify.patchSettings('default', VIEW, { watch: [pc.id], events: { device_online: false } });
  const { registry, ctx } = w.registryFor('registry');

  // The first connection: nothing was gone, nothing to announce.
  assert.equal((await WORKSPACE_DOOR(w, pc.id)).status, 101);
  assert.equal(rowsOf(w).length, 0);
  // A replaced socket closing is not the PC going away.
  assert.equal((await WORKSPACE_DOOR(w, pc.id)).status, 101);
  await registry.webSocketClose(ctx.sockets[0], 1000, 'replaced');
  assert.equal(w.registryFor('registry').ctx.storage.sql.exec('SELECT * FROM doorbells').toArray().length, 0);
  // A drop for 9 minutes.
  const live = ctx.sockets.find((s) => !s.closed);
  await registry.webSocketClose(live, 1006, '');
  w.advance(ONLINE_AFTER_MS - 60_000);
  assert.equal((await WORKSPACE_DOOR(w, pc.id)).status, 101);
  assert.equal(rowsOf(w).length, 0, 'under 10 minutes is a blip');
  // A drop for 10 minutes.
  await registry.webSocketClose(ctx.sockets.filter((s) => !s.closed).at(-1), 1006, '');
  const wentAt = w.now();
  w.advance(ONLINE_AFTER_MS);
  assert.equal((await WORKSPACE_DOOR(w, pc.id)).status, 101);
  await Promise.all(ctx.waited);
  assert.deepEqual(rowsOf(w).map((r) => [r.recipient, r.event, r.device_id, r.body, r.dedupe]), [[TECH, 'device_online', pc.id, 'Till', `online:${pc.id}:${wentAt}`]]);
  // It is told of once.
  assert.equal((await WORKSPACE_DOOR(w, pc.id)).status, 101);
  assert.equal(rowsOf(w).length, 1);
});

test('the doorbell connects without waiting for the "came online" write, and a write that fails does not break it', async (t) => {
  const w = await agentWorld(t);
  upgradeResponses(t);
  const pc = await w.addPc({ name: 'Till' });
  const { registry, ctx } = w.registryFor('registry');
  assert.equal((await WORKSPACE_DOOR(w, pc.id)).status, 101);
  const goneAndBack = async () => {
    await registry.webSocketClose(ctx.sockets.filter((s) => !s.closed).at(-1), 1006, '');
    w.advance(ONLINE_AFTER_MS);
  };
  // A write that never finishes.
  let started = 0;
  registry.announceOnline = () => { started++; return new Promise(() => {}); };
  await goneAndBack();
  const waitedBefore = ctx.waited.length;
  const door = await Promise.race([WORKSPACE_DOOR(w, pc.id), new Promise((resolve) => setTimeout(() => resolve('waited'), 200))]);
  assert.equal(door.status, 101, 'the 101 did not wait for the write');
  assert.equal(started, 1);
  assert.equal(ctx.waited.length, waitedBefore + 1, 'the write was handed to waitUntil');
  // A write that throws.
  registry.announceOnline = async () => { throw new Error('D1 is down'); };
  await goneAndBack();
  assert.equal((await WORKSPACE_DOOR(w, pc.id)).status, 101);
  await Promise.all(ctx.waited.slice(waitedBefore + 1));
});

test('the Worker hands the doorbell its workspace, and a Registry that is told nothing raises nothing', async (t) => {
  const w = await agentWorld(t);
  const pc = await w.addPc();
  const seen = [];
  w.env.REGISTRY = {
    idFromName: (n) => n,
    get: (name) => ({ fetch: async (request) => { seen.push({ name, url: request.url }); return new Response('upgraded', { status: 200 }); } }),
  };
  const r = await w.send('/device/ring?protocol=1', { headers: { authorization: `Bearer ${pc.key}`, upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' } });
  assert.equal(r.status, 200);
  assert.deepEqual(seen, [{ name: 'registry', url: `https://do/doorbell?device=${pc.id}&workspace=default` }]);
});

// ---- a PC missing for 7 days ------------------------------------------------------------------------------
test('a PC with no check-in and no doorbell for 7 days is reported missing once, to its watchers only', async (t) => {
  const w = await agentWorld(t);
  const gone = await w.addPc({ name: 'Gone' });
  const quiet = await w.addPc({ name: 'Quiet but online' });
  const fresh = await w.addPc({ name: 'Fresh' });
  const notify = notifyStore(w.db, w.team);
  for (const pc of [gone, quiet, fresh]) await notify.patchSettings('default', TECH, { watch: [gone.id, quiet.id, fresh.id] });
  await notify.patchSettings('default', LEAD, { watch: [gone.id] });
  w.ringSocket(quiet.id);
  const lastSeen = w.now();
  w.advance(7 * DAY + 3600_000);
  w.db.sqlite.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').run(w.now() - 60_000, fresh.id);
  await sweep(w.env);
  const rows = rowsOf(w);
  assert.deepEqual(rows.map((r) => [r.recipient, r.event, r.device_id, r.body, r.dedupe]).sort(), [
    [LEAD, 'device_missing', gone.id, 'Gone', `missing:${gone.id}:${lastSeen}`],
    [TECH, 'device_missing', gone.id, 'Gone', `missing:${gone.id}:${lastSeen}`],
  ].sort());
  assert.ok(rows.every((r) => r.title === 'A PC has not been seen for 7 days'));
  // Again an hour later: nothing new. The managers are not told, only the watchers.
  w.advance(3600_000);
  await sweep(w.env);
  assert.equal(rowsOf(w).length, 2);
  // It checks in, then goes quiet again: a new occurrence. The PC that was fresh is now 7 days quiet too.
  w.db.sqlite.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').run(w.now(), gone.id);
  w.advance(7 * DAY + 3600_000);
  await sweep(w.env);
  assert.deepEqual(rowsOf(w, 'WHERE id > ?', 2).map((r) => [r.recipient, r.device_id]).sort(), [[LEAD, gone.id], [TECH, fresh.id], [TECH, gone.id]].sort());
});

test('a PC with no last_seen counts from when it was paired', async (t) => {
  const w = await agentWorld(t);
  const pc = await w.addPc({ name: 'Never seen' });
  await notifyStore(w.db, w.team).patchSettings('default', TECH, { watch: [pc.id] });
  // The column is NOT NULL in the shipped schema: let it be empty for this test.
  w.db.sqlite.exec('CREATE TABLE devices_open AS SELECT * FROM devices; DROP TABLE devices; ALTER TABLE devices_open RENAME TO devices');
  const pairedAt = w.sql('SELECT paired_at FROM devices WHERE id = ?', pc.id)[0].paired_at;
  w.db.sqlite.prepare('UPDATE devices SET last_seen = NULL WHERE id = ?').run(pc.id);
  w.advance(7 * DAY + 3600_000);
  await sweep(w.env);
  assert.deepEqual(rowsOf(w).map((r) => [r.recipient, r.dedupe]), [[TECH, `missing:${pc.id}:${pairedAt}`]]);
  await sweep(w.env);
  assert.equal(rowsOf(w).length, 1, 'once');
});

test('a PC whose doorbell stayed connected for weeks is reported 7 days after the doorbell drops, once', async (t) => {
  const w = await agentWorld(t);
  upgradeResponses(t);
  const pc = await w.addPc({ name: 'Till' });
  await notifyStore(w.db, w.team).patchSettings('default', TECH, { watch: [pc.id] });
  const { registry, ctx } = w.registryFor('registry');
  assert.equal((await WORKSPACE_DOOR(w, pc.id)).status, 101);
  // It checked in once, then only the doorbell stayed up: last_seen is 30 days old.
  w.advance(30 * DAY);
  await sweep(w.env);
  assert.equal(rowsOf(w).length, 0, 'the doorbell is connected');
  // The doorbell drops now.
  await registry.webSocketClose(ctx.sockets.find((s) => !s.closed), 1006, '');
  await Promise.all(ctx.waited);
  const droppedAt = w.now();
  assert.equal(w.sql('SELECT last_seen FROM devices WHERE id = ?', pc.id)[0].last_seen, droppedAt, 'the drop is the last contact');
  w.advance(DAY);
  await sweep(w.env);
  assert.equal(rowsOf(w).length, 0, 'one day is not 7');
  w.advance(6 * DAY + 3600_000);
  await sweep(w.env);
  assert.deepEqual(rowsOf(w).map((r) => [r.recipient, r.dedupe]), [[TECH, `missing:${pc.id}:${droppedAt}`]]);
  await sweep(w.env);
  assert.equal(rowsOf(w).length, 1, 'once');
  // A doorbell that is replaced by a newer socket, or that closes because the PC was removed, is not a drop.
  const other = await w.addPc({ name: 'Replaced' });
  assert.equal((await WORKSPACE_DOOR(w, other.id)).status, 101);
  assert.equal((await WORKSPACE_DOOR(w, other.id)).status, 101);
  const seen = w.sql('SELECT last_seen FROM devices WHERE id = ?', other.id)[0].last_seen;
  w.advance(1000);
  await registry.webSocketClose(ctx.sockets.filter((s) => s.tags.includes(`dev:${other.id}`))[0], 1000, 'replaced');
  assert.equal(w.sql('SELECT last_seen FROM devices WHERE id = ?', other.id)[0].last_seen, seen);
});

test('a big team does not crowd the others out of the hourly run, and a run stays under the free plan\'s subrequests', async (t) => {
  const w = await agentWorld(t);
  await acme(w);
  // 600 PCs in acme (which sorts first) that crossed 7 days earlier than default's one PC.
  const insert = w.db.sqlite.prepare("INSERT INTO devices(workspace, id, status, name, access, control, key_hash, paired_at, paired_by, last_seen) VALUES (?, ?, 'active', ?, 'ask', 'full', 'k', 1, 'test', ?)");
  const base = w.now();
  for (let i = 0; i < 600; i++) insert.run('acme', `${String(i).padStart(4, '0')}`.replace(/\d/g, (d) => 'abcdefghij'[d]).padEnd(20, 'a'), `Big ${i}`, base - 1000 - i);
  const small = 'z'.repeat(20);
  insert.run('default', small, 'Small', base + 5000);
  const watch = (slug, ids) => w.db.sqlite.prepare('UPDATE members SET notify = ? WHERE workspace = ? AND identity = ?').run(JSON.stringify({ watch: ids }), slug, TECH);
  watch('default', [small]);
  watch('acme', w.sql("SELECT id FROM devices WHERE workspace = 'acme'").map((r) => r.id).slice(0, 500));
  w.advance(7 * DAY + 1000);
  // Count what the free plan counts: each statement run on its own, each batch once.
  let calls = 0;
  const real = w.env.DB;
  const counted = (st) => ({ ...st, bind: (...a) => counted(st.bind(...a)), run: (...a) => (calls++, st.run(...a)), all: (...a) => (calls++, st.all(...a)), first: (...a) => (calls++, st.first(...a)) });
  w.env.DB = { ...real, prepare: (sql) => counted(real.prepare(sql)), batch: (list) => (calls++, real.batch(list)) };
  const registryCalls = w.registryCalls.length;
  await sweep(w.env);
  w.env.DB = real;
  assert.ok(calls + (w.registryCalls.length - registryCalls) <= 50, `${calls} D1 calls and ${w.registryCalls.length - registryCalls} Registry calls`);
  // Over the hours, the small team is reached although the big one had the earlier PCs.
  for (let h = 0; h < 3; h++) { w.advance(3600_000); await sweep(w.env); }
  assert.ok(rowsOf(w, "WHERE workspace = 'default'").length > 0, 'the small team was reached');
});

// Many watched PCs lose contact at the same moment, so they all cross 7 days in the same hour.
// One run has the budget for about 22 of them. The ones already told of must not take the budget
// again, and the rest must be reached before the window for a new absence closes.
async function lostTogether(t, { teams }) {
  const w = await agentWorld(t);
  if (teams > 1) await acme(w);
  const insert = w.db.sqlite.prepare("INSERT INTO devices(workspace, id, status, name, access, control, key_hash, paired_at, paired_by, last_seen) VALUES (?, ?, 'active', ?, 'ask', 'full', 'k', 1, 'test', ?)");
  const lastSeen = w.now();
  const slugs = ['default', 'acme'].slice(0, teams);
  const ids = new Map(slugs.map((slug) => [slug, []]));
  for (const slug of slugs) {
    for (let i = 0; i < 100; i++) {
      const id = `${slug === 'acme' ? 'b' : 'a'}${String(i).padStart(3, '0').replace(/\d/g, (d) => 'abcdefghij'[d])}`.padEnd(20, 'a');
      ids.get(slug).push(id);
      insert.run(slug, id, `PC ${slug} ${i}`, lastSeen);
    }
    w.db.sqlite.prepare('UPDATE members SET notify = ? WHERE workspace = ? AND identity = ?').run(JSON.stringify({ watch: ids.get(slug) }), slug, TECH);
  }
  w.advance(7 * DAY + 3600_000);
  // Count what the free plan counts: each statement run on its own, each batch once, each Registry call.
  let calls = 0;
  const real = w.env.DB;
  const counted = (st) => ({ ...st, bind: (...a) => counted(st.bind(...a)), run: (...a) => (calls++, st.run(...a)), all: (...a) => (calls++, st.all(...a)), first: (...a) => (calls++, st.first(...a)) });
  w.env.DB = { ...real, prepare: (sql) => counted(real.prepare(sql)), batch: (list) => (calls++, real.batch(list)) };
  let worst = 0;
  const hour = async () => {
    calls = 0;
    const before = w.registryCalls.length;
    await sweep(w.env);
    worst = Math.max(worst, calls + (w.registryCalls.length - before));
    w.advance(3600_000);
  };
  return { w, lastSeen, ids, hour, worst: () => worst, done: () => { w.env.DB = real; } };
}

test('100 PCs that all go quiet at once are each reported missing once, within the window, in one team', async (t) => {
  const { w, lastSeen, ids, hour, worst, done } = await lostTogether(t, { teams: 1 });
  for (let h = 0; h < 48; h++) await hour();
  const rows = rowsOf(w, "WHERE event = 'device_missing'");
  assert.equal(rows.length, 100, 'PCs told of after 48 hourly runs');
  assert.deepEqual(rows.map((r) => r.dedupe).sort(), ids.get('default').map((id) => `missing:${id}:${lastSeen}`).sort(), 'every PC, once');
  assert.ok(rows.every((r) => r.recipient === TECH));
  // The window is over; later runs add nothing and spend nothing on PCs that were told of.
  for (let h = 0; h < 72; h++) await hour();
  assert.equal(rowsOf(w, "WHERE event = 'device_missing'").length, 100);
  assert.ok(worst() <= 50, `${worst()} subrequests in the worst run`);
  done();
});

test('100 PCs in each of two teams that all go quiet at once are each reported missing once, within the window', async (t) => {
  const { w, lastSeen, ids, hour, worst, done } = await lostTogether(t, { teams: 2 });
  for (let h = 0; h < 48; h++) await hour();
  const rows = rowsOf(w, "WHERE event = 'device_missing'");
  assert.equal(rows.length, 200, 'PCs told of after 48 hourly runs');
  const want = [...ids].flatMap(([slug, list]) => list.map((id) => `${slug}:missing:${id}:${lastSeen}`)).sort();
  assert.deepEqual(rows.map((r) => `${r.workspace}:${r.dedupe}`).sort(), want, 'every PC of both teams, once');
  for (let h = 0; h < 72; h++) await hour();
  assert.equal(rowsOf(w, "WHERE event = 'device_missing'").length, 200);
  assert.ok(worst() <= 50, `${worst()} subrequests in the worst run`);
  done();
});

for (const [count, how] of [[500, 'in the query'], [3000, 'too many to send to the query, so dropped after it']]) test(`${count} watched PCs whose doorbells are connected cannot crowd a missing PC out of the hourly run (${how})`, async (t) => {
  const w = await agentWorld(t);
  const insert = w.db.sqlite.prepare("INSERT INTO devices(workspace, id, status, name, access, control, key_hash, paired_at, paired_by, last_seen) VALUES ('default', ?, 'active', ?, 'ask', 'full', 'k', 1, 'test', ?)");
  const base = w.now();
  const id = (n) => `${String(n).padStart(4, '0').replace(/\d/g, (d) => 'abcdefghij'[d])}`.padEnd(20, 'a');
  // Many PCs with old last_seen but a connected doorbell, then one that is really missing (later last_seen, so it sorts after them).
  const connected = [...Array(count).keys()].map(id);
  connected.forEach((pcId, i) => { insert.run(pcId, `Up ${i}`, base - 100_000 + i); w.ringSocket(pcId); });
  const gone = id(count);
  insert.run(gone, 'Gone', base);
  w.db.sqlite.prepare('UPDATE members SET notify = ? WHERE workspace = ? AND identity = ?').run(JSON.stringify({ watch: [...connected, gone] }), 'default', TECH);
  w.advance(7 * DAY + 3600_000);
  for (let h = 0; h < 48; h++) { await sweep(w.env); w.advance(3600_000); }
  assert.deepEqual(rowsOf(w).map((r) => [r.recipient, r.device_id, r.dedupe]), [[TECH, gone, `missing:${gone}:${base}`]], 'the missing PC once, and none of the connected ones');
});

test('PCs nobody would be told of take none of the hourly budget, and the window ends before the rows are deleted', async (t) => {
  const w = await agentWorld(t);
  const insert = w.db.sqlite.prepare("INSERT INTO devices(workspace, id, status, name, access, control, key_hash, paired_at, paired_by, last_seen) VALUES ('default', ?, 'active', ?, 'ask', 'full', 'k', 1, 'test', ?)");
  const base = w.now();
  // 60 older PCs: 30 unwatched, 30 watched by someone who switched device_missing off. Then 5 that TECH watches.
  const id = (n) => `${String(n).padStart(4, '0').replace(/\d/g, (d) => 'abcdefghij'[d])}`.padEnd(20, 'a');
  for (let i = 0; i < 65; i++) insert.run(id(i), `PC ${i}`, base - 10_000 + i);
  w.db.sqlite.prepare('UPDATE members SET notify = ? WHERE workspace = ? AND identity = ?').run(JSON.stringify({ watch: [...Array(65).keys()].slice(30, 60).map(id), events: { device_missing: false } }), 'default', LEAD);
  w.db.sqlite.prepare('UPDATE members SET notify = ? WHERE workspace = ? AND identity = ?').run(JSON.stringify({ watch: [...Array(65).keys()].slice(60).map(id) }), 'default', TECH);
  w.advance(7 * DAY + 3600_000);
  await sweep(w.env);
  assert.deepEqual(rowsOf(w).map((r) => r.device_id).sort(), [...Array(65).keys()].slice(60).map(id), 'the 5 watched PCs, in the first run');
  assert.ok(MISSING_MS + MISSING_WINDOW_MS + DAY < KEEP_MS, 'a row is not deleted while its absence is still a candidate');
});

test('the hourly run skips a team whose doorbells it cannot read, and the Worker has a scheduled handler that runs it', async (t) => {
  const w = await agentWorld(t);
  const pc = await w.addPc({ name: 'Gone' });
  await notifyStore(w.db, w.team).patchSettings('default', TECH, { watch: [pc.id] });
  w.advance(7 * DAY + 3600_000);
  const real = w.env.REGISTRY;
  w.env.REGISTRY = { idFromName: (n) => n, get: () => ({ fetch: async () => { throw new Error('unreachable'); } }) };
  await sweep(w.env);
  assert.equal(rowsOf(w).length, 0, 'we cannot tell whether it is online');
  w.env.REGISTRY = real;
  const waited = [];
  await w.handler.scheduled({ cron: '17 * * * *' }, w.env, { waitUntil: (p) => waited.push(p) });
  assert.equal(waited.length, 1);
  assert.equal(rowsOf(w).length, 1);
});

test('notifications older than 30 days are deleted by the hourly run', async (t) => {
  const w = await agentWorld(t);
  await w.addPc({ status: 'pending' });
  const first = rowsOf(w).length;
  assert.ok(first > 0);
  w.advance(KEEP_MS - 1000);
  await w.addPc({ status: 'pending' });
  await sweep(w.env);
  assert.equal(rowsOf(w).length, first * 2, 'nothing is 30 days old yet');
  w.advance(2000);
  await sweep(w.env);
  assert.equal(rowsOf(w).length, first, 'the first PC\'s rows are gone, the second PC\'s stay');
});

// ---- isolation ---------------------------------------------------------------------------------------------
test('a team\'s events reach only its own members, and settings are per team', async (t) => {
  const w = await agentWorld(t);
  await acme(w);
  // A PC joins the default team: OTHER belongs only to acme, TECH to both.
  await w.addPc({ status: 'pending' });
  assert.ok(rowsOf(w).every((r) => r.workspace === 'default'));
  assert.ok(!who(rowsOf(w)).includes(OTHER));
  // A PC joins acme.
  const joined = await w.devs.requestJoin({ protocol: 1, workspace: 'acme', name: 'Acme PC' });
  const acmeRows = rowsOf(w, "WHERE workspace = 'acme'");
  assert.deepEqual(who(acmeRows), [BOSS, OTHER, TECH].sort());
  assert.ok(acmeRows.every((r) => r.device_id === joined.device_id));
  assert.equal(rowsOf(w, "WHERE workspace = 'default'").length, 3, 'acme\'s PC added nothing to default');
  // TECH's switch in acme does not change default.
  const notify = notifyStore(w.db, w.team);
  await notify.patchSettings('acme', TECH, { events: { device_waiting: false } });
  assert.equal((await notify.settings('default', TECH)).events.device_waiting, true);
  assert.equal((await notify.settings('acme', TECH)).events.device_waiting, false);
  await w.devs.requestJoin({ protocol: 1, workspace: 'acme', name: 'Second' });
  assert.deepEqual(who(rowsOf(w, "WHERE workspace = 'acme' AND device_id != ?", joined.device_id)), [BOSS, OTHER].sort());
  // The feed is per team and per person.
  assert.equal((await notify.feed('default', OTHER)).items.length, 0);
  assert.equal((await notify.feed('acme', OTHER)).items.length, 2);
  assert.equal((await notify.feed('acme', TECH)).items.length, 1);
});

// ---- invites and offers, and the queue's two events ----------------------------------------------------
test('the queue\'s two events are switchable and on by default; the invite and the offer are neither', async (t) => {
  const w = await agentWorld(t);
  const notify = notifyStore(w.db, w.team);
  assert.deepEqual(EVENTS.slice(-2), ['escalation_opened', 'escalation_claimed']);
  assert.deepEqual(DIRECT_EVENTS, ['session_invited', 'control_offered']);
  assert.equal(DIRECT_EVENTS.some((e) => EVENTS.includes(e)), false);
  assert.deepEqual((await notify.settings('default', TECH)).events.escalation_opened, true);
  const off = await notify.patchSettings('default', TECH, { events: { escalation_opened: false } });
  assert.deepEqual([off.events.escalation_opened, off.events.escalation_claimed], [false, true]);
  // A direct event has no switch: it is not a setting to name, and the writer for switchable events does not take it.
  for (const name of DIRECT_EVENTS) {
    await assert.rejects(() => notify.patchSettings('default', TECH, { events: { [name]: false } }), (e) => e.status === 400 && /unknown event/.test(e.message), name);
    await assert.rejects(() => notify.recipients('default', name, { to: [TECH] }), /unknown notification event/, name);
  }
  assert.deepEqual(Object.keys((await notify.settings('default', TECH)).events), EVENTS);
});

test('recipients can leave out the person who caused the event', async (t) => {
  const w = await agentWorld(t);
  const notify = notifyStore(w.db, w.team);
  const all = await notify.recipients('default', 'escalation_opened', { holding: 'sessions.control' });
  assert.deepEqual(all.sort(), [BOSS, LEAD, TECH].sort());
  assert.deepEqual((await notify.recipients('default', 'escalation_opened', { holding: 'sessions.control', except: [TECH.toUpperCase()] })).sort(), [BOSS, LEAD].sort());
  await notify.patchSettings('default', LEAD, { events: { escalation_opened: false } });
  assert.deepEqual((await notify.recipients('default', 'escalation_opened', { holding: 'sessions.control', except: [TECH] })), [BOSS], 'a switched-off event reaches nobody who switched it off');
  assert.equal(all.includes(VIEW), false, 'a Viewer holds no sessions.control');
});

test('a direct event goes to one named person, whatever their settings say, once per occurrence', async (t) => {
  const w = await agentWorld(t);
  await acme(w);
  const notify = notifyStore(w.db, w.team);
  const what = (n) => ({ session_id: 's'.repeat(64), title: 'You were invited', body: 'x'.repeat(500), dedupe: `invited:${n}` });
  // Every switchable event off does not matter.
  await notify.patchSettings('default', LEAD, { events: Object.fromEntries(EVENTS.map((e) => [e, false])) });
  const rows = await notify.direct('default', 'session_invited', LEAD.toUpperCase(), what(1));
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].recipient, rows[0].event, rows[0].body.length <= 300, rows[0].device_id], [LEAD, 'session_invited', true, null]);
  await notify.write('default', rows);
  await notify.write('default', await notify.direct('default', 'session_invited', LEAD, what(1)));
  assert.equal(rowsOf(w).length, 1, 'the same occurrence adds nothing');
  await notify.write('default', await notify.direct('default', 'session_invited', LEAD, what(2)));
  await notify.write('default', await notify.direct('default', 'control_offered', LEAD, { session_id: 's'.repeat(64), title: 'Control offered', body: 'b', dedupe: 'offered:1' }));
  assert.deepEqual(rowsOf(w).map((r) => r.event), ['session_invited', 'session_invited', 'control_offered']);
  assert.deepEqual((await notify.feed('default', LEAD)).items.map((i) => i.event), ['session_invited', 'session_invited', 'control_offered']);
  // Nobody else hears of it: not the admin, not a member of another team.
  assert.equal((await notify.feed('default', BOSS)).items.length, 0);
  // Not a member of the team, not a person, not in this team: nothing.
  assert.deepEqual(await notify.direct('default', 'session_invited', 'stranger@example.com', what(3)), []);
  assert.deepEqual(await notify.direct('default', 'session_invited', 'a-service-token-client-id', what(3)), []);
  assert.deepEqual(await notify.direct('acme', 'session_invited', VIEW, what(3)), [], 'a member of default is no member of acme');
  assert.equal((await notify.direct('acme', 'session_invited', OTHER, what(3))).length, 1);
  assert.deepEqual(await notify.direct('default', 'session_invited', '', what(3)), []);
  await assert.rejects(() => notify.direct('default', 'task_finished', LEAD, what(4)), /unknown direct notification event/);
});

// ---- the writer and the settings ------------------------------------------------------------------------
test('settings: defaults, partial patches, watched PCs from the team only, and bad input refused', async (t) => {
  const w = await agentWorld(t);
  await acme(w);
  const notify = notifyStore(w.db, w.team);
  const mine = await w.addPc();
  const theirs = await w.devs.requestJoin({ protocol: 1, workspace: 'acme', name: 'Theirs' });
  assert.deepEqual(await notify.settings('default', TECH), { events: Object.fromEntries(EVENTS.map((e) => [e, true])), watch: [] });
  assert.deepEqual(readNotify('not json'), { events: Object.fromEntries(EVENTS.map((e) => [e, true])), watch: [] });
  const one = await notify.patchSettings('default', TECH, { events: { task_finished: false } });
  assert.equal(one.events.task_finished, false);
  assert.equal(one.events.task_problem, true);
  const two = await notify.patchSettings('default', TECH, { watch: [mine.id, mine.id] });
  assert.deepEqual([two.events.task_finished, two.watch], [false, [mine.id]], 'a patch of the watch list keeps the switches');
  const three = await notify.patchSettings('default', TECH, { events: { task_finished: true, device_online: false } });
  assert.deepEqual([three.events.task_finished, three.events.device_online, three.watch], [true, false, [mine.id]]);
  assert.deepEqual((await notify.patchSettings('default', TECH, { watch: [] })).watch, []);
  const bad = async (body, match) => assert.rejects(() => notify.patchSettings('default', TECH, body), (e) => e.status === 400 && match.test(e.message), JSON.stringify(body));
  await bad({}, /send events, watch or both/);
  await bad({ colour: 'blue' }, /unknown setting/);
  await bad({ events: { nope: true } }, /unknown event/);
  await bad({ events: { task_finished: 'yes' } }, /must be true or false/);
  await bad({ events: [] }, /events must be an object/);
  await bad({ watch: 'all' }, /list of at most 500/);
  await bad({ watch: ['nope'] }, /PC ids from this team/);
  await bad({ watch: [theirs.device_id] }, /PC ids from this team/);
  await bad({ watch: Array.from({ length: 501 }, () => mine.id) }, /at most 500/);
  await assert.rejects(() => notify.patchSettings('default', OTHER, { watch: [] }), (e) => e.status === 403);
});

test('a retried write adds nothing: the dedupe key is unique per person, and the insert is limited by its condition', async (t) => {
  const w = await agentWorld(t);
  const notify = notifyStore(w.db, w.team);
  const list = await notify.rows('default', 'device_waiting', { holding: 'devices.manage' }, { device_id: 'a'.repeat(20), title: 't', body: 'b', dedupe: 'x' });
  assert.equal(list.length, 3);
  await notify.write('default', list);
  await notify.write('default', list);
  assert.equal(rowsOf(w).length, 3);
  // Statements for a change that does not hold add nothing.
  await w.db.batch(notify.statements('default', await notify.rows('default', 'device_waiting', { to: [TECH] }, { title: 't', body: 'b', dedupe: 'y' }), ['0', []]));
  assert.equal(rowsOf(w).length, 3);
  // Long text is cut, control characters are not kept.
  const [long] = await notify.rows('default', 'device_waiting', { to: [TECH] }, { title: 'T'.repeat(500), body: `a\u0000b${'c'.repeat(500)}`, dedupe: 'z' });
  assert.equal(long.title.length, 120);
  assert.equal(long.body.length, 300);
  assert.ok(!long.body.includes('\u0000'));
  // Every row names its workspace, and the notifications are not in the team log.
  assert.ok(rowsOf(w).every((r) => r.workspace === 'default'));
  assert.equal(w.sql("SELECT COUNT(*) AS n FROM audit WHERE kind LIKE '%notif%'")[0].n, 0);
  await assert.rejects(() => notify.recipients('default', 'nope', { to: [TECH] }), /unknown notification event/);
});

// ---- the feed and the settings, through /app ----------------------------------------------------------
const appTest = (name, fn) => test(name, { skip }, fn);
const feedWorld = (t) => appWorld(t, { handlerOptions: { notify: { pollMs: 20 } } });

appTest('GET /notifications returns the person\'s own rows, oldest first, with a next id to ask after', async (t) => {
  const w = await feedWorld(t);
  await acme(w);
  const tech = await w.connect(TECH, { app: true });
  const boss = await w.connect(BOSS, { app: true });
  assert.deepEqual((await w.appCall(tech.access, 'GET', '/notifications')).body, { items: [], next: 0 });
  const first = await w.addPc({ status: 'pending', name: 'First' });
  const second = await w.addPc({ status: 'pending', name: 'Second' });
  await w.devs.requestJoin({ protocol: 1, workspace: 'acme', name: 'In another team' });

  const feed = await w.appCall(tech.access, 'GET', '/notifications');
  assert.equal(feed.status, 200);
  assert.equal(feed.headers.get('cache-control'), 'no-store');
  assert.equal(feed.body.items.length, 2);
  const [a, b] = feed.body.items;
  assert.deepEqual(Object.keys(a), ['id', 'event', 'at', 'title', 'body', 'device_id', 'task_id', 'session_id']);
  assert.deepEqual([a.event, a.title, a.body, a.device_id, a.task_id, a.session_id, a.at], ['device_waiting', 'A PC is waiting for approval', 'First', first.id, null, null, w.now()]);
  assert.deepEqual([b.body, b.device_id], ['Second', second.id]);
  assert.ok(a.id < b.id);
  assert.equal(feed.body.next, b.id);
  // After the last id: nothing. After the first: the second.
  assert.deepEqual((await w.appCall(tech.access, 'GET', `/notifications?after=${feed.body.next}`)).body, { items: [], next: b.id });
  assert.deepEqual((await w.appCall(tech.access, 'GET', `/notifications?after=${a.id}`)).body.items.map((i) => i.id), [b.id]);
  // BOSS has the same two (an admin), in this team only, and a feed of their own.
  assert.equal((await w.appCall(boss.access, 'GET', '/notifications')).body.items.length, 2);
  // Another team's feed is another list: the token is for one team.
  const other = await w.connect(OTHER, { app: true, workspace: 'acme' });
  assert.deepEqual((await w.appCall(other.access, 'GET', '/notifications', undefined, { slug: 'acme' })).body.items.map((i) => i.body), ['In another team']);
  assert.equal((await w.appCall(other.access, 'GET', '/notifications')).status, 401, 'and not readable at the default team');
});

appTest('the feed refuses bad parameters, other methods, and a person who is not a member', async (t) => {
  const w = await feedWorld(t);
  const tech = await w.connect(TECH, { app: true });
  for (const q of ['after=-1', 'after=x', 'after=1.5', 'wait_s=26', 'wait_s=-1', 'wait_s=abc']) {
    const r = await w.appCall(tech.access, 'GET', `/notifications?${q}`);
    assert.equal(r.status, 400, q);
    assert.equal(r.body.error.code, 'bad_request');
  }
  assert.equal((await w.appCall(tech.access, 'POST', '/notifications', {})).status, 405);
  assert.equal((await w.appCall(tech.access, 'DELETE', '/notifications', {})).status, 405);
  assert.equal((await w.appCall(tech.access, 'POST', '/notifications/settings', {})).status, 405);
  w.db.sqlite.prepare("DELETE FROM members WHERE identity = ?").run(TECH);
  assert.equal((await w.appCall(tech.access, 'GET', '/notifications')).status, 403);
  assert.equal((await w.appCall(tech.access, 'GET', '/notifications/settings')).status, 403);
});

appTest('a waiting feed request returns within 3 seconds of a new row, and comes back empty when its wait runs out', async (t) => {
  const w = await feedWorld(t);
  const tech = await w.connect(TECH, { app: true });
  const started = performance.now();
  const waiting = w.appCall(tech.access, 'GET', '/notifications?wait_s=2');
  await new Promise((r) => setTimeout(r, 300));
  await w.addPc({ status: 'pending', name: 'Late' });
  const got = await waiting;
  const took = performance.now() - started;
  assert.equal(got.body.items.length, 1);
  assert.equal(got.body.items[0].body, 'Late');
  assert.ok(took < 3000, `returned in ${took.toFixed(0)} ms`);
  assert.ok(took >= 280, 'it waited for the row');

  const idle = performance.now();
  const empty = await w.appCall(tech.access, 'GET', `/notifications?after=${got.body.next}&wait_s=2`);
  const idleMs = performance.now() - idle;
  assert.deepEqual(empty.body, { items: [], next: got.body.next });
  assert.ok(idleMs >= 1800 && idleMs < 4000, `waited ${idleMs.toFixed(0)} ms`);
  // A request that already has rows does not wait.
  const instant = performance.now();
  assert.equal((await w.appCall(tech.access, 'GET', '/notifications?wait_s=25')).body.items.length, 1);
  assert.ok(performance.now() - instant < 1000);
});

appTest('GET and PATCH /notifications/settings: the person\'s switches and watched PCs, validated', async (t) => {
  const w = await feedWorld(t);
  await acme(w);
  const tech = await w.connect(TECH, { app: true });
  const view = await w.connect(VIEW, { app: true, factor: false });
  const pc = await w.addPc({ name: 'Till' });
  const theirs = await w.devs.requestJoin({ protocol: 1, workspace: 'acme', name: 'Theirs' });
  const all = Object.fromEntries(EVENTS.map((e) => [e, true]));
  const get = (token = tech.access) => w.appCall(token, 'GET', '/notifications/settings');
  const patch = (body, token = tech.access) => w.appCall(token, 'PATCH', '/notifications/settings', body);

  assert.deepEqual((await get()).body, { events: all, watch: [] });
  assert.deepEqual((await patch({ events: { task_finished: false } })).body, { events: { ...all, task_finished: false }, watch: [] });
  assert.deepEqual((await patch({ watch: [pc.id] })).body, { events: { ...all, task_finished: false }, watch: [pc.id] }, 'part of it');
  assert.deepEqual((await get()).body.watch, [pc.id]);
  assert.deepEqual((await get(view.access)).body, { events: all, watch: [] }, 'settings are the person\'s own');
  // A Viewer may set their own too: the settings need membership, not a role.
  assert.equal((await patch({ watch: [pc.id] }, view.access)).status, 200);

  for (const [body, match] of [
    [{}, /send events, watch or both/], [{ events: { nope: true } }, /unknown event/], [{ events: { task_finished: 1 } }, /true or false/],
    [{ watch: ['x'] }, /PC ids/], [{ watch: [theirs.device_id] }, /PC ids from this team/], [{ extra: 1 }, /unknown setting/], [{ watch: Array(501).fill(pc.id) }, /at most 500/],
  ]) {
    const r = await patch(body);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 60));
    assert.match(r.body.error.message, match);
  }
  assert.deepEqual((await get()).body.watch, [pc.id], 'a refused patch changes nothing');
  assert.equal((await w.appCall(tech.access, 'PATCH', '/notifications/settings', undefined, { headers: { 'content-type': 'text/plain' } })).status, 415);
  const text = await w.send('/app/w/default/notifications/settings', { method: 'PATCH', headers: { 'content-type': 'application/json', authorization: `Bearer ${tech.access}` }, body: 'not json' });
  assert.equal(text.status, 400);
  // The switch is honoured by the writer: no "waiting" row for someone who switched it off.
  await patch({ events: { device_waiting: false } });
  await w.addPc({ status: 'pending', name: 'Next' });
  assert.deepEqual((await w.appCall(tech.access, 'GET', '/notifications')).body.items, []);
  const boss = await w.connect(BOSS, { app: true });
  assert.equal((await w.appCall(boss.access, 'GET', '/notifications')).body.items.length, 1);
});
