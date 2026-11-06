// The device store: customers, sites, saved PCs, custom fields and pairing
// codes in D1, on the node:sqlite stand-in with every migration applied. The
// store sits on the team store's guarded change, so these tests drive the two
// together. The team API and the PC wire have their own files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openD1 } from './d1-fake.js';
import { teamStore } from '../src/workspace.js';
import { CHECK_IN_REFRESH_MS, CODE_TTL_MS, LIMITS, PENDING_TTL_MS, deviceStore, newId, normalizeCode, parseDeviceKey } from '../src/devices.js';

const W = 'default';
const SECRET = 'a-deployment-secret-of-at-least-32-characters';
const BOSS = 'boss@example.com';
const TECH = 'tech@example.com';
const VIEW = 'view@example.com';
const HOUR = 3_600_000;

// A relay database with an admin, a technician and a viewer in default.
async function setup({ secret = SECRET } = {}) {
  const db = openD1();
  const team = teamStore(db, { deploymentAdmins: BOSS });
  const devs = deviceStore(db, team, { authSecret: secret });
  await team.addMember(W, BOSS, { identity: BOSS, role_id: 'admin' });
  await team.addMember(W, BOSS, { identity: TECH, role_id: 'technician' });
  await team.addMember(W, BOSS, { identity: VIEW, role_id: 'viewer' });
  return { db, team, devs };
}

// Date.now moves only when told to, and comes back after the test.
function clock(t) {
  const real = Date.now;
  let now = real();
  Date.now = () => now;
  t.after(() => { Date.now = real; });
  return { advance: (ms) => { now += ms; }, now: () => now };
}

const kinds = async (team, slug = W) => (await team.readAudit(slug, { limit: 500 })).rows.map((r) => r.kind);
const rows = (db, sql, ...p) => db.sqlite.prepare(sql).all(...p);
const count = (db, table) => rows(db, `SELECT COUNT(*) AS n FROM ${table}`)[0].n;
const keyOf = (out) => parseDeviceKey(out.key);

// A technician's code, redeemed by a PC.
async function pair(devs, who = TECH, body = {}, site = {}) {
  const made = await devs.createPairingCode(W, who, site);
  const out = await devs.redeemCode({ protocol: 1, code: made.code, name: 'Front desk', access: 'ask', control: 'full', os: 'Windows 10', machine: 'POS-1', app_version: '0.3.0', ...body });
  return { made, out, key: keyOf(out) };
}

// The store with `sneak` run once, after it planned and before its batch commits.
function sneakBeforeBatch(db, sneak) {
  const batch = db.batch;
  let done = false;
  db.batch = async (statements) => {
    if (!done) { done = true; sneak(); }
    return batch(statements);
  };
}

const refused = (status, code) => ({ status, code });

// ---- ids, codes and keys ------------------------------------------------------
test('ids are 20 base32 characters, codes are 10 characters shown as two groups, keys parse back', async () => {
  const { devs } = await setup();
  assert.match(newId(), /^[a-z2-7]{20}$/);
  const made = await devs.createPairingCode(W, TECH, {});
  assert.match(made.code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/);
  assert.equal(normalizeCode(` ${made.code.toLowerCase()} `), made.code.replace('-', ''));
  assert.equal(made.expires_at - Date.now() <= CODE_TTL_MS, true);
  const { out, key } = await pair(devs);
  assert.equal(out.key, `smd1.default.${key.id}.${key.secret}`);
  assert.deepEqual(parseDeviceKey(out.key), { workspace: 'default', id: out.device_id, secret: key.secret });
  for (const bad of ['', 'smd1.default.x.y', out.key.replace('smd1', 'smd2'), `${out.key}x`, out.key.toUpperCase(), null, undefined, 5]) {
    assert.equal(parseDeviceKey(bad), null, String(bad));
  }
});

// ---- isolation -------------------------------------------------------------------
test('workspace isolation: a record, a PC, a field or a code made in one workspace is 404 or empty from another', async () => {
  const { db, team, devs } = await setup();
  await team.createWorkspace(BOSS, { slug: 'acme', name: 'Acme' });
  const field = await devs.addField(W, BOSS, { entity: 'customer', label: 'Contract' });
  const customer = await devs.addRecord('customer', W, BOSS, { name: 'Dana', fields: { [field.id]: 'yes' } });
  const site = await devs.addRecord('site', W, BOSS, { name: 'HQ', customer_id: customer.id });
  const { key } = await pair(devs, TECH, {}, { site_id: site.id });
  const code = await devs.createPairingCode(W, TECH, {});

  const missing = refused(404, 'not_found');
  await assert.rejects(devs.getRecord('customer', 'acme', customer.id), missing);
  await assert.rejects(devs.getRecord('site', 'acme', site.id), missing);
  await assert.rejects(devs.getDevice('acme', key.id), missing);
  await assert.rejects(devs.updateRecord('customer', 'acme', BOSS, customer.id, { name: 'X' }), missing);
  await assert.rejects(devs.removeRecord('site', 'acme', BOSS, site.id), missing);
  await assert.rejects(devs.updateDevice('acme', BOSS, key.id, { access: 'any' }), missing);
  await assert.rejects(devs.removeDevice('acme', BOSS, key.id), missing);
  await assert.rejects(devs.updateField('acme', BOSS, field.id, { label: 'X' }), missing);
  await assert.rejects(devs.removeField('acme', BOSS, field.id), missing);
  await assert.rejects(devs.revokePairingCode('acme', BOSS, code.id), missing);
  assert.deepEqual((await devs.listRecords('customer', 'acme')).customers, []);
  assert.deepEqual((await devs.listRecords('site', 'acme')).sites, []);
  assert.deepEqual((await devs.listDevices('acme')).devices, []);
  assert.deepEqual(await devs.listFields('acme'), []);
  assert.deepEqual(await devs.listPairingCodes('acme'), []);

  // The key names its workspace: the same id and secret under another slug is no key.
  assert.equal(await devs.authenticate({ ...key, workspace: 'acme' }), null);
  assert.ok(await devs.authenticate(key));
  // A site of one workspace is not a site in another, even by id.
  await assert.rejects(devs.createPairingCode('acme', BOSS, { site_id: site.id }), refused(400, 'unknown_site'));
  assert.equal(count(db, 'audit') > 0, true);
  assert.equal((await team.readAudit('acme', { limit: 500 })).rows.every((r) => !/devi|cust|site|pair|field/.test(r.kind)), true, 'nothing of default is in the other workspace log');
});

