// The team API under /api/v1/w/default, and how membership and roles decide
// MCP tool calls. Callers sign in with Access JWTs signed by a local key; the
// certs fetch is answered here, so nothing touches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openD1 } from './d1-fake.js';
import { createHandler } from '../src/app.js';
import { importRsaJwk } from '../src/jwt.js';
import { OPEN_PERMISSIONS, PERMISSIONS } from '../src/permissions.js';
import { accountStore } from '../src/accounts.js';

const TEAM = 'api-test.cloudflareaccess.com';
const AUD = 'api-test-aud';
const HOST = 'https://support.example.com';
const SID = 'a'.repeat(64);

// ---- Access JWTs ---------------------------------------------------------------
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
async function token(claims) {
  const input = `${enc({ alg: 'RS256', kid: 'k1', typ: 'JWT' })}.${enc({ aud: AUD, iss: `https://${TEAM}`, exp: Math.floor(Date.now() / 1000) + 600, ...claims })}`;
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', kp.privateKey, new TextEncoder().encode(input)));
  return `${input}.${b64url(sig)}`;
}
const tokens = new Map();
// A person signs in with an email; a service token's identity is its client id.
const as = async (who) => {
  if (!tokens.has(who)) tokens.set(who, await token(who.includes('@') ? { email: who } : { common_name: who, sub: '' }));
  return tokens.get(who);
};

// ---- a relay with fake Sessions ------------------------------------------------
function relay(extra = {}) {
  const calls = [];
  const SESSION = {
    idFromName: () => ({ toString: () => SID }),
    idFromString: (s) => s,
    get: () => ({
      fetch: async (u, init) => {
        const url = new URL(typeof u === 'string' ? u : u.url);
        calls.push({ path: url.pathname, body: init?.body ? JSON.parse(init.body) : null });
        if (url.pathname === '/create') return Response.json({ ok: true, sid: SID, code_expires_at: 1 });
        if (url.pathname === '/command') return Response.json({ ok: true, exit_code: 0, stdout: 'done', stderr: '', timed_out: false });
        if (url.pathname === '/status') return Response.json({ state: 'attached' });
        return Response.json({ ended: true });
      },
    }),
  };
  const REGISTRY = { idFromName: (n) => n, get: () => ({ fetch: async () => Response.json({ sessions: [] }) }) };
  const env = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, DEPLOYMENT_ADMINS: '', DB: openD1(), SESSION, REGISTRY, ...extra };
  const handler = createHandler('powershell agent');
  const api = async (who, method, path, body) => {
    const headers = { 'cf-access-jwt-assertion': await as(who) };
    if (method !== 'GET') headers['content-type'] = 'application/json';
    const r = await handler.fetch(new Request(`${HOST}/api/v1/w/default${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
    return { status: r.status, body: await r.json() };
  };
  const tool = async (who, name, args = {}) => {
    const r = await handler.fetch(new Request(`${HOST}/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'cf-access-jwt-assertion': await as(who) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    }), env);
    return (await r.json()).result;
  };
  // The same calls for any workspace: the team API under /api/v1/w/<slug>, the
  // workspace list and creation at /api/v1/w, and an MCP tool on /w/<slug>/mcp.
  const apiAt = async (slug, who, method, path, body) => {
    const headers = { 'cf-access-jwt-assertion': await as(who) };
    if (method !== 'GET') headers['content-type'] = 'application/json';
    const r = await handler.fetch(new Request(`${HOST}/api/v1/w${slug === null ? '' : `/${slug}`}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
    return { status: r.status, body: await r.json() };
  };
  const toolAt = async (slug, who, name, args = {}) => {
    const r = await handler.fetch(new Request(`${HOST}/w/${slug}/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'cf-access-jwt-assertion': await as(who) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    }), env);
    return (await r.json()).result;
  };
  return { env, calls, handler, api, tool, apiAt, toolAt };
}

const BOSS = 'boss@example.com';
const BOT = '0123abcd.access'; // an MCP client's service token client id
const run = (r, who) => r.tool(who, 'run', { session_id: SID, command: 'whoami' });
const refused = (out, text) => assert.deepEqual(out, { content: [{ type: 'text', text }], isError: true });

async function withAdmin(extra) {
  const r = relay(extra);
  const added = await r.api(BOSS, 'POST', '/members', { identity: BOSS, role_id: 'admin' });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  return r;
}

// ---- the gate --------------------------------------------------------------------
test('the API gate refuses Origin, non-JSON writes and a failed Access check before touching the database', async () => {
  const trap = { prepare() { throw new Error('DB touched'); }, batch() { throw new Error('DB touched'); } };
  const r = relay({ DB: trap });
  const send = (path, init) => r.handler.fetch(new Request(`${HOST}${path}`, init), r.env);
  const jwt = await as(BOSS);
  let res = await send('/api/v1/w/default', { headers: { origin: 'https://evil.example', 'cf-access-jwt-assertion': jwt } });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error.code, 'forbidden');
  // Under the localhost bypass too.
  res = await r.handler.fetch(new Request('http://127.0.0.1:8787/api/v1/w/default', { headers: { origin: 'http://127.0.0.1:8787' } }), { ...r.env, DEV_SKIP_ACCESS: '1' });
  assert.equal(res.status, 403);
  for (const method of ['POST', 'PATCH', 'DELETE']) {
    for (const ct of ['text/plain', 'application/x-www-form-urlencoded', null]) {
      const headers = { 'cf-access-jwt-assertion': jwt, ...(ct ? { 'content-type': ct } : {}) };
      res = await send('/api/v1/w/default/members', { method, headers, body: method === 'DELETE' ? undefined : '{}' });
      assert.equal(res.status, 415, `${method} ${ct}`);
      assert.equal((await res.json()).error.code, 'unsupported_media_type');
    }
  }
  for (const headers of [{}, { 'cf-access-jwt-assertion': 'not.a.jwt' }, { 'cf-access-jwt-assertion': await token({ email: BOSS, aud: 'other-app' }) }]) {
    res = await send('/api/v1/w/default/members', { headers });
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: { code: 'forbidden', message: 'Cloudflare Access did not admit this request' } });
  }
  res = await send('/api/v1/w/default', { method: 'PUT', headers: { 'cf-access-jwt-assertion': jwt, 'content-type': 'application/json' } });
  assert.equal(res.status, 405);
});

test('unknown routes are 404, and so is a workspace that was not created', async () => {
  const r = relay();
  for (const path of ['/api/v1/w/other', '/api/v1/w/other/members', '/api/v1/w/Default', '/api/v1/w/', '/api/v2/w/default', '/api', '/api/v1/w/default/nope', '/api/v1/w/default/members/a/b', '/api/v1/w/default/audit/1']) {
    const res = await r.handler.fetch(new Request(`${HOST}${path}`, { headers: { 'cf-access-jwt-assertion': await as(BOSS) } }), r.env);
    assert.equal(res.status, 404, path);
    assert.equal((await res.json()).error.code, 'not_found', path);
  }
});

// ---- open mode and the first member ----------------------------------------------
test('while open, the workspace page lists recent callers, service tokens among them', async () => {
  const r = relay();
  assert.ok(!(await run(r, BOT)).isError, 'the MCP client works while open');
  const { status, body } = await r.api('Someone@Example.com', 'GET', '');
  assert.equal(status, 200);
  assert.deepEqual(body.workspace, { slug: 'default', open: true });
  assert.deepEqual(body.me, { identity: 'someone@example.com', role_id: null, permissions: OPEN_PERMISSIONS });
  assert.deepEqual(OPEN_PERMISSIONS, ['sessions.create', 'sessions.view', 'sessions.control', 'sessions.end']);
  assert.deepEqual(body.recent_callers.map((c) => [c.identity, c.kind]).sort(), [[BOT, 'service'], ['someone@example.com', 'person']]);
});

