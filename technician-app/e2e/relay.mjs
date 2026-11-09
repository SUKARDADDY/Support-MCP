// A real relay for the end-to-end run: `wrangler dev` on loopback with a local database, KV
// and Durable Objects. Access is not skipped (no DEV_SKIP_ACCESS), so the app signs in the
// way it does against a deployed relay, through the OAuth pages. DEV_SHOW_EMAIL_LINKS shows
// the emailed sign-in link on the page, which loopback only allows.
import { spawn } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// wrangler, pinned. WRANGLER overrides the command (a local install), for runs where `npx` should not fetch it.
export const defaultWrangler = () => (process.env.WRANGLER ? process.env.WRANGLER.split(' ') : ['npx', '--yes', 'wrangler@4.159.0']);

export const RELAY_PORT = 8787;
export const RELAY = `http://127.0.0.1:${RELAY_PORT}`;

// wrangler.e2e.toml is the repo's wrangler.toml without its custom-domain route (the Worker
// would see that host name instead of 127.0.0.1), and .dev.vars holds the local settings.
export function prepareConfig(root) {
  // A fresh local database every run: the sign-in walk sets up an authenticator, which a second run could not repeat.
  rmSync(join(root, '.wrangler', 'state'), { recursive: true, force: true });
  const toml = readFileSync(join(root, 'wrangler.toml'), 'utf8');
  const lines = toml.split('\n').filter((l) => !/^routes\s*=/.test(l));
  writeFileSync(join(root, 'wrangler.e2e.toml'), lines.join('\n'));
  writeFileSync(join(root, '.dev.vars'), [
    'AUTH_SECRET=e2e-only-secret-0123456789-0123456789-0123456789',
    'DEV_SHOW_EMAIL_LINKS=1',
    '',
  ].join('\n'));
}

export async function startRelay(root, { wrangler = defaultWrangler(), log = () => {} } = {}) {
  const child = spawn(wrangler[0], [...wrangler.slice(1), 'dev', '-c', 'wrangler.e2e.toml', '--port', String(RELAY_PORT), '--ip', '127.0.0.1'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32', env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' },
  });
  let output = '';
  for (const s of [child.stdout, child.stderr]) s.on('data', (d) => { output += d; log(String(d)); });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited early:\n${output}`);
    try {
      const r = await fetch(`${RELAY}/healthz`);
      if (r.ok) return { child, stop: () => stopTree(child) };
    } catch (_) {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  stopTree(child);
  throw new Error(`wrangler dev did not answer /healthz in 2 minutes:\n${output}`);
}

// wrangler starts workerd as a child, so the whole tree has to go.
export function stopTree(child) {
  if (child.exitCode !== null) return;
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/t', '/f']);
  else child.kill('SIGTERM');
}
