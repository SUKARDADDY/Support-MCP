// The Session object's side of invites, handover and the watcher's picture: who is on a session,
// the offer of control, the three steps of moving it, the one-off driver, and the picture held in
// memory. These call the object's own routes; the tools and the team rules around them are in
// participants.test.js and handover.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentWorld, BOSS, TECH, VIEW, LEAD, shot, until } from './agent-world.js';
import { Session } from '../src/session.js';
import { appHello, attached, call, oneOff } from './people-world.js';

const JPEG = '/9j/4AAQ';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAA';

const people = (w, sid, body) => call(w, sid, '/people', body);
const handover = (w, sid, body) => call(w, sid, '/handover', body);
const status = (w, sid) => call(w, sid, '/status?workspace=default&log_tail=50', undefined, { method: 'GET' });
const watch = (w, sid) => call(w, sid, '/watch?workspace=default', undefined, { method: 'GET' });
const roles = (list) => list.map((p) => `${p.identity}:${p.role}`);

// ---- the one-off driver --------------------------------------------------------------------
test('a one-off session made with a driver keeps it in storage, shows it in status and watch, and refuses everyone else\'s command', async (t) => {
  const w = await agentWorld(t);
  const sid = await oneOff(w, { driver: TECH });
  assert.equal(w.sessionFor(sid).ctx.values.get('driver'), TECH);
  assert.equal((await status(w, sid)).driver, TECH);
  assert.equal((await watch(w, sid)).driver, TECH);
  assert.equal((await watch(w, sid)).device_id, null);
  const refused = await call(w, sid, '/command', { op: 'run', command: 'x', actor: BOSS });
  assert.equal(refused.ok, false);
  assert.match(refused.error, new RegExp(`${TECH} is driving this session`));
  assert.match(refused.error, /session_handover/);
  assert.doesNotMatch(refused.error, /device_connect/, 'a one-off session has no device_connect');
  // The driver's command passes the driver check (nothing is attached yet, which is the next refusal).
  assert.equal((await call(w, sid, '/command', { op: 'run', command: 'x', actor: TECH })).error, 'agent not attached');
  assert.deepEqual((await watch(w, sid)).actors.map((a) => a.actor), [TECH], 'a refused command is not an actor');
});

test('a one-off session whose storage has no driver key keeps today\'s open behaviour, with no created_by fallback', async (t) => {
  const w = await agentWorld(t);
  const sid = await oneOff(w); // made by BOSS, no driver named: the shape a session made before 0.8.1 has
  const values = w.sessionFor(sid).ctx.values;
  assert.equal(values.has('driver'), false);
  assert.equal(values.get('created_by'), BOSS, 'the creator is on record, and is not used');
  // A fresh object over the same storage, as after an eviction.
  w.sessions.get(sid).session = new Session(w.sessions.get(sid).ctx, w.env);
  for (const who of [TECH, BOSS, LEAD]) {
    assert.equal((await call(w, sid, '/command', { op: 'run', command: 'x', actor: who })).error, 'agent not attached', who);
  }
  const s = await status(w, sid);
  assert.equal(Object.hasOwn(s, 'driver'), false);
  assert.equal((await watch(w, sid)).driver, null);
  assert.deepEqual(s.participants, []);
  // Nobody drives, so nobody can invite, offer or take over.
  assert.equal((await people(w, sid, { action: 'invite', actor: BOSS, identity: TECH })).code, 'not_driver');
});

test('a one-off PC\'s poll answers and welcome never carry the driver; a saved PC\'s do', async (t) => {
  const w = await agentWorld(t);
  const sid = await oneOff(w, { driver: TECH });
  const { key, hello } = await appHello(w, sid);
  assert.equal(hello.status, 200, JSON.stringify(hello.body));
  assert.equal(Object.hasOwn(hello.body, 'driver'), false, 'the welcome');
  const headers = { 'x-attach-key': key };
  const idle = await w.agent(sid, null, { type: 'poll', generation: hello.body.generation, busy_lanes: ['cmd', 'screen'] }, headers);
  assert.deepEqual(idle.body, { type: 'idle' });
  // A command frame sent to the PC carries no driver either.
  const sent = w.tool(TECH, 'run', { session_id: sid, command: 'whoami' });
  let frame = null;
  for (let i = 0; i < 50 && !frame; i++) {
    await new Promise((r) => setImmediate(r));
    const got = await w.agent(sid, null, { type: 'poll', generation: hello.body.generation, busy_lanes: ['screen'] }, headers);
    if (got.body.type === 'run') frame = got.body;
  }
  assert.ok(frame, 'the PC got the command');
  assert.equal(Object.hasOwn(frame, 'driver'), false);
  await w.agent(sid, null, { type: 'result', generation: hello.body.generation, id: frame.id, ok: true, exit_code: 0, stdout_b64: '', stderr_b64: '' }, headers);
  await sent;
  assert.equal(JSON.stringify([...w.sessionFor(sid).ctx.values]).includes(TECH), true, 'the driver is in the session\'s own storage');
  // The same on a saved PC: its welcome and its polls name the driver.
  const { sid: pcSid, pc, generation } = await attached(w);
  const poll = await w.agent(pcSid, pc.key, { type: 'poll', generation, busy_lanes: ['cmd', 'screen'] });
  assert.equal(poll.body.driver, TECH);
});

