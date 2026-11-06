// The team API for customers, sites, saved PCs, custom fields and pairing codes,
// under /api/v1/w/<slug>/... Callers sign in with Access JWTs signed by a local
// key, as in test/api.test.js; nothing touches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openD1 } from './d1-fake.js';
import { createHandler } from '../src/app.js';
import { importRsaJwk } from '../src/jwt.js';

const TEAM = 'devices-api-test.cloudflareaccess.com';
const AUD = 'devices-api-test-aud';
const HOST = 'https://support.example.com';
const SECRET = 'a-deployment-secret-of-at-least-32-characters';

const kp = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', kp.publicKey)), kid: 'k1' };
await importRsaJwk(jwk, crypto.subtle);
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url) === `https://${TEAM}/cdn-cgi/access/certs`) return Response.json({ keys: [jwk] });
  return realFetch(url, init);
};
const b64url = (u8) => btoa(String.fromCharCode(...u8)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const enc = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
const tokens = new Map();
async function as(who) {
  if (!tokens.has(who)) {
    const claims = { email: who };
    const input = `${enc({ alg: 'RS256', kid: 'k1', typ: 'JWT' })}.${enc({ aud: AUD, iss: `https://${TEAM}`, exp: Math.floor(Date.now() / 1000) + 600, ...claims })}`;
    const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', kp.privateKey, new TextEncoder().encode(input)));
    tokens.set(who, `${input}.${b64url(sig)}`);
  }
  return tokens.get(who);
}

const BOSS = 'boss@example.com';
const TECH = 'tech@example.com';
const VIEW = 'view@example.com';
const OTHER = 'other@example.com';

function relay(extra = {}) {
  const env = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, DEPLOYMENT_ADMINS: BOSS, AUTH_SECRET: SECRET, DB: openD1(), ...extra };
  const handler = createHandler('powershell agent');
  const raw = async (who, method, path, body, headers = {}) => {
    const h = { 'cf-access-jwt-assertion': await as(who), ...headers };
    if (method !== 'GET' && !('content-type' in h)) h['content-type'] = 'application/json';
    return handler.fetch(new Request(`${HOST}${path}`, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) }), env);
  };
  const call = async (slug, who, method, path, body) => {
    const r = await raw(who, method, `/api/v1/w/${slug}${path}`, body);
    return { status: r.status, body: await r.json(), headers: r.headers };
  };
  const api = (who, method, path, body) => call('default', who, method, path, body);
  // A PC's request to the public wire.
  const pc = async (path, body, headers = {}) => {
    const r = await handler.fetch(new Request(`${HOST}/device/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }), env);
    return { status: r.status, body: await r.json() };
  };
  return { env, handler, raw, call, api, pc };
}

const ok = async (p, status = 200) => { const r = await p; assert.equal(r.status, status, JSON.stringify(r.body)); return r; };
const err = async (p, status, code) => {
  const r = await p;
  assert.deepEqual([r.status, r.body.error?.code], [status, code], JSON.stringify(r.body));
  return r;
};

// BOSS (admin), a technician and a viewer, in default.
async function team(extra) {
  const r = relay(extra);
  await ok(r.api(BOSS, 'POST', '/members', { identity: BOSS, role_id: 'admin' }), 201);
  await ok(r.api(BOSS, 'POST', '/members', { identity: TECH, role_id: 'technician' }), 201);
  await ok(r.api(BOSS, 'POST', '/members', { identity: VIEW, role_id: 'viewer' }), 201);
  return r;
}

// ---- the gate ---------------------------------------------------------------------
test('the new collections keep the API gate: Origin, non-JSON writes and a failed Access check never reach the database', async () => {
  const trap = { prepare() { throw new Error('DB touched'); }, batch() { throw new Error('DB touched'); } };
  const r = relay({ DB: trap });
  for (const path of ['customers', 'sites', 'devices', 'fields', 'pairing']) {
    let res = await r.raw(BOSS, 'GET', `/api/v1/w/default/${path}`, undefined, { origin: 'https://evil.example' });
    assert.equal(res.status, 403, path);
    for (const method of ['POST', 'PATCH', 'DELETE']) {
      res = await r.raw(BOSS, method, `/api/v1/w/default/${path}`, '{}', { 'content-type': 'text/plain' });
      assert.equal(res.status, 415, `${method} ${path}`);
    }
    res = await r.handler.fetch(new Request(`${HOST}/api/v1/w/default/${path}`), r.env);
    assert.equal(res.status, 403);
  }
});

// ---- who may do what ---------------------------------------------------------------
test('viewers read but do not change; technicians pair; only field managers define fields', async () => {
  const r = await team();
  const customer = (await ok(r.api(TECH, 'POST', '/customers', { name: 'Dana' }), 201)).body.customer;
  const site = (await ok(r.api(TECH, 'POST', '/sites', { name: 'HQ', customer_id: customer.id }), 201)).body.site;
  const field = (await ok(r.api(BOSS, 'POST', '/fields', { entity: 'device', label: 'Asset tag' }), 201)).body.field;
  const pairing = (await ok(r.api(TECH, 'POST', '/pairing', {}), 201)).body.pairing;
  const redeemed = await ok(r.pc('pair', { protocol: 1, code: pairing.code, name: 'Till' }), 201);
  const deviceId = redeemed.body.device_id;

  // A viewer reads all four, but not the pairing list (devices.manage).
  for (const path of ['/customers', `/customers/${customer.id}`, '/sites', `/sites/${site.id}`, '/devices', `/devices/${deviceId}`, '/fields']) {
    await ok(r.api(VIEW, 'GET', path));
  }
  await err(r.api(VIEW, 'GET', '/pairing'), 403, 'permission_denied');
  const writes = [
    ['POST', '/customers', { name: 'X' }], ['PATCH', `/customers/${customer.id}`, { name: 'X' }], ['DELETE', `/customers/${customer.id}`],
    ['POST', '/sites', { name: 'X', customer_id: customer.id }], ['PATCH', `/sites/${site.id}`, { name: 'X' }], ['DELETE', `/sites/${site.id}`],
    ['PATCH', `/devices/${deviceId}`, { access: 'any' }], ['DELETE', `/devices/${deviceId}`],
    ['POST', '/pairing', {}], ['DELETE', `/pairing/${pairing.id}`],
    ['POST', '/fields', { entity: 'site', label: 'X' }], ['PATCH', `/fields/${field.id}`, { label: 'X' }], ['DELETE', `/fields/${field.id}`],
  ];
  for (const [method, path, body] of writes) await err(r.api(VIEW, method, path, body ?? {}), 403, 'permission_denied');
  // A technician manages devices but does not define fields.
  for (const [method, path, body] of writes.filter(([, p]) => p.startsWith('/fields'))) await err(r.api(TECH, method, path, body ?? {}), 403, 'permission_denied');
  // A stranger is not a member.
  for (const path of ['/customers', '/sites', '/devices', '/fields', '/pairing']) await err(r.api(OTHER, 'GET', path), 403, 'not_member');
  await err(r.api(OTHER, 'POST', '/customers', { name: 'X' }), 403, 'not_member');
  assert.equal((await ok(r.api(BOSS, 'GET', '/customers'))).body.customers.length, 1, 'nothing the refused calls tried got through');
});

test('while default is open, the records are closed: reads are denied and writes ask for the first admin', async () => {
  const r = relay();
  for (const path of ['/customers', '/sites', '/devices', '/fields', '/pairing']) await err(r.api(OTHER, 'GET', path), 403, 'permission_denied');
  await err(r.api(OTHER, 'POST', '/customers', { name: 'X' }), 409, 'first_member');
  await err(r.api(OTHER, 'POST', '/pairing', {}), 409, 'first_member');
  await err(r.api(OTHER, 'POST', '/fields', { entity: 'site', label: 'X' }), 409, 'first_member');
});

test('a custom role with only devices.view reads; with fields.manage it defines fields without full admin', async () => {
  const r = await team();
  await ok(r.api(BOSS, 'POST', '/roles', { id: 'fieldkeeper', permissions: ['devices.view', 'fields.manage'] }), 201);
  await ok(r.api(BOSS, 'POST', '/members', { identity: OTHER, role_id: 'fieldkeeper' }), 201);
  await ok(r.api(OTHER, 'POST', '/fields', { entity: 'customer', label: 'Contract' }), 201);
  await ok(r.api(OTHER, 'GET', '/customers'));
  await err(r.api(OTHER, 'POST', '/customers', { name: 'X' }), 403, 'permission_denied');
});

// ---- customers and sites ------------------------------------------------------------
test('customers and sites: create, read, change, page and remove', async () => {
  const r = await team();
  const created = await ok(r.api(TECH, 'POST', '/customers', { name: 'Dana Cohen', phone: '050', email: 'd@example.com', notes: 'VIP' }), 201);
  const c = created.body.customer;
  assert.match(c.id, /^[a-z2-7]{20}$/);
  assert.deepEqual([c.name, c.phone, c.email, c.notes, c.fields, c.created_by], ['Dana Cohen', '050', 'd@example.com', 'VIP', {}, TECH]);
  assert.deepEqual((await ok(r.api(VIEW, 'GET', `/customers/${c.id}`))).body.customer, c);
  const patched = (await ok(r.api(TECH, 'PATCH', `/customers/${c.id}`, { phone: '052' }))).body.customer;
  assert.deepEqual([patched.phone, patched.name], ['052', 'Dana Cohen']);
  await err(r.api(TECH, 'POST', '/sites', { name: 'HQ' }), 400, 'bad_request');
  await err(r.api(TECH, 'POST', '/sites', { name: 'HQ', customer_id: 'a'.repeat(20) }), 400, 'unknown_customer');
  const site = (await ok(r.api(TECH, 'POST', '/sites', { name: 'HQ', customer_id: c.id, address: '1 High St' }), 201)).body.site;
  const other = (await ok(r.api(TECH, 'POST', '/customers', { name: 'Eli' }), 201)).body.customer;
  await ok(r.api(TECH, 'POST', '/sites', { name: 'Shop', customer_id: other.id }), 201);
  assert.deepEqual((await ok(r.api(VIEW, 'GET', `/sites?customer=${c.id}`))).body.sites.map((s) => s.id), [site.id]);
  assert.equal((await ok(r.api(VIEW, 'GET', '/sites'))).body.sites.length, 2);
  await err(r.api(TECH, 'DELETE', `/customers/${c.id}`), 409, 'in_use');
  await ok(r.api(TECH, 'DELETE', `/sites/${site.id}`));
  assert.deepEqual((await ok(r.api(TECH, 'DELETE', `/customers/${c.id}`))).body, { removed: { id: c.id } });
  await err(r.api(VIEW, 'GET', `/customers/${c.id}`), 404, 'not_found');
  await err(r.api(TECH, 'DELETE', `/customers/${c.id}`), 404, 'not_found');
  // A path id that is not an id, and routes that do not exist.
  for (const path of ['/customers/nope', '/customers/UPPERCASEUPPERCASE00', `/customers/${c.id}/sites`]) await err(r.api(VIEW, 'GET', path), 404, 'not_found');
  await err(r.api(TECH, 'PUT', '/customers', {}), 405, 'method_not_allowed');
  await err(r.api(TECH, 'POST', `/customers/${other.id}`, {}), 405, 'method_not_allowed');
  assert.equal((await ok(r.api(BOSS, 'GET', '/audit?verify=full'))).body.verified, true);
});

test('lists page by id with ?after and ?limit, and bad parameters are 400', async () => {
  const r = await team();
  for (let i = 0; i < 5; i++) await ok(r.api(TECH, 'POST', '/customers', { name: `C${i}` }), 201);
  const one = (await ok(r.api(VIEW, 'GET', '/customers?limit=2'))).body;
  assert.equal(one.customers.length, 2);
  assert.equal(one.next, one.customers[1].id);
  const two = (await ok(r.api(VIEW, 'GET', `/customers?limit=2&after=${one.next}`))).body;
  const three = (await ok(r.api(VIEW, 'GET', `/customers?limit=2&after=${two.next}`))).body;
  assert.deepEqual([three.customers.length, three.next], [1, null]);
  assert.equal(new Set([...one.customers, ...two.customers, ...three.customers].map((c) => c.id)).size, 5);
  for (const q of ['limit=0', 'limit=501', 'limit=x', 'after=nope', 'after=ABCDEFGHIJKLMNOPQRST']) await err(r.api(VIEW, 'GET', `/customers?${q}`), 400, 'bad_request');
  await err(r.api(VIEW, 'GET', '/sites?customer=nope'), 400, 'bad_request');
  await err(r.api(VIEW, 'GET', '/devices?status=gone'), 400, 'bad_request');
  await err(r.api(VIEW, 'GET', '/devices?site=nope'), 400, 'bad_request');
  assert.equal((await ok(r.api(VIEW, 'GET', '/customers?limit=500'))).body.customers.length, 5);
  assert.equal((await ok(r.api(VIEW, 'GET', '/customers?after=&limit='))).body.customers.length, 5, 'empty means left out');
});

test('the record routes take 32 KB bodies; the rest of the team API stays at 16 KB', async () => {
  const r = await team();
  const fields = [];
  for (let i = 0; i < 30; i++) fields.push((await ok(r.api(BOSS, 'POST', '/fields', { entity: 'customer', label: `F${i}` }), 201)).body.field.id);
  const big = Object.fromEntries(fields.map((id) => [id, 'x'.repeat(500)]));
  const body = { name: 'Dana', notes: 'n'.repeat(2000), fields: big };
  assert.equal(JSON.stringify(body).length > 16384, true);
  const made = (await ok(r.api(TECH, 'POST', '/customers', body), 201)).body.customer;
  assert.equal(Object.keys(made.fields).length, 30);
  await err(r.api(TECH, 'POST', '/customers', { name: 'Dana', pad: 'x'.repeat(33000) }), 400, 'bad_request');
  await err(r.api(TECH, 'PATCH', `/customers/${made.id}`, { pad: 'x'.repeat(33000) }), 400, 'bad_request');
  await err(r.api(BOSS, 'POST', '/fields', { entity: 'site', label: 'x', pad: 'x'.repeat(17000) }), 400, 'bad_request');
  await err(r.api(TECH, 'POST', '/pairing', { pad: 'x'.repeat(17000) }), 400, 'bad_request');
  // Over the declared length too.
  const res = await r.raw(TECH, 'POST', '/api/v1/w/default/customers', '{}', { 'content-length': '40000' });
  assert.equal(res.status, 400);
});

// ---- custom fields -------------------------------------------------------------------
test('custom fields: values are text, ids must be defined for that record type, and a removed definition clears its values', async () => {
  const r = await team();
  const f = (await ok(r.api(BOSS, 'POST', '/fields', { entity: 'customer', label: 'Contract until' }), 201)).body.field;
  assert.deepEqual([f.entity, f.label, f.position], ['customer', 'Contract until', 0]);
  const listed = (await ok(r.api(VIEW, 'GET', '/fields'))).body.fields;
  assert.deepEqual(listed.map((x) => x.id), [f.id]);
  const c = (await ok(r.api(TECH, 'POST', '/customers', { name: 'Dana', fields: { [f.id]: 'June 2027' } }), 201)).body.customer;
  assert.deepEqual(c.fields, { [f.id]: 'June 2027' });
  await err(r.api(TECH, 'PATCH', `/customers/${c.id}`, { fields: { [f.id]: 5 } }), 400, 'bad_request');
  await err(r.api(TECH, 'PATCH', `/customers/${c.id}`, { fields: { [f.id]: 'x'.repeat(501) } }), 400, 'bad_request');
  await err(r.api(TECH, 'PATCH', `/customers/${c.id}`, { fields: { aaaaaaaaaaaaaaaaaaaa: 'x' } }), 400, 'bad_request');
  await err(r.api(TECH, 'PATCH', `/customers/${c.id}`, { fields: 'x' }), 400, 'bad_request');
  assert.equal((await ok(r.api(BOSS, 'PATCH', `/fields/${f.id}`, { label: 'Renewal' }))).body.field.label, 'Renewal');
  await err(r.api(BOSS, 'PATCH', `/fields/${f.id}`, {}), 400, 'bad_request');
  await err(r.api(BOSS, 'POST', '/fields', { entity: 'nope', label: 'x' }), 400, 'bad_request');
  await ok(r.api(BOSS, 'DELETE', `/fields/${f.id}`));
  assert.deepEqual((await ok(r.api(VIEW, 'GET', `/customers/${c.id}`))).body.customer.fields, {});
  await err(r.api(BOSS, 'DELETE', `/fields/${f.id}`), 404, 'not_found');
});

// ---- pairing ---------------------------------------------------------------------------
test('a pairing code is shown once, in the 201 answer, and never listed', async () => {
  const r = await team();
  const made = (await ok(r.api(TECH, 'POST', '/pairing', {}), 201)).body.pairing;
  assert.match(made.code, /^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
  assert.deepEqual(Object.keys(made).sort(), ['code', 'expires_at', 'id', 'site_id']);
  const listed = await ok(r.api(TECH, 'GET', '/pairing'));
  assert.equal(JSON.stringify(listed.body).includes(made.code.replace('-', '')), false);
  assert.deepEqual(listed.body.pairings.map((p) => p.id), [made.id]);
  assert.equal(JSON.stringify(listed.body).includes('hash'), false);
  await ok(r.api(TECH, 'DELETE', `/pairing/${made.id}`));
  await err(r.pc('pair', { protocol: 1, code: made.code, name: 'Late' }), 404, 'code_invalid');
  await err(r.api(TECH, 'DELETE', `/pairing/${made.id}`), 404, 'not_found');
  await err(r.api(TECH, 'GET', `/pairing/${made.id}`), 405, 'method_not_allowed');
  for (let i = 0; i < 20; i++) await ok(r.api(TECH, 'POST', '/pairing', {}), 201);
  await err(r.api(TECH, 'POST', '/pairing', {}), 409, 'code_limit');
  const site = (await ok(r.api(TECH, 'POST', '/customers', { name: 'D' }), 201)).body.customer;
  await err(r.api(TECH, 'POST', '/pairing', { site_id: site.id }), 409, 'code_limit');
  await err(r.api(TECH, 'POST', '/pairing', { site_id: 'nope' }), 400, 'bad_request');
});

test('without AUTH_SECRET the pairing routes answer 503 unavailable with retry-after, and the rest of the API works', async () => {
  const r = await team({ AUTH_SECRET: undefined });
  const res = await err(r.api(TECH, 'POST', '/pairing', {}), 503, 'unavailable');
  assert.equal(res.headers.get('retry-after'), '1');
  await ok(r.api(TECH, 'POST', '/customers', { name: 'Dana' }), 201);
  await err(r.api(VIEW, 'GET', '/pairing'), 403, 'permission_denied');
});

// ---- saved PCs -------------------------------------------------------------------------
test('a paired PC is listed without its hashes; a technician sets its site and fields, and its access mode (logged as theirs)', async () => {
  const r = await team();
  const customer = (await ok(r.api(TECH, 'POST', '/customers', { name: 'Dana' }), 201)).body.customer;
  const site = (await ok(r.api(TECH, 'POST', '/sites', { name: 'HQ', customer_id: customer.id }), 201)).body.site;
  const field = (await ok(r.api(BOSS, 'POST', '/fields', { entity: 'device', label: 'Asset tag' }), 201)).body.field;
  const pairing = (await ok(r.api(TECH, 'POST', '/pairing', { site_id: site.id }), 201)).body.pairing;
  assert.equal(pairing.site_id, site.id);
  const paired = (await ok(r.pc('pair', { protocol: 1, code: pairing.code, name: 'Till', access: 'ask', control: 'limited', owner_contact: 'Sam' }), 201)).body;
  const shown = (await ok(r.api(VIEW, 'GET', `/devices/${paired.device_id}`))).body.device;
  assert.deepEqual([shown.name, shown.site_id, shown.status, shown.access, shown.control, shown.paired_by], ['Till', site.id, 'active', 'ask', 'limited', TECH]);
  assert.equal(/key_hash|confirm_hash|"key"|secret/.test(JSON.stringify(shown)), false);
  const list = JSON.stringify((await ok(r.api(VIEW, 'GET', '/devices'))).body);
  assert.equal(list.includes(paired.key.split('.')[3]), false);
  assert.equal(/key_hash|confirm_hash/.test(list), false);
  // The technician moves it, labels it, and switches its access.
  const patched = (await ok(r.api(TECH, 'PATCH', `/devices/${paired.device_id}`, { site_id: null, fields: { [field.id]: 'T-9' }, access: 'any' }))).body.device;
  assert.deepEqual([patched.site_id, patched.fields, patched.access, patched.control, patched.name], [null, { [field.id]: 'T-9' }, 'any', 'limited', 'Till']);
  const log = (await ok(r.api(BOSS, 'GET', '/audit?limit=500'))).body.rows;
  const changed = log.filter((x) => x.kind === 'device_changed');
  assert.equal(changed.length, 1);
  assert.deepEqual([changed[0].actor], [TECH]);
  assert.match(changed[0].detail, /access ask to any/);
  assert.match(changed[0].detail, /site .* to none/);
  assert.equal(changed[0].detail.includes('T-9'), false, 'a field value is not logged');
  // The PC's own hello still works, and shows the technician's access change.
  const hello = await ok(r.pc('hello', { protocol: 1 }, { authorization: `Bearer ${paired.key}` }));
  assert.equal(hello.body.device.access, 'any');
  await err(r.api(TECH, 'PATCH', `/devices/${paired.device_id}`, { access: 'sometimes' }), 400, 'bad_request');
  await err(r.api(TECH, 'PATCH', `/devices/${paired.device_id}`, {}), 400, 'bad_request');
  await err(r.api(TECH, 'PATCH', `/devices/${paired.device_id}`, { site_id: 'a'.repeat(20) }), 400, 'unknown_site');
  await err(r.api(TECH, 'POST', '/devices', {}), 405, 'method_not_allowed');
});

test('approving a waiting PC takes its six-digit number; deleting a PC ends its key at once', async () => {
  const r = await team();
  const waiting = (await ok(r.pc('pair', { protocol: 1, workspace: 'default', name: 'Kitchen' }), 202)).body;
  const auth = { authorization: `Bearer ${waiting.key}` };
  const shown = (await ok(r.api(VIEW, 'GET', `/devices/${waiting.device_id}`))).body.device;
  assert.deepEqual([shown.status, shown.expires_at], ['pending', waiting.expires_at]);
  assert.equal(JSON.stringify(shown).includes(waiting.confirm), false);
  assert.equal((await ok(r.api(VIEW, 'GET', '/devices?status=pending'))).body.devices.length, 1);
  await err(r.api(VIEW, 'PATCH', `/devices/${waiting.device_id}`, { approve: { confirm: waiting.confirm } }), 403, 'permission_denied');
  const wrong = waiting.confirm === '000000' ? '111111' : '000000';
  await err(r.api(TECH, 'PATCH', `/devices/${waiting.device_id}`, { approve: { confirm: wrong } }), 403, 'confirm_wrong');
  await err(r.api(TECH, 'PATCH', `/devices/${waiting.device_id}`, { approve: { confirm: 'abc' } }), 400, 'bad_request');
  await err(r.api(TECH, 'PATCH', `/devices/${waiting.device_id}`, { approve: wrong }), 400, 'bad_request');
  await err(r.api(TECH, 'PATCH', `/devices/${waiting.device_id}`, { access: 'any' }), 409, 'pending');
  assert.equal((await ok(r.pc('hello', { protocol: 1 }, auth))).body.device.status, 'pending');
  await err(r.pc('update', { protocol: 1, name: 'x' }, auth), 403, 'pending');
  const approved = (await ok(r.api(TECH, 'PATCH', `/devices/${waiting.device_id}`, { approve: { confirm: waiting.confirm } }))).body.device;
  assert.deepEqual([approved.status, approved.approved_by], ['active', TECH]);
  assert.equal((await ok(r.pc('hello', { protocol: 1 }, auth))).body.device.status, 'active');
  await err(r.api(VIEW, 'DELETE', `/devices/${waiting.device_id}`), 403, 'permission_denied');
  await ok(r.api(TECH, 'DELETE', `/devices/${waiting.device_id}`));
  await err(r.pc('hello', { protocol: 1 }, auth), 401, 'device_unknown');
  await err(r.api(VIEW, 'GET', `/devices/${waiting.device_id}`), 404, 'not_found');
  const kinds = (await ok(r.api(BOSS, 'GET', '/audit?limit=500&verify=full'))).body;
  assert.equal(kinds.verified, true);
  assert.deepEqual(kinds.rows.map((x) => x.kind).filter((k) => k.startsWith('device_')), ['device_requested', 'device_approved', 'device_removed']);
});

// ---- other workspaces -----------------------------------------------------------------------
test('records are per workspace: another workspace answers 404 for an id, and its own lists are empty', async () => {
  const r = await team();
  const made = await r.raw(BOSS, 'POST', '/api/v1/w', { slug: 'acme', name: 'Acme' });
  assert.equal(made.status, 201);
  const customer = (await ok(r.api(TECH, 'POST', '/customers', { name: 'Dana' }), 201)).body.customer;
  const paired = (await ok(r.pc('pair', { protocol: 1, code: (await ok(r.api(TECH, 'POST', '/pairing', {}), 201)).body.pairing.code, name: 'Till' }), 201)).body;
  await err(r.call('acme', BOSS, 'GET', `/customers/${customer.id}`), 404, 'not_found');
  await err(r.call('acme', BOSS, 'GET', `/devices/${paired.device_id}`), 404, 'not_found');
  await err(r.call('acme', BOSS, 'DELETE', `/devices/${paired.device_id}`), 404, 'not_found');
  await err(r.call('acme', BOSS, 'PATCH', `/customers/${customer.id}`, { name: 'X' }), 404, 'not_found');
  for (const path of ['/customers', '/sites', '/devices', '/fields', '/pairing']) {
    const res = await ok(r.call('acme', BOSS, 'GET', path));
    assert.deepEqual(Object.values(res.body).filter((v) => Array.isArray(v)).flat(), [], path);
  }
  // The same ids from a workspace nobody created.
  await err(r.call('nowhere', BOSS, 'GET', `/customers/${customer.id}`), 404, 'not_found');
  // A technician of default has no place in acme.
  await err(r.call('acme', TECH, 'GET', '/customers'), 403, 'not_member');
  // The PC is in default only: its key under acme is no key.
  const asAcme = paired.key.replace('smd1.default.', 'smd1.acme.');
  await err(r.pc('hello', { protocol: 1 }, { authorization: `Bearer ${asAcme}` }), 401, 'device_unknown');
});
