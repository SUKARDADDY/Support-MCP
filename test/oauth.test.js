// OAuth for MCP clients, end to end through the real router (src/app.js), the
// real @cloudflare/workers-oauth-provider and an in-memory KV and D1. A scripted
// client registers, a Browser signs in and consents, and the tokens are used on
// the MCP addresses. Nothing touches the network.
//
// The library imports `cloudflare:workers`, which Node cannot load. `npm test`
// preloads test/stubs/register.mjs to stand in for it. Run bare, `node --test`
// skips this file with a message instead of failing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openD1 } from './d1-fake.js';
import { openKV } from './kv-fake.js';
import { createHandler } from '../src/app.js';
import { importRsaJwk } from '../src/jwt.js';
import { accountStore } from '../src/accounts.js';
import { bytesToB64url, base32Decode, sha256Hex } from '../src/crypto.js';
import { totp } from '../src/totp.js';
import { redirectSource, returnAddress } from '../src/auth.js';
import { bearerToken, challengeHeader, resourceUrl, workspaceForResource } from '../src/oauth.js';

let lib = null;
let skip = false;
try {
  lib = await import('@cloudflare/workers-oauth-provider');
} catch (e) {
  skip = 'the OAuth library needs the cloudflare:workers stub: run npm test (node --import ./test/stubs/register.mjs --test)';
  console.log(`# oauth.test.js skipped: ${skip}`);
}
const it = (name, fn) => test(name, { skip }, fn);

const PROD = 'https://support.example.com';
const LOCAL = 'http://127.0.0.1:8787';
const SECRET = 'oauth-test-auth-secret-0123456789abcdef-xyz';
const TEAM = 'oauth-test.cloudflareaccess.com';
const AUD = 'oauth-test-aud';
const SID = 'a'.repeat(64);
const REDIRECT = 'http://127.0.0.1:33418/callback';
const rpc = (method, params) => JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
const call = (name, args = {}) => rpc('tools/call', { name, arguments: args });
const JSON_HEADERS = { 'content-type': 'application/json' };

// ---- time -------------------------------------------------------------------
// The library, the KV fake and the D1 fake all read Date.now, so one skew moves them together.
const realNow = Date.now;
let skew = 0;
Date.now = () => realNow() + skew;
const advance = (ms) => { skew += ms; };
const resetClock = () => { skew = 0; };

// ---- Access JWTs, signed locally (as in test/api.test.js) -------------------------
const kp = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', kp.publicKey)), kid: 'k1' };
await importRsaJwk(jwk, crypto.subtle);
const cimdDocs = new Map(); // url -> document, served to the library's metadata fetch
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url) === `https://${TEAM}/cdn-cgi/access/certs`) return Response.json({ keys: [jwk] });
  if (cimdDocs.has(String(url))) return Response.json(cimdDocs.get(String(url)), { headers: { 'cache-control': 'no-store' } });
  return realFetch(url, init);
};
const enc = (o) => bytesToB64url(new TextEncoder().encode(JSON.stringify(o)));
async function accessToken(claims) {
  const input = `${enc({ alg: 'RS256', kid: 'k1', typ: 'JWT' })}.${enc({ aud: AUD, iss: `https://${TEAM}`, exp: Math.floor(Date.now() / 1000) + 600, ...claims })}`;
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', kp.privateKey, new TextEncoder().encode(input)));
  return `${input}.${bytesToB64url(sig)}`;
}
const accessAs = (who) => accessToken(who.includes('@') ? { email: who } : { common_name: who, sub: '' });

// ---- a relay -----------------------------------------------------------------------
const mailer = { sent: [], async send(m) { this.sent.push(m); } };
const handler = lib && createHandler('agent', null, {
  mailer,
  oauth: { OAuthAuthorizationServer: lib.OAuthAuthorizationServer, AuthorizationError: lib.AuthorizationError, CimdFetchError: lib.CimdFetchError },
  oauthTuning: { missGapMs: 0 },
});
const plainHandler = createHandler('agent', null, { mailer }); // OAuth library not passed in

function makeEnv(extra = {}) {
  const calls = [];
  const SESSION = {
    idFromName: () => ({ toString: () => SID }),
    idFromString: (s) => s,
    get: () => ({
      fetch: async (u, init) => {
        const url = new URL(typeof u === 'string' ? u : u.url);
        calls.push({ kind: 'session', path: url.pathname, body: init?.body ? JSON.parse(init.body) : null });
        if (url.pathname === '/command') return Response.json({ ok: true, exit_code: 0, stdout: 'done', stderr: '', timed_out: false });
        return Response.json({ state: 'attached' });
      },
    }),
  };
  const REGISTRY = {
    idFromName: (n) => n,
    get: (n) => ({ fetch: async () => { calls.push({ kind: 'registry', name: n }); return Response.json({ sessions: [{ code: `listed-by-${n}` }] }); } }),
  };
  return {
    ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, DEPLOYMENT_ADMINS: 'root@example.com',
    DB: openD1(), OAUTH_KV: openKV(), AUTH_SECRET: SECRET, PUBLIC_ORIGIN: PROD,
    SESSION, REGISTRY, calls,
    ...extra,
  };
}

const sql = (env, text, ...params) => env.DB.sqlite.prepare(text).all(...params);
const exec = (env, text, ...params) => env.DB.sqlite.prepare(text).run(...params);
function member(env, identity, role = 'technician', workspace = 'default') {
  if (workspace !== 'default') exec(env, 'INSERT OR IGNORE INTO workspaces(slug, name, created_by, created_at) VALUES (?, ?, ?, 1)', workspace, `Team ${workspace}`, 'root@example.com');
  exec(env, "INSERT INTO members(workspace, identity, kind, name, role_id, added_at, added_by) VALUES (?, ?, 'person', NULL, ?, 1, 'test')", workspace, identity, role);
}

// ---- a browser with a cookie jar ---------------------------------------------------
const unesc = (v) => v.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const field = (html, name) => { const m = new RegExp(`name="${name}" value="([^"]*)"`).exec(html); return m && unesc(m[1]); };

