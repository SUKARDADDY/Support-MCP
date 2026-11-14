// The PC wire: POST /device/pair, /device/hello, /device/update and
// /device/leave. These addresses are public (a PC has no Access login), so the
// tests send no Access token anywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { openD1 } from './d1-fake.js';
import { createHandler } from '../src/app.js';
import { teamStore } from '../src/workspace.js';
import { deviceStore } from '../src/devices.js';
import { VERSION } from '../src/version.js';
import { buildNote, groupOf } from '../src/release.js';
import { MAC_URL, MAC_VERSION, fixtureBundle, macRelease, signNote, throwawayKey, verifies } from './release-fixture.js';
import { rulesFromEnv } from '../src/rules-store.js';

const HOST = 'https://support.example.com';
const SECRET = 'a-deployment-secret-of-at-least-32-characters';
const BOSS = 'boss@example.com';
const KEY_PATTERN = /^smd1\.default\.[a-z2-7]{20}\.[A-Za-z0-9_-]{43}$/;

async function wire(extra = {}, appBundle = null) {
  const db = openD1();
  const env = { DB: db, AUTH_SECRET: SECRET, ...extra };
  const team = teamStore(db);
  const devs = deviceStore(db, team, { authSecret: SECRET });
  await team.addMember('default', BOSS, { identity: BOSS, role_id: 'admin' });
  const handler = createHandler('powershell agent', appBundle);
  // A request to the wire. body undefined sends none; init overrides the defaults.
  const send = async (path, body, { method = 'POST', headers = {}, base = HOST, search = '' } = {}) => {
    const init = { method, headers: { 'content-type': 'application/json', ...headers } };
    if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
    const res = await handler.fetch(new Request(`${base}/device/${path}${search}`, init), env);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
    return { status: res.status, headers: res.headers, text, body: json };
  };
  const code = async () => (await devs.createPairingCode('default', BOSS, {})).code;
  const bearer = (key) => ({ authorization: `Bearer ${key}` });
  return { db, env, team, devs, send, code, bearer };
}

const rows = (db, sql, ...p) => db.sqlite.prepare(sql).all(...p);
const refuses = (res, status, code) => {
  assert.deepEqual([res.status, res.body?.error?.code], [status, code], res.text);
  assert.equal(res.body.protocol, 1, 'errors carry the protocol too');
  assert.equal(typeof res.body.error.message, 'string');
  return res;
};

// ---- the whole round trip -------------------------------------------------------------
test('a technician code pairs a PC; it checks in, changes its own settings, and leaves', async () => {
  const w = await wire();
  const paired = await w.send('pair', { protocol: 1, code: await w.code(), name: 'Front desk', access: 'ask', control: 'full', os: 'Windows 10 Pro 22H2', machine: 'POS-1', app_version: '0.4.0' });
  assert.equal(paired.status, 201);
  assert.deepEqual(Object.keys(paired.body).sort(), ['device_id', 'key', 'protocol', 'status', 'workspace']);
  assert.deepEqual([paired.body.protocol, paired.body.status, paired.body.workspace], [1, 'active', 'default']);
  assert.match(paired.body.key, KEY_PATTERN);
  assert.equal(paired.body.key.split('.')[2], paired.body.device_id);
  assert.equal(paired.headers.get('cache-control'), 'no-store');

  // A changed value is written at most once a minute: pretend the pairing was two minutes ago.
  w.db.sqlite.exec('UPDATE devices SET last_seen = last_seen - 120000');
  const hello = await w.send('hello', { protocol: 1, os: 'Windows 11', machine: 'POS-1', app_version: '0.4.1' }, { headers: w.bearer(paired.body.key) });
  assert.equal(hello.status, 200);
  const { rules, rules_tag: tag, hours_utc: spans, hours_until: until, server_time: serverTime, ...rest } = hello.body;
  assert.deepEqual(rest, {
    protocol: 1,
    device: { id: paired.body.device_id, workspace: 'default', status: 'active', name: 'Front desk', access: 'ask', control: 'full', site_id: null },
  });
  // A team with no rules row: the defaults, in UTC, with no business hours.
  assert.deepEqual(rules, {
    rev: 0, time_zone: 'UTC', hours: null, restart: 'approve', shutdown: 'approve', install: 'approve', uninstall: 'approve',
    close_program: 'allow', protected_programs: [], protected_folders: [],
  });
  assert.match(tag, /^[0-9a-f]{16}$/);
  assert.deepEqual([spans, until - serverTime], [[], 8 * 86400]);
  assert.ok(Math.abs(serverTime - Date.now() / 1000) < 5, 'the relay\'s clock');
  assert.deepEqual({ ...rows(w.db, 'SELECT os, app_version FROM devices')[0] }, { os: 'Windows 11', app_version: '0.4.1' });

  const updated = await w.send('update', { protocol: 1, name: 'Till', access: 'any', control: 'limited' }, { headers: w.bearer(paired.body.key) });
  assert.equal(updated.status, 200);
  assert.deepEqual([updated.body.protocol, updated.body.device.name, updated.body.device.access, updated.body.device.control], [1, 'Till', 'any', 'limited']);

  const left = await w.send('leave', { protocol: 1 }, { headers: w.bearer(paired.body.key) });
  assert.deepEqual([left.status, left.body], [200, { protocol: 1, removed: true }]);
  refuses(await w.send('hello', { protocol: 1 }, { headers: w.bearer(paired.body.key) }), 401, 'device_unknown');
  refuses(await w.send('update', { protocol: 1, name: 'x' }, { headers: w.bearer(paired.body.key) }), 401, 'device_unknown');
  refuses(await w.send('leave', { protocol: 1 }, { headers: w.bearer(paired.body.key) }), 401, 'device_unknown');
  assert.equal(rows(w.db, 'SELECT COUNT(*) AS n FROM devices')[0].n, 0, 'the row and its key hash are gone');
  assert.deepEqual((await w.team.readAudit('default', { limit: 500 })).rows.map((r) => r.kind).slice(2), ['pairing_code_created', 'device_paired', 'device_changed', 'device_left']);
});

