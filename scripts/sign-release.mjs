// Sign this release at deploy time.
//
//   <print the private key PEM> | node scripts/sign-release.mjs [--bundle <file>] [--pub <file>] [--out <folder>]
//
// It reads the release private key (PKCS#8 PEM) from stdin and never writes it
// anywhere. It reads the app bundle (src/app-bundle.json), checks that it was
// built from this source and carries VERSION, builds the release note from the
// exe's size and SHA-256 and the current time, signs it, and checks the
// signature against the public key (release-key.pub). It prints the two deploy
// settings, RELEASE_SIGNATURE and RELEASE_SIGNED_AT, then the note. With --out it
// also writes the exe, the note and its signature into that folder, for the
// GitHub release. The stages (10%, then half, then all) count from the signing
// time, so sign right before the deploy. See docs/development.md, "Releases".
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../src/version.js';
import { buildNote } from '../src/release.js';

const fail = (message) => {
  console.error(`sign-release: ${message}`);
  process.exit(1);
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const opts = { bundle: join(root, 'src', 'app-bundle.json'), pub: join(root, 'release-key.pub'), out: null };
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  const name = args[i].replace(/^--/, '');
  if (!args[i].startsWith('--') || !Object.hasOwn(opts, name) || args[i + 1] === undefined) fail('usage: <private key PEM> | node scripts/sign-release.mjs [--bundle <file>] [--pub <file>] [--out <folder>]');
  opts[name] = resolve(args[i + 1]);
}

// The private key, from stdin only.
let privateKey;
try {
  privateKey = createPrivateKey(readFileSync(0));
} catch (_) {
  fail('stdin must be the release private key, a PEM');
}
if (privateKey.asymmetricKeyType !== 'ec' || privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') fail('the release key must be ECDSA P-256');

// The public key the apps carry: 64 bytes X||Y in base64 on one line.
let publicKey;
try {
  const xy = Buffer.from(readFileSync(opts.pub, 'utf8').trim(), 'base64');
  if (xy.length !== 64) throw new Error('size');
  publicKey = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: xy.subarray(0, 32).toString('base64url'), y: xy.subarray(32).toString('base64url') }, format: 'jwk' });
} catch (_) {
  fail(`${opts.pub} must hold the 64-byte public key X||Y in base64`);
}

// The bundle: built from this source, which carries VERSION in the app as well.
let bundle;
try {
  bundle = JSON.parse(readFileSync(opts.bundle, 'utf8'));
} catch (_) {
  fail(`cannot read ${opts.bundle}`);
}
const source = readFileSync(join(root, 'src', 'agent-app.cs'));
if (createHash('sha256').update(source).digest('hex') !== bundle.source_sha256) fail('the bundle was not built from src/agent-app.cs: rebuild it (docs/development.md)');
const appVersion = /public const string Version = "([^"]*)"/.exec(source.toString('utf8'))?.[1];
if (appVersion !== VERSION) fail(`src/agent-app.cs carries version ${appVersion}, not ${VERSION}`);
const exe = Buffer.from(typeof bundle.exe_b64 === 'string' ? bundle.exe_b64 : '', 'base64');
if (exe.length < 2 || exe[0] !== 77 || exe[1] !== 90) fail('the bundle holds no exe');
if (!exe.includes(Buffer.from(VERSION, 'utf16le'))) fail(`the bundle exe does not carry version ${VERSION}`);

const released = Math.floor(Date.now() / 1000);
const note = buildNote({ version: VERSION, sha256: createHash('sha256').update(exe).digest('hex'), size: exe.length, released });
const signature = sign('sha256', Buffer.from(note), { key: privateKey, dsaEncoding: 'ieee-p1363' });
if (!verify('sha256', Buffer.from(note), { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature)) fail(`the key does not match ${opts.pub}: nothing was signed`);

const b64 = signature.toString('base64');
if (opts.out) {
  mkdirSync(opts.out, { recursive: true });
  writeFileSync(join(opts.out, `support-mcp-${VERSION}.exe`), exe);
  writeFileSync(join(opts.out, `support-mcp-${VERSION}.note`), note);
  writeFileSync(join(opts.out, `support-mcp-${VERSION}.note.sig`), `${b64}\n`);
}
process.stdout.write(`RELEASE_SIGNATURE=${b64}\nRELEASE_SIGNED_AT=${released}\n\n${note}`);
console.error(`sign-release: signed ${VERSION} at ${new Date(released * 1000).toISOString()}. Deploy now: the stages count from this time.`);
