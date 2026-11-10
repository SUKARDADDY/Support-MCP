// The escalation queue: opening an item, the open, mine and closed lists, claiming (a ticket, and a live session that
// moves control under the same rule as an accept), closing, and the isolation between teams.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentWorld, BOSS, TECH, VIEW, LEAD } from './agent-world.js';
import { TECH2, addTech2, attached, attachedLink, call } from './people-world.js';
import { oai } from './agent-fakes.js';
import { escalationService } from '../src/escalations.js';
import { teamStore } from '../src/workspace.js';
import { sessionPeople } from '../src/session-people.js';

const code = async (promise) => {
  try {
    await promise;
    return 'ok';
  } catch (e) {
    if (!e.code) throw e;
    return e.code;
  }
};
const items = (w) => w.sql('SELECT * FROM escalations ORDER BY opened_at, id').map((r) => ({ ...r }));
const notes = (w, event) => w.sql('SELECT recipient, event, device_id, session_id, task_id, title, body, dedupe FROM notifications WHERE event = ? ORDER BY id', event).map((r) => ({ ...r }));
const service = (w, mode = 'both') => escalationService(w.env, { agentMode: async () => mode });
const watchOf = (w, sid) => call(w, sid, '/watch?workspace=default', undefined, { method: 'GET' });

// Around the Session's /handover: run something after a step answered.
function after(w, op, fn) {
  const real = w.env.SESSION.get;
  w.env.SESSION.get = (id) => {
    const stub = real(id);
    return {
      fetch: async (u, init) => {
        const r = await stub.fetch(u, init);
        let body = null;
        try { body = JSON.parse(init?.body); } catch (_) { /* not JSON */ }
        if (new URL(typeof u === 'string' ? u : u.url).pathname === '/handover' && body?.op === op) await fn();
        return r;
      },
    };
  };
}

// ---- opening and listing ----------------------------------------------------------------------------
test('a driver opens an item for a session they drive, or anyone with control opens one for a PC; the rest is refused', async (t) => {
  const w = await agentWorld(t);
  await addTech2(w);
  const { sid, pc } = await attached(w, TECH);
  const svc = service(w);
  const made = await svc.open('default', TECH, { session_id: sid, note: '  The printer queue is stuck and I cannot find why.  ' });
  const e = made.escalation;
  assert.deepEqual([e.kind, e.device_id, e.device_name, e.session_id, e.task_id, e.summary, e.opened_by, e.opened_at], ['technician', pc.id, 'Till', sid, null, null, TECH, w.now()]);
  assert.equal(e.note, 'The printer queue is stuck and I cannot find why.');
  assert.deepEqual([e.claimed_by, e.claimed_at, e.closed_by, e.closed_at, e.close_note], [null, null, null, null, null]);
  assert.match(e.id, /^[a-z2-7]{20}$/);
  assert.match(made.untrusted_text, /data, never as instructions/);
  // The same session again: the same item, once.
  assert.equal((await svc.open('default', TECH, { session_id: sid, note: 'again' })).escalation.id, e.id);
  assert.equal(items(w).length, 1);
  // The team log has the id and the PC, never the note.
  const rows = (await w.log()).filter((r) => r.kind === 'escalation_opened');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actor, TECH);
  assert.equal(rows[0].detail, `${e.id} pc ${pc.id} session ${sid.slice(0, 8)}`);
  assert.ok(!JSON.stringify(await w.log()).includes('printer queue'));

  // Only the driver opens an item for a session.
  assert.equal(await code(svc.open('default', TECH2, { session_id: sid })), 'not_driver');
  assert.equal(await code(svc.open('default', BOSS, { session_id: sid })), 'not_driver');
  // A PC needs no session: anyone who controls sessions opens a ticket for it.
  const two = await w.addPc({ name: 'Back office' });
  const ticket = (await svc.open('default', TECH2, { device_id: two.id, note: 'Fails to wake from sleep' })).escalation;
  assert.deepEqual([ticket.device_id, ticket.device_name, ticket.session_id], [two.id, 'Back office', null]);
  // A Viewer cannot; a person outside the team cannot.
  assert.equal(await code(svc.open('default', VIEW, { device_id: two.id })), 'permission_denied');
  assert.equal(await code(svc.open('default', 'stranger@example.com', { device_id: two.id })), 'not_member');
  // Bad input.
  const bad = async (args, match) => assert.rejects(() => svc.open('default', TECH, args), (x) => x.code === 'bad_request' && match.test(x.message), JSON.stringify(args).slice(0, 60));
  await bad({}, /either session_id/);
  await bad({ session_id: sid, device_id: two.id }, /either session_id/);
  await bad({ device_id: two.id, note: 'x'.repeat(601) }, /at most 600/);
  await bad({ device_id: two.id, note: 'a\u0000b' }, /control characters/);
  await bad({ device_id: two.id, note: 7 }, /must be text/);
  await bad({ device_id: 'nope' }, /device_id must be/);
  await bad({ session_id: 'nope' }, /64 hex/);
  assert.equal(await code(svc.open('default', TECH, { device_id: 'a'.repeat(20) })), 'not_found');
  assert.equal(await code(svc.open('default', TECH, { session_id: 'f'.repeat(64) })), 'not_found');
  const pending = await w.addPc({ status: 'pending' });
  assert.equal(await code(svc.open('default', TECH, { device_id: pending.id })), 'pending');
  assert.equal(items(w).length, 2);
});

