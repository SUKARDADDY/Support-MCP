// Handover on a saved PC and the one rule behind watching and driving: who may join, see the picture, accept an offer
// and take control (control of sessions and its second factor; on a PC whose owner was never asked, also the permission to
// connect without asking and its factor; control moves only while attached), and the three steps that move
// control: the Session marks the accept, one guarded change moves the PC's pointer, the Session sets its driver.
// One-off link sessions are in link-handover.test.js, the queue's claim in escalations.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentWorld, BOSS, TECH, VIEW, LEAD } from './agent-world.js';
import { TECH2, addTech2, attached, call } from './people-world.js';
import { sessionPeople } from '../src/session-people.js';
import { teamStore } from '../src/workspace.js';

const NO_FACTOR = { factor: async (permission) => { throw new Error(`${permission} needs the authenticator your grant was made with`); } };
const NO_UNATTENDED_FACTOR = { factor: async (permission) => { if (permission === 'sessions.unattended') throw new Error('sessions.unattended needs your authenticator'); } };

// The error code of a refused call, or 'ok'.
async function code(promise) {
  try {
    await promise;
    return 'ok';
  } catch (e) {
    if (!e.code) throw e;
    return e.code;
  }
}

// Make calls to a Session's /handover fail or run something around them. op is the step ('accepting', 'complete', ...).
// before(n) runs before the nth call to reach the Session, after(n, answer) after it answered. times: how many calls throw.
function around(w, { op, before = null, after = null, times = 0 }) {
  const real = w.env.SESSION.get;
  const state = { calls: 0, thrown: 0 };
  w.env.SESSION.get = (id) => {
    const stub = real(id);
    return {
      fetch: async (u, init) => {
        const url = new URL(typeof u === 'string' ? u : u.url);
        let body = null;
        try { body = JSON.parse(init?.body); } catch (_) { /* not JSON */ }
        if (url.pathname !== '/handover' || body?.op !== op) return stub.fetch(u, init);
        state.calls += 1;
        await before?.(state.calls);
        if (state.thrown < times) {
          state.thrown += 1;
          throw new Error('the session is out of reach');
        }
        const r = await stub.fetch(u, init);
        await after?.(state.calls, r);
        return r;
      },
    };
  };
  return state;
}

// TECH drives a session that asked the person at the PC; TECH2 and the others are around it.
async function asked(w) {
  await addTech2(w);
  const s = await attached(w, TECH);
  assert.equal(w.pointer(s.pc.id).ask, true, 'a technician without sessions.unattended is asked at the PC');
  return { ...s, people: sessionPeople(w.env) };
}
// LEAD drives a session whose owner was never asked.
async function unasked(w) {
  await addTech2(w);
  const s = await attached(w, LEAD);
  assert.equal(w.pointer(s.pc.id).ask, false);
  return { ...s, people: sessionPeople(w.env) };
}
const part = (people, sid, who, action, identity) => people.participants('default', who, { session_id: sid, action, ...(identity ? { identity } : {}) });
const hand = (people, sid, who, action, identity, caps) => people.handover('default', who, { session_id: sid, action, ...(identity ? { identity } : {}) }, caps);
const notes = (w) => w.sql('SELECT recipient, event, device_id, session_id, title, body, dedupe FROM notifications ORDER BY id').map((r) => ({ ...r }));

// ---- the offer lifecycle ---------------------------------------------------------------------------
test('an offer lasts 2 minutes, only its target can accept or decline it, only the driver cancels, and they are told', async (t) => {
  const w = await agentWorld(t);
  const { sid, people } = await asked(w);
  await part(people, sid, TECH, 'invite', TECH2);
  await part(people, sid, TECH, 'invite', BOSS);
  await part(people, sid, TECH2, 'join');
  await part(people, sid, BOSS, 'join');
  const offered = await hand(people, sid, TECH, 'offer', TECH2);
  assert.deepEqual(offered.offer, { to: TECH2, by: TECH, expires_at: w.now() + 120_000 });
  assert.equal(offered.driver, TECH);
  assert.deepEqual(notes(w).filter((n) => n.event === 'control_offered').map((n) => [n.recipient, n.session_id, n.dedupe.startsWith(`offered:${sid}:${TECH2}:`)]), [[TECH2, sid, true]]);
  // Another watcher cannot take it, even an admin; a non-driver cannot cancel.
  assert.equal(await code(hand(people, sid, BOSS, 'accept')), 'not_offered_to_you');
  assert.equal(await code(hand(people, sid, BOSS, 'decline')), 'not_offered_to_you');
  assert.equal(await code(hand(people, sid, TECH2, 'cancel')), 'not_driver');
  assert.equal(await code(hand(people, sid, BOSS, 'offer', TECH2)), 'not_driver');
  assert.equal((await hand(people, sid, TECH, 'cancel')).offer, null);
  assert.equal(await code(hand(people, sid, TECH2, 'accept')), 'no_offer');
  // Declined by the target.
  await hand(people, sid, TECH, 'offer', TECH2);
  assert.equal((await hand(people, sid, TECH2, 'decline')).offer, null);
  // Two minutes later it is gone.
  await hand(people, sid, TECH, 'offer', TECH2);
  w.advance(120_000);
  assert.equal(await code(hand(people, sid, TECH2, 'accept')), 'no_offer');
  assert.equal((await w.tool(TECH, 'session_status', { session_id: sid })).offer, null);
  // Nobody moved: the driver is still TECH in the Session and on the PC.
  assert.equal((await call(w, sid, '/watch?workspace=default', undefined, { method: 'GET' })).driver, TECH);
});

