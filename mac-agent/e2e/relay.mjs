// A real relay for the Mac core's end-to-end run: `wrangler dev` on loopback with a local database, KV and Durable
// Objects, and Access skipped (DEV_SKIP_ACCESS=1, which src/jwt.js honours only for a request to 127.0.0.1 or
// localhost). Everything lives in a folder of its own under the system's temp folder and is removed at the end. The
// repository's own .wrangler/state and .dev.vars are never read or written.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// wrangler, pinned. WRANGLER overrides the command (a local install), for runs where `npx` should not fetch it.
export const defaultWrangler = () => (process.env.WRANGLER ? process.env.WRANGLER.split(' ') : ['npx', '--yes', 'wrangler@4.159.0']);

// A free loopback port, so a developer's own `wrangler dev` on 8787 is left alone.
export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// The repo's wrangler.toml without its custom-domain route (the Worker would see that host name instead of
// 127.0.0.1), with its paths made absolute because the file lives in the run's folder.
export function prepareConfig(root) {
  const dir = mkdtempSync(join(tmpdir(), 'support-mac-e2e-'));
  const absolute = (path) => JSON.stringify(join(root, path));
  const toml = readFileSync(join(root, 'wrangler.toml'), 'utf8')
    .split('\n')
    .filter((l) => !/^routes\s*=/.test(l))
    .map((l) => l
      .replace(/^main\s*=\s*"([^"]*)"\s*$/, (_, p) => `main = ${absolute(p)}`)
      .replace(/^migrations_dir\s*=\s*"([^"]*)"\s*$/, (_, p) => `migrations_dir = ${absolute(p)}`));
  writeFileSync(join(dir, 'wrangler.toml'), toml.join('\n'));
  writeFileSync(join(dir, '.dev.vars'), ['AUTH_SECRET=e2e-only-secret-0123456789-0123456789-0123456789', 'DEV_SKIP_ACCESS=1', ''].join('\n'));
  return {
    dir,
    config: join(dir, 'wrangler.toml'),
    state: join(dir, 'state'),
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (_) {
        // a file wrangler still holds: the system's temp cleaner gets it
      }
    },
  };
}

// Runs a wrangler command against the run's own local state. Throws with its output on failure.
export function wranglerRun(prepared, args, { wrangler = defaultWrangler() } = {}) {
  const r = spawnSync(wrangler[0], [...wrangler.slice(1), ...args, '-c', prepared.config, '--persist-to', prepared.state], {
    cwd: prepared.dir, encoding: 'utf8', env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' },
  });
  if (r.status !== 0) throw new Error(`wrangler ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

// Starts `wrangler dev` on `port` and waits for /healthz. `stop()` ends the whole process group (wrangler starts
// workerd as a child).
export async function startRelay(prepared, port, { wrangler = defaultWrangler(), log = () => {} } = {}) {
  const child = spawn(wrangler[0], [...wrangler.slice(1), 'dev', '-c', prepared.config, '--persist-to', prepared.state, '--port', String(port), '--ip', '127.0.0.1'], {
    cwd: prepared.dir, stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' },
  });
  let output = '';
  for (const s of [child.stdout, child.stderr]) s.on('data', (d) => { output += d; log(String(d)); });
  const stop = () => {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch (_) {
      // already gone
    }
  };
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited early:\n${output}`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return { child, stop };
    } catch (_) {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  stop();
  throw new Error(`wrangler dev did not answer /healthz in 2 minutes:\n${output}`);
}