class Browser {
  constructor(env, base = PROD, h = handler) { this.env = env; this.base = base; this.jar = new Map(); this.h = h; }
  async fetch(path, { method = 'GET', form, headers = {}, origin } = {}) {
    const h = new Headers(headers);
    if (this.jar.size) h.set('cookie', [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '));
    let body;
    if (form) { h.set('content-type', 'application/x-www-form-urlencoded'); body = new URLSearchParams(form).toString(); }
    if (method === 'POST' && origin !== null) h.set('origin', origin ?? this.base);
    const r = await this.h.fetch(new Request(this.base + path, { method, headers: h, body, redirect: 'manual' }), this.env);
    for (const sc of r.headers.getSetCookie()) {
      const pair = sc.split(';')[0];
      const i = pair.indexOf('=');
      if (/;\s*Max-Age=0/i.test(sc)) this.jar.delete(pair.slice(0, i)); else this.jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    return r;
  }
  // Follows redirects that stay on this site; returns the last response, or the
  // first redirect that leaves it.
  async follow(path, opts) {
    let r = await this.fetch(path, opts);
    for (let i = 0; i < 12 && r.status >= 300 && r.status < 400; i++) {
      const loc = new URL(r.headers.get('location'), this.base);
      if (loc.origin !== new URL(this.base).origin) return r;
      r = await this.fetch(loc.pathname + loc.search);
    }
    return r;
  }
}

// Signs the browser in without going through the sign-in pages: the same rows
// the pages would write. With `factor`, the person has an authenticator and this
// sign-in passed its code.
async function signIn(env, browser, email, { factor = false } = {}) {
  const store = accountStore(env.DB, { secret: SECRET });
  const found = await store.userForEmail(email, async () => true);
  const token = await store.createSession(found.user.id, { maxMs: 14 * 86400_000 });
  if (factor) {
    if (!(await store.getFactor(found.user.id))) await store.saveFactor(found.user.id, new Uint8Array(20).fill(7), 1, { replace: false });
    await store.markFactor(await sha256Hex(token));
  }
  browser.jar.set('__Host-smcp', token);
  return { userId: found.user.id, store };
}

// ---- a scripted OAuth client ------------------------------------------------------------
async function pkce() {
  const verifier = bytesToB64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = bytesToB64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  return { verifier, challenge };
}
const send = (env, path, init, base = PROD) => handler.fetch(new Request(`${base}${path}`, init), env);
// authMethod: 'none' registers a public client. null leaves the field out, which
// is what a client that does not know about it does: the library's default is
// client_secret_basic, a confidential client.
async function registerClient(env, { redirect = REDIRECT, name = 'Scripted client', authMethod = 'none' } = {}) {
  const r = await send(env, '/oauth/register', {
    method: 'POST', headers: JSON_HEADERS,
    body: JSON.stringify({ client_name: name, redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], ...(authMethod === null ? {} : { token_endpoint_auth_method: authMethod }) }),
  });
  assert.equal(r.status, 201, 'registered');
  return (await r.json()).client_id;
}
const authorizePath = ({ clientId, challenge, resource, redirect = REDIRECT, state = 'st-123', method = 'S256' }) => {
  const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirect, state, code_challenge: challenge, code_challenge_method: method });
  if (resource !== null) q.set('resource', resource ?? resourceUrl(PROD, 'default'));
  return `/oauth/authorize?${q}`;
};
async function tokenRequest(env, params) {
  const r = await send(env, '/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
  return { status: r.status, body: await r.json(), headers: r.headers };
}

// Opens the consent page for a signed-in browser. Returns the page and its fields.
async function openConsent(browser, path) {
  const r = await browser.fetch(path);
  const html = r.status === 200 ? await r.text() : '';
  if (r.status !== 200 && process.env.DBG) console.error('CONSENT', r.status, await r.clone().text().then((t) => t.slice(0, 300)));
  return { r, html, csrf: field(html, 'csrf'), handle: field(html, 'handle') };
}
const decide = (browser, page, decision, extra = {}) =>
  browser.fetch('/oauth/authorize', { method: 'POST', form: { csrf: page.csrf, handle: page.handle, decision, ...extra } });

// register -> authorize -> consent -> Allow -> token, for a browser that is already signed in.
async function connect(env, browser, { workspace = 'default', client, redirect = REDIRECT } = {}) {
  const clientId = client || await registerClient(env, { redirect });
  const { verifier, challenge } = await pkce();
  const resource = resourceUrl(PROD, workspace);
  const page = await openConsent(browser, authorizePath({ clientId, challenge, resource, redirect }));
  assert.equal(page.r.status, 200, `consent page for ${workspace}`);
  const allowed = await decide(browser, page, 'approve');
  assert.equal(allowed.status, 303);
  const back = new URL(allowed.headers.get('location'));
  assert.equal(back.origin + back.pathname, redirect);
  const code = back.searchParams.get('code');
  assert.ok(code, 'a code came back');
  const tokens = await tokenRequest(env, { grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: clientId, code_verifier: verifier, resource });
  assert.equal(tokens.status, 200, JSON.stringify(tokens.body));
  return { clientId, resource, workspace, access: tokens.body.access_token, refresh: tokens.body.refresh_token, tokens: tokens.body, back, verifier };
}

// A tool call to an MCP address with whatever headers.
const mcp = (env, path, headers, body, base = PROD) => send(env, path, { method: 'POST', headers: { ...JSON_HEADERS, ...headers }, body }, base);
const bearer = (token) => ({ authorization: `Bearer ${token}` });
async function toolText(r) {
  const out = (await r.json()).result;
  return { isError: Boolean(out.isError), text: out.content[0].text };
}
const challengeFor = (workspace, invalid) => challengeHeader(PROD, workspace, { invalid });

// ---- the library's own API: the names this relay builds on ---------------------------------------
it('the library exports the split-role API this relay uses', () => {
  for (const name of ['OAuthAuthorizationServer', 'AuthorizationError', 'CimdFetchError']) assert.equal(typeof lib[name], 'function', name);
  for (const method of ['validateToken', 'fetch', 'getOAuthApi']) assert.equal(typeof lib.OAuthAuthorizationServer.prototype[method], 'function', method);
  const server = new lib.OAuthAuthorizationServer({ issuer: PROD, resources: [`${PROD}/mcp`] });
  const api = server.getOAuthApi({ OAUTH_KV: openKV() });
  for (const method of ['parseAuthRequest', 'describeConsent', 'beginConsent', 'approveConsent', 'denyConsent', 'completeAuthorization', 'listUserGrants', 'revokeGrant']) {
    assert.equal(typeof api[method], 'function', method);
  }
});

it('small helpers: bearer parsing, challenge text and resource addresses', () => {
  const req = (value) => new Request(PROD, { headers: value === undefined ? {} : { authorization: value } });
  assert.equal(bearerToken(req()), null);
  assert.equal(bearerToken(req('Basic abc')), null);
  assert.equal(bearerToken(req('Bearer abc')), 'abc');
  assert.equal(bearerToken(req('bearer   abc  ')), 'abc');
  assert.equal(bearerToken(req('Bearer')), '');
  assert.equal(challengeHeader(PROD, 'default'), `Bearer resource_metadata="${PROD}/.well-known/oauth-protected-resource/mcp"`);
  assert.equal(challengeHeader(PROD, 'acme', { invalid: true }), `Bearer resource_metadata="${PROD}/.well-known/oauth-protected-resource/w/acme/mcp", error="invalid_token"`);
  assert.equal(challengeHeader(undefined, 'acme'), 'Bearer');
  assert.equal(resourceUrl(PROD, 'default'), `${PROD}/mcp`);
  assert.equal(resourceUrl(PROD, 'acme'), `${PROD}/w/acme/mcp`);
  assert.equal(workspaceForResource(PROD, `${PROD}/mcp`), 'default');
  assert.equal(workspaceForResource(PROD, `${PROD}/w/acme/mcp`), 'acme');
  for (const bad of [`${PROD}/w/default/mcp`, `${PROD}/mcp/x`, `https://other.example.com/mcp`, `${PROD}/w/ACME/mcp`, undefined, 7]) assert.equal(workspaceForResource(PROD, bad), null, String(bad));
});

// ---- discovery ------------------------------------------------------------------------------------
it('the authorization server document names our endpoints, S256 only, no resource list, and CIMD', async () => {
  const env = makeEnv();
  member(env, 'boss@example.com', 'admin', 'acme');
  const r = await send(env, '/.well-known/oauth-authorization-server', { method: 'GET' });
  assert.equal(r.status, 200);
  const doc = await r.json();
  assert.equal(doc.issuer, PROD);
  assert.equal(doc.authorization_endpoint, `${PROD}/oauth/authorize`);
  assert.equal(doc.token_endpoint, `${PROD}/oauth/token`);
  assert.equal(doc.registration_endpoint, `${PROD}/oauth/register`);
  assert.deepEqual(doc.code_challenge_methods_supported, ['S256']);
  assert.ok(doc.grant_types_supported.includes('refresh_token'));
  assert.equal(doc.authorization_response_iss_parameter_supported, true, 'RFC 9207');
  assert.equal(doc.client_id_metadata_document_supported, true);
  assert.ok(!('protected_resources' in doc), 'the list of teams is not published');
  assert.ok(!JSON.stringify(doc).includes('/w/acme'));
  // No sign-in is needed to read it, and a browser-based client may.
  const cors = await send(env, '/.well-known/oauth-authorization-server', { method: 'GET', headers: { origin: 'https://app.example.com' } });
  assert.equal(cors.headers.get('access-control-allow-origin'), 'https://app.example.com', 'the library answers browser clients');
  assert.equal((await send(env, '/.well-known/oauth-authorization-server', { method: 'OPTIONS', headers: { origin: 'https://app.example.com', 'access-control-request-method': 'GET' } })).status, 204);
});

it('protected resource documents name their own address and the authorization server', async () => {
  const env = makeEnv();
  member(env, 'boss@example.com', 'admin', 'acme');
  const get = (path) => send(env, `/.well-known/oauth-protected-resource${path}`, { method: 'GET' });
  for (const [path, resource] of [['', `${PROD}/mcp`], ['/mcp', `${PROD}/mcp`], ['/w/acme/mcp', `${PROD}/w/acme/mcp`]]) {
    const r = await get(path);
    assert.equal(r.status, 200, path);
    const doc = await r.json();
    assert.equal(doc.resource, resource, path);
    assert.deepEqual(doc.authorization_servers, [PROD], path);
    assert.deepEqual(doc.bearer_methods_supported, ['header']);
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
  }
  // A workspace that was never created, default's second spelling, and junk are 404.
  for (const path of ['/w/ghost/mcp', '/w/default/mcp', '/w/ACME/mcp', '/w/acme', '/mcp/extra', '/w/acme/mcp/extra']) assert.equal((await get(path)).status, 404, path);
  assert.equal((await send(env, '/.well-known/oauth-protected-resource/mcp', { method: 'POST' })).status, 405);
  assert.equal((await send(env, '/.well-known/oauth-protected-resource/mcp', { method: 'HEAD' })).status, 200);
  assert.equal((await send(env, '/.well-known/oauth-protected-resource/mcp', { method: 'OPTIONS' })).status, 204);
});

it('without the library, or without a KV namespace, every OAuth address is 404 and a bearer is ignored', async () => {
  const env = makeEnv();
  for (const path of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource/mcp', '/oauth/token', '/oauth/register', '/oauth/authorize']) {
    assert.equal((await plainHandler.fetch(new Request(`${PROD}${path}`), env)).status, 404, `no library ${path}`);
    assert.equal((await handler.fetch(new Request(`${PROD}${path}`), { ...env, OAUTH_KV: undefined })).status, 404, `no KV ${path}`);
  }
  // A bearer on /mcp is not looked at: the answer is the Access path's, a plain 401.
  const r = await plainHandler.fetch(new Request(`${PROD}/mcp`, { method: 'POST', headers: { ...JSON_HEADERS, ...bearer('x:y:z') }, body: rpc('tools/list') }), env);
  assert.equal(r.status, 401);
  assert.equal(r.headers.get('www-authenticate'), 'Bearer');
  // With the library but a missing PUBLIC_ORIGIN on a real host: the same, and no crash.
  const noOrigin = await handler.fetch(new Request(`${PROD}/mcp`, { method: 'POST', headers: JSON_HEADERS, body: rpc('tools/list') }), { ...env, PUBLIC_ORIGIN: '' });
  assert.equal(noOrigin.status, 401);
  assert.equal(noOrigin.headers.get('www-authenticate'), 'Bearer');
});

// ---- the MCP addresses refuse in the old order, then ask for a credential -------------------------------
it('Origin, then method, then content type are refused before any credential, a bearer included', async () => {
  const env = makeEnv();
  member(env, 'tech@example.com', 'viewer');
  const browser = new Browser(env);
  await signIn(env, browser, 'tech@example.com');
  const { access } = await connect(env, browser);
  const reads = env.OAUTH_KV.reads;
  for (const path of ['/mcp', '/w/acme/mcp']) {
    const withBearer = bearer(access);
    const post = (headers, body = rpc('tools/list'), method = 'POST') => send(env, path, { method, headers, body: method === 'GET' ? undefined : body });
    assert.equal((await post({ ...JSON_HEADERS, ...withBearer, origin: 'https://evil.example' })).status, 403, `${path} origin`);
    assert.equal((await post({ ...JSON_HEADERS, ...withBearer, origin: PROD })).status, 403, `${path} even our own origin`);
    assert.equal((await post({ 'content-type': 'text/plain', ...withBearer, origin: 'https://evil.example' })).status, 403);
    const wrongMethod = await post({ ...withBearer }, undefined, 'GET');
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get('allow'), 'POST');
    assert.equal((await post({ 'content-type': 'text/plain', ...withBearer })).status, 415, `${path} content type`);
    assert.equal((await post({ ...withBearer })).status, 415);
  }
  assert.equal(env.OAUTH_KV.reads, reads, 'no refusal above read KV');
});

it('no credential, a malformed, an empty and a foreign bearer token each get 401 with the discovery header', async () => {
  const env = makeEnv();
  for (const path of ['/mcp', '/w/acme/mcp']) {
    const workspace = path === '/mcp' ? 'default' : 'acme';
    const none = await mcp(env, path, {}, rpc('tools/list'));
    assert.equal(none.status, 401, path);
    assert.equal(none.headers.get('www-authenticate'), challengeFor(workspace, false), 'no error code when nothing was sent');
    assert.equal(none.headers.get('cache-control'), 'no-store');
    for (const header of ['Bearer', 'Bearer ', 'Bearer not-a-token', 'Bearer a:b:c', `Bearer ${'x'.repeat(5000)}`]) {
      const r = await mcp(env, path, { authorization: header }, rpc('tools/list'));
      assert.equal(r.status, 401, `${path} ${header.slice(0, 20)}`);
      assert.equal(r.headers.get('www-authenticate'), challengeFor(workspace, true));
      assert.equal((await r.json()).error, 'invalid_token');
    }
    // A bad Access JWT is a credential that failed on the old path: 401, no error code.
    const badJwt = await mcp(env, path, { 'cf-access-jwt-assertion': 'not.a.jwt' }, rpc('tools/list'));
    assert.equal(badJwt.status, 401);
    assert.equal(badJwt.headers.get('www-authenticate'), challengeFor(workspace, false));
  }
  // The header points at documents that exist.
  const url = /resource_metadata="([^"]+)"/.exec(challengeFor('acme', false))[1];
  assert.equal(url, `${PROD}/.well-known/oauth-protected-resource/w/acme/mcp`);
});