test('opening tells everyone who controls sessions except the opener, once, and a switched-off person is left out', async (t) => {
  const w = await agentWorld(t);
  await addTech2(w);
  const { sid, pc } = await attached(w, TECH);
  const svc = service(w);
  await w.sql('UPDATE members SET notify = ? WHERE identity = ?', JSON.stringify({ events: { escalation_opened: false } }), LEAD);
  const e = (await svc.open('default', TECH, { session_id: sid, note: 'help' })).escalation;
  const heard = notes(w, 'escalation_opened');
  assert.deepEqual(heard.map((n) => n.recipient).sort(), [BOSS, TECH2].sort(), 'not the opener, not the Viewer, not the person who switched it off');
  assert.deepEqual([heard[0].device_id, heard[0].session_id, heard[0].dedupe, heard[0].task_id], [pc.id, sid, `escalation:${e.id}:opened`, null]);
  assert.ok(!JSON.stringify(heard).includes('help'), 'the note is not in the notice');
  await svc.open('default', TECH, { session_id: sid, note: 'again' });
  assert.equal(notes(w, 'escalation_opened').length, 2, 'the repeat adds nothing');
});

test('the lists: open is what nobody has claimed, mine is what I opened or claimed and have not closed, closed is closed; newest first', async (t) => {
  const w = await agentWorld(t);
  await addTech2(w);
  const svc = service(w);
  const pcs = [];
  for (const n of ['One', 'Two', 'Three', 'Four']) pcs.push(await w.addPc({ name: n }));
  const made = [];
  for (const [i, who] of [TECH, TECH, TECH2, LEAD].entries()) {
    made.push((await svc.open('default', who, { device_id: pcs[i].id, note: `n${i}` })).escalation);
    w.advance(1000);
  }
  const ids = async (who, status) => (await svc.list('default', who, { status })).escalations.map((x) => x.id);
  assert.deepEqual(await ids(BOSS, 'open'), [...made].reverse().map((x) => x.id), 'newest first');
  assert.deepEqual(await ids(BOSS, undefined), await ids(BOSS, 'open'), 'open is the default');
  assert.deepEqual(await ids(TECH, 'mine'), [made[1].id, made[0].id]);
  await svc.claim('default', TECH, { id: made[2].id });
  assert.deepEqual(await ids(TECH, 'mine'), [made[2].id, made[1].id, made[0].id], 'mine: opened and claimed');
  assert.deepEqual(await ids(BOSS, 'open'), [made[3].id, made[1].id, made[0].id], 'claimed items leave the open list');
  await svc.close('default', TECH, { id: made[0].id, note: 'fixed by a restart' });
  assert.deepEqual(await ids(TECH, 'closed'), [made[0].id]);
  assert.deepEqual(await ids(TECH, 'mine'), [made[2].id, made[1].id], 'closed leaves mine');
  assert.equal((await svc.list('default', BOSS, { status: 'closed' })).escalations[0].close_note, 'fixed by a restart');
  assert.equal(await code(svc.list('default', BOSS, { status: 'all' })), 'bad_request');
  // A Viewer reads nothing: the permission is checked by the tool, and the store by the caller's role on a change.
  assert.equal(items(w).length, 4);
});

test('the list holds at most 100 items', async (t) => {
  const w = await agentWorld(t);
  const pc = await w.addPc();
  const svc = service(w);
  for (let i = 0; i < 105; i++) {
    const id = `${'a'.repeat(17)}${[...i.toString(6).padStart(3, '0')].map((d) => 'abcdef'[d]).join('')}`;
    w.db.sqlite.prepare("INSERT INTO escalations(workspace, id, kind, device_id, opened_by, opened_at) VALUES ('default', ?, 'technician', ?, ?, ?)").run(id, pc.id, TECH, 1000 + i);
  }
  const all = (await svc.list('default', BOSS, { status: 'open' })).escalations;
  assert.equal(all.length, 100);
  assert.ok(all[0].opened_at > all[99].opened_at);
});

// ---- claiming a ticket -------------------------------------------------------------------------------------
test('claiming a ticket marks it, returns the PC, tells the opener, and moves nobody', async (t) => {
  const w = await agentWorld(t);
  await addTech2(w);
  const svc = service(w);
  const pc = await w.addPc({ name: 'Back office' });
  const opened = (await svc.open('default', TECH, { device_id: pc.id, note: 'Fails to wake' })).escalation;
  w.advance(5000);
  const got = await svc.claim('default', TECH2, { id: opened.id });
  assert.deepEqual([got.device_id, got.device_name, got.one_off], [pc.id, 'Back office', undefined]);
  assert.deepEqual([got.escalation.claimed_by, got.escalation.claimed_at], [TECH2, w.now()]);
  assert.deepEqual(notes(w, 'escalation_claimed').map((n) => [n.recipient, n.dedupe, n.device_id]), [[TECH, `escalation:${opened.id}:claimed`, pc.id]]);
  assert.equal((await w.log()).filter((r) => r.kind === 'escalation_claimed').length, 1);
  assert.equal(items(w)[0].claimed_by, TECH2);
  // Again by the same person: the same answer, no second row. By someone else: already claimed.
  assert.equal((await svc.claim('default', TECH2, { id: opened.id })).escalation.claimed_at, got.escalation.claimed_at);
  assert.equal(await code(svc.claim('default', LEAD, { id: opened.id })), 'already_claimed');
  assert.equal(notes(w, 'escalation_claimed').length, 1);
  assert.equal((await w.log()).filter((r) => r.kind === 'escalation_claimed').length, 1);
  // A closed item cannot be claimed; a missing one is missing; a Viewer cannot.
  await svc.close('default', TECH2, { id: opened.id });
  assert.equal(await code(svc.claim('default', LEAD, { id: opened.id })), 'already_claimed');
  assert.equal(await code(svc.claim('default', LEAD, { id: 'a'.repeat(20) })), 'not_found');
  assert.equal(await code(svc.claim('default', LEAD, { id: 'nope' })), 'bad_request');
  const second = (await svc.open('default', TECH, { device_id: pc.id })).escalation;
  assert.equal(await code(svc.claim('default', VIEW, { id: second.id })), 'permission_denied');
  assert.equal(items(w).find((r) => r.id === second.id).claimed_by, null);
});