test('an accepted offer: the new driver drives, the old one watches, the PC is told, and the team log has device_session_handed_over', async (t) => {
  const w = await agentWorld(t);
  const { sid, pc, generation, people } = await asked(w);
  await part(people, sid, TECH, 'invite', TECH2);
  await part(people, sid, TECH2, 'join');
  await hand(people, sid, TECH, 'offer', TECH2);
  const moved = await hand(people, sid, TECH2, 'accept');
  assert.deepEqual([moved.driver, moved.offer], [TECH2, null]);
  assert.deepEqual(moved.participants.map((p) => `${p.identity}:${p.role}`), [`${TECH2}:driver`, `${TECH}:watcher`]);
  // The PC's record, the Session and the PC itself agree.
  assert.equal(w.pointer(pc.id).by, TECH2);
  assert.equal((await call(w, sid, '/watch?workspace=default', undefined, { method: 'GET' })).driver, TECH2);
  assert.equal((await w.agent(sid, pc.key, { type: 'poll', generation, busy_lanes: ['cmd', 'screen'] }, {})).body.driver, TECH2);
  assert.equal((await w.hello(pc.key)).body.session.by, TECH2);
  // One more row in the team log, with names and ids only.
  const row = (await w.log()).filter((r) => r.kind === 'device_session_handed_over');
  assert.equal(row.length, 1);
  assert.equal(row[0].actor, TECH2);
  assert.match(row[0].detail, new RegExp(`^${pc.id} "Till" from ${TECH} to ${TECH2}$`));
  // The old driver's command is refused with the new driver's name; the new driver's passes.
  const refused = await w.tool(TECH, 'run', { session_id: sid, command: 'whoami' });
  assert.match(refused.error, new RegExp(`${TECH2} is driving this session`));
  // Accepting twice changes nothing and is not an error for the driver.
  assert.equal((await hand(people, sid, TECH2, 'accept')).driver, TECH2);
  assert.equal((await w.log()).filter((r) => r.kind === 'device_session_handed_over').length, 1);
  // The old driver can be offered it back and the same steps run the other way.
  await hand(people, sid, TECH2, 'offer', TECH);
  assert.equal((await hand(people, sid, TECH, 'accept')).driver, TECH);
  assert.equal(w.pointer(pc.id).by, TECH);
});

test('a person who has no offer, or is not on the session, cannot accept; the driver\'s own accept is a no-op', async (t) => {
  const w = await agentWorld(t);
  const { sid, people } = await asked(w);
  assert.equal(await code(hand(people, sid, TECH2, 'accept')), 'no_offer');
  assert.equal(await code(hand(people, sid, VIEW, 'accept')), 'cannot_control');
  assert.equal(await code(hand(people, sid, 'stranger@example.com', 'accept')), 'cannot_control');
  assert.equal((await hand(people, sid, TECH, 'accept')).driver, TECH);
  assert.equal(await code(hand(people, sid, TECH, 'offer', TECH)), 'bad_request');
  assert.equal(await code(hand(people, sid, TECH, 'offer', 'nobody@example.com')), 'not_invited', 'only a person who joined');
  assert.equal(await code(people.handover('default', TECH, { session_id: sid, action: 'nope' })), 'bad_request');
  assert.equal(await code(people.handover('default', TECH, { session_id: sid, action: 'offer' })), 'bad_request');
  assert.equal(await code(people.handover('default', TECH, { session_id: 'nope', action: 'cancel' })), 'bad_request');
});

// ---- the one rule ---------------------------------------------------------------------------------
test('on a session where the PC asked, a technician without "connect without asking" may join, see, and once attached drive', async (t) => {
  const w = await agentWorld(t);
  const { sid, pc, people } = await asked(w);
  // The invite checks the role: TECH2 holds sessions.control.
  assert.equal((await part(people, sid, TECH, 'invite', TECH2)).participants.length, 2);
  assert.equal((await part(people, sid, TECH2, 'join')).participants.find((p) => p.identity === TECH2).role, 'watcher');
  assert.equal((await people.frame('default', TECH2, sid, {}).catch((e) => e.code)), 'no_frame');
  await hand(people, sid, TECH, 'offer', TECH2);
  assert.equal((await hand(people, sid, TECH2, 'accept')).driver, TECH2);
  assert.equal(w.pointer(pc.id).ask, true, 'the pointer still says the owner was asked');
});

