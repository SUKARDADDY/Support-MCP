// Small WebCrypto helpers for sign-in: random tokens, hashing, base64url and
// base32, keys derived from AUTH_SECRET, and AES-GCM sealing. Runs unchanged
// in Node 22 and in Workers. Every key derived from AUTH_SECRET uses its own
// HKDF info string, so a value sealed for one use can't be opened for another.

const enc = new TextEncoder();
const dec = new TextDecoder();

export const MIN_SECRET_LENGTH = 32;

export function bytesToB64url(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Throws on anything that is not base64url text.
export function b64urlToBytes(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('bad base64url');
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const bytesToHex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

export const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));
// n random bytes as base64url text.
export const randomToken = (n = 32) => bytesToB64url(randomBytes(n));

export async function sha256Hex(text) {
  return bytesToHex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

// Equal-length strings compared without stopping at the first difference.
export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---- base32 (RFC 4648, upper case, no padding) --------------------------------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text) {
  const clean = String(text).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('bad base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

// ---- keys derived from AUTH_SECRET --------------------------------------------
// HKDF-SHA-256 over the secret's bytes. `info` names the use ("cookie",
// "factor-secret", "csrf", "recovery-code"), and the same info always gives
// the same key. A fixed salt is fine: the input is already a high-entropy secret.
const SALT = enc.encode('support-mcp sign-in v1');
const keyCache = new Map(); // `${secret}\n${info}\n${kind}` -> Promise<CryptoKey>

async function derive(secret, info, kind) {
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveKey']);
  const params = { name: 'HKDF', hash: 'SHA-256', salt: SALT, info: enc.encode(info) };
  return kind === 'aes'
    ? crypto.subtle.deriveKey(params, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    : crypto.subtle.deriveKey(params, base, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign']);
}

function keyFor(secret, info, kind) {
  const id = `${secret}\n${info}\n${kind}`;
  if (!keyCache.has(id)) keyCache.set(id, derive(secret, info, kind));
  return keyCache.get(id);
}

// HMAC-SHA-256 hex of `message` under the key for `info`.
export async function hmacHex(secret, info, message) {
  const key = await keyFor(secret, info, 'hmac');
  return bytesToHex(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

// AES-GCM: base64url of a fresh 12-byte IV followed by the ciphertext and tag.
// `aad` is authenticated, not stored, so the opener must supply the same text.
export async function seal(secret, info, plaintext, aad = '') {
  const key = await keyFor(secret, info, 'aes');
  const iv = randomBytes(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, enc.encode(plaintext)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return bytesToB64url(out);
}

// The plaintext, or null for anything that is not a value we sealed for this
// info and aad (tampered, truncated, wrong key, wrong use).
export async function open(secret, info, sealed, aad = '') {
  try {
    const bytes = b64urlToBytes(sealed);
    if (bytes.length < 12 + 16) return null;
    const key = await keyFor(secret, info, 'aes');
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: enc.encode(aad) }, key, bytes.slice(12));
    return dec.decode(pt);
  } catch (_) {
    return null;
  }
}
