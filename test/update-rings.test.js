// Ringing the PCs that are due an update: the hourly run (src/sweep.js) and POST /api/v1/deployment/ring-updates,
// which runs the same pass right after a deploy. Only connected, active PCs below the release, in the share the
// rollout offers it to, and not seen lately, are rung; at most 100 per team per pass, inside the pass's subrequests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, accessToken, BOSS, TECH } from './device-sessions-world.js';
import { createHandler } from '../src/app.js';
import { sweep, ringUpdates, RING_PC_MAX, RING_SUBREQUESTS, RING_ROUTE_SUBREQUESTS } from '../src/sweep.js';
import { groupOf } from '../src/release.js';
import { VERSION } from '../src/version.js';
import { fixtureBundle } from './release-fixture.js';

const HOUR = 3600_000;
const OLD = '0.0.1';
const bundle = fixtureBundle();
const releaseEnv = (rollout = '100') => ({ RELEASE_SIGNATURE: Buffer.alloc(64, 1).toString('base64'), RELEASE_SIGNED_AT: String(Math.floor((1_800_000_000_000 - 72 * HOUR) / 1000)), UPDATE_ROLLOUT: rollout });

async function ringWorld(t, { rollout = '100', env = {} } = {}) {
  const w = await world(t, { env: { ...releaseEnv(rollout), ...env } });
  const handler = createHandler('powershell agent', bundle);
  const insert = w.db.sqlite.prepare("INSERT INTO devices(workspace, id, status, name, access, control, key_hash, paired_at, paired_by, app_version, last_seen) VALUES (?, ?, 'active', ?, 'ask', 'full', 'k', 1, 'test', ?, ?)");
  const idOf = (n, prefix = 'a') => `${prefix}${String(n).padStart(4, '0').replace(/\d/g, (d) => 'abcdefghij'[d])}`.padEnd(20, 'a');
  // A saved PC with a doorbell connected (or not), version and last_seen as given.
  const pc = (slug, n, { version = OLD, seen = w.now() - 2 * HOUR, bell = true, prefix = 'a' } = {}) => {
    const id = idOf(n, prefix);
    insert.run(slug, id, `PC ${n}`, version, seen);
    return { id, bell: bell ? w.ringSocket(id, slug) : null };
  };
  const team = (slug) => w.db.sqlite.prepare("INSERT INTO workspaces(slug, name, created_by, created_at) VALUES (?, ?, ?, 1)").run(slug, slug, BOSS);
  const route = async (who = BOSS, { method = 'POST', json = true, headers = {} } = {}) => {
    const r = await handler.fetch(new Request('https://support.example.com/api/v1/deployment/ring-updates', {
      method, headers: { ...(json ? { 'content-type': 'application/json' } : {}), 'cf-access-jwt-assertion': await accessToken(who), ...headers }, body: method === 'POST' ? '{}' : undefined,
    }), w.env);
    return { status: r.status, body: await r.json() };
  };
  return { w, handler, pc, team, route };
}

const rungOf = (pcs) => pcs.filter((p) => p.bell && p.bell.sent.length > 0).map((p) => p.id);

test('the hourly run rings connected, active PCs below the release that were not seen for an hour, and only those', async (t) => {
  const { w, handler, pc } = await ringWorld(t);
  const due = pc('default', 1);
  const notConnected = pc('default', 2, { bell: false });
  const current = pc('default', 3, { version: VERSION });
  const newer = pc('default', 4, { version: '99.0.0' });
  const seenLately = pc('default', 5, { seen: w.now() - 10 * 60_000 });
  const blank = pc('default', 6, { version: '' });
  const garbage = pc('default', 7, { version: 'not a version' });
  const pending = pc('default', 8);
  w.db.sqlite.prepare("UPDATE devices SET status = 'pending', expires_at = ? WHERE id = ?").run(w.now() + HOUR, pending.id);
  await handler.scheduled({}, w.env, { waitUntil: () => {} });
  assert.deepEqual(rungOf([due, notConnected, current, newer, seenLately, blank, garbage, pending]), [due.id]);
  assert.equal(due.bell.sent[0], '{"type":"ring"}');
  assert.equal(w.registryCalls.filter((c) => c.path === '/ring').length, 1, 'one call for the team');
  // Nothing is stored: a second run an hour on rings it again.
  const before = due.bell.sent.length;
  w.advance(HOUR);
  await handler.scheduled({}, w.env, { waitUntil: () => {} });
  assert.equal(due.bell.sent.length, before + 1);
});

