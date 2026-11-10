// Invites and watching through the tools and the picture route: who may invite and remove, that an invite never
// widens access, that a joined watcher reads the picture and nobody else does, the picture's rev, the names, and
// that a session of another team is no session. The Session's own side is in session-people.test.js; handover
// and the one rule are in handover.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentWorld, BOSS, TECH, VIEW, LEAD, shot } from './agent-world.js';
import { appWorld, skip } from './app-world.js';
import { TECH2, addTech2, attached, call } from './people-world.js';
import { listTools } from '../src/mcp.js';
import { teamStore } from '../src/workspace.js';

const it = (name, fn) => test(name, { skip }, fn);
const JPEG = '/9j/4AAQ';
const ZOOM = 'iVBORw0KGgoAAAANSUhEUgAA';
const NEW_TOOLS = ['people_list', 'session_participants', 'session_handover', 'escalation'];
const rows = (list) => list.map((p) => `${p.identity}:${p.role}`);

// The PC answers a screenshot with the next picture in the list and a zoom with a small PNG.
function screens(list) {
  let n = 0;
  return (frame) => {
    if (frame.type !== 'screen') return null;
    if (frame.action.name === 'zoom') return shot({ image_b64: ZOOM, mime: 'image/png', width: 100, height: 60 });
    return shot({ image_b64: list[Math.min(n++, list.length - 1)] });
  };
}
const pic = (word) => `${JPEG}${btoa(word.padEnd(9, '_')).replace(/=+$/, '').padEnd(12, 'A')}`;

// ---- the tools ------------------------------------------------------------------------------------
test('tools/list has 31 tools, the four new ones with the code-first contract in their descriptions', async (t) => {
  const w = await agentWorld(t);
  const tools = (await w.rpc(BOSS, 'tools/list')).body.result.tools;
  assert.equal(tools.length, 31);
  assert.equal(listTools().length, 31);
  for (const name of NEW_TOOLS) assert.ok(tools.some((x) => x.name === name), name);
  const by = Object.fromEntries(tools.map((x) => [x.name, x]));
  assert.deepEqual(by.session_participants.inputSchema.required, ['session_id', 'action']);
  assert.deepEqual(by.session_participants.inputSchema.properties.action.enum, ['invite', 'join', 'leave', 'remove']);
  assert.deepEqual(by.session_handover.inputSchema.properties.action.enum, ['offer', 'accept', 'decline', 'cancel', 'take_over']);
  assert.deepEqual(by.escalation.inputSchema.properties.action.enum, ['open', 'list', 'claim', 'close']);
  assert.deepEqual(by.escalation.inputSchema.required, ['action']);
  assert.deepEqual(by.people_list.inputSchema.properties, {});
  for (const name of ['session_participants', 'session_handover', 'escalation']) assert.match(by[name].description, /Errors start with a code/, name);
  assert.match(by.escalation.description, /untrusted data/);
  // A caller who is not a team member (open mode) is no driver, and the description says so.
  assert.match(by.session_create.description, /The caller becomes the driver when they are a team member \(not in open mode\)/);
  for (const name of ['session_participants', 'session_handover', 'escalation']) assert.match(by[name].description, /second_factor/, name);
  // The other 27 keep their names and the 27 old inputs.
  assert.equal(tools.filter((x) => !NEW_TOOLS.includes(x.name)).length, 27);
});

