// The team's rules over the team API (/api/v1/w/<slug>/rules and /rules/<customer id>) and at the PC's
// check-in: who may read and save, the fresh authenticator code, revisions, validation, the log, the ring to
// the PCs a change reaches, and the rules a PC receives with its customer's override. Also the technician app's
// way to the same routes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, BOSS, TECH, VIEW, LEAD, OTHER, SECRET } from './device-sessions-world.js';
import { appWorld, skip } from './app-world.js';
import { accountStore } from '../src/accounts.js';
import { totp } from '../src/totp.js';
import { DEFAULT_RULES } from '../src/rules.js';

const KEY = new Uint8Array(20).fill(7);
const DEFAULTS = { ...DEFAULT_RULES, protected_programs: [], protected_folders: [] };
const HOURS = { mon: ['08:00', '18:00'], tue: ['08:00', '18:00'], wed: ['08:00', '18:00'], thu: ['08:00', '18:00'], fri: ['08:00', '13:00'], sun: ['08:00', '18:00'] };

// Give a member an authenticator, as the sign-in pages would leave it.
async function enrol(w, email, key = KEY) {
  const accounts = accountStore(w.db, { secret: SECRET });
  const { user } = await accounts.userForEmail(email, async () => true);
  await accounts.saveFactor(user.id, key, 1, { replace: false });
  return user.id;
}

// The code the authenticator shows now. A code works once, so each save moves the clock on to the next step.
async function fresh(w, key = KEY) {
  w.advance(30_000);
  return totp(key, w.now());
}

// A save of the team's rules (customer null) or a customer's override, with a fresh code.
async function save(w, who, customer, doc, rev, extra = {}) {
  const code = Object.hasOwn(extra, 'code') ? extra.code : await fresh(w);
  return w.api(who, 'PATCH', customer ? `/rules/${customer}` : '/rules', { doc, rev, code, ...extra.body });
}

async function ready(t, opts) {
  const w = await world(t, opts);
  await enrol(w, BOSS);
  return w;
}

// A customer with a site and a PC on it, and the PC's doorbell connected.
async function customerWithPc(w, name = 'Acme Ltd') {
  const customer = (await w.api(BOSS, 'POST', '/customers', { name })).body.customer.id;
  const site = (await w.api(BOSS, 'POST', '/sites', { name: 'Main', customer_id: customer })).body.site.id;
  const pc = await w.addPc({ name: `${name} till` });
  assert.equal((await w.api(BOSS, 'PATCH', `/devices/${pc.id}`, { site_id: site, code: await fresh(w) })).status, 200);
  const bell = w.ringSocket(pc.id);
  return { customer, site, pc, bell };
}

const helloRules = async (w, pc) => (await w.hello(pc.key)).body;
const rings = (w) => w.registryCalls.filter((c) => c.path === '/ring').length;

// ---- reading ------------------------------------------------------------------------------------
test('anyone who sees devices reads the team rules: the defaults with revision 0 until a save', async (t) => {
  const w = await ready(t);
  for (const who of [BOSS, TECH, VIEW, LEAD]) {
    const r = await w.api(who, 'GET', '/rules');
    assert.equal(r.status, 200, who);
    assert.deepEqual(r.body, { rules: { rev: 0, doc: DEFAULTS, updated_at: null, updated_by: null }, overrides: [], default_time_zone: 'UTC' }, who);
  }
  assert.equal((await w.api('stranger@example.com', 'GET', '/rules')).status, 403);
  const zoned = await ready(t, { env: { DEFAULT_TIME_ZONE: 'Asia/Jerusalem' } });
  assert.equal((await zoned.api(BOSS, 'GET', '/rules')).body.default_time_zone, 'Asia/Jerusalem');
  const typo = await ready(t, { env: { DEFAULT_TIME_ZONE: 'Mars/Base' } });
  assert.equal((await typo.api(BOSS, 'GET', '/rules')).body.default_time_zone, 'UTC');
});

test('a workspace with no members answers no rules route but a 403', async (t) => {
  const w = await world(t, { members: false });
  assert.equal((await w.api(BOSS, 'GET', '/rules')).status, 403);
  const patch = await w.api(BOSS, 'PATCH', '/rules', { doc: {}, rev: 0, code: '123456' });
  assert.deepEqual([patch.status, patch.body.error.code], [409, 'first_member']);
});