test('the first member must be the caller, as admin', async () => {
  const r = relay();
  for (const body of [{ identity: 'someone-else@example.com', role_id: 'admin' }, { identity: BOSS, role_id: 'technician' }, { identity: BOT, role_id: 'admin' }]) {
    const res = await r.api(BOSS, 'POST', '/members', body);
    assert.equal(res.status, 409, JSON.stringify(body));
    assert.equal(res.body.error.code, 'first_member');
  }
  const ok = await r.api(' BOSS@example.com', 'POST', '/members', { identity: 'Boss@Example.com', name: 'The boss', role_id: 'admin' });
  assert.equal(ok.status, 201);
  assert.deepEqual({ ...ok.body.member, added_at: 0 }, { identity: BOSS, kind: 'person', name: 'The boss', role_id: 'admin', added_at: 0, added_by: BOSS });
  const log = await r.api(BOSS, 'GET', '/audit');
  assert.deepEqual(log.body.rows.map((x) => x.kind), ['member_added', 'roles_turned_on']);
  const page = await r.api(BOSS, 'GET', '');
  assert.deepEqual(page.body, { workspace: { slug: 'default', open: false }, me: { identity: BOSS, role_id: 'admin', permissions: PERMISSIONS } });
});

test('with DEPLOYMENT_ADMINS set, only a listed identity can add the first member', async () => {
  const r = relay({ DEPLOYMENT_ADMINS: ' Owner@Example.com , 0000.access' });
  const res = await r.api(BOSS, 'POST', '/members', { identity: BOSS, role_id: 'admin' });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'first_member');
  assert.match(res.body.error.message, /DEPLOYMENT_ADMINS/);
  assert.equal((await r.api('owner@example.com', 'POST', '/members', { identity: 'OWNER@example.com', role_id: 'admin' })).status, 201);
  // Once there is a member, the setting no longer matters: admins add people.
  assert.equal((await r.api('owner@example.com', 'POST', '/members', { identity: BOSS, role_id: 'admin' })).status, 201);
});

// ---- members and the MCP endpoint ------------------------------------------------
test('a non-member gets 403 from the API and "not a member" from tools/call', async () => {
  const r = await withAdmin();
  for (const [method, path, body] of [['GET', ''], ['GET', '/members'], ['GET', '/roles'], ['GET', '/audit'], ['POST', '/members', { identity: 'x@example.com', role_id: 'viewer' }], ['DELETE', `/members/${BOSS}`]]) {
    const res = await r.api('stranger@example.com', method, path, body);
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.deepEqual(res.body, { error: { code: 'not_member', message: 'you are not a member of this team' } });
  }
  for (const name of ['session_list', 'session_create', 'run']) {
    refused(await r.tool('stranger@example.com', name, name === 'run' ? { session_id: SID, command: 'x' } : {}), 'you are not a member of this team');
  }
  assert.deepEqual(r.calls, [], 'nothing reached a session');
});

test('a service-token member keeps working after roles turn on; one not added is refused', async () => {
  const r = relay();
  assert.ok(!(await run(r, BOT)).isError);
  await r.api(BOSS, 'POST', '/members', { identity: BOSS, role_id: 'admin' });
  const added = await r.api(BOSS, 'POST', '/members', { identity: BOT.toUpperCase(), name: 'Claude Code', role_id: 'technician' });
  assert.equal(added.status, 201);
  assert.equal(added.body.member.kind, 'service');
  const out = await run(r, BOT);
  assert.ok(!out.isError, out.content[0].text);
  assert.equal(JSON.parse(out.content[0].text).stdout, 'done');
  refused(await run(r, 'ffff9999.access'), 'you are not a member of this team');
  assert.equal(r.calls.filter((c) => c.path === '/command').length, 2);
  // The workspace page stops listing callers once roles are on.
  assert.ok(!('recent_callers' in (await r.api(BOSS, 'GET', '')).body));
});

test('after a member is removed, their next call is refused', async () => {
  const r = await withAdmin();
  await r.api(BOSS, 'POST', '/members', { identity: 'tech@example.com', role_id: 'technician' });
  assert.ok(!(await run(r, 'tech@example.com')).isError);
  const removed = await r.api(BOSS, 'DELETE', '/members/TECH%40example.com');
  assert.deepEqual([removed.status, removed.body], [200, { removed: { identity: 'tech@example.com' } }]);
  refused(await run(r, 'tech@example.com'), 'you are not a member of this team');
  assert.equal((await r.api('tech@example.com', 'GET', '')).status, 403);
  assert.equal((await r.api(BOSS, 'DELETE', '/members/tech@example.com')).status, 404);
});

