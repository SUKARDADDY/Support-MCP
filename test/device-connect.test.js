// Connecting to a saved PC: the permission, device_list, device_connect, the
// session pointer on the PC's record and the check-in answer that carries it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, BOSS, TECH, VIEW, LEAD } from './device-sessions-world.js';
import {
  BUILTIN_ROLES, FACTOR_PERMISSIONS, OPEN_PERMISSIONS, PERMISSIONS, needsSecondFactor, permissionForTool,
} from '../src/permissions.js';
import { livePointer } from '../src/devices.js';

const HEX64 = /^[0-9a-f]{64}$/;
const HOUR = 3_600_000;

// ---- the permission -----------------------------------------------------------------
test('sessions.unattended is a permission with a second factor, admin holds it, and no other built-in role does', () => {
  assert.ok(PERMISSIONS.includes('sessions.unattended'));
  assert.ok(FACTOR_PERMISSIONS.includes('sessions.unattended'));
  assert.equal(needsSecondFactor('sessions.unattended'), true);
  assert.ok(BUILTIN_ROLES.admin.permissions.includes('sessions.unattended'));
  assert.ok(!BUILTIN_ROLES.technician.permissions.includes('sessions.unattended'));
  assert.ok(!BUILTIN_ROLES.viewer.permissions.includes('sessions.unattended'));
  assert.equal(permissionForTool('device_list'), 'devices.view');
  assert.equal(permissionForTool('device_connect'), 'sessions.control');
});

test('open mode never grants sessions.unattended, though it grants every other sessions.* key', async (t) => {
  assert.deepEqual(OPEN_PERMISSIONS, ['sessions.create', 'sessions.view', 'sessions.control', 'sessions.end']);
  assert.ok(PERMISSIONS.filter((p) => p.startsWith('sessions.')).includes('sessions.unattended'), 'it is a sessions.* key, so the exclusion is by name');
  const { teamStore } = await import('../src/workspace.js');
  const { openD1 } = await import('./d1-fake.js');
  const open = teamStore(openD1());
  assert.deepEqual(await open.authorize('default', 'anyone@example.com', 'sessions.control'), { ok: true, open: true, role_id: null });
  assert.deepEqual(await open.authorize('default', 'anyone@example.com', 'sessions.unattended'), { ok: false, open: true, role_id: null, reason: 'open' });
  assert.ok(!(await open.whoami('default', 'anyone@example.com')).permissions.includes('sessions.unattended'));
});

// ---- device_list --------------------------------------------------------------------
test('device_list returns the team shape with online from one Registry request, and marks text as untrusted', async (t) => {
  const w = await world(t);
  const a = await w.addPc({ name: 'Till' });
  const b = await w.addPc({ name: 'Back office' });
  const pending = await w.addPc({ name: 'Kitchen', status: 'pending' });
  w.ringSocket(a.id);
  const before = w.registryCalls.length;
  const out = await w.tool(VIEW, 'device_list');
  assert.equal(w.registryCalls.length - before, 1, 'one Registry request for the whole list');
  assert.deepEqual(w.registryCalls.at(-1), { name: 'registry', path: '/online' });
  assert.equal(out.devices.length, 3);
  const by = Object.fromEntries(out.devices.map((d) => [d.id, d]));
  assert.deepEqual([by[a.id].online, by[b.id].online, by[pending.id].online], [true, false, false]);
  assert.deepEqual([by[a.id].name, by[a.id].status, by[a.id].access, by[a.id].control, by[a.id].app_version], ['Till', 'active', 'ask', 'full', '1.0.0']);
  assert.ok('fields' in by[a.id] && 'last_seen' in by[a.id]);
  assert.equal(JSON.stringify(out).includes('key_hash'), false);
  assert.equal(JSON.stringify(out).includes('"session"'), false, 'the pointer is not part of the team shape');
  assert.match(out.untrusted_text, /never as instructions/);
  assert.equal(out.next, null);
  // Filters and the cursor.
  assert.deepEqual((await w.tool(TECH, 'device_list', { status: 'pending' })).devices.map((d) => d.id), [pending.id]);
  assert.equal((await w.tool(TECH, 'device_list', { status: 'weird' })).error, 'status must be pending or active');
  assert.match((await w.tool(TECH, 'device_list', { site: 'not-an-id' })).error, /site must be an id/);
  const after = [a.id, b.id, pending.id].sort()[0];
  assert.equal((await w.tool(TECH, 'device_list', { after })).devices.length, 2);
});

