// Team data: the permission table, open mode, role checks on MCP tool calls,
// the chained team log, and workspace separation. Runs on the node:sqlite D1
// stand-in in test/d1-fake.js with every migration in migrations/ applied.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { openD1, handle } from './d1-fake.js';
import { listTools } from '../src/mcp.js';
import { createHandler } from '../src/app.js';
import { Session } from '../src/session.js';
import { Registry } from '../src/registry.js';
import { BUILTIN_ROLES, OPEN_PERMISSIONS, PERMISSIONS, normalizePermissions, permissionForTool } from '../src/permissions.js';
import { GENESIS_HASH, MAX_WORKSPACES, TeamError, chainHash, teamStore } from '../src/workspace.js';

const SID = 'a'.repeat(64);
const W = 'default';

// A Session binding that records every call and answers like an attached PC.
function fakeSessions() {
  const calls = [];
  const SESSION = {
    idFromName: () => ({ toString: () => SID }),
    idFromString: (s) => s,
    get: () => ({
      fetch: async (u, init) => {
        const url = new URL(typeof u === 'string' ? u : u.url);
        calls.push({ path: url.pathname, search: url.search, body: init?.body ? JSON.parse(init.body) : null });
        if (url.pathname === '/create') return Response.json({ ok: true, sid: SID, code_expires_at: 1 });
        if (url.pathname === '/command') return Response.json({ ok: true, exit_code: 0, stdout: 'done', stderr: '', timed_out: false });
        if (url.pathname === '/status') return Response.json({ state: 'attached' });
        return Response.json({ ended: true });
      },
    }),
  };
  const REGISTRY = { idFromName: (n) => n, get: () => ({ fetch: async () => Response.json({ sessions: [{ sid: SID }] }) }) };
  return { calls, SESSION, REGISTRY };
}