// ---- the log ----------------------------------------------------------------------
test('a scripted run of every kind of change writes exactly the expected log kinds, in order, and the chain verifies', async () => {
  const { team, devs } = await setup();
  const base = (await kinds(team)).length;
  const field = await devs.addField(W, BOSS, { entity: 'customer', label: 'Contract until' });
  const customer = await devs.addRecord('customer', W, TECH, { name: 'Dana Cohen', phone: '050', fields: { [field.id]: 'June' } });
  await devs.updateRecord('customer', W, TECH, customer.id, { notes: 'VIP', fields: { [field.id]: null } });
  const site = await devs.addRecord('site', W, TECH, { name: 'Main office', customer_id: customer.id });
  await devs.updateRecord('site', W, TECH, site.id, { address: '1 High St' });
  const spare = await devs.createPairingCode(W, TECH, {});
  const live = await devs.createPairingCode(W, TECH, { site_id: site.id });
  await devs.revokePairingCode(W, TECH, spare.id);
  const first = await devs.redeemCode({ protocol: 1, code: live.code, name: 'Front desk' });
  const waiting = await devs.requestJoin({ protocol: 1, workspace: W, name: 'Back office' });
  await devs.updateDevice(W, TECH, waiting.device_id, { approve: { confirm: waiting.confirm } });
  await devs.updateDevice(W, TECH, first.device_id, { access: 'any' });
  await devs.updateOwn(keyOf(waiting), { name: 'Back room' });
  await devs.removeDevice(W, TECH, first.device_id);
  const leaving = await devs.requestJoin({ protocol: 1, workspace: W, name: 'Spare' });
  await devs.leave(keyOf(leaving));
  await devs.updateField(W, BOSS, field.id, { label: 'Renewal' });
  await devs.updateDevice(W, TECH, waiting.device_id, { site_id: site.id });
  await devs.removeDevice(W, TECH, waiting.device_id);
  await devs.removeField(W, BOSS, field.id);
  await devs.removeRecord('site', W, TECH, site.id);
  await devs.removeRecord('customer', W, TECH, customer.id);
  assert.deepEqual((await kinds(team)).slice(base), [
    'field_added', 'customer_added', 'customer_changed', 'site_added', 'site_changed',
    'pairing_code_created', 'pairing_code_created', 'pairing_code_revoked',
    'device_paired', 'device_requested', 'device_approved', 'device_changed', 'device_changed',
    'device_removed', 'device_requested', 'device_left',
    'field_changed', 'device_changed', 'device_removed', 'field_removed', 'site_removed', 'customer_removed',
  ]);
  const log = await team.readAudit(W, { limit: 500 });
  assert.equal((await team.verifyAudit(W)).ok, true);
  assert.equal(log.verified, true);
  // Who did it: the technician for team changes, "<creator> via code" and "pc <id>" for the PCs.
  const by = (kind) => log.rows.filter((r) => r.kind === kind).map((r) => r.actor);
  assert.deepEqual(by('customer_added'), [TECH]);
  assert.deepEqual(by('field_added'), [BOSS]);
  assert.deepEqual(by('device_paired'), [`${TECH} via code`]);
  assert.deepEqual(by('device_requested'), [`pc ${waiting.device_id}`, `pc ${leaving.device_id}`]);
  assert.deepEqual(by('device_approved'), [TECH]);
  assert.deepEqual(by('device_left'), [`pc ${leaving.device_id}`]);
  assert.deepEqual(by('device_changed'), [TECH, `pc ${waiting.device_id}`, TECH]);
  // The technician's access change names the old and the new mode.
  assert.match(log.rows.find((r) => r.kind === 'device_changed').detail, /access ask to any/);
});

test('log details hold names and ids, never a field value, an owner contact, a code, a key or a confirm number', async () => {
  const { db, team, devs } = await setup();
  const field = await devs.addField(W, BOSS, { entity: 'device', label: 'Account' });
  const { made, out } = await pair(devs, TECH, { owner_contact: 'private-contact-text' });
  await devs.updateDevice(W, TECH, out.device_id, { fields: { [field.id]: 'secret-field-text' } });
  await devs.updateOwn(keyOf(out), { owner_contact: 'other-private-text' });
  const waiting = await devs.requestJoin({ protocol: 1, workspace: W, name: 'Waiting' });
  const stored = rows(db, 'SELECT actor, detail FROM audit').map((r) => `${r.actor} ${r.detail}`).join('\n');
  for (const secret of [made.code, made.code.replace('-', ''), keyOf(out).secret, keyOf(waiting).secret, 'secret-field-text', 'private-contact-text', 'other-private-text']) {
    assert.equal(stored.includes(secret), false, secret);
  }
  assert.equal(rows(db, 'SELECT 1 FROM audit WHERE detail = ? OR actor = ?', waiting.confirm, waiting.confirm).length, 0);
  assert.equal((await team.readAudit(W)).verified, true);
});

