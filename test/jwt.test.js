import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto as wc } from 'node:crypto';
import { verifyAccessJwt, importRsaJwk, audContains, localBypassAllowed, callerIdentity } from '../src/jwt.js';

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