test('no rings without a release, under EMERGENCY_STOP, with the rollout paused or at 0, and none for a team the rollout has not reached', async (t) => {
  for (const [label, opts, bundleToUse] of [
    ['no signature', { env: { RELEASE_SIGNATURE: '' } }, bundle],
    ['no signing date', { env: { RELEASE_SIGNED_AT: '' } }, bundle],
    ['no bundle', {}, null],
    ['stopped', { env: { EMERGENCY_STOP: '1' } }, bundle],
    ['paused', { rollout: 'pause' }, bundle],
    ['at zero', { rollout: '0' }, bundle],
  ]) {
    const { w, pc } = await ringWorld(t, opts);
    const one = pc('default', 1);
    await sweep(w.env, w.now(), bundleToUse);
    assert.equal(one.bell.sent.length, 0, label);
    assert.equal(w.registryCalls.filter((c) => c.path === '/ring').length, 0, label);
  }
});

test('the rollout decides which due PCs are rung: only those in a group below the stage', async (t) => {
  const { w, pc } = await ringWorld(t, { rollout: '50' });
  const pcs = Array.from({ length: 16 }, (_, i) => pc('default', i + 1));
  await sweep(w.env, w.now(), bundle);
  const want = [];
  for (const p of pcs) if ((await groupOf(VERSION, 'default', p.id)) < 50) want.push(p.id);
  assert.ok(want.length > 0 && want.length < pcs.length, 'the fixture has PCs on both sides');
  assert.deepEqual(rungOf(pcs).sort(), want.sort());
});

test('at most 100 PCs are rung per team per pass, the most recently seen first', async (t) => {
  const { w, pc } = await ringWorld(t);
  const pcs = Array.from({ length: 130 }, (_, i) => pc('default', i, { seen: w.now() - 2 * HOUR - i * 1000 }));
  await sweep(w.env, w.now(), bundle);
  assert.equal(rungOf(pcs).length, RING_PC_MAX);
  assert.equal(rungOf(pcs.slice(0, 100)).length, 100, 'the 100 seen most recently');
  assert.equal(w.registryCalls.filter((c) => c.path === '/ring').length, 1);
});

test('PCs that are not connected cannot use up the 100: the Registry rings the first 100 with an open doorbell', async (t) => {
  const { w, pc } = await ringWorld(t);
  // 150 PCs seen more recently than the connected ones, none connected.
  Array.from({ length: 150 }, (_, i) => pc('default', i, { bell: false, seen: w.now() - 2 * HOUR - i }));
  const here = Array.from({ length: 120 }, (_, i) => pc('default', 200 + i, { seen: w.now() - 20 * HOUR - i }));
  await sweep(w.env, w.now(), bundle);
  assert.equal(rungOf(here).length, RING_PC_MAX);
  assert.equal(w.registryCalls.filter((c) => c.path === '/ring').length, 1);
});

