import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto as wc } from 'node:crypto';
import {
  verifyAccessJwt, verifyIdToken, jwksKeyResolver, resetJwksCache, importRsaJwk, audContains, localBypassAllowed, callerIdentity,
} from '../src/jwt.js';

const subtle = wc.subtle;
const TEAM = 'example-team.cloudflareaccess.com';
const ISS = `https://${TEAM}`;
const AUD = 'test-access-aud';

function b64url(bytes) {
  let bin = '';
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const jsonB64 = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));

async function makeToken(priv, { kid = 'k1', aud = AUD, iss = ISS, exp = Math.floor(Date.now() / 1000) + 600, nbf } = {}) {
  const header = { alg: 'RS256', kid, typ: 'JWT' };
  const payload = { aud, iss, exp, email: 'operator@example.com' };
  if (nbf !== undefined) payload.nbf = nbf;
  const signingInput = `${jsonB64(header)}.${jsonB64(payload)}`;
  const sig = await subtle.sign('RSASSA-PKCS1-v1_5', priv, new TextEncoder().encode(signingInput));
  return `${signingInput}.${b64url(sig)}`;
}

async function keypair() {
  const kp = await subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const jwk = await subtle.exportKey('jwk', kp.publicKey);
  jwk.kid = 'k1';
  const pubKey = await importRsaJwk(jwk, subtle);
  const resolver = async (kid) => (kid === 'k1' ? pubKey : null);
  return { priv: kp.privateKey, resolver };
}

test('valid token verifies and returns payload', async () => {
  const { priv, resolver } = await keypair();
  const tok = await makeToken(priv);
  const payload = await verifyAccessJwt(tok, { aud: AUD, iss: ISS, keyResolver: resolver, subtle });
  assert.equal(payload.email, 'operator@example.com');
});

test('wrong aud rejected', async () => {
  const { priv, resolver } = await keypair();
  const tok = await makeToken(priv, { aud: 'nope' });
  await assert.rejects(() => verifyAccessJwt(tok, { aud: AUD, iss: ISS, keyResolver: resolver, subtle }), /bad aud/);
});

test('expired token rejected', async () => {
  const { priv, resolver } = await keypair();
  const tok = await makeToken(priv, { exp: Math.floor(Date.now() / 1000) - 10 });
  await assert.rejects(() => verifyAccessJwt(tok, { aud: AUD, iss: ISS, keyResolver: resolver, subtle }), /expired/);
});

test('wrong signature rejected (token signed by a different key)', async () => {
  const a = await keypair();
  const b = await keypair();
  const tok = await makeToken(b.priv); // signed by b, verified against a's resolver
  await assert.rejects(() => verifyAccessJwt(tok, { aud: AUD, iss: ISS, keyResolver: a.resolver, subtle }), /bad signature/);
});

test('wrong iss rejected', async () => {
  const { priv, resolver } = await keypair();
  const tok = await makeToken(priv, { iss: 'https://evil.example.com' });
  await assert.rejects(() => verifyAccessJwt(tok, { aud: AUD, iss: ISS, keyResolver: resolver, subtle }), /bad iss/);
});

test('unknown kid rejected', async () => {
  const { priv } = await keypair();
  const tok = await makeToken(priv, { kid: 'other' });
  const resolver = async () => null;
  await assert.rejects(() => verifyAccessJwt(tok, { aud: AUD, iss: ISS, keyResolver: resolver, subtle }), /unknown kid/);
});

test('audContains handles array and string', () => {
  assert.equal(audContains(AUD, AUD), true);
  assert.equal(audContains([AUD, 'x'], AUD), true);
  assert.equal(audContains(['x'], AUD), false);
});

test('local bypass only for localhost + flag', () => {
  assert.equal(localBypassAllowed({ DEV_SKIP_ACCESS: '1' }, 'localhost'), true);
  assert.equal(localBypassAllowed({ DEV_SKIP_ACCESS: '1' }, '127.0.0.1'), true);
  assert.equal(localBypassAllowed({ DEV_SKIP_ACCESS: '1' }, 'support.example.com'), false);
  assert.equal(localBypassAllowed({ DEV_SKIP_ACCESS: '0' }, 'localhost'), false);
  assert.equal(localBypassAllowed({}, 'localhost'), false);
});

test('nbf in the future (beyond 60 s skew) rejected, within skew accepted', async () => {
  const { priv, resolver } = await keypair();
  const now = Date.now();
  const far = await makeToken(priv, { nbf: Math.floor(now / 1000) + 300 });
  await assert.rejects(() => verifyAccessJwt(far, { aud: AUD, iss: ISS, keyResolver: resolver, subtle, nowMs: now }), /not yet valid/);
  const near = await makeToken(priv, { nbf: Math.floor(now / 1000) + 30 });
  const p = await verifyAccessJwt(near, { aud: AUD, iss: ISS, keyResolver: resolver, subtle, nowMs: now });
  assert.equal(p.email, 'operator@example.com');
});

