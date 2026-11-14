// Sign this release at deploy time.
//
//   <print the private key PEM> | node scripts/sign-release.mjs [--bundle <file>] [--pub <file>] [--out <folder>]
//   <print the private key PEM> | node scripts/sign-release.mjs --product technician --file <installer> [--pub <file>] [--out <folder>] [--root <folder>]
//   <print the private key PEM> | node scripts/sign-release.mjs --product mac --version <semver> --file <package> --url <package url> [--pub <file>] [--out <folder>]
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
//
// With --product technician it signs the technician app's installer instead: it takes the
// installer's size and SHA-256 (no bundle, no stages) and builds a note under its own header,
// support-mcp-technician-release 1, so a PC note never passes as a technician note. --out then
// writes support-technician-<V>-setup.exe, .note and .note.sig for the GitHub release, and
// the app checks the note against the same release-key.pub. It refuses unless the version in
// technician-app/package.json and the [package] version in technician-app/src-tauri/Cargo.toml
// (the version compiled into the app) both equal the release version. --root names another
// tree to read those two files from (the tests use it).
//
// With --product mac it signs the Mac app's installer package (Support-<V>.pkg, built by the macOS
// job): the note has six lines, the usual four values under support-mcp-mac-release 1 and a url, the
// GitHub release URL the Mac downloads the package from, https://github.com/<owner>/<repo>/releases/download/v<V>/Support-<V>.pkg.
// The Mac has its own version line, set by --version and unrelated to the relay's VERSION. It prints the two Worker secrets to set, MAC_RELEASE_NOTE (the
// note in base64) and MAC_RELEASE_SIGNATURE, then the note. They are secrets, not [vars]: a Windows-only
// deploy must not reset them. --out writes the package, the note and its signature for the GitHub release.
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../src/version.js';
import { buildMacNote, buildNote, buildTechnicianNote, validVersion } from '../src/release.js';

const fail = (message) => {
  console.error(`sign-release: ${message}`);
  process.exit(1);
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = 'usage: <private key PEM> | node scripts/sign-release.mjs [--bundle <file>] [--pub <file>] [--out <folder>]\n       <private key PEM> | node scripts/sign-release.mjs --product technician --file <installer> [--pub <file>] [--out <folder>] [--root <folder>]\n       <private key PEM> | node scripts/sign-release.mjs --product mac --version <semver> --file <package> --url <package url> [--pub <file>] [--out <folder>]';
const opts = { bundle: join(root, 'src', 'app-bundle.json'), pub: join(root, 'release-key.pub'), out: null, file: null, root, url: null, version: null };
let product = 'pc';
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  const name = args[i].replace(/^--/, '');
  if (!args[i].startsWith('--') || args[i + 1] === undefined) fail(USAGE);
  if (name === 'product') {
    if (!['technician', 'pc', 'mac'].includes(args[i + 1])) fail(USAGE);
    product = args[i + 1];
  } else if (name === 'url' || name === 'version') {
    opts[name] = args[i + 1];
  } else if (!Object.hasOwn(opts, name)) {
    fail(USAGE);
  } else {
    opts[name] = resolve(args[i + 1]);
  }
}
if (product === 'technician' && !opts.file) fail('--product technician needs --file <installer>');
if (product === 'mac' && (!opts.file || !opts.url || !opts.version)) fail('--product mac needs --version <semver>, --file <package> and --url <package url>');
if (product === 'pc' && opts.file) fail('--file is for --product technician or mac');
if (product !== 'mac' && (opts.url || opts.version)) fail('--url and --version are for --product mac');
if (product === 'mac' && !validVersion(opts.version)) fail('--version must be a SemVer version of at most 32 characters');

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