test('a pass reaches about four teams, takes turns, and stays inside its subrequests', async (t) => {
  const { w, pc, team } = await ringWorld(t);
  const slugs = ['t1', 't2', 't3', 't4', 't5', 't6'];
  const pcs = [];
  for (const [i, slug] of slugs.entries()) { team(slug); pcs.push(pc(slug, i)); }
  // Count what the free plan counts: each statement run on its own, each batch once, each Registry call.
  let calls = 0;
  const real = w.env.DB;
  const counted = (st) => ({ ...st, bind: (...a) => counted(st.bind(...a)), run: (...a) => (calls++, st.run(...a)), all: (...a) => (calls++, st.all(...a)), first: (...a) => (calls++, st.first(...a)) });
  w.env.DB = { ...real, prepare: (sql) => counted(real.prepare(sql)), batch: (list) => (calls++, real.batch(list)) };
  const reached = new Set();
  for (let h = 0; h < 3; h++) {
    for (const p of pcs) p.bell.sent.length = 0;
    calls = 0;
    const before = w.registryCalls.length;
    const out = await ringUpdates(w.env, w.now(), bundle, { turn: Math.floor(w.now() / HOUR) });
    assert.ok(calls + (w.registryCalls.length - before) <= RING_SUBREQUESTS, `${calls} D1 calls and ${w.registryCalls.length - before} Registry calls`);
    assert.deepEqual([out.rung, out.teams_left], [4, 2]);
    slugs.forEach((s, i) => { if (pcs[i].bell.sent.length) reached.add(s); });
    w.advance(HOUR);
  }
  w.env.DB = real;
  assert.deepEqual([...reached].sort(), slugs, 'every team within three hours');
});

// ---- the deploy-time route ---------------------------------------------------------------------------
test('POST /api/v1/deployment/ring-updates: a deployment admin rings the due PCs across teams, nobody else may', async (t) => {
  const { w, pc, team, route } = await ringWorld(t);
  team('acme');
  const a = pc('default', 1);
  const b = pc('acme', 1, { prefix: 'b' });
  const fresh = pc('default', 2, { seen: w.now() - 30_000 });
  const ok = await route(BOSS);
  assert.deepEqual([ok.status, ok.body], [200, { rung: 2, teams_left: 0 }]);
  assert.deepEqual(rungOf([a, b, fresh]).sort(), [a.id, b.id].sort(), 'a PC that checked in seconds ago was offered the release then');
  for (const who of [TECH, 'someone@example.com']) {
    const r = await route(who);
    assert.deepEqual([r.status, r.body.error.code], [403, 'forbidden'], who);
  }
  assert.equal((await route(BOSS, { method: 'GET' })).status, 405);
  assert.equal((await route(BOSS, { json: false })).status, 415);
  assert.equal((await route(BOSS, { headers: { origin: 'https://evil.example' } })).status, 403);
  const anonymous = await w.send('/api/v1/deployment/ring-updates', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(anonymous.status, 403);
});

test('the route says how many teams are left, and each call goes on from the PCs the last one rang, which have checked in since', async (t) => {
  const { w, pc, team, route } = await ringWorld(t);
  const slugs = Array.from({ length: 45 }, (_, i) => `team-${String(i).padStart(2, '0')}`);
  const pcs = slugs.map((slug, i) => { team(slug); return pc(slug, i); });
  let left = null;
  let total = 0;
  for (let call = 0; call < 5 && left !== 0; call++) {
    const r = await route(BOSS);
    assert.equal(r.status, 200);
    total += r.body.rung;
    left = r.body.teams_left;
    // The PCs that were rung check in, so they are not due again.
    for (const p of pcs.filter((x) => x.bell.sent.length)) w.db.sqlite.prepare('UPDATE devices SET last_seen = ?, app_version = ? WHERE id = ?').run(w.now(), VERSION, p.id);
    if (call === 0) assert.ok(left > 0 && left < 45, `a first call leaves teams: ${left}`);
  }
  assert.equal(left, 0);
  assert.equal(total, 45, 'every team\'s PC was rung once');
  assert.deepEqual(pcs.map((p) => p.bell.sent.length), pcs.map(() => 1));
  assert.ok(RING_ROUTE_SUBREQUESTS <= 45);
});

test('the route and the hourly run ring nothing under EMERGENCY_STOP', async (t) => {
  const { w, pc, route } = await ringWorld(t, { env: { EMERGENCY_STOP: '1' } });
  const a = pc('default', 1);
  assert.deepEqual((await route(BOSS)).body, { rung: 0, teams_left: 0 });
  await sweep(w.env, w.now(), bundle);
  assert.equal(a.bell.sent.length, 0);
});
