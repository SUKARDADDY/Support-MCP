// One-off link sessions are transferable too: the member who makes a link drives its session, and control moves by
// the same invite, offer and accept, or by an admin's take-over. The person at a one-off PC is never told the driver.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentWorld, BOSS, TECH, VIEW, LEAD } from './agent-world.js';
import { TECH2, addTech2, appHello, call, oneOff } from './people-world.js';

const rows = (list) => list.map((p) => `${p.identity}:${p.role}`);
const kinds = async (w) => (await w.log()).map((r) => r.kind).filter((k) => /session_(handed|taken)_over/.test(k));

// A link session made through the tool by `who`, with the downloaded app attached.
async function link(w, who = TECH) {
  const made = await w.tool(who, 'session_create', {});
  assert.equal(made.error, undefined, JSON.stringify(made));
  const { key, hello } = await appHello(w, made.session_id);
  assert.equal(hello.status, 200, JSON.stringify(hello.body));
  return { sid: made.session_id, key, generation: hello.body.generation, welcome: hello.body };
}
const poll = (w, l) => w.agent(l.sid, null, { type: 'poll', generation: l.generation, busy_lanes: ['cmd', 'screen'] }, { 'x-attach-key': l.key });
const hand = (w, who, sid, action, identity) => w.tool(who, 'session_handover', { session_id: sid, action, ...(identity ? { identity } : {}) });
const part = (w, who, sid, action, identity) => w.tool(who, 'session_participants', { session_id: sid, action, ...(identity ? { identity } : {}) });

test('a one-off session made by a member has its creator as driver, and another technician\'s command is refused with session_handover named', async (t) => {
  const w = await agentWorld(t);
  const made = await w.tool(TECH, 'session_create', {});
  const status = await w.tool(BOSS, 'session_status', { session_id: made.session_id });
  assert.equal(status.driver, TECH);
  assert.deepEqual(rows(status.participants), [`${TECH}:driver`]);
  assert.equal(w.sessionFor(made.session_id).ctx.values.get('driver'), TECH);
  const refused = await w.tool(LEAD, 'run', { session_id: made.session_id, command: 'whoami' });
  assert.match(refused.error, new RegExp(`^${TECH} is driving this session; .*session_handover`));
  assert.equal((await w.tool(TECH, 'run', { session_id: made.session_id, command: 'whoami' })).error, 'agent not attached');
  // The screen tools and files follow the same rule.
  for (const [name, args] of [['screenshot', {}], ['put_file', { path: 'C:\\x', data_b64: 'eA==' }], ['get_file', { path: 'C:\\x' }], ['click', { x: 1, y: 1 }]]) {
    assert.match((await w.tool(BOSS, name, { session_id: made.session_id, ...args })).error, /is driving this session/, name);
  }
});

test('in open mode a one-off session gets no driver and stays open to anyone', async (t) => {
  const w = await agentWorld(t, { members: false });
  const made = await w.tool('anyone@example.com', 'session_create', {});
  const status = await w.tool('another@example.com', 'session_status', { session_id: made.session_id });
  assert.equal(Object.hasOwn(status, 'driver'), false);
  assert.equal(w.sessionFor(made.session_id).ctx.values.has('driver'), false);
  for (const who of ['anyone@example.com', 'another@example.com']) {
    assert.equal((await w.tool(who, 'run', { session_id: made.session_id, command: 'x' })).error, 'agent not attached', who);
  }
});

test('a one-off session with no driver key, as made before 0.8.1, still accepts anyone; nobody can invite to it or take it over', async (t) => {
  const w = await agentWorld(t);
  const sid = await oneOff(w);
  assert.equal(w.sessionFor(sid).ctx.values.has('driver'), false);
  for (const who of [TECH, LEAD, BOSS]) assert.equal((await w.tool(who, 'run', { session_id: sid, command: 'x' })).error, 'agent not attached', who);
  assert.match((await part(w, BOSS, sid, 'invite', TECH)).error, /^not_driver: this session has no driver/);
  assert.match((await hand(w, BOSS, sid, 'take_over')).error, /^not_driver: /);
  assert.match((await part(w, TECH, sid, 'join')).error, /^not_driver: /);
  assert.equal(Object.hasOwn(await w.tool(TECH, 'session_status', { session_id: sid }), 'driver'), false);
});