test('a ticket for a one-off session says so, and a person who claims their own item just marks it', async (t) => {
  const w = await agentWorld(t);
  const { sid } = await attachedLink(w, TECH);
  const svc = service(w);
  const item = (await svc.open('default', TECH, { session_id: sid })).escalation;
  assert.deepEqual([item.device_id, item.device_name, item.session_id], [null, null, sid]);
  // TECH claims their own item: it is a ticket (nothing to move), and they still drive.
  const own = await svc.claim('default', TECH, { id: item.id });
  assert.deepEqual([own.one_off, own.device_id, own.escalation.claimed_by], [true, undefined, TECH]);
  assert.equal((await watchOf(w, sid)).driver, TECH);
  // A session that has ended: the item is a ticket for whoever claims it.
  const link2 = await attachedLink(w, TECH);
  const item2 = (await svc.open('default', TECH, { session_id: link2.sid })).escalation;
  await call(w, link2.sid, '/end', { actor: TECH });
  const t2 = await svc.claim('default', BOSS, { id: item2.id });
  assert.equal(t2.one_off, true);
  assert.equal(t2.escalation.claimed_by, BOSS);
});

test('a ticket claim whose item is taken after it was read, with no log row to show for it, records and claims nothing', async (t) => {
  const w = await agentWorld(t);
  await addTech2(w);
  const svc = service(w);
  const pc = await w.addPc();
  const item = (await svc.open('default', TECH, { device_id: pc.id })).escalation;
  // The claim read the item as free. Before its change goes in, the row is claimed without a log row (so the log head
  // has not moved and the log number cannot stop the change): only the guard on the item can.
  const real = w.db.batch;
  let taken = 0;
  w.db.batch = async (statements) => {
    if (!taken && statements.some((s) => s.params.includes('escalation_claimed'))) {
      taken += 1;
      w.db.sqlite.prepare('UPDATE escalations SET claimed_by = ?, claimed_at = ? WHERE id = ?').run(LEAD, w.now(), item.id);
    }
    return real.call(w.db, statements);
  };
  assert.equal(await code(svc.claim('default', TECH2, { id: item.id })), 'already_claimed');
  assert.equal(taken, 1);
  assert.equal(items(w)[0].claimed_by, LEAD);
  assert.equal((await w.log()).filter((r) => r.kind === 'escalation_claimed').length, 0, 'no claim was logged for the loser');
  assert.equal(notes(w, 'escalation_claimed').length, 0, 'and the opener was not told of it');
});

test('two people claiming at once: exactly one wins, and the other is told who has it', async (t) => {
  const w = await agentWorld(t);
  await addTech2(w);
  const svc = service(w);
  const pc = await w.addPc();
  const item = (await svc.open('default', TECH, { device_id: pc.id })).escalation;
  const results = await Promise.allSettled([svc.claim('default', TECH2, { id: item.id }), svc.claim('default', LEAD, { id: item.id }), svc.claim('default', BOSS, { id: item.id })]);
  const won = results.filter((r) => r.status === 'fulfilled');
  assert.equal(won.length, 1);
  assert.deepEqual(results.filter((r) => r.status === 'rejected').map((r) => r.reason.code), ['already_claimed', 'already_claimed']);
  const winner = won[0].value.escalation.claimed_by;
  assert.equal(items(w)[0].claimed_by, winner);
  assert.equal((await w.log()).filter((r) => r.kind === 'escalation_claimed').length, 1);
  assert.equal(notes(w, 'escalation_claimed').length, 1);
});

// ---- claiming a live session --------------------------------------------------------------------------------
test('a live claim makes the claimer the driver, claims the item in the same change, and the opener watches and is told', async (t) => {
  const w = await agentWorld(t);
  await addTech2(w);
  const { sid, pc, generation } = await attached(w, TECH);
  const svc = service(w);
  const item = (await svc.open('default', TECH, { session_id: sid, note: 'over to you' })).escalation;
  w.advance(1000);
  const got = await svc.claim('default', TECH2, { id: item.id });
  assert.equal(got.driver, TECH2);
  assert.deepEqual([got.escalation.claimed_by, got.escalation.claimed_at, got.session_id, got.device_id], [TECH2, w.now(), sid, pc.id]);
  assert.deepEqual(got.participants.map((p) => `${p.identity}:${p.role}`), [`${TECH2}:driver`, `${TECH}:watcher`]);
  // The PC's record, the Session and the PC agree.
  assert.equal(w.pointer(pc.id).by, TECH2);
  assert.equal((await watchOf(w, sid)).driver, TECH2);
  assert.equal((await w.agent(sid, pc.key, { type: 'poll', generation, busy_lanes: ['cmd', 'screen'] })).body.driver, TECH2);
  // The team log: the claim, then the handover; ids and names only.
  const kinds = (await w.log()).map((r) => r.kind).filter((k) => k.startsWith('escalation') || k.includes('handed'));
  assert.deepEqual(kinds, ['escalation_opened', 'escalation_claimed', 'device_session_handed_over']);
  assert.ok(!JSON.stringify(await w.log()).includes('over to you'));
  assert.deepEqual(notes(w, 'escalation_claimed').map((n) => [n.recipient, n.session_id]), [[TECH, sid]]);
  assert.equal((await watchOf(w, sid)).handed_over.to, TECH2);
  // The session's commands follow.
  assert.match((await call(w, sid, '/command', { op: 'run', command: 'x', actor: TECH })).error, new RegExp(`${TECH2} is driving`));
  // The same call again is the same answer and changes nothing more.
  const again = await svc.claim('default', TECH2, { id: item.id });
  assert.equal(again.escalation.claimed_at, got.escalation.claimed_at);
  assert.equal((await w.log()).filter((r) => r.kind === 'escalation_claimed').length, 1);
});

