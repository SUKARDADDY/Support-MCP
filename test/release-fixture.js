// Shared by the release tests: throwaway P-256 keys made at run time (none is
// committed), signing and checking a note the way the app does, and a fixture
// bundle that passes for one built from this source.
import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { VERSION } from '../src/version.js';

// The private key object and the public key as X||Y base64, the form the app and release-key.pub carry.
export function throwawayKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const xy = Buffer.concat([Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64');
  return { privateKey, publicKey, xy };
}
// A 64-byte r||s signature in base64, as RELEASE_SIGNATURE carries it.
export const signNote = (key, note) => sign('sha256', Buffer.from(note), { key: key.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64');
// What the PC checks: the signature over the note's exact bytes, against X||Y.
export function verifies(xy, note, signature) {
  const raw = Buffer.from(xy, 'base64');
  const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(0, 32).toString('base64url'), y: raw.subarray(32).toString('base64url') }, format: 'jwk' });
  return verify('sha256', Buffer.from(note), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64'));
}
// A bundle whose source hash is this src/agent-app.cs and whose exe carries VERSION.
export function fixtureBundle(extra = 'fixture') {
  const exe = Buffer.concat([Buffer.from('MZ'), Buffer.from(VERSION, 'utf16le'), Buffer.from(extra)]);
  const source = readFileSync(new URL('../src/agent-app.cs', import.meta.url));
  return { source_sha256: createHash('sha256').update(source).digest('hex'), exe_b64: exe.toString('base64') };
}