// ---- who is on the session -----------------------------------------------------------------
test('the driver invites, an invited person joins as a watcher, and a watcher leaves; the roster names each role', async (t) => {
  const w = await agentWorld(t);
  const { sid } = await attached(w);
  const invited = await people(w, sid, { action: 'invite', actor: TECH, identity: LEAD });
  assert.equal(invited.ok, true);
  assert.deepEqual(roles(invited.participants), [`${TECH}:driver`, `${LEAD}:invited`]);
  assert.equal(invited.changed, true);
  assert.equal(invited.since, w.now());
  // Inviting again changes nothing and keeps the first time.
  w.advance(1000);
  const again = await people(w, sid, { action: 'invite', actor: TECH, identity: LEAD });
  assert.deepEqual([again.changed, again.since], [false, invited.since]);
  assert.deepEqual(roles((await people(w, sid, { action: 'join', actor: LEAD })).participants), [`${TECH}:driver`, `${LEAD}:watcher`]);
  assert.deepEqual((await status(w, sid)).participants.map((p) => p.role), ['driver', 'watcher']);
  assert.deepEqual(roles((await people(w, sid, { action: 'leave', actor: LEAD })).participants), [`${TECH}:driver`]);
  // The log names who did what, never more.
  const log = (await status(w, sid)).log.map((r) => r.kind);
  assert.deepEqual(['invited', 'joined', 'left'].filter((k) => log.includes(k)), ['invited', 'joined', 'left']);
});

test('only the driver invites and removes; only an invited person joins; the driver cannot leave', async (t) => {
  const w = await agentWorld(t);
  const { sid } = await attached(w);
  for (const action of ['invite', 'remove']) {
    assert.equal((await people(w, sid, { action, actor: LEAD, identity: BOSS })).code, 'not_driver', action);
  }
  assert.equal((await people(w, sid, { action: 'join', actor: LEAD })).code, 'not_invited');
  assert.equal((await people(w, sid, { action: 'leave', actor: LEAD })).code, 'not_invited');
  assert.equal((await people(w, sid, { action: 'leave', actor: TECH })).code, 'not_invited', 'the driver');
  assert.equal((await people(w, sid, { action: 'invite', actor: TECH, identity: TECH })).code, 'bad_request');
  assert.equal((await people(w, sid, { action: 'invite', actor: TECH })).code, 'bad_request');
  assert.equal((await people(w, sid, { action: 'remove', actor: TECH, identity: LEAD })).code, 'not_invited');
  assert.equal((await people(w, sid, { action: 'nope', actor: TECH, identity: LEAD })).code, 'bad_request');
  // The driver joining their own session is a no-op.
  assert.deepEqual(roles((await people(w, sid, { action: 'join', actor: TECH })).participants), [`${TECH}:driver`]);
  // Remove takes an invited person and a watcher off, and an offer made to them.
  await people(w, sid, { action: 'invite', actor: TECH, identity: LEAD });
  await people(w, sid, { action: 'join', actor: LEAD });
  await handover(w, sid, { op: 'offer', actor: TECH, to: LEAD });
  assert.equal((await status(w, sid)).offer.to, LEAD);
  const removed = await people(w, sid, { action: 'remove', actor: TECH, identity: LEAD });
  assert.deepEqual(roles(removed.participants), [`${TECH}:driver`]);
  assert.equal((await status(w, sid)).offer, null, 'the offer went with them');
  assert.equal((await people(w, sid, { action: 'join', actor: LEAD })).code, 'not_invited');
});