it('an expired token, a revoked token and a token for another address each get 401 with the discovery header', async () => {
  const env = makeEnv();
  member(env, 'tech@example.com', 'viewer');
  member(env, 'tech@example.com', 'viewer', 'acme');
  const browser = new Browser(env);
  await signIn(env, browser, 'tech@example.com');
  const onDefault = await connect(env, browser);
  const onAcme = await connect(env, browser, { workspace: 'acme' });
  const list = (path, token) => mcp(env, path, bearer(token), call('session_list'));

  // Each token works on its own address.
  assert.equal((await toolText(await list('/mcp', onDefault.access))).isError, false);
  assert.equal((await toolText(await list('/w/acme/mcp', onAcme.access))).isError, false);

  // A token for another address: both ways.
  for (const [path, token, workspace] of [['/mcp', onAcme.access, 'default'], ['/w/acme/mcp', onDefault.access, 'acme']]) {
    const r = await list(path, token);
    assert.equal(r.status, 401, path);
    assert.equal(r.headers.get('www-authenticate'), challengeFor(workspace, true));
  }
  // A workspace that does not exist has no tokens.
  assert.equal((await list('/w/ghost/mcp', onDefault.access)).status, 401);

  // Revoked: the grant is removed from KV.
  const api = new lib.OAuthAuthorizationServer({ issuer: PROD, resources: [`${PROD}/mcp`] }).getOAuthApi(env);
  const { userId } = await signIn(env, new Browser(env), 'tech@example.com');
  const grants = (await api.listUserGrants(userId)).items;
  assert.equal(grants.length, 2, 'one grant per client and address');
  await api.revokeGrant(grants.find((g) => g.resource === `${PROD}/mcp`).id, userId);
  const revoked = await list('/mcp', onDefault.access);
  assert.equal(revoked.status, 401);
  assert.equal(revoked.headers.get('www-authenticate'), challengeFor('default', true));
  assert.equal((await list('/w/acme/mcp', onAcme.access)).status, 200, 'the other grant is untouched');

  // Expired: the access token lasts an hour.
  try {
    advance(61 * 60_000);
    const expired = await list('/w/acme/mcp', onAcme.access);
    assert.equal(expired.status, 401);
    assert.equal(expired.headers.get('www-authenticate'), challengeFor('acme', true));
    assert.equal((await expired.json()).error, 'invalid_token');
  } finally {
    resetClock();
  }
});

it('a token is accepted only for its own address and a person, not a service identity', async () => {
  const env = makeEnv();
  member(env, 'tech@example.com', 'viewer');
  const browser = new Browser(env);
  await signIn(env, browser, 'tech@example.com');
  const { access } = await connect(env, browser);
  // Cutting the token changes the secret part: invalid.
  const bad = access.slice(0, -2) + (access.endsWith('aa') ? 'bb' : 'aa');
  assert.equal((await mcp(env, '/mcp', bearer(bad), call('session_list'))).status, 401);
  // The token is not an Access credential and the team API does not take it.
  const api = await send(env, '/api/v1/w/default', { headers: bearer(access) });
  assert.equal(api.status, 403, 'the team API gate is Access only: a bearer is no credential there');
  assert.equal((await send(env, '/api/v1/w', { headers: bearer(access) })).status, 403);
  const create = await send(env, '/api/v1/w', { method: 'POST', headers: { ...JSON_HEADERS, ...bearer(access) }, body: JSON.stringify({ slug: 'sneaky', name: 'Sneaky' }) });
  assert.equal(create.status, 403);
  assert.equal(sql(env, "SELECT COUNT(*) AS n FROM workspaces WHERE slug = 'sneaky'")[0].n, 0);
});

// ---- a workspace made after start-up ----------------------------------------------------------------------
it('a workspace created after the handler started gets discovery and tokens for its address, with no restart', async () => {
  const env = makeEnv();
  member(env, 'tech@example.com', 'viewer');
  const browser = new Browser(env);
  await signIn(env, browser, 'tech@example.com');
  // The handler has already served this deployment.
  assert.equal((await send(env, '/.well-known/oauth-protected-resource/w/newco/mcp', { method: 'GET' })).status, 404);
  const first = await connect(env, browser);
  assert.equal((await toolText(await mcp(env, '/mcp', bearer(first.access), call('session_list')))).isError, false);
  // The authorization server document was read before the workspace existed.
  assert.equal((await send(env, '/.well-known/oauth-authorization-server', { method: 'GET' })).status, 200);

  member(env, 'tech@example.com', 'viewer', 'newco');
  assert.equal((await send(env, '/.well-known/oauth-protected-resource/w/newco/mcp', { method: 'GET' })).status, 200);
  const grant = await connect(env, browser, { workspace: 'newco' });
  const out = await toolText(await mcp(env, '/w/newco/mcp', bearer(grant.access), call('session_list')));
  assert.equal(out.isError, false);
  assert.match(out.text, /listed-by-registry:newco/);
  assert.equal((await mcp(env, '/mcp', bearer(grant.access), call('session_list'))).status, 401, 'and it is good for newco only');
});

// ---- Access logins and service tokens keep working ---------------------------------------------------------------
it('an Access login and a service token still work as members on every MCP address, next to OAuth', async () => {
  const env = makeEnv();
  member(env, 'access@example.com', 'technician');
  member(env, 'access@example.com', 'technician', 'acme');
  member(env, 'bot.access', 'technician', 'acme');
  exec(env, "UPDATE members SET kind = 'service' WHERE identity = 'bot.access'");
  for (const [path, who] of [['/mcp', 'access@example.com'], ['/w/acme/mcp', 'access@example.com'], ['/w/acme/mcp', 'bot.access']]) {
    const out = await toolText(await mcp(env, path, { 'cf-access-jwt-assertion': await accessAs(who) }, call('run', { session_id: SID, command: 'whoami' })));
    assert.equal(out.isError, false, `${who} ${path}: ${out.text}`);
    assert.match(out.text, /done/);
  }
  // The audit prefix carries the identity.
  const ran = env.calls.filter((c) => c.kind === 'session' && c.path === '/command');
  assert.deepEqual(ran.map((c) => c.body.actor), ['access@example.com', 'access@example.com', 'bot.access']);
  // A person who is not a member is refused as before, by the tool.
  const stranger = await toolText(await mcp(env, '/mcp', { 'cf-access-jwt-assertion': await accessAs('stranger@example.com') }, call('session_list')));
  assert.deepEqual(stranger, { isError: true, text: 'you are not a member of this team' });
  // An Access JWT with the wrong audience is a failed credential.
  const wrong = await mcp(env, '/mcp', { 'cf-access-jwt-assertion': await accessToken({ email: 'access@example.com', aud: 'other' }) }, rpc('tools/list'));
  assert.equal(wrong.status, 401);
  // Under the local bypass nothing changes: every caller is local-dev, no bearer needed.
  const localEnv = { ...env, DEV_SKIP_ACCESS: '1' };
  const local = await mcp(localEnv, '/mcp', {}, rpc('tools/list'), LOCAL);
  assert.equal(local.status, 200);
  assert.equal((await local.json()).result.tools.length, 37);
  const localCall = await toolText(await mcp(localEnv, '/mcp', {}, call('session_list'), LOCAL));
  assert.deepEqual(localCall, { isError: true, text: 'you are not a member of this team' }, 'local-dev is not a member of a closed team, as before');
  // The bypass is for localhost only: the same env on the real host asks for a credential.
  assert.equal((await mcp(localEnv, '/mcp', {}, rpc('tools/list'))).status, 401);
});

it('tools/list needs a credential now (401), and with a bearer reads the person and KV only', async () => {
  const env = makeEnv();
  member(env, 'tech@example.com', 'viewer');
  const browser = new Browser(env);
  await signIn(env, browser, 'tech@example.com');
  const { access } = await connect(env, browser);

  // Without any credential, nothing at all is read.
  const trap = () => { throw new Error('touched'); };
  const dark = { ...env, DB: { prepare: trap, batch: trap }, OAUTH_KV: { get: trap, put: trap, list: trap, delete: trap }, SESSION: { get: trap, idFromName: trap, idFromString: trap }, REGISTRY: { get: trap, idFromName: trap } };
  assert.equal((await mcp(dark, '/mcp', {}, rpc('tools/list'))).status, 401);
  assert.equal((await mcp(dark, '/w/acme/mcp', {}, rpc('tools/list'))).status, 401);

  // With a valid bearer: 37 tools. D1 is read once, for the person (before KV is);
  // every other D1 statement and every Durable Object is untouched.
  const onlyUser = { prepare: (text) => { if (!/FROM users WHERE id = \?/.test(text)) trap(); return env.DB.prepare(text); }, batch: trap };
  const kvOnly = { ...env, DB: onlyUser, SESSION: { get: trap, idFromName: trap, idFromString: trap }, REGISTRY: { get: trap, idFromName: trap } };
  const reads = env.OAUTH_KV.reads;
  const writes = env.OAUTH_KV.writes;
  const r = await mcp(kvOnly, '/mcp', bearer(access), rpc('tools/list'));
  assert.equal(r.status, 200);
  assert.equal((await r.json()).result.tools.length, 37);
  assert.equal(env.OAUTH_KV.reads - reads, 1, 'one KV read per OAuth call');
  assert.equal(env.OAUTH_KV.writes, writes, 'and no write');
  // Initialize and ping too.
  for (const method of ['initialize', 'ping']) {
    const out = await mcp(kvOnly, '/mcp', bearer(access), rpc(method, { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } }));
    assert.equal(out.status, 200, method);
  }
  // A bad bearer on tools/list is a 401, so a client refreshes instead of seeing a list it cannot use.
  assert.equal((await mcp(kvOnly, '/mcp', bearer(access.slice(0, -3) + 'zzz'), rpc('tools/list'))).status, 401);
});