// ---- saving: who, and what a save needs ------------------------------------------------------------
test('saving needs rules.manage: admins have it, a technician, a viewer and a lead do not', async (t) => {
  const w = await ready(t);
  for (const who of [TECH, VIEW, LEAD, OTHER]) {
    const r = await w.api(who, 'PATCH', '/rules', { doc: {}, rev: 0, code: await fresh(w) });
    assert.equal(r.status, 403, who);
  }
  assert.deepEqual((await w.api(TECH, 'PATCH', '/rules', { doc: {}, rev: 0, code: '000000' })).body.error.code, 'permission_denied');
  assert.equal((await w.api(TECH, 'DELETE', '/rules/aaaaaaaaaaaaaaaaaaaa', { code: '000000' })).status, 403);
  assert.equal((await save(w, BOSS, null, { restart: 'never' }, 0)).status, 200);
  // A custom role can be given it.
  await w.team.addRole('default', BOSS, { id: 'rules-only', permissions: ['devices.view', 'rules.manage'] });
  await w.team.addMember('default', BOSS, { identity: OTHER, role_id: 'rules-only' });
  await enrol(w, OTHER, new Uint8Array(20).fill(9));
  const r = await w.api(OTHER, 'PATCH', '/rules', { doc: { restart: 'allow' }, rev: 1, code: await fresh(w, new Uint8Array(20).fill(9)) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.rules.updated_by, OTHER);
});

test('a save needs a fresh code from the caller\'s own authenticator, used once, and never a recovery code', async (t) => {
  const w = await ready(t);
  const sent = (code) => w.api(BOSS, 'PATCH', '/rules', { doc: { restart: 'never' }, rev: 0, code });
  const kinds = async () => (await w.log()).map((r) => r.kind);
  const before = (await kinds()).length;
  assert.deepEqual([(await w.api(BOSS, 'PATCH', '/rules', { doc: {}, rev: 0 })).status], [400], 'no code');
  assert.equal((await sent(12345)).status, 400, 'not text');
  for (const wrong of ['000000', '', ' ']) {
    const r = await sent(wrong);
    assert.ok([400, 403].includes(r.status), wrong);
  }
  assert.equal((await sent('000000')).body.error.code, 'second_factor');
  assert.equal((await kinds()).length, before, 'nothing was saved');
  // A recovery code is not a code from the authenticator.
  const accounts = accountStore(w.db, { secret: SECRET });
  const user = await accounts.userByEmail(BOSS);
  const codes = await accounts.saveFactor(user.id, KEY, 1, { replace: true });
  const lock = await sent(codes[0]);
  assert.equal(lock.status, 403, 'a recovery code does not save rules');
  assert.equal((await accounts.recoveryLeft(user.id)), codes.length, 'and is not used up');
  const code = await fresh(w);
  assert.equal((await sent(code)).status, 200);
  // The same code again, in the same step, is refused: it was used.
  const again = await w.api(BOSS, 'PATCH', '/rules', { doc: { restart: 'allow' }, rev: 1, code });
  assert.deepEqual([again.status, again.body.error.code], [403, 'second_factor']);
  assert.equal((await w.api(BOSS, 'GET', '/rules')).body.rules.doc.restart, 'never', 'the second save did not happen');
  // A code the sign-in page used is used up for rules too, and the other way round.
  const signIn = await fresh(w);
  assert.equal((await accounts.verifyFactor(user.id, signIn)).ok, true);
  assert.equal((await w.api(BOSS, 'PATCH', '/rules', { doc: { restart: 'allow' }, rev: 1, code: signIn })).status, 403);
  // Five wrong codes lock the authenticator, and then even a right one is refused.
  for (let i = 0; i < 5; i++) await w.api(BOSS, 'PATCH', '/rules', { doc: { restart: 'allow' }, rev: 1, code: '000000' });
  const locked = await w.api(BOSS, 'PATCH', '/rules', { doc: { restart: 'allow' }, rev: 1, code: await fresh(w) });
  assert.deepEqual([locked.status, locked.body.error.code], [429, 'locked']);
});

test('a member with no authenticator cannot save, and the code is checked for the caller, not for anyone', async (t) => {
  const w = await ready(t);
  await w.team.addMember('default', BOSS, { identity: OTHER, role_id: 'admin' });
  const none = await w.api(OTHER, 'PATCH', '/rules', { doc: {}, rev: 0, code: await fresh(w) });
  assert.deepEqual([none.status, none.body.error.code], [403, 'second_factor']);
  // BOSS's code is no use to OTHER, who has an authenticator of their own.
  await enrol(w, OTHER, new Uint8Array(20).fill(5));
  const theirs = await w.api(OTHER, 'PATCH', '/rules', { doc: {}, rev: 0, code: await fresh(w, KEY) });
  assert.equal(theirs.status, 403);
  assert.equal((await w.api(OTHER, 'PATCH', '/rules', { doc: {}, rev: 0, code: await fresh(w, new Uint8Array(20).fill(5)) })).status, 200);
});

test('a document that cannot be saved is refused before the code is spent, and a stale rev is 409', async (t) => {
  const w = await ready(t);
  const code = await fresh(w);
  const bad = async (doc, extra = {}) => w.api(BOSS, 'PATCH', '/rules', { doc, rev: 0, code, ...extra });
  for (const [doc, message] of [
    [{ time_zone: 'Mars/Base' }, /time_zone/],
    [{ restart: 'outside_hours' }, /needs business hours/],
    [{ hours: { mon: ['18:00', '08:00'] } }, /end after/],
    [{ unknown: 1 }, /unknown rules field/],
    [{ protected_folders: ['relative'] }, /absolute/],
    [{ protected_folders: ['C:\\'] }, /not a whole drive/],
    [{ protected_folders: ['C:\\Customer Data', 'd:/'] }, /not a whole drive/],
  ]) {
    const r = await bad(doc);
    assert.deepEqual([r.status, r.body.error.code], [400, 'bad_request'], JSON.stringify(doc));
    assert.match(r.body.error.message, message);
  }
  assert.equal((await bad(null)).status, 400);
  assert.equal((await bad([])).status, 400);
  assert.equal((await w.api(BOSS, 'PATCH', '/rules', { rev: 0, code })).status, 400, 'no doc');
  assert.equal((await w.api(BOSS, 'PATCH', '/rules', { doc: {}, code })).status, 400, 'no rev');
  for (const rev of [-1, 1.5, '0', null]) assert.equal((await bad({}, { rev })).status, 400, `rev ${rev}`);
  // The code was not spent on any of those.
  assert.equal((await bad({ restart: 'never' })).status, 200);
  // A stale rev: the rules are at 1 now, and a save that read 0 is refused, again without spending its code.
  const stale = await fresh(w);
  const r = await w.api(BOSS, 'PATCH', '/rules', { doc: { restart: 'allow' }, rev: 0, code: stale });
  assert.deepEqual([r.status, r.body.error.code], [409, 'stale']);
  assert.equal((await w.api(BOSS, 'PATCH', '/rules', { doc: { restart: 'allow' }, rev: 1, code: stale })).status, 200);
});

test('the body is limited to 32 KB, and only PATCH writes the team rules', async (t) => {
  const w = await ready(t);
  const big = { doc: { protected_programs: ['a'], pad: 'x'.repeat(33_000) }, rev: 0, code: await fresh(w) };
  assert.equal((await w.api(BOSS, 'PATCH', '/rules', big)).status, 400);
  for (const method of ['POST', 'DELETE']) {
    const r = await w.api(BOSS, method, '/rules', { doc: {}, rev: 0, code: await fresh(w) });
    assert.equal(r.status, 405, method);
  }
  // A list of 50 programs and 50 folders at their longest fits well inside it.
  const doc = { protected_programs: Array.from({ length: 50 }, (_, i) => `${'p'.repeat(95)}${String(i).padStart(5, '0')}`), protected_folders: Array.from({ length: 50 }, (_, i) => `C:\\${'f'.repeat(250)}${String(i).padStart(2, '0')}`) };
  const r = await save(w, BOSS, null, doc, 0);
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
});

// ---- what a save does ------------------------------------------------------------------------------
test('a save stores the whole document, bumps the revision, logs only field names, and rings every PC', async (t) => {
  const w = await ready(t);
  const a = await customerWithPc(w, 'Acme Ltd');
  const loose = await w.addPc({ name: 'No customer' });
  const looseBell = w.ringSocket(loose.id);
  const doc = { time_zone: 'Asia/Jerusalem', hours: HOURS, restart: 'approve_in_hours', protected_programs: ['Outlook.exe'], protected_folders: ['C:\\Customer Data'] };
  const r = await save(w, BOSS, null, doc, 0);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.rules, { rev: 1, doc: { ...DEFAULTS, ...doc }, updated_at: w.now(), updated_by: BOSS });
  assert.deepEqual((await w.api(BOSS, 'GET', '/rules')).body.rules, r.body.rules);
  // Logged by the names of what changed.
  const row = (await w.log()).filter((x) => x.kind === 'rules_changed').at(-1);
  assert.equal(row.actor, BOSS);
  assert.equal(row.detail, 'team: time_zone, hours, restart, protected_programs, protected_folders');
  const everything = JSON.stringify(await w.log());
  for (const secret of ['Outlook.exe', 'Customer Data', 'Asia/Jerusalem', '08:00']) assert.equal(everything.includes(secret), false, secret);
  // Every PC of the team was rung, not only the customer's.
  assert.deepEqual([a.bell.sent.length, looseBell.sent.length], [1, 1]);
  // The same document again changes nothing: no revision, no log row, no ring.
  const logged = (await w.log()).length;
  const same = await save(w, BOSS, null, doc, 1);
  assert.equal(same.status, 200);
  assert.equal(same.body.rules.rev, 1);
  assert.equal((await w.log()).length, logged);
  assert.deepEqual([a.bell.sent.length, looseBell.sent.length], [1, 1]);
  // Only what differs is named the next time.
  await save(w, BOSS, null, { ...doc, shutdown: 'never' }, 1);
  assert.equal((await w.log()).filter((x) => x.kind === 'rules_changed').at(-1).detail, 'team: shutdown');
  // A role that loses rules.manage between the read and the write cannot save.
  assert.equal((await w.api(BOSS, 'GET', '/rules')).body.rules.rev, 2);
});