test('on a session the PC never asked about, a technician without "connect without asking" gets needs_unattended for invite, join, picture and accept; an admin passes', async (t) => {
  const w = await agentWorld(t);
  const { sid, people } = await unasked(w);
  // The invite names a target who lacks the permission.
  assert.equal(await code(part(people, sid, LEAD, 'invite', TECH2)), 'needs_unattended');
  assert.equal(await code(part(people, sid, LEAD, 'invite', BOSS)), 'ok', 'an admin holds every permission');
  // TECH2 cannot get in any other way.
  assert.equal(await code(part(people, sid, TECH2, 'join')), 'needs_unattended');
  assert.equal(await code(people.frame('default', TECH2, sid, {})), 'needs_unattended');
  assert.equal(await code(hand(people, sid, TECH2, 'accept')), 'needs_unattended');
  assert.equal((await part(people, sid, BOSS, 'join')).participants.find((p) => p.identity === BOSS).role, 'watcher');
  await hand(people, sid, LEAD, 'offer', BOSS);
  assert.equal((await hand(people, sid, BOSS, 'accept')).driver, BOSS);
  // The same message the app shows.
  const e = await part(people, sid, TECH2, 'join').catch((x) => x);
  assert.equal(e.message, 'This PC was connected without asking its owner. Only people allowed to connect without asking can join.');
  assert.equal(e.status, 403);
});

test('a person who loses "connect without asking" after being invited cannot join, and the accept fails at commit', async (t) => {
  const w = await agentWorld(t);
  await w.team.addRole('default', BOSS, { id: 'lead2', permissions: ['devices.view', 'sessions.view', 'sessions.control', 'sessions.unattended'] });
  const lead2 = 'lead2@example.com';
  await w.team.addMember('default', BOSS, { identity: lead2, role_id: 'lead2' });
  const { sid, pc, people } = await unasked(w);
  await part(people, sid, LEAD, 'invite', lead2);
  await part(people, sid, lead2, 'join');
  await hand(people, sid, LEAD, 'offer', lead2);
  // The role loses the permission between the offer and the accept.
  await w.team.updateRole('default', BOSS, 'lead2', { permissions: ['devices.view', 'sessions.view', 'sessions.control'] });
  assert.equal(await code(hand(people, sid, lead2, 'accept')), 'needs_unattended');
  assert.equal(w.pointer(pc.id).by, LEAD, 'the PC still names the driver');
  assert.equal((await call(w, sid, '/watch?workspace=default', undefined, { method: 'GET' })).driver, LEAD);
  // The reservation was let go again at once: the offer can still be answered by someone who may.
  assert.equal(await code(hand(people, sid, LEAD, 'cancel')), 'ok');
});

test('without the second factor, join, the picture and accept are each refused, whether or not the PC asked', async (t) => {
  const w = await agentWorld(t);
  const a = await asked(w);
  await part(a.people, a.sid, TECH, 'invite', TECH2);
  assert.equal(await code(part(a.people, a.sid, TECH2, 'join', undefined)), 'ok');
  await hand(a.people, a.sid, TECH, 'offer', TECH2);
  assert.equal(await code(a.people.participants('default', TECH2, { session_id: a.sid, action: 'join' }, NO_FACTOR)), 'second_factor');
  assert.equal(await code(a.people.frame('default', TECH2, a.sid, NO_FACTOR)), 'second_factor');
  assert.equal(await code(hand(a.people, a.sid, TECH2, 'accept', undefined, NO_FACTOR)), 'second_factor');
  assert.equal(w.pointer(a.pc.id).by, TECH, 'nothing moved');
  // A session that was never asked needs the second factor of both permissions.
  const u = await unasked(w);
  await part(u.people, u.sid, LEAD, 'invite', BOSS);
  await part(u.people, u.sid, BOSS, 'join');
  await hand(u.people, u.sid, LEAD, 'offer', BOSS);
  assert.equal(await code(u.people.participants('default', BOSS, { session_id: u.sid, action: 'join' }, NO_FACTOR)), 'second_factor');
  assert.equal(await code(u.people.participants('default', BOSS, { session_id: u.sid, action: 'join' }, NO_UNATTENDED_FACTOR)), 'second_factor');
  assert.equal(await code(u.people.frame('default', BOSS, u.sid, NO_UNATTENDED_FACTOR)), 'second_factor');
  assert.equal(await code(hand(u.people, u.sid, BOSS, 'accept', undefined, NO_UNATTENDED_FACTOR)), 'second_factor');
  assert.equal(w.pointer(u.pc.id).by, LEAD);
  assert.equal(await code(hand(u.people, u.sid, BOSS, 'accept')), 'ok', 'with the factors it goes through');
});

test('open mode, a Viewer and a person outside the team never pass the rule', async (t) => {
  const w = await agentWorld(t);
  const { sid, people } = await asked(w);
  for (const who of [VIEW, 'stranger@example.com', 'local-dev']) {
    assert.equal(await code(people.participants('default', who, { session_id: sid, action: 'join' })), 'cannot_control', who);
    assert.equal(await code(people.frame('default', who, sid, {})), 'cannot_control', who);
  }
  // The target of an invite must be a member who is a person and holds control.
  for (const who of [VIEW, 'stranger@example.com', 'a-service-client-id']) {
    assert.equal(await code(part(people, sid, TECH, 'invite', who)), 'cannot_control', who);
  }
});

