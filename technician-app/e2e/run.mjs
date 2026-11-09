// The end-to-end run, on a Windows CI runner (docs/technician-app.md, "How it is tested").
//
//   APP_EXE=<installed support app, built with --features e2e> node e2e/run.mjs
//
// It starts a real relay (wrangler dev, local D1, KV and Durable Objects), seeds a technician
// and one saved PC, starts the installed app, and drives it. The app's web view is WebView2,
// opened to a debug port by a machine policy the CI job writes (the runner is elevated, so
// the environment variable that does the same for a normal user is ignored). The e2e build of
// the app writes its authorize address to a file instead of opening a browser; a Chromium of
// Playwright's own walks the sign-in pages (email link, authenticator set-up with a code worked
// out here, consent). Then the run attaches to the app and checks:
//   1. the device list shows the seeded PC's name
//   2. Add a device shows a pairing code
//   3. after a scripted POST /device/pair, a device_waiting item is in the app's notification list
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { RELAY, prepareConfig, startRelay } from './relay.mjs';
import { APP_VERSION, EMAIL, SEEDED_PC, seed } from './seed.mjs';
import { walkSignIn } from './signin.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CDP = 'http://127.0.0.1:9222';
const APP_EXE = process.env.APP_EXE;
const OUT = process.env.E2E_OUT ?? join(root, 'e2e-out');
const say = (m) => console.log(`[e2e ${new Date().toISOString().slice(11, 19)}] ${m}`);

if (!APP_EXE || !existsSync(APP_EXE)) {
  console.error('APP_EXE must name the installed app (built with --features e2e)');
  process.exit(2);
}

const until = async (what, fn, ms = 60_000) => {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ''}`);
};

let relay = null;
let prepared = null;
let app = null;
let appBrowser = null;
let ownBrowser = null;
let appPage = null;
let failed = false;

try {
  mkdirSync(OUT, { recursive: true });
  const workdir = mkdtempSync(join(tmpdir(), 'support-e2e-'));
  const authorizeFile = join(workdir, 'authorize.txt');

  say('preparing and seeding the relay');
  prepared = prepareConfig(root);
  seed(prepared);
  relay = await startRelay(prepared);
  say(`relay is up at ${RELAY}`);

  say(`starting the app: ${APP_EXE}`);
  app = spawn(APP_EXE, [], { env: { ...process.env, SUPPORT_E2E_AUTHORIZE_FILE: authorizeFile }, stdio: 'ignore' });
  app.on('exit', (code) => say(`the app exited with ${code}`));

  await until('the app web view debug port', async () => (await fetch(`${CDP}/json/version`)).ok, 90_000);
  appBrowser = await chromium.connectOverCDP(CDP);
  appPage = await until('the app page', () => appBrowser.contexts().flatMap((c) => c.pages()).find((p) => p.url().length > 0), 60_000);
  say(`attached to the app at ${appPage.url()}`);

  // Sign in from the app: its form, then the browser.
  await appPage.getByLabel('Relay address').fill(RELAY);
  await appPage.getByLabel('Team').fill('default');
  await appPage.getByRole('button', { name: 'Sign in with your browser' }).click();
  const authorizeUrl = await until('the authorize address file', () => (existsSync(authorizeFile) ? readFileSync(authorizeFile, 'utf8').trim() : null), 30_000);
  assert.ok(authorizeUrl.startsWith(`${RELAY}/oauth/authorize?`), authorizeUrl);

  ownBrowser = await chromium.launch();
  const page = await (await ownBrowser.newContext()).newPage();
  const walked = await walkSignIn(page, authorizeUrl, { email: EMAIL, say });
  assert.equal(walked.callback.hostname, '127.0.0.1');
  say('signed in through the browser');

  // 1. The device list shows the seeded PC.
  await appPage.getByRole('button', { name: new RegExp(SEEDED_PC) }).waitFor({ timeout: 60_000 });
  say(`the device list shows "${SEEDED_PC}"`);

  // 2. Add a device shows a pairing code.
  await appPage.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Add a device' }).click();
  await appPage.getByRole('button', { name: 'Get a pairing code' }).click();
  const code = (await appPage.getByTestId('pairing-code').textContent({ timeout: 30_000 })).trim();
  assert.match(code, /^[A-Z2-9-]{8,}$/, `a pairing code, got "${code}"`);
  say('Add a device shows a pairing code');

  // 3. A PC asks to join (the owner starts an install): a device_waiting item reaches the list.
  const joined = await fetch(`${RELAY}/device/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspace: 'default', name: 'E2E waiting PC', os: 'Windows 11', machine: 'E2E-WAIT', app_version: APP_VERSION, access: 'ask', control: 'limited', protocol: 1 }),
  });
  assert.equal(joined.status, 202, await joined.text());
  await appPage.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /Notifications/ }).click();
  const item = appPage.locator('li[data-event="device_waiting"]');
  await item.waitFor({ timeout: 30_000 });
  assert.match((await item.first().textContent()) ?? '', /E2E waiting PC/);
  say('a device_waiting item is in the notification list');
  say('the end-to-end run passed');
} catch (e) {
  failed = true;
  console.error(e);
  try {
    if (appPage) await appPage.screenshot({ path: join(OUT, 'app-failure.png') });
  } catch (_) {
    // the web view may be gone
  }
} finally {
  await ownBrowser?.close().catch(() => {});
  await appBrowser?.close().catch(() => {});
  if (app && app.exitCode === null) {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(app.pid), '/t', '/f']);
    else app.kill('SIGTERM');
  }
  relay?.stop();
  // wrangler's children can hold the process open: leave explicitly.
  setTimeout(() => {
    prepared?.cleanup();
    process.exit(failed ? 1 : 0);
  }, 1500);
}