const released = Math.floor(Date.now() / 1000);
let note;
let exe;
let assetBase; // the GitHub release assets are <assetBase>.exe (.pkg for a Mac), .note and .note.sig
if (product === 'mac') {
  // The package, a flat package (xar) that carries the release's version in its file name, and the URL the Mac
  // downloads it from: the GitHub release of this version, so a note for one build never names another's file.
  try {
    exe = readFileSync(opts.file);
  } catch (_) {
    fail(`cannot read ${opts.file}`);
  }
  if (exe.length < 4 || exe.subarray(0, 4).toString('latin1') !== 'xar!') fail('the package is not a macOS installer package');
  if (!basename(opts.file).includes(opts.version)) fail(`the package's file name does not carry version ${opts.version}`);
  if (!opts.url.endsWith(`/releases/download/v${opts.version}/Support-${opts.version}.pkg`)) fail(`the url must end in /releases/download/v${opts.version}/Support-${opts.version}.pkg`);
  assetBase = `Support-${opts.version}`;
  try {
    note = buildMacNote({ version: opts.version, sha256: createHash('sha256').update(exe).digest('hex'), size: exe.length, released, url: opts.url });
  } catch (_) {
    fail('the note is not valid: the url must be https://github.com/ and a path (at most 300 characters, no ? # space or ..), and the package at most 40 MiB');
  }
} else if (product === 'technician') {
  // The installer, built by `tauri build` and carrying the app's version. Its file name has to
  // carry that version too, so the wrong build is not signed under a newer number.
  let version;
  try {
    version = JSON.parse(readFileSync(join(opts.root, 'technician-app', 'package.json'), 'utf8')).version;
  } catch (_) {
    fail('cannot read technician-app/package.json');
  }
  if (version !== VERSION) fail(`technician-app is ${version} but the release is ${VERSION}: run scripts/bump-version.mjs`);
  // The version the installer carries is the crate's, not package.json's.
  let crate;
  try {
    crate = /^\[package\]\r?\n(?:(?!\[)[^\n]*\n)*?version = "([^"]*)"/m.exec(readFileSync(join(opts.root, 'technician-app', 'src-tauri', 'Cargo.toml'), 'utf8'))?.[1];
  } catch (_) {
    fail('cannot read technician-app/src-tauri/Cargo.toml');
  }
  if (crate !== VERSION) fail(`technician-app/src-tauri/Cargo.toml is ${crate ?? 'missing a version'} but the release is ${VERSION}: run scripts/bump-version.mjs`);
  try {
    exe = readFileSync(opts.file);
  } catch (_) {
    fail(`cannot read ${opts.file}`);
  }
  if (exe.length < 2 || exe[0] !== 77 || exe[1] !== 90) fail('the installer is not a Windows program');
  if (!basename(opts.file).includes(VERSION)) fail(`the installer's file name does not carry version ${VERSION}`);
  assetBase = `support-technician-${VERSION}-setup`;
  note = buildTechnicianNote({ version: VERSION, sha256: createHash('sha256').update(exe).digest('hex'), size: exe.length, released });
} else {
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
  exe = Buffer.from(typeof bundle.exe_b64 === 'string' ? bundle.exe_b64 : '', 'base64');
  if (exe.length < 2 || exe[0] !== 77 || exe[1] !== 90) fail('the bundle holds no exe');
  if (!exe.includes(Buffer.from(VERSION, 'utf16le'))) fail(`the bundle exe does not carry version ${VERSION}`);
  assetBase = `support-mcp-${VERSION}`;
  note = buildNote({ version: VERSION, sha256: createHash('sha256').update(exe).digest('hex'), size: exe.length, released });
}
const signature = sign('sha256', Buffer.from(note), { key: privateKey, dsaEncoding: 'ieee-p1363' });
if (!verify('sha256', Buffer.from(note), { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature)) fail(`the key does not match ${opts.pub}: nothing was signed`);

const b64 = signature.toString('base64');
if (opts.out) {
  mkdirSync(opts.out, { recursive: true });
  writeFileSync(join(opts.out, `${assetBase}.${product === 'mac' ? 'pkg' : 'exe'}`), exe);
  writeFileSync(join(opts.out, `${assetBase}.note`), note);
  writeFileSync(join(opts.out, `${assetBase}.note.sig`), `${b64}\n`);
}
if (product === 'mac') {
  process.stdout.write(`MAC_RELEASE_NOTE=${Buffer.from(note).toString('base64')}\nMAC_RELEASE_SIGNATURE=${b64}\n\n${note}`);
  console.error(`sign-release: signed the Mac package ${opts.version} at ${new Date(released * 1000).toISOString()}. Attach the package, note and signature to the GitHub release, then set both with wrangler secret put and deploy: the stages count from this time.`);
} else if (product === 'technician') {
  process.stdout.write(`TECHNICIAN_SIGNATURE=${b64}\nTECHNICIAN_SIGNED_AT=${released}\n\n${note}`);
  console.error(`sign-release: signed the technician installer ${VERSION} at ${new Date(released * 1000).toISOString()}. Attach the three files to the GitHub release.`);
} else {
  process.stdout.write(`RELEASE_SIGNATURE=${b64}\nRELEASE_SIGNED_AT=${released}\n\n${note}`);
  console.error(`sign-release: signed ${VERSION} at ${new Date(released * 1000).toISOString()}. Deploy now: the stages count from this time.`);
}