test('while the session is still waiting, a person may join but accept gets not_attached and nothing moves', async (t) => {
  const w = await agentWorld(t);
  await addTech2(w);
  const pc = await w.addPc({ access: 'any' });
  const sid = (await w.tool(TECH, 'device_connect', { device_id: pc.id })).session_id;
  assert.equal(w.stateOf(sid), 'waiting');
  const people = sessionPeople(w.env);
  await part(people, sid, TECH, 'invite', TECH2);
  await part(people, sid, TECH2, 'join');
  await hand(people, sid, TECH, 'offer', TECH2);
  assert.equal(await code(hand(people, sid, TECH2, 'accept')), 'not_attached');
  assert.equal(w.pointer(pc.id).by, TECH);
  // Once the PC lets the session in, the same offer is accepted.
  await w.agent(sid, pc.key, { type: 'hello', machine: 'M1', user: 'dana', control: 'full', caps: ['screen', 'lanes'], version: '0.6.0' });
  assert.equal((await hand(people, sid, TECH2, 'accept')).driver, TECH2);
});

// ---- D1 and the Session in step ---------------------------------------------------------------------
test('a session step that fails after the PC\'s record moved is repeated, and the two converge', async (t) => {
  const w = await agentWorld(t);
  const { sid, pc, people } = await asked(w);
  await part(people, sid, TECH, 'invite', TECH2);
  await part(people, sid, TECH2, 'join');
  await hand(people, sid, TECH, 'offer', TECH2);
  const f = around(w, { op: 'complete', times: 2 });
  const done = await hand(people, sid, TECH2, 'accept');
  assert.deepEqual([done.driver, f.calls, f.thrown], [TECH2, 3, 2], 'the step was repeated until it went through');
  assert.equal(w.pointer(pc.id).by, TECH2);
  assert.equal((await w.log()).filter((r) => r.kind === 'device_session_handed_over').length, 1, 'one change, whatever the retries');
});

test('a session step that keeps failing is reported, and repeating the call finishes it without moving the PC again', async (t) => {
  const w = await agentWorld(t);
  const { sid, pc, people } = await asked(w);
  await part(people, sid, TECH, 'invite', TECH2);
  await part(people, sid, TECH2, 'join');
  await hand(people, sid, TECH, 'offer', TECH2);
  const f = around(w, { op: 'complete', times: 3 });
  const e = await hand(people, sid, TECH2, 'accept').catch((x) => x);
  assert.equal(e.code, 'busy');
  assert.equal(f.calls, 3);
  // The PC's record moved; the Session has not followed.
  assert.equal(w.pointer(pc.id).by, TECH2);
  assert.equal((await call(w, sid, '/watch?workspace=default', undefined, { method: 'GET' })).driver, TECH);
  // The same call again: the pointer already names TECH2, so only the session step runs.
  const again = await hand(people, sid, TECH2, 'accept');
  assert.equal(again.driver, TECH2);
  assert.equal((await call(w, sid, '/watch?workspace=default', undefined, { method: 'GET' })).driver, TECH2);
  assert.equal((await w.log()).filter((r) => r.kind === 'device_session_handed_over').length, 1);
});

test('a session step that kept failing until the offer lapsed is finished by a repeated accept, and later handovers work', async (t) => {
  const w = await agentWorld(t);
  const { sid, pc, people } = await asked(w);
  await part(people, sid, TECH, 'invite', TECH2);
  await part(people, sid, TECH2, 'join');
  await hand(people, sid, TECH, 'offer', TECH2);
  around(w, { op: 'complete', times: 3 });
  assert.equal(await code(hand(people, sid, TECH2, 'accept')), 'busy');
  assert.equal(w.pointer(pc.id).by, TECH2);
  // The offer and the hold lapse; the Session still names TECH.
  w.advance(180_000);
  assert.equal((await call(w, sid, '/watch?workspace=default', undefined, { method: 'GET' })).driver, TECH);
  assert.equal((await w.tool(TECH2, 'session_status', { session_id: sid })).offer, null);
  const again = await hand(people, sid, TECH2, 'accept');
  assert.equal(again.driver, TECH2);
  assert.equal(w.pointer(pc.id).by, TECH2);
  assert.equal((await call(w, sid, '/watch?workspace=default', undefined, { method: 'GET' })).driver, TECH2);
  assert.equal((await w.log()).filter((r) => r.kind === 'device_session_handed_over').length, 1, 'the PC did not move again');
  // The new driver can hand over again.
  await hand(people, sid, TECH2, 'offer', TECH);
  assert.equal((await hand(people, sid, TECH, 'accept')).driver, TECH);
  assert.equal(w.pointer(pc.id).by, TECH);
});

