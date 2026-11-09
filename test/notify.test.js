// The notification writer and each member's settings (src/notify.js, migration 0007).
// The events that use them are tested in the next file section, once they exist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentWorld, BOSS, TECH, OTHER } from './agent-world.js';
import { EVENTS, notifyStore, readNotify } from '../src/notify.js';

const rowsOf = (w, where = '', ...params) => w.sql(`SELECT workspace, recipient, event, device_id, task_id, session_id, title, body, dedupe FROM notifications ${where} ORDER BY id`, ...params).map((r) => ({ ...r }));

// A second team that TECH and OTHER belong to.
async function acme(w) {
  w.db.sqlite.prepare("INSERT INTO workspaces(slug, name, created_by, created_at) VALUES ('acme', 'Acme', ?, 1)").run(BOSS);
  for (const [identity, role] of [[BOSS, 'admin'], [TECH, 'technician'], [OTHER, 'technician']]) {
    w.db.sqlite.prepare("INSERT INTO members(workspace, identity, kind, name, role_id, added_at, added_by) VALUES ('acme', ?, 'person', NULL, ?, 1, 'test')").run(identity, role);
  }
}

// ---- the writer and the settings ------------------------------------------------------------------------
test('settings: defaults, partial patches, watched PCs from the team only, and bad input refused', async (t) => {
  const w = await agentWorld(t);
  await acme(w);
  const notify = notifyStore(w.db, w.team);
  const mine = await w.addPc();
  const theirs = await w.devs.requestJoin({ protocol: 1, workspace: 'acme', name: 'Theirs' });
  assert.deepEqual(await notify.settings('default', TECH), { events: Object.fromEntries(EVENTS.map((e) => [e, true])), watch: [] });
  assert.deepEqual(readNotify('not json'), { events: Object.fromEntries(EVENTS.map((e) => [e, true])), watch: [] });
  const one = await notify.patchSettings('default', TECH, { events: { task_finished: false } });
  assert.equal(one.events.task_finished, false);
  assert.equal(one.events.task_problem, true);
  const two = await notify.patchSettings('default', TECH, { watch: [mine.id, mine.id] });
  assert.deepEqual([two.events.task_finished, two.watch], [false, [mine.id]], 'a patch of the watch list keeps the switches');
  const three = await notify.patchSettings('default', TECH, { events: { task_finished: true, device_online: false } });
  assert.deepEqual([three.events.task_finished, three.events.device_online, three.watch], [true, false, [mine.id]]);
  assert.deepEqual((await notify.patchSettings('default', TECH, { watch: [] })).watch, []);
  const bad = async (body, match) => assert.rejects(() => notify.patchSettings('default', TECH, body), (e) => e.status === 400 && match.test(e.message), JSON.stringify(body));
  await bad({}, /send events, watch or both/);
  await bad({ colour: 'blue' }, /unknown setting/);
  await bad({ events: { nope: true } }, /unknown event/);
  await bad({ events: { task_finished: 'yes' } }, /must be true or false/);
  await bad({ events: [] }, /events must be an object/);
  await bad({ watch: 'all' }, /list of at most 500/);
  await bad({ watch: ['nope'] }, /PC ids from this team/);
  await bad({ watch: [theirs.device_id] }, /PC ids from this team/);
  await bad({ watch: Array.from({ length: 501 }, () => mine.id) }, /at most 500/);
  await assert.rejects(() => notify.patchSettings('default', OTHER, { watch: [] }), (e) => e.status === 403);
});

test('a retried write adds nothing: the dedupe key is unique per person, and the insert is limited by its condition', async (t) => {
  const w = await agentWorld(t);
  const notify = notifyStore(w.db, w.team);
  const list = await notify.rows('default', 'device_waiting', { holding: 'devices.manage' }, { device_id: 'a'.repeat(20), title: 't', body: 'b', dedupe: 'x' });
  assert.equal(list.length, 3);
  await notify.write('default', list);
  await notify.write('default', list);
  assert.equal(rowsOf(w).length, 3);
  // Statements for a change that does not hold add nothing.
  await w.db.batch(notify.statements('default', await notify.rows('default', 'device_waiting', { to: [TECH] }, { title: 't', body: 'b', dedupe: 'y' }), ['0', []]));
  assert.equal(rowsOf(w).length, 3);
  // Long text is cut, control characters are not kept.
  const [long] = await notify.rows('default', 'device_waiting', { to: [TECH] }, { title: 'T'.repeat(500), body: `a\u0000b${'c'.repeat(500)}`, dedupe: 'z' });
  assert.equal(long.title.length, 120);
  assert.equal(long.body.length, 300);
  assert.ok(!long.body.includes('\u0000'));
  // Every row names its workspace, and the notifications are not in the team log.
  assert.ok(rowsOf(w).every((r) => r.workspace === 'default'));
  assert.equal(w.sql("SELECT COUNT(*) AS n FROM audit WHERE kind LIKE '%notif%'")[0].n, 0);
  await assert.rejects(() => notify.recipients('default', 'nope', { to: [TECH] }), /unknown notification event/);
});