test('each of the four tools needs sessions.control: a Viewer, a stranger and open mode are refused', async (t) => {
  const w = await agentWorld(t);
  const { sid } = await attached(w, TECH);
  const calls = {
    people_list: {}, session_participants: { session_id: sid, action: 'leave' }, session_handover: { session_id: sid, action: 'cancel' }, escalation: { action: 'list' },
  };
  for (const [name, args] of Object.entries(calls)) {
    assert.equal((await w.tool(VIEW, name, args)).error, 'your role does not allow sessions.control', `${name} Viewer`);
    assert.equal((await w.tool('stranger@example.com', name, args)).error, 'you are not a member of this team', `${name} stranger`);
  }
  // A team with no members yet is open to the session tools, but never to these.
  const open = await agentWorld(t, { members: false });
  assert.deepEqual(Object.keys(await open.tool('anyone@example.com', 'session_list')), ['sessions']);
  for (const [name, args] of Object.entries(calls)) {
    assert.equal((await open.tool('anyone@example.com', name, args)).error, 'you are not a member of this team', `${name} open mode`);
  }
});

test('an error of these tools starts with its code: "<code>: <message>"', async (t) => {
  const w = await agentWorld(t);
  const { sid } = await attached(w, TECH);
  assert.match((await w.tool(LEAD, 'session_participants', { session_id: sid, action: 'invite', identity: BOSS })).error, /^not_driver: tech@example\.com is driving this session/);
  assert.match((await w.tool(TECH, 'session_participants', { session_id: sid, action: 'invite', identity: VIEW })).error, /^cannot_control: /);
  assert.match((await w.tool(BOSS, 'session_handover', { session_id: sid, action: 'accept' })).error, /^no_offer: /);
  assert.match((await w.tool(BOSS, 'session_participants', { session_id: sid, action: 'join' })).error, /^not_invited: /);
  assert.match((await w.tool(BOSS, 'session_participants', { session_id: 'nope', action: 'join' })).error, /^bad_request: session_id must be the 64 hex/);
  assert.match((await w.tool(BOSS, 'session_participants', { session_id: 'f'.repeat(64), action: 'join' })).error, /^not_found: no such live session$/);
  assert.match((await w.tool(BOSS, 'session_participants', { session_id: sid, action: 'dance' })).error, /^bad_request: action must be/);
  assert.match((await w.tool(BOSS, 'escalation', { action: 'claim', id: 'a'.repeat(20) })).error, /^not_found: /);
  assert.match((await w.tool(BOSS, 'escalation', { action: 'nope' })).error, /^bad_request: action must be open, list, claim or close$/);
  // The old tools' errors are as they were: plain text.
  assert.equal((await w.tool(BOSS, 'run', { session_id: sid, command: 'x' })).error, `${TECH} is driving this session; use device_connect with take_over`);
});

// ---- inviting ---------------------------------------------------------------------------------------
test('people_list names the members who are people and whether each can control sessions', async (t) => {
  const w = await agentWorld(t);
  w.db.sqlite.prepare("UPDATE members SET name = 'Tamar' WHERE identity = ?").run(TECH);
  const list = (await w.tool(TECH, 'people_list')).people;
  assert.deepEqual(list.find((p) => p.identity === TECH), { identity: TECH, name: 'Tamar', can_control: true });
  assert.deepEqual(list.find((p) => p.identity === VIEW), { identity: VIEW, name: null, can_control: false });
  assert.equal(list.length, 4);
});