// ---- moving a PC between customers changes its rules (PR 9 review) --------------------------------------
test('moving an active PC to another customer, or to no site, needs rules.manage and a fresh code, logs rules_changed and rings the PC', async (t) => {
  const w = await ready(t);
  const a = await customerWithPc(w, 'Acme Ltd');
  const otherCustomer = (await w.api(BOSS, 'POST', '/customers', { name: 'Bravo Ltd' })).body.customer.id;
  const bravo = (await w.api(BOSS, 'POST', '/sites', { name: 'B1', customer_id: otherCustomer })).body.site.id;
  const second = (await w.api(BOSS, 'POST', '/sites', { name: 'Second', customer_id: a.customer })).body.site.id;
  const siteOf = async () => (await w.api(BOSS, 'GET', `/devices/${a.pc.id}`)).body.device.site_id;
  const rung = a.bell.sent.length;
  // devices.manage alone is not enough: a technician is refused, and the PC stays put.
  const tech = await w.api(TECH, 'PATCH', `/devices/${a.pc.id}`, { site_id: bravo, code: '123456' });
  assert.deepEqual([tech.status, tech.body.error.code], [403, 'permission_denied']);
  // The admin needs a code, and a wrong or missing one moves nothing.
  const none = await w.api(BOSS, 'PATCH', `/devices/${a.pc.id}`, { site_id: bravo });
  assert.deepEqual([none.status, none.body.error.code], [400, 'bad_request']);
  const wrong = await w.api(BOSS, 'PATCH', `/devices/${a.pc.id}`, { site_id: bravo, code: '000000' });
  assert.deepEqual([wrong.status, wrong.body.error.code], [403, 'second_factor']);
  assert.equal(await siteOf(), a.site);
  // A site that is not there is refused before a code is spent.
  const unknown = await w.api(BOSS, 'PATCH', `/devices/${a.pc.id}`, { site_id: 'a'.repeat(20), code: await fresh(w) });
  assert.deepEqual([unknown.status, unknown.body.error.code], [400, 'unknown_site']);
  // Within the customer, devices.manage is enough and there is no ring.
  assert.equal((await w.api(TECH, 'PATCH', `/devices/${a.pc.id}`, { site_id: second })).status, 200);
  assert.equal(a.bell.sent.length, rung);
  // To another customer, with a code: moved, logged both ways, rung once.
  const ok = await w.api(BOSS, 'PATCH', `/devices/${a.pc.id}`, { site_id: bravo, code: await fresh(w) });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(await siteOf(), bravo);
  const kinds = (await w.log()).map((x) => x.kind);
  assert.deepEqual(kinds.slice(-2).sort(), ['device_changed', 'rules_changed']);
  assert.equal(a.bell.sent.length, rung + 1);
  // The code was spent: the same one does not move it again.
  const reuse = await w.api(BOSS, 'PATCH', `/devices/${a.pc.id}`, { site_id: null, code: await totp(KEY, w.now()) });
  assert.deepEqual([reuse.status, reuse.body.error.code], [403, 'second_factor']);
  // To no site, also with a code.
  assert.equal((await w.api(BOSS, 'PATCH', `/devices/${a.pc.id}`, { site_id: null, code: await fresh(w) })).status, 200);
  assert.equal(await siteOf(), null);
  assert.equal(a.bell.sent.length, rung + 2);
  // The code is not part of the PC's record, and a field change needs none.
  assert.equal((await w.api(TECH, 'PATCH', `/devices/${a.pc.id}`, { owner_contact: 'x@example.com' })).status, 200);
});

