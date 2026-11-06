// Google and Microsoft sign-in by OpenID Connect: authorization code flow with
// PKCE (S256), a state and a nonce. The endpoints are the providers' published
// ones, written here as constants. Only the signing keys are fetched at run
// time (src/jwt.js caches them). Nothing here touches storage or cookies.
import { bytesToB64url, randomToken } from './crypto.js';
import { verifyIdToken } from './jwt.js';
import { readTextCapped } from './body.js';

const RESPONSE_MAX = 64 * 1024; // a token response is a few kilobytes

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
export const MICROSOFT_JWKS_URL = 'https://login.microsoftonline.com/common/discovery/v2.0/keys';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// MICROSOFT_TENANTS: comma-separated tenant ids that may sign in. Empty = any.
export function microsoftTenants(env) {
  return new Set(String(env.MICROSOFT_TENANTS || '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean));
}

// `common` lets any work, school or personal account reach the consent screen.
// With tenants listed, a single tenant id is used as the authority and several
// use `organizations`. The token's tid is checked against the list either way.
function microsoftAuthority(env) {
  const tenants = [...microsoftTenants(env)];
  if (tenants.length === 0) return 'common';
  return tenants.length === 1 && GUID.test(tenants[0]) ? tenants[0] : 'organizations';
}

// null when the provider is not configured (its button and routes are hidden).
export function providerConfig(name, env) {
  if (name === 'google') {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return null;
    return {
      name, label: 'Google', clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET,
      authUrl: GOOGLE_AUTH_URL, tokenUrl: GOOGLE_TOKEN_URL, jwksUrl: GOOGLE_JWKS_URL,
      scope: 'openid email', extra: { prompt: 'select_account' },
    };
  }
  if (name === 'microsoft') {
    if (!env.MICROSOFT_CLIENT_ID || !env.MICROSOFT_CLIENT_SECRET) return null;
    const base = `https://login.microsoftonline.com/${microsoftAuthority(env)}/oauth2/v2.0`;
    return {
      name, label: 'Microsoft', clientId: env.MICROSOFT_CLIENT_ID, clientSecret: env.MICROSOFT_CLIENT_SECRET,
      authUrl: `${base}/authorize`, tokenUrl: `${base}/token`, jwksUrl: MICROSOFT_JWKS_URL,
      scope: 'openid email profile', extra: { response_mode: 'query', prompt: 'select_account' },
    };
  }
  return null;
}

// A new round trip: the values the callback must see again. Only `challenge`
// goes to the provider.
export async function newRoundTrip() {
  const verifier = randomToken(32);
  const challenge = bytesToB64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  return { state: randomToken(16), nonce: randomToken(16), verifier, challenge };
}

export function authorizationUrl(cfg, { redirectUri, state, nonce, challenge }) {
  const u = new URL(cfg.authUrl);
  const params = {
    client_id: cfg.clientId, redirect_uri: redirectUri, response_type: 'code', scope: cfg.scope,
    state, nonce, code_challenge: challenge, code_challenge_method: 'S256', ...cfg.extra,
  };
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

// Trade the code for tokens at the provider, from the Worker, with the client
// secret. Returns the id_token text. The provider's error text is not passed on.
export async function exchangeCode(cfg, { code, redirectUri, verifier, fetchFn }) {
  const r = await fetchFn(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: cfg.clientId,
      client_secret: cfg.clientSecret, code_verifier: verifier,
    }).toString(),
  });
  if (!r.ok) throw new Error('token exchange refused');
  let body;
  try {
    const text = await readTextCapped(r, RESPONSE_MAX);
    if (text === null) throw new Error('too large');
    body = JSON.parse(text);
  } catch (_) { throw new Error('token exchange gave no JSON'); }
  if (!body || typeof body.id_token !== 'string') throw new Error('no id_token');
  return body.id_token;
}

const isTrue = (v) => v === true || v === 'true';

// Verify the id_token and return { provider, subject, email } for a person the
// provider vouches for, or throw Error(reason). `nonce` is the one this
// browser's round trip carried.
export async function identityFromIdToken(name, idToken, { env, nonce, keyResolver, nowMs }) {
  const cfg = providerConfig(name, env);
  if (!cfg) throw new Error('provider not configured');
  const common = { aud: cfg.clientId, nonce, keyResolver, subtle: crypto.subtle, ...(nowMs === undefined ? {} : { nowMs }) };

  if (name === 'google') {
    const payload = await verifyIdToken(idToken, {
      ...common, checkIssuer: (iss) => iss === 'https://accounts.google.com' || iss === 'accounts.google.com',
    });
    if (payload.email_verified !== true) throw new Error('email not verified');
    return finish('google', payload.sub, payload.email);
  }

  // Microsoft's issuer carries the tenant, so build the expected one from the
  // token's own tid. verifyIdToken checks the signature before it calls this,
  // so the tid is only used once the token is known to be Microsoft's.
  const payload = await verifyIdToken(idToken, {
    ...common,
    checkIssuer: (iss, p) => typeof p.tid === 'string' && GUID.test(p.tid) && iss === `https://login.microsoftonline.com/${p.tid}/v2.0`,
  });
  const tid = payload.tid.toLowerCase();
  const tenants = microsoftTenants(env);
  if (tenants.size > 0 && !tenants.has(tid)) throw new Error('tenant not allowed');
  // An address in the token is the person's own only if Microsoft says the
  // domain's owner confirmed it (xms_edov), or the operator trusts the whole
  // tenant by listing it in MICROSOFT_TENANTS.
  if (!isTrue(payload.xms_edov) && !tenants.has(tid)) throw new Error('email not verified');
  if (typeof payload.oid !== 'string' || !GUID.test(payload.oid.toLowerCase())) throw new Error('no oid');
  return finish('microsoft', `${tid}:${payload.oid.toLowerCase()}`, payload.email);
}

function finish(provider, subject, email) {
  if (typeof subject !== 'string' || subject === '') throw new Error('no subject');
  const address = String(email ?? '').trim().toLowerCase();
  if (!address || address.length > 200 || !/^[^@\s]+@[^@\s]+$/.test(address)) throw new Error('no email');
  return { provider, subject, email: address };
}