test('only the driver invites or removes, the target must be a member who can control sessions, and the invite reaches them whatever their settings', async (t) => {
  const w = await agentWorld(t);
  await addTech2(w);
  w.db.sqlite.prepare("UPDATE members SET name = 'Tamar' WHERE identity = ?").run(TECH);
  const { sid, pc } = await attached(w, TECH);
  const invite = (who, identity) => w.tool(who, 'session_participants', { session_id: sid, action: 'invite', identity });
  // Only the driver.
  assert.match((await invite(TECH2, BOSS)).error, /^not_driver: /);
  assert.match((await invite(BOSS, TECH2)).error, /^not_driver: /);
  // The target is checked: a Viewer, someone outside the team, a name that is no person.
  for (const who of [VIEW, 'stranger@example.com', 'a-service-client']) assert.match((await invite(TECH, who)).error, /^cannot_control: /, who);
  // Switching every event off does not stop it.
  w.db.sqlite.prepare('UPDATE members SET notify = ? WHERE identity = ?').run(JSON.stringify({ events: { task_finished: false, escalation_opened: false } }), TECH2);
  const out = await invite(TECH, TECH2);
  assert.deepEqual(rows(out.participants), [`${TECH}:driver`, `${TECH2}:invited`]);
  assert.equal(out.participants[0].name, 'Tamar', 'names come from the team');
  assert.equal(out.participants[1].name, null);
  assert.equal(out.participants[1].since, w.now());
  const note = w.sql("SELECT recipient, event, device_id, session_id, title, body, dedupe FROM notifications WHERE event = 'session_invited'");
  assert.equal(note.length, 1);
  assert.deepEqual([note[0].recipient, note[0].device_id, note[0].session_id, note[0].body], [TECH2, pc.id, sid, 'Tamar invited you to watch the session on Till']);
  assert.equal(note[0].dedupe, `invited:${sid}:${TECH2}:${w.now()}`);
  // Inviting again adds no second notice, and no second entry.
  assert.deepEqual(rows((await invite(TECH, TECH2)).participants), [`${TECH}:driver`, `${TECH2}:invited`]);
  assert.equal(w.sql("SELECT COUNT(*) AS n FROM notifications WHERE event = 'session_invited'")[0].n, 1);
  // Join, leave, remove.
  assert.deepEqual(rows((await w.tool(TECH2, 'session_participants', { session_id: sid, action: 'join' })).participants), [`${TECH}:driver`, `${TECH2}:watcher`]);
  assert.match((await w.tool(TECH2, 'session_participants', { session_id: sid, action: 'remove', identity: TECH })).error, /^not_driver: /);
  assert.deepEqual(rows((await w.tool(TECH, 'session_participants', { session_id: sid, action: 'remove', identity: TECH2 })).participants), [`${TECH}:driver`]);
  await invite(TECH, TECH2);
  await w.tool(TECH2, 'session_participants', { session_id: sid, action: 'join' });
  assert.deepEqual(rows((await w.tool(TECH2, 'session_participants', { session_id: sid, action: 'leave' })).participants), [`${TECH}:driver`]);
});

test('people_list and an invite read the same stored kind, also for a hand-made row whose name is not an email', async (t) => {
  const w = await agentWorld(t);
  const { sid } = await attached(w, TECH);
  // Rows made by hand (the API would store both of these as services): a person-kind admin with no "@" in its name, and a service.
  w.db.sqlite.prepare("INSERT INTO members(workspace, identity, kind, name, role_id, added_at, added_by) VALUES ('default', 'local-dev', 'person', NULL, 'admin', 1, ?)").run(BOSS);
  w.db.sqlite.prepare("INSERT INTO members(workspace, identity, kind, name, role_id, added_at, added_by) VALUES ('default', 'a-service-client', 'service', NULL, 'admin', 1, ?)").run(BOSS);
  const list = (await w.tool(TECH, 'people_list')).people;
  assert.equal(list.find((p) => p.identity === 'local-dev')?.can_control, true);
  assert.equal(list.find((p) => p.identity === 'a-service-client'), undefined);
  const invite = (identity) => w.tool(TECH, 'session_participants', { session_id: sid, action: 'invite', identity });
  assert.deepEqual(rows((await invite('local-dev')).participants), [`${TECH}:driver`, 'local-dev:invited']);
  // Everyone people_list marks can_control is accepted; the service client, which it leaves out, is not.
  for (const p of list.filter((x) => x.can_control && x.identity !== TECH)) assert.equal((await invite(p.identity)).error, undefined, p.identity);
  assert.match((await invite('a-service-client')).error, /^cannot_control: /);
});

