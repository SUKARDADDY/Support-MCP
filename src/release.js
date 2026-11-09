// The signed release a saved PC may update to (docs/relay-v1-spec.md, "Updates").
//
// The release is this relay's own app bundle. Its note is five lines that the
// project's offline release key signs at deploy time:
//
//   support-mcp-release 1
//   version <VERSION>
//   sha256 <64 lowercase hex of the exe without a footer>
//   size <decimal byte count>
//   released <unix seconds>
//
// each ending in LF, UTF-8, nothing else. The signature is ECDSA P-256 over
// SHA-256 of those bytes, 64 bytes r||s, standard base64. The relay never holds
// the private key and never checks the signature: it rebuilds the note from
// VERSION, the bundle and RELEASE_SIGNED_AT, and passes RELEASE_SIGNATURE on.
// The PC checks the signature against the public key built into it, so a relay
// can offer or hold back a release but never forge one.
//
// Which PCs are offered it is derived, not stored: each PC has a group (0 to 99)
// per release, and the stage (10, 50, then 100) counts from the signed date.
// UPDATE_ROLLOUT pauses the rollout or pins a percentage.
import { VERSION, VERSION_PATTERN } from './version.js';
import { bytesToHex } from './crypto.js';

export const NOTE_HEADER = 'support-mcp-release 1';
// The technician app's note has the same four values under its own header, so a note for one
// product never passes as a note for the other: each checks its own header, and the signature
// covers it.
export const TECHNICIAN_NOTE_HEADER = 'support-mcp-technician-release 1';
const HEX64 = /^[0-9a-f]{64}$/;
const DECIMAL = /^[1-9][0-9]{0,15}$/;
const SIGNATURE = /^[A-Za-z0-9+/]{86}==$/; // 64 bytes in standard base64
const HOUR_MS = 3600_000;

// A version this code compares: VERSION_PATTERN and at most 32 characters, as a hello's version is capped.
export const validVersion = (v) => typeof v === 'string' && v.length <= 32 && VERSION_PATTERN.test(v);

// The note's exact text. Throws on a value that would not round-trip. `header` is the PC
// release's unless a caller names another (the technician app's).
export function buildNote({ version, sha256, size, released }, header = NOTE_HEADER) {
  if (!validVersion(version)) throw new Error('bad version');
  if (typeof sha256 !== 'string' || !HEX64.test(sha256)) throw new Error('bad sha256');
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error('bad size');
  if (!Number.isSafeInteger(released) || released <= 0) throw new Error('bad release date');
  return `${header}\nversion ${version}\nsha256 ${sha256}\nsize ${size}\nreleased ${released}\n`;
}

// The note's values, or null for anything but the exact five lines under `header`.
export function parseNote(text, header = NOTE_HEADER) {
  if (typeof text !== 'string' || !text.endsWith('\n') || /[^\x20-\x7e\n]/.test(text)) return null;
  const lines = text.slice(0, -1).split('\n');
  if (lines.length !== 5 || lines[0] !== header) return null;
  const value = (line, name) => (line.startsWith(`${name} `) ? line.slice(name.length + 1) : null);
  const version = value(lines[1], 'version'), sha256 = value(lines[2], 'sha256'), size = value(lines[3], 'size'), released = value(lines[4], 'released');
  if (!validVersion(version) || !HEX64.test(sha256 ?? '') || !DECIMAL.test(size ?? '') || !DECIMAL.test(released ?? '')) return null;
  const out = { version, sha256, size: Number(size), released: Number(released) };
  return Number.isSafeInteger(out.size) && Number.isSafeInteger(out.released) ? out : null;
}

// The technician app's note: the same five lines under TECHNICIAN_NOTE_HEADER.
export const buildTechnicianNote = (values) => buildNote(values, TECHNICIAN_NOTE_HEADER);
export const parseTechnicianNote = (text) => parseNote(text, TECHNICIAN_NOTE_HEADER);

// SemVer precedence of two valid versions, build metadata ignored: -1, 0 or 1.
// Throws on a version that is not valid.
export function compareVersions(a, b) {
  const parts = (v) => {
    if (!validVersion(v)) throw new Error(`not a version: ${String(v).slice(0, 40)}`);
    const [main, pre = null] = v.split('+')[0].split(/-(.*)/s);
    return { core: main.split('.'), pre: pre === null ? null : pre.split('.') };
  };
  // Numbers without leading zeros: a longer one is larger, and equal lengths compare as text.
  const num = (x, y) => (x.length !== y.length ? Math.sign(x.length - y.length) : x < y ? -1 : x > y ? 1 : 0);
  const isNum = (s) => /^[0-9]+$/.test(s);
  const pa = parts(a), pb = parts(b);
  for (let i = 0; i < 3; i++) {
    const c = num(pa.core[i], pb.core[i]);
    if (c) return c;
  }
  if (pa.pre === null || pb.pre === null) return pa.pre === pb.pre ? 0 : pa.pre === null ? 1 : -1;
  for (let i = 0; i < Math.min(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i], y = pb.pre[i];
    let c;
    if (isNum(x) && isNum(y)) c = num(x, y);
    else if (isNum(x) !== isNum(y)) c = isNum(x) ? -1 : 1;
    else c = x < y ? -1 : x > y ? 1 : 0;
    if (c) return c;
  }
  return Math.sign(pa.pre.length - pb.pre.length);
}

