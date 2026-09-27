// RS256 verification of Cloudflare Access JWTs, plus the local-bypass rule.
// Pure logic kept out of index.js so node --test can exercise it with a
// locally generated RSA key (no network).

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