// ---- the full flow ---------------------------------------------------------------------------------------------------
it('full flow: register, sign in, second factor, consent, code, token, tool call, refresh rotation', async () => {
  const env = makeEnv();
  member(env, 'tech@example.com', 'technician', 'acme');
  const browser = new Browser(env);

  // 1. The client registers itself.
  const clientId = await registerClient(env, { name: 'Claude Code' });
  const { verifier, challenge } = await pkce();
  const resource = resourceUrl(PROD, 'acme');
  const path = authorizePath({ clientId, challenge, resource });

  // 2. The authorize page needs a sign-in, and keeps the whole request through it.
  const first = await browser.fetch(path);
  assert.equal(first.status, 303);
  const signinPath = first.headers.get('location');
  assert.match(signinPath, /^\/auth\/signin\?next=/);
  assert.equal(new URL(signinPath, PROD).searchParams.get('next'), path);

  // 3. Sign in by email link. The link carries the request to the other side.
  const signin = await (await browser.fetch(signinPath)).text();
  assert.equal(field(signin, 'next'), path);
  mailer.sent.length = 0;
  const asked = await browser.fetch('/auth/email', { method: 'POST', form: { csrf: field(signin, 'csrf'), email: 'tech@example.com', next: field(signin, 'next') } });
  assert.equal(asked.status, 200);
  const link = new URL(/https:\/\/[^\s"]+/.exec(mailer.sent[0].text)[0]);
  const confirm = await (await browser.fetch(link.pathname + link.search)).text();
  const done = await browser.fetch('/auth/email/confirm', { method: 'POST', form: { csrf: field(confirm, 'csrf'), t: field(confirm, 't'), next: field(confirm, 'next') } });
  assert.equal(done.status, 303);
  assert.equal(done.headers.get('location'), path, 'back to the authorize request');

  // 4. A technician needs a second factor: the page sends the person to set one up, and comes back.
  const gated = await browser.fetch(path);
  assert.equal(gated.status, 303);
  assert.equal(gated.headers.get('location'), `/auth/factor?next=${encodeURIComponent(path)}`);
  const enrolPage = await (await browser.fetch(gated.headers.get('location'))).text();
  const secretBytes = base32Decode(/class="secret"><code>([A-Z2-7 ]+)<\/code>/.exec(enrolPage)[1].replace(/ /g, ''));
  assert.equal(field(enrolPage, 'next'), path);
  const enrolled = await browser.fetch('/auth/factor', { method: 'POST', form: { csrf: field(enrolPage, 'csrf'), action: 'enrol', sealed: field(enrolPage, 'sealed'), next: path, code: await totp(secretBytes, Date.now()) } });
  assert.equal(enrolled.status, 200);
  assert.ok((await enrolled.text()).includes(`href="${path.replace(/&/g, '&amp;')}"`), 'the recovery page continues to the authorize request');

  // 5. The consent page names the app, where it returns, the workspace and what the role allows.
  const page = await openConsent(browser, path);
  assert.equal(page.r.status, 200);
  assert.match(page.html, /Allow Claude Code to connect\?/);
  assert.match(page.html, /This app registered itself, so its name is not verified/);
  assert.match(page.html, /Team acme/);
  assert.match(page.html, /\(acme\)/);
  assert.match(page.html, /Technician/);
  assert.match(page.html, /<dd>127\.0\.0\.1<\/dd>/);
  assert.match(page.html, /This sends access to an app on your computer/, 'loopback warning');
  assert.match(page.html, /Run commands, move files and control the screen/);
  assert.match(page.html, /tech@example\.com/);
  assert.doesNotMatch(page.html, /<script|<link|<img|src=|@import|url\(/i);
  assert.doesNotMatch(page.html, /\u2014/);
  assert.equal(page.r.headers.get('cache-control'), 'no-store');
  assert.equal(page.r.headers.get('x-frame-options'), 'DENY');
  const csp = page.r.headers.get('content-security-policy');
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /script-src/);
  // form-action lets the browser follow the redirect to the client after the post.
  assert.match(csp, /form-action 'self' http:\/\/127\.0\.0\.1:33418;/);
  assert.ok([...browser.jar.keys()].some((k) => k.startsWith('__Host-oauth-consent-')), 'the library bound the page to this browser');

  // 6. Allow.
  const allowed = await decide(browser, page, 'approve');
  assert.equal(allowed.status, 303);
  const back = new URL(allowed.headers.get('location'));
  assert.equal(`${back.origin}${back.pathname}`, REDIRECT);
  assert.equal(back.searchParams.get('state'), 'st-123');
  assert.equal(back.searchParams.get('iss'), PROD, 'RFC 9207');
  const code = back.searchParams.get('code');
  assert.ok(code);
  assert.ok(![...browser.jar.keys()].some((k) => k.startsWith('__Host-oauth-consent-')), 'the binding cookie is cleared');

  // 7. The code is good for one exchange, with the verifier.
  const wrongVerifier = await tokenRequest(env, { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: 'x'.repeat(50), resource });
  assert.equal(wrongVerifier.status, 400);
  assert.equal(wrongVerifier.body.error, 'invalid_grant');
  const exchange = { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource };
  const tokens = await tokenRequest(env, exchange);
  assert.equal(tokens.status, 200, JSON.stringify(tokens.body));
  assert.equal(tokens.body.token_type, 'bearer');
  assert.equal(tokens.body.expires_in, 3600, 'access tokens last an hour');
  assert.ok(tokens.body.refresh_token);
  assert.equal(tokens.headers.get('cache-control'), 'no-store');

  // 8. The tool call runs on the right workspace, as the person.
  const ran = await toolText(await mcp(env, '/w/acme/mcp', bearer(tokens.body.access_token), call('run', { session_id: SID, command: 'whoami' })));
  assert.deepEqual(ran, { isError: false, text: JSON.stringify({ exit_code: 0, stdout: 'done', stderr: '', timed_out: false }) });
  const listed = await toolText(await mcp(env, '/w/acme/mcp', bearer(tokens.body.access_token), call('session_list')));
  assert.match(listed.text, /listed-by-registry:acme/);
  const command = env.calls.find((c) => c.path === '/command');
  assert.equal(command.body.actor, 'tech@example.com', 'the audit identity is the person');
  assert.equal(command.body.workspace, 'acme');

  // 9. Refresh: a new pair, and the old refresh token stops working.
  const writesBefore = env.OAUTH_KV.writes;
  const refreshed = await tokenRequest(env, { grant_type: 'refresh_token', refresh_token: tokens.body.refresh_token, client_id: clientId });
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
  assert.equal(env.OAUTH_KV.writes - writesBefore, 2, 'a refresh costs two KV writes: the new access token and the grant');
  assert.notEqual(refreshed.body.refresh_token, tokens.body.refresh_token, 'refresh tokens rotate');
  assert.equal((await toolText(await mcp(env, '/w/acme/mcp', bearer(refreshed.body.access_token), call('session_list')))).isError, false);
  // The library accepts the current refresh token and the one before it. Using the
  // current one makes the one before it (now two back) stop working.
  const again = await tokenRequest(env, { grant_type: 'refresh_token', refresh_token: refreshed.body.refresh_token, client_id: clientId });
  assert.equal(again.status, 200);
  const stale = await tokenRequest(env, { grant_type: 'refresh_token', refresh_token: tokens.body.refresh_token, client_id: clientId });
  assert.equal(stale.status, 400);
  assert.equal(stale.body.error, 'invalid_grant');
  // The refreshed token is still bound to the same address.
  assert.equal((await mcp(env, '/mcp', bearer(again.body.access_token), call('session_list'))).status, 401);

  // The code works once. Presenting it again is refused, and the library treats a
  // replay as theft: it ends the grant, so the tokens issued from it stop working too.
  const replay = await tokenRequest(env, exchange);
  assert.equal(replay.status, 400);
  assert.equal(replay.body.error, 'invalid_grant');
  const afterReplay = await mcp(env, '/w/acme/mcp', bearer(again.body.access_token), call('session_list'));
  assert.equal(afterReplay.status, 401, 'a replayed code ends the grant');
});

it('a request error is shown on our own page and never redirected to the client; only a plain link offers the way back', async () => {
  const env = makeEnv();
  member(env, 'tech@example.com', 'viewer');
  member(env, 'tech@example.com', 'viewer', 'acme');
  const browser = new Browser(env);
  await signIn(env, browser, 'tech@example.com');
  const clientId = await registerClient(env);
  const { challenge } = await pkce();
  const writes = env.OAUTH_KV.writes;
  const seen = {};
  for (const [name, path] of [
    ['plain', authorizePath({ clientId, challenge, method: 'plain' })],
    ['no challenge', authorizePath({ clientId, challenge: '' }).replace('code_challenge=&', '').replace('&code_challenge_method=S256', '')],
    ['no resource', authorizePath({ clientId, challenge, resource: null })],
    ['unknown resource', authorizePath({ clientId, challenge, resource: `${PROD}/w/ghost/mcp` })],
    ['foreign resource', authorizePath({ clientId, challenge, resource: 'https://other.example.com/mcp' })],
    ['bad response_type', authorizePath({ clientId, challenge }).replace('response_type=code', 'response_type=token')],
  ]) {
    const r = await browser.fetch(path);
    // The redirect address is registered and checked, and still nothing redirects:
    // the person has not chosen anything yet.
    assert.equal(r.status, 400, name);
    assert.equal(r.headers.get('location'), null, `${name}: no redirect to the client`);
    const html = await r.text();
    seen[name] = html;
    // A plain link names the client's host. It is a link the person may click, not a redirect.
    if (name !== 'no challenge') assert.match(html, /<a href="http:\/\/127\.0\.0\.1:33418\/callback\?[^"]*error=[^"]*" rel="noreferrer">Go back to 127\.0\.0\.1<\/a>/, name);
  }
  assert.match(seen['unknown resource'], /resource parameter must name exactly one/);
  assert.equal(env.OAUTH_KV.writes, writes, 'no consent was started by any of these');
  // An unregistered redirect address is never linked to either: the person sees an error.
  const evil = await browser.fetch(authorizePath({ clientId, challenge, redirect: 'https://evil.example/cb' }));
  assert.equal(evil.status, 400);
  const evilHtml = await evil.text();
  assert.match(evilHtml, /Invalid redirect URI/);
  assert.doesNotMatch(evilHtml, /evil\.example/);
  const unknownClient = await browser.fetch(authorizePath({ clientId: 'nope', challenge }));
  assert.equal(unknownClient.status, 400);
  // A client that registered itself and sends a bogus parameter cannot bounce a signed-in person to its own site.
  const attacker = await registerClient(env, { redirect: 'https://attacker.example/cb', name: 'Totally legit' });
  for (const [key, value] of [['response_type', 'token'], ['code_challenge_method', 'plain'], ['resource', 'https://nope.example/mcp'], ['code_challenge', '']]) {
    const q = new URL(authorizePath({ clientId: attacker, challenge, redirect: 'https://attacker.example/cb' }), PROD).searchParams;
    q.set(key, value);
    const r = await browser.fetch(`/oauth/authorize?${q}`);
    assert.equal(r.status, 400, key);
    assert.equal(r.headers.get('location'), null, `${key}: the person is not sent to attacker.example`);
  }
});

it('refresh rotation as the library does it: the previous token is accepted too, and reuse is not detected', async () => {
  const env = makeEnv();
  member(env, 'tech@example.com', 'viewer');
  const browser = new Browser(env);
  await signIn(env, browser, 'tech@example.com');
  const first = await connect(env, browser);
  const refresh = (token) => tokenRequest(env, { grant_type: 'refresh_token', refresh_token: token, client_id: first.clientId });
  const r1 = await refresh(first.refresh);
  assert.equal(r1.status, 200);
  // The token that was just replaced still works. A copy of it can be used once more, after the real client has moved on.
  const r2 = await refresh(first.refresh);
  assert.equal(r2.status, 200, 'the previous refresh token is accepted');
  // That use makes the real client's newer token stop working, and nothing ends the grant or says so.
  assert.equal((await refresh(r1.body.refresh_token)).status, 400, 'the newer token is now two back');
  assert.equal((await mcp(env, '/mcp', bearer(r1.body.access_token), call('session_list'))).status, 200, 'access tokens already issued stay good');
  assert.equal((await refresh(r2.body.refresh_token)).status, 200, 'and the grant lives on in the hands of whoever used it');
  assert.equal([...env.OAUTH_KV.rows.keys()].filter((k) => k.startsWith('grant:')).length, 1);
});

it('PKCE S256 is required of every client: a self-registered confidential client that sends no challenge is refused', async () => {
  const env = makeEnv();
  member(env, 'tech@example.com', 'viewer');
  const browser = new Browser(env);
  await signIn(env, browser, 'tech@example.com');
  // A client that names no authentication method gets the library's default: a confidential client.
  const confidential = await registerClient(env, { authMethod: null });
  const stored = JSON.parse([...env.OAUTH_KV.rows].find(([k]) => k === `client:${confidential}`)[1].value);
  assert.equal(stored.tokenEndpointAuthMethod, 'client_secret_basic', 'the default is not a public client');
  const { challenge } = await pkce();
  const bare = new URLSearchParams({ response_type: 'code', client_id: confidential, redirect_uri: REDIRECT, state: 's', resource: resourceUrl(PROD, 'default') });
  const writes = env.OAUTH_KV.writes;
  for (const [name, extra] of [
    ['no challenge', {}],
    ['a method but no challenge', { code_challenge_method: 'S256' }],
    ['plain', { code_challenge: challenge, code_challenge_method: 'plain' }],
    ['a challenge and no method', { code_challenge: challenge }],
    ['a challenge of the wrong length', { code_challenge: 'short', code_challenge_method: 'S256' }],
  ]) {
    const q = new URLSearchParams(bare);
    for (const [k, v] of Object.entries(extra)) q.set(k, v);
    const r = await browser.fetch(`/oauth/authorize?${q}`);
    assert.equal(r.status, 400, name);
    assert.equal(r.headers.get('location'), null, name);
  }
  const noChallenge = await browser.fetch(`/oauth/authorize?${bare}`);
  assert.match(await noChallenge.text(), /PKCE/);
  assert.equal(env.OAUTH_KV.writes, writes, 'no consent was started');
  // With S256 the same client is shown the consent page and can finish, with its secret.
  const ok = await openConsent(browser, authorizePath({ clientId: confidential, challenge }));
  assert.equal(ok.r.status, 200);

  // The code is made only after the check is made again. A stored request that lacks
  // the challenge (put there by anything) is refused when the person presses Allow.
  const api = new lib.OAuthAuthorizationServer({ issuer: PROD, resources: [`${PROD}/mcp`] }).getOAuthApi(env);
  const begun = await api.beginConsent({ responseType: 'code', clientId: confidential, redirectUri: REDIRECT, scope: [], state: 's', resource: resourceUrl(PROD, 'default'), issuer: PROD });
  for (const cookie of begun.headers.getSetCookie()) { const pair = cookie.split(';')[0]; browser.jar.set(pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)); }
  const grants = () => [...env.OAUTH_KV.rows.keys()].filter((k) => k.startsWith('grant:')).length;
  const forged = await browser.fetch('/oauth/authorize', { method: 'POST', form: { csrf: ok.csrf, handle: begun.handle, decision: 'approve' } });
  assert.equal(forged.status, 400);
  assert.equal(forged.headers.get('location'), null);
  assert.match(await forged.text(), /PKCE/);
  assert.equal(grants(), 0, 'no code was made');
});

// ---- consent -----------------------------------------------------------------------------------------------------------------
it('consent refuses someone who is not a member of the resource workspace, and one with no such workspace', async () => {
  const env = makeEnv();
  member(env, 'tech@example.com', 'viewer', 'acme');
  member(env, 'other@example.com', 'viewer', 'beta');
  const browser = new Browser(env);
  await signIn(env, browser, 'tech@example.com');
  const clientId = await registerClient(env);
  const { challenge } = await pkce();
  const ask = (workspace) => browser.fetch(authorizePath({ clientId, challenge, resource: resourceUrl(PROD, workspace) }));
  const writes = env.OAUTH_KV.writes;
  for (const workspace of ['beta', 'default']) {
    const r = await ask(workspace);
    assert.equal(r.status, 403, workspace);
    assert.match(await r.text(), /does not exist, or you are not a member/);
  }
  const ghost = await ask('ghost');
  assert.equal(ghost.status, 400, 'a workspace that does not exist is a bad resource: an error page');
  assert.equal(ghost.headers.get('location'), null);
  assert.equal(env.OAUTH_KV.writes, writes, 'no consent was started, no grant written');
  assert.equal((await ask('acme')).status, 200, 'the member passes');
  // The default workspace while open admits nobody over OAuth: only real members count.
  const open = new Browser(env);
  await signIn(env, open, 'root@example.com');
  assert.equal((await open.fetch(authorizePath({ clientId, challenge }))).status, 403);
});

it('Deny sends access_denied, state and iss back to the client and issues nothing', async () => {
  const env = makeEnv();
  member(env, 'tech@example.com', 'viewer');
  const browser = new Browser(env);
  await signIn(env, browser, 'tech@example.com');
  const clientId = await registerClient(env);
  const { challenge } = await pkce();
  const page = await openConsent(browser, authorizePath({ clientId, challenge, state: 'deny-state' }));
  const denied = await decide(browser, page, 'deny');
  assert.equal(denied.status, 303);
  const back = new URL(denied.headers.get('location'));
  assert.equal(`${back.origin}${back.pathname}`, REDIRECT);
  assert.equal(back.searchParams.get('error'), 'access_denied');
  assert.equal(back.searchParams.get('state'), 'deny-state');
  assert.equal(back.searchParams.get('iss'), PROD);
  assert.equal(back.searchParams.get('code'), null);
  assert.equal([...env.OAUTH_KV.rows.keys()].filter((k) => k.startsWith('grant:')).length, 0, 'no grant');
  // The page cannot be used again.
  const again = await decide(browser, page, 'approve');
  assert.equal(again.status, 400);
  assert.match(await again.text(), /start again/i);
});

it('the consent form needs its token, our own origin, a form body, and a handle from this browser', async () => {
  const env = makeEnv();
  member(env, 'tech@example.com', 'viewer');
  const browser = new Browser(env);
  await signIn(env, browser, 'tech@example.com');
  const clientId = await registerClient(env);
  const { challenge } = await pkce();
  const page = await openConsent(browser, authorizePath({ clientId, challenge }));
  const grants = () => [...env.OAUTH_KV.rows.keys()].filter((k) => k.startsWith('grant:')).length;
  const post = (init) => browser.fetch('/oauth/authorize', { method: 'POST', ...init });

  assert.equal((await post({ form: { handle: page.handle, decision: 'approve' } })).status, 403, 'no token');
  assert.equal((await post({ form: { csrf: 'wrong', handle: page.handle, decision: 'approve' } })).status, 403, 'wrong token');
  assert.equal((await post({ origin: 'https://evil.example', form: { csrf: page.csrf, handle: page.handle, decision: 'approve' } })).status, 403, 'foreign origin');
  assert.equal((await post({ origin: 'null', form: { csrf: page.csrf, handle: page.handle, decision: 'approve' } })).status, 403, 'null origin');
  const json = await handler.fetch(new Request(`${PROD}/oauth/authorize`, { method: 'POST', headers: { 'content-type': 'application/json', origin: PROD, cookie: [...browser.jar].map(([k, v]) => `${k}=${v}`).join('; ') }, body: '{}' }), env);
  assert.equal(json.status, 415);
  assert.equal((await post({ form: { csrf: page.csrf, handle: page.handle, decision: 'maybe' } })).status, 400, 'an unknown decision');
  assert.equal((await post({ form: { csrf: page.csrf, handle: page.handle } })).status, 400, 'no decision');
  assert.equal(grants(), 0);
  // Another person's token does not fit this sign-in.
  const other = new Browser(env);
  await signIn(env, other, 'tech@example.com');
  const otherPage = await openConsent(other, authorizePath({ clientId, challenge }));
  assert.equal((await post({ form: { csrf: otherPage.csrf, handle: page.handle, decision: 'approve' } })).status, 403, 'a token from another sign-in');
  // Without the binding cookie, a handle is useless.
  const stranger = new Browser(env);
  stranger.jar.set('__Host-smcp', browser.jar.get('__Host-smcp'));
  const noCookie = await stranger.fetch('/oauth/authorize', { method: 'POST', form: { csrf: page.csrf, handle: page.handle, decision: 'approve' } });
  assert.equal(noCookie.status, 400);
  assert.match(await noCookie.text(), /not started in this browser/);
  // Not signed in: sent to the sign-in page.
  const signedOut = await new Browser(env).fetch('/oauth/authorize', { method: 'POST', form: { csrf: page.csrf, handle: page.handle, decision: 'approve' } });
  assert.equal(signedOut.status, 303);
  assert.match(signedOut.headers.get('location'), /^\/auth\/signin/);
  assert.equal(grants(), 0, 'nothing was granted by any of these');
  // GET and POST only.
  assert.equal((await browser.fetch('/oauth/authorize', { method: 'PUT', form: {} })).status, 405);
  // And the genuine post still works.
  assert.equal((await post({ form: { csrf: page.csrf, handle: page.handle, decision: 'approve' } })).status, 303);
  assert.equal(grants(), 1);
});

it('a role that needs a second factor is sent to set one up or enter a code first, then back to consent', async () => {
  const env = makeEnv();
  member(env, 'tech@example.com', 'technician');
  member(env, 'view@example.com', 'viewer');
  const clientId = await registerClient(env);
  const { challenge } = await pkce();
  const path = authorizePath({ clientId, challenge });
  const back = `/auth/factor?next=${encodeURIComponent(path)}`;

  // A technician with no authenticator, or one not used in this sign-in.
  const noFactor = new Browser(env);
  await signIn(env, noFactor, 'tech@example.com');
  const r1 = await noFactor.fetch(path);
  assert.deepEqual([r1.status, r1.headers.get('location')], [303, back]);
  const enrolPage = await noFactor.fetch(back);
  assert.match(await enrolPage.text(), /Set up your authenticator/);

  const withFactorButNoCode = new Browser(env);
  const { store, userId } = await signIn(env, withFactorButNoCode, 'tech@example.com');
  await store.saveFactor(userId, new Uint8Array(20).fill(3), 1, { replace: false });
  const r2 = await withFactorButNoCode.fetch(path);
  assert.deepEqual([r2.status, r2.headers.get('location')], [303, back]);
  assert.match(await (await withFactorButNoCode.fetch(back)).text(), /Enter your code/);

  // With a code passed in this sign-in, the page shows.
  const passed = new Browser(env);
  await signIn(env, passed, 'tech@example.com', { factor: true });
  assert.equal((await passed.fetch(path)).status, 200);

  // A viewer holds no factor permission, so no code is asked for.
  const viewer = new Browser(env);
  await signIn(env, viewer, 'view@example.com');
  assert.equal((await viewer.fetch(path)).status, 200);

  // The approval is read again at Allow: a factor that stopped counting in between is refused.
  const page = await openConsent(passed, path);
  exec(env, 'DELETE FROM user_factors');
  const late = await decide(passed, page, 'approve');
  assert.equal(late.status, 403);
  assert.match(await late.text(), /changed while this page was open/);
  assert.equal([...env.OAUTH_KV.rows.keys()].filter((k) => k.startsWith('grant:')).length, 0);
});

it('the consent page escapes what the client chose, names a CIMD client by its domain, and covers the redirect in form-action', async () => {
  const env = makeEnv();
  member(env, 'tech@example.com', 'viewer');
  const browser = new Browser(env);
  await signIn(env, browser, 'tech@example.com');
  const { challenge } = await pkce();

  // A dynamically registered client picks its own name and redirect address.
  const r = await send(env, '/oauth/register', {
    method: 'POST', headers: JSON_HEADERS,
    body: JSON.stringify({ client_name: '<img src=x onerror=alert(1)>"', redirect_uris: ['https://app.example.org/cb'], grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
  });
  const evilName = (await r.json()).client_id;
  const page = await openConsent(browser, authorizePath({ clientId: evilName, challenge, redirect: 'https://app.example.org/cb' }));
  assert.equal(page.r.status, 200);
  assert.doesNotMatch(page.html, /<img/);
  assert.match(page.html, /&lt;img src=x onerror=alert\(1\)&gt;&quot;/);
  assert.doesNotMatch(page.html, /loopback|on your computer/);
  assert.match(page.r.headers.get('content-security-policy'), /form-action 'self' https:\/\/app\.example\.org;/);

  // A Client ID Metadata Document client: its https address is its id.
  const cimd = 'https://client.example.net/oauth/metadata.json';
  cimdDocs.set(cimd, { client_id: cimd, client_name: 'Docs client', redirect_uris: ['cursor://anysphere.cursor-mcp/oauth/callback', 'https://client.example.net/cb'], token_endpoint_auth_method: 'none' });
  const viaDoc = await openConsent(browser, authorizePath({ clientId: cimd, challenge, redirect: 'https://client.example.net/cb' }));
  assert.equal(viaDoc.r.status, 200, 'CIMD client resolved');
  assert.match(viaDoc.html, /Allow Docs client to connect\?/);
  assert.match(viaDoc.html, /Published by <strong>client\.example\.net<\/strong>/);
  const allowed = await decide(browser, viaDoc, 'approve');
  assert.equal(allowed.status, 303);
  assert.match(allowed.headers.get('location'), /^https:\/\/client\.example\.net\/cb\?code=/);
  // A document that does not match its address is refused, and shown as an error here.
  const lying = 'https://liar.example.net/oauth/metadata.json';
  cimdDocs.set(lying, { client_id: 'https://someone-else.example.net/x', client_name: 'Liar', redirect_uris: ['https://liar.example.net/cb'] });
  const bad = await browser.fetch(authorizePath({ clientId: lying, challenge, redirect: 'https://liar.example.net/cb' }));
  assert.ok([400, 502].includes(bad.status), `a lying document: ${bad.status}`);
  assert.equal(bad.headers.get('location'), null, 'never redirected to an unchecked client');
  cimdDocs.clear();
});

it('redirectSource builds a form-action source only from a plain origin or a safe scheme', () => {
  assert.equal(redirectSource('https://app.example.org/cb?x=1'), 'https://app.example.org');
  assert.equal(redirectSource('http://127.0.0.1:33418/callback'), 'http://127.0.0.1:33418');
  assert.equal(redirectSource('http://localhost:8080/cb'), 'http://localhost:8080');
  assert.equal(redirectSource('http://[::1]:9000/cb'), 'http://[::1]:9000');
  assert.equal(redirectSource('cursor://anysphere.cursor-mcp/oauth/callback'), 'cursor:');
  assert.equal(redirectSource('vscode://vscode.github-authentication/callback'), 'vscode:');
  assert.equal(redirectSource('com.example.app:/oauth2redirect'), 'com.example.app:', 'a reverse-domain scheme with a path only');
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'https://a;script-src.evil.example/cb', 'https://a,b.example/cb', 'https://exa mple.com/', 'not a url', 'ws://x.example/', 'ftp://x.example/', 'mailto:a@example.com', 'intent://x#Intent;end', 'x'.repeat(40) + '://a']) {
    assert.equal(redirectSource(bad), null, bad);
  }
});

it('returnAddress shows a web host plainly and an app link with its scheme', () => {
  assert.equal(returnAddress('https://app.example.org/cb?x=1'), 'app.example.org');
  assert.equal(returnAddress('http://127.0.0.1:33418/callback'), '127.0.0.1');
  assert.equal(returnAddress('cursor://anysphere.cursor-mcp/oauth/callback'), 'cursor://anysphere.cursor-mcp');
  assert.equal(returnAddress('com.example.app:/oauth2redirect'), 'com.example.app:/oauth2redirect');
  assert.equal(returnAddress('not a url'), '');
});

// ---- ending access ---------------------------------------------------------------------------------------------------------------
it('removing a member ends their token on its next call; so do a disabled person and a reset authenticator', async () => {
  const env = makeEnv();
  member(env, 'boss@example.com', 'admin');
  member(env, 'tech@example.com', 'technician');
  const browser = new Browser(env);
  const { userId } = await signIn(env, browser, 'tech@example.com', { factor: true });
  const { access } = await connect(env, browser);
  const run = () => mcp(env, '/mcp', bearer(access), call('run', { session_id: SID, command: 'whoami' })).then(toolText);
  const list = () => mcp(env, '/mcp', bearer(access), call('session_list')).then(toolText);
  const refusal = (text) => ({ isError: true, text });

  assert.equal((await run()).isError, false);
  assert.equal((await list()).isError, false);

  // A reset authenticator: control is refused, viewing is not.
  exec(env, 'DELETE FROM user_factors');
  assert.match((await run()).text, /a second factor is required/);
  assert.equal((await list()).isError, false);
  // The person enrols again: the old grant still does not carry the new authenticator.
  const store = accountStore(env.DB, { secret: SECRET });
  await store.saveFactor(userId, new Uint8Array(20).fill(9), 1, { replace: false });
  assert.match((await run()).text, /a second factor is required/, 'a new authenticator needs a new connection');

  // Disabled.
  // A disabled person's token is refused before KV is read.
  exec(env, 'UPDATE users SET disabled_at = 1 WHERE id = ?', userId);
  const kvReads = env.OAUTH_KV.reads;
  const disabled = await mcp(env, '/mcp', bearer(access), call('session_list'));
  assert.equal(disabled.status, 401);
  assert.equal((await disabled.json()).error, 'invalid_token');
  assert.equal(env.OAUTH_KV.reads, kvReads, 'and no KV read');
  exec(env, 'UPDATE users SET disabled_at = NULL WHERE id = ?', userId);
  assert.equal((await list()).isError, false);

  // Removed from the team, through the team API, as an admin: the very next call fails.
  const del = await send(env, '/api/v1/w/default/members/tech%40example.com', { method: 'DELETE', headers: { ...JSON_HEADERS, 'cf-access-jwt-assertion': await accessAs('boss@example.com') } });
  assert.equal(del.status, 200, await del.clone().text());
  assert.deepEqual(await list(), refusal('you are not a member of this team'));
  assert.deepEqual(await run(), refusal('you are not a member of this team'));
  // tools/list stays static and needs no database.
  assert.equal((await mcp(env, '/mcp', bearer(access), rpc('tools/list'))).status, 200);
});

it('an invited person who only holds another team still cannot use a token for a team they left', async () => {
  const env = makeEnv();
  member(env, 'boss@example.com', 'admin', 'acme');
  member(env, 'tech@example.com', 'viewer', 'acme');
  member(env, 'tech@example.com', 'viewer', 'beta');
  const browser = new Browser(env);
  await signIn(env, browser, 'tech@example.com');
  const { access } = await connect(env, browser, { workspace: 'acme' });
  exec(env, "DELETE FROM members WHERE workspace = 'acme' AND identity = 'tech@example.com'");
  const out = await toolText(await mcp(env, '/w/acme/mcp', bearer(access), call('session_list')));
  assert.deepEqual(out, { isError: true, text: 'you are not a member of this team' }, 'still invited to beta, but not a member of acme');
});

it('sign out everywhere revokes every OAuth grant; plain sign out does not', async () => {
  const env = makeEnv();
  member(env, 'tech@example.com', 'viewer');
  member(env, 'tech@example.com', 'viewer', 'acme');
  member(env, 'other@example.com', 'viewer');
  const browser = new Browser(env);
  await signIn(env, browser, 'tech@example.com');
  const a = await connect(env, browser);
  const b = await connect(env, browser, { workspace: 'acme' });
  const otherBrowser = new Browser(env);
  await signIn(env, otherBrowser, 'other@example.com');
  const c = await connect(env, otherBrowser);
  const ok = async (grant) => (await mcp(env, grant.workspace === 'default' ? '/mcp' : `/w/${grant.workspace}/mcp`, bearer(grant.access), call('session_list'))).status;
  assert.deepEqual([await ok(a), await ok(b), await ok(c)], [200, 200, 200]);

  // A plain sign out ends the browser only.
  const spare = new Browser(env);
  spare.jar.set('__Host-smcp', browser.jar.get('__Host-smcp'));
  const page = await (await spare.fetch('/account')).text();
  const out = await spare.fetch('/auth/signout', { method: 'POST', form: { csrf: field(page, 'csrf') } });
  assert.equal(out.status, 303);
  assert.deepEqual([await ok(a), await ok(b)], [200, 200], 'sign out leaves the clients connected');

  // Sign out everywhere ends the grants of this person, and only theirs.
  await signIn(env, browser, 'tech@example.com');
  const account = await (await browser.fetch('/account')).text();
  const everywhere = await browser.fetch('/account/signout-everywhere', { method: 'POST', form: { csrf: field(account, 'csrf') } });
  assert.equal(everywhere.status, 303);
  assert.match(everywhere.headers.get('location'), /m=signed_out/);
  assert.deepEqual([await ok(a), await ok(b), await ok(c)], [401, 401, 200]);
  assert.deepEqual([...env.OAUTH_KV.rows.keys()].filter((k) => k.startsWith('grant:')).map((k) => k.split(':')[1]).length, 1);
  // The refresh tokens died with the grants.
  const refused = await tokenRequest(env, { grant_type: 'refresh_token', refresh_token: a.refresh, client_id: a.clientId });
  assert.equal(refused.status, 400);
});

it('sign out everywhere says so when KV cannot be reached, and still ends the browser sign-ins', async () => {
  const env = makeEnv();
  member(env, 'tech@example.com', 'viewer');
  const browser = new Browser(env);
  const { userId } = await signIn(env, browser, 'tech@example.com');
  await connect(env, browser);
  const account = await (await browser.fetch('/account')).text();
  env.OAUTH_KV.failing = true;
  const r = await browser.fetch('/account/signout-everywhere', { method: 'POST', form: { csrf: field(account, 'csrf') } });
  env.OAUTH_KV.failing = false;
  assert.equal(r.status, 503);
  assert.match(await r.text(), /Some apps are still connected/);
  assert.equal(sql(env, 'SELECT COUNT(*) AS n FROM login_sessions WHERE user_id = ? AND revoked_at IS NULL', userId)[0].n, 0);
});

it('a KV failure is a 503 on an MCP call, not a 401 that would throw the sign-in away; tool calls cost one read', async () => {
  const env = makeEnv();
  member(env, 'tech@example.com', 'viewer');
  const browser = new Browser(env);
  await signIn(env, browser, 'tech@example.com');
  const writesBefore = env.OAUTH_KV.writes;
  const { access } = await connect(env, browser);
  assert.equal(env.OAUTH_KV.writes - writesBefore, 5, 'a new connection writes five keys: the client, the consent step, the code, the token and the grant update');
  const reads = env.OAUTH_KV.reads;
  assert.equal((await mcp(env, '/mcp', bearer(access), call('session_list'))).status, 200);
  assert.equal(env.OAUTH_KV.reads - reads, 1, 'one KV read per OAuth tool call');
  env.OAUTH_KV.failing = true;
  const r = await mcp(env, '/mcp', bearer(access), call('session_list'));
  env.OAUTH_KV.failing = false;
  assert.equal(r.status, 503);
  assert.equal(r.headers.get('www-authenticate'), null);
  assert.equal((await mcp(env, '/mcp', bearer(access), call('session_list'))).status, 200, 'and it recovers');
  // The OAuth endpoints fail the same way.
  env.OAUTH_KV.failing = true;
  const token = await send(env, '/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=refresh_token&refresh_token=a:b:c&client_id=x' });
  env.OAUTH_KV.failing = false;
  assert.ok(token.status >= 400, `token endpoint ${token.status}`);
});