test('an invite never widens access: on a PC the owner was never asked about, the target needs "connect without asking" too', async (t) => {
  const w = await agentWorld(t);
  await addTech2(w);
  const { sid } = await attached(w, LEAD);
  const invite = (identity) => w.tool(LEAD, 'session_participants', { session_id: sid, action: 'invite', identity });
  assert.match((await invite(TECH2)).error, /^needs_unattended: /);
  assert.match((await invite(TECH)).error, /^needs_unattended: /);
  assert.equal(rows((await invite(BOSS)).participants).length, 2, 'an admin holds it');
  assert.equal(w.sql("SELECT COUNT(*) AS n FROM notifications WHERE event = 'session_invited'")[0].n, 1, 'no notice for a refused invite');
  assert.match((await w.tool(TECH2, 'session_participants', { session_id: sid, action: 'join' })).error, /^needs_unattended: This PC was connected without asking its owner/);
});

test('session_status shows the people, the offer and the picture\'s rev and time; viewers read it, nobody gets more', async (t) => {
  const w = await agentWorld(t);
  await addTech2(w);
  const { sid } = await attached(w, TECH);
  await w.tool(TECH, 'session_participants', { session_id: sid, action: 'invite', identity: TECH2 });
  await w.tool(TECH2, 'session_participants', { session_id: sid, action: 'join' });
  await w.tool(TECH, 'session_handover', { session_id: sid, action: 'offer', identity: TECH2 });
  const s = await w.tool(VIEW, 'session_status', { session_id: sid });
  assert.deepEqual(rows(s.participants), [`${TECH}:driver`, `${TECH2}:watcher`]);
  assert.deepEqual(s.offer, { to: TECH2, by: TECH, expires_at: w.now() + 120_000 });
  assert.deepEqual([s.frame_rev, s.frame_at], [null, null]);
  assert.ok(!JSON.stringify(s).includes(JPEG), 'status never carries the picture');
});

test('an ended session shows no people and no offer in its status', async (t) => {
  const w = await agentWorld(t);
  await addTech2(w);
  const { sid } = await attached(w, TECH);
  await w.tool(TECH, 'session_participants', { session_id: sid, action: 'invite', identity: TECH2 });
  await w.tool(TECH2, 'session_participants', { session_id: sid, action: 'join' });
  await w.tool(TECH, 'session_handover', { session_id: sid, action: 'offer', identity: TECH2 });
  assert.equal((await w.tool(VIEW, 'session_status', { session_id: sid })).participants.length, 2);
  await w.tool(TECH, 'session_end', { session_id: sid });
  const ended = await w.tool(VIEW, 'session_status', { session_id: sid });
  assert.equal(ended.state, 'ended');
  assert.deepEqual([ended.participants, ended.offer, ended.frame_rev], [[], null, null]);
});

// ---- the picture ----------------------------------------------------------------------------------
async function watched(w, handler) {
  await addTech2(w);
  const pc = await w.addPc({ access: 'any', name: 'Till' });
  const { sid, welcome } = await w.attach(pc, TECH);
  const pump = w.pump({ sid, key: pc.key, generation: welcome.body.generation, handler });
  return { pc, sid, pump };
}
const frameApi = (w, who, sid, slug = 'default') => w.api(who, 'GET', `/sessions/${sid}/frame`, undefined, slug);