test('a PC that sends owner_contact to pair or update gets 400 bad_request, and nothing is written', async () => {
  const w = await wire();
  const code = await w.code();
  refuses(await w.send('pair', { protocol: 1, code, name: 'One', owner_contact: 'Sam' }), 400, 'bad_request');
  refuses(await w.send('pair', { protocol: 1, workspace: 'default', name: 'One', owner_contact: 'Sam' }), 400, 'bad_request');
  assert.equal(rows(w.db, 'SELECT COUNT(*) AS n FROM devices')[0].n, 0);
  const paired = await w.send('pair', { protocol: 1, code, name: 'One' });
  assert.equal(paired.status, 201, 'the code was not used up');
  refuses(await w.send('update', { protocol: 1, owner_contact: 'Sam' }, { headers: w.bearer(paired.body.key) }), 400, 'bad_request');
  refuses(await w.send('update', { protocol: 1, name: 'Two', owner_contact: 'Sam' }, { headers: w.bearer(paired.body.key) }), 400, 'bad_request');
  assert.deepEqual({ ...rows(w.db, 'SELECT name, owner_contact FROM devices')[0] }, { name: 'One', owner_contact: '' });
});

test('a pairing code works once: the second use, an unknown code and a malformed one get the same 404 code_invalid', async () => {
  const w = await wire();
  const code = await w.code();
  assert.equal((await w.send('pair', { protocol: 1, code, name: 'One' })).status, 201);
  const used = refuses(await w.send('pair', { protocol: 1, code, name: 'Two' }), 404, 'code_invalid');
  const unknown = refuses(await w.send('pair', { protocol: 1, code: 'ABCDE-FGH23', name: 'Two' }), 404, 'code_invalid');
  const malformed = refuses(await w.send('pair', { protocol: 1, code: '12', name: 'Two' }), 404, 'code_invalid');
  assert.equal(used.text, unknown.text);
  assert.equal(used.text, malformed.text);
  assert.equal(rows(w.db, 'SELECT COUNT(*) AS n FROM devices')[0].n, 1);
  refuses(await w.send('pair', { protocol: 1, code: 5, name: 'Two' }), 400, 'bad_request');
});

test('an owner-started install is pending: it can check in or leave, nothing else', async () => {
  const w = await wire();
  const asked = await w.send('pair', { protocol: 1, workspace: 'default', name: 'Kitchen', os: 'Windows 7', machine: 'KIT', app_version: '0.4.0' });
  assert.equal(asked.status, 202);
  assert.deepEqual(Object.keys(asked.body).sort(), ['confirm', 'device_id', 'expires_at', 'key', 'protocol', 'status', 'workspace']);
  assert.deepEqual([asked.body.status, asked.body.workspace], ['pending', 'default']);
  assert.match(asked.body.confirm, /^\d{6}$/);
  assert.match(asked.body.key, KEY_PATTERN);
  assert.ok(Math.abs(asked.body.expires_at - (Date.now() + 24 * 3600_000)) < 60_000);
  const auth = w.bearer(asked.body.key);
  assert.equal((await w.send('hello', { protocol: 1 }, { headers: auth })).body.device.status, 'pending');
  refuses(await w.send('update', { protocol: 1, name: 'Mine' }, { headers: auth }), 403, 'pending');
  const left = await w.send('leave', { protocol: 1 }, { headers: auth });
  assert.equal(left.status, 200);
  refuses(await w.send('hello', { protocol: 1 }, { headers: auth }), 401, 'device_unknown');
  const kinds = (await w.team.readAudit('default', { limit: 500 })).rows.map((r) => r.kind);
  assert.deepEqual(kinds.slice(2), ['device_requested', 'device_left'], 'leaving while pending is logged');
});

test('pair needs exactly one of code and workspace; a workspace that does not exist is 404 not_found', async () => {
  const w = await wire();
  const code = await w.code();
  refuses(await w.send('pair', { protocol: 1, name: 'x' }), 400, 'bad_request');
  refuses(await w.send('pair', { protocol: 1, code, workspace: 'default', name: 'x' }), 400, 'bad_request');
  refuses(await w.send('pair', { protocol: 1, workspace: 'nowhere', name: 'x' }), 404, 'not_found');
  refuses(await w.send('pair', { protocol: 1, workspace: 5, name: 'x' }), 404, 'not_found');
  refuses(await w.send('pair', { protocol: 1, workspace: 'default', name: 'x'.repeat(101) }), 400, 'bad_request');
  refuses(await w.send('pair', { protocol: 1, workspace: 'default', name: 'x', access: 'sometimes' }), 400, 'bad_request');
  refuses(await w.send('pair', { protocol: 1, workspace: 'default', name: 'x', control: 'root' }), 400, 'bad_request');
  assert.equal(rows(w.db, 'SELECT COUNT(*) AS n FROM devices')[0].n, 0, 'nothing was made');
  assert.equal((await w.send('pair', { protocol: 1, code, name: 'still good' })).status, 201, 'the code survived the refusals');
});