test('a PC waiting for approval takes a site with devices.manage alone, since no rules apply to it yet', async (t) => {
  const w = await ready(t);
  const customer = (await w.api(BOSS, 'POST', '/customers', { name: 'Acme Ltd' })).body.customer.id;
  const site = (await w.api(BOSS, 'POST', '/sites', { name: 'Main', customer_id: customer })).body.site.id;
  const pending = await w.addPc({ status: 'pending' });
  assert.equal((await w.api(TECH, 'PATCH', `/devices/${pending.id}`, { site_id: site })).status, 200);
});

test('the PC\'s hello carries the effective rules, hours and clock, and a team change moves the tag', async (t) => {
  const w = await ready(t);
  const { pc } = await customerWithPc(w);
  const first = await helloRules(w, pc);
  assert.deepEqual(first.rules, { rev: 0, ...DEFAULTS, time_zone: 'UTC' });
  await save(w, BOSS, null, { time_zone: 'Asia/Jerusalem', hours: HOURS, restart: 'outside_hours' }, 0);
  const now = await helloRules(w, pc);
  assert.equal(now.rules.rev, 1);
  assert.equal(now.rules.time_zone, 'Asia/Jerusalem');
  assert.equal(now.rules.restart, 'outside_hours');
  assert.notEqual(now.rules_tag, first.rules_tag);
  assert.equal(now.server_time, Math.floor(w.now() / 1000));
  assert.equal(now.hours_until, now.server_time + 8 * 86400);
  assert.ok(now.hours_utc.length >= 5 && now.hours_utc.every(([s, e]) => e > s && e > now.server_time && s < now.hours_until));
  // Nothing else changes the tag: a hello again says the same.
  assert.equal((await helloRules(w, pc)).rules_tag, now.rules_tag);
  // A waiting PC is sent no rules.
  const waiting = await w.addPc({ status: 'pending' });
  const answer = await helloRules(w, waiting);
  for (const field of ['rules', 'rules_tag', 'hours_utc', 'hours_until', 'server_time']) assert.equal(Object.hasOwn(answer, field), false, field);
});