test('a session holds at most 20 people besides its driver', async (t) => {
  const w = await agentWorld(t);
  const { sid } = await attached(w);
  for (let i = 0; i < 20; i++) assert.equal((await people(w, sid, { action: 'invite', actor: TECH, identity: `p${i}@example.com` })).ok, true);
  const over = await people(w, sid, { action: 'invite', actor: TECH, identity: 'p20@example.com' });
  assert.equal(over.code, 'bad_request');
  assert.match(over.error, /at most 20/);
});

test('another workspace and an ended session answer as a session that does not exist, for every route', async (t) => {
  const w = await agentWorld(t);
  const { sid } = await attached(w);
  const bodies = [
    ['/people', { action: 'invite', actor: TECH, identity: LEAD }],
    ['/handover', { op: 'offer', actor: TECH, to: LEAD }],
    ['/handover', { op: 'complete', actor: LEAD, from: TECH }],
  ];
  for (const [path, body] of bodies) {
    const other = await call(w, sid, path, { ...body, workspace: 'acme' });
    const missing = await call(w, 'f'.repeat(64), path, { ...body, workspace: 'acme' });
    assert.deepEqual(other, { ok: false, code: 'not_found', error: 'no such live session' }, path);
    assert.deepEqual(other, missing);
  }
  const frameOther = await call(w, sid, '/frame?workspace=acme&actor=' + TECH, undefined, { method: 'GET' });
  assert.equal(frameOther.code, 'not_found');
  assert.deepEqual(await call(w, sid, '/status?workspace=acme&log_tail=0', undefined, { method: 'GET' }), await call(w, 'e'.repeat(64), '/status?workspace=acme&log_tail=0', undefined, { method: 'GET' }));
  await call(w, sid, '/end', { actor: TECH });
  assert.equal((await people(w, sid, { action: 'invite', actor: TECH, identity: LEAD })).code, 'not_found');
  assert.equal((await handover(w, sid, { op: 'offer', actor: TECH, to: LEAD })).code, 'not_found');
});

// ---- the offer and the three steps --------------------------------------------------------------
async function watching(w, sid, who) {
  await people(w, sid, { action: 'invite', actor: TECH, identity: who });
  await people(w, sid, { action: 'join', actor: who });
}

test('an offer goes to a watcher, lasts 2 minutes, is answered by its target and cancelled by the driver', async (t) => {
  const w = await agentWorld(t);
  const { sid } = await attached(w);
  await people(w, sid, { action: 'invite', actor: TECH, identity: LEAD });
  // Not joined yet: no offer.
  assert.equal((await handover(w, sid, { op: 'offer', actor: TECH, to: LEAD })).code, 'not_invited');
  await people(w, sid, { action: 'join', actor: LEAD });
  assert.equal((await handover(w, sid, { op: 'offer', actor: LEAD, to: BOSS })).code, 'not_driver');
  assert.equal((await handover(w, sid, { op: 'offer', actor: TECH, to: TECH })).code, 'bad_request');
  const offered = await handover(w, sid, { op: 'offer', actor: TECH, to: LEAD });
  assert.deepEqual(offered.offer, { to: LEAD, by: TECH, expires_at: w.now() + 120_000 });
  // One at a time.
  await watching(w, sid, BOSS);
  assert.equal((await handover(w, sid, { op: 'offer', actor: TECH, to: BOSS })).code, 'offer_pending');
  // The same offer again is the same offer.
  assert.equal((await handover(w, sid, { op: 'offer', actor: TECH, to: LEAD })).changed, false);
  // Only its target declines, and only the driver cancels.
  assert.equal((await handover(w, sid, { op: 'decline', actor: BOSS })).code, 'not_offered_to_you');
  assert.equal((await handover(w, sid, { op: 'cancel', actor: LEAD })).code, 'not_driver');
  assert.equal((await handover(w, sid, { op: 'cancel', actor: TECH })).offer, null);
  assert.equal((await handover(w, sid, { op: 'cancel', actor: TECH })).code, 'no_offer');
  assert.equal((await handover(w, sid, { op: 'decline', actor: LEAD })).code, 'no_offer');
  await handover(w, sid, { op: 'offer', actor: TECH, to: LEAD });
  assert.equal((await handover(w, sid, { op: 'decline', actor: LEAD })).offer, null);
  // After 2 minutes an offer is gone: it cannot be accepted and a new one can be made.
  await handover(w, sid, { op: 'offer', actor: TECH, to: LEAD });
  w.advance(120_000);
  assert.equal((await status(w, sid)).offer, null);
  assert.equal((await handover(w, sid, { op: 'accepting', actor: LEAD })).code, 'no_offer');
  assert.equal((await handover(w, sid, { op: 'offer', actor: TECH, to: BOSS })).ok, true);
});