test('an open offer, a handover in progress and a missing second factor are each their own refusal, not already_claimed', async (t) => {
  const w = await agentWorld(t);
  const { sid, people } = await asked(w);
  await part(people, sid, TECH, 'invite', TECH2);
  await part(people, sid, TECH2, 'join');
  await part(people, sid, TECH, 'invite', LEAD);
  await part(people, sid, LEAD, 'join');
  await hand(people, sid, TECH, 'offer', TECH2);
  assert.equal(await code(hand(people, sid, TECH, 'offer', LEAD)), 'offer_pending');
  // While TECH2's accept is between its steps, another offer and another accept find control being handed over.
  let during = null;
  around(w, { op: 'accepting', after: async (n) => { if (n === 1) during = [await code(hand(people, sid, TECH, 'offer', LEAD)), await code(hand(people, sid, LEAD, 'accept'))]; } });
  await hand(people, sid, TECH2, 'accept');
  assert.deepEqual(during, ['busy', 'busy']);
  // A missing second factor is told as such, with the tool's "<code>: <message>" text.
  const e = await hand(people, sid, TECH, 'accept', undefined, NO_FACTOR).catch((x) => x);
  assert.equal(e.code, 'second_factor');
});

test('a take-over by the previous driver between the PC\'s change and the session step ends the accept for good: no split between the PC and the session', async (t) => {
  const w = await agentWorld(t);
  await addTech2(w);
  const { sid, pc, people } = await attached(w, LEAD).then((s) => ({ ...s, people: sessionPeople(w.env) }));
  assert.equal(w.pointer(pc.id).ask, false);
  await part(people, sid, LEAD, 'invite', BOSS);
  await part(people, sid, BOSS, 'join');
  await hand(people, sid, LEAD, 'offer', BOSS);
  // BOSS's accept moved the PC's pointer; before the session step, LEAD (the driver the accept began from) takes over again.
  // The identity "LEAD" is back on both sides, so comparing names would let the step run: only the generation stops it.
  let took = null;
  const f = around(w, { op: 'complete', before: async () => { took ??= await w.tool(LEAD, 'device_connect', { device_id: pc.id, take_over: true }); } });
  const e = await hand(people, sid, BOSS, 'accept').catch((x) => x);
  assert.equal(took.session_id, sid, JSON.stringify(took));
  assert.equal(e.code, 'not_driver');
  assert.equal(f.calls, 1, 'it did not try again');
  const watch = await call(w, sid, '/watch?workspace=default', undefined, { method: 'GET' });
  assert.deepEqual([w.pointer(pc.id).by, watch.driver], [LEAD, LEAD]);
  assert.equal(w.pointer(pc.id).gen, watch.gen, 'the pointer and the session count the same changes');
  assert.ok(watch.gen >= 2);
  // A retry cannot bring the older accept back: the offer is gone.
  assert.equal(await code(hand(people, sid, BOSS, 'accept')), 'no_offer');
  assert.deepEqual([w.pointer(pc.id).by, (await call(w, sid, '/watch?workspace=default', undefined, { method: 'GET' })).driver], [LEAD, LEAD]);
  // An honest handover afterwards still works, in the next generation.
  await hand(people, sid, LEAD, 'offer', BOSS);
  assert.equal((await hand(people, sid, BOSS, 'accept')).driver, BOSS);
  const after = await call(w, sid, '/watch?workspace=default', undefined, { method: 'GET' });
  assert.deepEqual([w.pointer(pc.id).by, after.driver, w.pointer(pc.id).gen === after.gen], [BOSS, BOSS, true]);
});

test('a half-finished accept, then a take-over by a third person, leaves them driving on both sides, and the lapsed retry cannot undo it', async (t) => {
  const w = await agentWorld(t);
  const { sid, pc, people } = await asked(w);
  await part(people, sid, TECH, 'invite', TECH2);
  await part(people, sid, TECH2, 'join');
  await hand(people, sid, TECH, 'offer', TECH2);
  around(w, { op: 'complete', times: 3 });
  assert.equal(await code(hand(people, sid, TECH2, 'accept')), 'busy');
  // The pointer names TECH2 at the next generation; the session is a generation behind. LEAD takes over: both sides move to LEAD.
  await w.tool(LEAD, 'device_connect', { device_id: pc.id, take_over: true });
  const watch = await call(w, sid, '/watch?workspace=default', undefined, { method: 'GET' });
  assert.deepEqual([w.pointer(pc.id).by, watch.driver, w.pointer(pc.id).gen === watch.gen], [LEAD, LEAD, true]);
  w.advance(180_000);
  // TECH2's repeated accept finds no offer, and the pointer no longer names them, so nothing moves.
  assert.equal(await code(hand(people, sid, TECH2, 'accept')), 'no_offer');
  assert.deepEqual([w.pointer(pc.id).by, (await call(w, sid, '/watch?workspace=default', undefined, { method: 'GET' })).driver], [LEAD, LEAD]);
});