test('DEFAULT_TIME_ZONE is the zone of rules that name none, and changing it changes the tag', async (t) => {
  const w = await ready(t, { env: { DEFAULT_TIME_ZONE: 'Asia/Jerusalem' } });
  const { pc } = await customerWithPc(w);
  const jl = await helloRules(w, pc);
  assert.equal(jl.rules.time_zone, 'Asia/Jerusalem');
  w.env.DEFAULT_TIME_ZONE = 'America/New_York';
  const ny = await helloRules(w, pc);
  assert.equal(ny.rules.time_zone, 'America/New_York');
  assert.notEqual(jl.rules_tag, ny.rules_tag);
  await save(w, BOSS, null, { time_zone: 'Europe/Paris' }, 0);
  assert.equal((await helloRules(w, pc)).rules.time_zone, 'Europe/Paris', 'the team\'s own zone beats the deployment\'s');
});

// ---- customer overrides ----------------------------------------------------------------------------
test('a customer override changes only that customer\'s PCs, rings only them, and removing it restores the team\'s rules', async (t) => {
  const w = await ready(t);
  const a = await customerWithPc(w, 'Acme Ltd');
  const b = await customerWithPc(w, 'Bravo Ltd');
  const loose = await w.addPc({ name: 'No site' });
  const looseBell = w.ringSocket(loose.id);
  await save(w, BOSS, null, { restart: 'allow', protected_programs: ['Outlook.exe'], hours: HOURS }, 0);
  for (const s of [a.bell, b.bell, looseBell]) s.sent.length = 0;
  const calls = rings(w);

  const put = await save(w, BOSS, a.customer, { restart: 'never', protected_programs: ['Sage.exe'] }, 0);
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.deepEqual(put.body.override, { customer_id: a.customer, rev: 1, doc: { restart: 'never', protected_programs: ['Sage.exe'] }, updated_at: w.now(), updated_by: BOSS });
  assert.deepEqual([a.bell.sent.length, b.bell.sent.length, looseBell.sent.length], [1, 0, 0], 'only that customer\'s PC was rung');
  assert.equal(rings(w) - calls, 1, 'in one call');

  const mine = await helloRules(w, a.pc);
  const theirs = await helloRules(w, b.pc);
  const nobody = await helloRules(w, loose);
  assert.deepEqual([mine.rules.restart, mine.rules.protected_programs, mine.rules.hours], ['never', ['Sage.exe'], HOURS], 'a field the override sets replaces; the rest is the team\'s');
  assert.deepEqual([theirs.rules.restart, theirs.rules.protected_programs], ['allow', ['Outlook.exe']]);
  assert.deepEqual([nobody.rules.restart, nobody.rules.protected_programs], ['allow', ['Outlook.exe']], 'a PC with no site has the team\'s');
  assert.equal(mine.rules.rev, 2, 'the two revisions added');
  assert.notEqual(mine.rules_tag, theirs.rules_tag);
  assert.equal(theirs.rules_tag, nobody.rules_tag);

  // The listing and the customer's own view.
  const list = (await w.api(BOSS, 'GET', '/rules')).body;
  assert.deepEqual(list.overrides.map((o) => [o.customer_id, o.rev]), [[a.customer, 1]]);
  const one = (await w.api(BOSS, 'GET', `/rules/${a.customer}`)).body;
  assert.deepEqual([one.customer_id, one.rev, one.doc, one.effective.restart], [a.customer, 1, { restart: 'never', protected_programs: ['Sage.exe'] }, 'never']);
  assert.deepEqual((await w.api(BOSS, 'GET', `/rules/${b.customer}`)).body.doc, {}, 'no row: no override');
  assert.equal((await w.api(BOSS, 'GET', `/rules/${b.customer}`)).body.rev, 0);
  assert.equal((await w.api(TECH, 'GET', `/rules/${a.customer}`)).status, 200);

  // The log names the customer and the fields, nothing more.
  assert.equal((await w.log()).filter((x) => x.kind === 'rules_changed').at(-1).detail, `customer ${a.customer}: restart, protected_programs`);
  assert.equal(JSON.stringify(await w.log()).includes('Sage.exe'), false);

  // Removing it restores the team's rules, rings that customer's PCs, and takes a code and the revision.
  for (const s of [a.bell, b.bell, looseBell]) s.sent.length = 0;
  const stale = await w.api(BOSS, 'DELETE', `/rules/${a.customer}`, { rev: 0, code: await fresh(w) });
  assert.deepEqual([stale.status, stale.body.error.code], [409, 'stale']);
  assert.equal((await w.api(BOSS, 'DELETE', `/rules/${a.customer}`, { code: '000000' })).status, 403, 'a code is needed');
  const gone = await w.api(BOSS, 'DELETE', `/rules/${a.customer}`, { rev: 1, code: await fresh(w) });
  assert.deepEqual([gone.status, gone.body], [200, { removed: { customer_id: a.customer } }]);
  assert.deepEqual([a.bell.sent.length, b.bell.sent.length], [1, 0]);
  assert.equal((await helloRules(w, a.pc)).rules.restart, 'allow');
  assert.equal((await w.log()).filter((x) => x.kind === 'rules_changed').at(-1).detail, `customer ${a.customer}: override removed (restart, protected_programs)`);
  // Removing one that is not there changes nothing and rings nothing.
  const logged = (await w.log()).length;
  assert.equal((await w.api(BOSS, 'DELETE', `/rules/${a.customer}`, { code: await fresh(w) })).status, 200);
  assert.equal((await w.log()).length, logged);
  assert.equal(a.bell.sent.length, 1);
});

