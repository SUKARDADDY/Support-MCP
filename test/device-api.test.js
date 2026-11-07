// The PC wire: POST /device/pair, /device/hello, /device/update and
// /device/leave. These addresses are public (a PC has no Access login), so the
// tests send no Access token anywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openD1 } from './d1-fake.js';
import { createHandler } from '../src/app.js';
import { teamStore } from '../src/workspace.js';
import { deviceStore } from '../src/devices.js';

const HOST = 'https://support.example.com';
const SECRET = 'a-deployment-secret-of-at-least-32-characters';
const BOSS = 'boss@example.com';
const KEY_PATTERN = /^smd1\.default\.[a-z2-7]{20}\.[A-Za-z0-9_-]{43}$/;

async function wire(extra = {}) {
  const db = openD1();
  const env = { DB: db, AUTH_SECRET: SECRET, ...extra };
  const team = teamStore(db);
  const devs = deviceStore(db, team, { authSecret: SECRET });
  await team.addMember('default', BOSS, { identity: BOSS, role_id: 'admin' });
  const handler = createHandler('powershell agent');
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
  const paired = await w.send('pair', { protocol: 1, code: await w.code(), name: 'Front desk', access: 'ask', control: 'full', owner_contact: 'Sam', os: 'Windows 10 Pro 22H2', machine: 'POS-1', app_version: '0.4.0' });
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
  assert.deepEqual(hello.body, {
    protocol: 1,
    device: { id: paired.body.device_id, workspace: 'default', status: 'active', name: 'Front desk', access: 'ask', control: 'full', site_id: null },
  });
  assert.deepEqual({ ...rows(w.db, 'SELECT os, app_version FROM devices')[0] }, { os: 'Windows 11', app_version: '0.4.1' });

  const updated = await w.send('update', { protocol: 1, name: 'Till', access: 'any', control: 'limited', owner_contact: 'Dana' }, { headers: w.bearer(paired.body.key) });
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