it('the OAuth endpoints answer 503 when the workspace list cannot be read', async () => {
  const env = makeEnv({ DB: undefined });
  for (const path of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource/w/acme/mcp']) {
    const r = await send(env, path, { method: 'GET' });
    assert.equal(r.status, 503, path);
  }
  // The default address needs no list.
  assert.equal((await send(env, '/.well-known/oauth-protected-resource/mcp', { method: 'GET' })).status, 200);
});

it('dynamic registration is open, defaults to a confidential client, and is strict about redirect addresses', async () => {
  const env = makeEnv();
  const reg = (body) => send(env, '/oauth/register', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
  const ok = await reg({ client_name: 'X', redirect_uris: ['https://app.example.org/cb'], token_endpoint_auth_method: 'none' });
  assert.equal(ok.status, 201);
  // Registration is not limited to public clients. The default method is a client secret,
  // so the PKCE rule cannot rest on the client being public (see the PKCE test).
  const dflt = await reg({ client_name: 'X', redirect_uris: ['https://app.example.org/cb'] });
  assert.equal(dflt.status, 201);
  assert.equal((await dflt.json()).token_endpoint_auth_method, 'client_secret_basic');
  for (const redirect_uris of [['javascript:alert(1)'], ['data:text/html,x'], ['http://app.example.org/cb'], ['https://u:p@app.example.org/cb'], ['https://app.example.org/cb#frag'], []]) {
    const r = await reg({ client_name: 'X', redirect_uris, token_endpoint_auth_method: 'none' });
    assert.equal(r.status, 400, JSON.stringify(redirect_uris));
  }
});

it('an app that returns through its own link (cursor://) can register, is shown where it returns, and gets its code there', async () => {
  const env = makeEnv();
  member(env, 'tech@example.com', 'viewer');
  const browser = new Browser(env);
  await signIn(env, browser, 'tech@example.com');
  const appLink = 'cursor://anysphere.cursor-mcp/oauth/callback';
  const clientId = await registerClient(env, { redirect: appLink, name: 'Cursor' });
  const { verifier, challenge } = await pkce();
  const page = await openConsent(browser, authorizePath({ clientId, challenge, redirect: appLink }));
  assert.equal(page.r.status, 200);
  assert.match(page.html, /<dd>cursor:\/\/anysphere\.cursor-mcp<\/dd>/, 'the scheme and host are shown');
  assert.match(page.html, /opens an app on your device/);
  assert.match(page.r.headers.get('content-security-policy'), /form-action 'self' cursor:;/);
  const allowed = await decide(browser, page, 'approve');
  assert.equal(allowed.status, 303);
  const back = new URL(allowed.headers.get('location'));
  assert.equal(`${back.protocol}//${back.host}${back.pathname}`, appLink);
  const tokens = await tokenRequest(env, { grant_type: 'authorization_code', code: back.searchParams.get('code'), redirect_uri: appLink, client_id: clientId, code_verifier: verifier, resource: resourceUrl(PROD, 'default') });
  assert.equal(tokens.status, 200, JSON.stringify(tokens.body));
  // Dangerous schemes are still refused at registration.
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd']) {
    const r = await send(env, '/oauth/register', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ client_name: 'X', redirect_uris: [bad], token_endpoint_auth_method: 'none' }) });
    assert.equal(r.status, 400, bad);
  }
  // A scheme the form-action builder will not write is refused on the authorize page, not shown.
  for (const odd of ['ws://x.example/cb', 'ftp://x.example/cb']) {
    const id = await registerClient(env, { redirect: odd });
    const r = await browser.fetch(authorizePath({ clientId: id, challenge, redirect: odd }));
    assert.equal(r.status, 400, odd);
    assert.match(await r.text(), /return address is not one this server can send you back to/);
  }
});

