// Signed, staged updates for saved PCs: the release note, version order, the
// group and stage rules, the deploy settings, the offer rule, and the key and
// signing scripts. Every key here is made at run time; none is committed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../src/version.js';
import {
  buildNote, bundleDigest, compareVersions, groupOf, isPrerelease, offerAtCheckIn, offerOnRefusal, parseNote, parseReleaseSettings,
  parseRollout, releaseFrom, scheduledStage, validVersion,
} from '../src/release.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOUR = 3600_000;
const SHA = 'ab'.repeat(32);

// A throwaway P-256 key: the private key object and the public key as X||Y base64, the form the app and release-key.pub carry.
export function throwawayKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const xy = Buffer.concat([Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64');
  return { privateKey, publicKey, xy };
}
const signNote = (key, note) => sign('sha256', Buffer.from(note), { key: key.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64');
const verifies = (xy, note, signature) => {
  const raw = Buffer.from(xy, 'base64');
  const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(0, 32).toString('base64url'), y: raw.subarray(32).toString('base64url') }, format: 'jwk' });
  return verify('sha256', Buffer.from(note), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64'));
};

// A fixture bundle: built (as far as the signer can tell) from this source, its exe carrying VERSION.
export function fixtureBundle(extra = 'fixture') {
  const exe = Buffer.concat([Buffer.from('MZ'), Buffer.from(VERSION, 'utf16le'), Buffer.from(extra)]);
  return { source_sha256: createHash('sha256').update(readFileSync(join(ROOT, 'src', 'agent-app.cs'))).digest('hex'), exe_b64: exe.toString('base64') };
}

// ---- the note --------------------------------------------------------------------
test('the release note is exactly five LF lines, and the parser takes nothing else', () => {
  const note = buildNote({ version: '0.5.1', sha256: SHA, size: 229376, released: 1794000000 });
  assert.equal(note, `support-mcp-release 1\nversion 0.5.1\nsha256 ${SHA}\nsize 229376\nreleased 1794000000\n`);
  assert.deepEqual(parseNote(note), { version: '0.5.1', sha256: SHA, size: 229376, released: 1794000000 });
  const bad = [
    note.slice(0, -1), // no final LF
    note.replace(/\n/g, '\r\n'), // CRLF
    `${note}extra 1\n`, // an extra line
    note.replace(/released [0-9]+\n/, ''), // a missing line
    note.replace(`version 0.5.1\nsha256 ${SHA}`, `sha256 ${SHA}\nversion 0.5.1`), // wrong order
    note.replace(SHA, SHA.toUpperCase()), // uppercase hex
    note.replace('size 229376', 'size 0229376'), // a leading zero
    note.replace('version 0.5.1', 'version 0.5.01'), // not a version
    note.replace('support-mcp-release 1', 'support-mcp-release 2'),
    note.replace('size 229376', 'size  229376'),
    note.replace('version 0.5.1', 'version 0.5.1é'),
  ];
  for (const text of bad) assert.equal(parseNote(text), null, JSON.stringify(text));
  assert.throws(() => buildNote({ version: '0.5', sha256: SHA, size: 1, released: 1 }));
  assert.throws(() => buildNote({ version: '0.5.1', sha256: SHA.toUpperCase(), size: 1, released: 1 }));
});

test('versions compare by SemVer precedence, build metadata ignored, leading zeros refused', () => {
  const order = ['0.4.9', '0.5.0-alpha', '0.5.0-alpha.1', '0.5.0-alpha.beta', '0.5.0-beta.2', '0.5.0-beta.11', '0.5.0-rc.1', '0.5.0', '0.5.1', '0.6.0-rc.1', '0.6.0', '0.10.0', '1.0.0'];
  for (let i = 0; i < order.length; i++) {
    for (let j = 0; j < order.length; j++) assert.equal(compareVersions(order[i], order[j]), Math.sign(i - j), `${order[i]} vs ${order[j]}`);
  }
  assert.equal(compareVersions('0.5.0+build.1', '0.5.0+build.2'), 0);
  assert.equal(compareVersions('10.0.0', '9.99.99'), 1);
  for (const v of ['01.0.0', '0.05.0', '0.5.0-01', '0.5', 'v0.5.0', '', 'x'.repeat(40)]) {
    assert.equal(validVersion(v), false, v);
    assert.throws(() => compareVersions(v, '0.5.0'));
  }
  assert.equal(isPrerelease('0.6.0-rc.1'), true);
  assert.equal(isPrerelease('0.6.0+build-1'), false);
});

// ---- group, stage, settings ------------------------------------------------------------
const seededIds = () => {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  return Array.from({ length: 10_000 }, (_, i) => {
    const h = createHash('sha256').update(`seed-${i}`).digest();
    return Array.from(h.subarray(0, 20), (b) => alphabet[b & 31]).join('');
  });
};

test('the group is fixed per PC and release, and 10,000 PCs spread evenly over the 100 groups', async () => {
  assert.equal(await groupOf('0.5.1', 'default', 'a'.repeat(20)), await groupOf('0.5.1', 'default', 'a'.repeat(20)));
  // The documented rule: the first 4 bytes of SHA-256 of "<version>:<workspace>:<id>", big-endian, mod 100.
  const want = createHash('sha256').update(`0.5.1:acme:${'b'.repeat(20)}`).digest().readUInt32BE(0) % 100;
  assert.equal(await groupOf('0.5.1', 'acme', 'b'.repeat(20)), want);
  const ids = seededIds();
  const groups = await Promise.all(ids.map((id) => groupOf('0.5.1', 'default', id)));
  const buckets = new Array(100).fill(0);
  for (const g of groups) {
    assert.ok(Number.isInteger(g) && g >= 0 && g < 100);
    buckets[g]++;
  }
  for (let b = 0; b < 100; b++) assert.ok(buckets[b] >= 70 && buckets[b] <= 130, `group ${b} holds ${buckets[b]}`);
  const share = (stage) => (100 * groups.filter((g) => g < stage).length) / groups.length;
  assert.ok(Math.abs(share(10) - 10) <= 1, `the 10% stage reaches ${share(10)}%`);
  assert.ok(Math.abs(share(50) - 50) <= 1, `the 50% stage reaches ${share(50)}%`);
  // A new release shuffles the groups.
  const next = await Promise.all(ids.slice(0, 200).map((id) => groupOf('0.5.2', 'default', id)));
  assert.ok(next.filter((g, i) => g === groups[i]).length < 20, 'the next release puts PCs in new groups');
});

test('the stage counts from the signed date: 10 for a day, 50 for the next, then 100', () => {
  const signed = 1_794_000_000;
  const at = (ms) => scheduledStage(signed, signed * 1000 + ms);
  assert.deepEqual([at(-HOUR), at(0), at(24 * HOUR - 1), at(24 * HOUR), at(48 * HOUR - 1), at(48 * HOUR), at(400 * HOUR)], [10, 10, 10, 50, 50, 100, 100]);
});

test('UPDATE_ROLLOUT: empty follows the schedule, 0 to 100 pins it, pause and anything else are 0', () => {
  for (const v of [undefined, null, '', '  ']) assert.deepEqual(parseRollout(v), { percent: null, pinned: false }, String(v));
  for (const [v, n] of [['0', 0], ['1', 1], ['10', 10], ['50', 50], ['100', 100], [' 25 ', 25]]) assert.deepEqual(parseRollout(v), { percent: n, pinned: true }, v);
  for (const v of ['pause', 'PAUSE', '101', '-1', '5%', '1.5', '010', 'all', 'on']) assert.deepEqual(parseRollout(v), { percent: 0, pinned: false }, v);
});

test('the deploy settings: a 64-byte base64 signature and unix seconds, or no release', () => {
  const signature = Buffer.alloc(64, 7).toString('base64');
  assert.deepEqual(parseReleaseSettings({ RELEASE_SIGNATURE: signature, RELEASE_SIGNED_AT: '1794000000' }), { signature, signedAt: 1794000000 });
  const bad = [
    {}, { RELEASE_SIGNATURE: signature }, { RELEASE_SIGNED_AT: '1794000000' },
    { RELEASE_SIGNATURE: '', RELEASE_SIGNED_AT: '' },
    { RELEASE_SIGNATURE: Buffer.alloc(63).toString('base64'), RELEASE_SIGNED_AT: '1' },
    { RELEASE_SIGNATURE: Buffer.alloc(72).toString('base64'), RELEASE_SIGNED_AT: '1' },
    { RELEASE_SIGNATURE: signature.replace(/=+$/, ''), RELEASE_SIGNED_AT: '1' },
    { RELEASE_SIGNATURE: signature.replace('B', '-'), RELEASE_SIGNED_AT: '1' },
    { RELEASE_SIGNATURE: signature, RELEASE_SIGNED_AT: '0' },
    { RELEASE_SIGNATURE: signature, RELEASE_SIGNED_AT: '-5' },
    { RELEASE_SIGNATURE: signature, RELEASE_SIGNED_AT: '17e8' },
    { RELEASE_SIGNATURE: signature, RELEASE_SIGNED_AT: '1794000000.5' },
    { RELEASE_SIGNATURE: signature, RELEASE_SIGNED_AT: 1794000000 },
  ];
  for (const env of bad) assert.equal(parseReleaseSettings(env), null, JSON.stringify(env));
});

// ---- the release from a fixture bundle ----------------------------------------------
test('a fixture bundle signed with a throwaway key: only the exact note verifies', async () => {
  const key = throwawayKey();
  const bundle = fixtureBundle();
  const exe = Buffer.from(bundle.exe_b64, 'base64');
  const signedAt = Math.floor(Date.now() / 1000);
  const truth = buildNote({ version: VERSION, sha256: createHash('sha256').update(exe).digest('hex'), size: exe.length, released: signedAt });
  assert.deepEqual(await bundleDigest(bundle), { sha256: createHash('sha256').update(exe).digest('hex'), size: exe.length });
  const env = (signature, at = signedAt) => ({ RELEASE_SIGNATURE: signature, RELEASE_SIGNED_AT: String(at) });

  const good = await releaseFrom(bundle, env(signNote(key, truth)));
  assert.equal(good.note, truth, 'the relay rebuilds the signed note exactly');
  assert.equal(good.version, VERSION);
  assert.ok(verifies(key.xy, good.note, good.signature), 'a good signature verifies');

  // The relay never checks the signature, so each of these is passed on, and the PC refuses it.
  const other = throwawayKey();
  const wrongKey = await releaseFrom(bundle, env(signNote(other, truth)));
  const wrongDate = await releaseFrom(bundle, env(signNote(key, truth), signedAt + 1));
  const wrongExe = await releaseFrom(fixtureBundle('another build'), env(signNote(key, truth)));
  const otherVersion = await releaseFrom(bundle, env(signNote(key, truth.replace(`version ${VERSION}`, 'version 9.9.9'))));
  for (const [name, r] of [['a signature by another key', wrongKey], ['a wrong signed date', wrongDate], ['a wrong exe', wrongExe], ['a version other than VERSION', otherVersion]]) {
    assert.ok(r, name);
    assert.equal(verifies(key.xy, r.note, r.signature), false, name);
  }
  assert.equal(await releaseFrom(bundle, {}), null, 'no settings, no release');
  assert.equal(await releaseFrom(null, env(signNote(key, truth))), null, 'no bundle, no release');
});

// ---- the offer rule ----------------------------------------------------------------------
test('the offer at check-in: active PCs below the release, in a group inside the stage', async () => {
  const now = 1_794_000_000_000;
  const release = { version: VERSION, note: 'n', signature: 's', signedAt: now / 1000 - 72 * 3600 }; // three days old: stage 100
  const pc = (extra = {}) => ({ status: 'active', workspace: 'default', id: 'a'.repeat(20), app_version: '0.0.1', ...extra });
  const group = await groupOf(VERSION, 'default', 'a'.repeat(20));
  const offer = (p, rollout = '', r = release, at = now, version = VERSION) => offerAtCheckIn(r, p, rollout, at, version);

  assert.equal(await offer(pc()), true, 'an active PC on a lower version');
  assert.equal(await offer(pc({ status: 'pending' })), false, 'a pending PC never');
  assert.equal(await offer(pc({ app_version: VERSION })), false, 'the same version');
  assert.equal(await offer(pc({ app_version: `${VERSION}+build.7` })), false, 'the same version with build metadata');
  assert.equal(await offer(pc({ app_version: '99.0.0' })), false, 'a higher version');
  assert.equal(await offer(pc({ app_version: `${VERSION}-rc.1` })), true, 'a prerelease of this version is lower');
  for (const v of ['', 'abc', '0.4', '0.04.0', null, undefined]) assert.equal(await offer(pc({ app_version: v })), false, `unparseable: ${v}`);
  assert.equal(await offer(pc(), '', null), false, 'no signed release');
  assert.equal(await offer(pc(), '', { ...release, version: '9.9.9' }), false, 'a release version other than VERSION');
  assert.equal(await offer(pc(), 'pause'), false, 'paused');
  assert.equal(await offer(pc(), '0'), false, 'pinned at 0');
  assert.equal(await offer(pc(), 'nonsense'), false, 'an unknown rollout counts as pause');
  assert.equal(await offer(pc(), String(group)), false, 'a group at the pinned percentage is outside');
  assert.equal(await offer(pc(), String(group + 1)), true, 'a group below the pinned percentage is inside');
  assert.equal(await offer(pc(), '100'), true);
  // The schedule: a fresh release reaches groups 0 to 9 only.
  const fresh = { ...release, signedAt: now / 1000 };
  assert.equal(await offer(pc(), '', fresh), group < 10, `stage 10, group ${group}`);
  assert.equal(await offer(pc(), '', fresh, now + 30 * HOUR), group < 50, `stage 50, group ${group}`);
  // A prerelease is offered only when the rollout pins a number.
  const pre = { ...release, version: '0.9.0-rc.1' };
  assert.equal(await offer(pc(), '', pre, now, '0.9.0-rc.1'), false, 'a prerelease on the schedule');
  assert.equal(await offer(pc(), '100', pre, now, '0.9.0-rc.1'), true, 'a prerelease with a pinned rollout');
});

test('the offer in a protocol refusal: any release unless paused or 0, a prerelease only when pinned', () => {
  const release = { version: VERSION, note: 'n', signature: 's', signedAt: 1 };
  assert.equal(offerOnRefusal(release, ''), true);
  assert.equal(offerOnRefusal(release, '30'), true);
  for (const v of ['pause', '0', 'junk']) assert.equal(offerOnRefusal(release, v), false, v);
  assert.equal(offerOnRefusal(null, ''), false);
  assert.equal(offerOnRefusal({ ...release, version: '9.9.9' }, ''), false);
  const pre = { ...release, version: '0.9.0-rc.1' };
  assert.equal(offerOnRefusal(pre, '', '0.9.0-rc.1'), false);
  assert.equal(offerOnRefusal(pre, '100', '0.9.0-rc.1'), true);
});

// ---- the public key and the scripts ---------------------------------------------------
test('release-key.pub and the key built into the app are the same 64-byte public key', () => {
  const file = readFileSync(join(ROOT, 'release-key.pub'), 'utf8');
  assert.match(file, /^[A-Za-z0-9+/]{86}==\n$/, 'one line of base64');
  assert.equal(Buffer.from(file.trim(), 'base64').length, 64);
  const app = /const string ProjectKey = "([^"]*)"/.exec(readFileSync(join(ROOT, 'src', 'agent-app.cs'), 'utf8'));
  assert.ok(app, 'src/agent-app.cs has ReleaseKey.ProjectKey');
  assert.equal(app[1], file.trim());
});