test('the D1 rows hold only hashes: no key secret, pairing code or confirm number in clear', async () => {
  const { db, devs } = await setup();
  const { made, out } = await pair(devs);
  const waiting = await devs.requestJoin({ protocol: 1, workspace: W, name: 'Waiting' });
  const every = ['devices', 'pairing_codes', 'audit', 'customers', 'sites', 'field_defs'].flatMap((t) => rows(db, `SELECT * FROM ${t}`));
  const text = JSON.stringify(every);
  for (const secret of [made.code, made.code.replace('-', ''), keyOf(out).secret, keyOf(waiting).secret, out.key, waiting.key]) {
    assert.equal(text.includes(secret), false, secret);
  }
  for (const row of rows(db, 'SELECT * FROM devices')) {
    assert.match(row.key_hash, /^[0-9a-f]{64}$/);
    assert.notEqual(row.confirm_hash, waiting.confirm);
    for (const v of Object.values(row)) assert.notEqual(v, waiting.confirm);
  }
  assert.match(rows(db, 'SELECT confirm_hash FROM devices WHERE status = ?', 'pending')[0].confirm_hash, /^[0-9a-f]{64}$/);
  assert.match(rows(db, 'SELECT hash FROM pairing_codes')[0].hash, /^[0-9a-f]{64}$/);
  // A device is never given back with its hashes.
  const listed = JSON.stringify(await devs.listDevices(W));
  assert.equal(/key_hash|confirm_hash|"key"|"confirm"/.test(listed), false);
  assert.equal(listed.includes(rows(db, 'SELECT key_hash FROM devices')[0].key_hash), false);
});

// ---- pairing codes -----------------------------------------------------------------
test('a pairing code works once, and a used, expired or unknown code all get the same answer', async (t) => {
  const { devs } = await setup();
  const clk = clock(t);
  const made = await devs.createPairingCode(W, TECH, {});
  const out = await devs.redeemCode({ protocol: 1, code: made.code.toLowerCase().replace('-', ' '), name: 'One' });
  assert.equal(out.status, 'active');
  const dead = refused(404, 'code_invalid');
  await assert.rejects(devs.redeemCode({ protocol: 1, code: made.code, name: 'Two' }), dead);
  await assert.rejects(devs.redeemCode({ protocol: 1, code: 'ABCDE-FGH23', name: 'Two' }), dead);
  for (const code of ['', 'short', 'ABCDEFGHIJ', made.code + 'X', '0000000000']) {
    await assert.rejects(devs.redeemCode({ protocol: 1, code, name: 'Two' }), dead, code);
  }
  const unused = await devs.createPairingCode(W, TECH, {});
  clk.advance(CODE_TTL_MS - 1);
  assert.ok((await devs.listPairingCodes(W)).some((c) => c.id === unused.id), 'one millisecond before the end it is live');
  clk.advance(1);
  await assert.rejects(devs.redeemCode({ protocol: 1, code: unused.code, name: 'Late' }), dead);
  assert.deepEqual(await devs.listPairingCodes(W), []);
});

test('a code is dead after 10 minutes, and expired codes are purged when new ones are made', async (t) => {
  const { db, devs } = await setup();
  const clk = clock(t);
  const made = await devs.createPairingCode(W, TECH, {});
  clk.advance(CODE_TTL_MS + 1);
  await assert.rejects(devs.redeemCode({ protocol: 1, code: made.code, name: 'Late' }), refused(404, 'code_invalid'));
  assert.equal(count(db, 'pairing_codes'), 1);
  await devs.createPairingCode(W, TECH, {});
  assert.equal(count(db, 'pairing_codes'), 1, 'the old code is gone, the new one is there');
});

test('a failed redeem leaves no device, no log row and the code unused; a good one leaves exactly one of each', async (t) => {
  const { db, team, devs } = await setup();
  const clk = clock(t);
  const made = await devs.createPairingCode(W, TECH, {});
  const state = async () => ({ devices: count(db, 'devices'), log: (await kinds(team)).length, used: rows(db, 'SELECT used_at FROM pairing_codes')[0]?.used_at ?? null });
  const before = await state();
  // Wrong code, malformed fields, and a full team: none of them touches the good code.
  await assert.rejects(devs.redeemCode({ protocol: 1, code: 'ABCDE-FGH23', name: 'X' }), refused(404, 'code_invalid'));
  await assert.rejects(devs.redeemCode({ protocol: 1, code: made.code, name: 'x'.repeat(101) }), refused(400, 'bad_request'));
  await assert.rejects(devs.redeemCode({ protocol: 1, code: made.code, name: 'X', access: 'sometimes' }), refused(400, 'bad_request'));
  assert.deepEqual(await state(), before);
  const fill = db.sqlite.prepare("INSERT INTO devices(workspace, id, status, name, access, control, key_hash, paired_at, paired_by, last_seen) VALUES ('default', ?, 'active', 'n', 'ask', 'full', 'h', 1, 'x', 1)");
  for (let i = 0; i < LIMITS.devices; i++) fill.run(`filler${String(i).padStart(14, '0')}`);
  const full = await state();
  await assert.rejects(devs.redeemCode({ protocol: 1, code: made.code, name: 'X' }), refused(409, 'device_limit'));
  assert.deepEqual(await state(), full);
  db.sqlite.exec('DELETE FROM devices');
  // The code is used by someone else between the lookup and the commit: the guard
  // refuses all three statements, so nothing is written.
  sneakBeforeBatch(db, () => db.sqlite.exec('UPDATE pairing_codes SET used_at = 1'));
  await assert.rejects(devs.redeemCode({ protocol: 1, code: made.code, name: 'X' }), refused(404, 'code_invalid'));
  assert.deepEqual(await state(), { ...before, used: 1 });
  db.sqlite.exec('UPDATE pairing_codes SET used_at = NULL');
  const ok = await devs.redeemCode({ protocol: 1, code: made.code, name: 'Front desk' });
  const after = await state();
  assert.equal(after.devices, 1);
  assert.equal(after.log, before.log + 1);
  assert.equal(after.used, clk.now());
  assert.equal((await kinds(team)).at(-1), 'device_paired');
  assert.equal(rows(db, 'SELECT id FROM devices')[0].id, ok.device_id);
});