test('accepting reserves the session, complete moves control once and again changes nothing, and the old driver watches', async (t) => {
  const w = await agentWorld(t);
  const { sid, pc, generation } = await attached(w);
  await watching(w, sid, LEAD);
  await handover(w, sid, { op: 'offer', actor: TECH, to: LEAD });
  assert.equal((await handover(w, sid, { op: 'accepting', actor: BOSS })).code, 'not_offered_to_you');
  const mark = await handover(w, sid, { op: 'accepting', actor: LEAD });
  assert.deepEqual([mark.ok, mark.from, mark.device_id], [true, TECH, pc.id]);
  // The reservation holds the session: nobody else accepts, the offer cannot be cancelled or declined.
  assert.equal((await handover(w, sid, { op: 'accepting', actor: BOSS })).code, 'busy');
  assert.equal((await handover(w, sid, { op: 'cancel', actor: TECH })).code, 'no_offer');
  assert.equal((await handover(w, sid, { op: 'decline', actor: LEAD })).code, 'no_offer');
  assert.equal((await handover(w, sid, { op: 'offer', actor: TECH, to: LEAD })).code, 'busy', 'no new offer while one is accepted');
  // Still the old driver until complete.
  assert.equal((await watch(w, sid)).driver, TECH);
  // The parked poll of a saved PC is answered at once when control moves.
  const parked = w.agent(sid, pc.key, { type: 'poll', generation, busy_lanes: [] });
  await until(() => w.sessionFor(sid).session.httpPoll);
  const done = await handover(w, sid, { op: 'complete', actor: LEAD, from: TECH, kind: 'accept' });
  assert.deepEqual([done.ok, done.changed, done.driver, done.offer], [true, true, LEAD, null]);
  assert.deepEqual(roles(done.participants), [`${LEAD}:driver`, `${TECH}:watcher`]);
  assert.equal((await parked).body.type, 'idle');
  assert.equal((await w.agent(sid, pc.key, { type: 'poll', generation, busy_lanes: ['cmd', 'screen'] })).body.driver, LEAD, 'the PC is told');
  const handed = (await watch(w, sid)).handed_over;
  assert.deepEqual([handed.from, handed.to, handed.at], [TECH, LEAD, w.now()]);
  // Again: nothing changes.
  const repeat = await handover(w, sid, { op: 'complete', actor: LEAD, from: TECH, kind: 'accept' });
  assert.deepEqual([repeat.ok, repeat.changed, repeat.driver], [true, false, LEAD]);
  assert.deepEqual((await watch(w, sid)).handed_over, handed);
  // The commands follow the driver.
  assert.match((await call(w, sid, '/command', { op: 'run', command: 'x', actor: TECH })).error, new RegExp(`${LEAD} is driving`));
  assert.equal((await call(w, sid, '/command', { op: 'nothing', actor: LEAD })).error, 'bad op', 'the new driver is past the driver check');
});

test('complete applies only in the generation the move began from, also when the same person drives again', async (t) => {
  const w = await agentWorld(t);
  const { sid } = await attached(w);
  await watching(w, sid, LEAD);
  await handover(w, sid, { op: 'offer', actor: TECH, to: LEAD });
  const mark = await handover(w, sid, { op: 'accepting', actor: LEAD });
  assert.equal(mark.gen, 0);
  // TECH, who drives, takes the session over from themselves (a new generation, the same name).
  const took = await call(w, sid, '/takeover', { actor: TECH, gen: 1 });
  assert.deepEqual([took.ok, took.driver], [true, TECH]);
  assert.equal((await watch(w, sid)).gen, 1);
  assert.equal((await watch(w, sid)).offer, null, 'the pending offer and its reservation are void');
  assert.equal((await handover(w, sid, { op: 'complete', actor: LEAD, from: TECH, kind: 'accept', from_gen: 0, gen: 1 })).code, 'not_driver');
  assert.equal((await watch(w, sid)).driver, TECH);
  // A late delivery of an older take-over changes nothing.
  await call(w, sid, '/takeover', { actor: LEAD, gen: 1 });
  assert.equal((await watch(w, sid)).driver, TECH);
  // The current generation applies once, and a repeat changes nothing.
  assert.equal((await handover(w, sid, { op: 'complete', actor: LEAD, from: TECH, kind: 'accept', from_gen: 1, gen: 2 })).driver, LEAD);
  assert.deepEqual([(await watch(w, sid)).driver, (await watch(w, sid)).gen], [LEAD, 2]);
  assert.equal((await handover(w, sid, { op: 'complete', actor: LEAD, from: TECH, kind: 'accept', from_gen: 1, gen: 2 })).changed, false);
});

