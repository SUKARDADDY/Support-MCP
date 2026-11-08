// A saved-PC session on the wire: /agent with the PC's own key, the waiting
// state, decline, the driver, take-over, how a session ends, and what ending
// leaves behind (the PC's pointer and the team log).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, BOSS, TECH, VIEW, LEAD, HOST } from './device-sessions-world.js';

const HOUR = 3_600_000;
const tick = () => new Promise((r) => setImmediate(r));
// Waits on the event itself, with a wall-clock bound. A count of event-loop turns is not a time: the work in
// between (key hashes on the thread pool) takes as many turns as it takes, and a loaded CI runner needs far more.
const until = async (fn, ms = 10_000) => { const end = performance.now() + ms; while (!fn() && performance.now() < end) await tick(); assert.ok(fn(), 'timed out waiting'); };

// ---- who may speak on /agent ----------------------------------------------------------
test('a PC joins its session with its own key; the welcome names the driver and ends 24 hours after the first hello', async (t) => {
  const w = await world(t);
  const pc = await w.addPc({ access: 'ask' });
  const { sid, welcome } = await w.attach(pc, TECH);
  assert.equal(welcome.status, 200);
  assert.deepEqual(Object.keys(welcome.body).sort(), ['driver', 'expires_at', 'generation', 'server_time', 'type']);
  assert.deepEqual([welcome.body.type, welcome.body.driver, welcome.body.generation], ['welcome', TECH, 1]);
  assert.equal(welcome.body.expires_at, w.now() + 24 * HOUR);
  assert.equal(w.stateOf(sid), 'attached');
  // The pointer now ends exactly when the session does.
  assert.equal(w.pointer(pc.id).expires_at, welcome.body.expires_at);
  assert.equal((await w.hello(pc.key)).body.session.expires_at, welcome.body.expires_at);
  // A second hello (the service restarted) rejoins and does not extend the 24 hours.
  w.advance(10 * 60_000);
  const again = await w.agent(sid, pc.key, { type: 'hello', control: 'full', caps: ['screen', 'lanes'] });
  assert.equal(again.body.expires_at, welcome.body.expires_at);
  assert.equal(again.body.generation, 2);
  // The registry lists it as attached with the PC's machine.
  const listed = (await w.tool(TECH, 'session_list')).sessions[0];
  assert.deepEqual([listed.state, listed.expires_at], ['attached', welcome.body.expires_at]);
});

test('there is no idle timeout: 24 hours from the first hello is the only end, and its reason is max_time', async (t) => {
  const w = await world(t);
  const pc = await w.addPc();
  const { sid, welcome } = await w.attach(pc);
  const generation = welcome.body.generation;
  w.advance(24 * HOUR - 1000);
  // A day of silence from the technician and the PC (no polls) did not end it.
  const idle = await w.agent(sid, pc.key, { type: 'poll', generation, busy_lanes: ['cmd', 'screen'] });
  assert.deepEqual([idle.status, idle.body.type], [200, 'idle']);
  assert.equal(w.stateOf(sid), 'attached');
  w.advance(1000);
  await w.sessionFor(sid).session.alarm();
  assert.deepEqual([w.stateOf(sid), w.reasonOf(sid)], ['ended', 'max_time']);
  assert.equal(w.pointer(pc.id), null, 'the pointer is cleared');
  const ended = (await w.log()).filter((r) => r.kind === 'device_session_ended');
  assert.deepEqual(ended.map((r) => [r.actor, r.detail]), [['relay', `${pc.id} "Till" ${sid.slice(0, 8)} max_time`]]);
  assert.equal(w.sessionFor(sid).ctx.alarm(), null);
});

test('the waiting deadline is 510 seconds; an unanswered session ends as timed_out and frees the PC', async (t) => {
  const w = await world(t);
  const pc = await w.addPc();
  const started = await w.tool(TECH, 'device_connect', { device_id: pc.id });
  w.advance(509_999);
  await w.sessionFor(started.session_id).session.alarm();
  assert.equal(w.stateOf(started.session_id), 'waiting');
  w.advance(1);
  await w.sessionFor(started.session_id).session.alarm();
  assert.deepEqual([w.stateOf(started.session_id), w.reasonOf(started.session_id)], ['ended', 'timed_out']);
  assert.equal(w.pointer(pc.id), null);
  assert.deepEqual((await w.log()).filter((r) => r.kind === 'device_session_ended').map((r) => r.detail.split(' ').pop()), ['timed_out']);
  // The PC is free for the next technician.
  assert.equal((await w.tool(BOSS, 'device_connect', { device_id: pc.id })).state, 'waiting');
});

