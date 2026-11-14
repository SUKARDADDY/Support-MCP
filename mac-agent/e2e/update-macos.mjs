// The Mac app's self-update, end to end on a macOS runner (docs/development.md, "Mac updates"). It needs root (sudo
// without a password, as GitHub's macOS runners have) and changes the machine: it installs Support, so run it only on
// a throwaway runner.
//
//   node mac-agent/e2e/update-macos.mjs keygen <dir>
//       Makes a throwaway P-256 release key: <dir>/test-key.pem (private) and <dir>/test-key.pub (64 bytes X||Y in
//       base64, as release-key.pub holds the real one). Prints the public key. The four test builds embed it with
//       SUPPORT_TEST_RELEASE_KEY; the real key is never used.
//
//   node mac-agent/e2e/update-macos.mjs run --key <dir>/test-key.pem --packages <dir>
//       <dir> holds Support-1.1.0.pkg (A), Support-1.1.1.pkg (B), Support-1.1.2.pkg (C) and Support-1.1.3.pkg (D), all
//       `test-release` builds with SUPPORT_TEST_DOWNLOAD_ORIGIN=http://127.0.0.1:8791. A and B are signed with one
//       throwaway identity, C with another, and D (signed like A) exits as soon as its service starts.
//
// It starts a stand-in relay on 127.0.0.1:8791 that answers check-ins as an active saved Mac, offers one signed release
// at a time (the note built by src/release.js, signed with the test key) and serves the packages at the paths of
// their notes' GitHub URLs, through a redirect. Then:
//
//   1. A is installed and checks in; offered B, it updates, and B checks in and commits its trial.
//   2. Offered C, signed by another identity, B refuses it: nothing changes, and update.json says why.
//   3. Offered D, B switches to it; D never checks in, and the watcher puts B back within the (test) trial time,
//      records D as failed and never downloads it again.
//
// Any failed check exits non-zero, after printing what the Mac's files say.
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, createPrivateKey, createHash, sign } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMacNote } from '../../src/release.js';

const PORT = 8791;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const DATA = '/Library/Application Support/SupportMCP';
const APP = '/Applications/Support.app';
const DAEMON = 'system/io.github.sukardaddy.supportmcp.device';
const WATCH_PLIST = '/Library/LaunchDaemons/io.github.sukardaddy.supportmcp.update.plist';
const VERSIONS = { A: '1.1.0', B: '1.1.1', C: '1.1.2', D: '1.1.3' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(message) {
  console.error(`update-macos: ${message}`);
  process.exit(2);
}

const [command, ...rest] = process.argv.slice(2);

if (command === 'keygen') {
  const dir = rest[0] ?? fail('keygen needs a folder');
  mkdirSync(dir, { recursive: true });
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const xy = Buffer.concat([Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64');
  writeFileSync(join(dir, 'test-key.pem'), privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  writeFileSync(join(dir, 'test-key.pub'), `${xy}\n`);
  console.log(xy);
  process.exit(0);
}

if (command !== 'run') fail('usage: update-macos.mjs keygen <dir> | run --key <pem> --packages <dir>');
const opt = (name) => {
  const i = rest.indexOf(name);
  return i >= 0 && rest[i + 1] ? rest[i + 1] : fail(`${name} is required`);
};
const key = createPrivateKey(readFileSync(opt('--key')));
const packages = opt('--packages');

// ---- the stand-in relay ------------------------------------------------------------------------------------------

const hellos = []; // { version, at }
const downloads = []; // paths asked for
let offer = null; // the update object of every answer, or null

function pkgPath(v) {
  return join(packages, `Support-${v}.pkg`);
}

function offerFor(v) {
  const bytes = readFileSync(pkgPath(v));
  const url = `https://github.com/example/support-mcp/releases/download/mac-v${v}/Support-${v}.pkg`;
  const note = buildMacNote({ version: v, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, released: Math.floor(Date.now() / 1000), url });
  const signature = sign('sha256', Buffer.from(note), { key, dsaEncoding: 'ieee-p1363' }).toString('base64');
  return { version: v, note, signature };
}

const server = createServer((req, res) => {
  const url = new URL(req.url, ORIGIN);
  const json = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.method === 'POST' && url.pathname.startsWith('/device/')) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let parsed = {};
      try {
        parsed = JSON.parse(body);
      } catch (_) {}
      if (url.pathname === '/device/hello') {
        hellos.push({ version: parsed.app_version, at: Date.now() });
        const answer = { protocol: 1, device: { status: 'active', access: 'any', control: 'full', name: 'CI Mac' } };
        if (offer) answer.update = offer;
        return json(200, answer);
      }
      json(200, { protocol: 1 });
    });
    return;
  }
  const release = /^\/example\/support-mcp\/releases\/download\/mac-v([^/]+)\/(Support-[^/]+\.pkg)$/.exec(url.pathname);
  if (req.method === 'GET' && release) {
    downloads.push(url.pathname);
    // As GitHub does: the release URL redirects to the asset's storage.
    res.writeHead(302, { location: `${ORIGIN}/assets/${release[2]}` });
    return res.end();
  }
  const asset = /^\/assets\/(Support-([^/]+)\.pkg)$/.exec(url.pathname);
  if (req.method === 'GET' && asset) {
    downloads.push(url.pathname);
    const bytes = readFileSync(pkgPath(asset[2]));
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length });
    return res.end(bytes);
  }
  json(404, { error: { code: 'not_found', message: 'no' } });
});