// ---- cheap refusals, open mode, the workspace list, service tokens -------------------------------------------
it('a junk bearer token costs no KV read: its shape and its person are checked in D1 first', async () => {
  const env = makeEnv();
  member(env, 'tech@example.com', 'viewer');
  const browser = new Browser(env);
  const { userId } = await signIn(env, browser, 'tech@example.com');
  const { access } = await connect(env, browser);
  const shaped = (id) => `${id}:${'A'.repeat(16)}:${'B'.repeat(32)}`;
  const junk = ['x:y:z', 'a:b:c', 'nope', ':::', shaped('not-a-uuid'), shaped(crypto.randomUUID()), `${userId}:short:${'B'.repeat(32)}`, `${userId}:${'A'.repeat(16)}:short`, `${access}:extra`];
  // A person who is disabled holds no usable token: refused before KV, with a well-formed token.
  exec(env, 'UPDATE users SET disabled_at = 1 WHERE id = ?', userId);
  junk.push(access);
  const reads = env.OAUTH_KV.reads;
  for (const path of ['/mcp', '/w/acme/mcp']) {
    for (const token of junk) {
      const r = await mcp(env, path, bearer(token), rpc('tools/list'));
      assert.equal(r.status, 401, `${path} ${token.slice(0, 24)}`);
      assert.equal((await r.json()).error, 'invalid_token');
    }
  }
  assert.equal(env.OAUTH_KV.reads, reads, 'not one KV read for any of them');
  exec(env, 'UPDATE users SET disabled_at = NULL WHERE id = ?', userId);
  // A well-formed token for a real person does cost the read (the library decides), and a wrong secret is a 401.
  const wrong = await mcp(env, '/mcp', bearer(shaped(userId)), rpc('tools/list'));
  assert.equal(wrong.status, 401);
  assert.equal(env.OAUTH_KV.reads - reads, 1);
  assert.equal((await mcp(env, '/mcp', bearer(access), rpc('tools/list'))).status, 200);
  // A token that is not even shaped like ours costs no D1 read either.
  const dark = { prepare: () => { throw new Error('D1 touched'); }, batch: () => { throw new Error('D1 touched'); } };
  for (const token of ['x:y:z', 'nope', shaped('not-a-uuid'), `${userId}:short:${'B'.repeat(32)}`]) {
    assert.equal((await mcp({ ...env, DB: dark }, '/mcp', bearer(token), rpc('tools/list'))).status, 401, token.slice(0, 20));
  }
  // If D1 cannot answer, the token is not judged: 503, and still no KV read.
  const trap = () => { throw new Error('D1 down'); };
  const before = env.OAUTH_KV.reads;
  const down = await mcp({ ...env, DB: { prepare: trap, batch: trap } }, '/mcp', bearer(access), rpc('tools/list'));
  assert.equal(down.status, 503);
  assert.equal(env.OAUTH_KV.reads, before);
});