for (const lapsed of [false, true]) {
  test(`a half-finished accept from before generations existed (${lapsed ? 'offer lapsed' : 'offer open'}): a repeat settles both sides to the same number, and a take-over after it really drives`, async (t) => {
    const w = await agentWorld(t);
    const { sid, pc } = await attached(w, LEAD);
    const people = sessionPeople(w.env);
    const watchOf = () => call(w, sid, '/watch?workspace=default', undefined, { method: 'GET' });
    await part(people, sid, LEAD, 'invite', BOSS);
    await part(people, sid, BOSS, 'join');
    await hand(people, sid, LEAD, 'offer', BOSS);
    // The old code moved the PC's pointer and stopped: no generation in the pointer, none in the Session.
    w.db.sqlite.prepare("UPDATE devices SET session = json_set(session, '$.by', ?) WHERE id = ?").run(BOSS, pc.id);
    assert.equal(w.pointer(pc.id).gen, undefined);
    assert.deepEqual([(await watchOf()).driver, (await watchOf()).gen], [LEAD, 0]);
    if (lapsed) w.advance(180_000);
    const done = await hand(people, sid, BOSS, 'accept');
    assert.equal(done.driver, BOSS);
    const settled = await watchOf();
    assert.deepEqual([w.pointer(pc.id).by, settled.driver], [BOSS, BOSS]);
    assert.equal(w.pointer(pc.id).gen, settled.gen, 'both sides count the same');
    assert.ok(settled.gen >= 1);
    // A repeat changes nothing. Then LEAD takes over: both sides name LEAD at the same, higher number.
    assert.equal((await hand(people, sid, BOSS, 'accept')).driver, BOSS);
    const took = await w.tool(LEAD, 'device_connect', { device_id: pc.id, take_over: true });
    assert.equal(took.session_id, sid, JSON.stringify(took));
    const after = await watchOf();
    assert.deepEqual([w.pointer(pc.id).by, after.driver], [LEAD, LEAD]);
    assert.equal(w.pointer(pc.id).gen, after.gen);
    assert.ok(after.gen > settled.gen);
    // LEAD really drives: the session lets their command through to the next check and refuses BOSS's.
    assert.doesNotMatch((await call(w, sid, '/command', { op: 'screenshot', actor: LEAD, timeout_ms: 50 })).error ?? '', /is driving this session/);
    assert.match((await call(w, sid, '/command', { op: 'run', command: 'x', actor: BOSS })).error, /is driving this session/);
  });
}

test('a take-over that the session has already passed answers a failure, so the caller is not told they drive', async (t) => {
  const w = await agentWorld(t);
  const { sid } = await attached(w, LEAD);
  // The session is at generation 3 (as after the older code made one up) and the pointer takes 1: a late take-over.
  await call(w, sid, '/takeover', { actor: LEAD, gen: 3 });
  const stale = await call(w, sid, '/takeover', { actor: BOSS, gen: 1 });
  assert.deepEqual([stale.ok, stale.stale], [false, true]);
  assert.equal((await call(w, sid, '/watch?workspace=default', undefined, { method: 'GET' })).driver, LEAD);
  // The same take-over delivered twice is fine.
  assert.equal((await call(w, sid, '/takeover', { actor: LEAD, gen: 3 })).ok, true);
});

test('complete never makes up a generation: one that is not above the session\'s stops', async (t) => {
  const w = await agentWorld(t);
  const { sid } = await attached(w, LEAD);
  const people = sessionPeople(w.env);
  await part(people, sid, LEAD, 'invite', BOSS);
  await part(people, sid, BOSS, 'join');
  const body = { op: 'complete', actor: BOSS, from: LEAD, kind: 'accept', from_gen: 0 };
  assert.equal((await call(w, sid, '/handover', { ...body, gen: 0 })).code, 'not_driver');
  assert.equal((await call(w, sid, '/handover', body)).code, 'not_driver');
  assert.equal((await call(w, sid, '/handover', { ...body, gen: 1 })).driver, BOSS);
});

test('a cancel between the steps leaves one driver, whichever way it lands', async (t) => {
  const w = await agentWorld(t);
  const { sid, pc, people } = await asked(w);
  await part(people, sid, TECH, 'invite', TECH2);
  await part(people, sid, TECH2, 'join');
  await hand(people, sid, TECH, 'offer', TECH2);
  // The driver cancels while the accept is between its steps: the offer is being accepted, so the cancel is refused.
  let cancelled = null;
  around(w, { op: 'accepting', after: async () => { cancelled = await code(hand(people, sid, TECH, 'cancel')); } });
  const done = await hand(people, sid, TECH2, 'accept');
  assert.equal(cancelled, 'no_offer');
  assert.equal(done.driver, TECH2);
  assert.equal(w.pointer(pc.id).by, TECH2);
  // The cancel lands first: the accept finds no offer.
  await hand(people, sid, TECH2, 'offer', TECH);
  await hand(people, sid, TECH2, 'cancel');
  assert.equal(await code(hand(people, sid, TECH, 'accept')), 'no_offer');
  assert.equal(w.pointer(pc.id).by, TECH2);
  assert.equal((await call(w, sid, '/watch?workspace=default', undefined, { method: 'GET' })).driver, TECH2);
});