test('a live claim follows the same rule as an accept: needs_unattended on a session nobody asked about, not_attached while waiting', async (t) => {
  const w = await agentWorld(t);
  await addTech2(w);
  const svc = service(w);
  const u = await attached(w, LEAD);
  assert.equal(w.pointer(u.pc.id).ask, false);
  const item = (await svc.open('default', LEAD, { session_id: u.sid })).escalation;
  assert.equal(await code(svc.claim('default', TECH2, { id: item.id })), 'needs_unattended');
  assert.equal(await code(svc.claim('default', TECH2, { id: item.id }, { factor: async (p) => { throw new Error(`${p} needs a code`); } })), 'second_factor');
  assert.deepEqual([items(w).find((r) => r.id === item.id).claimed_by, w.pointer(u.pc.id).by], [null, LEAD], 'nothing moved, nothing claimed');
  assert.equal(await code(svc.claim('default', BOSS, { id: item.id }, { factor: async (p) => { if (p === 'sessions.control') throw new Error('no'); } })), 'second_factor');
  assert.equal((await svc.claim('default', BOSS, { id: item.id })).driver, BOSS, 'an admin passes');

  // Waiting: the PC has not let the session in.
  const pc2 = await w.addPc({ access: 'any', name: 'Two' });
  const waiting = (await w.tool(TECH, 'device_connect', { device_id: pc2.id })).session_id;
  const item2 = (await svc.open('default', TECH, { session_id: waiting })).escalation;
  assert.equal(await code(svc.claim('default', TECH2, { id: item2.id })), 'not_attached');
  assert.deepEqual([items(w).find((r) => r.id === item2.id).claimed_by, w.pointer(pc2.id).by], [null, TECH]);
  // A person who cannot control sessions at all.
  assert.equal(await code(svc.claim('default', VIEW, { id: item2.id })), 'cannot_control');
});

test('a claim moves control only from the person who escalated: after a take-over it is a ticket', async (t) => {
  const w = await agentWorld(t);
  await addTech2(w);
  const { sid, pc } = await attached(w, TECH);
  const svc = service(w);
  const item = (await svc.open('default', TECH, { session_id: sid })).escalation;
  await w.tool(LEAD, 'device_connect', { device_id: pc.id, take_over: true });
  const got = await svc.claim('default', TECH2, { id: item.id });
  assert.deepEqual([got.device_id, got.session_id, got.driver, got.escalation.claimed_by], [pc.id, undefined, undefined, TECH2]);
  assert.equal(w.pointer(pc.id).by, LEAD, 'the take-over stands');
  assert.equal((await watchOf(w, sid)).driver, LEAD);
});

test('a claim that loses the race for the item stays unclaimed and moves nothing', async (t) => {
  const w = await agentWorld(t);
  await addTech2(w);
  const { sid, pc } = await attached(w, TECH);
  const svc = service(w);
  const item = (await svc.open('default', TECH, { session_id: sid })).escalation;
  // Another person claims it as a ticket after this claim reserved the session and before its change.
  let other = null;
  after(w, 'accepting', async () => { other = await svc.store.claimTicket('default', LEAD, item.id); });
  assert.equal(await code(svc.claim('default', TECH2, { id: item.id })), 'already_claimed');
  assert.equal(other.claimed_by, LEAD);
  assert.deepEqual([items(w)[0].claimed_by, w.pointer(pc.id).by, (await watchOf(w, sid)).driver], [LEAD, TECH, TECH]);
  assert.equal((await w.log()).filter((r) => r.kind === 'device_session_handed_over').length, 0);
  // The reservation was let go: the driver can still hand over by offer.
  const status = await w.tool(TECH, 'session_status', { session_id: sid });
  assert.equal(status.driver, TECH);
});

test('a live claim on a one-off session moves control and logs session_handed_over', async (t) => {
  const w = await agentWorld(t);
  await addTech2(w);
  const { sid } = await attachedLink(w, TECH);
  const svc = service(w);
  const item = (await svc.open('default', TECH, { session_id: sid })).escalation;
  const got = await svc.claim('default', TECH2, { id: item.id });
  assert.deepEqual([got.driver, got.one_off, got.device_id], [TECH2, true, undefined]);
  assert.equal((await watchOf(w, sid)).driver, TECH2);
  assert.deepEqual((await w.log()).map((r) => r.kind).filter((k) => k.startsWith('escalation') || k.includes('handed')), ['escalation_opened', 'escalation_claimed', 'session_handed_over']);
  assert.equal(items(w)[0].claimed_by, TECH2);
});

