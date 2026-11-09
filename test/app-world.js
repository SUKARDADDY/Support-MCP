// A relay for the technician app's tests: the agent world of agent-world.js with
// the real OAuth library and an in-memory KV, plus a scripted app. The app signs in
// the way the Rust core does: it registers as a public client (no secret) with a
// loopback address, opens the consent page in a browser that is already signed in,
// and exchanges the code. Tokens for the app's address (/app/w/<slug>) and for the
// MCP address are both made here, so a test can check each against the other.
//
// The library imports `cloudflare:workers`, which Node cannot load. `npm test`
// preloads test/stubs/register.mjs to stand in for it. Run bare, `node --test`
// finds no library, `lib` is null, and a test file skips itself.
import { agentWorld, BOSS, TECH, VIEW, LEAD, OTHER } from './agent-world.js';
import { HOST } from './device-sessions-world.js';
import { openKV } from './kv-fake.js';
import { accountStore } from '../src/accounts.js';
import { bytesToB64url, sha256Hex } from '../src/crypto.js';
import { appResourceUrl, resourceUrl } from '../src/oauth.js';

export { HOST, BOSS, TECH, VIEW, LEAD, OTHER };
export const REDIRECT = 'http://127.0.0.1/callback';
export const APP_PORT = 53122;
export const JSON_HEADERS = { 'content-type': 'application/json' };

export let lib = null;
export let skip = false;
try {
  lib = await import('@cloudflare/workers-oauth-provider');
} catch (e) {
  skip = 'the OAuth library needs the cloudflare:workers stub: run npm test (node --import ./test/stubs/register.mjs --test)';
  console.log(`# app tests skipped: ${skip}`);
}

const unesc = (v) => v.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
export const field = (html, name) => { const m = new RegExp(`name="${name}" value="([^"]*)"`).exec(html); return m && unesc(m[1]); };
export { unesc };

async function pkce() {
  const verifier = bytesToB64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = bytesToB64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  return { verifier, challenge };
}

export async function appWorld(t, opts = {}) {
  const { env: extra = {}, handlerOptions = {}, ...rest } = opts;
  const kv = openKV();
  const w = await agentWorld(t, {
    ...rest,
    env: { OAUTH_KV: kv, PUBLIC_ORIGIN: HOST, ...extra },
    handlerOptions: {
      oauth: { OAuthAuthorizationServer: lib.OAuthAuthorizationServer, AuthorizationError: lib.AuthorizationError, CimdFetchError: lib.CimdFetchError },
      oauthTuning: { missGapMs: 0 },
      ...handlerOptions,
    },
  });
  const accounts = accountStore(w.env.DB, { secret: w.env.AUTH_SECRET });

  // A browser with a cookie jar, signed in as `email` without the sign-in pages:
  // the same rows the pages would write. With `factor`, the person has an
  // authenticator and this sign-in passed its code.
  async function browser(email, { factor = false } = {}) {
    const jar = new Map();
    const found = await accounts.userForEmail(email, async () => true);
    const token = await accounts.createSession(found.user.id, { maxMs: 14 * 86400_000 });
    if (factor) {
      if (!(await accounts.getFactor(found.user.id))) await accounts.saveFactor(found.user.id, new Uint8Array(20).fill(7), 1, { replace: false });
      await accounts.markFactor(await sha256Hex(token));
    }
    jar.set('__Host-smcp', token);
    const b = {
      userId: found.user.id,
      async fetch(path, { method = 'GET', form } = {}) {
        const h = new Headers();
        if (jar.size) h.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
        let body;
        if (form) { h.set('content-type', 'application/x-www-form-urlencoded'); body = new URLSearchParams(form).toString(); }
        if (method === 'POST') h.set('origin', HOST);
        const r = await w.handler.fetch(new Request(HOST + path, { method, headers: h, body, redirect: 'manual' }), w.env);
        for (const sc of r.headers.getSetCookie()) {
          const pair = sc.split(';')[0];
          const i = pair.indexOf('=');
          if (/;\s*Max-Age=0/i.test(sc)) jar.delete(pair.slice(0, i)); else jar.set(pair.slice(0, i), pair.slice(i + 1));
        }
        return r;
      },
    };
    return b;
  }

  // A public client, as the app registers: no secret, a loopback address with no port.
  async function register({ redirect = REDIRECT, name = 'Support technician app' } = {}) {
    const r = await w.send('/oauth/register', {
      method: 'POST', headers: JSON_HEADERS,
      body: JSON.stringify({ client_name: name, redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
    });
    if (r.status !== 201) throw new Error(`could not register: ${r.status} ${await r.text()}`);
    return (await r.json()).client_id;
  }

  async function tokenRequest(params) {
    const r = await w.send('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
    return { status: r.status, body: await r.json() };
  }

  // Register, open the consent page for `resource`, press Allow, and exchange the code.
  // Returns the consent page's text and, when the exchange worked, the tokens.
  async function connect(email, { app = true, workspace = 'default', factor = true, port = APP_PORT, withResource = true, deny = false } = {}) {
    const b = await browser(email, { factor });
    const clientId = await register();
    const { verifier, challenge } = await pkce();
    const resource = app ? appResourceUrl(HOST, workspace) : resourceUrl(HOST, workspace);
    const redirect = `http://127.0.0.1:${port}/callback`;
    const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirect, state: 'st-1', code_challenge: challenge, code_challenge_method: 'S256', resource });
    const page = await b.fetch(`/oauth/authorize?${q}`);
    const html = page.status === 200 ? await page.text() : '';
    const out = { status: page.status, html, clientId, resource, userId: b.userId, browser: b };
    if (page.status !== 200) return out;
    const allowed = await b.fetch('/oauth/authorize', { method: 'POST', form: { csrf: field(html, 'csrf'), handle: field(html, 'handle'), decision: deny ? 'deny' : 'approve' } });
    out.decided = allowed.status;
    const back = new URL(allowed.headers.get('location'));
    out.back = back;
    const code = back.searchParams.get('code');
    if (!code) return out;
    const tokens = await tokenRequest({
      grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: clientId, code_verifier: verifier, ...(withResource ? { resource } : {}),
    });
    out.tokens = tokens;
    out.access = tokens.body.access_token;
    out.refresh = tokens.body.refresh_token;
    return out;
  }

  // A call to an /app route. `token` null sends no credential.
  async function appCall(token, method, path, body, { slug = 'default', headers = {}, raw = false } = {}) {
    const r = await w.send(`/app/w/${slug}${path}`, {
      method,
      headers: { ...(body === undefined && method === 'GET' ? {} : JSON_HEADERS), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (raw) return r;
    let json = null;
    try { json = await r.json(); } catch (_) { /* no body */ }
    return { status: r.status, body: json, headers: r.headers };
  }

  // One MCP tool call over the app's address, or over /mcp with `base`.
  async function appTool(token, name, args = {}, { base = '/app/w/default/mcp' } = {}) {
    const r = await w.send(base, {
      method: 'POST', headers: { ...JSON_HEADERS, authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    if (r.status !== 200) return { status: r.status };
    const result = (await r.json()).result;
    const text = result.content[0].text;
    if (result.isError) return { status: 200, error: text };
    try { return { status: 200, ...JSON.parse(text) }; } catch (_) { return { status: 200, text }; }
  }

  // The person's authenticator is gone, as after a reset: grants made with it no
  // longer pass a second-factor check.
  const loseFactor = (userId) => w.db.sqlite.prepare('DELETE FROM user_factors WHERE user_id = ?').run(userId);

  return { ...w, kv, accounts, browser, register, tokenRequest, connect, appCall, appTool, loseFactor };
}
