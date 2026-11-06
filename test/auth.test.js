// Technician sign-in, end to end through the real router (src/app.js) on the
// D1 stand-in. Providers are faked: id_tokens are signed with locally generated
// RSA keys and the JWKS, token and mail endpoints are answered by `idp.fetch`,
// so nothing touches the network. A Browser keeps cookies like a real one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openD1 } from './d1-fake.js';
import { createHandler } from '../src/app.js';
import { importRsaJwk } from '../src/jwt.js';
import { GOOGLE_JWKS_URL, GOOGLE_TOKEN_URL, MICROSOFT_JWKS_URL, identityFromIdToken } from '../src/oidc.js';
import { RESEND_URL } from '../src/mail/resend.js';
import { mailerFromEnv } from '../src/mail/index.js';
import { base32Decode, base32Encode, bytesToB64url } from '../src/crypto.js';
import { hotp, matchStep, otpauthUri, totp } from '../src/totp.js';
import { authorizeSignIn, factorRequired, safeNext } from '../src/auth.js';
import { accountStore } from '../src/accounts.js';
import { teamFromEnv } from '../src/workspace.js';

const PROD = 'https://support.example.com';
const LOCAL = 'http://127.0.0.1:8787';
const SECRET = 'test-only-auth-secret-0123456789abcdef-xyz';
const GOOGLE_ID = 'google-client-id.example.com';
const MS_ID = '11111111-2222-3333-4444-555555555555';
const TENANT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OTHER_TENANT = '99999999-8888-7777-6666-555555555555';
const OID = '0a0a0a0a-1b1b-2c2c-3d3d-4e4e4e4e4e4e';

// ---- keys, tokens and a fake network -------------------------------------------
async function rsa(kid) {
  const kp = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = { ...(await crypto.subtle.exportKey('jwk', kp.publicKey)), kid };
  await importRsaJwk(jwk, crypto.subtle);
  return { priv: kp.privateKey, jwk, kid };
}
const googleKey = await rsa('g1');
const msKey = await rsa('m1');
const rogueKey = await rsa('g1'); // same kid as Google's, different key
const rogueMsKey = await rsa('m1'); // same kid as Microsoft's, different key

const enc = (o) => bytesToB64url(new TextEncoder().encode(JSON.stringify(o)));
async function signToken(key, claims, header = {}) {
  const input = `${enc({ alg: 'RS256', kid: key.kid, typ: 'JWT', ...header })}.${enc(claims)}`;
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key.priv, new TextEncoder().encode(input)));
  return `${input}.${bytesToB64url(sig)}`;
}
const now = () => Math.floor(Date.now() / 1000);

const idp = {
  tokens: { google: null, microsoft: null },
  calls: [],
  fetch: async (url, init) => {
    url = String(url);
    idp.calls.push({ url, init });
    if (url === GOOGLE_JWKS_URL) return Response.json({ keys: [googleKey.jwk] });
    if (url === MICROSOFT_JWKS_URL) return Response.json({ keys: [msKey.jwk] });
    if (url === GOOGLE_TOKEN_URL) return Response.json({ id_token: idp.tokens.google });
    if (/^https:\/\/login\.microsoftonline\.com\/[^/]+\/oauth2\/v2\.0\/token$/.test(url)) return Response.json({ id_token: idp.tokens.microsoft });
    return new Response('no network in tests', { status: 599 });
  },
};

const mailer = { sent: [], async send(m) { this.sent.push(m); } };

const handler = createHandler('agent', null, { fetch: idp.fetch, mailer });
const trap = () => { throw new Error('Durable Object touched'); };

function makeEnv(extra = {}) {
  return {
    ACCESS_TEAM_DOMAIN: 'example-team.cloudflareaccess.com', ACCESS_AUD: 'aud',
    SESSION: { idFromName: trap, idFromString: trap, get: trap }, REGISTRY: { idFromName: trap, get: trap },
    DB: openD1(), AUTH_SECRET: SECRET, PUBLIC_ORIGIN: PROD, DEPLOYMENT_ADMINS: 'root@example.com',
    GOOGLE_CLIENT_ID: GOOGLE_ID, GOOGLE_CLIENT_SECRET: 'google-secret',
    MICROSOFT_CLIENT_ID: MS_ID, MICROSOFT_CLIENT_SECRET: 'ms-secret',
    ...extra,
  };
}

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
  has(name) { return this.jar.has(name); }
}

const field = (html, name) => (new RegExp(`name="${name}" value="([^"]*)"`).exec(html) || [])[1];
const sql = (env, text, ...params) => env.DB.sqlite.prepare(text).all(...params);
const exec = (env, text, ...params) => env.DB.sqlite.prepare(text).run(...params);
const count = (env, table) => sql(env, `SELECT COUNT(*) AS n FROM ${table}`)[0].n;
const member = (env, identity, role = 'technician', workspace = 'default') => {
  if (workspace !== 'default') exec(env, 'INSERT OR IGNORE INTO workspaces(slug, name, created_by, created_at) VALUES (?, ?, ?, 1)', workspace, `Team ${workspace}`, 'root@example.com');
  exec(env, "INSERT INTO members(workspace, identity, kind, name, role_id, added_at, added_by) VALUES (?, ?, 'person', NULL, ?, 1, 'test')", workspace, identity, role);
};

// ---- helpers for the three sign-in routes ---------------------------------------------
async function oidc(browser, provider, claims = {}, { key, header, next = '/account', state, tamper } = {}) {
  const start = await browser.fetch(`/auth/${provider}?next=${encodeURIComponent(next)}`);
  assert.equal(start.status, 302);
  // The provider gets no Referer from the hop that sends the person there.
  assert.equal(start.headers.get('referrer-policy'), 'same-origin');
  const loc = new URL(start.headers.get('location'));
  const nonce = loc.searchParams.get('nonce');
  const base = provider === 'google'
    ? { iss: 'https://accounts.google.com', aud: GOOGLE_ID, sub: 'g-sub-1', email: 'tech@example.com', email_verified: true }
    : { iss: `https://login.microsoftonline.com/${TENANT}/v2.0`, aud: MS_ID, tid: TENANT, oid: OID, email: 'tech@example.com', xms_edov: true };
  idp.tokens[provider] = await signToken(key || (provider === 'google' ? googleKey : msKey),
    { ...base, nonce, iat: now(), exp: now() + 600, ...claims }, header);
  if (tamper) tamper(browser);
  const cb = await browser.fetch(`/auth/${provider}/callback?code=abc&state=${encodeURIComponent(state ?? loc.searchParams.get('state'))}`);
  return { start, loc, cb };
}

async function emailSignIn(browser, email, { next } = {}) {
  const page = await (await browser.fetch('/auth/signin')).text();
  mailer.sent.length = 0;
  const asked = await browser.fetch('/auth/email', { method: 'POST', form: { csrf: field(page, 'csrf'), email, ...(next ? { next } : {}) } });
  const link = mailer.sent.length ? /https:\/\/[^\s"]+/.exec(mailer.sent[0].text)[0] : null;
  return { asked, link };
}
async function followLink(browser, link) {
  const u = new URL(link);
  const confirm = await browser.fetch(u.pathname + u.search);
  const html = await confirm.text();
  const done = await browser.fetch('/auth/email/confirm', { method: 'POST', form: { csrf: field(html, 'csrf'), t: field(html, 't'), next: field(html, 'next') } });
  return { confirm, html, done };
}
async function fullEmailSignIn(browser, email) {
  const { link } = await emailSignIn(browser, email);
  assert.ok(link, 'a link was mailed');
  const { done } = await followLink(browser, link);
  assert.equal(done.status, 303, 'signed in');
  return done;
}

// ---- configuration and headers ------------------------------------------------------------
test('with no AUTH_SECRET every /auth and /account route answers 503, without touching storage', async () => {
  const env = makeEnv({ AUTH_SECRET: undefined, DB: undefined });
  for (const path of ['/auth/signin', '/account', '/auth/google', '/auth/google/callback?code=a&state=b', '/auth/factor', '/auth/email', '/auth/nope']) {
    const r = await new Browser(env).fetch(path);
    assert.equal(r.status, 503, path);
    assert.match(await r.text(), /AUTH_SECRET/);
  }
  const short = await new Browser(makeEnv({ AUTH_SECRET: 'too short' })).fetch('/auth/signin');
  assert.equal(short.status, 503);
  const post = await new Browser(env).fetch('/auth/signout', { method: 'POST', form: {} });
  assert.equal(post.status, 503);
});

test('on a real host without PUBLIC_ORIGIN, sign-in answers 503; a loopback host works without it', async () => {
  const env = makeEnv({ PUBLIC_ORIGIN: '' });
  const r = await new Browser(env).fetch('/auth/signin');
  assert.equal(r.status, 503);
  assert.match(await r.text(), /PUBLIC_ORIGIN/);
  assert.equal((await new Browser(env, LOCAL).fetch('/auth/signin')).status, 200);
  // PUBLIC_ORIGIN must be https (loopback excepted) and must be the host asked.
  assert.equal((await new Browser(makeEnv({ PUBLIC_ORIGIN: 'http://support.example.com' })).fetch('/auth/signin')).status, 503);
  assert.equal((await new Browser(makeEnv({ PUBLIC_ORIGIN: 'https://support.example.com/path' })).fetch('/auth/signin')).status, 503);
  assert.equal((await new Browser(makeEnv({ PUBLIC_ORIGIN: 'https://other.example.com' })).fetch('/auth/signin')).status, 503);
  assert.equal((await new Browser(makeEnv({ PUBLIC_ORIGIN: 'not a url' })).fetch('/auth/signin')).status, 503);
});

test('every page carries the security headers, loads nothing external and has no script', async () => {
  const env = makeEnv();
  member(env, 'tech@example.com');
  const b = new Browser(env);
  const pages = [await b.fetch('/auth/signin'), await b.fetch('/auth/nope'), await b.fetch('/auth/email/confirm?t=bad')];
  await fullEmailSignIn(b, 'tech@example.com');
  pages.push(await b.fetch('/account'), await b.fetch('/auth/factor'));
  for (const r of pages) {
    const csp = r.headers.get('content-security-policy');
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /base-uri 'none'/);
    assert.match(csp, /form-action 'self'/);
    assert.doesNotMatch(csp, /script-src/);
    // Chrome sends `Origin: null` on a form post under no-referrer, which the
    // Origin check refuses, so a real button press needs same-origin.
    assert.equal(r.headers.get('referrer-policy'), 'same-origin');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const html = await r.text();
    assert.doesNotMatch(html, /<script|<link|<img|src=|@import|url\(/i);
    assert.doesNotMatch(html, /[\u2014]/, 'no em dash');
  }
  // The sign-in page may send a form to the providers, and only that page.
  const signin = await new Browser(env).fetch('/auth/signin');
  assert.match(signin.headers.get('content-security-policy'), /accounts\.google\.com/);
  assert.doesNotMatch(pages[3].headers.get('content-security-policy'), /google/);
});

test('the sign-in page shows only the methods that are configured', async () => {
  const both = await (await new Browser(makeEnv()).fetch('/auth/signin')).text();
  assert.match(both, /Continue with Google/);
  assert.match(both, /Continue with Microsoft/);
  assert.match(both, /Email me a sign-in link/);
  const bare = makeEnv({ GOOGLE_CLIENT_ID: '', MICROSOFT_CLIENT_SECRET: '' });
  const noMail = createHandler('agent', null, { fetch: idp.fetch, mailer: null });
  const html = await (await new Browser(bare, PROD, noMail).fetch('/auth/signin')).text();
  assert.doesNotMatch(html, /Google|Microsoft|sign-in link/);
  assert.match(html, /No sign-in method is set up/);
  // A method that is not configured is a 404, not an error.
  assert.equal((await new Browser(bare, PROD, noMail).fetch('/auth/google')).status, 404);
  assert.equal((await new Browser(bare, PROD, noMail).fetch('/auth/microsoft/callback?code=a&state=b')).status, 404);
});

test('sign-in and account routes never touch a Durable Object, and /mcp refusals are unchanged', async () => {
  const env = makeEnv();
  const b = new Browser(env);
  for (const path of ['/auth/signin', '/account', '/auth/factor']) assert.ok([200, 303].includes((await b.fetch(path)).status), path);
  const rpc = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const mcp = (init) => handler.fetch(new Request(`${PROD}/mcp`, init), env);
  assert.equal((await mcp({ method: 'POST', headers: { 'content-type': 'application/json', origin: PROD }, body: rpc })).status, 403);
  assert.equal((await mcp({ method: 'GET' })).status, 405);
  assert.equal((await mcp({ method: 'POST', headers: { 'content-type': 'text/plain' }, body: rpc })).status, 415);
});

// ---- Google and Microsoft -----------------------------------------------------------------------
test('Google: an invited person signs in with code, PKCE, state and nonce, and is linked by sub', async () => {
  const env = makeEnv();
  member(env, 'tech@example.com');
  const b = new Browser(env);
  const { start, loc, cb } = await oidc(b, 'google');
  assert.equal(loc.origin + loc.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(loc.searchParams.get('client_id'), GOOGLE_ID);
  assert.equal(loc.searchParams.get('redirect_uri'), `${PROD}/auth/google/callback`);
  assert.equal(loc.searchParams.get('response_type'), 'code');
  assert.equal(loc.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(loc.searchParams.get('state') && loc.searchParams.get('nonce'));
  const setCookie = start.headers.get('set-cookie');
  assert.match(setCookie, /^__Host-smcp-oidc=/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Max-Age=600/);
  assert.ok(!setCookie.includes(loc.searchParams.get('state')), 'the state is sealed, not in the clear');
  assert.equal(cb.status, 303);
  assert.equal(cb.headers.get('location'), '/account');
  assert.ok(b.has('__Host-smcp'), 'signed in');
  assert.ok(!b.has('__Host-smcp-oidc'), 'the round trip cookie is cleared');

  // The server asked the provider for the token with the secret and the verifier
  // whose SHA-256 is the challenge it sent.
  const exchange = idp.calls.filter((c) => c.url === GOOGLE_TOKEN_URL).at(-1);
  const sent = new URLSearchParams(exchange.init.body);
  assert.equal(sent.get('client_secret'), 'google-secret');
  assert.equal(sent.get('grant_type'), 'authorization_code');
  assert.equal(sent.get('code'), 'abc');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sent.get('code_verifier'))));
  assert.equal(bytesToB64url(digest), loc.searchParams.get('code_challenge'));

  const link = sql(env, 'SELECT * FROM user_identities')[0];
  assert.equal(link.provider, 'google');
  assert.equal(link.subject, 'g-sub-1');
  const account = await (await b.fetch('/account')).text();
  assert.match(account, /tech@example\.com/);
});