test('a take-over that lands between the accept\'s steps stops it with not_driver, and nothing loops', async (t) => {
  const w = await agentWorld(t);
  const { sid, pc, people } = await asked(w);
  await part(people, sid, TECH, 'invite', TECH2);
  await part(people, sid, TECH2, 'join');
  // Before the PC's record moves: LEAD takes over (device_connect), so the guard on the old driver fails.
  await hand(people, sid, TECH, 'offer', TECH2);
  let first = null;
  const a = around(w, { op: 'accepting', after: async () => { first ??= await w.tool(LEAD, 'device_connect', { device_id: pc.id, take_over: true }); } });
  const early = await hand(people, sid, TECH2, 'accept').catch((x) => x);
  assert.equal(first.session_id, sid, JSON.stringify(first));
  assert.equal(early.code, 'not_driver');
  assert.match(early.message, new RegExp(`${LEAD} is driving`));
  assert.equal(a.calls, 1);
  assert.equal(w.pointer(pc.id).by, LEAD);
  assert.equal((await call(w, sid, '/watch?workspace=default', undefined, { method: 'GET' })).driver, LEAD);
  assert.equal((await w.log()).filter((r) => r.kind === 'device_session_handed_over').length, 0, 'no handover was logged');
  // After the PC's record moved: BOSS takes over before the Session step. The later take-over stands.
  await part(people, sid, LEAD, 'invite', TECH2);
  await hand(people, sid, LEAD, 'offer', TECH2);
  let second = null;
  const b = around(w, { op: 'complete', before: async () => { second = await w.tool(BOSS, 'device_connect', { device_id: pc.id, take_over: true }); } });
  const late = await hand(people, sid, TECH2, 'accept').catch((x) => x);
  assert.equal(second.session_id, sid, JSON.stringify(second));
  assert.equal(late.code, 'not_driver');
  assert.equal(b.calls, 1, 'it did not try again');
  assert.equal(w.pointer(pc.id).by, BOSS);
  assert.equal((await call(w, sid, '/watch?workspace=default', undefined, { method: 'GET' })).driver, BOSS);
  assert.equal((await w.tool(BOSS, 'session_status', { session_id: sid })).driver, BOSS);
});

test('a take-over by device_connect clears an offer and puts the old driver among the watchers', async (t) => {
  const w = await agentWorld(t);
  const { sid, pc, people } = await asked(w);
  await part(people, sid, TECH, 'invite', TECH2);
  await part(people, sid, TECH2, 'join');
  await hand(people, sid, TECH, 'offer', TECH2);
  await w.tool(LEAD, 'device_connect', { device_id: pc.id, take_over: true });
  const status = await w.tool(LEAD, 'session_status', { session_id: sid });
  assert.deepEqual([status.driver, status.offer], [LEAD, null]);
  assert.deepEqual(status.participants.map((p) => `${p.identity}:${p.role}`).sort(), [`${LEAD}:driver`, `${TECH}:watcher`, `${TECH2}:watcher`].sort());
  assert.equal(await code(hand(people, sid, TECH2, 'accept')), 'no_offer');
});

// ---- another team ---------------------------------------------------------------------------------
test('a session of another team answers every route as a session that does not exist, and nothing changes', async (t) => {
  const w = await agentWorld(t);
  const { sid, pc, people } = await asked(w);
  // A second team with TECH and TECH2 in it.
  const team = teamStore(w.db, { deploymentAdmins: BOSS });
  await team.createWorkspace(BOSS, { slug: 'acme', name: 'Acme' });
  for (const who of [TECH, TECH2, LEAD]) await team.addMember('acme', BOSS, { identity: who, role_id: 'admin' });
  await part(people, sid, TECH, 'invite', TECH2);
  await part(people, sid, TECH2, 'join');
  await hand(people, sid, TECH, 'offer', TECH2);
  const other = sessionPeople(w.env);
  const before = JSON.stringify([...w.sessionFor(sid).ctx.values]);
  for (const [name, fn] of Object.entries({
    join: () => other.participants('acme', TECH2, { session_id: sid, action: 'join' }),
    invite: () => other.participants('acme', TECH, { session_id: sid, action: 'invite', identity: LEAD }),
    remove: () => other.participants('acme', TECH, { session_id: sid, action: 'remove', identity: TECH2 }),
    frame: () => other.frame('acme', TECH2, sid, {}),
    accept: () => other.handover('acme', TECH2, { session_id: sid, action: 'accept' }),
    decline: () => other.handover('acme', TECH2, { session_id: sid, action: 'decline' }),
    cancel: () => other.handover('acme', TECH, { session_id: sid, action: 'cancel' }),
    offer: () => other.handover('acme', TECH, { session_id: sid, action: 'offer', identity: TECH2 }),
    take_over: () => other.handover('acme', LEAD, { session_id: sid, action: 'take_over' }),
  })) {
    const e = await fn().catch((x) => x);
    assert.equal(e.code, 'not_found', name);
    assert.equal(e.message, 'no such live session', name);
  }
  assert.equal(JSON.stringify([...w.sessionFor(sid).ctx.values]), before, 'the session was not touched');
  assert.equal(w.pointer(pc.id).by, TECH);
  // And the other way: a session that is not there at all answers the same.
  const none = await other.handover('acme', TECH, { session_id: 'f'.repeat(64), action: 'cancel' }).catch((x) => x);
  assert.equal(none.code, 'not_found');
  // The team's own members see it fine.
  assert.equal((await hand(people, sid, TECH2, 'accept')).driver, TECH2);
});