test('the 21st request in an hour is 409 request_limit, and 409 pending_limit once 20 wait', async () => {
  const w = await wire();
  for (let i = 0; i < 20; i++) assert.equal((await w.send('pair', { protocol: 1, workspace: 'default', name: `PC ${i}` })).status, 202);
  refuses(await w.send('pair', { protocol: 1, workspace: 'default', name: 'PC 21' }), 409, 'request_limit');
  assert.equal(rows(w.db, "SELECT COUNT(*) AS n FROM devices WHERE status = 'pending'")[0].n, 20);
  // Requests older than an hour do not count, but 20 still wait.
  w.db.sqlite.exec(`UPDATE audit SET ts = ts - 7200000 WHERE kind = 'device_requested'`);
  refuses(await w.send('pair', { protocol: 1, workspace: 'default', name: 'PC 21' }), 409, 'pending_limit');
});

test('without AUTH_SECRET pair answers 503 unavailable; checking in and leaving still work', async () => {
  const w = await wire();
  const paired = await w.send('pair', { protocol: 1, code: await w.code(), name: 'x' });
  const bare = { ...w.env, AUTH_SECRET: undefined };
  const handler = createHandler('powershell agent');
  const send = (path, body, headers = {}) => handler.fetch(new Request(`${HOST}/device/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }), bare);
  for (const body of [{ protocol: 1, workspace: 'default', name: 'x' }, { protocol: 1, code: 'ABCDE-FGH23', name: 'x' }]) {
    const res = await send('pair', body);
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('retry-after'), '1');
    assert.deepEqual((await res.json()).error.code, 'unavailable');
  }
  assert.equal((await send('hello', { protocol: 1 }, w.bearer(paired.body.key))).status, 200);
  assert.equal((await send('leave', { protocol: 1 }, w.bearer(paired.body.key))).status, 200);
});

// ---- the request checks ------------------------------------------------------------------
test('POST only: every other method is 405 with Allow, and an unknown address is 404', async () => {
  const w = await wire();
  for (const name of ['pair', 'hello', 'update', 'leave']) {
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE', 'HEAD']) {
      const res = await w.send(name, undefined, { method });
      assert.equal(res.status, 405, `${method} ${name}`);
      assert.equal(res.headers.get('allow'), 'POST');
      if (method !== 'HEAD') assert.equal(res.body.error.code, 'method_not_allowed');
    }
  }
  for (const path of ['', 'nope', 'pair/', 'pair/x', '__proto__', 'constructor']) refuses(await w.send(path, { protocol: 1 }), 404, 'not_found');
});

test('plain http is 403 https_required, except on loopback', async () => {
  const w = await wire();
  refuses(await w.send('hello', { protocol: 1 }, { base: 'http://support.example.com' }), 403, 'https_required');
  refuses(await w.send('pair', { protocol: 1, workspace: 'default', name: 'x' }, { base: 'http://support.example.com' }), 403, 'https_required');
  assert.equal(rows(w.db, 'SELECT COUNT(*) AS n FROM devices')[0].n, 0);
  const local = await w.send('pair', { protocol: 1, workspace: 'default', name: 'x' }, { base: 'http://127.0.0.1:8787' });
  assert.equal(local.status, 202);
  assert.equal((await w.send('hello', { protocol: 1 }, { base: 'http://localhost:8787', headers: w.bearer(local.body.key) })).status, 200);
});

test('a request with an Origin header, or a key or code in the URL, is refused before anything is read', async () => {
  const w = await wire();
  const code = await w.code();
  const paired = await w.send('pair', { protocol: 1, code, name: 'x' });
  for (const name of ['pair', 'hello', 'update', 'leave']) {
    refuses(await w.send(name, { protocol: 1 }, { headers: { origin: 'https://evil.example', ...w.bearer(paired.body.key) } }), 403, 'forbidden');
    refuses(await w.send(name, { protocol: 1 }, { search: `?key=${paired.body.key}`, headers: w.bearer(paired.body.key) }), 400, 'bad_request');
    refuses(await w.send(name, { protocol: 1 }, { search: '?code=ABCDE-FGH23' }), 400, 'bad_request');
  }
  const queried = await w.send('pair', { protocol: 1, workspace: 'default', name: 'q' }, { search: '?key=' });
  refuses(queried, 400, 'bad_request');
  // The paired PC is untouched by all of it.
  assert.equal((await w.send('hello', { protocol: 1 }, { headers: w.bearer(paired.body.key) })).status, 200);
  assert.equal(rows(w.db, 'SELECT COUNT(*) AS n FROM devices')[0].n, 1);
});

test('the body must be JSON, an object, at most 8 KB, with an integer protocol', async () => {
  const w = await wire();
  const paired = await w.send('pair', { protocol: 1, code: await w.code(), name: 'x' });
  const auth = w.bearer(paired.body.key);
  for (const ct of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data']) {
    refuses(await w.send('hello', '{"protocol":1}', { headers: { 'content-type': ct, ...auth } }), 415, 'unsupported_media_type');
  }
  refuses(await w.send('hello', '{"protocol":1,"pad":"' + 'x'.repeat(8200) + '"}', { headers: auth }), 413, 'payload_too_large');
  // A lying or missing Content-Length is caught by the capped reader.
  const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(`{"protocol":1,"pad":"${'x'.repeat(5000)}`)); c.enqueue(new TextEncoder().encode(`${'x'.repeat(5000)}"}`)); c.close(); } });
  const streamed = await createHandler('powershell agent').fetch(new Request(`${HOST}/device/hello`, { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: stream, duplex: 'half' }), w.env);
  assert.equal(streamed.status, 413);
  refuses(await w.send('hello', '{"protocol":1', { headers: auth }), 400, 'bad_request');
  refuses(await w.send('hello', '', { headers: auth }), 400, 'bad_request');
  refuses(await w.send('hello', '[1]', { headers: auth }), 400, 'bad_request');
  refuses(await w.send('hello', 'null', { headers: auth }), 400, 'bad_request');
  for (const body of [{}, { protocol: '1' }, { protocol: 1.5 }, { protocol: null }, { protocol: true }, { os: 'x' }]) {
    refuses(await w.send('hello', body, { headers: auth }), 400, 'bad_request');
  }
  assert.equal((await w.send('hello', '{"protocol":1,"pad":"' + 'x'.repeat(100) + '"}', { headers: auth })).status, 200);
});

test('a protocol outside 1 to 1 is 426 with the supported range, on every address', async () => {
  const w = await wire();
  const paired = await w.send('pair', { protocol: 1, code: await w.code(), name: 'x' });
  for (const name of ['pair', 'hello', 'update', 'leave']) {
    for (const protocol of [2, 0, -1, 99]) {
      const res = await w.send(name, { protocol, workspace: 'default', name: 'x' }, { headers: w.bearer(paired.body.key) });
      assert.equal(res.status, 426, `${name} ${protocol}`);
      assert.deepEqual(res.body, {
        protocol: 1,
        error: { code: 'protocol_unsupported', message: res.body.error.message },
        supported: { min: 1, max: 1 },
      });
    }
  }
  assert.equal(rows(w.db, 'SELECT COUNT(*) AS n FROM devices')[0].n, 1, 'a refused protocol changes nothing');
});

test('a key that does not match the pattern, or no key, is 401 device_unknown without touching the database', async () => {
  const trap = { prepare() { throw new Error('DB touched'); }, batch() { throw new Error('DB touched'); } };
  const w = await wire({ DB: trap });
  const secret = 'A'.repeat(43);
  const id = 'a'.repeat(20);
  const keys = [
    'smd1', `smd1.default.${id}`, `smd2.default.${id}.${secret}`, `smd1.DEFAULT.${id}.${secret}`, `smd1.default.${id.toUpperCase()}.${secret}`,
    `smd1.default.${id.slice(1)}.${secret}`, `smd1.default.${id}.${secret.slice(1)}`, `smd1.default.${id}.${secret}x`, `smd1.${'a'.repeat(41)}.${id}.${secret}`,
    `smd1.default.${'1'.repeat(20)}.${secret}`, `smd1..${id}.${secret}`, `smd1.default.${id}.${secret}.extra`,
  ];
  for (const name of ['hello', 'update', 'leave']) {
    refuses(await w.send(name, { protocol: 1, name: 'x' }), 401, 'device_unknown');
    for (const key of keys) refuses(await w.send(name, { protocol: 1, name: 'x' }, { headers: w.bearer(key) }), 401, 'device_unknown');
    refuses(await w.send(name, { protocol: 1, name: 'x' }, { headers: { authorization: `Basic ${secret}` } }), 401, 'device_unknown');
    refuses(await w.send(name, { protocol: 1, name: 'x' }, { headers: { 'x-attach-key': secret } }), 401, 'device_unknown');
  }
});

test('a wrong secret, an unknown id and a removed PC all get the identical 401', async () => {
  const w = await wire();
  const paired = await w.send('pair', { protocol: 1, code: await w.code(), name: 'x' });
  const [, slug, id, secret] = paired.body.key.split('.');
  const wrongSecret = await w.send('hello', { protocol: 1 }, { headers: w.bearer(`smd1.${slug}.${id}.${'B'.repeat(43)}`) });
  const unknownId = await w.send('hello', { protocol: 1 }, { headers: w.bearer(`smd1.${slug}.${'c'.repeat(20)}.${secret}`) });
  const unknownWorkspace = await w.send('hello', { protocol: 1 }, { headers: w.bearer(`smd1.nowhere.${id}.${secret}`) });
  await w.send('leave', { protocol: 1 }, { headers: w.bearer(paired.body.key) });
  const removed = await w.send('hello', { protocol: 1 }, { headers: w.bearer(paired.body.key) });
  for (const res of [wrongSecret, unknownId, unknownWorkspace, removed]) {
    refuses(res, 401, 'device_unknown');
    assert.equal(res.text, wrongSecret.text);
  }
  assert.equal(JSON.stringify(wrongSecret.body).includes(secret), false, 'a key is never echoed');
});

test('a PC cannot reach another workspace: the key names its own, and an owner-started request lands where it says', async () => {
  const w = await wire({ DEPLOYMENT_ADMINS: BOSS });
  await teamStore(w.db, { deploymentAdmins: BOSS }).createWorkspace(BOSS, { slug: 'acme', name: 'Acme' });
  const a = await w.send('pair', { protocol: 1, workspace: 'acme', name: 'Acme PC' });
  assert.equal(a.body.workspace, 'acme');
  assert.match(a.body.key, /^smd1\.acme\./);
  const hello = await w.send('hello', { protocol: 1 }, { headers: w.bearer(a.body.key) });
  assert.equal(hello.body.device.workspace, 'acme');
  assert.deepEqual(rows(w.db, 'SELECT workspace FROM devices').map((r) => r.workspace), ['acme']);
  refuses(await w.send('hello', { protocol: 1 }, { headers: w.bearer(a.body.key.replace('smd1.acme.', 'smd1.default.')) }), 401, 'device_unknown');
});

test('/device/ is public: no Access token is needed, and the Access-gated paths still are', async () => {
  const w = await wire();
  const res = await w.send('pair', { protocol: 1, workspace: 'default', name: 'x' });
  assert.equal(res.status, 202);
  const api = await createHandler('powershell agent').fetch(new Request(`${HOST}/api/v1/w/default/devices`), w.env);
  assert.equal(api.status, 403);
  const noSlash = await createHandler('powershell agent').fetch(new Request(`${HOST}/device`, { method: 'POST' }), w.env);
  assert.equal(noSlash.status, 404);
});

test('without a database the wire answers 503 in its own envelope', async () => {
  const w = await wire({ DB: undefined });
  const res = await w.send('pair', { protocol: 1, workspace: 'default', name: 'x' });
  assert.equal(res.status, 503);
  assert.equal(res.body.protocol, 1);
  assert.equal(res.headers.get('retry-after'), '1');
});

// ---- the update offer ---------------------------------------------------------------------
// A relay with a fixture bundle and the deploy settings of a release signed by a throwaway key. signedAgoMs sets
// RELEASE_SIGNED_AT that long before now; rollout is UPDATE_ROLLOUT.
async function releaseWire({ rollout = '', signedAgoMs = 72 * 3600_000, signature, extra = {} } = {}) {
  const key = throwawayKey();
  const bundle = fixtureBundle();
  const exe = Buffer.from(bundle.exe_b64, 'base64');
  const signedAt = Math.floor((Date.now() - signedAgoMs) / 1000);
  const note = buildNote({ version: VERSION, sha256: createHash('sha256').update(exe).digest('hex'), size: exe.length, released: signedAt });
  const env = { RELEASE_SIGNATURE: signature ?? signNote(key, note), RELEASE_SIGNED_AT: String(signedAt), UPDATE_ROLLOUT: rollout, ...extra };
  const w = await wire(env, bundle);
  return { ...w, key, note };
}
const OLDER = '0.0.1';

test('a hello offers the signed release to an active PC on an older version, and the note verifies', async () => {
  const w = await releaseWire();
  const paired = await w.send('pair', { protocol: 1, code: await w.code(), name: 'Till', app_version: OLDER });
  const hello = await w.send('hello', { protocol: 1, app_version: OLDER }, { headers: w.bearer(paired.body.key) });
  assert.equal(hello.status, 200);
  assert.deepEqual(Object.keys(hello.body).sort(), ['device', 'hours_until', 'hours_utc', 'protocol', 'rules', 'rules_tag', 'server_time', 'update']);
  assert.deepEqual(hello.body.update, { version: VERSION, note: w.note, signature: w.env.RELEASE_SIGNATURE });
  assert.ok(verifies(w.key.xy, hello.body.update.note, hello.body.update.signature), 'the PC can verify what it is offered');
  // Without app_version in the request, the stored version decides.
  assert.ok((await w.send('hello', { protocol: 1 }, { headers: w.bearer(paired.body.key) })).body.update);
});

test('the offer matrix: version, status, rollout, group and the deploy settings', async () => {
  const offered = async (w, pairBody, helloBody) => {
    const paired = await w.send('pair', { protocol: 1, ...pairBody });
    const hello = await w.send('hello', { protocol: 1, ...helloBody }, { headers: w.bearer(paired.body.key) });
    assert.equal(hello.status, 200, hello.text);
    return { offered: Object.hasOwn(hello.body, 'update'), id: paired.body.device_id };
  };
  const w = await releaseWire();
  const active = async (version) => (await offered(w, { code: await w.code(), name: 'x' }, { app_version: version })).offered;
  assert.equal(await active(OLDER), true, 'older');
  assert.equal(await active(VERSION), false, 'equal');
  assert.equal(await active(`${VERSION}+build.9`), false, 'equal with build metadata');
  assert.equal(await active('99.0.0'), false, 'higher');
  assert.equal(await active('not a version'), false, 'unparseable');
  assert.equal((await offered(w, { workspace: 'default', name: 'x' }, { app_version: OLDER })).offered, false, 'a pending PC is never offered one');

  for (const rollout of ['pause', '0', 'sometimes']) {
    const r = await releaseWire({ rollout });
    assert.equal((await offered(r, { code: await r.code(), name: 'x' }, { app_version: OLDER })).offered, false, `rollout ${rollout}`);
  }
  // A pinned percentage takes PCs whose group is below it.
  const probe = await releaseWire({ rollout: '100' });
  const { id } = await offered(probe, { code: await probe.code(), name: 'x' }, { app_version: OLDER });
  const group = await groupOf(VERSION, 'default', id);
  for (const [pin, want] of [[group, false], [group + 1, true]]) {
    const r = await releaseWire({ rollout: String(pin) });
    const paired = await r.send('pair', { protocol: 1, code: await r.code(), name: 'x' });
    // Same group: move the PC to the probe's id, which keeps its key hash.
    r.db.sqlite.prepare('UPDATE devices SET id = ? WHERE id = ?').run(id, paired.body.device_id);
    const key = paired.body.key.replace(paired.body.device_id, id);
    const hello = await r.send('hello', { protocol: 1, app_version: OLDER }, { headers: r.bearer(key) });
    assert.equal(Object.hasOwn(hello.body, 'update'), want, `group ${group} with the rollout pinned at ${pin}`);
  }
  // On the schedule a fresh release reaches groups 0 to 9 only.
  const fresh = await releaseWire({ signedAgoMs: 0 });
  const paired = await fresh.send('pair', { protocol: 1, code: await fresh.code(), name: 'x' });
  fresh.db.sqlite.prepare('UPDATE devices SET id = ? WHERE id = ?').run(id, paired.body.device_id);
  const hello = await fresh.send('hello', { protocol: 1, app_version: OLDER }, { headers: fresh.bearer(paired.body.key.replace(paired.body.device_id, id)) });
  assert.equal(Object.hasOwn(hello.body, 'update'), group < 10, `a fresh release and group ${group}`);

  // Missing or malformed settings mean no release.
  for (const extra of [{ RELEASE_SIGNATURE: '' }, { RELEASE_SIGNED_AT: '' }, { RELEASE_SIGNATURE: 'abc' }, { RELEASE_SIGNED_AT: 'yesterday' }]) {
    const r = await releaseWire({ extra });
    assert.equal((await offered(r, { code: await r.code(), name: 'x' }, { app_version: OLDER })).offered, false, JSON.stringify(extra));
  }
});

test('a relay with no app bundle offers nothing, and the hello answer has no update', async () => {
  const signature = Buffer.alloc(64, 1).toString('base64');
  const w = await wire({ RELEASE_SIGNATURE: signature, RELEASE_SIGNED_AT: '1794000000', UPDATE_ROLLOUT: '100' });
  const paired = await w.send('pair', { protocol: 1, code: await w.code(), name: 'x' });
  const hello = await w.send('hello', { protocol: 1, app_version: OLDER }, { headers: w.bearer(paired.body.key) });
  assert.deepEqual(Object.keys(hello.body).sort(), ['device', 'hours_until', 'hours_utc', 'protocol', 'rules', 'rules_tag', 'server_time']);
});

test('working out the offer reads and writes nothing more in the database', async () => {
  const count = async (w) => {
    const paired = await w.send('pair', { protocol: 1, code: await w.code(), name: 'x' });
    const before = w.db.seen.length;
    const hello = await w.send('hello', { protocol: 1, app_version: OLDER }, { headers: w.bearer(paired.body.key) });
    return [Object.hasOwn(hello.body, 'update'), w.db.seen.length - before];
  };
  const [offeredOne, withRelease] = await count(await releaseWire({ rollout: '100' }));
  const [offeredNone, without] = await count(await wire());
  assert.deepEqual([offeredOne, offeredNone], [true, false]);
  assert.equal(withRelease, without, 'the same statements with and without an offer');
});

test('a 426 carries the signed release unless the rollout is paused or 0, on every address', async () => {
  const w = await releaseWire({ signedAgoMs: 0 });
  const paired = await w.send('pair', { protocol: 1, code: await w.code(), name: 'x' });
  for (const name of ['pair', 'hello', 'update', 'leave']) {
    const res = await w.send(name, { protocol: 2, name: 'x' }, { headers: w.bearer(paired.body.key) });
    assert.equal(res.status, 426);
    assert.deepEqual(res.body, {
      protocol: 1,
      error: { code: 'protocol_unsupported', message: res.body.error.message },
      supported: { min: 1, max: 1 },
      update: { version: VERSION, note: w.note, signature: w.env.RELEASE_SIGNATURE },
    }, name);
  }
  // No key is needed: a PC cut off by protocol may not even reach the key check.
  assert.ok((await w.send('hello', { protocol: 2 })).body.update);
  for (const rollout of ['pause', '0']) {
    const r = await releaseWire({ rollout });
    const res = await r.send('hello', { protocol: 2 });
    assert.equal(res.status, 426);
    assert.equal(Object.hasOwn(res.body, 'update'), false, rollout);
  }
  const none = await releaseWire({ extra: { RELEASE_SIGNATURE: '' } });
  assert.equal(Object.hasOwn((await none.send('hello', { protocol: 2 })).body, 'update'), false, 'no release, no update');
});

// ---- the Mac's release, and the rules per platform ------------------------------------------------------
const MAC_OS = 'macOS 26.1 (25B78)';
// A relay with both releases: the Windows one from releaseWire and a Mac one signed by the same throwaway key.
async function bothWire({ rollout = '', mac = true, windows = true } = {}) {
  const w = windows ? await releaseWire({ rollout }) : await wire({ UPDATE_ROLLOUT: rollout });
  const m = macRelease(w.key ?? throwawayKey(), { version: MAC_VERSION });
  if (mac) Object.assign(w.env, m.env);
  return { ...w, mac: m };
}
const helloAs = async (w, body, pairOs = '') => {
  const paired = await w.send('pair', { protocol: 1, code: await w.code(), name: 'x', app_version: OLDER, ...(pairOs ? { os: pairOs } : {}) });
  return w.send('hello', { protocol: 1, ...body }, { headers: w.bearer(paired.body.key) });
};

test('a check-in that reports a macOS os gets the Mac release, which verifies; a Windows os, or none, gets only the Windows one', async () => {
  const w = await bothWire();
  const mac = await helloAs(w, { app_version: OLDER, os: MAC_OS });
  assert.deepEqual(mac.body.update, { version: MAC_VERSION, note: w.mac.note, signature: w.mac.signature });
  assert.ok(verifies(w.key.xy, mac.body.update.note, mac.body.update.signature));
  for (const os of ['Windows 11 Pro', 'macOS', 'macOSX 14', 'MACOS 26', 'Mac OS X 14']) {
    const res = await helloAs(w, { app_version: OLDER, os });
    assert.deepEqual(res.body.update, { version: VERSION, note: w.note, signature: w.env.RELEASE_SIGNATURE }, `${os} is not a Mac`);
  }
  assert.equal((await helloAs(w, { app_version: OLDER })).body.update.version, VERSION, 'no os at all is not a Mac');
  // Without os in the request the stored one decides, as app_version does.
  const stored = await helloAs(w, {}, MAC_OS);
  assert.equal(stored.body.update.version, MAC_VERSION);
  // A Mac at the Mac release, or above it, is offered nothing, and a Mac below it is offered the Mac one, not the Windows one.
  assert.equal(Object.hasOwn((await helloAs(w, { app_version: MAC_VERSION, os: MAC_OS })).body, 'update'), false);
  assert.equal((await helloAs(w, { app_version: VERSION, os: MAC_OS })).body.update.version, MAC_VERSION, 'older than the Mac release, newer than nothing');
});

test('a Mac never gets the Windows release, and Windows never gets the Mac one', async () => {
  // A Windows release but no Mac one: a Mac is offered nothing.
  const onlyWindows = await bothWire({ mac: false });
  assert.equal(Object.hasOwn((await helloAs(onlyWindows, { app_version: OLDER, os: MAC_OS })).body, 'update'), false);
  assert.ok((await helloAs(onlyWindows, { app_version: OLDER, os: 'Windows 11' })).body.update);
  // A Mac release but no Windows release (no bundle): Windows is offered nothing, and the Mac its own.
  const onlyMac = await bothWire({ windows: false });
  assert.equal(Object.hasOwn((await helloAs(onlyMac, { app_version: OLDER, os: 'Windows 11' })).body, 'update'), false);
  assert.equal(Object.hasOwn((await helloAs(onlyMac, { app_version: OLDER })).body, 'update'), false);
  assert.equal((await helloAs(onlyMac, { app_version: OLDER, os: MAC_OS })).body.update.version, MAC_VERSION);
  // A malformed Mac setting is no Mac release.
  for (const extra of [{ MAC_RELEASE_NOTE: '' }, { MAC_RELEASE_SIGNATURE: '' }, { MAC_RELEASE_SIGNATURE: 'abc' }, { MAC_RELEASE_NOTE: 'bm90IGEgbm90ZQ==' }]) {
    const w = await bothWire({ windows: false });
    Object.assign(w.env, extra);
    assert.equal(Object.hasOwn((await helloAs(w, { app_version: OLDER, os: MAC_OS })).body, 'update'), false, JSON.stringify(extra));
  }
  // The Mac's own rollout: paused means no Mac update, as for Windows.
  const paused = await bothWire({ rollout: 'pause' });
  assert.equal(Object.hasOwn((await helloAs(paused, { app_version: OLDER, os: MAC_OS })).body, 'update'), false);
});

// The first id (20 base32 characters) whose group for a release version is below, or at or above, a stage.
async function idWithGroup(version, below, stage = 10) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  for (const a of alphabet) {
    for (const b of alphabet) {
      const id = `${'a'.repeat(18)}${a}${b}`;
      if (((await groupOf(version, 'default', id)) < stage) === below) return id;
    }
  }
  throw new Error('no id found');
}
// Pairs a Mac and gives it `id`, which keeps its key hash. Returns its key.
async function macWithId(w, id) {
  const paired = await w.send('pair', { protocol: 1, code: await w.code(), name: 'x', app_version: OLDER, os: MAC_OS });
  w.db.sqlite.prepare('UPDATE devices SET id = ? WHERE id = ?').run(id, paired.body.device_id);
  return paired.body.key.replace(paired.body.device_id, id);
}

test('a Mac release signed just now reaches a Mac by its own signing time and group, not the Windows release\'s', async () => {
  // This relay's Windows release is 72 hours old (stage 100); the Mac release was signed just now (stage 10).
  const w = await bothWire();
  Object.assign(w.env, macRelease(w.key, { signedAt: Math.floor(Date.now() / 1000) }).env);
  const inside = await idWithGroup(MAC_VERSION, true);
  const outside = await idWithGroup(MAC_VERSION, false);
  assert.ok((await groupOf(MAC_VERSION, 'default', inside)) < 10 && (await groupOf(MAC_VERSION, 'default', outside)) >= 10);
  const hello = async (id) => (await w.send('hello', { protocol: 1 }, { headers: w.bearer(await macWithId(w, id)) })).body;
  assert.equal((await hello(inside)).update?.version, MAC_VERSION, 'group below the Mac stage');
  assert.equal(Object.hasOwn(await hello(outside), 'update'), false, 'group at or above the Mac stage, though the Windows release would reach it');
});

test('the Mac has its own version line: 1.1.0 is offered to a Mac on 1.0.x whatever the relay\'s VERSION is, and so is a version below VERSION', async () => {
  for (const [macVersion, macOn, upToDate] of [['1.1.0', '1.0.5', '1.1.0'], ['0.9.0', '0.8.0', '0.9.0']]) {
    const w = await bothWire();
    Object.assign(w.env, macRelease(w.key, { version: macVersion }).env);
    const answer = async (app_version) => helloAs(w, { app_version, os: MAC_OS });
    assert.equal((await answer(macOn)).body.update?.version, macVersion, `${macOn} is offered ${macVersion}`);
    assert.equal(Object.hasOwn((await answer(upToDate)).body, 'update'), false, `${upToDate} is current`);
    const refused = await w.send('hello', { protocol: 2, os: MAC_OS });
    assert.equal(refused.body.update?.version, macVersion, 'on a 426 too');
    // Windows is still offered its own release, not the Mac one, and by VERSION.
    assert.equal((await helloAs(w, { app_version: OLDER, os: 'Windows 11' })).body.update.version, VERSION);
  }
});

test('a Windows check-in answer is byte-identical with and without the Mac settings', async () => {
  const w = await bothWire({ mac: false });
  const answer = async (body, key) => {
    const res = await w.send('hello', { protocol: 1, ...body }, { headers: w.bearer(key) });
    const parsed = JSON.parse(res.text);
    delete parsed.server_time; // the relay's clock, which can tick between two calls
    return JSON.stringify(parsed);
  };
  for (const [os, version] of [['Windows 11 Pro', OLDER], ['Windows 11 Pro', VERSION], ['', OLDER]]) {
    const paired = await w.send('pair', { protocol: 1, code: await w.code(), name: 'x', app_version: version, ...(os ? { os } : {}) });
    const body = { app_version: version, ...(os ? { os } : {}) };
    const before = await answer(body, paired.body.key);
    Object.assign(w.env, w.mac.env);
    const after = await answer(body, paired.body.key);
    delete w.env.MAC_RELEASE_NOTE;
    delete w.env.MAC_RELEASE_SIGNATURE;
    assert.equal(after, before, `${os || 'no os'} on ${version}`);
  }
  // A 426 for a Windows body, or for one with no os, is the same too.
  const refusal = async (body) => (await w.send('hello', { protocol: 2, ...body })).text;
  const beforeRefusal = [await refusal({}), await refusal({ os: 'Windows 11' }), await refusal({ os: 7 })];
  Object.assign(w.env, w.mac.env);
  assert.deepEqual([await refusal({}), await refusal({ os: 'Windows 11' }), await refusal({ os: 7 })], beforeRefusal);
});

test('a 426 carries the Mac release for a body that reports a macOS os, and only that', async () => {
  const w = await bothWire({ rollout: '100' });
  const mac = await w.send('hello', { protocol: 2, os: MAC_OS });
  assert.equal(mac.status, 426);
  assert.deepEqual(mac.body.update, { version: MAC_VERSION, note: w.mac.note, signature: w.mac.signature });
  for (const name of ['pair', 'update', 'leave']) assert.equal((await w.send(name, { protocol: 2, os: MAC_OS })).body.update.version, MAC_VERSION, name);
  // Windows, no os, a bad os (not text, too long, a control character) are not a Mac.
  for (const os of ['Windows 11', undefined, 7, null, ['macOS 26'], `macOS ${'x'.repeat(100)}`, 'macOS 26\u0007']) {
    const res = await w.send('hello', { protocol: 2, ...(os === undefined ? {} : { os }) });
    assert.equal(res.body.update.version, VERSION, JSON.stringify(os));
  }
  // A Mac with no Mac release is offered nothing on a 426, though there is a Windows one.
  const none = await bothWire({ mac: false });
  assert.equal(Object.hasOwn((await none.send('hello', { protocol: 2, os: MAC_OS })).body, 'update'), false);
  // A Mac release only, and a Windows body: nothing.
  const onlyMac = await bothWire({ windows: false });
  assert.equal(Object.hasOwn((await onlyMac.send('hello', { protocol: 2, os: 'Windows 11' })).body, 'update'), false);
  assert.equal((await onlyMac.send('hello', { protocol: 2, os: MAC_OS })).body.update.version, MAC_VERSION);
});

test('protected folders reach each PC by platform, and the tag of each is what its Session decides with', async () => {
  const w = await wire();
  const store = rulesFromEnv(w.env, w.team);
  const pcs = {};
  for (const [name, os] of [['win', 'Windows 11 Pro'], ['mac', MAC_OS], ['none', '']]) {
    const paired = await w.send('pair', { protocol: 1, code: await w.code(), name, ...(os ? { os } : {}) });
    pcs[name] = paired.body;
  }
  const hello = async (name) => (await w.send('hello', { protocol: 1 }, { headers: w.bearer(pcs[name].key) })).body;
  const winBefore = await hello('win');
  assert.deepEqual(winBefore.rules.protected_folders, []);

  const saved = await store.save('default', BOSS, '', { protected_folders: ['C:\\Data', '/Users/a/Docs', 'D:/More', '/Library/Stuff'] }, 0);
  assert.ok(saved);
  const win = await hello('win'), mac = await hello('mac'), none = await hello('none');
  assert.deepEqual(win.rules.protected_folders, ['C:\\Data', 'D:/More']);
  assert.deepEqual(mac.rules.protected_folders, ['/Users/a/Docs', '/Library/Stuff']);
  assert.deepEqual(none.rules.protected_folders, win.rules.protected_folders, 'a PC that reports no os is not a Mac');
  assert.notEqual(win.rules_tag, mac.rules_tag);
  // The Session reads the same rules for the same PC: the tag is the one the check-in gave.
  for (const [name, answer] of [['win', win], ['mac', mac], ['none', none]]) {
    const read = await w.devs.rulesFor('default', pcs[name].device_id);
    assert.equal(read.tag, answer.rules_tag, name);
    assert.deepEqual(read.rules.protected_folders, answer.rules.protected_folders, name);
  }
  // A Windows PC's rules and tag are what they would be with no Mac folder in the team's document.
  const plain = await store.save('default', BOSS, '', { protected_folders: ['C:\\Data', 'D:/More'] }, saved.rev ?? 1);
  assert.ok(plain);
  const winAlone = await hello('win');
  assert.equal(winAlone.rules_tag, win.rules_tag);
  assert.deepEqual({ ...winAlone.rules, rev: 0 }, { ...win.rules, rev: 0 });
  // A Mac in a team with only Windows folders gets none.
  assert.deepEqual((await hello('mac')).rules.protected_folders, []);
});

test('a pair request that carries a macOS os stores it, so the first check-in already gets only the Mac folders', async () => {
  const w = await wire();
  const store = rulesFromEnv(w.env, w.team);
  assert.ok(await store.save('default', BOSS, '', { protected_folders: ['C:\\Data', '/Users/a/Docs', '/Library/Stuff'] }, 0));
  const mac = await w.send('pair', { protocol: 1, code: await w.code(), name: 'Mac', os: MAC_OS, machine: 'Mac-1', app_version: OLDER });
  assert.equal(mac.status, 201);
  assert.equal(rows(w.db, 'SELECT os FROM devices WHERE id = ?', mac.body.device_id)[0].os, MAC_OS, 'stored at pairing');
  // The first hello after pairing, with no os in it, reads the stored one.
  const first = await w.send('hello', { protocol: 1 }, { headers: w.bearer(mac.body.key) });
  assert.deepEqual(first.body.rules.protected_folders, ['/Users/a/Docs', '/Library/Stuff']);
  // A Windows PC paired the same way gets the other half.
  const win = await w.send('pair', { protocol: 1, code: await w.code(), name: 'Win', os: 'Windows 11 Pro' });
  const winFirst = await w.send('hello', { protocol: 1 }, { headers: w.bearer(win.body.key) });
  assert.deepEqual(winFirst.body.rules.protected_folders, ['C:\\Data']);
  assert.equal((await w.devs.rulesFor('default', mac.body.device_id)).tag, first.body.rules_tag);
});
