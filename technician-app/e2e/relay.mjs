// A real relay for the end-to-end run: `wrangler dev` on loopback with a local database, KV
// and Durable Objects. Access is not skipped (no DEV_SKIP_ACCESS), so the app signs in the
// way it does against a deployed relay, through the OAuth pages. DEV_SHOW_EMAIL_LINKS shows
// the emailed sign-in link on the page, which loopback only allows.
//
// Nothing here touches the repository's own relay state: the run keeps its config, its
// .dev.vars and its database in a folder of its own under the system's temp folder, and
// removes it at the end. A developer's .wrangler/state and .dev.vars stay as they were.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// wrangler, pinned. WRANGLER overrides the command (a local install), for runs where `npx` should not fetch it.
export const defaultWrangler = () => (process.env.WRANGLER ? process.env.WRANGLER.split(' ') : ['npx', '--yes', 'wrangler@4.159.0']);

export const RELAY_PORT = 8787;
export const RELAY = `http://127.0.0.1:${RELAY_PORT}`;

// Makes the run's own folder and returns where everything is:
//   config   the repo's wrangler.toml without its custom-domain route (the Worker would see
//            that host name instead of 127.0.0.1), and with its paths made absolute because the
//            file lives here, not in the repo
//   state    the local database, KV and Durable Object files (wrangler's --persist-to), empty
//            at the start: the sign-in walk sets up an authenticator, which a second run on the
//            same database could not repeat
//   .dev.vars  the local settings, next to the config, which is where wrangler reads them; the
//            repo's own .dev.vars is never read
// `cleanup` removes the folder.
export function prepareConfig(root) {
  const dir = mkdtempSync(join(tmpdir(), 'support-relay-e2e-'));
  const absolute = (path) => JSON.stringify(join(root, path));
  const toml = readFileSync(join(root, 'wrangler.toml'), 'utf8')
    .split('\n')
    .filter((l) => !/^routes\s*=/.test(l))
    .map((l) => l
      .replace(/^main\s*=\s*"([^"]*)"\s*$/, (_, p) => `main = ${absolute(p)}`)
      .replace(/^migrations_dir\s*=\s*"([^"]*)"\s*$/, (_, p) => `migrations_dir = ${absolute(p)}`));
  writeFileSync(join(dir, 'wrangler.toml'), toml.join('\n'));
  writeFileSync(join(dir, '.dev.vars'), [
    'AUTH_SECRET=e2e-only-secret-0123456789-0123456789-0123456789',
    'DEV_SHOW_EMAIL_LINKS=1',
    '',
  ].join('\n'));
  return {
    dir,
    config: join(dir, 'wrangler.toml'),
    state: join(dir, 'state'),
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (_) {
        // a file wrangler still holds (Windows): the system's temp folder cleaner gets it
      }
    },
  };
}

export async function startRelay(prepared, { wrangler = defaultWrangler(), log = () => {} } = {}) {
  const child = spawn(wrangler[0], [...wrangler.slice(1), 'dev', '-c', prepared.config, '--persist-to', prepared.state, '--port', String(RELAY_PORT), '--ip', '127.0.0.1'], {
    cwd: prepared.dir, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32', env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' },
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