const handler = createHandler('powershell agent');
async function mcp(env, name, args = {}) {
  const r = await handler.fetch(new Request('http://127.0.0.1:8787/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  }), env);
  return (await r.json()).result;
}

// ---- the permission table ----------------------------------------------------
test('every tool the MCP endpoint lists needs a known permission', () => {
  for (const ui of [true, false]) {
    for (const t of listTools({ ui })) {
      const p = permissionForTool(t.name);
      assert.ok(PERMISSIONS.includes(p), `${t.name} (ui=${ui ? 1 : 0}) has no permission`);
    }
  }
  assert.equal(permissionForTool('session_create'), 'sessions.create');
  assert.equal(permissionForTool('session_list'), 'sessions.view');
  assert.equal(permissionForTool('session_status'), 'sessions.view');
  assert.equal(permissionForTool('session_end'), 'sessions.end');
  for (const name of ['run', 'put_file', 'get_file', 'click', 'type_secret', 'request_full_control', 'ui_act']) {
    assert.equal(permissionForTool(name), 'sessions.control', name);
  }
  for (const name of ['nope', 'toString', '__proto__', '', undefined]) assert.equal(permissionForTool(name), null, String(name));
});

test('the built-in roles and permission keys are as specified', () => {
  assert.deepEqual(PERMISSIONS, ['members.manage', 'roles.manage', 'audit.view', 'devices.view', 'devices.manage', 'fields.manage', 'sessions.create', 'sessions.view', 'sessions.control', 'sessions.end', 'sessions.unattended']);
  assert.deepEqual(BUILTIN_ROLES.admin.permissions, PERMISSIONS);
  assert.deepEqual(BUILTIN_ROLES.technician.permissions, ['devices.view', 'devices.manage', 'sessions.create', 'sessions.view', 'sessions.control', 'sessions.end']);
  assert.deepEqual(BUILTIN_ROLES.viewer.permissions, ['audit.view', 'devices.view', 'sessions.view']);
  assert.ok(!PERMISSIONS.some((p) => /system/.test(p)), 'there is no separate SYSTEM permission');
  assert.deepEqual(normalizePermissions(['sessions.end', 'audit.view', 'audit.view']), ['audit.view', 'sessions.end']);
  assert.throws(() => normalizePermissions(['sessions.control_system']), /unknown permission/);
  assert.throws(() => normalizePermissions('audit.view'));
});

// ---- the D1 stand-in ---------------------------------------------------------
test('the D1 stand-in commits a batch whole or not at all', async () => {
  const db = openD1();
  const ins = (seq) => db.prepare("INSERT INTO audit VALUES ('default', ?, 1, 'a', 'k', 'd', 'p', 'h')").bind(seq);
  await db.batch([ins(1)]);
  await assert.rejects(db.batch([ins(2), ins(1)]), /UNIQUE constraint failed: audit\./);
  assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM audit').first('n'), 1, 'the first insert rolled back');
  await assert.rejects(async () => db.prepare('SELECT ?').bind(undefined).first(), /D1_TYPE_ERROR/);
});

// ---- open mode -----------------------------------------------------------------
test('with no members any Access caller holds the sessions permissions and can run a command, as today', async () => {
  const db = openD1();
  const team = teamStore(db);
  for (const p of OPEN_PERMISSIONS) assert.deepEqual(await team.authorize(W, 'anyone@example.com', p), { ok: true, open: true, role_id: null });
  // Nothing that changes the team or reads its log is held while open.
  for (const p of PERMISSIONS.filter((x) => !OPEN_PERMISSIONS.includes(x))) {
    assert.deepEqual(await team.authorize(W, 'anyone@example.com', p), { ok: false, open: true, role_id: null, reason: 'open' }, p);
  }
  const s = fakeSessions();
  const env = { DEV_SKIP_ACCESS: '1', DB: db, ...s };
  const created = await mcp(env, 'session_create', {});
  assert.ok(!created.isError, created.content[0].text);
  const run = await mcp(env, 'run', { session_id: SID, command: 'whoami' });
  assert.ok(!run.isError, run.content[0].text);
  assert.equal(JSON.parse(run.content[0].text).stdout, 'done');
  assert.deepEqual(s.calls.map((c) => c.path), ['/create', '/command']);
  // The session is created in the default workspace, and the command names it.
  assert.equal(s.calls[0].body.workspace, 'default');
  assert.equal(s.calls[1].body.workspace, 'default');
  assert.equal(s.calls[1].body.actor, 'local-dev', 'the audit actor is unchanged');
  // Open mode lists who has been calling, so an admin can add them.
  assert.deepEqual((await team.recentCallers(W)).map((c) => c.identity).sort(), ['anyone@example.com', 'local-dev']);
});

test('tools/list never touches the team database', async () => {
  const trap = { prepare() { throw new Error('DB touched'); }, batch() { throw new Error('DB touched'); } };
  const r = await handler.fetch(new Request('http://127.0.0.1:8787/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  }), { DEV_SKIP_ACCESS: '1', DB: trap, ...fakeSessions() });
  assert.equal((await r.json()).result.tools.length, 24);
});

test('a tool call without a team database is refused and never reaches a session', async () => {
  const s = fakeSessions();
  const out = await mcp({ DEV_SKIP_ACCESS: '1', ...s }, 'run', { session_id: SID, command: 'whoami' });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /team database/);
  assert.deepEqual(s.calls, []);
});

// ---- roles on tool calls ---------------------------------------------------------
test('a Viewer can list and read status; run is refused naming the permission, and nothing reaches the session', async () => {
  const db = openD1();
  const team = teamStore(db);
  await team.addMember(W, 'boss@example.com', { identity: 'boss@example.com', role_id: 'admin' });
  await team.addMember(W, 'boss@example.com', { identity: 'local-dev', role_id: 'viewer' });
  const s = fakeSessions();
  const env = { DEV_SKIP_ACCESS: '1', DB: db, ...s };
  const list = await mcp(env, 'session_list');
  assert.ok(!list.isError);
  assert.deepEqual(JSON.parse(list.content[0].text), { sessions: [{ sid: SID }] });
  assert.ok(!(await mcp(env, 'session_status', { session_id: SID })).isError);
  assert.equal(s.calls.at(-1).search, '?log_tail=20&workspace=default');
  s.calls.length = 0;
  for (const [name, args] of [['run', { command: 'whoami' }], ['click', { x: 1, y: 2 }], ['type_secret', { text: 'pw' }], ['put_file', { path: 'x', data_b64: '' }]]) {
    const out = await mcp(env, name, { session_id: SID, ...args });
    assert.deepEqual(out, { content: [{ type: 'text', text: 'your role does not allow sessions.control' }], isError: true }, name);
  }
  for (const [name, perm] of [['session_create', 'sessions.create'], ['session_end', 'sessions.end']]) {
    const out = await mcp(env, name, name === 'session_end' ? { session_id: SID } : {});
    assert.equal(out.content[0].text, `your role does not allow ${perm}`);
  }
  assert.deepEqual(s.calls, [], 'no refused command reached the session');
});

test('a technician can run and end, and identities match trimmed and in any case', async () => {
  const db = openD1();
  const team = teamStore(db);
  await team.addMember(W, 'Boss@Example.com', { identity: ' boss@example.com ', role_id: 'admin' });
  await team.addMember(W, 'boss@example.com', { identity: 'Tech@Example.com', role_id: 'technician' });
  assert.equal((await team.authorize(W, '  TECH@example.COM ', 'sessions.control')).ok, true);
  assert.deepEqual(await team.authorize(W, 'tech@example.com', 'members.manage'), { ok: false, open: false, role_id: 'technician', reason: 'permission' });
  assert.deepEqual(await team.authorize(W, 'stranger@example.com', 'sessions.view'), { ok: false, open: false, role_id: null, reason: 'not_member' });
});

test('authorize takes a permission key and nothing else', async () => {
  const team = teamStore(openD1());
  assert.equal(team.authorize.length, 3);
  for (const bad of [{ permission: 'sessions.control' }, 'run', 'sessions.control_system', undefined, ['sessions.view']]) {
    await assert.rejects(team.authorize(W, 'a@example.com', bad), TypeError);
  }
  await assert.rejects(team.authorize('', 'a@example.com', 'sessions.view'), TypeError);
});

// ---- the chained log -------------------------------------------------------------
async function seeded() {
  const db = openD1();
  const team = teamStore(db);
  await team.addMember(W, 'boss@example.com', { identity: 'boss@example.com', role_id: 'admin' });
  await team.addMember(W, 'boss@example.com', { identity: 'tech@example.com', role_id: 'technician' });
  await team.addRole(W, 'boss@example.com', { id: 'auditor', permissions: ['audit.view'] });
  await team.updateMember(W, 'boss@example.com', 'tech@example.com', { role_id: 'auditor' });
  await team.removeMember(W, 'boss@example.com', 'tech@example.com');
  return { db, team };
}

test('every team change writes one chained log row, sealed from the genesis hash', async () => {
  const { team } = await seeded();
  const { rows, head, verified } = await team.readAudit(W);
  assert.equal(verified, true);
  assert.deepEqual(rows.map((r) => [r.seq, r.actor, r.kind, r.detail]), [
    [1, 'boss@example.com', 'member_added', 'boss@example.com as admin'],
    [2, 'boss@example.com', 'roles_turned_on', 'first admin boss@example.com'],
    [3, 'boss@example.com', 'member_added', 'tech@example.com as technician'],
    [4, 'boss@example.com', 'role_added', 'auditor audit.view'],
    [5, 'boss@example.com', 'member_changed', 'tech@example.com role technician to auditor'],
    [6, 'boss@example.com', 'member_removed', 'tech@example.com'],
  ]);
  assert.equal(rows[0].prev_hash, GENESIS_HASH);
  for (let i = 1; i < rows.length; i++) assert.equal(rows[i].prev_hash, rows[i - 1].hash);
  const r = rows[2];
  const { createHash } = await import('node:crypto');
  assert.equal(r.hash, createHash('sha256').update(`${r.prev_hash}\n${r.seq}\n${r.ts}\n${r.actor}\n${r.kind}\n${r.detail}`).digest('hex'));
  assert.deepEqual(head, { seq: 6, hash: rows[5].hash });
});

test('editing any log entry makes verification fail', async () => {
  for (const [column, value] of [['detail', "'tech@example.com as admin'"], ['actor', "'mallory@example.com'"], ['kind', "'member_changed'"], ['ts', 'ts + 1'], ['hash', "'" + 'f'.repeat(64) + "'"]]) {
    for (const seq of [1, 3, 6]) {
      const { db, team } = await seeded();
      db.sqlite.exec(`UPDATE audit SET ${column} = ${value} WHERE workspace = 'default' AND seq = ${seq}`);
      const v = await team.verifyAudit(W);
      assert.equal(v.ok, false, `${column} of row ${seq}`);
      assert.equal(v.bad_seq, seq, `${column} of row ${seq}`);
      assert.equal((await team.readAudit(W)).verified, false);
    }
  }
  // A row edited and resealed breaks the next row's link.
  const { db, team } = await seeded();
  const row = { ...db.sqlite.prepare("SELECT * FROM audit WHERE workspace = 'default' AND seq = 3").get() };
  row.detail = 'tech@example.com as admin';
  const hash = await chainHash(row);
  db.sqlite.prepare("UPDATE audit SET detail = ?, hash = ? WHERE workspace = 'default' AND seq = 3").run(row.detail, hash);
  assert.deepEqual([(await team.verifyAudit(W)).ok, (await team.verifyAudit(W)).bad_seq], [false, 4]);
  // A deleted row leaves a gap.
  const gap = await seeded();
  gap.db.sqlite.exec("DELETE FROM audit WHERE workspace = 'default' AND seq = 2");
  assert.equal((await gap.team.verifyAudit(W)).ok, false);
});

// Count the rows each read statement returns.
function countRows(db) {
  const counter = { rows: 0 };
  const prepare = db.prepare;
  const wrap = (st) => ({
    ...st,
    bind: (...p) => wrap(st.bind(...p)),
    all: async () => { const r = await st.all(); counter.rows += r.results.length; return r; },
    first: async (col) => { const r = await st.first(col); if (r !== null && r !== undefined) counter.rows++; return r; },
  });
  db.prepare = (sql) => wrap(prepare(sql));
  return counter;
}

async function longLog(n = 30) {
  const db = openD1();
  const team = teamStore(db);
  await team.addMember(W, 'boss@example.com', { identity: 'boss@example.com', role_id: 'admin' });
  for (let i = 0; i < n; i++) await team.addMember(W, 'boss@example.com', { identity: `u${i}@example.com`, role_id: 'viewer' });
  return { db, team };
}

test('a page read checks only the rows it returns, and reads at most limit + 2 of them', async () => {
  const { db, team } = await longLog();
  const total = 32;
  const counter = countRows(db);
  const page = await team.readAudit(W, { after: 10, limit: 5 });
  assert.deepEqual([page.rows.map((r) => r.seq), page.verified, page.verified_scope, page.head.seq], [[11, 12, 13, 14, 15], true, 'page', total]);
  assert.equal(counter.rows, 1 + 5 + 1 + 1, 'the row before the page, the page, the row after it, and the head');
  // The first page has no row before it, so it reads one row fewer.
  counter.rows = 0;
  assert.deepEqual([(await team.readAudit(W, { limit: 3 })).verified, counter.rows], [true, 3 + 1 + 1]);
  // The newest rows have no row after them.
  counter.rows = 0;
  assert.deepEqual([(await team.readAudit(W, { after: 31, limit: 5 })).rows.length, counter.rows], [1, 1 + 1 + 1]);
  // The full check reads the whole chain, and only the page rows besides: no anchor, no next row.
  counter.rows = 0;
  const full = await team.readAudit(W, { after: 10, limit: 5, full: true });
  assert.deepEqual([full.rows.map((r) => r.seq), full.verified, full.verified_scope, counter.rows], [[11, 12, 13, 14, 15], true, 'full', 5 + total]);
  // An empty page verifies, in page scope.
  const empty = await team.readAudit(W, { after: 500 });
  assert.deepEqual([empty.rows, empty.verified, empty.verified_scope, empty.head.seq], [[], true, 'page', total]);
});

test('tampering on the returned page fails the page check; tampering elsewhere fails only verify=full', async () => {
  for (const [column, value] of [['detail', "'x@example.com as admin'"], ['actor', "'mallory@example.com'"], ['hash', "'" + 'f'.repeat(64) + "'"], ['prev_hash', "'" + 'e'.repeat(64) + "'"]]) {
    for (const seq of [11, 13, 15]) {
      const { db, team } = await longLog();
      db.sqlite.exec(`UPDATE audit SET ${column} = ${value} WHERE workspace = 'default' AND seq = ${seq}`);
      assert.equal((await team.readAudit(W, { after: 10, limit: 5 })).verified, false, `${column} of row ${seq}`);
    }
  }
  // Rows outside the page 11 to 15, before and after it.
  for (const seq of [2, 9, 20, 32]) {
    const { db, team } = await longLog();
    db.sqlite.exec(`UPDATE audit SET detail = 'x@example.com as admin' WHERE workspace = 'default' AND seq = ${seq}`);
    const page = await team.readAudit(W, { after: 10, limit: 5 });
    assert.deepEqual([page.verified, page.verified_scope], [true, 'page'], `row ${seq}`);
    const full = await team.readAudit(W, { after: 10, limit: 5, full: true });
    assert.deepEqual([full.verified, full.verified_scope], [false, 'full'], `row ${seq}`);
  }
  // The row just before the page is its anchor: a changed seal there breaks the first link.
  const { db, team } = await longLog();
  db.sqlite.exec(`UPDATE audit SET hash = '${'d'.repeat(64)}' WHERE workspace = 'default' AND seq = 10`);
  assert.equal((await team.readAudit(W, { after: 10, limit: 5 })).verified, false);
  // A deleted row leaves a gap: inside the page, or between the anchor and the page.
  const gap = await longLog();
  gap.db.sqlite.exec("DELETE FROM audit WHERE workspace = 'default' AND seq = 13");
  assert.equal((await gap.team.readAudit(W, { after: 10, limit: 5 })).verified, false);
  const before = await longLog();
  before.db.sqlite.exec("DELETE FROM audit WHERE workspace = 'default' AND seq = 11");
  assert.equal((await before.team.readAudit(W, { after: 10, limit: 5 })).verified, false);
  // A first page whose row 1 is gone has no anchor.
  const first = await longLog();
  first.db.sqlite.exec("DELETE FROM audit WHERE workspace = 'default' AND seq = 1");
  assert.equal((await first.team.readAudit(W, { limit: 5 })).verified, false);
});

test('a page check sees the last returned row edited and resealed, unless that row is the newest of the log', async () => {
  const reseal = async (db, seq) => {
    const row = { ...db.sqlite.prepare(`SELECT * FROM audit WHERE workspace = 'default' AND seq = ${seq}`).get() };
    row.detail = 'x@example.com as admin';
    db.sqlite.prepare("UPDATE audit SET detail = ?, hash = ? WHERE workspace = 'default' AND seq = ?").run(row.detail, await chainHash(row), seq);
  };
  // Row 15 ends the page and is not the newest: row 16 no longer links to it.
  const { db, team } = await longLog();
  assert.equal((await team.readAudit(W, { after: 10, limit: 5 })).verified, true);
  await reseal(db, 15);
  assert.equal((await team.readAudit(W, { after: 10, limit: 5 })).verified, false);
  assert.equal((await team.readAudit(W, { after: 10, limit: 5, full: true })).verified, false);
  // The same from the first page (no anchor to lean on), and for a page of one row.
  const first = await longLog();
  await reseal(first.db, 3);
  assert.equal((await first.team.readAudit(W, { limit: 3 })).verified, false);
  assert.equal((await first.team.readAudit(W, { after: 2, limit: 1 })).verified, false);
  // The row after the page vanishing leaves a gap after the last row.
  const gap = await longLog();
  gap.db.sqlite.exec("DELETE FROM audit WHERE workspace = 'default' AND seq = 16");
  assert.equal((await gap.team.readAudit(W, { after: 10, limit: 5 })).verified, false);
  // Only the newest row has nothing after it: a page check cannot see it resealed. The head moves.
  const newest = await longLog();
  const before = (await newest.team.readAudit(W, { after: 30 })).head;
  await reseal(newest.db, 32);
  const page = await newest.team.readAudit(W, { after: 30 });
  assert.deepEqual([page.verified, page.head.seq], [true, 32]);
  assert.notEqual(page.head.hash, before.hash, 'the head changed, so a noted head catches it');
});

test('50 changes at once leave a gapless, valid chain', async () => {
  const db = openD1();
  const team = teamStore(db);
  await team.addMember(W, 'boss@example.com', { identity: 'boss@example.com', role_id: 'admin' });
  const results = await Promise.allSettled(Array.from({ length: 50 }, (_, i) =>
    team.addMember(W, 'boss@example.com', { identity: `user${i}@example.com`, role_id: 'viewer' })));
  const failed = results.filter((r) => r.status === 'rejected');
  // A change that loses every retry answers busy; it never forks the chain.
  for (const f of failed) assert.equal(f.reason.code, 'busy');
  assert.ok(failed.length <= 10, `${failed.length} of 50 changes gave up`);
  const ok = 50 - failed.length;
  const { rows, head, verified } = await team.readAudit(W, { limit: 500 });
  assert.equal(verified, true);
  assert.deepEqual(rows.map((r) => r.seq), Array.from({ length: 2 + ok }, (_, i) => i + 1));
  assert.equal(head.seq, 2 + ok);
  assert.equal((await team.listMembers(W)).length, 1 + ok, 'every logged change happened, and only those');
});

test('two Worker instances writing at once: the loser of the log number retries, and the chain stays valid', async () => {
  const first = openD1();
  const second = handle(first.sqlite);
  const a = teamStore(first);
  const b = teamStore(second);
  await a.addMember(W, 'boss@example.com', { identity: 'boss@example.com', role_id: 'admin' });
  await Promise.all([
    a.addMember(W, 'boss@example.com', { identity: 'one@example.com', role_id: 'viewer' }),
    b.addMember(W, 'boss@example.com', { identity: 'two@example.com', role_id: 'viewer' }),
  ]);
  assert.equal(first.failedBatches + second.failedBatches, 1, 'both read the same head, so one batch collided and retried');
  const v = await a.verifyAudit(W);
  assert.deepEqual([v.ok, v.head.seq], [true, 4]);
});

test('the rule check sits inside the changing SQL, so a change that lands after the read is still caught', async () => {
  const db = openD1();
  const team = teamStore(db);
  await team.addMember(W, 'boss@example.com', { identity: 'boss@example.com', role_id: 'admin' });
  await team.addMember(W, 'boss@example.com', { identity: 'second@example.com', role_id: 'admin' });
  // Between the store's read (two admins) and its batch, the other admin loses
  // the role by a write that takes no log number, so only the SQL can see it.
  const batch = db.batch;
  let sneaked = false;
  db.batch = async (statements) => {
    if (!sneaked) {
      sneaked = true;
      db.sqlite.exec("UPDATE members SET role_id = 'viewer' WHERE workspace = 'default' AND identity = 'second@example.com'");
    }
    return batch(statements);
  };
  await assert.rejects(team.updateMember(W, 'boss@example.com', 'boss@example.com', { role_id: 'viewer' }), { status: 409, code: 'last_admin' });
  assert.equal((await team.getMember(W, 'boss@example.com')).role_id, 'admin');
  const { rows, verified } = await team.readAudit(W);
  assert.deepEqual([rows.length, verified], [3, true], 'the refused change wrote no log row');
});

// ---- workspace separation --------------------------------------------------------
test("another workspace's rows never appear in the default workspace", async () => {
  const db = openD1();
  const team = teamStore(db);
  await teamStore(db, { deploymentAdmins: 'eve@example.com' }).createWorkspace('eve@example.com', { slug: 'other', name: 'Other' });
  await team.addMember('other', 'eve@example.com', { identity: 'mallory@example.com', role_id: 'technician' });
  await team.addRole('other', 'eve@example.com', { id: 'spy', permissions: ['sessions.view'] });
  await team.removeRole('other', 'eve@example.com', 'viewer');
  await team.authorize('other', 'eve@example.com', 'sessions.view');
  assert.equal((await team.listMembers('other')).length, 2);

  assert.deepEqual(await team.listMembers(W), []);
  assert.deepEqual((await team.listRoles(W)).map((r) => r.id), ['admin', 'technician', 'viewer']);
  assert.deepEqual((await team.readAudit(W)).rows, []);
  assert.deepEqual((await team.readAudit(W)).head, { seq: 0, hash: GENESIS_HASH });
  // Default is still open, and eve is no member of it.
  assert.equal((await team.authorize(W, 'eve@example.com', 'sessions.view')).open, true);
  await team.addMember(W, 'boss@example.com', { identity: 'boss@example.com', role_id: 'admin' });
  assert.equal((await team.authorize(W, 'eve@example.com', 'sessions.view')).reason, 'not_member');
  assert.equal((await team.authorize(W, 'mallory@example.com', 'sessions.control')).reason, 'not_member');
  assert.equal((await team.readAudit(W)).rows.length, 2, 'default has its own chain from seq 1');
  assert.equal((await team.verifyAudit('other')).ok, true);
  // Every statement the store ran named a workspace.
  for (const { sql } of db.seen) assert.match(sql, /workspace/, sql);
});

test('team errors carry an HTTP status and a code', () => {
  const e = new TeamError(409, 'last_admin', 'x');
  assert.deepEqual([e.status, e.code, e.message], [409, 'last_admin', 'x']);
});

// ---- escalation: the SQL guard holds when the state moves after the read -----------
async function leadTeam() {
  const db = openD1();
  const team = teamStore(db);
  const boss = 'boss@example.com';
  await team.addMember(W, boss, { identity: boss, role_id: 'admin' });
  await team.addMember(W, boss, { identity: 'second@example.com', role_id: 'admin' });
  await team.addRole(W, boss, { id: 'lead', permissions: ['members.manage', 'sessions.view'] });
  await team.addRole(W, boss, { id: 'sv', permissions: ['sessions.view'] });
  await team.addMember(W, boss, { identity: 'lead@example.com', role_id: 'lead' });
  return { db, team, boss };
}
const within403 = { status: 403, code: 'forbidden', message: /within your own permissions/ };
// Run `sneak` once, after the store has planned and before its batch commits.
function sneakBeforeBatch(db, sneak) {
  const batch = db.batch;
  let done = false;
  db.batch = async (statements) => {
    if (!done) { done = true; sneak(); }
    return batch(statements);
  };
}

test('a role handed out is re-checked in SQL: it grew after the read, so the assignment is refused', async () => {
  const { db, team } = await leadTeam();
  sneakBeforeBatch(db, () => db.sqlite.exec(`UPDATE roles SET permissions = '["sessions.view","sessions.control"]' WHERE workspace = 'default' AND role_id = 'sv'`));
  await assert.rejects(team.addMember(W, 'lead@example.com', { identity: 'new@example.com', role_id: 'sv' }), { status: 403, code: 'forbidden' });
  assert.equal(await team.getMember(W, 'new@example.com'), null);
  assert.equal((await team.readAudit(W)).verified, true);
});

test('the actor is re-checked in SQL: demoted after the read, an admin removal is refused', async () => {
  const { db, team, boss } = await leadTeam();
  await team.addMember(W, boss, { identity: 'third@example.com', role_id: 'admin' });
  sneakBeforeBatch(db, () => db.sqlite.exec(`UPDATE members SET role_id = 'sv' WHERE workspace = 'default' AND identity = 'second@example.com'`));
  await assert.rejects(team.removeMember(W, 'second@example.com', 'third@example.com'), { status: 403, code: 'permission_denied' });
  assert.equal((await team.getMember(W, 'third@example.com')).role_id, 'admin');
});

test("the actor's own permissions are re-checked in SQL: a lead that lost permissions cannot hand out the old ones", async () => {
  const { db, team } = await leadTeam();
  await team.addRole(W, 'boss@example.com', { id: 'both', permissions: ['sessions.view', 'audit.view'] });
  await team.addRole(W, 'boss@example.com', { id: 'wide', permissions: ['members.manage', 'sessions.view', 'audit.view'] });
  await team.updateMember(W, 'boss@example.com', 'lead@example.com', { role_id: 'wide' });
  // After the read, "wide" loses audit.view: handing out "both" now exceeds it.
  sneakBeforeBatch(db, () => db.sqlite.exec(`UPDATE roles SET permissions = '["members.manage","sessions.view"]' WHERE workspace = 'default' AND role_id = 'wide'`));
  await assert.rejects(team.addMember(W, 'lead@example.com', { identity: 'new@example.com', role_id: 'both' }), { status: 403, code: 'forbidden' });
  assert.equal(await team.getMember(W, 'new@example.com'), null);
});

test('a member manager acts only on members whose role is within their own permissions', async () => {
  const { team, boss } = await leadTeam();
  await team.addRole(W, boss, { id: 'wide', permissions: ['sessions.view', 'sessions.control'] });
  const lead = 'lead@example.com';
  await team.addMember(W, boss, { identity: 'wide@example.com', role_id: 'wide' });
  await team.addMember(W, boss, { identity: 'sv@example.com', role_id: 'sv' });
  const within = { status: 403, code: 'forbidden', message: /within your own permissions/ };
  await assert.rejects(team.updateMember(W, lead, 'second@example.com', { name: 'x' }), within);
  await assert.rejects(team.updateMember(W, lead, 'wide@example.com', { name: 'x' }), within);
  await assert.rejects(team.updateMember(W, lead, 'wide@example.com', { role_id: 'sv' }), within);
  await assert.rejects(team.removeMember(W, lead, 'wide@example.com'), within);
  await assert.rejects(team.removeMember(W, lead, 'second@example.com'), /only an admin can remove an admin/);
  await team.updateMember(W, lead, 'sv@example.com', { name: 'Vee' });
  await team.removeMember(W, lead, 'sv@example.com');
  await team.updateMember(W, boss, 'wide@example.com', { name: 'Wide' });
  await team.removeMember(W, boss, 'wide@example.com');
  assert.equal((await team.readAudit(W)).verified, true);
});

test("the member's role is re-checked in SQL: the member moved to a stronger role after the read, a rename is refused", async () => {
  const { db, team, boss } = await leadTeam();
  await team.addMember(W, boss, { identity: 'sv@example.com', role_id: 'sv' });
  sneakBeforeBatch(db, () => db.sqlite.exec("UPDATE members SET role_id = 'technician' WHERE workspace = 'default' AND identity = 'sv@example.com'"));
  await assert.rejects(team.updateMember(W, 'lead@example.com', 'sv@example.com', { name: 'Vee' }), within403);
  const m = await team.getMember(W, 'sv@example.com');
  assert.deepEqual([m.role_id, m.name], ['technician', null]);
  assert.equal((await team.readAudit(W)).verified, true);
});

test('the target is re-checked in SQL: promoted to a stronger role after the read, a removal is refused', async () => {
  const { db, team, boss } = await leadTeam();
  await team.addMember(W, boss, { identity: 'sv@example.com', role_id: 'sv' });
  sneakBeforeBatch(db, () => db.sqlite.exec("UPDATE members SET role_id = 'admin' WHERE workspace = 'default' AND identity = 'sv@example.com'"));
  await assert.rejects(team.removeMember(W, 'lead@example.com', 'sv@example.com'), { status: 403, code: 'forbidden' });
  assert.equal((await team.getMember(W, 'sv@example.com')).role_id, 'admin');
});

test("the target's role is re-checked in SQL: it grew after the read, so a rename is refused", async () => {
  const { db, team, boss } = await leadTeam();
  await team.addMember(W, boss, { identity: 'sv@example.com', role_id: 'sv' });
  sneakBeforeBatch(db, () => db.sqlite.exec(`UPDATE roles SET permissions = '["sessions.view","sessions.control"]' WHERE workspace = 'default' AND role_id = 'sv'`));
  await assert.rejects(team.updateMember(W, 'lead@example.com', 'sv@example.com', { name: 'Vee' }), within403);
  assert.equal((await team.getMember(W, 'sv@example.com')).name, null);
  assert.equal((await team.readAudit(W)).verified, true);
});

test('the actor is re-checked in SQL on a rename: an admin demoted after the read cannot rename a stronger member', async () => {
  const { db, team, boss } = await leadTeam();
  await team.addMember(W, boss, { identity: 'tech@example.com', role_id: 'technician' });
  // second@ is an admin when the plan reads, and only a lead after.
  sneakBeforeBatch(db, () => db.sqlite.exec("UPDATE members SET role_id = 'lead' WHERE workspace = 'default' AND identity = 'second@example.com'"));
  await assert.rejects(team.updateMember(W, 'second@example.com', 'tech@example.com', { name: 'Tech' }), within403);
  assert.equal((await team.getMember(W, 'tech@example.com')).name, null);
  assert.equal((await team.readAudit(W)).verified, true);
});

test("the target's role growing after the read is refused in SQL", async () => {
  const { db, team, boss } = await leadTeam();
  await team.addMember(W, boss, { identity: 'sv@example.com', role_id: 'sv' });
  sneakBeforeBatch(db, () => db.sqlite.exec(`UPDATE roles SET permissions = '["sessions.view","sessions.control"]' WHERE workspace = 'default' AND role_id = 'sv'`));
  await assert.rejects(team.removeMember(W, 'lead@example.com', 'sv@example.com'), { status: 403, code: 'forbidden' });
  assert.notEqual(await team.getMember(W, 'sv@example.com'), null);
});

test('an admin demoted after the read cannot finish a removal that only an admin may do', async () => {
  const { db, team, boss } = await leadTeam();
  await team.addRole(W, boss, { id: 'strong', permissions: ['sessions.view', 'sessions.control'] });
  await team.addMember(W, boss, { identity: 'strong@example.com', role_id: 'strong' });
  // second@ is an admin when the plan reads, and holds members.manage and more after.
  await team.addRole(W, boss, { id: 'mgr', permissions: ['members.manage', 'sessions.view'] });
  sneakBeforeBatch(db, () => db.sqlite.exec("UPDATE members SET role_id = 'mgr' WHERE workspace = 'default' AND identity = 'second@example.com'"));
  await assert.rejects(team.removeMember(W, 'second@example.com', 'strong@example.com'), { status: 403, code: 'forbidden' });
  assert.notEqual(await team.getMember(W, 'strong@example.com'), null);
});

// ---- editing and deleting roles ---------------------------------------------------
const roleWithin = { status: 403, code: 'forbidden', message: /you can only (change|delete) a role whose permissions you hold: you do not hold sessions\.control/ };
async function rolemakerTeam() {
  const t = await leadTeam();
  await t.team.addRole(W, t.boss, { id: 'rolemaker', permissions: ['roles.manage', 'sessions.view'] });
  await t.team.addMember(W, t.boss, { identity: 'rm@example.com', role_id: 'rolemaker' });
  await t.team.addRole(W, t.boss, { id: 'strong', permissions: ['sessions.view', 'sessions.control'] });
  return t;
}
const permsOf = async (team, id) => (await team.listRoles(W)).find((r) => r.id === id)?.permissions;

test('a role manager cannot narrow, rename or delete a role that holds more than they do', async () => {
  const { team } = await rolemakerTeam();
  const rm = 'rm@example.com';
  await assert.rejects(team.updateRole(W, rm, 'strong', { permissions: ['sessions.view'] }), roleWithin);
  await assert.rejects(team.updateRole(W, rm, 'strong', { permissions: [] }), roleWithin);
  await assert.rejects(team.updateRole(W, rm, 'strong', { name: 'Renamed' }), roleWithin);
  await assert.rejects(team.removeRole(W, rm, 'strong'), roleWithin);
  await assert.rejects(team.updateRole(W, rm, 'technician', { permissions: ['sessions.view'] }), /you do not hold devices\.view, devices\.manage, sessions\.create/);
  await assert.rejects(team.removeRole(W, rm, 'technician'), /you do not hold devices\.view, devices\.manage, sessions\.create/);
  assert.deepEqual(await permsOf(team, 'strong'), ['sessions.view', 'sessions.control']);
  assert.ok(await permsOf(team, 'technician'));
  assert.equal((await team.readAudit(W)).verified, true);
});

test('a role manager can still edit and delete a role within their own permissions; an admin can edit any role', async () => {
  const { team, boss } = await rolemakerTeam();
  const rm = 'rm@example.com';
  await team.updateRole(W, rm, 'sv', { name: 'Viewer of sessions' });
  await team.updateRole(W, rm, 'sv', { permissions: [] });
  await team.updateRole(W, rm, 'sv', { permissions: ['sessions.view'] });
  await team.addRole(W, rm, { id: 'tmp', permissions: ['sessions.view'] });
  await team.removeRole(W, rm, 'tmp');
  await team.updateRole(W, boss, 'strong', { permissions: ['sessions.view'] });
  await team.updateRole(W, boss, 'technician', { name: 'Tech' });
  await team.removeRole(W, boss, 'strong');
  assert.equal(await permsOf(team, 'strong'), undefined);
  assert.equal((await team.readAudit(W)).verified, true);
});

test('a role widened after the read is re-checked in SQL: narrowing it is refused', async () => {
  const { db, team } = await rolemakerTeam();
  sneakBeforeBatch(db, () => db.sqlite.exec(`UPDATE roles SET permissions = '["sessions.view","sessions.control"]' WHERE workspace = 'default' AND role_id = 'sv'`));
  await assert.rejects(team.updateRole(W, 'rm@example.com', 'sv', { permissions: [] }), roleWithin);
  assert.deepEqual(await permsOf(team, 'sv'), ['sessions.view', 'sessions.control']);
  assert.equal((await team.readAudit(W)).verified, true);
});

test('a role widened after the read is re-checked in SQL: a rename is refused', async () => {
  const { db, team } = await rolemakerTeam();
  sneakBeforeBatch(db, () => db.sqlite.exec(`UPDATE roles SET permissions = '["sessions.view","sessions.control"]' WHERE workspace = 'default' AND role_id = 'sv'`));
  await assert.rejects(team.updateRole(W, 'rm@example.com', 'sv', { name: 'Renamed' }), roleWithin);
  assert.equal((await team.listRoles(W)).find((r) => r.id === 'sv').name, 'sv');
});

test('a role widened after the read is re-checked in SQL: deleting it is refused', async () => {
  const { db, team, boss } = await rolemakerTeam();
  await team.addRole(W, boss, { id: 'spare', permissions: ['sessions.view'] });
  sneakBeforeBatch(db, () => db.sqlite.exec(`UPDATE roles SET permissions = '["sessions.view","sessions.control"]' WHERE workspace = 'default' AND role_id = 'spare'`));
  await assert.rejects(team.removeRole(W, 'rm@example.com', 'spare'), roleWithin);
  assert.deepEqual(await permsOf(team, 'spare'), ['sessions.view', 'sessions.control']);
  assert.equal((await team.readAudit(W)).verified, true);
});

// ---- a member whose role no longer exists -----------------------------------------------
test('a member whose role is gone can be given a role or removed by an admin; any other change is a clean 409', async () => {
  const { db, team, boss } = await leadTeam();
  const lead = 'lead@example.com';
  const gone = { status: 409, code: 'role_missing', message: 'that member has a role that no longer exists; give them a role first' };
  await team.addRole(W, boss, { id: 'ghost', permissions: ['sessions.view'] });
  for (const id of ['g1', 'g2', 'g3', 'g4']) await team.addMember(W, boss, { identity: `${id}@example.com`, role_id: 'ghost' });
  // A built-in role deleted behind the store's back is gone too.
  await team.addMember(W, boss, { identity: 'bv@example.com', role_id: 'viewer' });
  db.sqlite.exec("UPDATE roles SET deleted = 1 WHERE workspace = 'default' AND role_id = 'ghost'");
  db.sqlite.exec("INSERT INTO roles(workspace, role_id, name, permissions, builtin, deleted) VALUES ('default', 'viewer', 'Viewer', '[]', 1, 1)");
  const before = (await team.readAudit(W)).head.seq;
  await assert.rejects(team.updateMember(W, lead, 'g1@example.com', { name: 'x' }), gone);
  await assert.rejects(team.updateMember(W, boss, 'g1@example.com', { name: 'x' }), gone);
  await assert.rejects(team.removeMember(W, lead, 'g1@example.com'), gone);
  await assert.rejects(team.removeMember(W, lead, 'bv@example.com'), gone);
  assert.equal((await team.readAudit(W)).head.seq, before, 'a refused change writes no log row');
  // Giving a role that exists works, for an admin and for a lead within their permissions.
  assert.equal((await team.updateMember(W, boss, 'g1@example.com', { role_id: 'technician' })).role_id, 'technician');
  assert.equal((await team.updateMember(W, lead, 'g2@example.com', { role_id: 'sv' })).role_id, 'sv');
  assert.equal((await team.updateMember(W, lead, 'bv@example.com', { name: 'Bee', role_id: 'sv' })).role_id, 'sv');
  await assert.rejects(team.updateMember(W, lead, 'g3@example.com', { role_id: 'technician' }), { status: 403, code: 'forbidden' });
  await assert.rejects(team.updateMember(W, lead, 'g3@example.com', { role_id: 'nonesuch' }), { status: 400, code: 'unknown_role' });
  // An admin can still remove one.
  await team.removeMember(W, boss, 'g4@example.com');
  assert.equal(await team.getMember(W, 'g4@example.com'), null);
  assert.equal((await team.readAudit(W)).verified, true);
});

// ---- open mode ---------------------------------------------------------------------
test('while open, every team write but the first member is refused with first_member', async () => {
  const db = openD1();
  const team = teamStore(db);
  const me = 'me@example.com';
  const refusal = { status: 409, code: 'first_member', message: 'add yourself as the first admin before changing the team' };
  await assert.rejects(team.addRole(W, me, { id: 'x', permissions: [] }), refusal);
  await assert.rejects(team.updateRole(W, me, 'viewer', { permissions: PERMISSIONS }), refusal);
  await assert.rejects(team.removeRole(W, me, 'viewer'), refusal);
  await assert.rejects(team.updateMember(W, me, me, { role_id: 'admin' }), refusal);
  await assert.rejects(team.removeMember(W, me), refusal);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM roles').get().n, 0);
  assert.equal((await team.whoami(W, me)).open, true);
  assert.deepEqual((await team.whoami(W, me)).permissions, OPEN_PERMISSIONS);
});

test('two callers racing to add the first member: exactly one wins', async () => {
  for (let round = 0; round < 5; round++) {
    const first = openD1();
    const a = teamStore(first);
    const b = teamStore(handle(first.sqlite));
    const results = await Promise.allSettled([
      a.addMember(W, 'one@example.com', { identity: 'one@example.com', role_id: 'admin' }),
      b.addMember(W, 'two@example.com', { identity: 'two@example.com', role_id: 'admin' }),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
    assert.equal(results.find((r) => r.status === 'rejected').reason.status, 403);
    const members = await a.listMembers(W);
    assert.equal(members.length, 1);
    const { rows, verified } = await a.readAudit(W);
    assert.deepEqual([verified, rows.map((r) => r.kind)], [true, ['member_added', 'roles_turned_on']]);
  }
});

test('a caller seen in the last minute is not written again; an older one is refreshed', async () => {
  const db = openD1();
  const team = teamStore(db);
  const seen = () => db.sqlite.prepare("SELECT last_seen FROM callers WHERE identity = 'a@example.com'").get()?.last_seen;
  await team.authorize(W, 'a@example.com', 'sessions.view');
  const inserted = seen();
  assert.ok(Math.abs(Date.now() - inserted) < 5000, 'a new caller is inserted');
  const writes = () => db.seen.filter((x) => /INSERT INTO callers/.test(x.sql)).length;
  db.sqlite.exec(`UPDATE callers SET last_seen = ${Date.now() - 10_000}`);
  const recent = seen();
  await team.authorize(W, 'a@example.com', 'sessions.control');
  assert.equal(seen(), recent, 'last seen 10 seconds ago: left alone');
  db.sqlite.exec(`UPDATE callers SET last_seen = ${Date.now() - 120_000}`);
  await team.authorize(W, 'a@example.com', 'sessions.control');
  assert.ok(Date.now() - seen() < 5000, 'last seen two minutes ago: refreshed');
  assert.ok(writes() >= 3);
  assert.deepEqual((await team.recentCallers(W)).map((c) => c.identity), ['a@example.com']);
});

// ---- retrying a lost log number -----------------------------------------------------
function failFirstBatch(db, error) {
  const batch = db.batch;
  const calls = { n: 0 };
  db.batch = async (statements) => {
    calls.n++;
    if (calls.n === 1) throw await error();
    return batch(statements);
  };
  return calls;
}

test('a lost log number is retried for the error text D1 really gives, and for variants', async () => {
  for (const text of [
    'D1_ERROR: UNIQUE constraint failed: audit.workspace, audit.seq: SQLITE_CONSTRAINT',
    'D1_ERROR: constraint failed on the audit table: SQLITE_CONSTRAINT_PRIMARYKEY',
    'unique constraint violated',
  ]) {
    const db = openD1();
    const team = teamStore(db);
    const calls = failFirstBatch(db, async () => new Error(text));
    await team.addMember(W, 'boss@example.com', { identity: 'boss@example.com', role_id: 'admin' });
    assert.equal(calls.n, 2, text);
    assert.equal((await team.readAudit(W)).verified, true);
  }
  // The error can sit one level down, as a cause.
  const db = openD1();
  const calls = failFirstBatch(db, async () => new Error('D1_ERROR', { cause: new Error('UNIQUE constraint failed: audit.seq') }));
  await teamStore(db).addMember(W, 'boss@example.com', { identity: 'boss@example.com', role_id: 'admin' });
  assert.equal(calls.n, 2);
});

test('any other batch error retries only if the log head moved since the read', async () => {
  // Moved: another writer committed a change, then this batch failed with unfamiliar text.
  const first = openD1();
  const other = teamStore(handle(first.sqlite));
  const team = teamStore(first);
  await team.addMember(W, 'boss@example.com', { identity: 'boss@example.com', role_id: 'admin' });
  const calls = failFirstBatch(first, async () => {
    await other.addMember(W, 'boss@example.com', { identity: 'other@example.com', role_id: 'viewer' });
    return new Error('D1_ERROR: something new');
  });
  await team.addMember(W, 'boss@example.com', { identity: 'mine@example.com', role_id: 'viewer' });
  assert.equal(calls.n, 2, 'the batch failed once, the head had moved, and the retry went through');
  assert.deepEqual((await team.listMembers(W)).map((m) => m.identity).sort(), ['boss@example.com', 'mine@example.com', 'other@example.com']);
  assert.equal((await team.readAudit(W)).verified, true);
  // Not moved: the error is the caller's.
  const db = openD1();
  const t2 = teamStore(db);
  const c2 = failFirstBatch(db, async () => new Error('D1_ERROR: network connection lost'));
  await assert.rejects(t2.addMember(W, 'boss@example.com', { identity: 'boss@example.com', role_id: 'admin' }), /network connection lost/);
  assert.equal(c2.n, 1);
  assert.equal((await t2.listMembers(W)).length, 0);
});

test('retries stay bounded: a log number that is always lost ends as busy', async () => {
  const db = openD1();
  const team = teamStore(db);
  db.batch = async () => { throw new Error('D1_ERROR: UNIQUE constraint failed: audit.workspace, audit.seq: SQLITE_CONSTRAINT'); };
  await assert.rejects(team.addMember(W, 'boss@example.com', { identity: 'boss@example.com', role_id: 'admin' }), { status: 503, code: 'busy' });
});

// ---- creating workspaces --------------------------------------------------------
const OWNER = 'owner@example.com';
const ownerTeam = (db) => teamStore(db, { deploymentAdmins: OWNER });
const workspaceRows = (db) => db.sqlite.prepare('SELECT slug, name, created_by FROM workspaces ORDER BY slug').all().map((r) => ({ ...r }));

test('creating a workspace writes the row, the creator as admin and two log rows in one batch', async () => {
  const db = openD1();
  const team = ownerTeam(db);
  const out = await team.createWorkspace(' Owner@Example.com ', { slug: 'acme', name: ' Acme Support ' });
  assert.deepEqual({ ...out, created_at: 0 }, { slug: 'acme', name: 'Acme Support', role_id: 'admin', created_by: OWNER, created_at: 0 });
  assert.deepEqual(workspaceRows(db), [{ slug: 'acme', name: 'Acme Support', created_by: OWNER }]);
  assert.equal(db.failedBatches, 0);
  const members = await team.listMembers('acme');
  assert.deepEqual(members.map((m) => [m.identity, m.kind, m.role_id, m.added_by]), [[OWNER, 'person', 'admin', OWNER]]);
  const log = await team.readAudit('acme', { full: true });
  assert.deepEqual(log.rows.map((r) => [r.seq, r.kind, r.actor]), [[1, 'workspace_created', OWNER], [2, 'member_added', OWNER]]);
  assert.equal(log.rows[1].detail, `${OWNER} as admin`);
  assert.deepEqual([log.rows[0].prev_hash, log.rows[1].prev_hash], [GENESIS_HASH, log.rows[0].hash]);
  assert.equal(log.verified, true);
  // The creator holds every permission at once, and default's log is untouched.
  for (const p of PERMISSIONS) assert.equal((await team.authorize('acme', OWNER, p)).ok, true, p);
  assert.deepEqual((await team.readAudit(W)).rows, []);
  // A service token can create one too.
  const bot = teamStore(db, { deploymentAdmins: '0123abcd.access' });
  assert.equal((await bot.createWorkspace('0123abcd.access', { slug: 'bots', name: 'Bots' })).role_id, 'admin');
  assert.equal((await bot.getMember('bots', '0123abcd.access')).kind, 'service');
});

test('only a deployment admin can create a workspace, and with none named nobody can', async () => {
  const db = openD1();
  const body = { slug: 'acme', name: 'Acme' };
  for (const named of ['', '  ', undefined]) {
    await assert.rejects(teamStore(db, { deploymentAdmins: named }).createWorkspace(OWNER, body), { status: 409, code: 'no_deployment_admins' });
  }
  await assert.rejects(ownerTeam(db).createWorkspace('mallory@example.com', body), { status: 403, code: 'forbidden' });
  // Being an admin of another workspace is not enough.
  await ownerTeam(db).createWorkspace(OWNER, { slug: 'beta', name: 'Beta' });
  await ownerTeam(db).addMember('beta', OWNER, { identity: 'lead@example.com', role_id: 'admin' });
  await assert.rejects(ownerTeam(db).createWorkspace('lead@example.com', body), { status: 403, code: 'forbidden' });
  assert.deepEqual(workspaceRows(db).map((r) => r.slug), ['beta'], 'a refusal writes nothing');
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM audit WHERE workspace = 'acme'").first('n'), 0);
});

test('a workspace needs a good slug and name; default is reserved; an existing slug is refused', async () => {
  const db = openD1();
  const team = ownerTeam(db);
  for (const slug of [undefined, null, 5, '', 'Acme', 'a b', 'a_b', 'a/b', '..', 'x'.repeat(41), 'é']) {
    await assert.rejects(team.createWorkspace(OWNER, { slug, name: 'N' }), { status: 400, code: 'bad_request' }, String(slug));
  }
  for (const name of [undefined, null, '', '   ', 5, 'x'.repeat(101), 'a\nb']) {
    await assert.rejects(team.createWorkspace(OWNER, { slug: 'acme', name }), { status: 400, code: 'bad_request' }, String(name));
  }
  await assert.rejects(team.createWorkspace(OWNER, undefined), { status: 400, code: 'bad_request' });
  await assert.rejects(team.createWorkspace(OWNER, { slug: 'default', name: 'Mine' }), { status: 409, code: 'workspace_exists' });
  assert.deepEqual(workspaceRows(db), []);
  assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM members').first('n'), 0);
  await team.createWorkspace(OWNER, { slug: 'a'.repeat(40), name: 'Longest slug' });
  await team.createWorkspace(OWNER, { slug: '0-9', name: 'Digits and a hyphen' });
  await team.createWorkspace(OWNER, { slug: 'acme', name: 'Acme' });
  await assert.rejects(team.createWorkspace(OWNER, { slug: 'acme', name: 'Again' }), { status: 409, code: 'workspace_exists' });
  assert.equal(workspaceRows(db).find((r) => r.slug === 'acme').name, 'Acme', 'the first creation stands');
  assert.equal((await team.readAudit('acme')).rows.length, 2, 'the refused creation wrote no log row');
});

test('creation stops at 500 workspaces with 409 workspace_limit, and the list is never cut short', async () => {
  const db = openD1();
  const team = ownerTeam(db);
  assert.equal(MAX_WORKSPACES, 500);
  const insert = db.sqlite.prepare("INSERT INTO workspaces(slug, name, created_by, created_at) VALUES (?, 'W', 'x', 1)");
  for (let i = 0; i < MAX_WORKSPACES - 1; i++) insert.run(`w${String(i).padStart(4, '0')}`);
  await team.createWorkspace(OWNER, { slug: 'last-one', name: 'The 500th' });
  assert.equal((await team.workspaceSlugs()).length, MAX_WORKSPACES, 'all 500 are listed');
  await assert.rejects(team.createWorkspace(OWNER, { slug: 'one-more', name: 'Too many' }), { status: 409, code: 'workspace_limit' });
  assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM workspaces').first('n'), MAX_WORKSPACES);
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM members WHERE workspace = 'one-more'").first('n'), 0, 'no member row was left behind');
  assert.equal((await team.readAudit('one-more')).rows.length, 0, 'and no log row');
  // A slug that exists is still reported as existing, not as the limit.
  await assert.rejects(team.createWorkspace(OWNER, { slug: 'last-one', name: 'Again' }), { status: 409, code: 'workspace_exists' });
});

test('the limit holds in the guard too: a creation planned under the limit does not land past it', async () => {
  const db = openD1();
  const team = ownerTeam(db);
  const insert = db.sqlite.prepare("INSERT INTO workspaces(slug, name, created_by, created_at) VALUES (?, 'W', 'x', 1)");
  for (let i = 0; i < MAX_WORKSPACES - 1; i++) insert.run(`w${String(i).padStart(4, '0')}`);
  // Two creators each see room for one more. The guard lets exactly one in.
  const other = teamStore(handle(db.sqlite), { deploymentAdmins: 'other@example.com' });
  const results = await Promise.allSettled([
    team.createWorkspace(OWNER, { slug: 'race-a', name: 'A' }),
    other.createWorkspace('other@example.com', { slug: 'race-b', name: 'B' }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'workspace_limit');
  assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM workspaces').first('n'), MAX_WORKSPACES);
});

test('membersOnly never opens default and never records the caller; without it open mode is unchanged', async () => {
  const db = openD1();
  const team = teamStore(db);
  const callers = () => db.sqlite.prepare('SELECT COUNT(*) AS n FROM callers').get().n;
  for (const p of OPEN_PERMISSIONS) {
    assert.deepEqual(await team.authorize(W, 'oauth@example.com', p, { membersOnly: true }), { ok: false, open: false, role_id: null, reason: 'not_member' }, p);
  }
  assert.equal(callers(), 0, 'not recorded');
  assert.deepEqual(await team.authorize(W, 'oauth@example.com', 'sessions.view'), { ok: true, open: true, role_id: null });
  assert.equal(callers(), 1, 'an Access caller is, as before');
  // For a member it changes nothing.
  db.sqlite.prepare("INSERT INTO members(workspace, identity, kind, name, role_id, added_at, added_by) VALUES ('default', 'm@example.com', 'person', NULL, 'viewer', 1, 't')").run();
  assert.equal((await team.authorize(W, 'm@example.com', 'sessions.view', { membersOnly: true })).ok, true);
});

test('two creators racing for one slug: exactly one wins, and its log stays valid', async () => {
  const first = openD1();
  const a = ownerTeam(first);
  const b = teamStore(handle(first.sqlite), { deploymentAdmins: 'other@example.com' });
  const results = await Promise.allSettled([
    a.createWorkspace(OWNER, { slug: 'acme', name: 'From owner' }),
    b.createWorkspace('other@example.com', { slug: 'acme', name: 'From other' }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  assert.deepEqual(results.find((r) => r.status === 'rejected').reason.code, 'workspace_exists');
  assert.equal(workspaceRows(first).length, 1);
  assert.equal((await a.listMembers('acme')).length, 1, 'one admin, the winner');
  const log = await a.readAudit('acme', { full: true });
  assert.deepEqual([log.rows.map((r) => r.kind), log.verified], [['workspace_created', 'member_added'], true]);
});

test('a slug that was not created does not exist; default always does', async () => {
  const db = openD1();
  const team = ownerTeam(db);
  await team.createWorkspace(OWNER, { slug: 'acme', name: 'Acme' });
  assert.equal(await team.workspaceExists('default'), true);
  assert.equal(await team.workspaceExists('acme'), true);
  for (const slug of ['beta', 'Acme', '', 'a b', undefined, null, 5, 'x'.repeat(41), '__proto__']) {
    assert.equal(await team.workspaceExists(slug), false, String(slug));
  }
});

test('open mode is only for default: a created workspace with no members is closed', async () => {
  const db = openD1();
  const team = ownerTeam(db);
  await team.createWorkspace(OWNER, { slug: 'acme', name: 'Acme' });
  // Remove its members behind the store's back: the rules refuse that, so this is the "somehow" case.
  db.sqlite.exec("DELETE FROM members WHERE workspace = 'acme'");
  for (const p of PERMISSIONS) {
    assert.deepEqual(await team.authorize('acme', 'anyone@example.com', p), { ok: false, open: false, role_id: null, reason: 'not_member' }, p);
  }
  assert.deepEqual(await team.whoami('acme', 'anyone@example.com'), { identity: 'anyone@example.com', open: false, member: false, role_id: null, permissions: [] });
  // Nobody can claim the first admin seat, themselves or anyone else, and no caller is recorded.
  for (const body of [{ identity: 'anyone@example.com', role_id: 'admin' }, { identity: 'anyone@example.com', role_id: 'viewer' }]) {
    await assert.rejects(team.addMember('acme', 'anyone@example.com', body), { status: 403, code: 'not_member' });
    await assert.rejects(ownerTeam(db).addMember('acme', OWNER, { identity: OWNER, role_id: 'admin' }), { status: 403, code: 'not_member' });
  }
  await assert.rejects(team.addRole('acme', 'anyone@example.com', { id: 'x', permissions: [] }), { status: 403, code: 'not_member' });
  assert.deepEqual(await team.recentCallers('acme'), []);
  assert.deepEqual(await team.listMembers('acme'), []);
  // Default is still open.
  assert.deepEqual(await team.authorize(W, 'anyone@example.com', 'sessions.view'), { ok: true, open: true, role_id: null });
  // A slug that was never created is closed too.
  assert.equal((await team.authorize('ghost', 'anyone@example.com', 'sessions.view')).reason, 'not_member');
});

test('listWorkspaces: the ones I am a member of, by role, and default while open or when I am in it', async () => {
  const db = openD1();
  const team = ownerTeam(db);
  await team.createWorkspace(OWNER, { slug: 'beta', name: 'Beta' });
  await team.createWorkspace(OWNER, { slug: 'acme', name: 'Acme' });
  await team.addMember('acme', OWNER, { identity: 'Tech@Example.com', role_id: 'technician' });
  // Default is open: everyone sees it, with no role.
  assert.deepEqual(await team.listWorkspaces(' TECH@example.com '), [
    { slug: 'default', name: 'Default', role_id: null }, { slug: 'acme', name: 'Acme', role_id: 'technician' },
  ]);
  assert.deepEqual(await team.listWorkspaces(OWNER), [
    { slug: 'default', name: 'Default', role_id: null }, { slug: 'acme', name: 'Acme', role_id: 'admin' }, { slug: 'beta', name: 'Beta', role_id: 'admin' },
  ]);
  assert.deepEqual(await team.listWorkspaces('stranger@example.com'), [{ slug: 'default', name: 'Default', role_id: null }]);
  // Once default has members, only its members see it, with their role.
  await team.addMember(W, OWNER, { identity: OWNER, role_id: 'admin' });
  assert.deepEqual(await team.listWorkspaces('stranger@example.com'), []);
  assert.deepEqual(await team.listWorkspaces('tech@example.com'), [{ slug: 'acme', name: 'Acme', role_id: 'technician' }]);
  assert.deepEqual((await team.listWorkspaces(OWNER)).map((w) => [w.slug, w.role_id]), [['default', 'admin'], ['acme', 'admin'], ['beta', 'admin']]);
  // It reads members through the identity index, and writes nothing.
  const read = db.seen.findLast((x) => x.sql.includes('JOIN workspaces'));
  const plan = db.sqlite.prepare(`EXPLAIN QUERY PLAN ${read.sql}`).all(...read.params).map((r) => r.detail).join('\n');
  assert.match(plan, /members_by_identity/);
  assert.deepEqual(await team.recentCallers(W), []);
});

// ---- two workspaces, real Sessions and Registries ----------------------------------
// One Durable Object namespace in memory: a real Session per id and a real
// Registry per name, so what crosses between workspaces is what the code does.
function registryObject() {
  const sqlite = new DatabaseSync(':memory:');
  const ctx = { storage: { sql: { exec(query, ...args) {
    const st = sqlite.prepare(query);
    if (/^\s*SELECT/i.test(query)) return { toArray: () => st.all(...args).map((r) => ({ ...r })) };
    st.run(...args);
    return { toArray: () => [] };
  } } } };
  return new Registry(ctx, {});
}
function sessionObject(registries) {
  const values = new Map();
  const logs = [];
  const ctx = { getWebSockets: () => [], storage: {
    get: async (k) => (Array.isArray(k) ? new Map(k.map((x) => [x, values.get(x)])) : values.get(k)),
    put: async (o) => { for (const [k, v] of Object.entries(o)) values.set(k, v); },
    setAlarm: async () => {}, deleteAlarm: async () => {},
    sql: { exec(query, ...a) {
      if (query.startsWith('INSERT INTO log')) logs.push({ ts: a[0], kind: a[1], detail: a[2] });
      return { toArray: () => logs.slice().reverse() };
    } },
  } };
  const env = { REGISTRY: registries.binding };
  return { session: new Session(ctx, env), values };
}
function world() {
  const registryByName = new Map();
  const sessions = new Map();
  const touched = [];
  const registries = { binding: {
    idFromName: (name) => ({ name }),
    get: (id) => {
      if (!registryByName.has(id.name)) registryByName.set(id.name, registryObject());
      const reg = registryByName.get(id.name);
      return { fetch: (u, init) => { touched.push(`${id.name} ${new URL(u).pathname}`); return reg.fetch(new Request(u, init)); } };
    },
  } };
  const SESSION = {
    idFromName: (code) => ({ toString: () => Buffer.from(code).toString('hex').padEnd(64, '0') }),
    idFromString: (sid) => ({ toString: () => sid }),
    get: (id) => {
      const sid = id.toString();
      if (!sessions.has(sid)) sessions.set(sid, sessionObject(registries));
      return { fetch: (u, init) => sessions.get(sid).session.fetch(typeof u === 'string' ? new Request(u, init) : u) };
    },
  };
  const db = openD1();
  const env = { DEV_SKIP_ACCESS: '1', DEPLOYMENT_ADMINS: 'local-dev', DB: db, SESSION, REGISTRY: registries.binding };
  return { env, db, sessions, registryByName, touched };
}
async function toolAt(env, path, name, args = {}) {
  const r = await handler.fetch(new Request(`http://127.0.0.1:8787${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  }), env);
  assert.equal(r.status, 200);
  return (await r.json()).result;
}
const payload = (out) => JSON.parse(out.content[0].text);
const WS_PATHS = { default: '/mcp', acme: '/w/acme/mcp', beta: '/w/beta/mcp' };

// Every tool that takes a session, with arguments that pass its schema.
const SESSION_TOOLS = {
  session_status: {}, session_end: {}, run: { command: 'whoami' },
  put_file: { path: 'C:\\x.txt', data_b64: 'eA==' }, get_file: { path: 'C:\\x.txt' },
  screenshot: {}, click: { x: 1, y: 1 }, move_mouse: { x: 1, y: 1 }, drag: { x1: 1, y1: 1, x2: 2, y2: 2 },
  scroll: { x: 1, y: 1, direction: 'down' }, type_text: { text: 'hi' }, press_key: { keys: 'enter' }, wait: {},
  zoom: { x1: 0, y1: 0, x2: 10, y2: 10 }, ui_tree: {}, ui_act: { ref: 1, verb: 'invoke' },
  block_input: { on: true }, send_sas: {}, type_secret: { text: 'hunter2-secret' }, request_full_control: {},
};

async function twoWorkspaces() {
  const w = world();
  const team = teamStore(w.db, { deploymentAdmins: 'local-dev' });
  await team.createWorkspace('local-dev', { slug: 'acme', name: 'Acme' });
  await team.createWorkspace('local-dev', { slug: 'beta', name: 'Beta' });
  const sid = {};
  for (const ws of Object.keys(WS_PATHS)) {
    const out = await toolAt(w.env, WS_PATHS[ws], 'session_create', { label: ws });
    assert.ok(!out.isError, out.content[0].text);
    sid[ws] = payload(out).session_id;
  }
  // A session made before workspaces existed: no workspace stored, listed in the old Registry.
  const code = 'legacycodelegacy';
  const legacy = w.env.SESSION.idFromName(code).toString();
  const made = await w.env.SESSION.get(w.env.SESSION.idFromName(code)).fetch('https://do/create', {
    method: 'POST', body: JSON.stringify({ code, sid: legacy, label: 'legacy', windows_mode: 'app' }),
  });
  assert.equal(made.status, 200);
  w.sessions.get(legacy).values.delete('workspace');
  sid.legacy = legacy;
  return { w, sid, team };
}

test('every tool that takes a session is separate per workspace; a session from another one answers as a missing session', async () => {
  const { w, sid } = await twoWorkspaces();
  const tools = listTools({ ui: true }).filter((t) => Object.hasOwn(t.inputSchema.properties, 'session_id')).map((t) => t.name);
  assert.deepEqual([...tools].sort(), Object.keys(SESSION_TOOLS).sort(), 'a new session tool needs a line in SESSION_TOOLS');
  const missing = 'f'.repeat(64);
  // A session that does not exist answers the same way from any workspace.
  const missingAnswer = async (ws, name, args) => toolAt(w.env, WS_PATHS[ws], name, { session_id: missing, ...args });
  const owners = { default: [sid.default, sid.legacy], acme: [sid.acme], beta: [sid.beta] };
  for (const [name, args] of Object.entries(SESSION_TOOLS)) {
    if (name === 'session_end') continue; // last, because it ends the session
    for (const ws of Object.keys(WS_PATHS)) {
      const reference = await missingAnswer(ws === 'default' ? 'acme' : 'default', name, args);
      for (const [owner, sids] of Object.entries(owners)) {
        for (const s of sids) {
          const out = await toolAt(w.env, WS_PATHS[ws], name, { session_id: s, ...args });
          if (owner === ws) {
            // Its own workspace sees the session. A pending one has no agent yet.
            assert.notDeepEqual(out, reference, `${name} from ${ws} sees its own session`);
          } else {
            assert.deepEqual(out, reference, `${name} from ${ws} on a session of ${owner}`);
          }
        }
      }
    }
  }
});

test('session_status shows a session only to its own workspace', async () => {
  const { w, sid } = await twoWorkspaces();
  for (const ws of Object.keys(WS_PATHS)) {
    const st = payload(await toolAt(w.env, WS_PATHS[ws], 'session_status', { session_id: sid[ws] }));
    assert.equal(st.state, 'pending', ws);
    for (const other of Object.keys(WS_PATHS).filter((x) => x !== ws)) {
      const seen = payload(await toolAt(w.env, WS_PATHS[other], 'session_status', { session_id: sid[ws] }));
      assert.deepEqual(seen, payload(await toolAt(w.env, WS_PATHS[other], 'session_status', { session_id: 'e'.repeat(64) })), `${other} looking at ${ws}`);
      assert.notEqual(seen.state, 'pending');
    }
  }
  // The pre-2a session belongs to default, and only to default.
  assert.equal(payload(await toolAt(w.env, '/mcp', 'session_status', { session_id: sid.legacy })).state, 'pending');
  for (const ws of ['acme', 'beta']) {
    assert.notEqual(payload(await toolAt(w.env, WS_PATHS[ws], 'session_status', { session_id: sid.legacy })).state, 'pending');
  }
});

test('session_end from another workspace ends nothing, and from its own workspace ends the session', async () => {
  const { w, sid } = await twoWorkspaces();
  const state = async (ws, s) => payload(await toolAt(w.env, WS_PATHS[ws], 'session_status', { session_id: s })).state;
  for (const [caller, target] of [['acme', 'beta'], ['beta', 'acme'], ['default', 'acme'], ['acme', 'default'], ['acme', 'legacy'], ['beta', 'legacy']]) {
    assert.deepEqual(payload(await toolAt(w.env, WS_PATHS[caller], 'session_end', { session_id: sid[target] })), { ended: true });
    assert.equal(await state(target === 'legacy' ? 'default' : target, sid[target]), 'pending', `${caller} ended nothing in ${target}`);
  }
  assert.deepEqual(payload(await toolAt(w.env, '/w/acme/mcp', 'session_end', { session_id: sid.acme })), { ended: true });
  assert.equal(await state('acme', sid.acme), 'ended');
  assert.equal(await state('beta', sid.beta), 'pending');
});

test('session_list reads only the caller\'s workspace; sessions from before workspaces are in default only', async () => {
  const { w, sid } = await twoWorkspaces();
  const listed = async (ws) => payload(await toolAt(w.env, WS_PATHS[ws], 'session_list')).sessions.map((x) => x.sid).sort();
  assert.deepEqual(await listed('acme'), [sid.acme]);
  assert.deepEqual(await listed('beta'), [sid.beta]);
  assert.deepEqual(await listed('default'), [sid.default, sid.legacy].sort());
  assert.deepEqual([...w.registryByName.keys()].sort(), ['registry', 'registry:acme', 'registry:beta']);
  // A workspace with no sessions lists nothing, and does not make the others' rows appear.
  await teamStore(w.db, { deploymentAdmins: 'local-dev' }).createWorkspace('local-dev', { slug: 'empty', name: 'Empty' });
  assert.deepEqual(payload(await toolAt(w.env, '/w/empty/mcp', 'session_list')), { sessions: [] });
  // Ending a session updates its own workspace's list only.
  await toolAt(w.env, '/w/acme/mcp', 'session_end', { session_id: sid.acme });
  const acme = payload(await toolAt(w.env, '/w/acme/mcp', 'session_list')).sessions;
  assert.deepEqual(acme.map((x) => [x.sid, x.state]), [[sid.acme, 'ended']]);
  assert.deepEqual(payload(await toolAt(w.env, '/w/beta/mcp', 'session_list')).sessions.map((x) => x.state), ['pending']);
});

test('a workspace that was not created answers tool calls with a tool error and touches nothing', async () => {
  const { w, sid } = await twoWorkspaces();
  w.touched.length = 0;
  const seenDo = [];
  const env = { ...w.env, SESSION: new Proxy(w.env.SESSION, { get: (t, k) => { seenDo.push(String(k)); return t[k]; } }) };
  for (const path of ['/w/ghost/mcp', '/w/x/mcp', `/w/${'a'.repeat(40)}/mcp`]) {
    for (const [name, args] of [['session_list', {}], ['session_create', {}], ['session_status', { session_id: sid.acme }], ['run', { session_id: sid.acme, command: 'whoami' }], ['session_end', { session_id: sid.acme }]]) {
      const out = await toolAt(env, path, name, args);
      assert.deepEqual(out, { content: [{ type: 'text', text: 'workspace not found' }], isError: true }, `${path} ${name}`);
    }
  }
  assert.deepEqual([seenDo, w.touched], [[], []], 'no Session or Registry was touched');
  assert.equal((await w.db.prepare('SELECT COUNT(*) AS n FROM members WHERE workspace = ?').bind('ghost').first('n')), 0);
  assert.equal((await w.db.prepare('SELECT COUNT(*) AS n FROM callers WHERE workspace = ?').bind('ghost').first('n')), 0, 'the unknown workspace is not opened or recorded');
});

test('tools/list on any well-formed workspace address never touches the database or a Durable Object', async () => {
  const trap = () => { throw new Error('touched'); };
  const env = { DEV_SKIP_ACCESS: '1', DB: { prepare: trap, batch: trap }, SESSION: { idFromName: trap, idFromString: trap, get: trap }, REGISTRY: { idFromName: trap, get: trap } };
  for (const path of ['/mcp', '/w/acme/mcp', '/w/never-created/mcp']) {
    const r = await handler.fetch(new Request(`http://127.0.0.1:8787${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }), env);
    assert.equal((await r.json()).result.tools.length, 24, path);
  }
});

test('roles are per workspace: a viewer in one can hold another role in the next, and a stranger holds nothing', async () => {
  const { w, sid } = await twoWorkspaces();
  const team = teamStore(w.db, { deploymentAdmins: 'local-dev' });
  // local-dev is a viewer in acme (boss holds the admin seat) and an admin in beta.
  await team.addMember('acme', 'local-dev', { identity: 'boss@example.com', role_id: 'admin' });
  await team.updateMember('acme', 'local-dev', 'local-dev', { role_id: 'viewer' });
  const text = (out) => out.content[0].text;
  assert.ok(!(await toolAt(w.env, '/w/acme/mcp', 'session_list')).isError);
  assert.equal(text(await toolAt(w.env, '/w/acme/mcp', 'run', { session_id: sid.acme, command: 'whoami' })), 'your role does not allow sessions.control');
  assert.equal(text(await toolAt(w.env, '/w/beta/mcp', 'run', { session_id: sid.beta, command: 'whoami' })), 'agent not attached');
  // Open mode is default's alone: local-dev holds the sessions permissions there, and nothing else.
  assert.equal(text(await toolAt(w.env, '/mcp', 'run', { session_id: sid.default, command: 'whoami' })), 'agent not attached');
  // Move beta's only seat to someone else: local-dev is then a stranger there.
  await team.addMember('beta', 'local-dev', { identity: 'boss@example.com', role_id: 'admin' });
  await team.removeMember('beta', 'boss@example.com', 'local-dev');
  const stranger = await toolAt(w.env, '/w/beta/mcp', 'session_list');
  assert.deepEqual(stranger, { content: [{ type: 'text', text: 'you are not a member of this team' }], isError: true });
});