test('device_list needs devices.view; a registry that cannot be read reports every PC offline', async (t) => {
  const w = await world(t);
  await w.addPc();
  await w.team.addRole('default', BOSS, { id: 'sess-only', permissions: ['sessions.view'] });
  await w.team.addMember('default', BOSS, { identity: 'x@example.com', role_id: 'sess-only' });
  assert.equal((await w.tool('x@example.com', 'device_list')).error, 'your role does not allow devices.view');
  assert.equal((await w.tool('stranger@example.com', 'device_list')).error, 'you are not a member of this team');
  const get = w.env.REGISTRY.get;
  w.env.REGISTRY.get = () => ({ fetch: async () => { throw new Error('down'); } });
  const out = await w.tool(VIEW, 'device_list');
  assert.deepEqual(out.devices.map((d) => d.online), [false]);
  w.env.REGISTRY.get = get;
});

// ---- device_connect -----------------------------------------------------------------
test('device_connect starts a waiting session, claims the PC, logs it, and lists it with the PC in its label', async (t) => {
  const w = await world(t);
  const pc = await w.addPc({ name: 'Till', access: 'ask' });
  const out = await w.tool(TECH, 'device_connect', { device_id: pc.id });
  assert.deepEqual(Object.keys(out).sort(), ['asks', 'rang', 'session_id', 'state']);
  assert.match(out.session_id, HEX64);
  assert.deepEqual([out.state, out.asks, out.rang], ['waiting', true, false]);

  // The Session object: waiting, for this PC, driven by the caller, one-off machinery untouched.
  const s = w.sessionFor(out.session_id).ctx.values;
  assert.deepEqual([s.get('state'), s.get('device_id'), s.get('driver'), s.get('windows_mode'), s.get('workspace')], ['waiting', pc.id, TECH, 'app', 'default']);
  assert.match(s.get('code'), /^[a-z2-7]{16}$/);
  assert.equal(s.get('key_hash'), undefined, 'no attach key exists');
  assert.equal(s.get('waiting_expires_at'), w.now() + 510_000);
  assert.equal(w.sessionFor(out.session_id).ctx.alarm(), w.now() + 510_000);

  // The pointer on the PC's record.
  const p = w.pointer(pc.id);
  assert.deepEqual(Object.keys(p), ['id', 'by', 'ask', 'expires_at', 'code', 'team']);
  assert.deepEqual([p.id, p.by, p.ask, p.team, p.code], [out.session_id, TECH, true, 'Default', s.get('code')]);
  assert.equal(p.expires_at, w.now() + 510_000 + 24 * HOUR, 'the latest the session can end');

  // The team log: ids and names, no code and no key.
  const rows = (await w.log()).filter((r) => r.kind === 'device_session_started');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actor, TECH);
  assert.equal(rows[0].detail, `${pc.id} "Till" ${out.session_id.slice(0, 8)} asks`);
  assert.equal(JSON.stringify(await w.log()).includes(p.code), false);
  assert.equal(JSON.stringify(await w.log()).includes(pc.key.split('.')[3]), false);

  // The session list names the PC.
  const list = await w.tool(TECH, 'session_list');
  assert.equal(list.sessions.length, 1);
  assert.deepEqual([list.sessions[0].sid, list.sessions[0].state, list.sessions[0].label], [out.session_id, 'waiting', `PC Till (${pc.id})`]);
  const status = await w.tool(TECH, 'session_status', { session_id: out.session_id });
  assert.deepEqual([status.state, status.device_id, status.driver, status.startup_expires_at], ['waiting', pc.id, TECH, w.now() + 510_000]);
});