test('/agent refuses a wrong key, another PC, a session the record does not point at, a bare attach key and a pending PC', async (t) => {
  const w = await world(t);
  const pc = await w.addPc();
  const other = await w.addPc({ name: 'Other' });
  const started = await w.tool(TECH, 'device_connect', { device_id: pc.id });
  const sid = started.session_id;
  const body = { type: 'hello', control: 'full', caps: [] };
  const wrong = `${pc.key.slice(0, -3)}AAA`;
  for (const [what, key, headers] of [
    ['a wrong secret', wrong, {}],
    ['another PC', other.key, {}],
    ['no key', null, {}],
    ['a malformed key', 'smd1.nope', {}],
    ['an attach key only', null, { 'x-attach-key': 'a'.repeat(64) }],
    ['an attach key with a device key', other.key, { 'x-attach-key': 'a'.repeat(64) }],
  ]) {
    const res = await w.agent(sid, key, body, headers);
    assert.equal(res.status, 401, what);
    assert.deepEqual(res.body, { error: 'unauthorized' }, what);
  }
  assert.equal(w.stateOf(sid), 'waiting', 'none of them attached');
  // A session id that is not the one on the record, and a made-up one.
  assert.equal((await w.agent('b'.repeat(64), pc.key, body)).status, 401);
  const stranger = await w.tool(BOSS, 'session_create', {});
  assert.equal((await w.agent(stranger.session_id, pc.key, body)).status, 401, 'a link session is not reachable with a device key');
  // The right key still works.
  assert.equal((await w.agent(sid, pc.key, body)).status, 200);
  // A pending PC cannot join, even with a pointer on its row.
  const waiting = await w.addPc({ status: 'pending' });
  w.db.sqlite.prepare('UPDATE devices SET session = ? WHERE id = ?').run(JSON.stringify({ id: sid, by: TECH, ask: true, expires_at: w.now() + HOUR, code: 'abcdefghijklmnop', team: 'Default' }), waiting.id);
  assert.equal((await w.agent(sid, waiting.key, body)).status, 401);
  // Once the PC is removed its key ends with it.
  await w.api(BOSS, 'DELETE', `/devices/${pc.id}`);
  assert.equal((await w.agent(sid, pc.key, body)).status, 401);
});