test('a joined watcher gets the picture; frame_rev moves with a full screenshot and never with a zoom', async (t) => {
  const w = await agentWorld(t);
  const { sid, pump } = await watched(w, screens([pic('ONE'), pic('TWO')]));
  t.after(() => pump.stop());
  await w.tool(TECH, 'session_participants', { session_id: sid, action: 'invite', identity: TECH2 });
  // Invited but not joined: no picture.
  assert.equal((await frameApi(w, TECH2, sid)).status, 403);
  await w.tool(TECH2, 'session_participants', { session_id: sid, action: 'join' });
  assert.equal((await frameApi(w, TECH2, sid)).body.error.code, 'no_frame');
  const at = w.now();
  await w.tool(TECH, 'screenshot', { session_id: sid });
  const one = await frameApi(w, TECH2, sid);
  assert.equal(one.status, 200, JSON.stringify(one.body));
  assert.deepEqual([one.body.data, one.body.mime, one.body.at], [pic('ONE'), 'image/jpeg', at]);
  const status = await w.tool(TECH, 'session_status', { session_id: sid });
  assert.deepEqual([status.frame_rev, status.frame_at], [one.body.rev, at]);
  await w.tool(TECH, 'zoom', { session_id: sid, x1: 0, y1: 0, x2: 10, y2: 10 });
  const afterZoom = await frameApi(w, TECH2, sid);
  assert.deepEqual([afterZoom.body.rev, afterZoom.body.data], [one.body.rev, pic('ONE')], 'a zoom changes nothing');
  assert.equal((await w.tool(TECH, 'session_status', { session_id: sid })).frame_rev, one.body.rev);
  w.advance(3000);
  await w.tool(TECH, 'screenshot', { session_id: sid });
  const two = await frameApi(w, TECH2, sid);
  assert.equal(two.body.data, pic('TWO'));
  assert.ok(two.body.rev > one.body.rev);
  // The driver reads it too; a person who left or was removed, a Viewer, a stranger and an admin who never joined do not.
  assert.equal((await frameApi(w, TECH, sid)).status, 200);
  for (const [who, status2] of [[BOSS, 403], [LEAD, 403], [VIEW, 403], ['stranger@example.com', 403]]) {
    const r = await frameApi(w, who, sid);
    assert.equal(r.status, status2, who);
    assert.ok(!JSON.stringify(r.body).includes(pic('TWO')), `${who} sees no picture`);
  }
  assert.equal((await frameApi(w, VIEW, sid)).body.error.code, 'permission_denied');
  assert.equal((await frameApi(w, BOSS, sid)).body.error.code, 'not_invited');
  await w.tool(TECH, 'session_participants', { session_id: sid, action: 'remove', identity: TECH2 });
  assert.equal((await frameApi(w, TECH2, sid)).status, 403);
});

test('the picture is gone after the session ends, a PC that was never asked needs "connect without asking" to see it, and routes are strict', async (t) => {
  const w = await agentWorld(t);
  const { sid, pump } = await watched(w, screens([pic('ONE')]));
  t.after(() => pump.stop());
  await w.tool(TECH, 'session_participants', { session_id: sid, action: 'invite', identity: TECH2 });
  await w.tool(TECH2, 'session_participants', { session_id: sid, action: 'join' });
  await w.tool(TECH, 'screenshot', { session_id: sid });
  assert.equal((await frameApi(w, TECH2, sid)).status, 200);
  // The path: only GET, only a 64-hex session id, only /frame.
  assert.equal((await w.api(TECH2, 'POST', `/sessions/${sid}/frame`, {})).status, 405);
  assert.equal((await w.api(TECH2, 'GET', `/sessions/${sid}`)).status, 404);
  assert.equal((await w.api(TECH2, 'GET', `/sessions/${sid}/frames`)).status, 404);
  assert.equal((await w.api(TECH2, 'GET', `/sessions/${sid}/frame/x`)).status, 404);
  assert.equal((await w.api(TECH2, 'GET', '/sessions')).status, 404);
  assert.equal((await w.api(TECH2, 'GET', `/sessions/${'a'.repeat(20)}/frame`)).status, 404);
  assert.equal((await w.api(TECH2, 'GET', `/sessions/${sid.toUpperCase()}/frame`)).status, 404);
  assert.equal((await frameApi(w, TECH2, 'f'.repeat(64))).body.error.code, 'not_found');
  // A stopped workspace shows no picture.
  await w.api(BOSS, 'POST', '/stop', {});
  assert.equal((await frameApi(w, TECH2, sid)).body.error.code, 'stopped');
  await w.api(BOSS, 'DELETE', '/stop');
  // Ended: gone.
  await w.tool(TECH, 'session_end', { session_id: sid });
  const gone = await frameApi(w, TECH2, sid);
  assert.deepEqual([gone.status, gone.body.error.code], [404, 'not_found']);
  assert.equal(w.sessionFor(sid).session.frame, null);
});