test('a race for one code gives exactly one PC', async () => {
  const { db, devs } = await setup();
  const made = await devs.createPairingCode(W, TECH, {});
  const results = await Promise.allSettled(['A', 'B', 'C', 'D'].map((name) => devs.redeemCode({ protocol: 1, code: made.code, name })));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  for (const r of results.filter((x) => x.status === 'rejected')) assert.equal(r.reason.code, 'code_invalid');
  assert.equal(count(db, 'devices'), 1);
  assert.equal(rows(db, "SELECT COUNT(*) AS n FROM audit WHERE kind = 'device_paired'")[0].n, 1);
});

test('a code carries its site; the PC gets it only if the site still exists', async () => {
  const { devs } = await setup();
  const customer = await devs.addRecord('customer', W, TECH, { name: 'Dana' });
  const site = await devs.addRecord('site', W, TECH, { name: 'HQ', customer_id: customer.id });
  const { out } = await pair(devs, TECH, {}, { site_id: site.id });
  assert.equal((await devs.getDevice(W, out.device_id)).site_id, site.id);
  // A site with a PC, or a live code, is in use.
  await assert.rejects(devs.removeRecord('site', W, TECH, site.id), refused(409, 'in_use'));
  await devs.createPairingCode(W, TECH, { site_id: site.id });
  await assert.rejects(devs.createPairingCode(W, TECH, { site_id: newId() }), refused(400, 'unknown_site'));
});

test('20 live codes per workspace; the 21st is code_limit, and revoking one makes room', async () => {
  const { db, devs } = await setup();
  const made = [];
  for (let i = 0; i < LIMITS.liveCodes; i++) made.push(await devs.createPairingCode(W, TECH, {}));
  await assert.rejects(devs.createPairingCode(W, TECH, {}), refused(409, 'code_limit'));
  assert.equal(count(db, 'pairing_codes'), LIMITS.liveCodes);
  const list = await devs.listPairingCodes(W);
  assert.equal(list.length, LIMITS.liveCodes);
  assert.equal(/code|hash/.test(Object.keys(list[0]).join()), false, 'the list holds no codes');
  await devs.revokePairingCode(W, TECH, made[0].id);
  await assert.rejects(devs.redeemCode({ protocol: 1, code: made[0].code, name: 'Revoked' }), refused(404, 'code_invalid'));
  await devs.createPairingCode(W, TECH, {});
  await assert.rejects(devs.revokePairingCode(W, TECH, made[0].id), refused(404, 'not_found'));
});

test('without AUTH_SECRET, or with a short one, pairing answers 503 unavailable', async () => {
  for (const secret of ['', 'too-short', null]) {
    const { devs } = await setup({ secret });
    for (const call of [
      () => devs.createPairingCode(W, TECH, {}),
      () => devs.redeemCode({ protocol: 1, code: 'ABCDE-FGH23', name: 'X' }),
      () => devs.requestJoin({ protocol: 1, workspace: W, name: 'X' }),
      () => devs.updateDevice(W, TECH, newId(), { approve: { confirm: '123456' } }),
    ]) await assert.rejects(call(), refused(503, 'unavailable'));
  }
});

// ---- owner-started installs --------------------------------------------------------
test('an owner-started PC is pending until a technician types its six-digit number; a wrong number is refused', async () => {
  const { devs } = await setup();
  const out = await devs.requestJoin({ protocol: 1, workspace: W, name: 'Kitchen', access: 'any' });
  assert.equal(out.status, 'pending');
  assert.match(out.confirm, /^\d{6}$/);
  const key = keyOf(out);
  assert.equal((await devs.checkIn(key, {})).status, 'pending');
  await assert.rejects(devs.updateOwn(key, { name: 'Mine' }), refused(403, 'pending'));
  const shown = await devs.getDevice(W, out.device_id);
  assert.equal(shown.status, 'pending');
  assert.equal(shown.expires_at, out.expires_at);
  assert.equal(JSON.stringify(shown).includes(out.confirm), false, 'the digits are not shown to the team');
  const wrong = out.confirm === '000000' ? '000001' : '000000';
  await assert.rejects(devs.updateDevice(W, TECH, out.device_id, { approve: { confirm: wrong } }), refused(403, 'confirm_wrong'));
  await assert.rejects(devs.updateDevice(W, TECH, out.device_id, { approve: { confirm: '12345' } }), refused(400, 'bad_request'));
  await assert.rejects(devs.updateDevice(W, TECH, out.device_id, { approve: { confirm: out.confirm }, access: 'any' }), refused(400, 'bad_request'));
  await assert.rejects(devs.updateDevice(W, TECH, out.device_id, { access: 'any' }), refused(409, 'pending'));
  assert.equal((await devs.getDevice(W, out.device_id)).status, 'pending');
  const approved = await devs.updateDevice(W, TECH, out.device_id, { approve: { confirm: out.confirm } });
  assert.deepEqual([approved.status, approved.approved_by, approved.expires_at], ['active', TECH, undefined]);
  assert.equal((await devs.updateOwn(key, { name: 'Mine' })).name, 'Mine');
  await assert.rejects(devs.updateDevice(W, TECH, out.device_id, { approve: { confirm: out.confirm } }), refused(409, 'not_pending'));
});

test('a pending PC is gone 24 hours after its request', async (t) => {
  const { db, devs } = await setup();
  const clk = clock(t);
  const out = await devs.requestJoin({ protocol: 1, workspace: W, name: 'Kitchen' });
  clk.advance(PENDING_TTL_MS - 1);
  assert.equal((await devs.checkIn(keyOf(out), {})).status, 'pending');
  clk.advance(1);
  await assert.rejects(devs.checkIn(keyOf(out), {}), refused(401, 'device_unknown'));
  assert.equal(count(db, 'devices'), 0, 'purged when met');
  const again = await devs.requestJoin({ protocol: 1, workspace: W, name: 'Again' });
  clk.advance(PENDING_TTL_MS);
  assert.deepEqual((await devs.listDevices(W)).devices, [], 'purged on read');
  await assert.rejects(devs.updateDevice(W, TECH, again.device_id, { approve: { confirm: again.confirm } }), refused(404, 'not_found'));
});