test('callerIdentity prefers email, then common_name', () => {
  assert.equal(callerIdentity({ email: 'a@b.c', common_name: 'x' }), 'a@b.c');
  assert.equal(callerIdentity({ common_name: 'abc.access' }), 'abc.access');
  assert.equal(callerIdentity(null), 'unknown');
});

// ---- id_tokens from an identity provider --------------------------------------
async function idToken(priv, claims = {}) {
  const t = Math.floor(Date.now() / 1000);
  const payload = { iss: 'https://idp.example.com', aud: 'client-1', sub: 's', nonce: 'n1', iat: t, exp: t + 600, ...claims };
  const signingInput = `${jsonB64({ alg: 'RS256', kid: 'k1', typ: 'JWT' })}.${jsonB64(payload)}`;
  const sig = await subtle.sign('RSASSA-PKCS1-v1_5', priv, new TextEncoder().encode(signingInput));
  return `${signingInput}.${b64url(sig)}`;
}
const idOpts = (resolver, extra = {}) => ({ aud: 'client-1', checkIssuer: (iss) => iss === 'https://idp.example.com', nonce: 'n1', keyResolver: resolver, subtle, ...extra });

test('id_token: a good token verifies, and each wrong claim is refused', async () => {
  const { priv, resolver } = await keypair();
  const ok = await verifyIdToken(await idToken(priv), idOpts(resolver));
  assert.equal(ok.sub, 's');
  const t = Math.floor(Date.now() / 1000);
  const bad = [
    [{ iss: 'https://evil.example.com' }, /bad iss/],
    [{ aud: 'other' }, /bad aud/],
    [{ nonce: 'n2' }, /bad nonce/],
    [{ nonce: undefined }, /bad nonce/],
    [{ exp: t - 300, iat: t - 900 }, /expired/],
    [{ iat: t + 900, exp: t + 1500 }, /bad iat/],
    [{ aud: ['client-1', 'other'] }, /bad azp/],
  ];
  for (const [claims, reason] of bad) {
    const token = await idToken(priv, claims);
    await assert.rejects(() => verifyIdToken(token, idOpts(resolver)), reason, JSON.stringify(claims));
  }
  const other = await keypair();
  const forged = await idToken(other.priv);
  await assert.rejects(() => verifyIdToken(forged, idOpts(resolver)), /bad signature/);
  const plain = await idToken(priv);
  await assert.rejects(() => verifyIdToken(plain, idOpts(resolver, { nonce: '' })), /bad nonce/);
  // Two minutes of clock skew are allowed on exp and iat.
  const skewed = await idToken(priv, { exp: t - 30, iat: t - 700 });
  assert.equal((await verifyIdToken(skewed, idOpts(resolver))).sub, 's');
  // The issuer check sees the payload, so a provider can build its issuer from a claim.
  const tenant = await idToken(priv, { iss: 'https://login.example.com/t1/v2.0', tid: 't1' });
  const viaTid = idOpts(resolver, { checkIssuer: (iss, p) => iss === `https://login.example.com/${p.tid}/v2.0` });
  assert.equal((await verifyIdToken(tenant, viaTid)).tid, 't1');
});

// ---- the key cache --------------------------------------------------------------
test('key cache: one entry and one refetch limit per address', async () => {
  resetJwksCache();
  const a = await keypair();
  const b = await keypair();
  const jwkOf = async (kid) => {
    const kp = await subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
    return { ...(await subtle.exportKey('jwk', kp.publicKey)), kid };
  };
  const served = { 'https://a.example/keys': [await jwkOf('a1')], 'https://b.example/keys': [await jwkOf('b1')] };
  const calls = [];
  const fetchFn = async (url, init) => { calls.push({ url, init }); return Response.json({ keys: served[url] }); };
  const ra = jwksKeyResolver('https://a.example/keys', fetchFn);
  const rb = jwksKeyResolver('https://b.example/keys', fetchFn);
  assert.ok(await ra('a1'));
  assert.ok(await rb('b1'));
  assert.ok(await ra('a1'));
  assert.ok(await rb('b1'));
  assert.equal(calls.length, 2, 'each address is fetched once and stays cached beside the other');
  assert.deepEqual(calls[0].init, { cf: { cacheTtl: 3600 } });
  // An unknown kid forces one uncached refetch per address, then waits a minute.
  assert.equal(await ra('nope'), null);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2].init, { cache: 'no-store' });
  assert.equal(await ra('nope-again'), null);
  assert.equal(calls.length, 3, 'a second unknown kid within a minute does not refetch');
  assert.equal(await rb('nope'), null);
  assert.equal(calls.length, 4, 'the other address has its own limit');
  // A rotated key shows up through the forced refetch.
  served['https://a.example/keys'] = [await jwkOf('a2')];
  resetJwksCache();
  assert.ok(await ra('a2'));
  // A failed fetch throws, and nothing is cached from it.
  resetJwksCache();
  const down = jwksKeyResolver('https://c.example/keys', async () => new Response('no', { status: 500 }));
  await assert.rejects(() => down('x'), /jwks fetch failed/);
  void a; void b;
  resetJwksCache();
});