test('/agent keeps its other rules for a device key: https, no Origin, JSON, a key never in the URL, a size cap', async (t) => {
  const w = await world(t);
  const pc = await w.addPc();
  const { sid } = await w.attach(pc);
  const post = (path, init) => w.send(path, { method: 'POST', ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${pc.key}`, ...(init?.headers ?? {}) } });
  assert.equal((await post(`/agent?sid=${sid}`, { base: 'http://support.example.com', body: '{}' })).status, 403);
  assert.equal((await post(`/agent?sid=${sid}`, { headers: { origin: 'https://evil.example' }, body: '{}' })).status, 403);
  assert.equal((await post(`/agent?sid=${sid}&key=${pc.key}`, { body: '{}' })).status, 403);
  assert.equal((await post(`/agent?sid=${sid}`, { headers: { 'content-type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await post(`/agent?sid=${sid}`, { body: 'x'.repeat(750_001) })).status, 413);
  assert.equal((await post('/agent', { body: '{}' })).status, 401);
  assert.equal((await w.send(`/agent?sid=${sid}`, { method: 'GET', headers: { authorization: `Bearer ${pc.key}` } })).status, 405);
});

test('a client cannot forge the device headers: a link session ignores X-Device-Id, and a device session ignores an attach key', async (t) => {
  const w = await world(t);
  const link = await w.tool(BOSS, 'session_create', {});
  const forged = await w.agent(link.session_id, null, { type: 'hello' }, { 'x-device-id': 'a'.repeat(20), 'x-device-control': 'full' });
  assert.equal(forged.status, 401);
  const pc = await w.addPc();
  const started = await w.tool(TECH, 'device_connect', { device_id: pc.id });
  const direct = await w.agent(started.session_id, null, { type: 'hello' }, { 'x-device-id': pc.id });
  assert.equal(direct.status, 401, 'the Worker, not the client, says which device this is');
  // What the Session receives from the Worker: the id and the control the database holds, and no key.
  await w.agent(started.session_id, pc.key, { type: 'hello', control: 'full', caps: [] });
  const call = w.sessionCalls.findLast((c) => c.path === '/agent');
  assert.equal(call.headers['x-device-id'], pc.id);
  assert.equal(call.headers['x-device-control'], 'full');
  assert.equal(call.headers.authorization, undefined);
  assert.equal(call.headers['x-attach-key'], undefined);
});

// ---- decline and control --------------------------------------------------------------
test('before hello a PC can decline with declined, nobody or busy; the session ends with that reason and the PC is free', async (t) => {
  for (const reason of ['declined', 'nobody', 'busy']) {
    const w = await world(t);
    const pc = await w.addPc();
    const started = await w.tool(TECH, 'device_connect', { device_id: pc.id });
    const res = await w.agent(started.session_id, pc.key, { type: 'decline', reason });
    assert.deepEqual([res.status, res.body], [200, { type: 'end' }], reason);
    assert.deepEqual([w.stateOf(started.session_id), w.reasonOf(started.session_id)], ['ended', reason]);
    assert.equal(w.pointer(pc.id), null);
    const ended = (await w.log()).filter((r) => r.kind === 'device_session_ended');
    assert.deepEqual(ended.map((r) => [r.actor, r.detail.split(' ').pop()]), [[`pc ${pc.id}`, reason]]);
    const status = await w.tool(TECH, 'session_status', { session_id: started.session_id });
    assert.deepEqual([status.state, status.ended_reason], ['ended', reason]);
    // Later requests for the session get 401: the record no longer points at it.
    assert.equal((await w.agent(started.session_id, pc.key, { type: 'hello', control: 'full' })).status, 401);
  }
});

test('decline is valid before hello with one of the three reasons, after hello only as nobody or busy, and only on a saved-PC session', async (t) => {
  const w = await world(t);
  const pc = await w.addPc();
  const started = await w.tool(TECH, 'device_connect', { device_id: pc.id });
  for (const reason of ['other', '', undefined, 5, 'owner']) {
    const res = await w.agent(started.session_id, pc.key, { type: 'decline', reason });
    assert.equal(res.status, 400, String(reason));
  }
  assert.equal(w.stateOf(started.session_id), 'waiting');
  await w.agent(started.session_id, pc.key, { type: 'hello', control: 'full', caps: [] });
  assert.equal((await w.agent(started.session_id, pc.key, { type: 'decline', reason: 'declined' })).status, 400);
  assert.equal(w.stateOf(started.session_id), 'attached');
  // After hello "nobody" and "busy" are taken: a PC that restarted during a limited session and found its user signed
  // out, or several Remote Desktop users to choose from.
  assert.equal((await w.agent(started.session_id, pc.key, { type: 'decline', reason: 'nobody' })).status, 200);
  assert.deepEqual([w.stateOf(started.session_id), w.reasonOf(started.session_id)], ['ended', 'nobody']);
  const again = await w.tool(TECH, 'device_connect', { device_id: pc.id });
  await w.agent(again.session_id, pc.key, { type: 'hello', control: 'limited', caps: [] });
  assert.equal((await w.agent(again.session_id, pc.key, { type: 'decline', reason: 'declined' })).status, 400);
  assert.equal((await w.agent(again.session_id, pc.key, { type: 'decline', reason: 'busy' })).status, 200);
  assert.deepEqual([w.stateOf(again.session_id), w.reasonOf(again.session_id)], ['ended', 'busy']);
  // A link session has no decline.
  const link = await w.tool(BOSS, 'session_create', {});
  const session = w.sessionFor(link.session_id).session;
  const res = await session.fetch(new Request('https://do/agent', { method: 'POST', headers: { 'x-attach-key': 'a'.repeat(64) }, body: JSON.stringify({ type: 'decline', reason: 'declined' }) }));
  assert.equal(res.status, 401);
});

test('a hello with control full from a limited PC is 403; limited PCs say normal, full PCs say full', async (t) => {
  const w = await world(t);
  const limited = await w.addPc({ name: 'Limited', control: 'limited' });
  const full = await w.addPc({ name: 'Full', control: 'full' });
  const a = await w.tool(TECH, 'device_connect', { device_id: limited.id });
  const b = await w.tool(TECH, 'device_connect', { device_id: full.id });
  const denied = await w.agent(a.session_id, limited.key, { type: 'hello', control: 'full', caps: ['full'] });
  assert.equal(denied.status, 403);
  assert.equal(w.stateOf(a.session_id), 'waiting', 'it did not attach');
  assert.equal((await w.agent(a.session_id, limited.key, { type: 'hello', control: 'normal', caps: [] })).status, 200);
  assert.equal((await w.agent(b.session_id, full.key, { type: 'hello', control: 'full', caps: [] })).status, 200);
  const status = await w.tool(TECH, 'session_status', { session_id: a.session_id });
  assert.equal(status.control, 'normal');
  // The control level is read from the record at the hello, so a PC the owner lowered stays lowered.
  const lowered = await w.addPc({ name: 'Lowered', control: 'full' });
  const c = await w.tool(TECH, 'device_connect', { device_id: lowered.id });
  w.db.sqlite.prepare("UPDATE devices SET control = 'limited' WHERE id = ?").run(lowered.id);
  assert.equal((await w.agent(c.session_id, lowered.key, { type: 'hello', control: 'full', caps: [] })).status, 403);
});

// ---- consume and the link page --------------------------------------------------------------
test('/consume and /j/ refuse a saved-PC session: its code opens nothing', async (t) => {
  const w = await world(t);
  const pc = await w.addPc();
  const started = await w.tool(TECH, 'device_connect', { device_id: pc.id });
  const code = w.sessionFor(started.session_id).ctx.values.get('code');
  const consume = await w.sessionFor(started.session_id).session.fetch(new Request('https://do/consume', { method: 'POST', body: JSON.stringify({ windows_mode: 'app' }) }));
  assert.deepEqual(await consume.json(), { ok: false, reason: 'not-pending' });
  // The PowerShell link route: a code that does not work.
  const ps = await w.send(`/j/${code}`, { headers: { 'user-agent': 'WindowsPowerShell/5.1.19041' } });
  assert.equal(ps.status, 404);
  // The app link route needs an app bundle; with one it shows an expired page and downloads nothing.
  assert.equal(w.stateOf(started.session_id), 'waiting');
  assert.equal(w.sessionFor(started.session_id).ctx.values.get('key_hash'), undefined);
  const ws = await w.send(`/ws?sid=${started.session_id}`, { headers: { 'x-attach-key': 'a'.repeat(64) } });
  assert.equal(ws.status, 401);
});

// ---- the driver ----------------------------------------------------------------------------
test('commands from anyone but the driver are refused with the driver named; session_status and session_end are not commands', async (t) => {
  const w = await world(t);
  const pc = await w.addPc();
  const { sid } = await w.attach(pc, TECH);
  const refused = await w.tool(LEAD, 'run', { session_id: sid, command: 'whoami' });
  assert.equal(refused.error, `${TECH} is driving this session; use device_connect with take_over`);
  for (const [name, args] of [['put_file', { path: 'C:\\x', data_b64: 'AA==' }], ['get_file', { path: 'C:\\x' }], ['screenshot', {}], ['click', { x: 1, y: 1 }], ['request_full_control', {}]]) {
    const r = await w.tool(LEAD, name, { session_id: sid, ...args });
    assert.match(r.error ?? JSON.stringify(r), /is driving this session; use device_connect with take_over/, name);
  }
  assert.equal((await w.tool(LEAD, 'session_status', { session_id: sid })).state, 'attached');
  assert.equal((await w.tool(LEAD, 'session_list')).sessions.length, 1);
});

test('the driver runs a command, and every poll answer carries the driver', async (t) => {
  const w = await world(t);
  const pc = await w.addPc();
  const { sid, welcome } = await w.attach(pc, TECH);
  const generation = welcome.body.generation;
  const idle = await w.agent(sid, pc.key, { type: 'poll', generation, busy_lanes: ['cmd', 'screen'] });
  assert.deepEqual(idle.body, { type: 'idle', driver: TECH });
  const running = w.tool(TECH, 'run', { session_id: sid, command: 'whoami' });
  const session = w.sessionFor(sid).session;
  await until(() => session.httpCommands.cmd !== null);
  const frame = await w.agent(sid, pc.key, { type: 'poll', generation, busy_lanes: [] });
  assert.deepEqual([frame.body.type, frame.body.command, frame.body.driver], ['run', 'whoami', TECH]);
  const result = await w.agent(sid, pc.key, { type: 'result', generation, id: frame.body.id, ok: true, exit_code: 0, stdout_b64: btoa('nt authority\\system'), stderr_b64: '' });
  assert.deepEqual(result.body, { type: 'ack' });
  assert.deepEqual(await running, { exit_code: 0, stdout: 'nt authority\\system', stderr: '', timed_out: false });
});

test('a link session never shows a driver and any caller may command it, as before', async (t) => {
  const w = await world(t);
  const link = await w.tool(BOSS, 'session_create', {});
  const status = await w.tool(TECH, 'session_status', { session_id: link.session_id });
  assert.equal(Object.hasOwn(status, 'driver'), false);
  assert.equal(Object.hasOwn(status, 'device_id'), false);
  // Not attached yet, but the answer is the old one, not a driver refusal.
  assert.equal((await w.tool(TECH, 'run', { session_id: link.session_id, command: 'x' })).error, 'agent not attached');
  assert.equal((await w.tool(LEAD, 'run', { session_id: link.session_id, command: 'x' })).error, 'agent not attached');
});

// ---- take-over -----------------------------------------------------------------------------
test('take_over needs sessions.unattended, moves the driver, rings the PC and logs a take-over, not an end', async (t) => {
  const w = await world(t);
  const pc = await w.addPc({ access: 'ask' });
  const { sid, welcome } = await w.attach(pc, TECH);
  const bell = w.ringSocket(pc.id);
  // A technician without the permission is told to end it and connect again.
  const refused = await w.tool(VIEW, 'device_connect', { device_id: pc.id, take_over: true });
  assert.match(refused.error, /sessions\.control/);
  const lead = await w.team.addMember('default', BOSS, { identity: 'tech2@example.com', role_id: 'technician' });
  assert.equal(lead.role_id, 'technician');
  const no = await w.tool('tech2@example.com', 'device_connect', { device_id: pc.id, take_over: true });
  assert.match(no.error, /^taking over needs sessions\.unattended\. Ask the driver to end the session, then connect again so the person at the PC is asked\.$/);
  assert.equal(w.pointer(pc.id).by, TECH);
  assert.deepEqual(bell.sent, []);
  // Without take_over the answer names who is connected.
  assert.equal((await w.tool(BOSS, 'device_connect', { device_id: pc.id })).error, `${TECH} is connected`);

  const taken = await w.tool(LEAD, 'device_connect', { device_id: pc.id, take_over: true });
  assert.deepEqual(taken, { session_id: sid, state: 'attached', asks: true, rang: true });
  assert.deepEqual(bell.sent, ['{"type":"ring"}']);
  assert.equal(w.pointer(pc.id).by, LEAD);
  assert.equal(w.pointer(pc.id).id, sid);
  assert.equal(w.stateOf(sid), 'attached', 'a take-over is not an end');
  assert.equal(w.sessionFor(sid).ctx.values.get('driver'), LEAD);
  const rows = (await w.log()).filter((r) => r.kind.startsWith('device_session_'));
  assert.deepEqual(rows.map((r) => [r.kind, r.actor]), [['device_session_started', TECH], ['device_session_taken_over', LEAD]]);
  assert.equal(rows[1].detail, `${pc.id} "Till" from ${TECH}`);
  // The old driver is refused now; the new one is not. The PC hears the new name on its next answer.
  assert.equal((await w.tool(TECH, 'run', { session_id: sid, command: 'x' })).error, `${LEAD} is driving this session; use device_connect with take_over`);
  const idle = await w.agent(sid, pc.key, { type: 'poll', generation: welcome.body.generation, busy_lanes: ['cmd', 'screen'] });
  assert.deepEqual(idle.body, { type: 'idle', driver: LEAD });
  assert.equal((await w.hello(pc.key)).body.session.by, LEAD);
  assert.equal((await w.tool(TECH, 'session_status', { session_id: sid })).driver, LEAD);
  // Taking over your own session changes nothing.
  assert.equal((await w.tool(LEAD, 'device_connect', { device_id: pc.id, take_over: true })).session_id, sid);
});

test('take_over wakes a parked poll at once, so the corner window shows the new name', async (t) => {
  const w = await world(t);
  const pc = await w.addPc();
  const { sid, welcome } = await w.attach(pc, TECH);
  const parked = w.agent(sid, pc.key, { type: 'poll', generation: welcome.body.generation, busy_lanes: [] });
  await until(() => w.sessionFor(sid).session.httpPoll !== null);
  await w.tool(BOSS, 'device_connect', { device_id: pc.id, take_over: true });
  assert.deepEqual((await parked).body, { type: 'idle', driver: BOSS });
});

test('take_over with no session is a plain connect that still needs sessions.unattended; a session that just ended is an error', async (t) => {
  const w = await world(t);
  const pc = await w.addPc({ access: 'any' });
  assert.match((await w.tool(TECH, 'device_connect', { device_id: pc.id, take_over: true })).error, /^taking over needs sessions\.unattended/);
  assert.equal(w.pointer(pc.id), null);
  const out = await w.tool(BOSS, 'device_connect', { device_id: pc.id, take_over: true });
  assert.deepEqual([out.state, out.asks], ['waiting', false]);
  // The Session object ended without clearing the pointer (its clear is still to retry).
  w.sessionFor(out.session_id).ctx.values.set('state', 'ended');
  const gone = await w.tool(LEAD, 'device_connect', { device_id: pc.id, take_over: true });
  assert.equal(gone.error, 'that session has just ended; connect again');
});

// ---- ending ------------------------------------------------------------------------------
test('the PC ends its own session: reason owner, with or without it in the message; the pointer clears and the log says so', async (t) => {
  for (const extra of [{ reason: 'owner' }, {}]) {
    const w = await world(t);
    const pc = await w.addPc();
    const { sid, welcome } = await w.attach(pc, TECH);
    const res = await w.agent(sid, pc.key, { type: 'end', generation: welcome.body.generation, ...extra });
    assert.deepEqual([res.status, res.body], [200, { type: 'end' }]);
    assert.deepEqual([w.stateOf(sid), w.reasonOf(sid)], ['ended', 'owner']);
    assert.equal(w.pointer(pc.id), null);
    const ended = (await w.log()).filter((r) => r.kind === 'device_session_ended');
    assert.deepEqual(ended.map((r) => [r.actor, r.detail]), [[`pc ${pc.id}`, `${pc.id} "Till" ${sid.slice(0, 8)} owner`]]);
  }
});

test('a technician ends the session with reason technician, and the PC is told on its parked poll', async (t) => {
  const w = await world(t);
  const pc = await w.addPc();
  const { sid, welcome } = await w.attach(pc, TECH);
  const parked = w.agent(sid, pc.key, { type: 'poll', generation: welcome.body.generation, busy_lanes: [] });
  await until(() => w.sessionFor(sid).session.httpPoll !== null);
  assert.deepEqual(await w.tool(LEAD, 'session_end', { session_id: sid }), { ended: true });
  assert.deepEqual((await parked).body, { type: 'end', reason: 'technician', driver: TECH });
  assert.deepEqual([w.stateOf(sid), w.reasonOf(sid)], ['ended', 'technician']);
  assert.equal(w.pointer(pc.id), null);
  const ended = (await w.log()).filter((r) => r.kind === 'device_session_ended');
  assert.deepEqual(ended.map((r) => [r.actor, r.detail.split(' ').pop()]), [[LEAD, 'technician']]);
  // Ending again changes nothing and logs nothing more.
  await w.tool(LEAD, 'session_end', { session_id: sid });
  assert.equal((await w.kinds()).filter((k) => k === 'device_session_ended').length, 1);
});

test('only the team can name stopped, removed or replaced as an end reason; a link session keeps ended_by_operator', async (t) => {
  const w = await world(t);
  const link = await w.tool(BOSS, 'session_create', {});
  await w.tool(BOSS, 'session_end', { session_id: link.session_id });
  assert.equal(w.reasonOf(link.session_id), 'ended_by_operator');
  // The tool takes no reason; the Session object ignores an unknown one.
  const pc = await w.addPc();
  const { sid } = await w.attach(pc);
  const stub = w.sessionFor(sid).session;
  await stub.fetch(new Request('https://do/end', { method: 'POST', body: JSON.stringify({ actor: BOSS, workspace: 'default', reason: 'owner' }) }));
  assert.equal(w.reasonOf(sid), 'technician', 'owner is the PC\'s word, not the team\'s');
});

test('a Session that cannot clear its pointer keeps trying from its alarm until it works, and logs the end once', async (t) => {
  const w = await world(t);
  const pc = await w.addPc();
  const { sid } = await w.attach(pc, TECH);
  const batch = w.db.batch;
  w.db.batch = async () => { throw new Error('D1 is down'); };
  await w.tool(TECH, 'session_end', { session_id: sid });
  assert.equal(w.stateOf(sid), 'ended');
  assert.notEqual(w.pointer(pc.id), null, 'the clear failed');
  const ctx = w.sessionFor(sid).ctx;
  assert.equal(ctx.values.get('cleanup_pending'), true);
  assert.equal(ctx.alarm(), w.now() + 30_000, 'a retry is set');
  await w.sessionFor(sid).session.alarm();
  assert.notEqual(w.pointer(pc.id), null);
  assert.equal(ctx.alarm(), w.now() + 30_000);
  w.db.batch = batch;
  w.advance(30_000);
  await w.sessionFor(sid).session.alarm();
  assert.equal(w.pointer(pc.id), null);
  assert.equal(ctx.values.get('cleanup_pending'), false);
  assert.equal((await w.kinds()).filter((k) => k === 'device_session_ended').length, 1);
  await w.sessionFor(sid).session.alarm();
  assert.equal((await w.kinds()).filter((k) => k === 'device_session_ended').length, 1, 'a finished clear is not repeated');
});

test('ending a session never clears a newer session on the same PC', async (t) => {
  const w = await world(t);
  const pc = await w.addPc();
  const { sid } = await w.attach(pc, TECH);
  // The pointer has moved on to another session (the first one's clear was late).
  const other = { ...w.pointer(pc.id), id: 'c'.repeat(64) };
  w.db.sqlite.prepare('UPDATE devices SET session = ? WHERE id = ?').run(JSON.stringify(other), pc.id);
  await w.tool(TECH, 'session_end', { session_id: sid });
  assert.equal(w.pointer(pc.id).id, 'c'.repeat(64));
});

// ---- removal ---------------------------------------------------------------------------
test('removing a PC in the team API ends its live session with reason removed, and rings its doorbell, then closes it', async (t) => {
  const w = await world(t);
  const pc = await w.addPc();
  const { sid } = await w.attach(pc, TECH);
  const bell = w.ringSocket(pc.id);
  const res = await w.api(BOSS, 'DELETE', `/devices/${pc.id}`);
  assert.equal(res.status, 200);
  assert.deepEqual([w.stateOf(sid), w.reasonOf(sid)], ['ended', 'removed']);
  const kinds = await w.kinds();
  const at = (k) => kinds.indexOf(k);
  assert.ok(at('device_session_ended') > -1 && at('device_session_ended') < at('device_removed'), 'the end is logged before the removal');
  const ended = (await w.log()).find((r) => r.kind === 'device_session_ended');
  assert.deepEqual([ended.actor, ended.detail.split(' ').pop()], [BOSS, 'removed']);
  assert.deepEqual(bell.sent, ['{"type":"ring"}']);
  assert.equal(bell.closed, true);
  assert.equal((await w.hello(pc.key)).status, 401, 'the PC finds out it is removed when it checks in');
  assert.equal(w.sql('SELECT COUNT(*) AS n FROM devices')[0].n, 0);
});

test('a PC that leaves itself ends its live session with reason removed', async (t) => {
  const w = await world(t);
  const pc = await w.addPc();
  const { sid } = await w.attach(pc, TECH);
  const r = await w.send('/device/leave', { method: 'POST', headers: { 'content-type': 'application/json', ...w.bearer(pc.key) }, body: JSON.stringify({ protocol: 1 }) });
  assert.equal(r.status, 200);
  assert.deepEqual([w.stateOf(sid), w.reasonOf(sid)], ['ended', 'removed']);
  const ended = (await w.log()).find((x) => x.kind === 'device_session_ended');
  assert.equal(ended.actor, `pc ${pc.id}`);
  assert.equal((await w.kinds()).filter((k) => k === 'device_session_ended').length, 1);
});

test('removing a PC with no session ends nothing, and the removal still rings its doorbell', async (t) => {
  const w = await world(t);
  const pc = await w.addPc();
  const bell = w.ringSocket(pc.id);
  await w.api(BOSS, 'DELETE', `/devices/${pc.id}`);
  assert.equal(w.sessionCalls.length, 0);
  assert.deepEqual(bell.sent, ['{"type":"ring"}']);
});

// ---- the team changes that ring -------------------------------------------------------------
test('switching a PC to any time needs sessions.unattended as well as devices.manage, and rings the PC; ask needs only devices.manage', async (t) => {
  const w = await world(t);
  const pc = await w.addPc({ access: 'ask' });
  const bell = w.ringSocket(pc.id);
  const refused = await w.api(TECH, 'PATCH', `/devices/${pc.id}`, { access: 'any' });
  assert.deepEqual([refused.status, refused.body.error.code], [403, 'permission_denied']);
  assert.match(refused.body.error.message, /sessions\.unattended/);
  assert.deepEqual(bell.sent, []);
  assert.equal(w.sql('SELECT access FROM devices')[0].access, 'ask');
  assert.equal((await w.api(VIEW, 'PATCH', `/devices/${pc.id}`, { access: 'any' })).status, 403);
  const ok = await w.api(LEAD, 'PATCH', `/devices/${pc.id}`, { access: 'any' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.device.access, 'any');
  assert.deepEqual(bell.sent, ['{"type":"ring"}']);
  // Back to ask: a technician may, and the PC is rung again.
  const back = await w.api(TECH, 'PATCH', `/devices/${pc.id}`, { access: 'ask' });
  assert.equal(back.status, 200);
  assert.equal(bell.sent.length, 2);
  // Another change does not ring; a change that changes nothing does not either.
  await w.api(TECH, 'PATCH', `/devices/${pc.id}`, { owner_contact: 'Sam' });
  await w.api(TECH, 'PATCH', `/devices/${pc.id}`, { access: 'ask' });
  assert.equal(bell.sent.length, 2);
  // The owner's own switch (from the PC) is not a team change and needs nothing.
  const own = await w.send('/device/update', { method: 'POST', headers: { 'content-type': 'application/json', ...w.bearer(pc.key) }, body: JSON.stringify({ protocol: 1, access: 'any' }) });
  assert.equal(own.status, 200);
});

test('the permission is held again at commit: a role that loses sessions.unattended in between is refused', async (t) => {
  const w = await world(t);
  const pc = await w.addPc({ access: 'ask' });
  const batch = w.db.batch;
  let done = false;
  w.db.batch = async (statements) => {
    if (!done) { done = true; w.db.sqlite.exec(`UPDATE roles SET permissions = '["devices.view","devices.manage","sessions.view","sessions.control","sessions.end"]' WHERE role_id = 'lead'`); }
    return batch(statements);
  };
  const res = await w.api(LEAD, 'PATCH', `/devices/${pc.id}`, { access: 'any' });
  w.db.batch = batch;
  assert.equal(res.status, 403);
  assert.equal(w.sql('SELECT access FROM devices')[0].access, 'ask');
  assert.equal((await w.kinds()).includes('device_changed'), false);
});

test('approving a waiting PC rings its doorbell, and a team change that is not access or approval does not', async (t) => {
  const w = await world(t);
  const out = await w.devs.requestJoin({ protocol: 1, workspace: 'default', name: 'Kitchen' });
  const bell = w.ringSocket(out.device_id);
  const site = await w.devs.addRecord('customer', 'default', BOSS, { name: 'Dana' });
  await w.api(TECH, 'PATCH', `/devices/${out.device_id}`, { fields: {} }).catch(() => null);
  assert.equal(bell.sent.length, 0);
  const approved = await w.api(TECH, 'PATCH', `/devices/${out.device_id}`, { approve: { confirm: out.confirm } });
  assert.equal(approved.status, 200);
  assert.deepEqual(bell.sent, ['{"type":"ring"}']);
  assert.ok(site.id);
});

test('a Session is made for a saved PC only with a good device id, a driver and the app mode; a second create is refused', async (t) => {
  const w = await world(t);
  const create = (sid, body) => w.sessionFor(sid).session.fetch(new Request('https://do/create', { method: 'POST', body: JSON.stringify({ code: 'abcdefghijklmnop', sid, windows_mode: 'app', workspace: 'default', ...body }) }));
  const id = 'a'.repeat(20);
  for (const [what, body] of [
    ['no driver', { device_id: id }],
    ['an empty driver', { device_id: id, driver: '' }],
    ['a bad id', { device_id: 'nope', driver: TECH }],
    ['a number for an id', { device_id: 5, driver: TECH }],
    ['the PowerShell mode', { device_id: id, driver: TECH, windows_mode: 'powershell' }],
  ]) {
    const sid = createSid(what);
    const res = await create(sid, body);
    assert.equal(res.status, 400, what);
    assert.equal(w.stateOf(sid), undefined, `${what} made nothing`);
  }
  const sid = createSid('good');
  const ok = await create(sid, { device_id: id, driver: ' Tech@Example.com ', device_name: 'x'.repeat(300) });
  assert.equal(ok.status, 200);
  const values = w.sessionFor(sid).ctx.values;
  assert.deepEqual([values.get('state'), values.get('driver'), values.get('device_name').length], ['waiting', TECH, 101], 'the driver is kept as an identity, the name is cut');
  assert.equal((await create(sid, { device_id: id, driver: TECH })).status, 409, 'never overwrite a live session');
});
const createSid = (label) => Buffer.from(label.padEnd(32, '.')).toString('hex');