test('a session asks unless the PC is any time, the caller may connect without asking, and did not pass ask:true', async (t) => {
  const w = await world(t);
  const ask = await w.addPc({ name: 'A', access: 'ask' });
  const any1 = await w.addPc({ name: 'B', access: 'any' });
  const any2 = await w.addPc({ name: 'C', access: 'any' });
  const any3 = await w.addPc({ name: 'D', access: 'any' });
  assert.equal((await w.tool(BOSS, 'device_connect', { device_id: ask.id })).asks, true, 'an ask-first PC always asks, even for an admin');
  assert.equal((await w.tool(BOSS, 'device_connect', { device_id: any1.id })).asks, false);
  assert.equal(w.pointer(any1.id).ask, false);
  assert.equal((await w.tool(LEAD, 'device_connect', { device_id: any2.id })).asks, false, 'a custom role with the permission');
  const technician = await w.tool(TECH, 'device_connect', { device_id: any3.id });
  assert.equal(technician.error, undefined, 'a technician is not refused: the person at the PC is asked');
  assert.equal(technician.asks, true);
  assert.equal(w.pointer(any3.id).ask, true);
  // ask:true adds asking for someone who could skip it.
  await w.tool(BOSS, 'session_end', { session_id: (await w.tool(BOSS, 'session_list')).sessions.find((s) => s.label.includes(any1.id)).sid });
  assert.equal(w.pointer(any1.id), null);
  assert.equal((await w.tool(BOSS, 'device_connect', { device_id: any1.id, ask: true })).asks, true);
});

test('device_connect refuses a pending, unknown or foreign PC, an old version, a busy PC and bad arguments', async (t) => {
  const w = await world(t);
  const pending = await w.addPc({ status: 'pending' });
  const old = await w.addPc({ name: 'Old', version: '0.9.9' });
  const unknownVersion = await w.addPc({ name: 'Blank', version: '' });
  const rc = await w.addPc({ name: 'RC', version: '1.0.0-rc.1' });
  const ok = await w.addPc({ name: 'Fine', version: '1.0.1' });
  assert.match((await w.tool(TECH, 'device_connect', { device_id: pending.id })).error, /waiting for approval/);
  assert.equal((await w.tool(TECH, 'device_connect', { device_id: 'a'.repeat(20) })).error, 'no such PC in this team');
  assert.equal((await w.tool(TECH, 'device_connect', { device_id: old.id })).error, 'this PC updates itself to 1.0.0 first');
  assert.equal((await w.tool(TECH, 'device_connect', { device_id: unknownVersion.id })).error, 'this PC updates itself to 1.0.0 first');
  assert.equal((await w.tool(TECH, 'device_connect', { device_id: rc.id })).error, 'this PC updates itself to 1.0.0 first');
  assert.equal((await w.tool(TECH, 'device_connect', {})).error, 'device_id must be the id of a PC from device_list');
  assert.equal((await w.tool(TECH, 'device_connect', { device_id: 'nope' })).error, 'device_id must be the id of a PC from device_list');
  assert.equal((await w.tool(TECH, 'device_connect', { device_id: ok.id, ask: 'yes' })).error, 'ask must be true or false');
  assert.equal((await w.tool(TECH, 'device_connect', { device_id: ok.id, take_over: 1 })).error, 'take_over must be true or false');
  assert.equal(w.sessionCalls.filter((c) => c.path === '/create').length, 0, 'no session was made for any refusal');
  const first = await w.tool(TECH, 'device_connect', { device_id: ok.id });
  assert.equal(first.state, 'waiting');
  assert.equal((await w.tool(BOSS, 'device_connect', { device_id: ok.id })).error, `${TECH} is connected`);
  assert.equal(w.sessionCalls.filter((c) => c.path === '/create').length, 1);
  // Another workspace's PC is a missing PC, and so is a PC id in a workspace that was never made.
  await w.team.createWorkspace(BOSS, { slug: 'acme', name: 'Acme' });
  assert.equal((await w.tool(BOSS, 'device_connect', { device_id: ok.id }, '/w/acme/mcp')).error, 'no such PC in this team');
  assert.equal((await w.tool(BOSS, 'device_connect', { device_id: ok.id }, '/w/nowhere/mcp')).error, 'workspace not found');
  assert.equal(w.pointer(ok.id).id, first.session_id, 'the PC kept its session');
});

