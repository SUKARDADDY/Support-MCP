// RS256 verification of Cloudflare Access JWTs and of Google and Microsoft
// id_tokens, the JWKS key cache they share, and the local-bypass rule. Pure
// logic kept out of index.js so node --test can exercise it with a locally
// generated RSA key (no network).

import { readTextCapped } from './body.js';

const JWKS_MAX = 256 * 1024; // a key set is a few kilobytes

const b64urlToBytes = (s) => {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const bytesToStr = (u8) => new TextDecoder().decode(u8);

export function decodeJwt(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const header = JSON.parse(bytesToStr(b64urlToBytes(parts[0])));
  const payload = JSON.parse(bytesToStr(b64urlToBytes(parts[1])));
  const signature = b64urlToBytes(parts[2]);
  const signingInput = new TextEncoder().encode(parts[0] + '.' + parts[1]);
  return { header, payload, signature, signingInput };
}

// jwk -> CryptoKey (RS256). Cached by the caller.
export async function importRsaJwk(jwk, subtle) {
  return subtle.importKey(
    'jwk',
    { ...jwk, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
}

// audClaim may be a string or array; ACCESS_AUD must be contained.
export function audContains(audClaim, wanted) {
  if (Array.isArray(audClaim)) return audClaim.includes(wanted);
  return audClaim === wanted;
}

// keyResolver(kid) -> Promise<CryptoKey|null>. Returns the payload on success,
// throws Error(reason) on any failure. nowMs injectable for tests.
export async function verifyAccessJwt(token, { aud, iss, keyResolver, subtle, nowMs = Date.now() }) {
  const { header, payload, signature, signingInput } = decodeJwt(token);
  if (header.alg !== 'RS256') throw new Error('bad alg');
  if (!header.kid) throw new Error('no kid');
  const key = await keyResolver(header.kid);
  if (!key) throw new Error('unknown kid');
  const valid = await subtle.verify('RSASSA-PKCS1-v1_5', key, signature, signingInput);
  if (!valid) throw new Error('bad signature');
  if (payload.iss !== iss) throw new Error('bad iss');
  if (!audContains(payload.aud, aud)) throw new Error('bad aud');
  if (typeof payload.exp !== 'number' || payload.exp * 1000 <= nowMs) throw new Error('expired');
  if (payload.nbf !== undefined) {
    if (typeof payload.nbf !== 'number') throw new Error('bad nbf');
    if (payload.nbf * 1000 > nowMs + NBF_SKEW_MS) throw new Error('not yet valid');
  }
  return payload;
}

// Clock skew tolerated on nbf (Access and the Worker clocks can differ a little).
export const NBF_SKEW_MS = 60 * 1000;

// Clock skew tolerated on an id_token's exp and iat.
export const ID_TOKEN_SKEW_MS = 120 * 1000;

// An OpenID Connect id_token (RS256) from an identity provider. `checkIssuer`
// is called with the token's iss and payload and returns true to accept it, so
// each provider supplies its own rule (Google has two spellings, Microsoft's
// varies by tenant). `nonce` must equal the token's nonce. Returns the payload,
// throws Error(reason) on any failure.
export async function verifyIdToken(token, { aud, checkIssuer, nonce, keyResolver, subtle, nowMs = Date.now() }) {
  const { header, payload, signature, signingInput } = decodeJwt(token);
  if (header.alg !== 'RS256') throw new Error('bad alg');
  if (!header.kid) throw new Error('no kid');
  const key = await keyResolver(header.kid);
  if (!key) throw new Error('unknown kid');
  const valid = await subtle.verify('RSASSA-PKCS1-v1_5', key, signature, signingInput);
  if (!valid) throw new Error('bad signature');
  if (typeof payload.iss !== 'string' || !checkIssuer(payload.iss, payload)) throw new Error('bad iss');
  if (!audContains(payload.aud, aud)) throw new Error('bad aud');
  // A token for several audiences must name us as the party it was issued to.
  if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== aud) throw new Error('bad azp');
  if (typeof payload.exp !== 'number' || payload.exp * 1000 + ID_TOKEN_SKEW_MS <= nowMs) throw new Error('expired');
  if (typeof payload.iat !== 'number' || payload.iat * 1000 > nowMs + ID_TOKEN_SKEW_MS) throw new Error('bad iat');
  if (payload.nbf !== undefined && (typeof payload.nbf !== 'number' || payload.nbf * 1000 > nowMs + ID_TOKEN_SKEW_MS)) throw new Error('not yet valid');
  if (typeof nonce !== 'string' || nonce === '' || payload.nonce !== nonce) throw new Error('bad nonce');
  return payload;
}

// ---- JWKS cache (module scope, ~1h) ----------------------------------------
// One entry and one refetch limit per key address, so Access, Google and
// Microsoft do not evict each other. Normal refresh may use the edge cache. A
// refetch forced by an unknown `kid` (key rotation) bypasses every cache and is
// limited to one per 60 s per address, so a stream of junk tokens cannot turn
// into a stream of key fetches.
const JWKS_TTL_MS = 3600_000;
const JWKS_FORCED_MIN_GAP_MS = 60_000;
const jwksEntries = new Map(); // url -> { at, keys: Map<kid, CryptoKey>, forcedAt }

export function resetJwksCache() {
  jwksEntries.clear();
}

async function fetchJwks(url, forced, fetchFn) {
  const init = forced ? { cache: 'no-store' } : { cf: { cacheTtl: 3600 } };
  const r = await fetchFn(url, init);
  if (!r.ok) throw new Error('jwks fetch failed');
  const text = await readTextCapped(r, JWKS_MAX);
  if (text === null) throw new Error('jwks too large');
  const { keys } = JSON.parse(text);
  const map = new Map();
  for (const jwk of keys || []) {
    if (!jwk.kid) continue;
    try {
      map.set(jwk.kid, await importRsaJwk(jwk, crypto.subtle));
    } catch (_) {
      // A key we cannot use (not RSA, say) must not hide the others.
    }
  }
  const prev = jwksEntries.get(url);
  jwksEntries.set(url, { at: Date.now(), keys: map, forcedAt: prev ? prev.forcedAt : 0 });
}

// keyResolver(kid) for the keys at `url`. Lazy: nothing is fetched until a
// well-formed token asks for a kid. `fetchFn` is for tests.
export function jwksKeyResolver(url, fetchFn) {
  const doFetch = fetchFn || ((u, init) => fetch(u, init));
  return async (kid) => {
    let entry = jwksEntries.get(url);
    if (!entry || Date.now() - entry.at >= JWKS_TTL_MS) {
      await fetchJwks(url, false, doFetch);
      entry = jwksEntries.get(url);
    }
    if (entry.keys.has(kid)) return entry.keys.get(kid);
    const now = Date.now();
    if (now - entry.forcedAt < JWKS_FORCED_MIN_GAP_MS) return null;
    // Record the attempt first: a failed fetch must not be retried at once either.
    entry.forcedAt = now;
    await fetchJwks(url, true, doFetch);
    return jwksEntries.get(url).keys.get(kid) || null;
  };
}

// Who is calling, for the audit log: a user JWT carries `email`, a service-token
// JWT carries `common_name` (the client id). Never the token itself.
export function callerIdentity(payload) {
  if (!payload || typeof payload !== 'object') return 'unknown';
  const v = payload.email || payload.common_name || payload.sub || 'unknown';
  return String(v).slice(0, 200);
}

// Local bypass only when DEV_SKIP_ACCESS==="1" AND hostname is localhost/127.0.0.1.
export function localBypassAllowed(env, hostname) {
  return env.DEV_SKIP_ACCESS === '1' && (hostname === 'localhost' || hostname === '127.0.0.1');
}