test('20 requests an hour per workspace; the 21st is request_limit, and the hour rolls on', async (t) => {
  const { db, devs } = await setup();
  const clk = clock(t);
  for (let i = 0; i < LIMITS.requestsPerHour; i++) await devs.requestJoin({ protocol: 1, workspace: W, name: `PC ${i}` });
  await assert.rejects(devs.requestJoin({ protocol: 1, workspace: W, name: 'One more' }), refused(409, 'request_limit'));
  assert.equal(count(db, 'devices'), LIMITS.requestsPerHour);
  // A technician clears the slots, but the hourly cap still holds.
  const { devices } = await devs.listDevices(W);
  await devs.removeDevice(W, TECH, devices[0].id);
  await assert.rejects(devs.requestJoin({ protocol: 1, workspace: W, name: 'One more' }), refused(409, 'request_limit'));
  clk.advance(HOUR + 1);
  await devs.requestJoin({ protocol: 1, workspace: W, name: 'Next hour' });
});

test('20 waiting PCs per workspace; the 21st is pending_limit even when the requests were hours apart', async (t) => {
  const { devs } = await setup();
  const clk = clock(t);
  for (let i = 0; i < LIMITS.pending; i++) {
    await devs.requestJoin({ protocol: 1, workspace: W, name: `PC ${i}` });
    clk.advance(HOUR / 2);
  }
  await assert.rejects(devs.requestJoin({ protocol: 1, workspace: W, name: 'Too many' }), refused(409, 'pending_limit'));
  // The oldest wait ends after 24 hours, which makes room.
  clk.advance(PENDING_TTL_MS - HOUR * 10);
  await devs.requestJoin({ protocol: 1, workspace: W, name: 'Room again' });
  await assert.rejects(devs.requestJoin({ protocol: 1, workspace: 'nope', name: 'x' }), refused(404, 'not_found'));
});

// ---- keys and check-ins ------------------------------------------------------------
test('a wrong key, an unknown id and a removed device all get the same device_unknown', async () => {
  const { devs } = await setup();
  const { key, out } = await pair(devs);
  const unknown = refused(401, 'device_unknown');
  await assert.rejects(devs.checkIn({ ...key, secret: 'A'.repeat(43) }, {}), unknown);
  await assert.rejects(devs.checkIn({ ...key, id: newId() }, {}), unknown);
  await assert.rejects(devs.checkIn({ ...key, workspace: 'nope' }, {}), unknown);
  assert.equal((await devs.checkIn(key, {})).id, out.device_id);
  await devs.leave(key);
  await assert.rejects(devs.checkIn(key, {}), unknown);
  await assert.rejects(devs.updateOwn(key, { name: 'x' }), unknown);
  await assert.rejects(devs.leave(key), unknown);
});

test('a PC checks in unlogged, and its details are written at most every 5 minutes unless one changed', async (t) => {
  const { db, team, devs } = await setup();
  const clk = clock(t);
  const { key } = await pair(devs);
  const log = (await kinds(team)).length;
  const seen = () => rows(db, 'SELECT last_seen, app_version, os FROM devices')[0];
  const paired = seen().last_seen;
  const writes = () => db.seen.filter((s) => /^UPDATE devices SET os/.test(s.sql)).length;
  clk.advance(60_000);
  await devs.checkIn(key, { os: 'Windows 10', machine: 'POS-1', app_version: '0.3.0' });
  assert.equal(seen().last_seen, paired, 'a minute on, nothing changed: no write');
  assert.equal(writes(), 0);
  clk.advance(CHECK_IN_REFRESH_MS);
  await devs.checkIn(key, { os: 'Windows 10' });
  assert.equal(seen().last_seen, clk.now(), 'five minutes on: last_seen moves');
  const moved = clk.now();
  clk.advance(1000);
  await devs.checkIn(key, { app_version: '0.4.0' });
  assert.deepEqual([seen().app_version, seen().last_seen], ['0.4.0', clk.now()], 'a changed value is written at once');
  assert.equal(writes(), 2);
  assert.equal(moved < clk.now(), true);
  assert.equal((await kinds(team)).length, log, 'check-ins write no log rows');
  await assert.rejects(devs.checkIn(key, { os: 5 }), refused(400, 'bad_request'));
  await assert.rejects(devs.checkIn(key, { machine: 'x'.repeat(101) }), refused(400, 'bad_request'));
});

test('a PC changes its own name, access, control and contact; a no-op writes no log row', async () => {
  const { team, devs } = await setup();
  const { key } = await pair(devs);
  const log = (await kinds(team)).length;
  const out = await devs.updateOwn(key, { name: 'Till', access: 'any', control: 'limited', owner_contact: 'Sam 050' });
  assert.deepEqual([out.name, out.access, out.control], ['Till', 'any', 'limited']);
  assert.equal((await kinds(team)).length, log + 1);
  assert.equal((await devs.updateOwn(key, { name: 'Till', access: 'any' })).name, 'Till');
  assert.equal((await kinds(team)).length, log + 1, 'unchanged values write nothing');
  const shown = await devs.getDevice(W, key.id);
  assert.deepEqual([shown.owner_contact, shown.paired_by], ['Sam 050', TECH]);
  await assert.rejects(devs.updateOwn(key, {}), refused(400, 'bad_request'));
  await assert.rejects(devs.updateOwn(key, { name: '' }), refused(400, 'bad_request'));
  await assert.rejects(devs.updateOwn(key, { access: 'always' }), refused(400, 'bad_request'));
  await assert.rejects(devs.updateOwn(key, { os: 'Windows 11' }), refused(400, 'bad_request'), 'a PC reports its os at check-in, not here');
});