test('device_connect needs sessions.control, and a viewer cannot connect', async (t) => {
  const w = await world(t);
  const pc = await w.addPc();
  assert.equal((await w.tool(VIEW, 'device_connect', { device_id: pc.id })).error, 'your role does not allow sessions.control');
  assert.equal((await w.tool('stranger@example.com', 'device_connect', { device_id: pc.id })).error, 'you are not a member of this team');
  assert.equal(w.pointer(pc.id), null);
});

test('two technicians connecting at once: one wins, the other is told who, and the loser leaves no trace', async (t) => {
  const w = await world(t);
  const pc = await w.addPc({ access: 'ask' });
  const [a, b] = await Promise.all([
    w.tool(TECH, 'device_connect', { device_id: pc.id }),
    w.tool(LEAD, 'device_connect', { device_id: pc.id }),
  ]);
  const winner = a.session_id ? a : b;
  const loser = a.session_id ? b : a;
  assert.equal(winner.state, 'waiting');
  assert.match(loser.error, /^(tech|lead)@example\.com is connected$/);
  assert.equal(w.pointer(pc.id).id, winner.session_id);
  assert.equal((await w.kinds()).filter((k) => k === 'device_session_started').length, 1);
  // The Session object the loser made was thrown away quietly: ended, and not announced.
  const made = [...w.sessions.entries()].filter(([sid]) => sid !== winner.session_id);
  assert.equal(made.length <= 1, true);
  for (const [, { ctx }] of made) {
    assert.equal(ctx.values.get('state'), 'ended');
    assert.equal(ctx.values.get('cleanup_pending'), undefined);
  }
  assert.equal((await w.kinds()).includes('device_session_ended'), false);
});

test('a pointer past its end is reclaimed by the next connect, and the check-in ignores it', async (t) => {
  const w = await world(t);
  const pc = await w.addPc();
  const first = await w.tool(TECH, 'device_connect', { device_id: pc.id });
  assert.equal((await w.hello(pc.key)).body.session.id, first.session_id);
  // The Session object is lost (no alarm ever ran): the pointer's own end still frees the PC.
  w.advance(510_000 + 24 * HOUR + 1);
  assert.equal(Object.hasOwn((await w.hello(pc.key)).body, 'session'), false, 'an expired pointer is left out of the check-in');
  assert.equal(livePointer({ session: JSON.stringify(w.pointer(pc.id)) }, w.now()), null);
  const second = await w.tool(BOSS, 'device_connect', { device_id: pc.id });
  assert.notEqual(second.session_id, first.session_id);
  assert.deepEqual([w.pointer(pc.id).id, w.pointer(pc.id).by], [second.session_id, BOSS]);
});

test('the grant is checked again when the claim commits: a technician who loses the permission in between is asked, not skipped', async (t) => {
  const w = await world(t);
  const pc = await w.addPc({ access: 'any' });
  // The role loses sessions.unattended after the plan read it and before the batch commits.
  const batch = w.db.batch;
  let done = false;
  w.db.batch = async (statements) => {
    if (!done) {
      done = true;
      w.db.sqlite.exec(`UPDATE roles SET permissions = '["devices.view","devices.manage","sessions.view","sessions.control","sessions.end"]' WHERE role_id = 'lead'`);
    }
    return batch(statements);
  };
  const out = await w.tool(LEAD, 'device_connect', { device_id: pc.id });
  w.db.batch = batch;
  assert.equal(out.asks, true, 'the retry found no permission and asked');
  assert.equal(w.pointer(pc.id).ask, true);
  assert.equal((await w.kinds()).filter((k) => k === 'device_session_started').length, 1);
});

test('rang says whether a doorbell was connected, and the ring carries only {"type":"ring"}', async (t) => {
  const w = await world(t);
  const pc = await w.addPc();
  const bell = w.ringSocket(pc.id);
  const out = await w.tool(TECH, 'device_connect', { device_id: pc.id });
  assert.equal(out.rang, true);
  assert.deepEqual(bell.sent, ['{"type":"ring"}']);
  // Another PC's doorbell is not rung.
  const other = await w.addPc({ name: 'Other' });
  const otherBell = w.ringSocket(other.id);
  await w.tool(BOSS, 'device_connect', { device_id: other.id });
  assert.equal(bell.sent.length, 1);
  assert.equal(otherBell.sent.length, 1);
});