test('a claim whose last step did not go through is finished by repeating it, with one claim and one log row', async (t) => {
  const w = await agentWorld(t);
  await addTech2(w);
  const { sid } = await attachedLink(w, TECH);
  const svc = service(w);
  const item = (await svc.open('default', TECH, { session_id: sid })).escalation;
  const real = w.env.SESSION.get;
  let down = 3;
  w.env.SESSION.get = (id) => ({ fetch: async (u, init) => {
    let body = null;
    try { body = JSON.parse(init?.body); } catch (_) { /* not JSON */ }
    if (down > 0 && body?.op === 'complete') { down -= 1; throw new Error('out of reach'); }
    return real(id).fetch(u, init);
  } });
  assert.equal(await code(svc.claim('default', TECH2, { id: item.id })), 'busy');
  assert.equal(items(w)[0].claimed_by, TECH2, 'the claim is recorded');
  assert.equal((await watchOf(w, sid)).driver, TECH, 'the session has not followed');
  assert.equal((await svc.claim('default', TECH2, { id: item.id })).driver, TECH2);
  assert.equal((await watchOf(w, sid)).driver, TECH2);
  assert.equal((await w.log()).filter((r) => r.kind === 'escalation_claimed').length, 1);
  assert.equal((await w.log()).filter((r) => r.kind === 'session_handed_over').length, 1, 'the one-off record was not written twice');
  assert.equal(notes(w, 'escalation_claimed').length, 1);
});

// The session step of a claim fails `times` times, so the claim is recorded and the PC (or the reservation) is ahead.
function failComplete(w, times = 3) {
  const real = w.env.SESSION.get;
  let down = times;
  w.env.SESSION.get = (id) => ({ fetch: async (u, init) => {
    let body = null;
    try { body = JSON.parse(init?.body); } catch (_) { /* not JSON */ }
    if (down > 0 && body?.op === 'complete') { down -= 1; throw new Error('out of reach'); }
    return real(id).fetch(u, init);
  } });
}
const handoverTo = (people, sid, from, to) => people.handover('default', from, { session_id: sid, action: 'offer', identity: to })
  .then(() => people.handover('default', to, { session_id: sid, action: 'accept' }));
const drivers = async (w, sid, pc) => [pc ? w.pointer(pc.id).by : null, (await watchOf(w, sid)).driver];

test('repeating a claim moves control only while it is half done: not after the claimer handed back, not after the sender took back, not for a ticket claim', async (t) => {
  const w = await agentWorld(t);
  await addTech2(w);
  const svc = service(w);
  const people = sessionPeople(w.env);
  const moves = async () => (await w.log()).filter((r) => r.kind === 'device_session_handed_over' || r.kind === 'device_session_taken_over').length;

  // The claimer handed control back to the sender.
  const a = await attached(w, LEAD);
  const itemA = (await svc.open('default', LEAD, { session_id: a.sid })).escalation;
  assert.equal((await svc.claim('default', BOSS, { id: itemA.id })).driver, BOSS);
  await handoverTo(people, a.sid, BOSS, LEAD);
  const countA = await moves();
  const againA = await svc.claim('default', BOSS, { id: itemA.id });
  assert.equal(againA.driver, undefined, 'a ticket: no control moved');
  assert.deepEqual(await drivers(w, a.sid, a.pc), [LEAD, LEAD]);
  assert.equal(await moves(), countA);

  // The sender took control back (a take-over).
  const b = await attached(w, LEAD);
  const itemB = (await svc.open('default', LEAD, { session_id: b.sid })).escalation;
  assert.equal((await svc.claim('default', BOSS, { id: itemB.id })).driver, BOSS);
  await w.tool(LEAD, 'device_connect', { device_id: b.pc.id, take_over: true });
  const countB = await moves();
  assert.equal((await svc.claim('default', BOSS, { id: itemB.id })).driver, undefined);
  assert.deepEqual(await drivers(w, b.sid, b.pc), [LEAD, LEAD]);
  assert.equal(await moves(), countB);

  // A ticket claim (someone else drove when it was made); the sender drives again later.
  const c = await attached(w, TECH);
  const itemC = (await svc.open('default', TECH, { session_id: c.sid })).escalation;
  await people.participants('default', TECH, { session_id: c.sid, action: 'invite', identity: TECH2 });
  await people.participants('default', TECH2, { session_id: c.sid, action: 'join' });
  await handoverTo(people, c.sid, TECH, TECH2);
  assert.equal((await svc.claim('default', BOSS, { id: itemC.id })).driver, undefined, 'a ticket while TECH2 drives');
  await handoverTo(people, c.sid, TECH2, TECH);
  const countC = await moves();
  assert.equal((await svc.claim('default', BOSS, { id: itemC.id })).driver, undefined);
  assert.deepEqual(await drivers(w, c.sid, c.pc), [TECH, TECH]);
  assert.equal(await moves(), countC);
  // None of these is offered as unfinished on Mine.
  const mine = (await svc.list('default', BOSS, { status: 'mine' })).escalations;
  assert.deepEqual(mine.filter((e) => e.finish_pending), []);
});

test('the same on a one-off session: a repeated claim after a hand back is a ticket, and only a claim whose reservation is still there is finished', async (t) => {
  const w = await agentWorld(t);
  await addTech2(w);
  const svc = service(w);
  const people = sessionPeople(w.env);
  const { sid } = await attachedLink(w, TECH);
  const item = (await svc.open('default', TECH, { session_id: sid })).escalation;
  assert.equal((await svc.claim('default', TECH2, { id: item.id })).driver, TECH2);
  await handoverTo(people, sid, TECH2, TECH);
  assert.equal((await svc.claim('default', TECH2, { id: item.id })).driver, undefined);
  assert.equal((await watchOf(w, sid)).driver, TECH);

  // A half-done claim: the reservation is there, the list marks it, and repeating it moves control.
  const link2 = await attachedLink(w, TECH);
  const item2 = (await svc.open('default', TECH, { session_id: link2.sid })).escalation;
  failComplete(w);
  assert.equal(await code(svc.claim('default', TECH2, { id: item2.id })), 'busy');
  assert.equal((await watchOf(w, link2.sid)).driver, TECH);
  assert.deepEqual((await svc.list('default', TECH2, { status: 'mine' })).escalations.filter((e) => e.finish_pending).map((e) => e.id), [item2.id]);
  assert.equal((await svc.claim('default', TECH2, { id: item2.id })).driver, TECH2);
  // Once the reservation has lapsed, the same half-done state is only a ticket.
  const link3 = await attachedLink(w, TECH);
  const item3 = (await svc.open('default', TECH, { session_id: link3.sid })).escalation;
  failComplete(w);
  assert.equal(await code(svc.claim('default', TECH2, { id: item3.id })), 'busy');
  w.advance(60_000);
  assert.equal((await svc.claim('default', TECH2, { id: item3.id })).driver, undefined);
  assert.equal((await watchOf(w, link3.sid)).driver, TECH);
});

