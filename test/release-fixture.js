// Shared by the release tests: throwaway P-256 keys made at run time (none is
// committed), signing and checking a note the way the app does, and a fixture
// bundle that passes for one built from this source.
import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { VERSION } from '../src/version.js';
import { buildMacNote } from '../src/release.js';

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

// The two Worker secrets of a Mac release signed by `key`, and the note and URL they carry. signedAt is Unix seconds.
// The Mac has its own version line, from 1.1.0, apart from the relay's VERSION.
export const MAC_VERSION = '1.1.0';
export const macUrl = (version) => `https://github.com/example/support-mcp/releases/download/v${version}/Support-${version}.pkg`;
export const MAC_URL = macUrl(MAC_VERSION);
export function macRelease(key, { version = MAC_VERSION, signedAt = Math.floor(Date.now() / 1000) - 72 * 3600, url = macUrl(version) } = {}) {
  const note = buildMacNote({ version, sha256: 'cd'.repeat(32), size: 9_000_000, released: signedAt, url });
  const signature = signNote(key, note);
  return { note, signature, url, signedAt, env: { MAC_RELEASE_NOTE: Buffer.from(note).toString('base64'), MAC_RELEASE_SIGNATURE: signature } };
}