export const isPrerelease = (v) => v.split('+')[0].includes('-');

// A PC's group for a release, 0 to 99: the first 4 bytes of SHA-256 of
// "<version>:<workspace>:<device id>", big-endian, mod 100. Stable for one PC and
// one release, shuffled again for the next release.
export async function groupOf(version, workspace, deviceId) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${version}:${workspace}:${deviceId}`));
  return new DataView(digest).getUint32(0) % 100;
}

// The share of PCs offered the release, from the time it was signed: 10 for the
// first day, 50 for the second, 100 after.
export function scheduledStage(signedAtSeconds, nowMs = Date.now()) {
  const age = nowMs - signedAtSeconds * 1000;
  return age < 24 * HOUR_MS ? 10 : age < 48 * HOUR_MS ? 50 : 100;
}

// UPDATE_ROLLOUT: empty follows the schedule; a whole number 0 to 100 pins the
// stage; "pause", and anything else, is 0. Returns { percent: null } for the
// schedule, else { percent, pinned } where pinned says a number was given.
export function parseRollout(value) {
  const v = typeof value === 'string' ? value.trim() : value === undefined || value === null ? '' : String(value);
  if (v === '') return { percent: null, pinned: false };
  if (/^(?:100|[1-9]?[0-9])$/.test(v)) return { percent: Number(v), pinned: true };
  return { percent: 0, pinned: false };
}

// The two deploy settings, or null when either is missing or malformed.
export function parseReleaseSettings(env) {
  const signature = typeof env?.RELEASE_SIGNATURE === 'string' ? env.RELEASE_SIGNATURE.trim() : '';
  const signedAt = typeof env?.RELEASE_SIGNED_AT === 'string' ? env.RELEASE_SIGNED_AT.trim() : '';
  if (!SIGNATURE.test(signature) || !DECIMAL.test(signedAt)) return null;
  const at = Number(signedAt);
  return Number.isSafeInteger(at) ? { signature, signedAt: at } : null;
}

// The exe in a bundle, without a footer, as bytes.
export function bundleExe(bundle) {
  return Uint8Array.from(atob(bundle.exe_b64), (c) => c.charCodeAt(0));
}

// The bundle exe's SHA-256 and size, computed once per bundle object (once per
// isolate in the Worker).
const digests = new WeakMap();
export function bundleDigest(bundle) {
  let p = digests.get(bundle);
  if (!p) {
    p = (async () => {
      const exe = bundleExe(bundle);
      return { sha256: bytesToHex(await crypto.subtle.digest('SHA-256', exe)), size: exe.length };
    })();
    digests.set(bundle, p);
  }
  return p;
}

// The release this relay can offer: { version, note, signature, signedAt }, or
// null without a bundle or valid settings. version is the release's own
// version, VERSION unless a test passes another.
export async function releaseFrom(bundle, env, version = VERSION) {
  if (!bundle || typeof bundle.exe_b64 !== 'string') return null;
  const settings = parseReleaseSettings(env);
  if (!settings) return null;
  try {
    const { sha256, size } = await bundleDigest(bundle);
    const note = buildNote({ version, sha256, size, released: settings.signedAt });
    return { version, note, signature: settings.signature, signedAt: settings.signedAt };
  } catch (_) {
    return null;
  }
}

// The update object of an answer: what the PC checks, and the version for people reading the wire.
export const updateField = (release) => ({ version: release.version, note: release.note, signature: release.signature });

// Whether a release reaches a PC that is cut off by protocol (the 426 answer):
// whenever one exists and the rollout is not paused or 0. Such a PC can do
// nothing else, so there is no group check. A prerelease needs a pinned rollout.
export function offerOnRefusal(release, rolloutValue, version = VERSION) {
  if (!release || release.version !== version) return false;
  const rollout = parseRollout(rolloutValue);
  if (rollout.percent === 0) return false;
  return !isPrerelease(release.version) || rollout.pinned;
}

// Whether a release is offered at a check-in. pc: { status, workspace, id,
// app_version } with app_version the request's, else the stored one. The PC
// must be active (never pending), on a valid version below the release, and in a
// group below the stage.
export async function offerAtCheckIn(release, pc, rolloutValue, nowMs = Date.now(), version = VERSION) {
  if (!release || release.version !== version) return false;
  if (!pc || pc.status !== 'active' || !validVersion(pc.app_version)) return false;
  if (compareVersions(pc.app_version, release.version) >= 0) return false;
  const rollout = parseRollout(rolloutValue);
  if (isPrerelease(release.version) && !rollout.pinned) return false;
  const stage = rollout.percent === null ? scheduledStage(release.signedAt, nowMs) : rollout.percent;
  if (stage <= 0) return false;
  return (await groupOf(release.version, pc.workspace, pc.id)) < stage;
}