// ---- the check-in answer --------------------------------------------------------------
test('the check-in answer carries session {id, by, team, ask, expires_at} only for an active PC with a live pointer', async (t) => {
  const w = await world(t);
  const pc = await w.addPc({ access: 'ask' });
  const quiet = await w.hello(pc.key);
  assert.equal(Object.hasOwn(quiet.body, 'session'), false);
  const started = await w.tool(TECH, 'device_connect', { device_id: pc.id });
  const hello = await w.hello(pc.key);
  assert.deepEqual(hello.body.session, {
    id: started.session_id, by: TECH, team: 'Default', ask: true, expires_at: w.now() + 510_000 + 24 * HOUR,
  });
  assert.deepEqual(Object.keys(hello.body.session), ['id', 'by', 'team', 'ask', 'expires_at']);
  assert.equal(JSON.stringify(hello.body).includes('check_in_s'), false, 'no check-in interval is sent');
  assert.deepEqual(Object.keys(hello.body).sort(), ['device', 'hours_until', 'hours_utc', 'protocol', 'rules', 'rules_tag', 'server_time', 'session']);
  assert.equal(Object.hasOwn(hello.body.device, 'session'), false, 'the key sits beside device, never inside it');
  // A pending PC never gets the key, even with a pointer on its row.
  const waiting = await w.addPc({ status: 'pending' });
  w.db.sqlite.prepare('UPDATE devices SET session = ? WHERE id = ?').run(JSON.stringify({ id: 'a'.repeat(64), by: TECH, ask: true, expires_at: w.now() + HOUR, code: 'abcdefghijklmnop', team: 'Default' }), waiting.id);
  assert.equal(Object.hasOwn((await w.hello(waiting.key)).body, 'session'), false);
  // A pointer that is not valid is simply absent.
  w.db.sqlite.prepare("UPDATE devices SET session = 'not json' WHERE id = ?").run(pc.id);
  assert.equal(Object.hasOwn((await w.hello(pc.key)).body, 'session'), false);
});

test('a check-in costs the same statements with and without a session', async (t) => {
  const w = await world(t);
  const pc = await w.addPc({ access: 'ask' });
  const count = async () => {
    const before = w.db.seen.length;
    await w.hello(pc.key);
    return w.db.seen.slice(before).map((s) => s.sql);
  };
  const without = await count();
  await w.tool(TECH, 'device_connect', { device_id: pc.id });
  const withSession = await count();
  assert.deepEqual(withSession, without);
  assert.equal(withSession.filter((s) => /^SELECT/.test(s)).length, 1, 'authenticate, and nothing else');
});

test('every statement the connect path runs names a workspace', async (t) => {
  const w = await world(t);
  const pc = await w.addPc({ access: 'any' });
  w.db.seen.length = 0;
  await w.tool(BOSS, 'device_connect', { device_id: pc.id });
  await w.tool(BOSS, 'device_list');
  await w.tool(LEAD, 'device_connect', { device_id: pc.id, take_over: true });
  await w.hello(pc.key);
  await w.tool(BOSS, 'session_end', { session_id: w.pointer(pc.id).id });
  assert.ok(w.db.seen.length > 10);
  for (const { sql } of w.db.seen) {
    if (/FROM workspaces WHERE slug = \?/.test(sql)) continue; // the workspace table is keyed by slug
    assert.match(sql, /workspace/, sql);
  }
});

// ---- a session that ends before its pointer is written, and a stop in that window ---------
const STOPPED = 'this workspace is stopped; someone who can manage members must resume it';
// After the real /create of the next saved-PC Session returns, run `then` once. This is the window between
// createSession and the claim: the Session exists, devices.session is not written yet.
function afterCreate(w, then) {
  const realGet = w.env.SESSION.get;
  let fired = false;
  w.env.SESSION.get = (id) => {
    const stub = realGet(id);
    return {
      fetch: async (u, init) => {
        const r = await stub.fetch(u, init);
        if (!fired && String(u).endsWith('/create')) { fired = true; await then(); }
        return r;
      },
    };
  };
  return () => { w.env.SESSION.get = realGet; };
}

