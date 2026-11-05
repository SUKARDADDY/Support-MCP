// Team data: the permission table, open mode, role checks on MCP tool calls,
// the chained team log, and workspace separation. Runs on the node:sqlite D1
// stand-in in test/d1-fake.js with migrations/0001_team.sql applied.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openD1, handle } from './d1-fake.js';
import { listTools } from '../src/mcp.js';
import { createHandler } from '../src/app.js';
import { BUILTIN_ROLES, OPEN_PERMISSIONS, PERMISSIONS, normalizePermissions, permissionForTool } from '../src/permissions.js';
import { GENESIS_HASH, TeamError, chainHash, teamStore } from '../src/workspace.js';

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
  assert.deepEqual(PERMISSIONS, ['members.manage', 'roles.manage', 'audit.view', 'sessions.create', 'sessions.view', 'sessions.control', 'sessions.end']);
  assert.deepEqual(BUILTIN_ROLES.admin.permissions, PERMISSIONS);
  assert.deepEqual(BUILTIN_ROLES.technician.permissions, ['sessions.create', 'sessions.view', 'sessions.control', 'sessions.end']);
  assert.deepEqual(BUILTIN_ROLES.viewer.permissions, ['sessions.view', 'audit.view']);
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
  assert.equal((await r.json()).result.tools.length, 22);
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
  await team.addMember('other', 'eve@example.com', { identity: 'eve@example.com', role_id: 'admin' });
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