test('Google: tokens with a bad signature, issuer, audience, nonce, expiry or an unverified email are refused', async () => {
  const cases = {
    'signature from another key': [{}, { key: rogueKey }],
    'wrong issuer': [{ iss: 'https://evil.example.com' }],
    'issuer without the scheme is allowed' : null,
    'wrong audience': [{ aud: 'someone-else' }],
    'wrong nonce': [{ nonce: 'not-the-nonce' }],
    'expired': [{ exp: now() - 600, iat: now() - 1200 }],
    'issued in the future': [{ iat: now() + 3600, exp: now() + 4200 }],
    'email not verified': [{ email_verified: false }],
    'email_verified as text': [{ email_verified: 'true' }],
    'no email_verified claim': [{ email_verified: undefined }],
    'no email': [{ email: undefined }],
    'no subject': [{ sub: undefined }],
    'wrong algorithm': [{}, { header: { alg: 'HS256' } }],
  };
  for (const [name, args] of Object.entries(cases)) {
    if (!args) continue;
    const env = makeEnv();
    member(env, 'tech@example.com');
    const b = new Browser(env);
    const { cb } = await oidc(b, 'google', args[0], args[1]);
    assert.ok([400, 403].includes(cb.status), `${name}: ${cb.status}`);
    assert.ok(!b.has('__Host-smcp'), `${name}: no sign-in`);
    assert.equal(count(env, 'login_sessions'), 0, name);
    assert.equal(count(env, 'user_identities'), 0, name);
    assert.equal(count(env, 'users'), 0, name);
  }
  // The other spelling of Google's issuer is accepted.
  const env = makeEnv();
  member(env, 'tech@example.com');
  const { cb } = await oidc(new Browser(env), 'google', { iss: 'accounts.google.com' });
  assert.equal(cb.status, 303);
});

test('Microsoft: the issuer is built from tid, and the email must be verified or the tenant trusted', async () => {
  const env = makeEnv();
  member(env, 'tech@example.com');
  const b = new Browser(env);
  const { start, cb } = await oidc(b, 'microsoft');
  assert.match(new URL(start.headers.get('location')).pathname, /^\/common\/oauth2\/v2\.0\/authorize$/);
  assert.equal(cb.status, 303);
  assert.equal(sql(env, 'SELECT subject FROM user_identities')[0].subject, `${TENANT}:${OID}`);

  const refused = {
    'issuer of another tenant': { iss: `https://login.microsoftonline.com/${OTHER_TENANT}/v2.0` },
    'issuer without a tenant': { iss: 'https://login.microsoftonline.com/v2.0' },
    'wrong audience': { aud: 'someone-else' },
    'wrong nonce': { nonce: 'nope' },
    'expired': { exp: now() - 600, iat: now() - 1200 },
    'xms_edov missing': { xms_edov: undefined },
    'xms_edov false': { xms_edov: false },
    'no tid': { tid: undefined },
    'no oid': { oid: undefined },
    'no email': { email: undefined },
  };
  for (const [name, claims] of Object.entries(refused)) {
    const e = makeEnv();
    member(e, 'tech@example.com');
    const { cb: r } = await oidc(new Browser(e), 'microsoft', claims);
    assert.ok([400, 403].includes(r.status), `${name}: ${r.status}`);
    assert.equal(count(e, 'login_sessions'), 0, name);
  }
  const rogue = makeEnv();
  member(rogue, 'tech@example.com');
  assert.equal((await oidc(new Browser(rogue), 'microsoft', {}, { key: rogueMsKey })).cb.status, 403);
  assert.equal(count(rogue, 'login_sessions'), 0);
});