it('an OAuth token is never open mode: with default emptied it is refused, and the call is not recorded as a recent caller', async () => {
  const env = makeEnv();
  member(env, 'tech@example.com', 'technician');
  member(env, 'tech@example.com', 'technician', 'acme'); // keeps them invited once default has no members
  const browser = new Browser(env);
  await signIn(env, browser, 'tech@example.com', { factor: true });
  const { access } = await connect(env, browser);
  const callers = () => sql(env, 'SELECT identity FROM callers').map((r) => r.identity);
  assert.equal((await toolText(await mcp(env, '/mcp', bearer(access), call('session_list')))).isError, false, 'works while default has members');

  // default loses every member. It is open again, and open mode admits an Access caller...
  exec(env, "DELETE FROM members WHERE workspace = 'default'");
  const viaAccess = await toolText(await mcp(env, '/mcp', { 'cf-access-jwt-assertion': await accessAs('anyone@example.com') }, call('session_list')));
  assert.equal(viaAccess.isError, false, 'open mode is real: an Access caller gets in');
  assert.deepEqual(callers(), ['anyone@example.com']);

  // ...but never an OAuth token. Both a view and a control permission are refused, and nothing is recorded.
  for (const tool of [call('session_list'), call('run', { session_id: SID, command: 'whoami' }), call('session_create')]) {
    const out = await toolText(await mcp(env, '/mcp', bearer(access), tool));
    assert.deepEqual(out, { isError: true, text: 'you are not a member of this team' }, tool);
  }
  assert.deepEqual(callers(), ['anyone@example.com'], 'the OAuth caller was not recorded in default\'s recent callers');
  assert.equal(env.calls.filter((c) => c.kind === 'session').length, 0, 'and no session was touched');
});

it('a code exchange in an instance that has not seen a new workspace refreshes its list and succeeds', async () => {
  const env = makeEnv();
  member(env, 'tech@example.com', 'viewer');
  const browser = new Browser(env);
  await signIn(env, browser, 'tech@example.com');
  // Two Worker instances share the database. The second reads its list before the workspace exists,
  // and keeps it (a long list lifetime), as an instance does for ten seconds.
  const second = createHandler('agent', null, {
    mailer,
    oauth: { OAuthAuthorizationServer: lib.OAuthAuthorizationServer, AuthorizationError: lib.AuthorizationError, CimdFetchError: lib.CimdFetchError },
    oauthTuning: { missGapMs: 0, listTtlMs: 3600_000 },
  });
  const viaSecond = (path, init) => second.fetch(new Request(`${PROD}${path}`, init), env);
  assert.equal((await viaSecond('/.well-known/oauth-authorization-server', { method: 'GET' })).status, 200);

  member(env, 'tech@example.com', 'viewer', 'newco');
  const clientId = await registerClient(env);
  const { verifier, challenge } = await pkce();
  const resource = resourceUrl(PROD, 'newco');
  const page = await openConsent(browser, authorizePath({ clientId, challenge, resource }));
  assert.equal(page.r.status, 200, 'the first instance knows newco');
  const code = new URL((await decide(browser, page, 'approve')).headers.get('location')).searchParams.get('code');

  const exchange = (extra = {}) => viaSecond('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, ...extra }) });
  // With the resource, and without it: both reach newco.
  const done = await exchange({ resource });
  assert.equal(done.status, 200, JSON.stringify(await done.clone().json()));
  const tokens = await done.json();
  assert.equal((await toolText(await mcp(env, '/w/newco/mcp', bearer(tokens.access_token), call('session_list')))).isError, false);

  // The refresh grant, from the instance with the old list, is the same.
  const third = createHandler('agent', null, {
    mailer,
    oauth: { OAuthAuthorizationServer: lib.OAuthAuthorizationServer, AuthorizationError: lib.AuthorizationError, CimdFetchError: lib.CimdFetchError },
    oauthTuning: { missGapMs: 0, listTtlMs: 3600_000 },
  });
  const stale = await third.fetch(new Request(`${PROD}/.well-known/oauth-authorization-server`), env);
  assert.equal(stale.status, 200);
  member(env, 'tech@example.com', 'viewer', 'later');
  const page2 = await openConsent(browser, authorizePath({ clientId, challenge, resource: resourceUrl(PROD, 'later') }));
  const code2 = new URL((await decide(browser, page2, 'approve')).headers.get('location')).searchParams.get('code');
  const noResource = await third.fetch(new Request(`${PROD}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: code2, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier }) }), env);
  assert.equal(noResource.status, 200, JSON.stringify(await noResource.clone().json()));

  // A request for a workspace that does not exist stays refused, and the refusal reads D1 at most once per gap.
  const gapped = createHandler('agent', null, {
    mailer,
    oauth: { OAuthAuthorizationServer: lib.OAuthAuthorizationServer, AuthorizationError: lib.AuthorizationError, CimdFetchError: lib.CimdFetchError },
    oauthTuning: { missGapMs: 60_000, listTtlMs: 3600_000 },
  });
  await gapped.fetch(new Request(`${PROD}/.well-known/oauth-authorization-server`), env);
  const slugReads = () => env.DB.seen.filter((q) => /FROM workspaces/.test(q.sql)).length;
  const base = slugReads();
  for (let i = 0; i < 5; i++) {
    const r = await gapped.fetch(new Request(`${PROD}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: 'a:b:c', redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: `${PROD}/w/ghost/mcp` }) }), env);
    assert.equal(r.status, 400);
  }
  assert.equal(slugReads(), base, 'inside the gap, refusals read no list');
});