test('a saved PC\'s half-done claim is marked on Mine and finished by repeating it, in one generation step with the pointer', async (t) => {
  const w = await agentWorld(t);
  const svc = service(w);
  const { sid, pc } = await attached(w, LEAD);
  const item = (await svc.open('default', LEAD, { session_id: sid })).escalation;
  failComplete(w);
  assert.equal(await code(svc.claim('default', BOSS, { id: item.id })), 'busy');
  assert.deepEqual(await drivers(w, sid, pc), [BOSS, LEAD], 'the PC is ahead of the session');
  assert.deepEqual((await svc.list('default', BOSS, { status: 'mine' })).escalations.filter((e) => e.finish_pending).map((e) => e.id), [item.id]);
  const done = await svc.claim('default', BOSS, { id: item.id });
  assert.equal(done.driver, BOSS);
  const watch = await watchOf(w, sid);
  assert.deepEqual([w.pointer(pc.id).by, watch.driver, w.pointer(pc.id).gen === watch.gen], [BOSS, BOSS, true]);
  assert.equal((await w.log()).filter((r) => r.kind === 'device_session_handed_over').length, 1, 'one move, however often it was tried');
  assert.deepEqual((await svc.list('default', BOSS, { status: 'mine' })).escalations.filter((e) => e.finish_pending), []);
});

test('a team on the built-in agent only may claim a ticket, but a live claim gets mode', async (t) => {
  const w = await agentWorld(t);
  await addTech2(w);
  const { sid, pc } = await attached(w, TECH);
  const svc = service(w, 'agent');
  const live = (await svc.open('default', TECH, { session_id: sid })).escalation;
  assert.equal(await code(svc.claim('default', TECH2, { id: live.id })), 'mode');
  assert.deepEqual([items(w)[0].claimed_by, w.pointer(pc.id).by], [null, TECH]);
  const ticket = (await svc.open('default', TECH, { device_id: (await w.addPc({ name: 'Other' })).id })).escalation;
  assert.equal((await svc.claim('default', TECH2, { id: ticket.id })).escalation.claimed_by, TECH2);
  // A mode that cannot be read counts as agent-only for a live claim.
  const broken = escalationService(w.env, { agentMode: async () => { throw new Error('db'); } });
  assert.equal(await code(broken.claim('default', TECH2, { id: live.id })), 'mode');
});

// ---- closing -----------------------------------------------------------------------------------------------------
test('the claimer, the opener or an admin closes an item and the note is kept; nobody else can', async (t) => {
  const w = await agentWorld(t);
  await addTech2(w);
  const svc = service(w);
  const pc = await w.addPc();
  const open = async () => (await svc.open('default', TECH, { device_id: pc.id })).escalation;
  const a = await open();
  assert.equal(await code(svc.close('default', TECH2, { id: a.id })), 'cannot_control', 'neither opened nor claimed it');
  assert.equal(await code(svc.close('default', LEAD, { id: a.id })), 'cannot_control', 'a lead is not an admin');
  assert.equal(await code(svc.close('default', VIEW, { id: a.id })), 'permission_denied');
  w.advance(1000);
  const closedByOpener = (await svc.close('default', TECH, { id: a.id, note: 'solved before anyone came' })).escalation;
  assert.deepEqual([closedByOpener.closed_by, closedByOpener.closed_at, closedByOpener.close_note], [TECH, w.now(), 'solved before anyone came']);
  // Closing again changes nothing.
  assert.equal((await svc.close('default', BOSS, { id: a.id, note: 'again' })).escalation.close_note, 'solved before anyone came');
  const b = await open();
  await svc.claim('default', TECH2, { id: b.id });
  assert.equal((await svc.close('default', TECH2, { id: b.id, note: 'restarted the spooler' })).escalation.closed_by, TECH2);
  const c = await open();
  assert.equal((await svc.close('default', BOSS, { id: c.id })).escalation.closed_by, BOSS, 'an admin');
  assert.equal(items(w).find((r) => r.id === c.id).close_note, null);
  assert.equal((await w.log()).filter((r) => r.kind === 'escalation_closed').length, 3);
  assert.ok(!JSON.stringify(await w.log()).includes('spooler'), 'the note is not in the log');
  assert.equal(await code(svc.close('default', BOSS, { id: c.id, note: 'x'.repeat(601) })), 'bad_request');
  assert.equal(await code(svc.close('default', BOSS, { id: 'a'.repeat(20) })), 'not_found');
});