test('Microsoft: MICROSOFT_TENANTS limits tenants, and a listed tenant needs no xms_edov', async () => {
  const listed = makeEnv({ MICROSOFT_TENANTS: `${TENANT.toUpperCase()}, ${OTHER_TENANT}` });
  member(listed, 'tech@example.com');
  const one = await oidc(new Browser(listed), 'microsoft', { xms_edov: undefined });
  assert.match(new URL(one.start.headers.get('location')).pathname, /^\/organizations\//, 'several tenants use organizations');
  assert.equal(one.cb.status, 303, 'a trusted tenant is enough');

  const single = makeEnv({ MICROSOFT_TENANTS: TENANT });
  member(single, 'tech@example.com');
  const s = await oidc(new Browser(single), 'microsoft');
  assert.match(new URL(s.start.headers.get('location')).pathname, new RegExp(`^/${TENANT}/`));

  // A tenant that is not listed is refused even with a verified domain.
  const other = makeEnv({ MICROSOFT_TENANTS: OTHER_TENANT });
  member(other, 'tech@example.com');
  const bad = await oidc(new Browser(other), 'microsoft', { tid: TENANT });
  assert.equal(bad.cb.status, 403);
  assert.equal(count(other, 'login_sessions'), 0);
});

test('an uninvited person cannot sign in, and nothing is stored for them', async () => {
  const env = makeEnv();
  member(env, 'someone-else@example.com');
  const b = new Browser(env);
  const { cb } = await oidc(b, 'google', { email: 'stranger@example.com', sub: 'stranger' });
  assert.equal(cb.status, 403);
  const html = await cb.text();
  assert.match(html, /can.t sign in here/);
  assert.ok(!b.has('__Host-smcp'));
  for (const t of ['users', 'user_identities', 'login_sessions', 'email_links', 'user_factors']) assert.equal(count(env, t), 0, t);
  // The same answer for Microsoft.
  const ms = await oidc(new Browser(env), 'microsoft', { email: 'stranger@example.com' });
  assert.equal(ms.cb.status, 403);
  assert.equal(await ms.cb.text(), html);
});

test('DEPLOYMENT_ADMINS may sign in without being in a workspace', async () => {
  const env = makeEnv();
  const b = new Browser(env);
  const { cb } = await oidc(b, 'google', { email: 'Root@Example.com', sub: 'root-sub' });
  assert.equal(cb.status, 303);
  assert.equal(sql(env, 'SELECT email FROM users')[0].email, 'root@example.com');
  const html = await (await b.fetch('/account')).text();
  assert.match(html, /Deployment admin/);
  assert.match(html, /You are not in a workspace yet/);
  assert.match(html, /you need an authenticator/);
});

test('linking: a known identity stays with its person, and an unknown one joins the person with that email', async () => {
  const env = makeEnv();
  member(env, 'tech@example.com');
  member(env, 'new-address@example.com');
  await oidc(new Browser(env), 'google', { sub: 'g-sub-1', email: 'tech@example.com' });
  const user = sql(env, 'SELECT id FROM users WHERE email = ?', 'tech@example.com')[0];

  // The same Google account now reports another address that is also invited.
  // It still signs in as the person it was first linked to.
  const b = new Browser(env);
  const { cb } = await oidc(b, 'google', { sub: 'g-sub-1', email: 'new-address@example.com' });
  assert.equal(cb.status, 303);
  assert.equal(count(env, 'users'), 1, 'no second person');
  assert.match(await (await b.fetch('/account')).text(), /tech@example\.com/);
  assert.equal(sql(env, 'SELECT user_id FROM user_identities WHERE subject = ?', 'g-sub-1')[0].user_id, user.id);

  // A different Google account with the first person's verified address links to them.
  const c = new Browser(env);
  assert.equal((await oidc(c, 'google', { sub: 'g-sub-2', email: 'tech@example.com' })).cb.status, 303);
  assert.equal(count(env, 'users'), 1);
  assert.equal(sql(env, 'SELECT user_id FROM user_identities WHERE subject = ?', 'g-sub-2')[0].user_id, user.id);
  assert.equal(count(env, 'user_identities'), 2);

  // A known identity whose person is no longer invited cannot sign in.
  exec(env, 'DELETE FROM members WHERE identity = ?', 'tech@example.com');
  const d = new Browser(env);
  assert.equal((await oidc(d, 'google', { sub: 'g-sub-1' })).cb.status, 403);
  assert.ok(!d.has('__Host-smcp'));
});

test('a disabled person cannot sign in, and their open sign-ins end', async () => {
  const env = makeEnv();
  member(env, 'tech@example.com');
  const b = new Browser(env);
  await oidc(b, 'google');
  assert.equal((await b.fetch('/account')).status, 200);
  exec(env, 'UPDATE users SET disabled_at = 1');
  assert.equal((await b.fetch('/account')).status, 303);
  assert.equal((await oidc(new Browser(env), 'google')).cb.status, 403);
});

test('round trip: a tampered, missing, expired or mismatched cookie, or a wrong state, is refused', async () => {
  const env = makeEnv();
  member(env, 'tech@example.com');
  const oidcName = '__Host-smcp-oidc';
  const flip = (v) => v.slice(0, -4) + (v.endsWith('AAAA') ? 'BBBB' : 'AAAA');
  const cases = {
    'tampered cookie': { tamper: (b) => b.jar.set(oidcName, flip(b.jar.get(oidcName))) },
    'no cookie': { tamper: (b) => b.jar.delete(oidcName) },
    'garbage cookie': { tamper: (b) => b.jar.set(oidcName, 'x') },
    'wrong state': { state: 'another-state' },
    'empty state': { state: '' },
  };
  for (const [name, opts] of Object.entries(cases)) {
    const b = new Browser(env);
    const { cb } = await oidc(b, 'google', {}, opts);
    assert.equal(cb.status, 400, name);
    assert.ok(!b.has('__Host-smcp'), name);
  }
  // A Google round trip cannot finish a Microsoft one.
  const b = new Browser(env);
  const g = await b.fetch('/auth/google');
  const gState = new URL(g.headers.get('location')).searchParams.get('state');
  await b.fetch('/auth/microsoft'); // overwritten by the Microsoft cookie
  b.jar.set(oidcName, g.headers.get('set-cookie').split(';')[0].split('=').slice(1).join('='));
  assert.equal((await b.fetch(`/auth/microsoft/callback?code=a&state=${gState}`)).status, 400);
  // The provider reporting an error.
  const e = new Browser(env);
  const start = await e.fetch('/auth/google');
  const st = new URL(start.headers.get('location')).searchParams.get('state');
  assert.equal((await e.fetch(`/auth/google/callback?error=access_denied&state=${st}`)).status, 400);
  // A round trip cookie expired by the clock.
  const f = new Browser(env);
  const realNow = Date.now;
  await f.fetch('/auth/google');
  Date.now = () => realNow() + 11 * 60_000;
  try {
    assert.equal((await f.fetch('/auth/google/callback?code=a&state=x')).status, 400);
  } finally { Date.now = realNow; }
});

test('the return path is a path on this site and nothing else', async () => {
  for (const bad of ['https://evil.example/x', '//evil.example', '/\\evil.example', 'javascript:alert(1)', 'account', '', '/a\nb', undefined, null, `/${'a'.repeat(400)}`,
    // The URL parser folds these into //evil.example, so the raw string looks fine.
    '/..//evil.example/phish', '/.//evil.example', '/%2e%2e//evil.example', '/a/../..//evil.example', '/%2E%2E//evil.example',
    '/\\evil.example', '/%5c%5cevil.example', '/%5Cevil.example', '/%2f%2fevil.example', 'https://evil.example', '//evil.example', '/ x', '/a\tb']) {
    assert.equal(safeNext(bad), '/account', String(bad));
  }
  assert.equal(safeNext('/account'), '/account');
  assert.equal(safeNext('/auth/factor?next=%2Faccount'), '/auth/factor?next=%2Faccount');
  const env = makeEnv();
  member(env, 'tech@example.com');
  const { cb } = await oidc(new Browser(env), 'google', {}, { next: 'https://evil.example/steal' });
  assert.equal(cb.headers.get('location'), '/account');
  const ok = await oidc(new Browser(env), 'google', { sub: 'g2' }, { next: '/auth/factor?x=1' });
  assert.equal(ok.cb.headers.get('location'), '/auth/factor?x=1');
});

test('a return path that folds into another host is never emitted: redirects, links and form fields', async () => {
  const env = makeEnv();
  member(env, 'tech@example.com', 'viewer');
  const evil = ['/..//evil.example/phish', '/.//evil.example', '/%2e%2e//evil.example'];
  const offSite = (loc) => loc !== null && /^(\/\/|\/\\|[a-z][a-z0-9+.-]*:)/i.test(loc);
  for (const next of evil) {
    exec(env, 'DELETE FROM email_links'); // the hourly limit is not under test here
    // Signed in already: the sign-in page redirects to next.
    const b = new Browser(env);
    await fullEmailSignIn(b, 'tech@example.com');
    const again = await b.fetch(`/auth/signin?next=${encodeURIComponent(next)}`);
    assert.equal(again.status, 303);
    assert.equal(again.headers.get('location'), '/account', next);
    // Through Google.
    const g = await oidc(new Browser(env), 'google', {}, { next });
    assert.equal(g.cb.headers.get('location'), '/account', next);
    // Through an email link, whose next travels in the mail and in the page.
    const e = new Browser(env);
    const { link } = await emailSignIn(e, 'tech@example.com', { next });
    assert.ok(!link.includes('next='), 'no next in the mailed link');
    const { html, done } = await followLink(e, link);
    assert.equal(field(html, 'next'), '/account');
    assert.equal(done.headers.get('location'), '/account', next);
    // A forged next in the confirm form and the factor pages.
    const f = new Browser(env);
    const { link: l2 } = await emailSignIn(f, 'tech@example.com');
    const u = new URL(l2);
    const page = await (await f.fetch(u.pathname + u.search + `&next=${encodeURIComponent(next)}`)).text();
    assert.equal(field(page, 'next'), '/account');
    const forged = await f.fetch('/auth/email/confirm', { method: 'POST', form: { csrf: field(page, 'csrf'), t: field(page, 't'), next } });
    assert.equal(forged.headers.get('location'), '/account');
    const en = await f.fetch(`/auth/factor?next=${encodeURIComponent(next)}`);
    const enHtml = await en.text();
    assert.equal(field(enHtml, 'next'), '/account');
    // Enrolment: the recovery-codes link.
    const secretText = /class="secret"><code>([A-Z2-7 ]+)<\/code>/.exec(enHtml)[1].replace(/ /g, '');
    const code = await totp(base32Decode(secretText), Date.now());
    const done2 = await f.fetch('/auth/factor', { method: 'POST', form: { csrf: field(enHtml, 'csrf'), action: 'enrol', sealed: field(enHtml, 'sealed'), next, code } });
    const codesHtml = await done2.text();
    assert.match(codesHtml, /href="\/account">I have saved them/, next);
    exec(env, 'DELETE FROM user_factors');
    // The factor page for a person who has passed a code redirects only on site.
    const { secretBytes: sb } = await enrol(env, f);
    const via = await f.fetch(`/auth/factor?next=${encodeURIComponent(next)}`);
    assert.ok(!offSite(via.headers.get('location')), String(via.headers.get('location')));
    exec(env, 'DELETE FROM user_factors');
    assert.ok(sb.length === 20);
  }
});

// ---- email links ---------------------------------------------------------------------------------------
test('email link: works once, only by POST, only in the browser that asked', async () => {
  const env = makeEnv();
  member(env, 'tech@example.com');
  const b = new Browser(env);
  const { asked, link } = await emailSignIn(b, 'Tech@Example.com');
  assert.equal(asked.status, 200);
  assert.ok(link.startsWith(`${PROD}/auth/email/confirm?t=`));
  assert.equal(mailer.sent[0].to, 'tech@example.com');
  assert.ok(b.has('__Host-smcp-bind'));
  const row = sql(env, 'SELECT * FROM email_links')[0];
  assert.ok(!link.includes(row.hash), 'only a hash is stored');
  assert.equal(row.hash.length, 64);
  assert.ok(row.expires_at - row.created_at === 600_000, 'ten minutes');

  // A GET (a mail scanner, a link preview) shows a button and uses nothing up.
  const scanner = new Browser(env);
  const u = new URL(link);
  const scanned = await scanner.fetch(u.pathname + u.search);
  assert.equal(scanned.status, 200);
  assert.match(await scanned.text(), /Open this link in the same browser/);
  assert.equal(sql(env, 'SELECT used_at FROM email_links')[0].used_at, null);
  const seen = await b.fetch(u.pathname + u.search);
  const page = await seen.text();
  const bindValue = b.jar.get('__Host-smcp-bind');
  assert.match(page, /<button[^>]*>Sign in<\/button>/);
  assert.equal(sql(env, 'SELECT used_at FROM email_links')[0].used_at, null);

  // Another browser that has the link can't redeem it, and doesn't burn it.
  const other = new Browser(env);
  other.jar.set('__Host-smcp-bind', 'a'.repeat(43));
  const stolen = await other.fetch('/auth/email/confirm', { method: 'POST', form: { csrf: await bindCsrf('a'.repeat(43)), t: field(page, 't') } });
  assert.equal(stolen.status, 400);
  assert.equal(sql(env, 'SELECT used_at FROM email_links')[0].used_at, null);
  // No cookie at all.
  const bare = await new Browser(env).fetch('/auth/email/confirm', { method: 'POST', form: { csrf: 'x', t: field(page, 't') } });
  assert.equal(bare.status, 403);

  // The right browser, by button: signed in.
  const done = await b.fetch('/auth/email/confirm', { method: 'POST', form: { csrf: field(page, 'csrf'), t: field(page, 't'), next: field(page, 'next') } });
  assert.equal(done.status, 303);
  assert.ok(b.has('__Host-smcp'));
  assert.ok(!b.has('__Host-smcp-bind'));
  assert.equal((await b.fetch('/account')).status, 200);
  // Once only: the same link, from the same browser, fails the second time.
  b.jar.set('__Host-smcp-bind', bindValue);
  const replay = await b.fetch('/auth/email/confirm', { method: 'POST', form: { csrf: await bindCsrf(bindValue), t: field(page, 't') } });
  assert.equal(replay.status, 400);
  assert.equal(count(env, 'login_sessions'), 1, 'no second sign-in');
});

// The form token for a binding cookie value, as the server computes it.
async function bindCsrf(bindValue) {
  const { hmacHex } = await import('../src/crypto.js');
  return hmacHex(SECRET, 'csrf', `bind:${bindValue}`);
}

test('email link: expired, GET-only use and a missing token do not sign anyone in', async () => {
  const env = makeEnv();
  member(env, 'tech@example.com');
  const b = new Browser(env);
  const { link } = await emailSignIn(b, 'tech@example.com');
  exec(env, 'UPDATE email_links SET expires_at = ?', Date.now() - 1);
  const { done } = await followLink(b, link);
  assert.equal(done.status, 400);
  assert.ok(!b.has('__Host-smcp'));
  assert.equal(count(env, 'login_sessions'), 0);
  // A made-up token.
  const page = await (await b.fetch(`/auth/email/confirm?t=${'A'.repeat(43)}`)).text();
  const fake = await b.fetch('/auth/email/confirm', { method: 'POST', form: { csrf: field(page, 'csrf'), t: 'A'.repeat(43) } });
  assert.equal(fake.status, 400);
  assert.equal((await b.fetch('/auth/email/confirm?t=short')).status, 400);
  assert.equal((await b.fetch('/auth/email/confirm', { method: 'PUT' })).status, 405);
});

test('email link: the answer is the same for an invited and an uninvited address, and only invited ones get mail', async () => {
  const env = makeEnv();
  member(env, 'tech@example.com');
  const known = new Browser(env);
  const stranger = new Browser(env);
  const a = await emailSignIn(known, 'tech@example.com');
  const sentToKnown = mailer.sent.length;
  const b = await emailSignIn(stranger, 'stranger@example.com');
  assert.equal(sentToKnown, 1);
  assert.equal(mailer.sent.length, 0, 'nothing is sent to an address nobody invited');
  assert.equal(b.link, null);
  assert.equal(a.asked.status, b.asked.status);
  assert.equal(await a.asked.text(), await b.asked.text());
  assert.deepEqual([...a.asked.headers.keys()].sort(), [...b.asked.headers.keys()].sort());
  assert.equal(a.asked.headers.get('set-cookie').split('=')[0], b.asked.headers.get('set-cookie').split('=')[0]);
  assert.equal(count(env, 'email_links'), 1, 'nothing is stored for the stranger');
  assert.equal(count(env, 'users'), 0);
  // A malformed address is a plain 400 that says nothing about invitations.
  const page = await (await known.fetch('/auth/signin')).text();
  const bad = await known.fetch('/auth/email', { method: 'POST', form: { csrf: field(page, 'csrf'), email: 'nope' } });
  assert.equal(bad.status, 400);
});

test('email link: five links an address an hour, then silence', async () => {
  const env = makeEnv();
  member(env, 'tech@example.com');
  const b = new Browser(env);
  const results = [];
  for (let i = 0; i < 7; i++) {
    const { asked, link } = await emailSignIn(b, 'tech@example.com');
    assert.equal(asked.status, 200, 'the answer never changes');
    results.push(Boolean(link));
  }
  assert.deepEqual(results, [true, true, true, true, true, false, false]);
  assert.equal(count(env, 'email_links'), 5);
  // A different address is counted on its own.
  member(env, 'other@example.com');
  assert.ok((await emailSignIn(b, 'other@example.com')).link);
  // An hour later the address may ask again.
  exec(env, 'UPDATE email_links SET created_at = created_at - ?', 3601_000);
  assert.ok((await emailSignIn(b, 'tech@example.com')).link);
});

test('email link: a form needs its token and our own origin', async () => {
  const env = makeEnv();
  member(env, 'tech@example.com');
  const b = new Browser(env);
  const page = await (await b.fetch('/auth/signin')).text();
  const csrf = field(page, 'csrf');
  mailer.sent.length = 0;
  assert.equal((await b.fetch('/auth/email', { method: 'POST', form: { email: 'tech@example.com' } })).status, 403);
  assert.equal((await b.fetch('/auth/email', { method: 'POST', form: { csrf: 'wrong', email: 'tech@example.com' } })).status, 403);
  assert.equal((await b.fetch('/auth/email', { method: 'POST', origin: 'https://evil.example', form: { csrf, email: 'tech@example.com' } })).status, 403);
  assert.equal((await b.fetch('/auth/email', { method: 'POST', origin: 'null', form: { csrf, email: 'tech@example.com' } })).status, 403);
  // A token minted for another browser does not fit this one.
  const elsewhere = field(await (await new Browser(env).fetch('/auth/signin')).text(), 'csrf');
  assert.equal((await b.fetch('/auth/email', { method: 'POST', form: { csrf: elsewhere, email: 'tech@example.com' } })).status, 403);
  // JSON is not a form.
  const json = await handler.fetch(new Request(`${PROD}/auth/email`, { method: 'POST', headers: { 'content-type': 'application/json', origin: PROD, cookie: `__Host-smcp-pre=${b.jar.get('__Host-smcp-pre')}` }, body: '{}' }), env);
  assert.equal(json.status, 415);
  assert.equal(mailer.sent.length, 0);
  assert.equal(count(env, 'email_links'), 0);
  assert.equal((await b.fetch('/auth/email')).status, 405);
});

test('email links need a mail provider; DEV_SHOW_EMAIL_LINKS shows the link, on loopback only', async () => {
  const none = createHandler('agent', null, { fetch: idp.fetch, mailer: null });
  const env = makeEnv();
  member(env, 'tech@example.com');
  // No provider: hidden, and the routes are 404.
  assert.equal((await new Browser(env, PROD, none).fetch('/auth/email', { method: 'POST', form: {} })).status, 404);
  assert.equal((await new Browser(env, PROD, none).fetch('/auth/email/confirm?t=x')).status, 404);
  // The dev setting on a real host does nothing.
  const dev = makeEnv({ DEV_SHOW_EMAIL_LINKS: '1' });
  member(dev, 'tech@example.com');
  const prod = new Browser(dev, PROD, none);
  assert.doesNotMatch(await (await prod.fetch('/auth/signin')).text(), /sign-in link/);
  assert.equal((await prod.fetch('/auth/email', { method: 'POST', form: {} })).status, 404);
  // The dev setting on a real host also does not replace a real mailer.
  const real = new Browser(dev, PROD);
  mailer.sent.length = 0;
  const page = await (await real.fetch('/auth/signin')).text();
  const sent = await real.fetch('/auth/email', { method: 'POST', form: { csrf: field(page, 'csrf'), email: 'tech@example.com' } });
  assert.doesNotMatch(await sent.text(), /Open the sign-in link/);
  assert.equal(mailer.sent.length, 1);
  // On loopback the link is on the page, and nothing is mailed.
  const local = new Browser(dev, LOCAL, none);
  const lp = await (await local.fetch('/auth/signin')).text();
  assert.match(lp, /Email me a sign-in link/);
  mailer.sent.length = 0;
  const shown = await (await local.fetch('/auth/email', { method: 'POST', form: { csrf: field(lp, 'csrf'), email: 'tech@example.com' } })).text();
  assert.equal(mailer.sent.length, 0);
  const href = /href="(http:\/\/127\.0\.0\.1:8787\/auth\/email\/confirm[^"]+)"/.exec(shown)[1].replace(/&amp;/g, '&');
  const { done } = await followLink(local, href);
  assert.equal(done.status, 303);
  // Over plain http on loopback the cookies are not __Host- and not Secure.
  assert.ok(local.has('smcp'));
  assert.ok(!local.has('__Host-smcp'));
});