test('member changes are checked: duplicates, unknown roles, bad input, permission', async () => {
  const r = await withAdmin();
  assert.equal((await r.api(BOSS, 'POST', '/members', { identity: 'v@example.com', role_id: 'viewer' })).status, 201);
  const dup = await r.api(BOSS, 'POST', '/members', { identity: 'V@example.com', role_id: 'technician' });
  assert.deepEqual([dup.status, dup.body.error.code], [409, 'member_exists']);
  for (const body of [{ identity: 'x@example.com', role_id: 'nope' }]) {
    assert.deepEqual((await r.api(BOSS, 'POST', '/members', body)).status, 400);
  }
  for (const body of [{ identity: '', role_id: 'viewer' }, { identity: 'a b@example.com', role_id: 'viewer' }, { identity: 'x@example.com', role_id: 'Viewer' }, { identity: 'x@example.com', role_id: 'viewer', name: 5 }, { identity: 'x\n@example.com', role_id: 'viewer' }]) {
    const res = await r.api(BOSS, 'POST', '/members', body);
    assert.deepEqual([res.status, res.body.error.code], [400, 'bad_request'], JSON.stringify(body));
  }
  for (const raw of ['not json', '[]', 'null']) {
    const res = await r.handler.fetch(new Request(`${HOST}/api/v1/w/default/members`, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-access-jwt-assertion': await as(BOSS) }, body: raw }), r.env);
    assert.equal(res.status, 400, raw);
  }
  const patched = await r.api(BOSS, 'PATCH', '/members/v@example.com', { role_id: 'technician', name: 'Vera' });
  assert.deepEqual([patched.status, patched.body.member.role_id, patched.body.member.name], [200, 'technician', 'Vera']);
  assert.equal((await r.api(BOSS, 'PATCH', '/members/v@example.com', {})).status, 400);
  assert.equal((await r.api(BOSS, 'PATCH', '/members/nobody@example.com', { role_id: 'viewer' })).status, 404);
  // A technician has no members.manage.
  const denied = await r.api('v@example.com', 'POST', '/members', { identity: 'w@example.com', role_id: 'viewer' });
  assert.deepEqual(denied.body, { error: { code: 'permission_denied', message: 'your role does not allow members.manage' } });
  assert.equal((await r.api('v@example.com', 'GET', '/members')).status, 403);
  assert.equal((await r.api('v@example.com', 'GET', '/audit')).status, 403);
  assert.equal((await r.api('v@example.com', 'GET', '')).status, 200, 'any member can read the workspace page');
});

// ---- the last admin --------------------------------------------------------------
test('the last admin cannot be removed or demoted', async () => {
  const r = await withAdmin();
  const del = await r.api(BOSS, 'DELETE', `/members/${BOSS}`);
  assert.deepEqual([del.status, del.body.error.code], [409, 'last_admin']);
  const demote = await r.api(BOSS, 'PATCH', `/members/${BOSS}`, { role_id: 'technician' });
  assert.deepEqual([demote.status, demote.body.error.code], [409, 'last_admin']);
  // A second admin makes either possible, once.
  await r.api(BOSS, 'POST', '/members', { identity: 'two@example.com', role_id: 'admin' });
  assert.equal((await r.api(BOSS, 'PATCH', '/members/two@example.com', { role_id: 'viewer' })).status, 200);
  assert.equal((await r.api(BOSS, 'DELETE', `/members/${BOSS}`)).status, 409);
});

test('two demotions at once leave one admin: one succeeds, the other is 409', async () => {
  for (let round = 0; round < 5; round++) {
    const r = await withAdmin();
    await r.api(BOSS, 'POST', '/members', { identity: 'two@example.com', role_id: 'admin' });
    const [a, b] = await Promise.all([
      r.api(BOSS, 'PATCH', `/members/${BOSS}`, { role_id: 'technician' }),
      r.api('two@example.com', 'PATCH', '/members/two@example.com', { role_id: 'viewer' }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409], JSON.stringify([a.body, b.body]));
    const members = (await r.api(a.status === 200 ? 'two@example.com' : BOSS, 'GET', '/members')).body.members;
    assert.equal(members.filter((m) => m.role_id === 'admin').length, 1);
    // Removals race the same way.
    const r2 = await withAdmin();
    await r2.api(BOSS, 'POST', '/members', { identity: 'two@example.com', role_id: 'admin' });
    const [c, d] = await Promise.all([r2.api(BOSS, 'DELETE', `/members/${BOSS}`), r2.api('two@example.com', 'DELETE', '/members/two@example.com')]);
    assert.deepEqual([c.status, d.status].sort(), [200, 409]);
  }
});

// ---- roles -----------------------------------------------------------------------
test('a custom role gets exactly its permissions', async () => {
  const r = await withAdmin();
  const made = await r.api(BOSS, 'POST', '/roles', { id: 'helpdesk', name: 'Help desk', permissions: ['sessions.view', 'sessions.create', 'sessions.view'] });
  assert.equal(made.status, 201);
  assert.deepEqual(made.body.role, { id: 'helpdesk', name: 'Help desk', permissions: ['sessions.create', 'sessions.view'], builtin: false, editable: true });
  await r.api(BOSS, 'POST', '/members', { identity: 'hd@example.com', role_id: 'helpdesk' });
  assert.ok(!(await r.tool('hd@example.com', 'session_create')).isError);
  assert.ok(!(await r.tool('hd@example.com', 'session_list')).isError);
  refused(await run(r, 'hd@example.com'), 'your role does not allow sessions.control');
  refused(await r.tool('hd@example.com', 'session_end', { session_id: SID }), 'your role does not allow sessions.end');
  assert.equal((await r.api('hd@example.com', 'GET', '/audit')).status, 403);
  // An edit takes effect on the next call.
  assert.equal((await r.api(BOSS, 'PATCH', '/roles/helpdesk', { permissions: ['sessions.view', 'sessions.control'] })).status, 200);
  assert.ok(!(await run(r, 'hd@example.com')).isError);
  refused(await r.tool('hd@example.com', 'session_create'), 'your role does not allow sessions.create');
});

test('roles: unknown permission is 400, admin is fixed, a role in use cannot be deleted', async () => {
  const r = await withAdmin();
  for (const body of [{ id: 'x', permissions: ['sessions.control_system'] }, { id: 'x', permissions: 'audit.view' }, { id: 'X', permissions: [] }, { id: 'a'.repeat(41), permissions: [] }, { id: 'x' }]) {
    const res = await r.api(BOSS, 'POST', '/roles', body);
    assert.deepEqual([res.status, res.body.error.code], [400, 'bad_request'], JSON.stringify(body));
  }
  assert.equal((await r.api(BOSS, 'PATCH', '/roles/viewer', { permissions: ['nope'] })).status, 400);
  for (const [method, path, body] of [['PATCH', '/roles/admin', { permissions: [] }], ['DELETE', '/roles/admin'], ['POST', '/roles', { id: 'admin', permissions: [] }]]) {
    const res = await r.api(BOSS, method, path, body);
    assert.deepEqual([res.status, res.body.error.code], [409, 'role_fixed'], `${method} ${path}`);
  }
  assert.equal((await r.api(BOSS, 'POST', '/roles', { id: 'viewer', permissions: [] })).body.error.code, 'role_exists');
  await r.api(BOSS, 'POST', '/members', { identity: 'v@example.com', role_id: 'viewer' });
  const inUse = await r.api(BOSS, 'DELETE', '/roles/viewer');
  assert.deepEqual([inUse.status, inUse.body.error.code], [409, 'role_in_use']);
  assert.equal((await r.api(BOSS, 'DELETE', '/roles/nope')).status, 404);
  assert.equal((await r.api(BOSS, 'PATCH', '/roles/nope', { name: 'x' })).status, 404);
  // An unused built-in default can be deleted, and then can't be given out.
  assert.equal((await r.api(BOSS, 'DELETE', '/roles/technician')).status, 200);
  assert.deepEqual((await r.api(BOSS, 'GET', '/roles')).body.roles.map((x) => x.id), ['admin', 'viewer']);
  assert.equal((await r.api(BOSS, 'POST', '/members', { identity: 't@example.com', role_id: 'technician' })).body.error.code, 'unknown_role');
  // An edited default overrides the built-in permissions.
  assert.equal((await r.api(BOSS, 'PATCH', '/roles/viewer', { permissions: ['sessions.view'] })).status, 200);
  assert.equal((await r.api('v@example.com', 'GET', '/audit')).status, 403);
  const roles = (await r.api(BOSS, 'GET', '/roles')).body.roles;
  assert.deepEqual(roles.find((x) => x.id === 'admin'), { id: 'admin', name: 'Admin', permissions: PERMISSIONS, builtin: true, editable: false });
  assert.deepEqual(roles.find((x) => x.id === 'viewer').permissions, ['sessions.view']);
});

// ---- the log ---------------------------------------------------------------------
test('the log API pages by after and limit, and reports the head and verification', async () => {
  const r = await withAdmin();
  for (let i = 0; i < 4; i++) await r.api(BOSS, 'POST', '/members', { identity: `u${i}@example.com`, role_id: 'viewer' });
  const all = await r.api(BOSS, 'GET', '/audit');
  assert.equal(all.status, 200);
  assert.deepEqual(all.body.rows.map((x) => x.seq), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(all.body.head, { seq: 6, hash: all.body.rows[5].hash });
  assert.equal(all.body.verified, true);
  const page = await r.api(BOSS, 'GET', '/audit?after=2&limit=2');
  assert.deepEqual(page.body.rows.map((x) => x.seq), [3, 4]);
  assert.deepEqual(Object.keys(page.body.rows[0]).sort(), ['actor', 'detail', 'hash', 'kind', 'prev_hash', 'seq', 'ts']);
  for (const q of ['?limit=501', '?limit=0', '?after=-1', '?limit=abc']) assert.equal((await r.api(BOSS, 'GET', `/audit${q}`)).status, 400, q);
  assert.equal((await r.api(BOSS, 'GET', '/audit?limit=500')).status, 200);
  r.env.DB.sqlite.exec("UPDATE audit SET detail = 'u0@example.com as admin' WHERE seq = 3");
  assert.equal((await r.api(BOSS, 'GET', '/audit')).body.verified, false);
});

test('a log read checks the rows it returns; verify=full checks the whole chain', async () => {
  const r = await withAdmin();
  for (let i = 0; i < 6; i++) await r.api(BOSS, 'POST', '/members', { identity: `u${i}@example.com`, role_id: 'viewer' });
  const clean = await r.api(BOSS, 'GET', '/audit?after=3&limit=2');
  assert.deepEqual([clean.body.rows.map((x) => x.seq), clean.body.verified, clean.body.verified_scope, clean.body.head.seq], [[4, 5], true, 'page', 8]);
  const full = await r.api(BOSS, 'GET', '/audit?verify=full&limit=2');
  assert.deepEqual([full.body.rows.map((x) => x.seq), full.body.verified, full.body.verified_scope, full.body.head.seq], [[1, 2], true, 'full', 8]);
  // A row outside the page is edited.
  r.env.DB.sqlite.exec("UPDATE audit SET detail = 'u0@example.com as admin' WHERE seq = 1");
  const page = await r.api(BOSS, 'GET', '/audit?after=3&limit=2');
  assert.deepEqual([page.body.verified, page.body.verified_scope], [true, 'page']);
  const after = await r.api(BOSS, 'GET', '/audit?verify=full&after=3&limit=2');
  assert.deepEqual([after.body.rows.map((x) => x.seq), after.body.verified, after.body.verified_scope], [[4, 5], false, 'full']);
  // A row on the page is edited.
  assert.equal((await r.api(BOSS, 'GET', '/audit?after=0&limit=2')).body.verified, false);
  // An empty page verifies, with page scope.
  const empty = await r.api(BOSS, 'GET', '/audit?after=8');
  assert.deepEqual([empty.body.rows, empty.body.verified, empty.body.verified_scope, empty.body.head.seq], [[], true, 'page', 8]);
  // Only full is accepted. An empty value counts as left out, and a repeated one uses its first value.
  for (const q of ['?verify=bad', '?verify=FULL', '?verify=page', '?verify=bad&verify=full']) {
    const res = await r.api(BOSS, 'GET', `/audit${q}`);
    assert.deepEqual([res.status, res.body.error.code], [400, 'bad_request'], q);
  }
  for (const [q, scope] of [['?verify=', 'page'], ['?verify=&limit=2', 'page'], ['?verify=full&verify=bad', 'full'], ['?verify=full&verify=', 'full']]) {
    const res = await r.api(BOSS, 'GET', `/audit${q}`);
    assert.deepEqual([res.status, res.body.verified_scope], [200, scope], q);
  }
  assert.equal((await r.api('stranger@example.com', 'GET', '/audit?verify=full')).status, 403, 'verify=full needs audit.view like any read');
});

// ---- escalation through team management ----------------------------------------------
const LEAD = 'lead@example.com';
const RM = 'rm@example.com';
const ok = async (p, status = 200) => { const res = await p; assert.equal(res.status, status, JSON.stringify(res.body)); return res; };
const forbidden = async (p, re) => {
  const res = await p;
  assert.equal(res.status, 403, JSON.stringify(res.body));
  assert.equal(res.body.error.code, 'forbidden');
  assert.match(res.body.error.message, re);
  return res;
};

// BOSS and a second admin, a "lead" role that can manage members and view
// sessions, a "rolemaker" role that can manage roles and view sessions, and a
// technician and a viewer to practise on.
async function withTeam() {
  const r = await withAdmin();
  await ok(r.api(BOSS, 'POST', '/members', { identity: 'admin2@example.com', role_id: 'admin' }), 201);
  await ok(r.api(BOSS, 'POST', '/roles', { id: 'lead', permissions: ['members.manage', 'sessions.view'] }), 201);
  await ok(r.api(BOSS, 'POST', '/roles', { id: 'rolemaker', permissions: ['roles.manage', 'sessions.view'] }), 201);
  await ok(r.api(BOSS, 'POST', '/roles', { id: 'sv', permissions: ['sessions.view'] }), 201);
  await ok(r.api(BOSS, 'POST', '/members', { identity: LEAD, role_id: 'lead' }), 201);
  await ok(r.api(BOSS, 'POST', '/members', { identity: RM, role_id: 'rolemaker' }), 201);
  await ok(r.api(BOSS, 'POST', '/members', { identity: 'tech@example.com', role_id: 'technician' }), 201);
  await ok(r.api(BOSS, 'POST', '/members', { identity: 'v@example.com', role_id: 'sv' }), 201);
  r.logLength = async () => (await r.api(BOSS, 'GET', '/audit?limit=500')).body.rows.length;
  r.roleOf = async (who) => (await r.api(BOSS, 'GET', '/members')).body.members.find((m) => m.identity === who).role_id;
  return r;
}

test('a members.manage member cannot make anyone admin, remove an admin, or hand out permissions they lack', async () => {
  const r = await withTeam();
  const before = await r.logLength();
  // Promote self or others to admin, or add a new admin.
  await forbidden(r.api(LEAD, 'PATCH', `/members/${LEAD}`, { role_id: 'admin' }), /own role/);
  await forbidden(r.api(LEAD, 'PATCH', '/members/v@example.com', { role_id: 'admin' }), /only an admin can give the admin role/);
  await forbidden(r.api(LEAD, 'POST', '/members', { identity: 'new@example.com', role_id: 'admin' }), /only an admin can add a member as admin/);
  // Change or remove an admin.
  await forbidden(r.api(LEAD, 'PATCH', '/members/admin2@example.com', { role_id: 'sv' }), /only an admin can change the role of an admin/);
  await forbidden(r.api(LEAD, 'DELETE', '/members/admin2@example.com'), /only an admin can remove an admin/);
  await forbidden(r.api(LEAD, 'DELETE', `/members/${BOSS}`), /only an admin can remove an admin/);
  // Roles that hold more than the lead does: technician has sessions.control, viewer has audit.view.
  await forbidden(r.api(LEAD, 'POST', '/members', { identity: 'new@example.com', role_id: 'technician' }), /you do not hold sessions\.create, sessions\.control, sessions\.end/);
  await forbidden(r.api(LEAD, 'PATCH', '/members/v@example.com', { role_id: 'technician' }), /you do not hold/);
  await forbidden(r.api(LEAD, 'POST', '/members', { identity: 'new@example.com', role_id: 'viewer' }), /you do not hold audit\.view/);
  // Nobody changes their own role, even to a lesser one.
  await forbidden(r.api(LEAD, 'PATCH', `/members/${LEAD}`, { role_id: 'sv' }), /own role/);
  assert.equal(await r.roleOf(LEAD), 'lead');
  assert.equal(await r.roleOf('v@example.com'), 'sv');
  assert.equal(await r.roleOf('admin2@example.com'), 'admin');
  assert.equal(await r.logLength(), before, 'a refused change writes no log row');
});

test('a members.manage member can still add and move people within their own permissions', async () => {
  const r = await withTeam();
  // sv holds sessions.view, which the lead holds. lead holds members.manage and sessions.view.
  await ok(r.api(LEAD, 'POST', '/members', { identity: 'new@example.com', role_id: 'sv' }), 201);
  await ok(r.api(LEAD, 'POST', '/members', { identity: 'peer@example.com', role_id: 'lead' }), 201);
  await ok(r.api(LEAD, 'PATCH', '/members/new@example.com', { name: 'New' }));
  assert.equal((await ok(r.api(LEAD, 'PATCH', '/members/new@example.com', { role_id: 'lead' }))).body.member.role_id, 'lead');
  await ok(r.api(LEAD, 'DELETE', '/members/new@example.com'));
  // Moving a peer or someone below them is fine too.
  await ok(r.api(LEAD, 'PATCH', '/members/peer@example.com', { name: 'Peer', role_id: 'sv' }));
  await ok(r.api(LEAD, 'DELETE', '/members/peer@example.com'));
  await ok(r.api(LEAD, 'PATCH', '/members/v@example.com', { name: 'Vee' }));
  await ok(r.api(LEAD, 'DELETE', '/members/v@example.com'));
});

test('a members.manage member cannot change, demote or remove a member whose role holds more than theirs', async () => {
  const r = await withTeam();
  const before = await r.logLength();
  const within = /within your own permissions/;
  // An admin, even for a rename. technician holds sessions.create, control and end, which lead lacks.
  await forbidden(r.api(LEAD, 'PATCH', '/members/admin2@example.com', { name: 'Renamed' }), within);
  await forbidden(r.api(LEAD, 'PATCH', `/members/${BOSS}`, { name: 'Renamed' }), within);
  await forbidden(r.api(LEAD, 'PATCH', '/members/tech@example.com', { name: 'Renamed' }), within);
  await forbidden(r.api(LEAD, 'PATCH', '/members/tech@example.com', { role_id: 'sv' }), within);
  await forbidden(r.api(LEAD, 'PATCH', '/members/tech@example.com', { name: 'T', role_id: 'sv' }), within);
  await forbidden(r.api(LEAD, 'DELETE', '/members/tech@example.com'), within);
  // The rolemaker holds roles.manage, which lead lacks.
  await forbidden(r.api(LEAD, 'PATCH', `/members/${RM}`, { name: 'Renamed' }), within);
  await forbidden(r.api(LEAD, 'DELETE', `/members/${RM}`), within);
  // A role with every permission still is not admin: its holder cannot touch an admin.
  await ok(r.api(BOSS, 'POST', '/roles', { id: 'everything', permissions: PERMISSIONS }), 201);
  await ok(r.api(BOSS, 'POST', '/members', { identity: 'all@example.com', role_id: 'everything' }), 201);
  await forbidden(r.api('all@example.com', 'PATCH', '/members/admin2@example.com', { name: 'Renamed' }), within);
  const members = (await r.api(BOSS, 'GET', '/members')).body.members;
  assert.equal(members.find((m) => m.identity === 'admin2@example.com').name, null);
  assert.equal(members.find((m) => m.identity === 'tech@example.com').role_id, 'technician');
  assert.ok(members.some((m) => m.identity === RM));
  assert.equal(await r.logLength(), before + 2, 'only the two setup changes wrote log rows');
});

test('an admin can still rename, demote and remove any member', async () => {
  const r = await withTeam();
  await ok(r.api(BOSS, 'PATCH', '/members/admin2@example.com', { name: 'Second' }));
  await ok(r.api(BOSS, 'PATCH', '/members/tech@example.com', { name: 'Tech', role_id: 'sv' }));
  await ok(r.api(BOSS, 'PATCH', `/members/${RM}`, { name: 'Role maker' }));
  await ok(r.api(BOSS, 'DELETE', `/members/${RM}`));
  await ok(r.api('admin2@example.com', 'PATCH', `/members/${BOSS}`, { name: 'Boss' }));
  await ok(r.api('admin2@example.com', 'DELETE', `/members/${BOSS}`));
});

test('a roles.manage member cannot add permissions to their own role or grant ones they lack', async () => {
  const r = await withTeam();
  const before = await r.logLength();
  await forbidden(r.api(RM, 'PATCH', '/roles/rolemaker', { permissions: ['roles.manage', 'sessions.view', 'sessions.control'] }), /edit the role you hold/);
  await forbidden(r.api(RM, 'PATCH', '/roles/rolemaker', { name: 'Renamed' }), /edit the role you hold/);
  await forbidden(r.api(RM, 'DELETE', '/roles/rolemaker'), /delete the role you hold/);
  await forbidden(r.api(RM, 'POST', '/roles', { id: 'strong', permissions: ['sessions.view', 'sessions.control'] }), /you do not hold sessions\.control/);
  await forbidden(r.api(RM, 'POST', '/roles', { id: 'strong', permissions: ['members.manage'] }), /you do not hold members\.manage/);
  await forbidden(r.api(RM, 'PATCH', '/roles/sv', { permissions: ['sessions.view', 'sessions.end'] }), /you do not hold sessions\.end/);
  // Even a rename leaves technician holding permissions the rolemaker lacks.
  await forbidden(r.api(RM, 'PATCH', '/roles/technician', { name: 'Tech' }), /you do not hold sessions\.create/);
  assert.deepEqual((await r.api(BOSS, 'GET', '/roles')).body.roles.find((x) => x.id === 'rolemaker').permissions, ['roles.manage', 'sessions.view']);
  assert.deepEqual((await r.api(BOSS, 'GET', '/roles')).body.roles.find((x) => x.id === 'sv').permissions, ['sessions.view']);
  assert.equal(await r.logLength(), before);
  // Within their own permissions they can still work, and delete a role nobody holds.
  await ok(r.api(RM, 'POST', '/roles', { id: 'peek', permissions: ['sessions.view'] }), 201);
  await ok(r.api(RM, 'PATCH', '/roles/peek', { name: 'Peek', permissions: [] }));
  await ok(r.api(RM, 'DELETE', '/roles/peek'));
});

test('a roles.manage member cannot narrow, rename or delete a role that holds more than they do', async () => {
  const r = await withTeam();
  await ok(r.api(BOSS, 'POST', '/roles', { id: 'strong', permissions: ['sessions.view', 'sessions.control'] }), 201);
  const before = await r.logLength();
  const held = /you can only (change|delete) a role whose permissions you hold: you do not hold/;
  await forbidden(r.api(RM, 'PATCH', '/roles/technician', { permissions: ['sessions.view'] }), held);
  await forbidden(r.api(RM, 'PATCH', '/roles/technician', { permissions: [] }), held);
  await forbidden(r.api(RM, 'PATCH', '/roles/strong', { name: 'Renamed' }), held);
  await forbidden(r.api(RM, 'DELETE', '/roles/strong'), held);
  await forbidden(r.api(RM, 'DELETE', '/roles/viewer'), held);
  const roles = (await r.api(BOSS, 'GET', '/roles')).body.roles;
  assert.deepEqual(roles.find((x) => x.id === 'technician').permissions, ['sessions.create', 'sessions.view', 'sessions.control', 'sessions.end']);
  assert.ok(roles.some((x) => x.id === 'strong' && x.name === 'strong'));
  assert.ok(roles.some((x) => x.id === 'viewer'));
  assert.equal(await r.logLength(), before, 'a refused change writes no log row');
  // Within their own permissions they can still edit and delete; an admin can edit any role.
  await ok(r.api(RM, 'PATCH', '/roles/sv', { name: 'Seer', permissions: [] }));
  await ok(r.api(RM, 'PATCH', '/roles/sv', { permissions: ['sessions.view'] }));
  await ok(r.api(BOSS, 'PATCH', '/roles/strong', { permissions: ['sessions.view'] }));
  await ok(r.api(RM, 'DELETE', '/roles/strong'));
  await ok(r.api(BOSS, 'DELETE', '/roles/viewer'));
});

test('a member whose role is gone answers a clean 409 to a rename, and takes a new role', async () => {
  const r = await withTeam();
  await ok(r.api(BOSS, 'POST', '/roles', { id: 'ghost', permissions: ['sessions.view'] }), 201);
  await ok(r.api(BOSS, 'POST', '/members', { identity: 'g@example.com', role_id: 'ghost' }), 201);
  r.env.DB.sqlite.exec("UPDATE roles SET deleted = 1 WHERE role_id = 'ghost'");
  const refused = await r.api(LEAD, 'PATCH', '/members/g@example.com', { name: 'G' });
  assert.deepEqual([refused.status, refused.body], [409, { error: { code: 'role_missing', message: 'that member has a role that no longer exists; give them a role first' } }]);
  assert.equal((await r.api(BOSS, 'PATCH', '/members/g@example.com', { name: 'G' })).body.error.code, 'role_missing');
  assert.equal((await ok(r.api(BOSS, 'PATCH', '/members/g@example.com', { role_id: 'technician' }))).body.member.role_id, 'technician');
});

test('an admin can still promote, demote, remove and hand out any role', async () => {
  const r = await withTeam();
  await ok(r.api(BOSS, 'PATCH', '/members/v@example.com', { role_id: 'admin' }));
  await ok(r.api(BOSS, 'PATCH', '/members/v@example.com', { role_id: 'technician' }));
  await ok(r.api(BOSS, 'POST', '/members', { identity: 'a3@example.com', role_id: 'admin' }), 201);
  await ok(r.api(BOSS, 'DELETE', '/members/a3@example.com'));
  await ok(r.api(BOSS, 'POST', '/roles', { id: 'everything', permissions: PERMISSIONS }), 201);
  await ok(r.api(BOSS, 'POST', '/members', { identity: 'x@example.com', role_id: 'everything' }), 201);
  await ok(r.api(BOSS, 'PATCH', '/roles/sv', { permissions: ['sessions.view', 'sessions.control'] }));
  await ok(r.api(BOSS, 'DELETE', '/members/admin2@example.com'));
});

test('an admin can demote themselves only while another admin remains', async () => {
  const r = await withTeam();
  await ok(r.api('admin2@example.com', 'PATCH', '/members/admin2@example.com', { role_id: 'technician' }));
  const last = await r.api(BOSS, 'PATCH', `/members/${BOSS}`, { role_id: 'technician' });
  assert.deepEqual([last.status, last.body.error.code], [409, 'last_admin']);
});

// ---- open mode ---------------------------------------------------------------------
test('while open, no team write works except adding yourself as the first admin', async () => {
  const r = relay();
  const open = [
    ['POST', '/roles', { id: 'x', permissions: ['sessions.view'] }],
    ['PATCH', '/roles/viewer', { permissions: ['sessions.control'] }],
    ['DELETE', '/roles/technician'],
    ['PATCH', '/members/a@example.com', { role_id: 'admin' }],
    ['DELETE', '/members/a@example.com'],
  ];
  for (const [method, path, body] of open) {
    const res = await r.api(BOSS, method, path, body);
    assert.deepEqual([res.status, res.body], [409, { error: { code: 'first_member', message: 'add yourself as the first admin before changing the team' } }], `${method} ${path}`);
  }
  // Reading the workspace and the roles still works; members and the log do not.
  assert.equal((await r.api(BOSS, 'GET', '')).status, 200);
  const roles = await r.api(BOSS, 'GET', '/roles');
  assert.deepEqual([roles.status, roles.body.roles.map((x) => x.id)], [200, ['admin', 'technician', 'viewer']]);
  for (const path of ['/members', '/audit']) assert.equal((await r.api(BOSS, 'GET', path)).status, 403, path);
  // Nothing was written, and the session tools work as before.
  assert.equal(r.env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM roles').get().n, 0);
  assert.equal(r.env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM audit').get().n, 0);
  assert.ok(!(await run(r, BOSS)).isError);
  assert.ok(!(await r.tool(BOSS, 'session_create')).isError);
});

test('with DEPLOYMENT_ADMINS set, another caller cannot edit the roles before the owner signs in', async () => {
  const r = relay({ DEPLOYMENT_ADMINS: 'owner@example.com' });
  const mallory = await r.api('mallory@example.com', 'PATCH', '/roles/viewer', { permissions: ['members.manage', 'roles.manage', 'sessions.control'] });
  assert.deepEqual([mallory.status, mallory.body.error.code], [409, 'first_member']);
  assert.equal((await r.api('mallory@example.com', 'POST', '/roles', { id: 'back-door', permissions: PERMISSIONS })).status, 409);
  assert.equal((await r.api('mallory@example.com', 'POST', '/members', { identity: 'mallory@example.com', role_id: 'admin' })).body.error.code, 'first_member');
  await ok(r.api('owner@example.com', 'POST', '/members', { identity: 'owner@example.com', role_id: 'admin' }), 201);
  const roles = (await r.api('owner@example.com', 'GET', '/roles')).body.roles;
  assert.deepEqual(roles.map((x) => x.id), ['admin', 'technician', 'viewer']);
  assert.deepEqual(roles.find((x) => x.id === 'viewer').permissions, ['sessions.view', 'audit.view']);
});

// ---- more workspaces ----------------------------------------------------------------
const OWNER = 'owner@example.com';
const created = async (extra = {}) => {
  const r = relay({ DEPLOYMENT_ADMINS: `${OWNER}, ${BOT}`, ...extra });
  const made = await r.apiAt(null, OWNER, 'POST', '', { slug: 'acme', name: 'Acme Support' });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  return r;
};

test('POST /api/v1/w creates a workspace and makes the caller its admin, with two log rows', async () => {
  const r = relay({ DEPLOYMENT_ADMINS: ` ${OWNER.toUpperCase()} ` });
  const made = await r.apiAt(null, OWNER, 'POST', '', { slug: 'acme', name: 'Acme Support' });
  assert.equal(made.status, 201);
  assert.deepEqual({ ...made.body.workspace, created_at: 0 }, { slug: 'acme', name: 'Acme Support', role_id: 'admin', created_by: OWNER, created_at: 0 });
  const page = await r.apiAt('acme', OWNER, 'GET', '');
  assert.deepEqual(page.body, { workspace: { slug: 'acme', open: false }, me: { identity: OWNER, role_id: 'admin', permissions: PERMISSIONS } });
  const log = await r.apiAt('acme', OWNER, 'GET', '/audit?verify=full');
  assert.deepEqual([log.body.rows.map((x) => [x.seq, x.kind, x.actor, x.detail]), log.body.verified], [
    [[1, 'workspace_created', OWNER, 'named "Acme Support"'], [2, 'member_added', OWNER, `${OWNER} as admin`]], true]);
  assert.deepEqual((await r.apiAt('acme', OWNER, 'GET', '/members')).body.members.map((m) => [m.identity, m.role_id]), [[OWNER, 'admin']]);
  // Default is not touched: still open, with an empty log.
  assert.equal((await r.api(OWNER, 'GET', '')).body.workspace.open, true);
});

test('creating a workspace is refused without deployment admins, for anyone not listed, and for bad input', async () => {
  const none = relay({ DEPLOYMENT_ADMINS: '' });
  for (const who of [OWNER, BOT]) {
    const res = await none.apiAt(null, who, 'POST', '', { slug: 'acme', name: 'Acme' });
    assert.deepEqual([res.status, res.body.error.code], [409, 'no_deployment_admins']);
  }
  const r = relay({ DEPLOYMENT_ADMINS: OWNER });
  const denied = await r.apiAt(null, 'mallory@example.com', 'POST', '', { slug: 'acme', name: 'Acme' });
  assert.deepEqual([denied.status, denied.body.error.code], [403, 'forbidden']);
  // Not even an admin of default may, unless listed.
  await r.api(OWNER, 'POST', '/members', { identity: OWNER, role_id: 'admin' });
  await r.api(OWNER, 'POST', '/members', { identity: BOSS, role_id: 'admin' });
  assert.equal((await r.apiAt(null, BOSS, 'POST', '', { slug: 'acme', name: 'Acme' })).status, 403);
  for (const body of [{}, { slug: 'acme' }, { name: 'Acme' }, { slug: 'Acme', name: 'A' }, { slug: 'a b', name: 'A' }, { slug: 'x'.repeat(41), name: 'A' }, { slug: 'acme', name: '' }, { slug: 'acme', name: 5 }, { slug: 5, name: 'A' }]) {
    const res = await r.apiAt(null, OWNER, 'POST', '', body);
    assert.deepEqual([res.status, res.body.error.code], [400, 'bad_request'], JSON.stringify(body));
  }
  assert.equal((await r.apiAt('acme', OWNER, 'GET', '')).status, 404, 'nothing was created');
  // Writes to the collection need JSON, like every other write.
  const headers = { 'cf-access-jwt-assertion': await as(OWNER), 'content-type': 'text/plain' };
  assert.equal((await r.handler.fetch(new Request(`${HOST}/api/v1/w`, { method: 'POST', headers, body: '{}' }), r.env)).status, 415);
  const put = await r.apiAt(null, OWNER, 'PUT', '', {});
  assert.equal(put.status, 405);
});

test('default cannot be created and an existing slug is 409 workspace_exists', async () => {
  const r = await created();
  for (const slug of ['default', 'acme']) {
    const res = await r.apiAt(null, OWNER, 'POST', '', { slug, name: 'Again' });
    assert.deepEqual([res.status, res.body.error.code], [409, 'workspace_exists'], slug);
  }
  // Another deployment admin can't take it over either, and the owner stays admin.
  const takeover = await r.apiAt(null, BOT, 'POST', '', { slug: 'acme', name: 'Mine' });
  assert.deepEqual([takeover.status, takeover.body.error.code], [409, 'workspace_exists']);
  assert.deepEqual((await r.apiAt('acme', OWNER, 'GET', '/members')).body.members.map((m) => m.identity), [OWNER]);
  assert.equal((await r.apiAt('acme', BOT, 'GET', '')).status, 403, 'a would-be taker is no member');
  assert.equal((await r.api(OWNER, 'GET', '')).body.workspace.open, true, 'default was not created or closed');
});

test('GET /api/v1/w lists the caller\'s workspaces, and default while it is open', async () => {
  const r = await created();
  await r.apiAt(null, OWNER, 'POST', '', { slug: 'beta', name: 'Beta' });
  await r.apiAt('acme', OWNER, 'POST', '/members', { identity: 'tech@example.com', role_id: 'technician' });
  const listOf = async (who) => (await r.apiAt(null, who, 'GET', '')).body;
  assert.deepEqual(await listOf(OWNER), { workspaces: [
    { slug: 'default', name: 'Default', role_id: null }, { slug: 'acme', name: 'Acme Support', role_id: 'admin' }, { slug: 'beta', name: 'Beta', role_id: 'admin' }] });
  assert.deepEqual((await listOf('tech@example.com')).workspaces.map((w) => [w.slug, w.role_id]), [['default', null], ['acme', 'technician']]);
  assert.equal((await r.apiAt(null, OWNER, 'GET', '')).status, 200);
  // Once default has members, a stranger sees none of them and a member sees default with their role.
  await r.api(OWNER, 'POST', '/members', { identity: OWNER, role_id: 'admin' });
  await r.api(OWNER, 'POST', '/members', { identity: BOSS, role_id: 'viewer' });
  assert.deepEqual(await listOf('tech@example.com'), { workspaces: [{ slug: 'acme', name: 'Acme Support', role_id: 'technician' }] });
  assert.deepEqual((await listOf(BOSS)).workspaces, [{ slug: 'default', name: 'Default', role_id: 'viewer' }]);
  assert.deepEqual((await listOf(OWNER)).workspaces.map((w) => [w.slug, w.role_id]), [['default', 'admin'], ['acme', 'admin'], ['beta', 'admin']]);
  assert.deepEqual(await listOf('stranger@example.com'), { workspaces: [] });
  // Same gate as the rest of the API: no Access, no list.
  const res = await r.handler.fetch(new Request(`${HOST}/api/v1/w`), r.env);
  assert.equal(res.status, 403);
});

test('a workspace that was not created is 404 on every API route, for everyone, before any permission is looked at', async () => {
  const r = await created();
  const trapped = { ...r.env, DB: new Proxy(r.env.DB, { get: (t, k) => (k === 'prepare' ? (sql) => { if (/FROM (members|roles|audit|callers)/.test(sql)) throw new Error(`team table read: ${sql}`); return t.prepare(sql); } : t[k]) }) };
  const stranger = 'stranger@example.com';
  const slugs = ['ghost', 'acme2', 'Acme', 'a_b', 'x'.repeat(41), '%20', 'a%2Fb', 'acme%00', '__proto__'];
  for (const slug of slugs) {
    for (const who of [OWNER, stranger]) {
      for (const [method, path, body] of [['GET', ''], ['GET', '/members'], ['GET', '/roles'], ['GET', '/audit'], ['POST', '/members', { identity: who, role_id: 'admin' }], ['POST', '/roles', { id: 'x', permissions: [] }], ['PATCH', `/members/${who}`, { name: 'x' }], ['DELETE', `/members/${who}`]]) {
        const headers = { 'cf-access-jwt-assertion': await as(who), ...(method === 'GET' ? {} : { 'content-type': 'application/json' }) };
        const res = await r.handler.fetch(new Request(`${HOST}/api/v1/w/${slug}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), trapped);
        assert.equal(res.status, 404, `${method} ${slug}${path} as ${who}`);
        assert.deepEqual((await res.json()).error, { code: 'not_found', message: 'no such workspace' });
      }
    }
  }
  // A stranger in a created workspace is told they are not a member, which a missing one never says.
  assert.equal((await r.apiAt('acme', stranger, 'GET', '')).status, 403);
});

test('every team route works in a created workspace, apart from default', async () => {
  const r = await created();
  const put = (method, path, body, who = OWNER) => r.apiAt('acme', who, method, path, body);
  const added = await put('POST', '/members', { identity: 'tech@example.com', name: 'Tess', role_id: 'technician' });
  assert.equal(added.status, 201);
  assert.equal((await put('POST', '/roles', { id: 'lead', name: 'Lead', permissions: ['sessions.view'] })).status, 201);
  assert.equal((await put('PATCH', '/members/tech@example.com', { role_id: 'lead' })).body.member.role_id, 'lead');
  assert.deepEqual((await put('GET', '/roles')).body.roles.map((x) => x.id), ['admin', 'technician', 'viewer', 'lead']);
  assert.equal((await put('PATCH', '/roles/lead', { name: 'Leader' })).body.role.name, 'Leader');
  assert.equal((await put('GET', '/members', undefined, 'tech@example.com')).status, 403, 'a lead holds no members.manage');
  assert.equal((await put('DELETE', '/members/tech@example.com')).status, 200);
  assert.equal((await put('DELETE', '/roles/lead')).status, 200);
  const last = await put('DELETE', `/members/${OWNER}`);
  assert.deepEqual([last.status, last.body.error.code], [409, 'last_admin']);
  const log = await put('GET', '/audit?verify=full');
  assert.equal(log.body.verified, true);
  assert.deepEqual(log.body.rows.map((x) => x.kind), ['workspace_created', 'member_added', 'member_added', 'role_added', 'member_changed', 'role_changed', 'member_removed', 'role_removed']);
  // None of it reached default.
  assert.equal((await r.api(OWNER, 'GET', '')).body.workspace.open, true);
});

test('open mode and the first-admin rule are default\'s alone', async () => {
  const r = await created();
  // A stranger cannot make themselves the first admin of a created workspace, nor read it.
  const grab = await r.apiAt('acme', BOSS, 'POST', '/members', { identity: BOSS, role_id: 'admin' });
  assert.deepEqual([grab.status, grab.body.error.code], [403, 'not_member']);
  assert.equal((await r.apiAt('acme', BOSS, 'GET', '')).status, 403);
  assert.equal((await r.apiAt('acme', BOSS, 'GET', '/roles')).status, 403, 'the role list is not open to anyone');
  refused(await r.toolAt('acme', BOSS, 'session_list'), 'you are not a member of this team');
  assert.deepEqual(r.calls, []);
  // Even with every member gone, the workspace stays closed instead of opening.
  r.env.DB.sqlite.exec("DELETE FROM members WHERE workspace = 'acme'");
  for (const [method, path, body] of [['GET', ''], ['GET', '/roles'], ['GET', '/members'], ['POST', '/members', { identity: OWNER, role_id: 'admin' }], ['POST', '/roles', { id: 'x', permissions: [] }], ['DELETE', '/members/a@example.com']]) {
    const res = await r.apiAt('acme', OWNER, method, path, body);
    assert.deepEqual([res.status, res.body.error.code], [403, 'not_member'], `${method} ${path}`);
  }
  refused(await r.toolAt('acme', OWNER, 'run', { session_id: SID, command: 'whoami' }), 'you are not a member of this team');
  refused(await r.toolAt('acme', OWNER, 'session_create'), 'you are not a member of this team');
  assert.deepEqual(r.calls, [], 'nothing reached a session');
  assert.equal(await r.env.DB.prepare("SELECT COUNT(*) AS n FROM callers WHERE workspace = 'acme'").first('n'), 0);
  // Default is still open, and still wants its first admin to add themselves.
  const page = await r.api(BOSS, 'GET', '');
  assert.equal(page.body.workspace.open, true);
  assert.equal((await r.api(BOSS, 'POST', '/members', { identity: OWNER, role_id: 'admin' })).body.error.code, 'first_member');
});

test('Access logins and service tokens work as members on /w/<slug>/mcp, and not as strangers', async () => {
  const r = await created();
  await r.apiAt('acme', OWNER, 'POST', '/members', { identity: BOT, name: 'Claude Code', role_id: 'technician' });
  await r.apiAt('acme', OWNER, 'POST', '/members', { identity: 'viewer@example.com', role_id: 'viewer' });
  // A person on an Access login, and a service token, each run a command as members.
  for (const who of [OWNER, BOT]) {
    const out = await r.toolAt('acme', who, 'run', { session_id: SID, command: 'whoami' });
    assert.ok(!out.isError, out.content[0].text);
    assert.equal(JSON.parse(out.content[0].text).stdout, 'done');
  }
  const actors = r.calls.filter((c) => c.path === '/command').map((c) => [c.body.actor, c.body.workspace]);
  assert.deepEqual(actors, [[OWNER, 'acme'], [BOT, 'acme']], 'the audit actor is the member, and the Session is told the workspace');
  refused(await r.toolAt('acme', 'viewer@example.com', 'run', { session_id: SID, command: 'x' }), 'your role does not allow sessions.control');
  refused(await r.toolAt('acme', 'stranger@example.com', 'session_list'), 'you are not a member of this team');
  refused(await r.toolAt('acme', 'ffff9999.access', 'session_list'), 'you are not a member of this team');
  // The same members are strangers to a workspace they were not added to.
  await r.apiAt(null, OWNER, 'POST', '', { slug: 'beta', name: 'Beta' });
  refused(await r.toolAt('beta', BOT, 'session_list'), 'you are not a member of this team');
  // A workspace that was not created: a tool error, even for a deployment admin.
  refused(await r.toolAt('ghost', OWNER, 'session_list'), 'workspace not found');
  // And /mcp is still default: open, so the stranger holds the sessions permissions there.
  assert.ok(!(await r.tool('stranger@example.com', 'session_list')).isError);
});

test('session_create in a workspace tells the Session its workspace, and session_list reads that workspace\'s Registry', async () => {
  const names = [];
  const r = await created();
  r.env.REGISTRY = { idFromName: (n) => { names.push(n); return n; }, get: () => ({ fetch: async () => Response.json({ sessions: [] }) }) };
  await r.apiAt(null, OWNER, 'POST', '', { slug: 'beta', name: 'Beta' });
  assert.ok(!(await r.toolAt('acme', OWNER, 'session_create')).isError);
  assert.equal(r.calls.find((c) => c.path === '/create').body.workspace, 'acme');
  await r.toolAt('acme', OWNER, 'session_list');
  await r.toolAt('beta', OWNER, 'session_list');
  await r.tool(OWNER, 'session_list');
  assert.deepEqual(names, ['registry:acme', 'registry:beta', 'registry']);
});

// ---- a browser sign-in is not a credential here ---------------------------------------
// PR 2b lets a person sign in with a cookie. That cookie opens the account page
// only. The team API and every MCP address still admit Access logins and service
// tokens, so a signed-in person from another team can't claim the open default
// workspace's first admin, or read who has been calling it.
test('a sign-in cookie is ignored on the team API and MCP, so default\'s first admin still needs Access', async () => {
  const secret = 'api-test-auth-secret-0123456789abcdef-xyz';
  const r = relay({ AUTH_SECRET: secret, PUBLIC_ORIGIN: HOST });
  // A member of another team, signed in by cookie.
  await r.api(BOSS, 'POST', '/members', { identity: BOSS, role_id: 'admin' }); // makes default closed...
  r.env.DB.sqlite.exec('DELETE FROM members'); // ...then reopen it: no member in default
  r.env.DB.sqlite.exec("INSERT INTO workspaces(slug, name, created_by, created_at) VALUES ('acme', 'Acme', 'x', 1)");
  r.env.DB.sqlite.exec("INSERT INTO members(workspace, identity, kind, name, role_id, added_at, added_by) VALUES ('acme', 'tech@example.com', 'person', NULL, 'admin', 1, 'x')");
  const store = accountStore(r.env.DB, { secret });
  const found = await store.userForEmail('tech@example.com', async () => true);
  const cookie = `__Host-smcp=${await store.createSession(found.user.id, { maxMs: 86400_000 })}`;
  const send = (path, init = {}) => r.handler.fetch(new Request(`${HOST}${path}`, { ...init, headers: { cookie, ...(init.headers || {}) } }), r.env);

  assert.equal((await send('/api/v1/w/default')).status, 403, 'recent_callers stay behind Access');
  const claim = await send('/api/v1/w/default/members', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identity: 'tech@example.com', role_id: 'admin' }) });
  assert.equal(claim.status, 403);
  assert.equal((await send('/api/v1/w')).status, 403);
  assert.equal((await send('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'session_list', arguments: {} } }) })).status, 403);
  assert.equal(r.env.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM members WHERE workspace = 'default'").get().n, 0);

  // The account page does accept it, and the same Access login claims default as before.
  assert.equal((await send('/account')).status, 200);
  const access = await r.api('tech@example.com', 'POST', '/members', { identity: 'tech@example.com', role_id: 'admin' });
  assert.equal(access.status, 201, JSON.stringify(access.body));
});