test('a removal that cannot be done is refused before the code is spent', async (t) => {
  const w = await ready(t);
  const a = await customerWithPc(w);
  const b = await customerWithPc(w, 'Bravo Ltd');
  assert.equal((await save(w, BOSS, a.customer, { restart: 'never' }, 0)).status, 200);
  const code = await fresh(w);
  const stale = await w.api(BOSS, 'DELETE', `/rules/${a.customer}`, { rev: 0, code });
  assert.deepEqual([stale.status, stale.body.error.code], [409, 'stale']);
  const unknown = await w.api(BOSS, 'DELETE', `/rules/${'z'.repeat(20)}`, { rev: 1, code });
  assert.deepEqual([unknown.status, unknown.body.error.code], [404, 'not_found']);
  // Nothing to remove is no change, and spends nothing either.
  assert.equal((await w.api(BOSS, 'DELETE', `/rules/${b.customer}`, { rev: 0, code })).status, 200);
  // The code still works.
  assert.equal((await w.api(BOSS, 'DELETE', `/rules/${a.customer}`, { rev: 1, code })).status, 200);
  assert.equal((await w.api(BOSS, 'GET', `/rules/${a.customer}`)).body.effective.restart, DEFAULTS.restart);
});

test('an override\'s revision never repeats: a save that read an override removed since then is stale against a new one', async (t) => {
  const w = await ready(t);
  const a = await customerWithPc(w);
  assert.equal((await save(w, BOSS, a.customer, { restart: 'never' }, 0)).body.override.rev, 1);
  // Another admin read rev 1 and is still holding it. The override is removed, then made again.
  assert.equal((await w.api(BOSS, 'DELETE', `/rules/${a.customer}`, { rev: 1, code: await fresh(w) })).status, 200);
  const none = (await w.api(BOSS, 'GET', `/rules/${a.customer}`)).body;
  assert.deepEqual([none.rev, none.doc, none.updated_by], [0, {}, null], 'a removed override reads as none');
  assert.deepEqual((await w.api(BOSS, 'GET', '/rules')).body.overrides, [], 'and is not listed');
  assert.equal((await save(w, BOSS, a.customer, { restart: 'never' }, 1)).status, 409, 'the old rev is stale while there is none');
  const again = await save(w, BOSS, a.customer, { shutdown: 'never' }, 0);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.ok(again.body.override.rev > 1, `a new revision: ${again.body.override.rev}`);
  // The save that read the first override is stale, and cannot loosen the new one.
  const late = await save(w, BOSS, a.customer, { restart: 'allow' }, 1);
  assert.deepEqual([late.status, late.body.error.code], [409, 'stale']);
  const now = (await w.api(BOSS, 'GET', `/rules/${a.customer}`)).body;
  assert.deepEqual([now.rev, now.doc], [again.body.override.rev, { shutdown: 'never' }]);
  // The effective revision the PC is shown never went back: 1 with the first override, 2 once removed, 3 now.
  assert.deepEqual([none.effective.rev, now.effective.rev], [2, 3]);
  assert.deepEqual((await w.api(BOSS, 'GET', '/rules')).body.overrides.map((o) => [o.customer_id, o.rev]), [[a.customer, again.body.override.rev]]);
  assert.equal((await helloRules(w, a.pc)).rules.shutdown, 'never');
  // Saving an override with no fields removes it the same way.
  assert.deepEqual((await save(w, BOSS, a.customer, {}, again.body.override.rev)).body.override.rev, 0);
  assert.equal((await w.api(BOSS, 'GET', `/rules/${a.customer}`)).body.rev, 0);
  assert.equal((await save(w, BOSS, a.customer, { restart: 'never' }, again.body.override.rev)).status, 409);
});