test('a stop between createSession and the claim ends the connect: nothing is claimed, the new Session is gone, and a connect after resume works', async (t) => {
  const w = await world(t);
  const pc = await w.addPc();
  const restore = afterCreate(w, () => w.api(BOSS, 'POST', '/stop', {}));
  const out = await w.tool(TECH, 'device_connect', { device_id: pc.id });
  restore();
  assert.equal(out.error, STOPPED);
  assert.equal(w.pointer(pc.id), null, 'no pointer to a dead session');
  assert.equal((await w.kinds()).includes('device_session_started'), false);
  const made = [...w.sessions.keys()];
  assert.equal(made.length, 1);
  assert.equal(w.stateOf(made[0]), 'ended');
  // Resume: the PC is free, and the next connect is a normal one, not "<actor> is connected".
  await w.api(BOSS, 'DELETE', '/stop', {});
  const again = await w.tool(TECH, 'device_connect', { device_id: pc.id });
  assert.equal(again.state, 'waiting');
  assert.deepEqual([w.pointer(pc.id).id, w.stateOf(again.session_id)], [again.session_id, 'waiting']);
});

test('a retry never reuses a Session that has ended: a stop and a resume in the window make a fresh one', async (t) => {
  const w = await world(t);
  const pc = await w.addPc();
  const restore = afterCreate(w, async () => {
    await w.api(BOSS, 'POST', '/stop', {});
    await w.api(BOSS, 'DELETE', '/stop', {});
  });
  const out = await w.tool(TECH, 'device_connect', { device_id: pc.id });
  restore();
  assert.equal(out.state, 'waiting');
  assert.equal(w.stateOf(out.session_id), 'waiting', 'the Session the PC is told about is live');
  assert.equal(w.pointer(pc.id).id, out.session_id);
  const first = [...w.sessions.keys()].filter((sid) => sid !== out.session_id);
  assert.equal(first.length, 1, 'the first Session was thrown away, not reused');
  assert.equal(w.stateOf(first[0]), 'ended');
  assert.equal((await w.kinds()).filter((k) => k === 'device_session_started').length, 1);
});

test('the claim itself refuses a stopped workspace, even if the plan did not see the stop', async (t) => {
  const w = await world(t);
  const pc = await w.addPc();
  // Make the plan blind to the stop: the stop row is written after the plan read and the batch then names that
  // same log number, so the only thing left to refuse is the guard.
  const prepare = w.db.prepare;
  w.db.prepare = (text) => (/workspace_stopped/.test(text) && /MAX\(seq\)[\s\S]*workspace_resumed/.test(text) && !/COALESCE/.test(text)
    ? { bind: () => ({ first: async () => ({ stopped: null, resumed: null }) }) } : prepare(text));
  const batch = w.db.batch;
  w.db.batch = async (statements) => {
    // A stop row in the log, written straight to the table, one number after the head the plan read.
    const head = w.db.sqlite.prepare("SELECT seq, hash FROM audit WHERE workspace = 'default' ORDER BY seq DESC LIMIT 1").get();
    w.db.sqlite.prepare("INSERT INTO audit(workspace, seq, ts, actor, kind, detail, prev_hash, hash) VALUES ('default', ?, ?, ?, 'workspace_stopped', 'stopped', ?, ?)")
      .run(head.seq + 1, Date.now(), BOSS, head.hash, 'x'.repeat(64));
    w.db.batch = batch;
    return batch(statements);
  };
  const out = await w.tool(TECH, 'device_connect', { device_id: pc.id });
  w.db.prepare = prepare;
  w.db.batch = batch;
  // The plan never saw the stop, so only the guard stopped the claim (the connect then runs out of retries).
  assert.match(out.error, /being changed by someone else/);
  assert.equal(w.pointer(pc.id), null, 'no claim after a stop row');
  assert.equal((await w.kinds()).includes('device_session_started'), false);
});