// ---- another team ------------------------------------------------------------------------------------------------
test('another team sees nothing of this queue and can claim or close nothing in it', async (t) => {
  const w = await agentWorld(t);
  await addTech2(w);
  const team = teamStore(w.db, { deploymentAdmins: BOSS });
  await team.createWorkspace(BOSS, { slug: 'acme', name: 'Acme' });
  for (const who of [TECH, TECH2]) await team.addMember('acme', BOSS, { identity: who, role_id: 'admin' });
  const { sid } = await attached(w, TECH);
  const svc = service(w);
  const item = (await svc.open('default', TECH, { session_id: sid })).escalation;
  assert.deepEqual((await svc.list('acme', TECH2, { status: 'open' })).escalations, []);
  assert.deepEqual((await svc.list('acme', TECH, { status: 'mine' })).escalations, []);
  assert.equal(await code(svc.claim('acme', TECH2, { id: item.id })), 'not_found');
  assert.equal(await code(svc.close('acme', TECH, { id: item.id })), 'not_found');
  assert.equal(await code(svc.open('acme', TECH, { session_id: sid })), 'not_found', 'the session of another team is no session');
  assert.deepEqual([items(w)[0].claimed_by, items(w)[0].closed_at], [null, null]);
  // An item of acme is invisible from default.
  const pc = await w.devs.requestJoin({ protocol: 1, workspace: 'acme', name: 'Theirs' });
  w.db.sqlite.prepare("UPDATE devices SET status = 'active', confirm_hash = NULL, expires_at = NULL WHERE id = ?").run(pc.device_id);
  const theirs = (await svc.open('acme', TECH, { device_id: pc.device_id })).escalation;
  assert.deepEqual((await svc.list('default', BOSS, { status: 'open' })).escalations.map((x) => x.id), [item.id]);
  assert.equal(await code(svc.claim('default', BOSS, { id: theirs.id })), 'not_found');
  assert.equal((await svc.list('acme', TECH2, { status: 'open' })).escalations.length, 1);
});

test('the escalation tool: open, list mine, claim a live session and close, with the shapes the app reads', async (t) => {
  const w = await agentWorld(t);
  await addTech2(w);
  const { sid, pc } = await attached(w, TECH);
  const opened = await w.tool(TECH, 'escalation', { action: 'open', session_id: sid, note: 'Needs the vendor tool' });
  assert.deepEqual(Object.keys(opened.escalation).sort(), ['claimed_at', 'claimed_by', 'close_note', 'closed_at', 'closed_by', 'device_id', 'device_name', 'id', 'kind', 'note', 'opened_at', 'opened_by', 'session_id', 'summary', 'task_id']);
  assert.match(opened.untrusted_text, /untrusted|data/i);
  assert.deepEqual((await w.tool(TECH, 'escalation', { action: 'list', status: 'mine' })).escalations.map((x) => x.id), [opened.escalation.id]);
  assert.deepEqual((await w.tool(TECH2, 'escalation', { action: 'list' })).escalations.map((x) => x.id), [opened.escalation.id]);
  assert.deepEqual((await w.tool(TECH2, 'escalation', { action: 'list', status: 'mine' })).escalations, []);
  assert.match((await w.tool(TECH2, 'escalation', { action: 'list', status: 'everything' })).error, /^bad_request: status must be/);
  const claimed = await w.tool(TECH2, 'escalation', { action: 'claim', id: opened.escalation.id });
  assert.deepEqual([claimed.driver, claimed.session_id, claimed.device_id, claimed.escalation.claimed_by], [TECH2, sid, pc.id, TECH2]);
  assert.deepEqual((await w.tool(TECH2, 'escalation', { action: 'list', status: 'mine' })).escalations.map((x) => x.id), [opened.escalation.id]);
  assert.deepEqual((await w.tool(TECH2, 'escalation', { action: 'list' })).escalations, []);
  const closed = await w.tool(TECH2, 'escalation', { action: 'close', id: opened.escalation.id, note: 'Vendor tool run' });
  assert.deepEqual([closed.escalation.closed_by, closed.escalation.close_note], [TECH2, 'Vendor tool run']);
  assert.match((await w.tool(TECH, 'escalation', { action: 'claim', id: opened.escalation.id })).error, /^already_claimed: /);
  assert.equal((await w.tool(BOSS, 'escalation', { action: 'list', status: 'closed' })).escalations.length, 1);
});

// ---- a stuck agent's summary --------------------------------------------------------------------------------
const shotCall = () => oai.call('screenshot', { display: null });
const finishCall = (outcome, summary) => oai.call('finish', { outcome, summary });

test('a task that finishes with "needs a person" opens exactly one item with its summary, for the PC it worked on', async (t) => {
  const w = await agentWorld(t);
  await addTech2(w);
  await w.ready();
  const a = await w.startOnPc(TECH, { keep_working: true });
  w.fake.queue('openai', shotCall(), finishCall('needs_human', 'The sign-in needs a password I do not have.'));
  await w.drive(a.id);
  assert.equal(w.taskRow(a.id).state, 'stuck');
  assert.equal(w.taskRow(a.id).end_reason, 'finished: needs a person');
  const [row, ...rest] = items(w);
  assert.equal(rest.length, 0, 'one item');
  assert.deepEqual([row.kind, row.device_id, row.task_id, row.summary, row.note, row.opened_by, row.claimed_by, row.closed_at], ['agent', a.pc.id, a.id, 'The sign-in needs a password I do not have.', null, TECH, null, null]);
  assert.equal(row.session_id, null, 'the task opened its session and ended it');
  assert.equal(row.opened_at, w.taskRow(a.id).ended_at);
  // It is in the open list, with the PC's name.
  const listed = (await service(w).list('default', BOSS, {})).escalations;
  assert.deepEqual(listed.map((x) => [x.id, x.kind, x.device_name, x.summary]), [[row.id, 'agent', 'Till', row.summary]]);
  // The team log: the end and the item, in that order, names and ids only.
  const kinds = (await w.log()).map((r) => r.kind).filter((k) => k === 'agent_task_ended' || k === 'escalation_opened');
  assert.deepEqual(kinds, ['agent_task_ended', 'escalation_opened']);
  assert.ok(!JSON.stringify(await w.log()).includes('password'));
  // The others who control sessions are told once; the starter has their own "task needs attention".
  assert.deepEqual(notes(w, 'escalation_opened').map((n) => [n.recipient, n.task_id, n.device_id, n.session_id]).sort(), [BOSS, LEAD, TECH2].sort().map((r) => [r, a.id, a.pc.id, null]));
  assert.deepEqual(w.sql("SELECT recipient FROM notifications WHERE event = 'task_problem'").map((r) => r.recipient), [TECH]);
  // Anyone free claims it: a ticket, which names the PC.
  const got = await service(w).claim('default', TECH2, { id: row.id });
  assert.deepEqual([got.device_id, got.device_name, got.escalation.claimed_by, got.escalation.summary], [a.pc.id, 'Till', TECH2, row.summary]);
  assert.deepEqual(notes(w, 'escalation_claimed').map((n) => [n.recipient, n.task_id]), [[TECH, a.id]]);
});