// ---- the Mac -----------------------------------------------------------------------------------------------------

function sudo(args, input) {
  const r = spawnSync('sudo', ['-n', ...args], { input, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`sudo ${args.join(' ')} exited ${r.status}: ${r.stderr}`);
  return r.stdout;
}

function sudoTry(args) {
  const r = spawnSync('sudo', ['-n', ...args], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout : null;
}

function version(app) {
  const out = sudoTry(['/usr/bin/plutil', '-extract', 'CFBundleShortVersionString', 'raw', `${app}/Contents/Info.plist`]);
  return out === null ? null : out.trim();
}

function updateJson() {
  const text = sudoTry(['/bin/cat', `${DATA}/update.json`]);
  return text === null ? {} : JSON.parse(text);
}

function history() {
  const text = sudoTry(['/bin/cat', `${DATA}/history.json`]);
  return text === null ? [] : JSON.parse(text);
}

function kickstart() {
  sudo(['/bin/launchctl', 'kickstart', '-k', DAEMON]);
}

const checks = [];
function check(name, ok, detail = '') {
  checks.push(name);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : `\n     ${detail}`}`);
  if (!ok) throw new Error(`check failed: ${name}`);
}

async function until(what, fn, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out after ${ms / 1000} s waiting for ${what}`);
    await sleep(500);
  }
}

const helloSince = (v, t) => hellos.some((h) => h.version === v && h.at >= t);

function diagnose() {
  console.log('---- what the Mac says ----');
  console.log('hellos:', JSON.stringify(hellos));
  console.log('downloads:', JSON.stringify(downloads));
  console.log('installed:', version(APP), 'previous:', version(`${DATA}/previous/Support.app`));
  console.log('update.json:', sudoTry(['/bin/cat', `${DATA}/update.json`]));
  console.log('history.json:', sudoTry(['/bin/cat', `${DATA}/history.json`]));
  console.log(sudoTry(['/bin/ls', '-la', DATA, `${DATA}/staging`]) ?? '');
  console.log(sudoTry(['/bin/launchctl', 'print', DAEMON]) ?? 'no service job');
  console.log(sudoTry(['/bin/launchctl', 'print', 'system/io.github.sukardaddy.supportmcp.update']) ?? 'no watcher job');
  console.log(spawnSync('/bin/ps', ['-axo', 'pid,uid,command'], { encoding: 'utf8' }).stdout.split('\n').filter((l) => /Support\.app|SupportMCP/.test(l)).join('\n'));
}