test('an override is judged with the team\'s rules, may not name a customer that is not there, and goes with its customer', async (t) => {
  const w = await ready(t);
  const a = await customerWithPc(w);
  // An hour rule needs hours from the override or the team.
  const noHours = await save(w, BOSS, a.customer, { restart: 'outside_hours' }, 0);
  assert.deepEqual([noHours.status, noHours.body.error.code], [400, 'bad_request']);
  assert.match(noHours.body.error.message, /needs business hours/);
  assert.equal((await save(w, BOSS, a.customer, { restart: 'outside_hours', hours: HOURS }, 0)).status, 200);
  assert.equal((await save(w, BOSS, a.customer, { restart: 'outside_hours', hours: null }, 1)).status, 400);
  // The team has no hours: an override that names an hour rule without its own is refused.
  await save(w, BOSS, null, { shutdown: 'allow' }, 0);
  const still = await save(w, BOSS, a.customer, { shutdown: 'outside_hours' }, 1);
  assert.deepEqual([still.status, still.body.error.code], [400, 'bad_request']);
  assert.match(still.body.error.message, /needs business hours/);
  // A customer that does not exist.
  assert.equal((await save(w, BOSS, 'z'.repeat(20), {}, 0)).status, 404);
  assert.equal((await w.api(BOSS, 'GET', `/rules/${'z'.repeat(20)}`)).status, 404);
  assert.equal((await w.api(BOSS, 'GET', '/rules/not-an-id')).status, 404);
  // An empty override is no change.
  const logged = (await w.log()).length;
  assert.equal((await save(w, BOSS, a.customer, { restart: 'outside_hours', hours: HOURS }, 1)).body.override.rev, 1);
  assert.equal((await w.log()).length, logged);
  // Removing the customer removes its rules.
  assert.equal((await w.api(BOSS, 'PATCH', `/devices/${a.pc.id}`, { site_id: null, code: await fresh(w) })).status, 200);
  assert.equal((await w.api(BOSS, 'DELETE', `/sites/${a.site}`)).status, 200);
  assert.equal(w.sql("SELECT COUNT(*) AS n FROM rules WHERE customer_id = ?", a.customer)[0].n, 1);
  assert.equal((await w.api(BOSS, 'DELETE', `/customers/${a.customer}`)).status, 200);
  assert.equal(w.sql("SELECT COUNT(*) AS n FROM rules WHERE customer_id = ?", a.customer)[0].n, 0);
});