test('nothing holds picture bytes in storage: not the Session, D1, KV or a Registry', async (t) => {
  const w = await agentWorld(t);
  const full = pic('NEEDLEPIC');
  const { sid, pump } = await watched(w, screens([full]));
  t.after(() => pump.stop());
  await w.tool(TECH, 'session_participants', { session_id: sid, action: 'invite', identity: TECH2 });
  await w.tool(TECH2, 'session_participants', { session_id: sid, action: 'join' });
  await w.tool(TECH, 'screenshot', { session_id: sid });
  assert.equal((await frameApi(w, TECH2, sid)).body.data, full, 'the picture really flowed through the session');
  const needle = full.slice(4);
  const found = () => {
    const hits = [];
    const look = (where, text) => { if (text.includes(needle)) hits.push(where); };
    for (const [s, o] of w.sessions) look(`session ${s.slice(0, 8)}`, JSON.stringify([...o.ctx.values, o.ctx.logs]));
    for (const [n, o] of w.registries) look(`registry ${n}`, JSON.stringify([...o.ctx.values]));
    for (const { name } of w.db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) look(`D1 ${name}`, JSON.stringify(w.db.sqlite.prepare(`SELECT * FROM ${name}`).all()));
    look('D1 statements', JSON.stringify(w.db.seen));
    return hits;
  };
  assert.deepEqual(found(), []);
  await w.tool(TECH, 'session_end', { session_id: sid });
  assert.deepEqual(found(), []);
});

// ---- the app's address -----------------------------------------------------------------------------------
it('the app reads the picture on /app with its second factor, and a lost factor, a Viewer and a non-participant are refused', async (t) => {
  const w = await appWorld(t);
  await addTech2(w);
  const { sid, pump } = await watched(w, screens([pic('APP')]));
  t.after(() => pump.stop());
  await w.tool(TECH, 'session_participants', { session_id: sid, action: 'invite', identity: TECH2 });
  const tech2 = await w.connect(TECH2, { app: true, factor: true });
  const join = await w.appTool(tech2.access, 'session_participants', { session_id: sid, action: 'join' });
  assert.deepEqual(rows(join.participants), [`${TECH}:driver`, `${TECH2}:watcher`]);
  await w.tool(TECH, 'screenshot', { session_id: sid });
  const frame = (token, id = sid) => w.appCall(token, 'GET', `/api/sessions/${id}/frame`);
  const ok = await frame(tech2.access);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(Object.keys(ok.body).sort(), ['at', 'data', 'mime', 'rev']);
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  // A Viewer, someone who never joined, no credential, an MCP token.
  const view = await w.connect(VIEW, { app: true, factor: false });
  assert.equal((await frame(view.access)).body.error.code, 'permission_denied');
  const boss = await w.connect(BOSS, { app: true, factor: true });
  assert.equal((await frame(boss.access)).body.error.code, 'not_invited');
  assert.equal((await frame(null)).status, 401);
  assert.equal((await frame((await w.connect(TECH2, { app: false })).access)).status, 401);
  assert.equal((await w.appCall(tech2.access, 'POST', `/api/sessions/${sid}/frame`, {})).status, 404, 'the app has the route for GET only');
  assert.equal((await frame(tech2.access, 'nope')).status, 404);
  assert.equal((await w.appCall(tech2.access, 'GET', `/api/sessions/${sid}`)).status, 404);
  // The authenticator is gone: refused, with no picture.
  w.loseFactor(tech2.userId);
  const lost = await frame(tech2.access);
  assert.deepEqual([lost.status, lost.body.error.code], [403, 'second_factor']);
  assert.ok(!JSON.stringify(lost.body).includes(pic('APP')));
  assert.match((await w.appTool(tech2.access, 'session_participants', { session_id: sid, action: 'leave' })).error ?? '', /./, 'the tools refuse too');
  // An Access login has the route too, under the same rule.
  assert.equal((await frameApi(w, TECH, sid)).status, 200);
});