async function main() {
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

  // 1. A is installed and set up as an active saved Mac of the stand-in relay.
  sudo(['/usr/sbin/installer', '-pkg', pkgPath(VERSIONS.A), '-target', '/']);
  check('A is installed', version(APP) === VERSIONS.A, version(APP));
  const device = { origin: ORIGIN, key: 'smd1.ci.updatetest', device_id: 'ci', workspace: 'ci', name: 'CI Mac', access: 'any', control: 'full', state: 'active' };
  const tmp = mkdtempSync(join(tmpdir(), 'support-update-'));
  writeFileSync(join(tmp, 'device.json'), JSON.stringify(device));
  sudo(['/bin/mkdir', '-p', DATA]);
  sudo(['/bin/chmod', '700', DATA]);
  sudo(['/usr/bin/install', '-m', '600', '-o', 'root', '-g', 'wheel', join(tmp, 'device.json'), `${DATA}/device.json`]);
  rmSync(tmp, { recursive: true, force: true });

  // A updates to B, and B commits.
  offer = offerFor(VERSIONS.B);
  let t = Date.now();
  kickstart();
  await until('a check-in from A', () => helloSince(VERSIONS.A, t), 60_000);
  check('A checks in with the relay', true);
  await until('a check-in from B', () => helloSince(VERSIONS.B, t), 120_000);
  check('B was downloaded through the redirect', downloads.includes(`/example/support-mcp/releases/download/mac-v${VERSIONS.B}/Support-${VERSIONS.B}.pkg`) && downloads.includes(`/assets/Support-${VERSIONS.B}.pkg`), JSON.stringify(downloads));
  await until("B's commit", () => !updateJson().trial && history().includes(`Support updated to version ${VERSIONS.B}.`), 60_000);
  check('B is installed and committed', version(APP) === VERSIONS.B && !updateJson().trial, `${version(APP)} ${JSON.stringify(updateJson())}`);
  check('A is kept in previous/', version(`${DATA}/previous/Support.app`) === VERSIONS.A);
  check('the watcher is gone after the commit', sudoTry(['/bin/test', '-e', WATCH_PLIST]) === null);
  offer = null;

  // 2. C is signed by another identity: refused, and nothing changes.
  offer = offerFor(VERSIONS.C);
  t = Date.now();
  kickstart();
  await until('a check-in from B', () => helloSince(VERSIONS.B, t), 60_000);
  await until("C's refusal in update.json", () => updateJson().last_error?.version === VERSIONS.C, 60_000);
  const refused = updateJson();
  check('C was downloaded and refused for its signer', downloads.includes(`/assets/Support-${VERSIONS.C}.pkg`) && /not signed as this one is/.test(refused.last_error.reason), JSON.stringify(refused));
  check('B stays installed, with no trial', version(APP) === VERSIONS.B && !refused.trial);
  check('nothing of C is left in staging', !/update-/.test(sudoTry(['/bin/ls', `${DATA}/staging`]) ?? ''));
  check('C never checked in', !hellos.some((h) => h.version === VERSIONS.C));
  offer = null;

  // 3. D exits at start: B switches to it, the watcher puts B back at the deadline, and D is never taken again.
  offer = offerFor(VERSIONS.D);
  t = Date.now();
  kickstart();
  await until('the switch to D', () => version(APP) === VERSIONS.D, 120_000);
  const switched = Date.now();
  check('D is on trial', updateJson().trial?.version === VERSIONS.D, JSON.stringify(updateJson()));
  await until('the rollback to B', () => version(APP) === VERSIONS.B && !updateJson().trial, 240_000);
  const rolledBackIn = (Date.now() - switched) / 1000;
  check(`D was rolled back to B within 4 minutes (${rolledBackIn.toFixed(0)} s)`, rolledBackIn < 240);
  check('D is recorded as failed', (updateJson().failed ?? []).includes(VERSIONS.D), JSON.stringify(updateJson()));
  check('the history says so', history().includes(`Support couldn't update to version ${VERSIONS.D}, so it went back to version ${VERSIONS.B}.`), JSON.stringify(history()));
  check('D never checked in', !hellos.some((h) => h.version === VERSIONS.D));
  const back = Date.now();
  await until('a check-in from B after the rollback', () => helloSince(VERSIONS.B, back - 5_000), 60_000);
  check('B checks in again', true);
  check('the watcher is gone after the rollback', sudoTry(['/bin/test', '-e', WATCH_PLIST]) === null);
  // Offered again, D is not even downloaded.
  const before = downloads.length;
  t = Date.now();
  kickstart();
  await until('a check-in from B', () => helloSince(VERSIONS.B, t), 60_000);
  await sleep(5_000);
  check('a failed version is never downloaded again', downloads.length === before, JSON.stringify(downloads.slice(before)));
  console.log(`\nAll ${checks.length} checks passed.`);
}

main()
  .then(() => {
    server.close();
    process.exit(0);
  })
  .catch((e) => {
    console.error(e.stack ?? e);
    try {
      diagnose();
    } catch (_) {}
    server.close();
    process.exit(1);
  });