test('a pointer whose Session ended or never existed is reclaimed by the next connect, in the same guarded change', async (t) => {
  const w = await world(t);
  const pc = await w.addPc({ access: 'any' });
  // 1. The Session ended but its pointer was never cleared.
  const first = await w.tool(BOSS, 'device_connect', { device_id: pc.id });
  w.sessionFor(first.session_id).ctx.values.set('state', 'ended');
  assert.equal(w.pointer(pc.id).id, first.session_id);
  const second = await w.tool(TECH, 'device_connect', { device_id: pc.id });
  assert.equal(second.state, 'waiting');
  assert.notEqual(second.session_id, first.session_id);
  assert.deepEqual([w.pointer(pc.id).id, w.pointer(pc.id).by], [second.session_id, TECH]);
  // 2. The pointer names a Session that does not exist.
  const ghost = 'f'.repeat(64);
  w.db.sqlite.prepare('UPDATE devices SET session = ? WHERE id = ?').run(JSON.stringify({ ...w.pointer(pc.id), id: ghost }), pc.id);
  const third = await w.tool(BOSS, 'device_connect', { device_id: pc.id });
  assert.equal(third.state, 'waiting');
  assert.equal(w.pointer(pc.id).id, third.session_id);
  assert.equal((await w.kinds()).filter((k) => k === 'device_session_started').length, 3);
  // 3. A live Session still holds the PC, and one that cannot be reached counts as live.
  assert.equal((await w.tool(TECH, 'device_connect', { device_id: pc.id })).error, `${BOSS} is connected`);
  const realGet = w.env.SESSION.get;
  w.env.SESSION.get = (id) => ({ fetch: async (u, init) => { if (String(u).includes('/status')) throw new Error('unreachable'); return realGet(id).fetch(u, init); } });
  assert.equal((await w.tool(TECH, 'device_connect', { device_id: pc.id })).error, `${BOSS} is connected`);
  w.env.SESSION.get = realGet;
});

test('a claim on a stranded pointer loses to a newer pointer: it is guarded on the old pointer value', async (t) => {
  const w = await world(t);
  const pc = await w.addPc();
  const first = await w.tool(BOSS, 'device_connect', { device_id: pc.id });
  w.sessionFor(first.session_id).ctx.values.set('state', 'ended');
  // Between the plan and the claim another connect reclaims the PC.
  const batch = w.db.batch;
  let done = false;
  let rival = null;
  w.db.batch = async (statements) => {
    if (!done) {
      done = true;
      w.db.batch = batch;
      rival = await w.tool(LEAD, 'device_connect', { device_id: pc.id });
    }
    return batch(statements);
  };
  const out = await w.tool(TECH, 'device_connect', { device_id: pc.id });
  w.db.batch = batch;
  assert.equal(rival.state, 'waiting');
  assert.equal(out.error, `${LEAD} is connected`);
  assert.equal(w.pointer(pc.id).id, rival.session_id);
});

// ---- the access mode needs sessions.unattended only when it changes to any time ------------
test('resending access "any" for a PC that is already any time needs only devices.manage; switching ask to any still needs sessions.unattended', async (t) => {
  const w = await world(t);
  const any = await w.addPc({ name: 'Any', access: 'any' });
  const ask = await w.addPc({ name: 'Ask', access: 'ask' });
  const resend = await w.api(TECH, 'PATCH', `/devices/${any.id}`, { access: 'any', owner_contact: 'Dana' });
  assert.equal(resend.status, 200);
  assert.deepEqual([resend.body.device.access, resend.body.device.owner_contact], ['any', 'Dana']);
  // Nothing changes at all: an answer, and no log row.
  const rows = (await w.kinds()).length;
  assert.equal((await w.api(TECH, 'PATCH', `/devices/${any.id}`, { access: 'any' })).status, 200);
  assert.equal((await w.kinds()).length, rows);
  const refused = await w.api(TECH, 'PATCH', `/devices/${ask.id}`, { access: 'any', owner_contact: 'Dana' });
  assert.deepEqual([refused.status, refused.body.error.code], [403, 'permission_denied']);
  assert.match(refused.body.error.message, /sessions\.unattended/);
  assert.equal((await w.api(TECH, 'GET', `/devices/${ask.id}`)).body.device.access, 'ask');
  assert.equal((await w.api(LEAD, 'PATCH', `/devices/${ask.id}`, { access: 'any' })).body.device.access, 'any');
  // Going back to ask needs nothing extra.
  assert.equal((await w.api(TECH, 'PATCH', `/devices/${ask.id}`, { access: 'ask' })).body.device.access, 'ask');
});
