// Time-based one-time passwords (RFC 6238 over RFC 4226): HMAC-SHA-1, 30 second
// steps, 6 digits. Authenticator apps (Google Authenticator, Microsoft
// Authenticator, 1Password, Authy and the like) all speak this.
import { base32Encode, randomBytes, timingSafeEqual } from './crypto.js';

export const STEP_SECONDS = 30;
export const DIGITS = 6;
// A code from one step before or after the current one is accepted, for clock drift.
export const WINDOW_STEPS = 1;

export const newSecret = () => randomBytes(20); // 160 bits, the size RFC 4226 recommends

// The code for one counter value.
export async function hotp(secretBytes, counter, digits = DIGITS) {
  const key = await crypto.subtle.importKey('raw', secretBytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setBigUint64(0, BigInt(counter));
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export const stepAt = (timeMs) => Math.floor(timeMs / 1000 / STEP_SECONDS);

export const totp = (secretBytes, timeMs, digits = DIGITS) => hotp(secretBytes, stepAt(timeMs), digits);

// The step `code` matches within the drift window and after `lastStep`, or
// null. A step at or before `lastStep` is never accepted again, so a code can
// be used once, and so can any older code that is still inside the window.
export async function matchStep(secretBytes, code, timeMs, lastStep = 0) {
  const text = String(code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(text)) return null;
  const now = stepAt(timeMs);
  let found = null;
  // Check every step in the window, without stopping at the first match.
  for (let step = now - WINDOW_STEPS; step <= now + WINDOW_STEPS; step++) {
    const ok = timingSafeEqual(await hotp(secretBytes, step), text);
    if (ok && step > lastStep && (found === null || step > found)) found = step;
  }
  return found;
}

// The otpauth:// address an authenticator app reads (usually from a QR code;
// most apps also take the text secret by hand).
export function otpauthUri({ secretBytes, account, issuer }) {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret: base32Encode(secretBytes), issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params}`;
}
