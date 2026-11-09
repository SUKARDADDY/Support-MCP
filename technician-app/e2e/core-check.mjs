// Runs src-tauri/tests/real_relay.rs against a real relay. It starts the relay, seeds it, starts
// the test, and plays the person in a browser: the test's sign-in writes the authorize address to
// a file, and this walks the relay's pages (email link, authenticator, consent) as the app's
// own browser would. It needs Rust, wrangler and Playwright's Chromium, and works on any system.
//
//   node e2e/core-check.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { RELAY, prepareConfig, startRelay } from './relay.mjs';
import { EMAIL, seed } from './seed.mjs';
import { walkSignIn } from './signin.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const say = (m) => console.log(`[core-check] ${m}`);
let relay = null;
let browser = null;
let test = null;
let failed = true;

try {
  prepareConfig(root);
  seed({ root });
  relay = await startRelay(root);
  say(`relay up at ${RELAY}`);
  const file = join(mkdtempSync(join(tmpdir(), 'support-core-check-')), 'authorize.txt');
  const done = new Promise((res) => {
    test = spawn('cargo', ['test', '--test', 'real_relay', '--', '--ignored', '--nocapture'], {
      cwd: join(here, '..', 'src-tauri'), stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, RELAY_URL: RELAY, AUTHORIZE_FILE: file },
    });
    test.on('exit', res);
  });
  const end = Date.now() + 600_000;
  while (!existsSync(file) && test.exitCode === null && Date.now() < end) await new Promise((r) => setTimeout(r, 500));
  assert.ok(existsSync(file), 'the core wrote no authorize address (the test may have failed to build)');
  const url = readFileSync(file, 'utf8').trim();
  browser = await chromium.launch();
  const page = await (await browser.newContext()).newPage();
  await walkSignIn(page, url, { email: EMAIL, say });
  const code = await done;
  assert.equal(code, 0, 'the real-relay test passed');
  failed = false;
  say('passed');
} catch (e) {
  console.error(e);
} finally {
  await browser?.close().catch(() => {});
  if (test && test.exitCode === null) test.kill();
  relay?.stop();
  setTimeout(() => process.exit(failed ? 1 : 0), 1500);
}