test('leaving removes the device and its key at once, and logs who left', async () => {
  const { db, team, devs } = await setup();
  const { key, out } = await pair(devs);
  assert.deepEqual(await devs.leave(key), { removed: true });
  assert.equal(count(db, 'devices'), 0);
  assert.equal((await kinds(team)).at(-1), 'device_left');
  assert.equal((await team.readAudit(W, { limit: 500 })).rows.at(-1).actor, `pc ${out.device_id}`);
});

// ---- permissions ------------------------------------------------------------------
test('a viewer or a stranger cannot change anything, and a refusal writes no log row', async () => {
  const { team, devs } = await setup();
  const denied = refused(403, 'permission_denied');
  const customer = await devs.addRecord('customer', W, TECH, { name: 'Dana' });
  const { out } = await pair(devs);
  const log = (await kinds(team)).length;
  const calls = [
    (who) => devs.addRecord('customer', W, who, { name: 'X' }),
    (who) => devs.updateRecord('customer', W, who, customer.id, { name: 'X' }),
    (who) => devs.removeRecord('customer', W, who, customer.id),
    (who) => devs.updateDevice(W, who, out.device_id, { access: 'any' }),
    (who) => devs.removeDevice(W, who, out.device_id),
    (who) => devs.createPairingCode(W, who, {}),
    (who) => devs.revokePairingCode(W, who, newId()),
  ];
  for (const call of calls) {
    await assert.rejects(call(VIEW), denied);
    await assert.rejects(call('stranger@example.com'), refused(403, 'not_member'));
  }
  assert.equal((await kinds(team)).length, log);
  // Only fields.manage defines fields: the technician role does not hold it.
  await assert.rejects(devs.addField(W, TECH, { entity: 'site', label: 'X' }), denied);
  await assert.rejects(devs.addField(W, VIEW, { entity: 'site', label: 'X' }), denied);
  await devs.addField(W, BOSS, { entity: 'site', label: 'X' });
});

test('the actor is re-checked at commit: a technician demoted after the read cannot change anything', async () => {
  const { db, team, devs } = await setup();
  const customer = await devs.addRecord('customer', W, TECH, { name: 'Dana' });
  const { out } = await pair(devs);
  const demote = () => db.sqlite.exec("UPDATE members SET role_id = 'viewer' WHERE workspace = 'default' AND identity = 'tech@example.com'");
  const undo = () => db.sqlite.exec("UPDATE members SET role_id = 'technician' WHERE workspace = 'default' AND identity = 'tech@example.com'");
  const log = (await kinds(team)).length;
  const denied = refused(403, 'permission_denied');
  const calls = [
    () => devs.addRecord('customer', W, TECH, { name: 'Late' }),
    () => devs.updateRecord('customer', W, TECH, customer.id, { name: 'Late' }),
    () => devs.removeRecord('customer', W, TECH, customer.id),
    () => devs.updateDevice(W, TECH, out.device_id, { access: 'any' }),
    () => devs.removeDevice(W, TECH, out.device_id),
    () => devs.createPairingCode(W, TECH, {}),
  ];
  for (const call of calls) {
    sneakBeforeBatch(db, demote);
    await assert.rejects(call(), denied);
    undo();
  }
  assert.equal((await kinds(team)).length, log, 'no log row for a refused change');
  assert.equal(count(db, 'customers'), 1);
  assert.equal(count(db, 'devices'), 1);
  assert.equal(count(db, 'pairing_codes'), 1, 'only the code made by the pair() helper');
  assert.equal((await devs.getRecord('customer', W, customer.id)).name, 'Dana');
  assert.equal((await devs.getDevice(W, out.device_id)).access, 'ask');
  // The role losing the permission after the read does the same.
  sneakBeforeBatch(db, () => db.sqlite.exec(`INSERT INTO roles VALUES ('default', 'technician', 'Technician', '["sessions.view"]', 1, 0)`));
  await assert.rejects(devs.removeDevice(W, TECH, out.device_id), denied);
  assert.equal(count(db, 'devices'), 1);
  assert.equal((await team.readAudit(W)).verified, true);
});

test('a technician with devices.manage can change a PC access mode, logged as theirs; control and name stay the owner', async () => {
  const { team, devs } = await setup();
  const { out } = await pair(devs, TECH, { access: 'ask', control: 'limited', name: 'Till' });
  const changed = await devs.updateDevice(W, TECH, out.device_id, { access: 'any' });
  assert.deepEqual([changed.access, changed.control, changed.name], ['any', 'limited', 'Till']);
  const row = (await team.readAudit(W, { limit: 500 })).rows.at(-1);
  assert.deepEqual([row.kind, row.actor], ['device_changed', TECH]);
  assert.match(row.detail, /access ask to any/);
  // control and name are not the technician's to change; they are ignored.
  const same = await devs.updateDevice(W, TECH, out.device_id, { access: 'any', control: 'full', name: 'Hacked' });
  assert.deepEqual([same.name, same.control], ['Till', 'limited']);
  assert.equal((await kinds(team)).at(-1), 'device_changed');
  await assert.rejects(devs.updateDevice(W, TECH, out.device_id, { access: 'always' }), refused(400, 'bad_request'));
  await assert.rejects(devs.updateDevice(W, VIEW, out.device_id, { access: 'ask' }), refused(403, 'permission_denied'));
  assert.equal((await devs.getDevice(W, out.device_id)).access, 'any');
});