test('a take-over by the person who drives already, with an offer open, logs that the offer ended, and sends no notice', async (t) => {
  const w = await agentWorld(t);
  const { sid } = await attached(w);
  await watching(w, sid, LEAD);
  await handover(w, sid, { op: 'offer', actor: TECH, to: LEAD });
  const notices = w.sql('SELECT COUNT(*) AS n FROM notifications')[0].n;
  assert.equal((await call(w, sid, '/takeover', { actor: TECH, gen: 1 })).ok, true);
  const rows = (await status(w, sid)).log.map((r) => r.kind);
  assert.ok(rows.includes('offer cancelled'), rows.join(','));
  assert.equal(rows.filter((k) => k === 'offer cancelled').length, 1);
  assert.equal(w.sql('SELECT COUNT(*) AS n FROM notifications')[0].n, notices);
  // With no offer open, a same-person take-over writes no such row.
  const before = (await status(w, sid)).log.length;
  await call(w, sid, '/takeover', { actor: TECH, gen: 2 });
  assert.equal((await status(w, sid)).log.filter((r) => r.kind === 'offer cancelled').length, 1);
  assert.equal((await status(w, sid)).log.length, before);
});

test('complete stops when someone else drives now: a take-over that landed in between stands', async (t) => {
  const w = await agentWorld(t);
  const { sid } = await attached(w);
  await watching(w, sid, LEAD);
  await handover(w, sid, { op: 'offer', actor: TECH, to: LEAD });
  await handover(w, sid, { op: 'accepting', actor: LEAD });
  // BOSS takes over (the saved-PC take-over route).
  assert.equal((await call(w, sid, '/takeover', { actor: BOSS })).ok, true);
  const late = await handover(w, sid, { op: 'complete', actor: LEAD, from: TECH, kind: 'accept' });
  assert.equal(late.code, 'not_driver');
  assert.match(late.error, new RegExp(`${BOSS} is driving`));
  assert.equal((await watch(w, sid)).driver, BOSS);
  // The take-over cleared the offer and the reservation, and did not record a handover.
  const after = await watch(w, sid);
  assert.deepEqual([after.offer, after.handed_over], [null, null]);
  assert.deepEqual(roles(after.participants).sort(), [`${BOSS}:driver`, `${LEAD}:watcher`, `${TECH}:watcher`].sort());
});

test('a claim reserves for the escalated driver only, a take-over of a one-off session names no from, and neither moves control without attach', async (t) => {
  const w = await agentWorld(t);
  const { sid } = await attached(w);
  assert.equal((await handover(w, sid, { op: 'accepting', actor: LEAD, claim: { expect_driver: BOSS } })).code, 'not_driver');
  assert.equal((await handover(w, sid, { op: 'accepting', actor: LEAD, claim: { expect_driver: TECH } })).ok, true);
  assert.equal((await handover(w, sid, { op: 'accepting', actor: BOSS, claim: { expect_driver: TECH } })).code, 'already_claimed');
  // A reservation is released by its owner, and lapses after 30 seconds.
  await handover(w, sid, { op: 'release', actor: BOSS });
  assert.equal((await handover(w, sid, { op: 'accepting', actor: BOSS, claim: { expect_driver: TECH } })).code, 'already_claimed', 'only the owner releases');
  w.advance(30_000);
  assert.equal((await handover(w, sid, { op: 'accepting', actor: BOSS, claim: { expect_driver: TECH } })).ok, true);
  await handover(w, sid, { op: 'release', actor: BOSS });
  // The claimer completes: control moves to them, with kind claim recorded.
  await handover(w, sid, { op: 'accepting', actor: LEAD, claim: { expect_driver: TECH } });
  assert.equal((await handover(w, sid, { op: 'complete', actor: LEAD, from: TECH, kind: 'claim' })).driver, LEAD);
  // A session that is not attached gives no control: waiting saved PC.
  const pc2 = await w.addPc({ access: 'any', name: 'Two' });
  const waiting = (await w.tool(TECH, 'device_connect', { device_id: pc2.id })).session_id;
  assert.equal(w.stateOf(waiting), 'waiting');
  assert.equal((await handover(w, waiting, { op: 'accepting', actor: LEAD, claim: { expect_driver: TECH } })).code, 'not_attached');

  // A one-off session: a take-over has no from, and sets the driver whoever it was.
  const link = await oneOff(w, { driver: TECH });
  const t1 = await handover(w, link, { op: 'complete', actor: BOSS, kind: 'take_over' });
  assert.deepEqual([t1.ok, t1.driver], [true, BOSS]);
  assert.equal((await watch(w, link)).handed_over, null, 'a take-over is not a handover');
  assert.deepEqual(roles(t1.participants), [`${BOSS}:driver`, `${TECH}:watcher`]);
  // A session with no driver cannot be taken over, and a complete from a stale `from` stops.
  const open = await oneOff(w);
  assert.equal((await handover(w, open, { op: 'complete', actor: BOSS, kind: 'take_over' })).code, 'not_driver');
  assert.equal((await handover(w, link, { op: 'complete', actor: LEAD, from: TECH, kind: 'accept' })).code, 'not_driver');
});