test('control of a one-off session moves by invite, offer and accept; the PC is never told who drives', async (t) => {
  const w = await agentWorld(t);
  await addTech2(w);
  const l = await link(w, TECH);
  assert.equal(Object.hasOwn(l.welcome, 'driver'), false, 'the welcome');
  assert.deepEqual((await poll(w, l)).body, { type: 'idle' });
  // TECH2 holds no "connect without asking": a one-off session counts as approved once attached, so that is not asked.
  assert.deepEqual(rows((await part(w, TECH, l.sid, 'invite', TECH2)).participants), [`${TECH}:driver`, `${TECH2}:invited`]);
  assert.deepEqual(rows((await part(w, TECH2, l.sid, 'join')).participants), [`${TECH}:driver`, `${TECH2}:watcher`]);
  // Not the driver, so no commands, and no offer.
  assert.match((await w.tool(TECH2, 'run', { session_id: l.sid, command: 'x' })).error, /is driving this session/);
  assert.match((await hand(w, TECH2, l.sid, 'offer', TECH)).error, /^not_driver: /);
  const offered = await hand(w, TECH, l.sid, 'offer', TECH2);
  assert.deepEqual(offered.offer, { to: TECH2, by: TECH, expires_at: w.now() + 120_000 });
  const moved = await hand(w, TECH2, l.sid, 'accept');
  assert.deepEqual([moved.driver, moved.offer], [TECH2, null]);
  assert.deepEqual(rows(moved.participants), [`${TECH2}:driver`, `${TECH}:watcher`]);
  assert.deepEqual(await kinds(w), ['session_handed_over']);
  const log = (await w.log()).find((r) => r.kind === 'session_handed_over');
  assert.equal(log.actor, TECH2);
  assert.equal(log.detail, `${l.sid.slice(0, 8)} from ${TECH} to ${TECH2}`);
  // The commands follow; the old driver is refused with the new one's name.
  assert.match((await w.tool(TECH, 'run', { session_id: l.sid, command: 'x' })).error, new RegExp(`${TECH2} is driving`));
  assert.equal(w.sessionFor(l.sid).ctx.values.get('driver'), TECH2);
  // The PC saw nothing of it.
  assert.deepEqual((await poll(w, l)).body, { type: 'idle' });
  const sent = w.tool(TECH2, 'run', { session_id: l.sid, command: 'whoami' });
  let frame = null;
  for (let i = 0; i < 80 && !frame; i++) {
    await new Promise((r) => setImmediate(r));
    const got = await w.agent(l.sid, null, { type: 'poll', generation: l.generation, busy_lanes: ['screen'] }, { 'x-attach-key': l.key });
    if (got.body.type === 'run') frame = got.body;
  }
  assert.ok(frame && !('driver' in frame), 'a command frame carries no driver');
  await w.agent(l.sid, null, { type: 'result', generation: l.generation, id: frame.id, ok: true, exit_code: 0, stdout_b64: '', stderr_b64: '' }, { 'x-attach-key': l.key });
  await sent;
  assert.ok(!JSON.stringify([...w.sessionCalls.filter((c) => c.path === '/agent').map((c) => c.body)]).includes(TECH2));
  // A reattach (a second hello) is told no driver either.
  const again = await w.agent(l.sid, null, { type: 'hello', machine: 'M2', user: 'sam', control: 'full', caps: ['screen', 'lanes'] }, { 'x-attach-key': l.key });
  assert.equal(Object.hasOwn(again.body, 'driver'), false);
  // Handing it back works the same way.
  await hand(w, TECH2, l.sid, 'offer', TECH);
  assert.equal((await hand(w, TECH, l.sid, 'accept')).driver, TECH);
});

test('an admin or anyone allowed to connect without asking takes a one-off session over; a technician without it cannot', async (t) => {
  const w = await agentWorld(t);
  await addTech2(w);
  const l = await link(w, TECH);
  assert.match((await hand(w, TECH2, l.sid, 'take_over')).error, /^needs_unattended: taking over needs sessions\.unattended/);
  assert.match((await hand(w, VIEW, l.sid, 'take_over')).error, /^permission_denied|your role does not allow/);
  assert.equal((await w.tool(TECH, 'session_status', { session_id: l.sid })).driver, TECH);
  const taken = await hand(w, BOSS, l.sid, 'take_over');
  assert.equal(taken.driver, BOSS);
  assert.deepEqual(rows(taken.participants), [`${BOSS}:driver`, `${TECH}:watcher`]);
  assert.deepEqual(await kinds(w), ['session_taken_over']);
  assert.match((await w.tool(TECH, 'run', { session_id: l.sid, command: 'x' })).error, new RegExp(`${BOSS} is driving`));
  // The permission to connect without asking is enough; and taking over what you drive changes nothing.
  assert.equal((await hand(w, LEAD, l.sid, 'take_over')).driver, LEAD);
  assert.equal((await hand(w, LEAD, l.sid, 'take_over')).driver, LEAD);
  assert.deepEqual(await kinds(w), ['session_taken_over', 'session_taken_over']);
  // A take-over is not a handover: nothing recorded for the built-in agent to read as one.
  assert.equal((await call(w, l.sid, '/watch?workspace=default', undefined, { method: 'GET' })).handed_over, null);
  // A saved PC's take-over is device_connect.
  const pc = await w.addPc({ access: 'any' });
  const { sid } = await w.attach(pc, TECH);
  assert.match((await hand(w, BOSS, sid, 'take_over')).error, /^bad_request: take_over here is for one-off link sessions/);
});

test('a one-off session is not handed over, claimed or taken over before the PC has run the link', async (t) => {
  const w = await agentWorld(t);
  await addTech2(w);
  const made = await w.tool(TECH, 'session_create', {});
  assert.match((await hand(w, BOSS, made.session_id, 'take_over')).error, /^not_attached: /);
  await part(w, TECH, made.session_id, 'invite', TECH2);
  await part(w, TECH2, made.session_id, 'join');
  await hand(w, TECH, made.session_id, 'offer', TECH2);
  assert.match((await hand(w, TECH2, made.session_id, 'accept')).error, /^not_attached: /);
  assert.equal((await w.tool(TECH, 'session_status', { session_id: made.session_id })).driver, TECH);
});

test('only a person who controls sessions and is a member can be invited to a one-off session; a Viewer and open mode cannot join', async (t) => {
  const w = await agentWorld(t);
  const l = await link(w, TECH);
  assert.match((await part(w, TECH, l.sid, 'invite', VIEW)).error, /^cannot_control: /);
  assert.match((await part(w, VIEW, l.sid, 'join')).error, /your role does not allow sessions\.control/);
  assert.match((await part(w, 'stranger@example.com', l.sid, 'join')).error, /not a member of this team/);
});