test('a team change that leaves a customer\'s hour rule without hours makes it never, in the answer the PC gets', async (t) => {
  const w = await ready(t);
  const a = await customerWithPc(w);
  await save(w, BOSS, null, { hours: HOURS, time_zone: 'UTC' }, 0);
  assert.equal((await save(w, BOSS, a.customer, { restart: 'outside_hours' }, 0)).status, 200);
  assert.equal((await helloRules(w, a.pc)).rules.restart, 'outside_hours');
  assert.equal((await save(w, BOSS, null, { hours: null, time_zone: 'UTC' }, 1)).status, 200);
  assert.equal((await helloRules(w, a.pc)).rules.restart, 'never');
  assert.equal((await w.api(BOSS, 'GET', `/rules/${a.customer}`)).body.effective.restart, 'never');
});

test('the check-in reads one row for the device, its site and both rules rows, and writes nothing more', async (t) => {
  const w = await ready(t);
  const a = await customerWithPc(w);
  await save(w, BOSS, null, { restart: 'allow', hours: HOURS }, 0);
  await save(w, BOSS, a.customer, { restart: 'never' }, 0);
  w.advance(10_000);
  await helloRules(w, a.pc);
  const before = w.db.seen.length;
  const hello = await helloRules(w, a.pc);
  assert.equal(hello.rules.restart, 'never');
  const ran = w.db.seen.slice(before).map((s) => s.sql);
  assert.equal(ran.filter((s) => /^\s*SELECT/i.test(s)).length, 1, 'one read');
  assert.equal(ran.filter((s) => !/^\s*SELECT/i.test(s)).length, 0, 'no write');
});

// ---- the technician app ---------------------------------------------------------------------------
test('the technician app reads the rules, and an admin saves them there with a code', { skip }, async (t) => {
  const w = await appWorld(t);
  await enrol(w, BOSS);
  const admin = await w.connect(BOSS, { app: true });
  const tech = await w.connect(TECH, { app: true });
  assert.equal(admin.tokens.status, 200);
  const read = await w.appCall(tech.access, 'GET', '/api/rules');
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.equal(read.body.rules.rev, 0);
  const denied = await w.appCall(tech.access, 'PATCH', '/api/rules', { doc: {}, rev: 0, code: '123456' });
  assert.equal(denied.status, 403);
  w.advance(30_000);
  const code = await totp(KEY, w.now());
  const saved = await w.appCall(admin.access, 'PATCH', '/api/rules', { doc: { restart: 'never' }, rev: 0, code });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.rules.doc.restart, 'never');
  const reused = await w.appCall(admin.access, 'PATCH', '/api/rules', { doc: { restart: 'allow' }, rev: 1, code });
  assert.deepEqual([reused.status, reused.body.error.code], [403, 'second_factor']);
  // A grant without the factor it needs for rules.manage is refused whatever code comes with it.
  w.sql('SELECT 1');
  w.db.sqlite.prepare('DELETE FROM user_factors').run();
  const none = await w.appCall(admin.access, 'PATCH', '/api/rules', { doc: { restart: 'allow' }, rev: 1, code: '123456' });
  assert.deepEqual([none.status, none.body.error.code], [403, 'second_factor']);
});