// ---- the picture --------------------------------------------------------------------------------
// The PC answers each screen frame with the next picture in its list; a zoom gets its own.
function screens(list) {
  let n = 0;
  return (frame) => {
    if (frame.type !== 'screen') return null;
    if (frame.action.name === 'zoom') return shot({ image_b64: PNG, mime: 'image/png', width: 100, height: 60 });
    return shot({ image_b64: list[Math.min(n++, list.length - 1)] });
  };
}

test('the session holds the last full screenshot in memory with a rev that grows, and a zoom never replaces it', async (t) => {
  const w = await agentWorld(t);
  const pc = await w.addPc({ access: 'any', name: 'Till' });
  const { sid, welcome } = await w.attach(pc, TECH);
  const a = `${JPEG}AAAAAAAA`;
  const b = `${JPEG}BBBBBBBB`;
  const p = w.pump({ sid, key: pc.key, generation: welcome.body.generation, handler: screens([a, b, b]) });
  t.after(() => p.stop());
  const frame = async (actor = TECH) => call(w, sid, `/frame?workspace=default&actor=${encodeURIComponent(actor)}`, undefined, { method: 'GET' });
  assert.equal((await frame()).code, 'no_frame');
  assert.deepEqual([(await status(w, sid)).frame_rev, (await status(w, sid)).frame_at], [null, null]);

  const at1 = w.now();
  await w.tool(TECH, 'screenshot', { session_id: sid });
  const one = await frame();
  assert.deepEqual([one.data, one.mime, one.at], [a, 'image/jpeg', at1]);
  assert.equal(Number.isInteger(one.rev), true);
  assert.deepEqual([(await status(w, sid)).frame_rev, (await status(w, sid)).frame_at], [one.rev, at1]);

  // A zoom is a piece of the screen: the picture and its rev stay.
  await w.tool(TECH, 'zoom', { session_id: sid, x1: 0, y1: 0, x2: 10, y2: 10 });
  assert.deepEqual([(await frame()).data, (await frame()).rev], [a, one.rev]);
  // An input action's own screenshot is a full one: it replaces the picture and moves the rev.
  w.advance(5000);
  await w.tool(TECH, 'click', { session_id: sid, x: 5, y: 5 });
  const two = await frame();
  assert.equal(two.data, b);
  assert.ok(two.rev > one.rev);
  // Even with the clock held still, the rev only grows.
  await w.tool(TECH, 'screenshot', { session_id: sid });
  assert.ok((await frame()).rev > two.rev);
  assert.equal(Object.keys(await frame()).sort().join(), 'at,data,mime,rev');
});

test('type_secret\'s picture is never kept, and nothing is kept for a result that is not a plain picture', async (t) => {
  const w = await agentWorld(t);
  const pc = await w.addPc({ access: 'any', name: 'Till' });
  const { sid, welcome } = await w.attach(pc, TECH);
  const p = w.pump({ sid, key: pc.key, generation: welcome.body.generation, handler: screens([`${JPEG}SECRETSCREEN`]) });
  t.after(() => p.stop());
  await w.tool(TECH, 'type_secret', { session_id: sid, text: 'hunter2-secret' });
  assert.equal(w.sessionFor(sid).session.frame, null);
  assert.equal((await status(w, sid)).frame_rev, null);
});