test('cookie rules: __Host- and Secure on https, plain names on loopback http only', async () => {
  const env = makeEnv();
  member(env, 'tech@example.com');
  const prod = new Browser(env);
  const done = await fullEmailSignIn(prod, 'tech@example.com');
  const cookie = done.headers.getSetCookie().find((c) => c.startsWith('__Host-smcp='));
  assert.match(cookie, /; Path=\//);
  assert.match(cookie, /; HttpOnly/);
  assert.match(cookie, /; Secure/);
  assert.match(cookie, /; SameSite=Lax/);
  assert.doesNotMatch(cookie, /Domain/);
  assert.match(cookie, new RegExp(`Max-Age=${14 * 86400}`));
  const local = new Browser(makeEnv({ PUBLIC_ORIGIN: '', DEV_SHOW_EMAIL_LINKS: '1' }), LOCAL);
  const e = local.env;
  member(e, 'tech@example.com');
  await local.fetch('/auth/signin');
  const lc = [...local.jar.keys()];
  assert.deepEqual(lc, ['smcp-pre']);
});

// ---- browser sign-ins ----------------------------------------------------------------------------------------
test('a sign-in stores only a hash of its cookie, and ends by idle time, absolute time, sign out and sign out everywhere', async () => {
  const env = makeEnv();
  member(env, 'tech@example.com', 'viewer');
  const b = new Browser(env);
  await fullEmailSignIn(b, 'tech@example.com');
  const token = b.jar.get('__Host-smcp');
  const row = sql(env, 'SELECT * FROM login_sessions')[0];
  assert.notEqual(row.id_hash, token);
  assert.equal(row.id_hash.length, 64);
  assert.ok(!JSON.stringify(sql(env, 'SELECT * FROM login_sessions')).includes(token));
  assert.equal(row.expires_at - row.created_at, 14 * 86400_000);
  assert.equal((await b.fetch('/account')).status, 200);

  // Idle 13 hours: over the 12 hour default.
  exec(env, 'UPDATE login_sessions SET last_seen = ?', Date.now() - 13 * 3600_000);
  assert.equal((await b.fetch('/account')).status, 303);
  // Idle 11 hours: fine, and last_seen moves forward.
  exec(env, 'UPDATE login_sessions SET last_seen = ?', Date.now() - 11 * 3600_000);
  assert.equal((await b.fetch('/account')).status, 200);
  assert.ok(sql(env, 'SELECT last_seen FROM login_sessions')[0].last_seen > Date.now() - 60_000);
  // Often-used sign-ins are written at most every few minutes.
  const seenAt = Date.now() - 60_000;
  exec(env, 'UPDATE login_sessions SET last_seen = ?', seenAt);
  await b.fetch('/account');
  assert.equal(sql(env, 'SELECT last_seen FROM login_sessions')[0].last_seen, seenAt);

  // The settings apply to sign-ins already open.
  const short = new Browser({ ...env, SIGNIN_IDLE_HOURS: '1' });
  short.jar = b.jar;
  exec(env, 'UPDATE login_sessions SET last_seen = ?', Date.now() - 2 * 3600_000);
  assert.equal((await short.fetch('/account')).status, 303);
  exec(env, 'UPDATE login_sessions SET last_seen = ?', Date.now());

  // Absolute: 15 days after it began, however busy.
  exec(env, 'UPDATE login_sessions SET created_at = ?, expires_at = ?', Date.now() - 15 * 86400_000, Date.now() + 1000);
  assert.equal((await b.fetch('/account')).status, 303);
  exec(env, 'UPDATE login_sessions SET created_at = ?, expires_at = ?', Date.now() - 15 * 86400_000, Date.now() - 1000);
  assert.equal((await b.fetch('/account')).status, 303);
  exec(env, 'UPDATE login_sessions SET created_at = ?, expires_at = ?', Date.now(), Date.now() + 14 * 86400_000);
  assert.equal((await b.fetch('/account')).status, 200);
  const tight = new Browser({ ...env, SIGNIN_MAX_DAYS: '0.0001' });
  tight.jar = b.jar;
  exec(env, 'UPDATE login_sessions SET created_at = ?', Date.now() - 60_000);
  assert.equal((await tight.fetch('/account')).status, 303);
  exec(env, 'UPDATE login_sessions SET created_at = ?', Date.now());

  // Sign out ends this one only.
  const second = new Browser(env);
  await fullEmailSignIn(second, 'tech@example.com');
  const acct = await (await b.fetch('/account')).text();
  const out = await b.fetch('/auth/signout', { method: 'POST', form: { csrf: field(acct, 'csrf') } });
  assert.equal(out.status, 303);
  assert.ok(!b.has('__Host-smcp'));
  assert.ok(sql(env, 'SELECT revoked_at FROM login_sessions WHERE revoked_at IS NOT NULL').length === 1);
  const stale = new Browser(env);
  stale.jar.set('__Host-smcp', token);
  assert.equal((await stale.fetch('/account')).status, 303, 'the old cookie is dead');
  assert.equal((await second.fetch('/account')).status, 200, 'the other browser is still in');

  // Sign out everywhere ends all of them.
  const third = new Browser(env);
  await fullEmailSignIn(third, 'tech@example.com');
  const acct2 = await (await second.fetch('/account')).text();
  const all = await second.fetch('/account/signout-everywhere', { method: 'POST', form: { csrf: field(acct2, 'csrf') } });
  assert.equal(all.status, 303);
  assert.equal((await second.fetch('/account')).status, 303);
  assert.equal((await third.fetch('/account')).status, 303);
  assert.equal(sql(env, 'SELECT COUNT(*) AS n FROM login_sessions WHERE revoked_at IS NULL')[0].n, 0);
});

test('removal from the team ends a sign-in on its next request', async () => {
  const env = makeEnv();
  member(env, 'tech@example.com');
  member(env, 'tech@example.com', 'technician', 'acme');
  const b = new Browser(env);
  await fullEmailSignIn(b, 'tech@example.com');
  const html = await (await b.fetch('/account')).text();
  assert.match(html, /Default/);
  assert.match(html, /Team acme/);
  assert.match(html, /Technician/);
  exec(env, "DELETE FROM members WHERE workspace = 'acme'");
  const after = await (await b.fetch('/account')).text();
  assert.doesNotMatch(after, /Team acme/);
  exec(env, 'DELETE FROM members');
  const gone = await b.fetch('/account');
  assert.equal(gone.status, 303);
  assert.match(gone.headers.get('location'), /^\/auth\/signin/);
  // The cookie still names a live row, but the person is nowhere, so a new link also fails.
  assert.equal(sql(env, 'SELECT COUNT(*) AS n FROM login_sessions WHERE revoked_at IS NULL')[0].n, 1);
  assert.equal((await emailSignIn(new Browser(env), 'tech@example.com')).link, null);
  // Still able to end their own sign-in.
  assert.equal((await b.fetch('/auth/signout', { method: 'POST', form: { csrf: 'x' } })).status, 403);
});

test('account forms need their token and our origin', async () => {
  const env = makeEnv();
  member(env, 'tech@example.com', 'viewer');
  const b = new Browser(env);
  await fullEmailSignIn(b, 'tech@example.com');
  const csrf = field(await (await b.fetch('/account')).text(), 'csrf');
  const live = () => sql(env, 'SELECT COUNT(*) AS n FROM login_sessions WHERE revoked_at IS NULL')[0].n;
  for (const path of ['/account/signout-everywhere', '/auth/signout']) {
    assert.equal((await b.fetch(path, { method: 'POST', form: {} })).status, 403, `${path} without a token`);
    assert.equal((await b.fetch(path, { method: 'POST', form: { csrf: 'nope' } })).status, 403, `${path} with a wrong token`);
    assert.equal((await b.fetch(path, { method: 'POST', form: { csrf }, origin: 'https://evil.example' })).status, 403, `${path} from another origin`);
    assert.equal((await b.fetch(path, { method: 'POST', form: { csrf }, origin: 'http://support.example.com' })).status, 403, `${path} from http`);
    assert.equal(live(), 1, `${path} left the sign-in alone`);
    assert.equal((await b.fetch(path)).status, 405, `${path} by GET`);
  }
  // A token from another person's sign-in does not fit.
  const other = new Browser(env);
  member(env, 'other@example.com', 'viewer');
  await fullEmailSignIn(other, 'other@example.com');
  const otherCsrf = field(await (await other.fetch('/account')).text(), 'csrf');
  assert.equal((await b.fetch('/account/signout-everywhere', { method: 'POST', form: { csrf: otherCsrf } })).status, 403);
  assert.equal((await b.fetch('/auth/factor', { method: 'POST', form: { csrf: otherCsrf, action: 'verify', code: '123456' } })).status, 403);
  assert.equal(live(), 2);
  // No Origin header at all (an old browser) still needs the token.
  assert.equal((await b.fetch('/auth/signout', { method: 'POST', form: { csrf }, origin: null })).status, 303);
  assert.equal(live(), 1);
});

// ---- the second factor -------------------------------------------------------------------------------------------
test('TOTP matches the RFC 6238 SHA-1 test vectors', async () => {
  const secret = new TextEncoder().encode('12345678901234567890');
  const vectors = [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']];
  for (const [t, code] of vectors) assert.equal(await totp(secret, t * 1000, 8), code, String(t));
  assert.equal(await totp(secret, 59_000), '287082');
  // RFC 4226 appendix D, counter 0 and 9.
  assert.equal(await hotp(secret, 0), '755224');
  assert.equal(await hotp(secret, 9), '520489');
  assert.equal(base32Encode(secret), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.deepEqual(base32Decode('gezd gnbv-GY3TQOJQGEZDGNBVGY3TQOJQ'), secret);
  assert.throws(() => base32Decode('not base32!'));
});

test('TOTP accepts one step either side, and never a step it has seen', async () => {
  const secret = new Uint8Array(20).fill(7);
  const t = 1_700_000_010_000;
  const step = Math.floor(t / 30_000);
  const at = (s) => hotp(secret, s);
  assert.equal(await matchStep(secret, await at(step), t, 0), step);
  assert.equal(await matchStep(secret, await at(step - 1), t, 0), step - 1);
  assert.equal(await matchStep(secret, await at(step + 1), t, 0), step + 1);
  assert.equal(await matchStep(secret, await at(step - 2), t, 0), null);
  assert.equal(await matchStep(secret, await at(step + 2), t, 0), null);
  // After step was used, it and anything older are refused; a newer one is not.
  assert.equal(await matchStep(secret, await at(step), t, step), null);
  assert.equal(await matchStep(secret, await at(step - 1), t, step), null);
  assert.equal(await matchStep(secret, await at(step + 1), t, step), step + 1);
  for (const bad of ['', '12345', '1234567', 'abcdef', null, undefined]) assert.equal(await matchStep(secret, bad, t, 0), null);
  assert.equal(await matchStep(secret, `${(await at(step)).slice(0, 3)} ${(await at(step)).slice(3)}`, t, 0), step, 'spaces are ignored');
  const uri = otpauthUri({ secretBytes: secret, account: 'a@example.com', issuer: 'Support-MCP' });
  assert.match(uri, /^otpauth:\/\/totp\/Support-MCP:a%40example\.com\?/);
  assert.match(uri, /secret=[A-Z2-7]{32}/);
  assert.match(uri, /issuer=Support-MCP/);
});

async function enrol(env, b, email = 'tech@example.com') {
  const page = await (await b.fetch('/auth/factor')).text();
  const secretText = /class="secret"><code>([A-Z2-7 ]+)<\/code>/.exec(page)[1].replace(/ /g, '');
  const uri = /href="(otpauth:[^"]+)"/.exec(page)[1].replace(/&amp;/g, '&');
  const secretBytes = base32Decode(secretText);
  const code = await totp(secretBytes, Date.now());
  const r = await b.fetch('/auth/factor', { method: 'POST', form: { csrf: field(page, 'csrf'), action: 'enrol', sealed: field(page, 'sealed'), next: '/account', code } });
  return { page, secretText, secretBytes, uri, r, code };
}

test('a person sets up an authenticator, gets ten recovery codes once, and the secret is stored encrypted', async () => {
  const env = makeEnv();
  member(env, 'tech@example.com', 'technician');
  const b = new Browser(env);
  await fullEmailSignIn(b, 'tech@example.com');
  // A role that controls sessions sees the requirement.
  const before = await (await b.fetch('/account')).text();
  assert.match(before, /you need an authenticator/);
  assert.match(before, /Set up your authenticator/);

  const { secretText, uri, page, r } = await enrol(env, b);
  assert.equal(r.status, 200);
  assert.match(uri, new RegExp(`secret=${secretText}`));
  assert.match(uri, /^otpauth:\/\/totp\/Support-MCP:tech%40example\.com\?/);
  const html = await r.text();
  const codes = [...html.matchAll(/<code>([a-z2-7]{5}-[a-z2-7]{5})<\/code>/g)].map((m) => m[1]);
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  assert.match(html, /Save your recovery codes/);

  const row = sql(env, 'SELECT * FROM user_factors')[0];
  assert.ok(!row.secret_enc.includes(secretText), 'secret is not stored in the clear');
  assert.ok(!JSON.stringify(row).includes(codes[0].replace('-', '')), 'recovery codes are not stored in the clear');
  assert.ok(!JSON.stringify(row).includes(codes[0]));
  assert.equal(JSON.parse(row.recovery_hashes).length, 10);
  assert.ok(row.last_step > 0);
  // This sign-in has passed its factor.
  assert.ok(sql(env, 'SELECT factor_at FROM login_sessions')[0].factor_at > 0);
  const after = await (await b.fetch('/account')).text();
  assert.match(after, /authenticator is set up/);
  assert.match(after, /10 recovery codes are left/);
  // The page that shows codes is not shown again.
  assert.doesNotMatch(after, /Save your recovery codes/);
});

test('enrolment needs a right code, a fresh page and the signed-in person', async () => {
  const env = makeEnv();
  member(env, 'tech@example.com');
  member(env, 'other@example.com');
  const b = new Browser(env);
  await fullEmailSignIn(b, 'tech@example.com');
  const page = await (await b.fetch('/auth/factor')).text();
  const csrf = field(page, 'csrf');
  const post = (form, who = b) => who.fetch('/auth/factor', { method: 'POST', form: { csrf, action: 'enrol', next: '/account', sealed: field(page, 'sealed'), ...form } });
  const wrong = await post({ code: '000000' });
  assert.equal(wrong.status, 400);
  assert.match(await wrong.text(), /did not match/);
  assert.equal(count(env, 'user_factors'), 0);
  // A sealed key from somebody else's page, or a made-up one.
  const o = new Browser(env);
  await fullEmailSignIn(o, 'other@example.com');
  const theirs = await (await o.fetch('/auth/factor')).text();
  const secret = base32Decode(/class="secret"><code>([A-Z2-7 ]+)</.exec(theirs)[1].replace(/ /g, ''));
  const code = await totp(secret, Date.now());
  const swapped = await post({ sealed: field(theirs, 'sealed'), code });
  assert.equal(swapped.status, 400);
  assert.equal((await post({ sealed: 'junk', code })).status, 400);
  assert.equal(count(env, 'user_factors'), 0);
  assert.equal((await post({ code: '123456' }, new Browser(env))).status, 303, 'signed out: sent to sign in');
});

test('after enrolling, every new sign-in must pass a code before the account page opens', async () => {
  const env = makeEnv();
  member(env, 'tech@example.com', 'viewer');
  const first = new Browser(env);
  await fullEmailSignIn(first, 'tech@example.com');
  const { secretBytes } = await enrol(env, first);
  exec(env, 'UPDATE user_factors SET last_step = last_step - 10'); // time passes

  const b = new Browser(env);
  const signedIn = await fullEmailSignIn(b, 'tech@example.com');
  assert.match(signedIn.headers.get('location'), /^\/auth\/factor\?next=/);
  const gate = await b.fetch('/account');
  assert.equal(gate.status, 303);
  assert.match(gate.headers.get('location'), /^\/auth\/factor/);
  const page = await (await b.fetch('/auth/factor?next=%2Faccount')).text();
  assert.match(page, /Enter your code/);
  const csrf = field(page, 'csrf');
  const verify = (code) => b.fetch('/auth/factor', { method: 'POST', form: { csrf, action: 'verify', next: '/account', code } });
  assert.equal((await verify('000000')).status, 400);
  assert.equal((await b.fetch('/account')).status, 303, 'still gated');
  const good = await verify(await totp(secretBytes, Date.now()));
  assert.equal(good.status, 303);
  assert.equal((await b.fetch('/account')).status, 200);
  // The same code cannot be used again, by another sign-in.
  const c = new Browser(env);
  await fullEmailSignIn(c, 'tech@example.com');
  const csrf2 = field(await (await c.fetch('/auth/factor')).text(), 'csrf');
  const replay = await c.fetch('/auth/factor', { method: 'POST', form: { csrf: csrf2, action: 'verify', next: '/account', code: await totp(secretBytes, Date.now()) } });
  assert.equal(replay.status, 400);
  assert.equal((await c.fetch('/account')).status, 303);
});

test('five wrong codes lock the factor for 15 minutes, even against the right code', async () => {
  const env = makeEnv();
  member(env, 'tech@example.com', 'viewer');
  const first = new Browser(env);
  await fullEmailSignIn(first, 'tech@example.com');
  const { secretBytes } = await enrol(env, first);
  exec(env, 'UPDATE user_factors SET last_step = 0');
  const b = new Browser(env);
  await fullEmailSignIn(b, 'tech@example.com');
  const csrf = field(await (await b.fetch('/auth/factor')).text(), 'csrf');
  const verify = (code) => b.fetch('/auth/factor', { method: 'POST', form: { csrf, action: 'verify', next: '/account', code } });
  for (let i = 0; i < 4; i++) assert.equal((await verify('000000')).status, 400);
  assert.equal(sql(env, 'SELECT failed FROM user_factors')[0].failed, 4);
  const fifth = await verify('000000');
  assert.equal(fifth.status, 429, 'the fifth wrong code locks');
  assert.match(await fifth.text(), /Try again in 15 minutes/);
  const locked = sql(env, 'SELECT locked_until FROM user_factors')[0].locked_until;
  assert.ok(locked > Date.now() + 14 * 60_000 && locked <= Date.now() + 15 * 60_000);
  const good = await totp(secretBytes, Date.now());
  assert.equal((await verify(good)).status, 429, 'the right code is refused while locked');
  assert.equal((await b.fetch('/account')).status, 303);
  // Fifteen minutes later it works again.
  exec(env, 'UPDATE user_factors SET locked_until = ?', Date.now() - 1);
  assert.equal((await verify(good)).status, 303);
  assert.equal(sql(env, 'SELECT failed FROM user_factors')[0].failed, 0);
  // A right code resets the count, so four wrong ones after it do not lock.
  const c = new Browser(env);
  await fullEmailSignIn(c, 'tech@example.com');
  const csrfC = field(await (await c.fetch('/auth/factor')).text(), 'csrf');
  for (let i = 0; i < 4; i++) await c.fetch('/auth/factor', { method: 'POST', form: { csrf: csrfC, action: 'verify', next: '/account', code: '111111' } });
  assert.ok(!(sql(env, 'SELECT locked_until FROM user_factors')[0].locked_until > Date.now()), 'not locked');
});

test('parallel guesses are counted before they are checked', async () => {
  const env = makeEnv();
  member(env, 'tech@example.com', 'viewer');
  const first = new Browser(env);
  await fullEmailSignIn(first, 'tech@example.com');
  await enrol(env, first);
  const userId = sql(env, 'SELECT id FROM users')[0].id;
  const store = accountStore(env.DB, { secret: SECRET });
  const results = await Promise.all(Array.from({ length: 30 }, (_, i) => store.verifyFactor(userId, String(100000 + i))));
  assert.ok(results.filter((r) => r.reason === 'wrong').length <= 5);
  assert.ok(results.filter((r) => r.reason === 'locked').length >= 25, 'only five guesses got a look');
});

test('recovery codes sign in once each', async () => {
  const env = makeEnv();
  member(env, 'tech@example.com', 'viewer');
  const first = new Browser(env);
  await fullEmailSignIn(first, 'tech@example.com');
  const { r } = await enrol(env, first);
  const codes = [...(await r.text()).matchAll(/<code>([a-z2-7]{5}-[a-z2-7]{5})<\/code>/g)].map((m) => m[1]);
  const useCode = async (code) => {
    const b = new Browser(env);
    await fullEmailSignIn(b, 'tech@example.com');
    const csrf = field(await (await b.fetch('/auth/factor')).text(), 'csrf');
    const res = await b.fetch('/auth/factor', { method: 'POST', form: { csrf, action: 'verify', next: '/account', code } });
    return { res, b };
  };
  const one = await useCode(codes[0].toUpperCase());
  assert.equal(one.res.status, 200, 'upper case and the dash are fine; the page says what happened');
  assert.match(await one.res.text(), /signed you out of every other browser/);
  assert.equal((await one.b.fetch('/account')).status, 200);
  assert.equal(JSON.parse(sql(env, 'SELECT recovery_hashes FROM user_factors')[0].recovery_hashes).length, 9);
  assert.equal((await useCode(codes[0])).res.status, 400, 'the same code twice');
  const two = await useCode(codes[1].replace('-', ''));
  assert.equal(two.res.status, 200, 'another code');
  assert.equal((await one.b.fetch('/account')).status, 303, 'the earlier sign-in was ended by the later recovery sign-in');
  assert.equal((await useCode('aaaaa-aaaaa')).res.status, 400);
  // A failed recovery try counts towards the lock like a wrong code, until a right one.
  assert.equal(sql(env, 'SELECT failed FROM user_factors')[0].failed, 1);
  assert.match(await (await two.b.fetch('/account')).text(), /8 recovery codes are left/);
});

test('replacing an authenticator needs the current one first', async () => {
  const env = makeEnv();
  member(env, 'tech@example.com', 'viewer');
  const a = new Browser(env);
  await fullEmailSignIn(a, 'tech@example.com');
  const old = await enrol(env, a);
  exec(env, 'UPDATE user_factors SET last_step = 0');
  const before = sql(env, 'SELECT secret_enc FROM user_factors')[0].secret_enc;
  // A sign-in that has not passed its code can't reach the reset page, or post to it.
  const b = new Browser(env);
  await fullEmailSignIn(b, 'tech@example.com');
  const gated = await (await b.fetch('/auth/factor?reset=1')).text();
  assert.match(gated, /Enter your code/);
  assert.doesNotMatch(gated, /Set up your authenticator/);
  const sneaky = await (await a.fetch('/auth/factor?reset=1')).text();
  assert.match(sneaky, /replaces your current authenticator/);
  const csrfB = field(gated, 'csrf');
  const secret = base32Decode(/class="secret"><code>([A-Z2-7 ]+)</.exec(sneaky)[1].replace(/ /g, ''));
  const forged = await b.fetch('/auth/factor', { method: 'POST', form: { csrf: csrfB, action: 'enrol', next: '/account', sealed: 'x', code: await totp(secret, Date.now()) } });
  assert.equal(forged.status, 303);
  assert.equal(sql(env, 'SELECT secret_enc FROM user_factors')[0].secret_enc, before);
  // The signed-in-with-factor browser may replace it.
  const code = await totp(secret, Date.now());
  const csrfA = field(sneaky, 'csrf');
  const done = await a.fetch('/auth/factor', { method: 'POST', form: { csrf: csrfA, action: 'enrol', next: '/account', sealed: field(sneaky, 'sealed'), code } });
  assert.equal(done.status, 200);
  assert.notEqual(sql(env, 'SELECT secret_enc FROM user_factors')[0].secret_enc, before);
  assert.equal(count(env, 'user_factors'), 1);
  assert.ok(old.secretBytes.length === 20);
});

test('a role that can control sessions or manage the team needs a second factor; a viewer does not', async () => {
  const env = makeEnv();
  member(env, 'tech@example.com', 'technician');
  member(env, 'admin@example.com', 'admin');
  member(env, 'viewer@example.com', 'viewer');
  exec(env, "INSERT INTO roles(workspace, role_id, name, permissions, builtin, deleted) VALUES ('default', 'lead', 'Lead', '[\"members.manage\",\"sessions.view\"]', 0, 0)");
  member(env, 'lead@example.com', 'lead');
  exec(env, "INSERT INTO roles(workspace, role_id, name, permissions, builtin, deleted) VALUES ('default', 'ops', 'Ops', '[\"sessions.view\",\"sessions.create\",\"sessions.end\",\"audit.view\"]', 0, 0)");
  member(env, 'ops@example.com', 'ops');
  const team = teamFromEnv(env);
  const noFactor = (email) => ({ email, factorAt: null });
  const withFactor = (email) => ({ email, factorAt: Date.now() });

  for (const [who, perm] of [['tech@example.com', 'sessions.control'], ['admin@example.com', 'sessions.control'], ['admin@example.com', 'roles.manage'], ['lead@example.com', 'members.manage']]) {
    const refused = await authorizeSignIn(team, noFactor(who), 'default', perm);
    assert.deepEqual([refused.ok, refused.reason, refused.message], [false, 'second_factor', 'a second factor is required'], `${who} ${perm}`);
    assert.equal((await authorizeSignIn(team, withFactor(who), 'default', perm)).ok, true, `${who} ${perm} with a factor`);
  }
  // Permissions that don't need one are fine without, for anyone who holds them.
  assert.equal((await authorizeSignIn(team, noFactor('viewer@example.com'), 'default', 'sessions.view')).ok, true);
  assert.equal((await authorizeSignIn(team, noFactor('viewer@example.com'), 'default', 'audit.view')).ok, true);
  assert.equal((await authorizeSignIn(team, noFactor('ops@example.com'), 'default', 'sessions.create')).ok, true);
  assert.equal((await authorizeSignIn(team, noFactor('tech@example.com'), 'default', 'sessions.view')).ok, true);
  // A factor never grants what the role lacks.
  const denied = await authorizeSignIn(team, withFactor('viewer@example.com'), 'default', 'sessions.control');
  assert.deepEqual([denied.ok, denied.reason], [false, 'permission']);
  assert.equal((await authorizeSignIn(team, withFactor('stranger@example.com'), 'default', 'sessions.view')).reason, 'not_member');

  // Which people must enrol.
  const need = async (email) => factorRequired(await team.memberships(email), team.isDeploymentAdmin(email));
  assert.equal(await need('tech@example.com'), true);
  assert.equal(await need('admin@example.com'), true);
  assert.equal(await need('lead@example.com'), true);
  assert.equal(await need('root@example.com'), true, 'a deployment admin');
  assert.equal(await need('viewer@example.com'), false);
  assert.equal(await need('ops@example.com'), false);

  // The account page says so, and only to those people.
  const view = new Browser(env);
  await fullEmailSignIn(view, 'viewer@example.com');
  assert.match(await (await view.fetch('/account')).text(), /Optional for your role/);
  const tech = new Browser(env);
  await fullEmailSignIn(tech, 'tech@example.com');
  assert.match(await (await tech.fetch('/account')).text(), /you need an authenticator/);
});

// ---- guards that must hold ------------------------------------------------------------------------------------------
test('a sign-in cookie is not accepted on the team API or the MCP address', async () => {
  const env = makeEnv();
  member(env, 'tech@example.com', 'admin', 'acme');
  const b = new Browser(env);
  await fullEmailSignIn(b, 'tech@example.com');
  const cookie = `__Host-smcp=${b.jar.get('__Host-smcp')}`;
  const api = (path, init = {}) => handler.fetch(new Request(`${PROD}${path}`, { ...init, headers: { cookie, ...(init.headers || {}) } }), env);
  assert.equal((await api('/api/v1/w')).status, 403);
  assert.equal((await api('/api/v1/w/acme')).status, 403);
  assert.equal((await api('/api/v1/w/default')).status, 403);
  const claim = await api('/api/v1/w/default/members', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identity: 'tech@example.com', role_id: 'admin' }) });
  assert.equal(claim.status, 403);
  assert.equal(sql(env, "SELECT COUNT(*) AS n FROM members WHERE workspace = 'default'")[0].n, 0, 'nobody claimed default');
  const rpc = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'session_list', arguments: {} } });
  assert.equal((await api('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: rpc })).status, 401);
  assert.equal((await api('/w/acme/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: rpc })).status, 401);
});

test('secrets stay out of every table', async () => {
  const env = makeEnv();
  member(env, 'tech@example.com', 'viewer');
  const b = new Browser(env);
  const { link } = await emailSignIn(b, 'tech@example.com');
  const token = new URL(link).searchParams.get('t');
  await followLink(b, link);
  const cookie = b.jar.get('__Host-smcp');
  const { secretText } = await enrol(env, b);
  const dump = JSON.stringify(['users', 'user_identities', 'login_sessions', 'email_links', 'user_factors'].map((t) => sql(env, `SELECT * FROM ${t}`)));
  for (const secret of [token, cookie, secretText, SECRET, b.jar.get('__Host-smcp-bind') ?? 'zzzzzzzz']) assert.ok(!dump.includes(secret), 'a secret is stored in the clear');
});

// ---- mail ------------------------------------------------------------------------------------------------------------------
test('mailerFromEnv picks a provider by name and returns null when there is none', async () => {
  assert.equal(mailerFromEnv({}), null);
  assert.equal(mailerFromEnv({ MAIL_PROVIDER: '' }), null);
  assert.equal(mailerFromEnv({ MAIL_PROVIDER: 'unknown', RESEND_API_KEY: 'k', MAIL_FROM: 'a@example.com' }), null);
  assert.equal(mailerFromEnv({ MAIL_PROVIDER: 'toString' }), null, 'not a lookup into Object.prototype');
  assert.equal(mailerFromEnv({ MAIL_PROVIDER: 'resend', MAIL_FROM: 'a@example.com' }), null, 'no API key');
  assert.equal(mailerFromEnv({ MAIL_PROVIDER: 'resend', RESEND_API_KEY: 'k' }), null, 'no sender');

  const calls = [];
  const fetchFn = async (url, init) => { calls.push({ url, init }); return Response.json({ id: 'x' }); };
  const m = mailerFromEnv({ MAIL_PROVIDER: 'Resend', RESEND_API_KEY: 'key-123', MAIL_FROM: 'Support <login@example.com>' }, { fetchFn });
  await m.send({ to: 'tech@example.com', subject: 'Hi', text: 'text', html: '<p>html</p>' });
  assert.equal(calls[0].url, RESEND_URL);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.authorization, 'Bearer key-123');
  assert.deepEqual(JSON.parse(calls[0].init.body), { from: 'Support <login@example.com>', to: ['tech@example.com'], subject: 'Hi', text: 'text', html: '<p>html</p>' });
  const failing = mailerFromEnv({ MAIL_PROVIDER: 'resend', RESEND_API_KEY: 'k', MAIL_FROM: 'a@example.com' }, { fetchFn: async () => new Response('no', { status: 422 }) });
  await assert.rejects(() => failing.send({ to: 'a@example.com', subject: 's', text: 't', html: 'h' }), /422/);
  // A new provider is a function in the table.
  const custom = mailerFromEnv({ MAIL_PROVIDER: 'acme' }, { providers: { acme: () => ({ send: async () => 'ok' }) } });
  assert.equal(await custom.send({}), 'ok');
});

test('a mail provider that fails does not change the answer', async () => {
  const env = makeEnv();
  member(env, 'tech@example.com');
  const broken = createHandler('agent', null, { mailer: { send: async () => { throw new Error('boom'); } } });
  const b = new Browser(env, PROD, broken);
  const page = await (await b.fetch('/auth/signin')).text();
  const r = await b.fetch('/auth/email', { method: 'POST', form: { csrf: field(page, 'csrf'), email: 'tech@example.com' } });
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Check your email/);
});

test('the answer to an email request does not wait for the mail, when the runtime can finish it afterwards', async () => {
  const env = makeEnv();
  member(env, 'tech@example.com');
  const pending = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = createHandler('agent', null, { mailer: { send: async (m) => { await gate; mailer.sent.push(m); } } });
  const b = new Browser(env, PROD, { fetch: (req, e) => slow.fetch(req, e, { waitUntil: (p) => pending.push(p) }) });
  const page = await (await b.fetch('/auth/signin')).text();
  mailer.sent.length = 0;
  const r = await b.fetch('/auth/email', { method: 'POST', form: { csrf: field(page, 'csrf'), email: 'tech@example.com' } });
  assert.equal(r.status, 200);
  assert.equal(mailer.sent.length, 0, 'answered before sending');
  release();
  await Promise.all(pending);
  assert.equal(mailer.sent.length, 1);
});

// ---- id_token unit checks ----------------------------------------------------------------------------------------------------------
test('identityFromIdToken names the provider, subject and a lowercased email', async () => {
  const env = makeEnv();
  const resolver = async (kid) => (kid === 'g1' ? await importRsaJwk(googleKey.jwk, crypto.subtle) : null);
  const token = await signToken(googleKey, {
    iss: 'https://accounts.google.com', aud: GOOGLE_ID, sub: 's1', email: 'Mixed@Example.com', email_verified: true, nonce: 'n1', iat: now(), exp: now() + 60,
  });
  assert.deepEqual(await identityFromIdToken('google', token, { env, nonce: 'n1', keyResolver: resolver }), { provider: 'google', subject: 's1', email: 'mixed@example.com' });
  await assert.rejects(() => identityFromIdToken('google', token, { env, nonce: 'n2', keyResolver: resolver }), /nonce/);
  await assert.rejects(() => identityFromIdToken('google', token, { env, nonce: '', keyResolver: resolver }), /nonce/);
  await assert.rejects(() => identityFromIdToken('google', token, { env: { ...env, GOOGLE_CLIENT_ID: '' }, nonce: 'n1', keyResolver: resolver }), /not configured/);
  await assert.rejects(() => identityFromIdToken('google', token, { env, nonce: 'n1', keyResolver: resolver, nowMs: Date.now() + 3600_000 }), /expired/);
  // A token for several audiences must name us in azp.
  const multi = await signToken(googleKey, {
    iss: 'https://accounts.google.com', aud: [GOOGLE_ID, 'other'], sub: 's1', email: 'a@example.com', email_verified: true, nonce: 'n1', iat: now(), exp: now() + 60,
  });
  await assert.rejects(() => identityFromIdToken('google', multi, { env, nonce: 'n1', keyResolver: resolver }), /azp/);
});

// ---- review round: lockout, session revocation, binding, body size ---------------------------------
async function enrolledViewer(env) {
  member(env, 'tech@example.com', 'viewer');
  const first = new Browser(env);
  await fullEmailSignIn(first, 'tech@example.com');
  const e = await enrol(env, first);
  exec(env, 'UPDATE user_factors SET last_step = 0');
  const recovery = [...(await e.r.text()).matchAll(/<code>([a-z2-7]{5}-[a-z2-7]{5})<\/code>/g)].map((m) => m[1]);
  return { first, secretBytes: e.secretBytes, recovery };
}
async function signedIn(env) {
  const b = new Browser(env);
  await fullEmailSignIn(b, 'tech@example.com');
  const csrf = field(await (await b.fetch('/auth/factor')).text(), 'csrf');
  const verify = (code) => b.fetch('/auth/factor', { method: 'POST', form: { csrf, action: 'verify', next: '/account', code } });
  return { b, csrf, verify };
}

test('each lock lasts twice as long as the one before, up to a day, and only a right code starts over', async () => {
  const env = makeEnv();
  const { secretBytes } = await enrolledViewer(env);
  const { verify } = await signedIn(env);
  const lockMs = () => sql(env, 'SELECT locked_until FROM user_factors')[0].locked_until - Date.now();
  const wrongFive = async () => { for (let i = 0; i < 5; i++) await verify('000000'); };
  const expectMinutes = [15, 30, 60, 120, 240, 480, 960, 1440, 1440];
  for (const minutes of expectMinutes) {
    await wrongFive();
    const ms = lockMs();
    assert.ok(ms > (minutes - 1) * 60_000 && ms <= minutes * 60_000, `lock of ${minutes} minutes, got ${ms / 60_000}`);
    assert.equal((await verify('000000')).status, 429, 'refused while locked');
    exec(env, 'UPDATE user_factors SET locked_until = ?', Date.now() - 1); // the lock ends
  }
  assert.ok(sql(env, 'SELECT failed FROM user_factors')[0].failed >= 45, 'the count survives the locks');
  // Four wrong tries after a lock do not lock again; the fifth does.
  for (let i = 0; i < 4; i++) assert.equal((await verify('000000')).status, 400, 'a try after a lock is counted, not locked yet');
  // A right code clears the count and the lock.
  assert.equal((await verify(await totp(secretBytes, Date.now()))).status, 303);
  const row = sql(env, 'SELECT failed, locked_until FROM user_factors')[0];
  assert.equal(row.failed, 0);
  assert.equal(row.locked_until, null);
  // And the next lock is a first one again.
  exec(env, 'UPDATE user_factors SET last_step = 0');
  const next = await signedIn(env);
  for (let i = 0; i < 5; i++) await next.verify('000000');
  assert.ok(lockMs() <= 15 * 60_000);
});

test('a count without a lock time can never leave a factor stuck', async () => {
  const env = makeEnv();
  const { secretBytes } = await enrolledViewer(env);
  // The state a crash between counting and locking left behind in the old code.
  exec(env, 'UPDATE user_factors SET failed = 5, locked_until = NULL');
  const { b, verify } = await signedIn(env);
  assert.equal((await verify('000000')).status, 400, 'a wrong code is just wrong');
  exec(env, 'UPDATE user_factors SET failed = 5, locked_until = NULL');
  assert.equal((await verify(await totp(secretBytes, Date.now()))).status, 303, 'a right code gets in');
  assert.equal((await b.fetch('/account')).status, 200);
  // The count and the lock are written by one statement.
  exec(env, 'UPDATE user_factors SET failed = 4, locked_until = NULL');
  const store = accountStore(env.DB, { secret: SECRET });
  const userId = sql(env, 'SELECT id FROM users')[0].id;
  const seen = env.DB.seen ? env.DB.seen.length : 0;
  const r = await store.verifyFactor(userId, '000000');
  assert.equal(r.reason, 'locked');
  const writes = (env.DB.seen || []).slice(seen).filter((x) => /UPDATE user_factors/i.test(x.sql));
  assert.ok(writes.every((x) => !/SET locked_until = \?, failed = 0/.test(x.sql)), 'no second statement sets the lock');
  assert.equal(sql(env, 'SELECT failed FROM user_factors')[0].failed, 5);
  assert.ok(sql(env, 'SELECT locked_until FROM user_factors')[0].locked_until > Date.now());
});

test('replacing the authenticator ends every other sign-in and says so', async () => {
  const env = makeEnv();
  const { first } = await enrolledViewer(env);
  const other = new Browser(env);
  await fullEmailSignIn(other, 'tech@example.com');
  const third = await signedIn(env);
  exec(env, 'UPDATE user_factors SET last_step = 0');
  assert.equal(sql(env, 'SELECT COUNT(*) AS n FROM login_sessions WHERE revoked_at IS NULL')[0].n, 3);
  // `first` passed its code when it enrolled; it replaces the key.
  const sneaky = await (await first.fetch('/auth/factor?reset=1')).text();
  const secret = base32Decode(/class="secret"><code>([A-Z2-7 ]+)</.exec(sneaky)[1].replace(/ /g, ''));
  const done = await first.fetch('/auth/factor', { method: 'POST', form: { csrf: field(sneaky, 'csrf'), action: 'enrol', next: '/account', sealed: field(sneaky, 'sealed'), code: await totp(secret, Date.now()) } });
  assert.equal(done.status, 200);
  assert.match(await done.text(), /signed you out of every other browser/);
  assert.equal((await first.fetch('/account')).status, 200, 'the current sign-in stays');
  assert.equal((await other.fetch('/account')).status, 303, 'another sign-in is gone');
  assert.equal((await third.b.fetch('/account')).status, 303, 'so is a sign-in that had passed its code');
  assert.equal(sql(env, 'SELECT COUNT(*) AS n FROM login_sessions WHERE revoked_at IS NULL')[0].n, 1);
});

test('a recovery code ends every other sign-in and says so', async () => {
  const env = makeEnv();
  const { first, recovery } = await enrolledViewer(env);
  const other = new Browser(env);
  await fullEmailSignIn(other, 'tech@example.com');
  const { b, verify } = await signedIn(env);
  const r = await verify(recovery[0]);
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /recovery code/);
  assert.match(html, /signed you out of every other browser/);
  assert.match(html, /9 recovery codes are left/);
  assert.match(html, /href="\/account"/);
  assert.equal((await b.fetch('/account')).status, 200);
  assert.equal((await first.fetch('/account')).status, 303);
  assert.equal((await other.fetch('/account')).status, 303);
  // A code from the app is not a reason to end the others.
  const live = await signedIn(env);
  exec(env, 'UPDATE user_factors SET last_step = 0');
  const again = await signedIn(env);
  const ok = await again.verify(await totp(await secretOf(env), Date.now()));
  assert.equal(ok.status, 303);
  assert.equal((await live.b.fetch('/account')).status, 303, 'still waiting for its own code');
  assert.equal((await b.fetch('/account')).status, 200, 'an authenticator code leaves other sign-ins alone');
});
async function secretOf(env) {
  const userId = sql(env, 'SELECT id FROM users')[0].id;
  const { open } = await import('../src/crypto.js');
  return base32Decode(await open(SECRET, 'factor-secret', sql(env, 'SELECT secret_enc FROM user_factors')[0].secret_enc, userId));
}

test('sign out everywhere needs a passed code when the person has an authenticator', async () => {
  const env = makeEnv();
  const { first } = await enrolledViewer(env);
  const victim = new Browser(env);
  await fullEmailSignIn(victim, 'tech@example.com');
  // A sign-in that has not passed its code can't end the others.
  const unverified = await signedIn(env);
  const gated = await unverified.b.fetch('/account/signout-everywhere', { method: 'POST', form: { csrf: unverified.csrf } });
  assert.equal(gated.status, 303);
  assert.match(gated.headers.get('location'), /^\/auth\/factor/);
  assert.equal(sql(env, 'SELECT COUNT(*) AS n FROM login_sessions WHERE revoked_at IS NULL')[0].n, 3, 'nothing was ended');
  assert.equal((await first.fetch('/account')).status, 200);
  // Plain sign out of the sign-in itself stays allowed.
  const out = await unverified.b.fetch('/auth/signout', { method: 'POST', form: { csrf: unverified.csrf } });
  assert.equal(out.headers.get('location'), '/auth/signin?m=signed_out');
  // A sign-in that passed its code can.
  const acct = await (await first.fetch('/account')).text();
  const all = await first.fetch('/account/signout-everywhere', { method: 'POST', form: { csrf: field(acct, 'csrf') } });
  assert.equal(all.headers.get('location'), '/auth/signin?m=signed_out');
  assert.equal(sql(env, 'SELECT COUNT(*) AS n FROM login_sessions WHERE revoked_at IS NULL')[0].n, 0);
  // Without an authenticator it stays allowed.
  exec(env, 'DELETE FROM user_factors');
  const plain = new Browser(env);
  await fullEmailSignIn(plain, 'tech@example.com');
  const csrf = field(await (await plain.fetch('/account')).text(), 'csrf');
  const free = await plain.fetch('/account/signout-everywhere', { method: 'POST', form: { csrf } });
  assert.equal(free.headers.get('location'), '/auth/signin?m=signed_out');
  assert.equal(sql(env, 'SELECT COUNT(*) AS n FROM login_sessions WHERE revoked_at IS NULL')[0].n, 0);
});

test('two email links asked for in one browser both work, once each, and only there', async () => {
  const env = makeEnv();
  member(env, 'tech@example.com');
  const b = new Browser(env);
  const one = await emailSignIn(b, 'tech@example.com');
  const bind1 = b.jar.get('__Host-smcp-bind');
  const two = await emailSignIn(b, 'tech@example.com');
  assert.equal(b.jar.get('__Host-smcp-bind'), bind1, 'the browser keeps its binding value');
  assert.notEqual(one.link, two.link);
  const hashes = sql(env, 'SELECT binding_hash FROM email_links');
  assert.equal(hashes.length, 2);
  assert.ok(!JSON.stringify(hashes).includes(bind1), 'the value itself is not stored');
  // Another browser still can't use either.
  const stranger = new Browser(env);
  const su = new URL(one.link);
  assert.match(await (await stranger.fetch(su.pathname + su.search)).text(), /Open this link in the same browser/);
  // The first link signs in, and the cookie stays for the second.
  assert.equal((await followLink(b, one.link)).done.status, 303);
  assert.ok(b.has('__Host-smcp-bind'), 'kept while another link is open');
  assert.equal((await followLink(b, two.link)).done.status, 303);
  assert.ok(!b.has('__Host-smcp-bind'), 'cleared when none is left');
  // Each works once.
  const c = new Browser(env);
  c.jar.set('__Host-smcp-bind', bind1);
  assert.equal((await followLink(c, one.link)).done.status, 400);
  assert.equal((await followLink(c, two.link)).done.status, 400);
});

test('a form is cut off at its size limit while it is read, with or without a length', async () => {
  const env = makeEnv();
  const post = (body, headers = {}) => handler.fetch(new Request(`${PROD}/auth/email`, {
    method: 'POST', headers: { origin: PROD, 'content-type': 'application/x-www-form-urlencoded', ...headers }, body, duplex: 'half',
  }), env);
  let pulled = 0;
  const endless = new ReadableStream({
    pull(controller) { pulled += 1; controller.enqueue(new TextEncoder().encode('a'.repeat(1024))); if (pulled > 5000) controller.close(); },
  }, { highWaterMark: 0 });
  const r = await post(endless);
  assert.equal(r.status, 413);
  assert.ok(pulled <= 10, `read ${pulled} chunks of 1 KiB`);
  // A declared length over the limit is refused without reading anything.
  let touched = false;
  const unread = new ReadableStream({ pull(controller) { touched = true; controller.close(); } }, { highWaterMark: 0 });
  assert.equal((await post(unread, { 'content-length': '100000' })).status, 413);
  assert.equal(touched, false);
  // Multi-byte text is counted in bytes, not characters.
  assert.equal((await post(new TextEncoder().encode('e=' + '\u00e9'.repeat(5000)))).status, 413);
});

test('provider responses are read with a cap too', async () => {
  const env = makeEnv();
  member(env, 'tech@example.com');
  const huge = () => new Response(new ReadableStream({ pull(c) { c.enqueue(new TextEncoder().encode('x'.repeat(65536))); }, cancel() { huge.cancelled = true; } }, { highWaterMark: 0 }));
  const h = createHandler('agent', null, { fetch: async (url) => (String(url) === GOOGLE_TOKEN_URL ? huge() : idp.fetch(url)), mailer });
  const b = new Browser(env, PROD, h);
  const start = await b.fetch('/auth/google?next=%2Faccount');
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const cb = await b.fetch(`/auth/google/callback?code=abc&state=${encodeURIComponent(state)}`);
  assert.equal(cb.status, 403);
  assert.equal(huge.cancelled, true, 'the stream was cancelled');
});