test('the people list names the members who are people and whether each can control sessions', async (t) => {
  const w = await agentWorld(t);
  await addTech2(w);
  const { people: list } = { people: (await sessionPeople(w.env).peopleList('default')).people };
  const by = Object.fromEntries(list.map((p) => [p.identity, p.can_control]));
  assert.deepEqual(by, { [BOSS]: true, [TECH]: true, [VIEW]: false, [LEAD]: true, [TECH2]: true });
  assert.ok(list.every((p) => p.name === null || typeof p.name === 'string'));
});

// ---- the built-in agent --------------------------------------------------------------------------------
const rowsOf = (w, where = '', ...params) => w.sql(`SELECT recipient, event, task_id, title, body FROM notifications ${where} ORDER BY id`, ...params).map((r) => ({ ...r }));

test('a handover by the starter stops their task quietly and leaves the session running; the new driver keeps it', async (t) => {
  const w = await agentWorld(t);
  await w.ready();
  await addTech2(w);
  const a = await w.startOnPc(TECH, { keep_working: true });
  const sid = a.joined.sid;
  const people = sessionPeople(w.env);
  await part(people, sid, TECH, 'invite', TECH2);
  await part(people, sid, TECH2, 'join');
  await hand(people, sid, TECH, 'offer', TECH2);
  await hand(people, sid, TECH2, 'accept');
  assert.equal(w.pointer(a.pc.id).by, TECH2);
  await w.drive(a.id);
  const row = w.taskRow(a.id);
  assert.deepEqual([row.state, row.end_reason], ['stopped', `handed over to ${TECH2}`]);
  // The starter did it themselves: no "needs attention", and the log names them as the actor.
  assert.deepEqual(rowsOf(w, "WHERE task_id = ? AND event LIKE 'task%'", a.id), []);
  const ended = (await w.log()).find((r) => r.kind === 'agent_task_ended');
  assert.equal(ended.actor, TECH);
  assert.match(ended.detail, new RegExp(`${a.id} stopped handed over to ${TECH2}`));
  // The session is the new driver's now: not ended, and the pointer still names them.
  assert.equal(w.stateOf(sid), 'attached');
  assert.equal(w.pointer(a.pc.id).by, TECH2);
  assert.equal(w.sql('SELECT COUNT(*) AS n FROM escalations')[0].n, 0);
});

test('the quiet stop names the new driver the way the team knows them', async (t) => {
  const w = await agentWorld(t);
  await w.ready();
  await addTech2(w);
  w.db.sqlite.prepare("UPDATE members SET name = 'Tamar Two' WHERE identity = ?").run(TECH2);
  const a = await w.startOnPc(TECH, { keep_working: true });
  const sid = a.joined.sid;
  const people = sessionPeople(w.env);
  await part(people, sid, TECH, 'invite', TECH2);
  await part(people, sid, TECH2, 'join');
  await hand(people, sid, TECH, 'offer', TECH2);
  await hand(people, sid, TECH2, 'accept');
  await w.drive(a.id);
  assert.equal(w.taskRow(a.id).end_reason, 'handed over to Tamar Two');
});

test('a take-over by someone else still ends the task with the notice, even when the starter had offered control', async (t) => {
  const w = await agentWorld(t);
  await w.ready();
  await addTech2(w);
  const a = await w.startOnPc(TECH, { keep_working: true });
  const people = sessionPeople(w.env);
  // The starter offered control to TECH2, but LEAD took the session over before it was accepted.
  await part(people, a.joined.sid, TECH, 'invite', TECH2);
  await part(people, a.joined.sid, TECH2, 'join');
  await hand(people, a.joined.sid, TECH, 'offer', TECH2);
  await w.tool(LEAD, 'device_connect', { device_id: a.pc.id, take_over: true });
  await w.drive(a.id);
  assert.deepEqual([w.taskRow(a.id).state, w.taskRow(a.id).end_reason], ['stopped', 'someone else took over the session']);
  assert.deepEqual(rowsOf(w, "WHERE task_id = ? AND event = 'task_problem'", a.id).map((r) => [r.recipient, r.body]), [[TECH, 'The printer stopped printing.: someone else took over the session']]);
  assert.equal((await w.log()).find((r) => r.kind === 'agent_task_ended').actor, 'relay');
});

test('a handover that is later taken over by someone else raises the notice: the handover record names the new driver only', async (t) => {
  const w = await agentWorld(t);
  await w.ready();
  await addTech2(w);
  const a = await w.startOnPc(TECH, { keep_working: true });
  const sid = a.joined.sid;
  const people = sessionPeople(w.env);
  await part(people, sid, TECH, 'invite', TECH2);
  await part(people, sid, TECH2, 'join');
  await hand(people, sid, TECH, 'offer', TECH2);
  await hand(people, sid, TECH2, 'accept');
  // Before the task looks again, LEAD takes the session over from TECH2.
  await w.tool(LEAD, 'device_connect', { device_id: a.pc.id, take_over: true });
  await w.drive(a.id);
  assert.equal(w.taskRow(a.id).end_reason, 'someone else took over the session', 'handed_over is cleared by a take-over');
  assert.equal(rowsOf(w, "WHERE task_id = ? AND event = 'task_problem'", a.id).length, 1);
});