it('on a PC the owner was never asked about, the app\'s picture needs the permission to connect without asking and its factor', async (t) => {
  const w = await appWorld(t);
  await addTech2(w);
  const pc = await w.addPc({ access: 'any', name: 'Till' });
  const { sid, welcome } = await w.attach(pc, LEAD);
  const pump = w.pump({ sid, key: pc.key, generation: welcome.body.generation, handler: screens([pic('UNASKED')]) });
  t.after(() => pump.stop());
  await w.tool(LEAD, 'screenshot', { session_id: sid });
  const tech2 = await w.connect(TECH2, { app: true, factor: true });
  const boss = await w.connect(BOSS, { app: true, factor: true });
  const frame = (token) => w.appCall(token, 'GET', `/api/sessions/${sid}/frame`);
  assert.equal((await w.appTool(boss.access, 'session_participants', { session_id: sid, action: 'join' })).error.slice(0, 12), 'not_invited:');
  await w.tool(LEAD, 'session_participants', { session_id: sid, action: 'invite', identity: BOSS });
  assert.equal((await w.appTool(boss.access, 'session_participants', { session_id: sid, action: 'join' })).participants.length, 2);
  assert.equal((await frame(boss.access)).status, 200);
  // The technician without the permission is refused by the rule before the roster is looked at.
  const e = await w.appTool(tech2.access, 'session_participants', { session_id: sid, action: 'join' });
  assert.match(e.error, /^needs_unattended: /);
  const r = await frame(tech2.access);
  assert.deepEqual([r.status, r.body.error.code], [403, 'needs_unattended']);
  assert.ok(!JSON.stringify(r.body).includes(pic('UNASKED')));
});

// ---- another team -----------------------------------------------------------------------------------------
test('a session of another team answers the new tools as a session that does not exist', async (t) => {
  const w = await agentWorld(t);
  await addTech2(w);
  const team = teamStore(w.db, { deploymentAdmins: BOSS });
  await team.createWorkspace(BOSS, { slug: 'acme', name: 'Acme' });
  for (const who of [TECH, TECH2]) await team.addMember('acme', BOSS, { identity: who, role_id: 'admin' });
  const { sid } = await attached(w, TECH);
  await w.tool(TECH, 'session_participants', { session_id: sid, action: 'invite', identity: TECH2 });
  const before = JSON.stringify([...w.sessionFor(sid).ctx.values]);
  for (const [name, args] of Object.entries({
    session_participants: { session_id: sid, action: 'join' },
    session_participants_invite: { session_id: sid, action: 'invite', identity: BOSS },
    session_handover: { session_id: sid, action: 'accept' },
    session_handover_offer: { session_id: sid, action: 'offer', identity: TECH2 },
    session_handover_take_over: { session_id: sid, action: 'take_over' },
    escalation: { action: 'open', session_id: sid },
  })) {
    const tool = name.replace(/_(invite|offer|take_over)$/, '');
    const r = await w.tool(TECH2, tool, args, '/w/acme/mcp');
    assert.match(r.error, /^not_found: no such live session$/, name);
  }
  assert.equal(JSON.stringify([...w.sessionFor(sid).ctx.values]), before, 'the session was not touched');
  // session_status from the other team is the status of a session that does not exist.
  assert.deepEqual(await w.tool(TECH2, 'session_status', { session_id: sid }, '/w/acme/mcp'), await w.tool(TECH2, 'session_status', { session_id: 'e'.repeat(64) }, '/w/acme/mcp'));
  assert.equal((await frameApi(w, TECH2, sid, 'acme')).body.error.code, 'not_found');
});