const node = (script, args, input) => spawnSync(process.execPath, [join(ROOT, 'scripts', script), ...args], { input, encoding: 'utf8' });

test('release-key makes a key in memory: the private key goes only to stdout, the public key to the named file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'support-mcp-key-'));
  try {
    const pub = join(dir, 'release-key.pub');
    const made = node('release-key.mjs', [pub]);
    assert.equal(made.status, 0, made.stderr);
    assert.match(made.stdout, /^-----BEGIN PRIVATE KEY-----\n[\s\S]+\n-----END PRIVATE KEY-----\n$/);
    assert.deepEqual(readdirSync(dir), ['release-key.pub'], 'nothing but the public key is written');
    const xy = readFileSync(pub, 'utf8');
    assert.doesNotMatch(xy, /PRIVATE/);
    assert.match(xy, /^[A-Za-z0-9+/]{86}==\n$/);
    const jwk = createPublicKey(made.stdout).export({ format: 'jwk' });
    assert.equal(Buffer.concat([Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64'), xy.trim(), 'the file holds the public half of the printed key');
    assert.notEqual(node('release-key.mjs', []).status, 0, 'the file name is required');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sign-release reads the key from stdin, signs the note and checks it against the public key; a wrong key signs nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'support-mcp-sign-'));
  try {
    const pub = join(dir, 'release-key.pub');
    const pem = node('release-key.mjs', [pub]).stdout;
    const bundleFile = join(dir, 'bundle.json');
    const bundle = fixtureBundle();
    writeFileSync(bundleFile, JSON.stringify(bundle));
    const out = join(dir, 'out');
    const before = Math.floor(Date.now() / 1000);
    const signed = node('sign-release.mjs', ['--bundle', bundleFile, '--pub', pub, '--out', out], pem);
    assert.equal(signed.status, 0, signed.stderr);
    const [sigLine, atLine, blank, ...rest] = signed.stdout.split('\n');
    const signature = /^RELEASE_SIGNATURE=([A-Za-z0-9+/]{86}==)$/.exec(sigLine)?.[1];
    const signedAt = Number(/^RELEASE_SIGNED_AT=([0-9]+)$/.exec(atLine)?.[1]);
    assert.ok(signature, sigLine);
    assert.ok(signedAt >= before && signedAt <= Math.floor(Date.now() / 1000) + 1, atLine);
    assert.equal(blank, '');
    const note = rest.join('\n');
    const exe = Buffer.from(bundle.exe_b64, 'base64');
    assert.equal(note, buildNote({ version: VERSION, sha256: createHash('sha256').update(exe).digest('hex'), size: exe.length, released: signedAt }));
    assert.ok(verifies(readFileSync(pub, 'utf8').trim(), note, signature), 'the printed signature verifies against release-key.pub');
    // The files for the GitHub release.
    assert.deepEqual(readdirSync(out).sort(), [`support-mcp-${VERSION}.exe`, `support-mcp-${VERSION}.note`, `support-mcp-${VERSION}.note.sig`]);
    assert.deepEqual(readFileSync(join(out, `support-mcp-${VERSION}.exe`)), exe);
    assert.equal(readFileSync(join(out, `support-mcp-${VERSION}.note`), 'utf8'), note);
    assert.equal(readFileSync(join(out, `support-mcp-${VERSION}.note.sig`), 'utf8'), `${signature}\n`);
    const wrong = throwawayKey().privateKey.export({ format: 'pem', type: 'pkcs8' });
    const refused = node('sign-release.mjs', ['--bundle', bundleFile, '--pub', pub], wrong);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /does not match/);
    assert.equal(refused.stdout, '', 'nothing is printed for a wrong key');
    // A bundle not built from this source, or with no key on stdin, signs nothing.
    writeFileSync(bundleFile, JSON.stringify({ ...bundle, source_sha256: '0'.repeat(64) }));
    assert.notEqual(node('sign-release.mjs', ['--bundle', bundleFile, '--pub', pub], pem).status, 0);
    writeFileSync(bundleFile, JSON.stringify(bundle));
    assert.notEqual(node('sign-release.mjs', ['--bundle', bundleFile, '--pub', pub], '').status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the relay rebuilds what sign-release signed, from the two settings and the bundle', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'support-mcp-sign-'));
  try {
    const pub = join(dir, 'release-key.pub');
    const pem = node('release-key.mjs', [pub]).stdout;
    const bundle = fixtureBundle();
    writeFileSync(join(dir, 'bundle.json'), JSON.stringify(bundle));
    const signed = node('sign-release.mjs', ['--bundle', join(dir, 'bundle.json'), '--pub', pub], pem);
    const env = Object.fromEntries(signed.stdout.split('\n').slice(0, 2).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    const release = await releaseFrom(bundle, env);
    assert.ok(release);
    assert.ok(verifies(readFileSync(pub, 'utf8').trim(), release.note, release.signature));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