// ---- customers, sites and fields ----------------------------------------------------
test('customers and sites keep built-in fields; limits and bad input are 400', async () => {
  const { devs } = await setup();
  const customer = await devs.addRecord('customer', W, TECH, { name: ' Dana Cohen ', phone: '050-1', email: 'd@example.com', notes: 'line one\nline two' });
  assert.deepEqual([customer.name, customer.phone, customer.notes, customer.fields], ['Dana Cohen', '050-1', 'line one\nline two', {}]);
  const bad = refused(400, 'bad_request');
  await assert.rejects(devs.addRecord('customer', W, TECH, {}), bad);
  await assert.rejects(devs.addRecord('customer', W, TECH, { name: '' }), bad);
  await assert.rejects(devs.addRecord('customer', W, TECH, { name: 'x'.repeat(101) }), bad);
  await assert.rejects(devs.addRecord('customer', W, TECH, { name: 'ok', phone: 'x'.repeat(201) }), bad);
  await assert.rejects(devs.addRecord('customer', W, TECH, { name: 'ok', notes: 'x'.repeat(2001) }), bad);
  await assert.rejects(devs.addRecord('customer', W, TECH, { name: 'a\u0000b' }), bad);
  await assert.rejects(devs.addRecord('customer', W, TECH, { name: 5 }), bad);
  await assert.rejects(devs.addRecord('site', W, TECH, { name: 'HQ' }), bad);
  await assert.rejects(devs.addRecord('site', W, TECH, { name: 'HQ', customer_id: 'nope' }), bad);
  await assert.rejects(devs.addRecord('site', W, TECH, { name: 'HQ', customer_id: newId() }), refused(400, 'unknown_customer'));
  const site = await devs.addRecord('site', W, TECH, { name: 'HQ', customer_id: customer.id, address: 'x'.repeat(300) });
  await assert.rejects(devs.updateRecord('site', W, TECH, site.id, { address: 'x'.repeat(301) }), bad);
  await assert.rejects(devs.updateRecord('site', W, TECH, site.id, {}), bad);
  await assert.rejects(devs.updateRecord('customer', W, TECH, newId(), { name: 'X' }), refused(404, 'not_found'));
  // A customer with a site is in use.
  await assert.rejects(devs.removeRecord('customer', W, TECH, customer.id), refused(409, 'in_use'));
  await devs.removeRecord('site', W, TECH, site.id);
  await devs.removeRecord('customer', W, TECH, customer.id);
  await assert.rejects(devs.removeRecord('customer', W, TECH, customer.id), refused(404, 'not_found'));
});

test('a customer cannot be removed while a site is added to it concurrently, and no site is left without its customer', async () => {
  const { db, devs } = await setup();
  const customer = await devs.addRecord('customer', W, TECH, { name: 'Dana' });
  sneakBeforeBatch(db, () => db.sqlite.prepare("INSERT INTO sites(workspace, id, customer_id, name, created_at, created_by, updated_at) VALUES ('default', ?, ?, 'Raced', 1, 'x', 1)").run(newId(), customer.id));
  await assert.rejects(devs.removeRecord('customer', W, TECH, customer.id), refused(409, 'in_use'));
  assert.equal(count(db, 'customers'), 1);
  sneakBeforeBatch(db, () => db.sqlite.exec('DELETE FROM customers'));
  await assert.rejects(devs.addRecord('site', W, TECH, { name: 'Orphan', customer_id: customer.id }), refused(400, 'unknown_customer'));
  assert.equal(count(db, 'sites'), 1, 'only the raced site');
});

test('custom fields are text up to 500 characters, defined per record type; unknown ids are refused', async () => {
  const { devs } = await setup();
  const contract = await devs.addField(W, BOSS, { entity: 'customer', label: 'Contract until' });
  const asset = await devs.addField(W, BOSS, { entity: 'device', label: 'Asset tag' });
  assert.deepEqual((await devs.listFields(W)).map((f) => [f.entity, f.label, f.position]), [['customer', 'Contract until', 0], ['device', 'Asset tag', 0]]);
  const customer = await devs.addRecord('customer', W, TECH, { name: 'Dana', fields: { [contract.id]: 'x'.repeat(500) } });
  assert.equal(customer.fields[contract.id].length, 500);
  const bad = refused(400, 'bad_request');
  await assert.rejects(devs.addRecord('customer', W, TECH, { name: 'X', fields: { [contract.id]: 'x'.repeat(501) } }), bad);
  await assert.rejects(devs.addRecord('customer', W, TECH, { name: 'X', fields: { [contract.id]: 5 } }), bad);
  await assert.rejects(devs.addRecord('customer', W, TECH, { name: 'X', fields: { [contract.id]: null } }), bad);
  await assert.rejects(devs.addRecord('customer', W, TECH, { name: 'X', fields: { [newId()]: 'x' } }), bad);
  await assert.rejects(devs.addRecord('customer', W, TECH, { name: 'X', fields: { [asset.id]: 'x' } }), bad, "a device field is not a customer's");
  await assert.rejects(devs.addRecord('customer', W, TECH, { name: 'X', fields: ['x'] }), bad);
  await assert.rejects(devs.addRecord('site', W, TECH, { name: 'X', customer_id: customer.id, fields: { [contract.id]: 'x' } }), bad);
  // PATCH merges: a value is set, a null deletes, an absent id is left alone.
  const second = await devs.addField(W, BOSS, { entity: 'customer', label: 'Account' });
  const merged = await devs.updateRecord('customer', W, TECH, customer.id, { fields: { [second.id]: 'A1' } });
  assert.deepEqual(Object.keys(merged.fields).sort(), [contract.id, second.id].sort());
  const cut = await devs.updateRecord('customer', W, TECH, customer.id, { fields: { [contract.id]: null } });
  assert.deepEqual(cut.fields, { [second.id]: 'A1' });
  assert.deepEqual((await devs.getRecord('customer', W, customer.id)).fields, { [second.id]: 'A1' });
  const same = await devs.updateRecord('customer', W, TECH, customer.id, { fields: { [second.id]: 'A1' } });
  assert.equal(same.updated_at, cut.updated_at, 'the same value is not a change');
  // A PC's custom fields go through the technician, not the PC.
  const { out } = await pair(devs);
  const device = await devs.updateDevice(W, TECH, out.device_id, { fields: { [asset.id]: 'T-9' } });
  assert.deepEqual(device.fields, { [asset.id]: 'T-9' });
  await assert.rejects(devs.updateDevice(W, TECH, out.device_id, { fields: { [contract.id]: 'x' } }), bad);
});

