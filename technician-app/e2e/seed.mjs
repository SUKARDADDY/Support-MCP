// Seeds the local relay's database for the end-to-end run: the person who signs in (a
// technician, so the second factor applies) and one saved PC the device list must show.
//
// It runs `wrangler d1 ... --local --persist-to <the run's state folder>`, which writes into the
// same local state `wrangler dev` reads (relay.mjs, prepareConfig). Nothing here touches a real
// database, or the repository's own .wrangler/state.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defaultWrangler } from './relay.mjs';

// The version the app under test carries, so a version bump needs no edit here.
export const APP_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export const EMAIL = 'e2e-tech@example.com';
export const SEEDED_PC = 'E2E front counter';
const PC_ID = 'e2eseededpcaaaaaaaaa'; // 20 characters of a-z and 2-7, like a real id

export function seedSql(now = Date.now()) {
  return [
    `INSERT INTO members(workspace, identity, kind, name, role_id, added_at, added_by) VALUES ('default', '${EMAIL}', 'person', NULL, 'technician', ${now}, 'e2e');`,
    `INSERT INTO devices(workspace, id, site_id, status, name, access, control, owner_contact, os, machine, app_version, protocol, key_hash, confirm_hash, expires_at, paired_at, paired_by, approved_by, last_seen, fields)`
      + ` VALUES ('default', '${PC_ID}', NULL, 'active', '${SEEDED_PC}', 'ask', 'limited', '', 'Windows 11 Pro', 'E2E-PC', '${APP_VERSION}', 1, '${'0'.repeat(64)}', NULL, NULL, ${now}, 'e2e', NULL, ${now}, '{}');`,
  ].join('\n');
}

// Applies the migrations and the seed to the local database of `prepared` (relay.mjs, prepareConfig).
export function seed(prepared, { wrangler = defaultWrangler() } = {}) {
  const run = (args) => {
    const r = spawnSync(wrangler[0], [...wrangler.slice(1), ...args, '-c', prepared.config, '--persist-to', prepared.state], { cwd: prepared.dir, encoding: 'utf8', shell: process.platform === 'win32' });
    if (r.status !== 0) throw new Error(`wrangler ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
  };
  run(['d1', 'migrations', 'apply', 'support-mcp', '--local']);
  const dir = mkdtempSync(join(tmpdir(), 'support-e2e-seed-'));
  try {
    const file = join(dir, 'seed.sql');
    writeFileSync(file, seedSql());
    run(['d1', 'execute', 'support-mcp', '--local', '--file', file]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