test('only "needs a person" opens an item: done, stuck and a time limit open nothing', async (t) => {
  const w = await agentWorld(t);
  await w.ready();
  const done = await w.startOnPc(TECH, { keep_working: true });
  w.fake.queue('openai', shotCall(), finishCall('done', 'all good'));
  await w.drive(done.id);
  const stuck = await w.startOnPc(TECH, { keep_working: true }, { pc: await w.addPc({ access: 'any', name: 'Stuck' }) });
  w.fake.queue('openai', shotCall(), finishCall('stuck', 'tried everything'));
  await w.drive(stuck.id);
  // The two-hour limit.
  const slow = await w.startOnPc(TECH, { keep_working: true }, { pc: await w.addPc({ access: 'any', name: 'Slow' }) });
  w.fake.queue('openai', shotCall(), shotCall());
  await w.alarm(slow.id);
  w.advance(2 * 3600_000 + 1000);
  await w.drive(slow.id);
  assert.deepEqual([w.taskRow(done.id).state, w.taskRow(stuck.id).state, w.taskRow(slow.id).state, w.taskRow(slow.id).end_reason], ['done', 'stuck', 'stuck', 'reached the limit of 2 hours']);
  assert.equal(items(w).length, 0);
  assert.equal(notes(w, 'escalation_opened').length, 0);
});

test('a task given a session it leaves open carries that session in its item; the item and the end commit together or not at all', async (t) => {
  const w = await agentWorld(t);
  await w.ready();
  const pc = await w.addPc({ access: 'any', name: 'Given' });
  const { sid } = await w.attach(pc, TECH);
  const started = await w.tool(TECH, 'agent_start', { session_id: sid, instructions: 'Check the printer.', keep_working: true });
  assert.equal(started.error, undefined, JSON.stringify(started));
  const pump = w.pump({ sid, key: pc.key, generation: (await w.agent(sid, pc.key, { type: 'hello', control: 'full', caps: ['screen', 'lanes'] })).body.generation });
  t.after(() => pump.stop());
  // The end fails after the item was written: nothing stays.
  w.db.sqlite.exec("CREATE TRIGGER no_end BEFORE UPDATE ON agent_tasks WHEN NEW.state = 'stuck' BEGIN SELECT RAISE(ABORT, 'the end failed'); END");
  w.fake.queue('openai', shotCall(), finishCall('needs_human', 'Needs the owner to approve a prompt.'));
  await w.alarm(started.task_id);
  await w.alarm(started.task_id); // finish: the batch fails
  assert.equal(w.taskRow(started.task_id).ended_at, null, 'the task did not end');
  assert.equal(items(w).length, 0, 'and the item was not written');
  assert.equal((await w.log()).filter((r) => r.kind === 'escalation_opened' || r.kind === 'agent_task_ended').length, 0);
  assert.equal(notes(w, 'escalation_opened').length, 0);
  // It tries again once the database works, and writes one item.
  w.db.sqlite.exec('DROP TRIGGER no_end');
  w.fake.queue('openai', shotCall(), finishCall('needs_human', 'Needs the owner to approve a prompt.'));
  await w.drive(started.task_id);
  assert.equal(w.taskRow(started.task_id).state, 'stuck');
  const [row, ...rest] = items(w);
  assert.equal(rest.length, 0);
  assert.deepEqual([row.session_id, row.device_id, row.summary], [sid, pc.id, 'Needs the owner to approve a prompt.']);
  assert.equal(w.stateOf(sid), 'attached', 'a session it was given stays open');
  assert.equal(w.pointer(pc.id).by, TECH);
  // The item is a live session its opener still drives: whoever is free takes it over.
  await addTech2(w);
  const got = await service(w).claim('default', TECH2, { id: row.id });
  assert.equal(got.driver, TECH2);
  assert.equal(w.pointer(pc.id).by, TECH2);
});

test('an agent item is unique per task, even if the end is recorded twice', async (t) => {
  const w = await agentWorld(t);
  await w.ready();
  const a = await w.startOnPc(TECH, { keep_working: true });
  w.fake.queue('openai', shotCall(), finishCall('needs_human', 'Help.'));
  await w.drive(a.id);
  const store = (await import('../src/agent-store.js')).agentStoreFromEnv(w.env);
  assert.deepEqual(await store.endTask('default', a.id, { state: 'stuck', reason: 'again', summary: 'again', escalate: true }), { ended: false });
  assert.equal(items(w).length, 1);
  assert.throws(() => w.db.sqlite.prepare("INSERT INTO escalations(workspace, id, kind, task_id, opened_by, opened_at) VALUES ('default', ?, 'agent', ?, ?, 1)").run('b'.repeat(20), a.id, TECH), /UNIQUE/);
});