it('a service token\'s Access JWT for ACCESS_MCP_AUD works on the MCP addresses only; unset, nothing changes', async () => {
  const MCP_AUD = 'oauth-test-mcp-aud';
  const env = makeEnv({ ACCESS_MCP_AUD: MCP_AUD });
  member(env, 'bot.access', 'technician');
  member(env, 'bot.access', 'technician', 'acme');
  member(env, 'root@example.com', 'admin');
  exec(env, "UPDATE members SET kind = 'service' WHERE identity = 'bot.access'");
  const botFor = (aud) => accessToken({ common_name: 'bot.access', sub: '', aud });
  const list = async (e, path, jwt) => (await mcp(e, path, { 'cf-access-jwt-assertion': jwt }, call('session_list')));

  for (const path of ['/mcp', '/w/acme/mcp']) {
    const r = await list(env, path, await botFor(MCP_AUD));
    assert.equal(r.status, 200, path);
    assert.equal((await toolText(r)).isError, false, path);
    assert.equal((await list(env, path, await botFor(AUD))).status, 200, `${path}: the main application's JWT still works`);
    assert.equal((await list(env, path, await botFor(['x', MCP_AUD]))).status, 200, `${path}: an aud list holding it`);
    assert.equal((await list(env, path, await botFor('someone-elses'))).status, 401, `${path}: another aud`);
  }
  // The team API accepts ACCESS_AUD only.
  const api = (e, jwt) => send(e, '/api/v1/w/default', { headers: { 'cf-access-jwt-assertion': jwt } });
  const viaMain = await api(env, await accessToken({ email: 'root@example.com' }));
  assert.equal(viaMain.status, 200, 'the main JWT is good on /api');
  const viaMcp = await api(env, await accessToken({ email: 'root@example.com', aud: MCP_AUD }));
  const viaWrong = await api(env, await accessToken({ email: 'root@example.com', aud: 'someone-elses' }));
  assert.notEqual(viaMcp.status, 200, 'the MCP application\'s JWT is refused on /api');
  assert.equal(viaMcp.status, viaWrong.status, 'exactly as a JWT for any other application is');
  assert.equal((await send(env, '/api/v1/w', { headers: { 'cf-access-jwt-assertion': await accessToken({ email: 'root@example.com', aud: MCP_AUD }) } })).status, viaWrong.status);

  // Unset or empty: the extra audience means nothing.
  for (const unset of [undefined, '', '   ']) {
    const plain = makeEnv({ ACCESS_MCP_AUD: unset });
    member(plain, 'bot.access', 'technician');
    exec(plain, "UPDATE members SET kind = 'service' WHERE identity = 'bot.access'");
    assert.equal((await list(plain, '/mcp', await botFor(MCP_AUD))).status, 401, `unset as ${JSON.stringify(unset)}`);
    assert.equal((await list(plain, '/mcp', await botFor(''))).status, 401, 'an empty aud is not an accepted one');
    assert.equal((await list(plain, '/mcp', await botFor(AUD))).status, 200);
  }
});

// ---- the 2b follow-ups ---------------------------------------------------------------------------------------------------------------
it('2b follow-up: a sign-in counts its factor only while the person still has that authenticator', async () => {
  const env = makeEnv();
  member(env, 'tech@example.com', 'technician');
  const browser = new Browser(env);
  const { userId, store } = await signIn(env, browser, 'tech@example.com', { factor: true });
  const token = browser.jar.get('__Host-smcp');
  const read = () => store.sessionForToken(token, { idleMs: 12 * 3600_000, maxMs: 14 * 86400_000 });
  assert.ok((await read()).factorAt, 'counts while the authenticator is there');
  // An operator resets the authenticator: the open sign-in loses its factor.
  exec(env, 'DELETE FROM user_factors WHERE user_id = ?', userId);
  assert.equal((await read()).factorAt, null);
  // The person enrols again later: the older sign-in still does not count.
  advance(60_000);
  try {
    await store.saveFactor(userId, new Uint8Array(20).fill(5), 1, { replace: false });
    assert.equal((await read()).factorAt, null, 'a code passed before the new authenticator is not a code from it');
    // A sign-in that passes a code from the new authenticator does.
    await store.markFactor(await sha256Hex(token));
    assert.ok((await read()).factorAt);
  } finally {
    resetClock();
  }
  // And the consent page treats the two the same way.
  exec(env, 'DELETE FROM user_factors');
  const clientId = await registerClient(env);
  const { challenge } = await pkce();
  const r = await browser.fetch(authorizePath({ clientId, challenge }));
  assert.equal(r.status, 303);
  assert.match(r.headers.get('location'), /^\/auth\/factor/);
});

it('2b follow-up: old login_sessions rows are deleted when a new sign-in is made', async () => {
  const env = makeEnv();
  member(env, 'tech@example.com', 'viewer');
  const store = accountStore(env.DB, { secret: SECRET });
  const { user } = await store.userForEmail('tech@example.com', async () => true);
  const day = 86400_000;
  const now = Date.now();
  const row = (id, created, expires, revoked) => exec(env, 'INSERT INTO login_sessions(id_hash, user_id, created_at, last_seen, expires_at, factor_at, revoked_at) VALUES (?, ?, ?, ?, ?, NULL, ?)', id, user.id, created, created, expires, revoked);
  row('expired-long-ago', now - 60 * day, now - 40 * day, null);
  row('expired-recently', now - 20 * day, now - 5 * day, null);
  row('revoked-long-ago', now - 60 * day, now + 5 * day, now - 31 * day);
  row('revoked-recently', now - 20 * day, now + 5 * day, now - 2 * day);
  row('live', now - day, now + 5 * day, null);
  await store.createSession(user.id, { maxMs: 14 * day });
  const left = sql(env, 'SELECT id_hash FROM login_sessions ORDER BY id_hash').map((r) => r.id_hash).filter((id) => !/^[0-9a-f]{64}$/.test(id));
  assert.deepEqual(left, ['expired-recently', 'live', 'revoked-recently']);
  assert.equal(sql(env, 'SELECT COUNT(*) AS n FROM login_sessions')[0].n, 4, 'three kept and the new one');
});

it('2b follow-up: a short idle limit cannot sign out someone who is using the site', async () => {
  const env = makeEnv();
  member(env, 'tech@example.com', 'viewer');
  const store = accountStore(env.DB, { secret: SECRET });
  const { user } = await store.userForEmail('tech@example.com', async () => true);
  const token = await store.createSession(user.id, { maxMs: 14 * 86400_000 });
  const tiny = { idleMs: 1000, maxMs: 14 * 86400_000 }; // SIGNIN_IDLE_HOURS so small it is under the write interval
  try {
    // A request every 4 minutes keeps it alive, though last_seen is written at most every 5.
    for (let i = 0; i < 6; i++) {
      advance(4 * 60_000);
      assert.ok(await store.sessionForToken(token, tiny), `still signed in after ${(i + 1) * 4} minutes of use`);
    }
    // A real gap still ends it.
    advance(30 * 60_000);
    assert.equal(await store.sessionForToken(token, tiny), null);
  } finally {
    resetClock();
  }
  // Through the router, with the setting the operator would write.
  const browser = new Browser(env);
  await signIn(env, browser, 'tech@example.com');
  const tinyEnv = { ...env, SIGNIN_IDLE_HOURS: '0.001' };
  const a = new Browser(tinyEnv);
  a.jar = browser.jar;
  try {
    advance(4 * 60_000);
    assert.equal((await a.fetch('/account')).status, 200);
    advance(4 * 60_000);
    assert.equal((await a.fetch('/account')).status, 200);
  } finally {
    resetClock();
  }
});

it('a long authorize request is kept through sign-in up to a limit, and safeNext keeps its 300 limit elsewhere', async () => {
  const env = makeEnv();
  member(env, 'tech@example.com', 'viewer');
  const browser = new Browser(env);
  const clientId = await registerClient(env);
  const { challenge } = await pkce();
  // A long state, as some clients send, still survives the trip.
  const long = authorizePath({ clientId, challenge, state: 's'.repeat(900) });
  assert.ok(long.length > 1000 && long.length < 1800);
  const r = await browser.fetch(long);
  assert.equal(r.status, 303);
  assert.equal(new URL(r.headers.get('location'), PROD).searchParams.get('next'), long);
  const page = await (await browser.fetch(r.headers.get('location'))).text();
  assert.equal(field(page, 'next'), long);
  // Past the limit the person is told, instead of landing on the wrong page after sign-in.
  const tooLong = authorizePath({ clientId, challenge, state: 's'.repeat(1900) });
  const refused = await browser.fetch(tooLong);
  assert.equal(refused.status, 400);
  assert.match(await refused.text(), /too long/);
  // Other return paths are still capped at 300.
  const { safeNext } = await import('../src/paths.js');
  assert.equal(safeNext(`/account?x=${'a'.repeat(400)}`), '/account');
  assert.equal(safeNext(`/oauth/authorize?x=${'a'.repeat(400)}`), `/oauth/authorize?x=${'a'.repeat(400)}`);
  assert.equal(safeNext(`/oauth/authorize?x=${'a'.repeat(1900)}`), '/account');
  assert.equal(safeNext(`/x/../oauth/authorize?x=${'a'.repeat(400)}`), '/account', 'only a path that starts as an authorize request gets the larger limit');
  assert.equal(safeNext('//evil.example/oauth/authorize?x=1'), '/account');
});