test('30 field definitions per record type; the 31st is field_limit', async () => {
  const { devs } = await setup();
  for (let i = 0; i < LIMITS.fieldDefs; i++) await devs.addField(W, BOSS, { entity: 'site', label: `Field ${i}` });
  await assert.rejects(devs.addField(W, BOSS, { entity: 'site', label: 'One more' }), refused(409, 'field_limit'));
  await devs.addField(W, BOSS, { entity: 'customer', label: 'Other type' });
  const bad = refused(400, 'bad_request');
  await assert.rejects(devs.addField(W, BOSS, { entity: 'workspace', label: 'X' }), bad);
  await assert.rejects(devs.addField(W, BOSS, { entity: 'site', label: '' }), bad);
  await assert.rejects(devs.addField(W, BOSS, { entity: 'site', label: 'x'.repeat(61) }), bad);
  const [first] = await devs.listFields(W);
  await assert.rejects(devs.updateField(W, BOSS, first.id, {}), bad);
  await assert.rejects(devs.updateField(W, BOSS, first.id, { position: -1 }), bad);
  assert.equal((await devs.updateField(W, BOSS, first.id, { label: 'Renamed', position: 5 })).position, 5);
});

test('removing a field definition clears its values from every record in the same change', async () => {
  const { db, team, devs } = await setup();
  const field = await devs.addField(W, BOSS, { entity: 'customer', label: 'Contract' });
  const keep = await devs.addField(W, BOSS, { entity: 'customer', label: 'Keep' });
  const a = await devs.addRecord('customer', W, TECH, { name: 'A', fields: { [field.id]: '1', [keep.id]: 'k' } });
  const b = await devs.addRecord('customer', W, TECH, { name: 'B', fields: { [field.id]: '2' } });
  await devs.addRecord('customer', W, TECH, { name: 'C' });
  await devs.removeField(W, BOSS, field.id);
  assert.deepEqual((await devs.getRecord('customer', W, a.id)).fields, { [keep.id]: 'k' });
  assert.deepEqual((await devs.getRecord('customer', W, b.id)).fields, {});
  assert.equal(rows(db, "SELECT COUNT(*) AS n FROM customers WHERE fields LIKE ?", `%${field.id}%`)[0].n, 0);
  assert.equal((await devs.listFields(W)).length, 1);
  // A value set after its definition is gone is refused at commit.
  const doomed = await devs.addField(W, BOSS, { entity: 'customer', label: 'Doomed' });
  sneakBeforeBatch(db, () => db.sqlite.prepare('DELETE FROM field_defs WHERE id = ?').run(doomed.id));
  await assert.rejects(devs.updateRecord('customer', W, TECH, a.id, { fields: { [doomed.id]: 'late' } }), refused(400, 'bad_request'));
  assert.deepEqual((await devs.getRecord('customer', W, a.id)).fields, { [keep.id]: 'k' });
  assert.equal((await team.readAudit(W)).verified, true);
});

test('lists page by id: the next cursor holds the last id when more remain', async () => {
  const { devs } = await setup();
  for (let i = 0; i < 5; i++) await devs.addRecord('customer', W, TECH, { name: `C${i}` });
  const first = await devs.listRecords('customer', W, { limit: 2 });
  assert.equal(first.customers.length, 2);
  assert.equal(first.next, first.customers[1].id);
  const second = await devs.listRecords('customer', W, { after: first.next, limit: 2 });
  assert.equal(second.customers[0].id > first.next, true);
  const last = await devs.listRecords('customer', W, { after: second.next, limit: 2 });
  assert.deepEqual([last.customers.length, last.next], [1, null]);
  const all = [...first.customers, ...second.customers, ...last.customers].map((c) => c.id);
  assert.deepEqual(all, [...all].sort());
  assert.equal(new Set(all).size, 5);
  const exact = await devs.listRecords('customer', W, { limit: 5 });
  assert.equal(exact.next, null, 'no next when nothing remains');
});

test('devices list filters by site and status', async () => {
  const { devs } = await setup();
  const customer = await devs.addRecord('customer', W, TECH, { name: 'Dana' });
  const site = await devs.addRecord('site', W, TECH, { name: 'HQ', customer_id: customer.id });
  const { out } = await pair(devs, TECH, {}, { site_id: site.id });
  await pair(devs);
  const waiting = await devs.requestJoin({ protocol: 1, workspace: W, name: 'W' });
  assert.deepEqual((await devs.listDevices(W, { site: site.id })).devices.map((d) => d.id), [out.device_id]);
  assert.deepEqual((await devs.listDevices(W, { status: 'pending' })).devices.map((d) => d.id), [waiting.device_id]);
  assert.equal((await devs.listDevices(W, { status: 'active' })).devices.length, 2);
  assert.equal((await devs.listDevices(W)).devices.length, 3);
  // Moving a PC to another site, and off any site.
  const site2 = await devs.addRecord('site', W, TECH, { name: 'Branch', customer_id: customer.id });
  assert.equal((await devs.updateDevice(W, TECH, out.device_id, { site_id: site2.id })).site_id, site2.id);
  assert.equal((await devs.updateDevice(W, TECH, out.device_id, { site_id: null })).site_id, null);
  await assert.rejects(devs.updateDevice(W, TECH, out.device_id, { site_id: newId() }), refused(400, 'unknown_site'));
  await assert.rejects(devs.updateDevice(W, TECH, out.device_id, {}), refused(400, 'bad_request'));
});