test('only the driver and a person who joined can read the picture; an invited person and a stranger cannot', async (t) => {
  const w = await agentWorld(t);
  const pc = await w.addPc({ access: 'any', name: 'Till' });
  const { sid, welcome } = await w.attach(pc, TECH);
  const p = w.pump({ sid, key: pc.key, generation: welcome.body.generation, handler: screens([`${JPEG}AAAAAAAA`]) });
  t.after(() => p.stop());
  await w.tool(TECH, 'screenshot', { session_id: sid });
  const frame = (actor) => call(w, sid, `/frame?workspace=default&actor=${encodeURIComponent(actor)}`, undefined, { method: 'GET' });
  assert.equal((await frame(TECH)).data, `${JPEG}AAAAAAAA`);
  await people(w, sid, { action: 'invite', actor: TECH, identity: LEAD });
  for (const who of [LEAD, BOSS, VIEW, '']) assert.equal((await frame(who)).code, 'not_invited', `${who || 'nobody'}`);
  await people(w, sid, { action: 'join', actor: LEAD });
  assert.equal((await frame(LEAD)).data, `${JPEG}AAAAAAAA`);
  // Removed, they lose it.
  await people(w, sid, { action: 'remove', actor: TECH, identity: LEAD });
  assert.equal((await frame(LEAD)).code, 'not_invited');
});

test('the picture is gone when the session ends, and after the object is evicted until the next screenshot; storage never holds it', async (t) => {
  const w = await agentWorld(t);
  const pc = await w.addPc({ access: 'any', name: 'Till' });
  const { sid, welcome } = await w.attach(pc, TECH);
  const full = `${JPEG}QUJDREVGR0hJSktMTU5PUAAA`;
  const p = w.pump({ sid, key: pc.key, generation: welcome.body.generation, handler: screens([full]) });
  t.after(() => p.stop());
  await w.tool(TECH, 'screenshot', { session_id: sid });
  const frame = () => call(w, sid, `/frame?workspace=default&actor=${TECH}`, undefined, { method: 'GET' });
  assert.equal((await frame()).data, full);
  const needle = full.slice(4);
  const stored = () => JSON.stringify([...w.sessionFor(sid).ctx.values, w.sessionFor(sid).ctx.logs]);
  assert.equal(stored().includes(needle), false, 'not in the object\'s storage');
  assert.equal(JSON.stringify(w.db.seen).includes(needle), false, 'not in D1');
  const rev = (await frame()).rev;
  // Evicted: the same storage, a new object, no picture; a new screenshot brings one, with a rev that is not smaller.
  const entry = w.sessions.get(sid);
  entry.session = new Session(entry.ctx, w.env);
  assert.equal((await frame()).code, 'no_frame');
  assert.equal((await status(w, sid)).frame_rev, null);
  await p.stop();
  const p2 = w.pump({ sid, key: pc.key, generation: welcome.body.generation, handler: screens([full]) });
  t.after(() => p2.stop());
  w.advance(1000);
  await w.tool(TECH, 'screenshot', { session_id: sid });
  assert.ok((await frame()).rev > rev);
  // Ended: dropped, and a late result does not bring it back.
  await call(w, sid, '/end', { actor: TECH });
  assert.equal(entry.session.frame, null);
  assert.equal((await frame()).code, 'not_found');
  entry.session.holdFrame({ name: 'screenshot' }, { ok: true, image_b64: full, mime: 'image/jpeg' });
  assert.equal(entry.session.frame, null);
  assert.equal(stored().includes(needle), false);
});

test('status gains participants, offer, frame_rev and frame_at without losing a field', async (t) => {
  const w = await agentWorld(t);
  const { sid } = await attached(w);
  const s = await status(w, sid);
  for (const k of ['state', 'machine', 'user', 'windows_mode', 'elevated', 'control', 'caps', 'client_version', 'expires_at', 'device_id', 'driver', 'ended_reason', 'attached', 'log']) {
    assert.ok(Object.hasOwn(s, k), k);
  }
  assert.deepEqual([s.participants.map((p) => p.role), s.offer, s.frame_rev, s.frame_at], [['driver'], null, null, null]);
});
