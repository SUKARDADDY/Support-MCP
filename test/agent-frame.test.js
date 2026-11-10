// The agent's last screen: GET /app/w/<team>/api/agent/tasks/<id>/frame. The last full
// screenshot a task took is held in the task's memory and nowhere else, read only by
// the person who started the task or the one who drives its session, on the terms a
// screenshot is read, and gone when the task ends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appWorld, skip, BOSS, TECH, VIEW, LEAD } from './app-world.js';
import { shot } from './agent-world.js';
import { oai } from './agent-fakes.js';

const it = (name, fn) => test(name, { skip }, fn);
const shotCall = () => oai.call('screenshot', { display: null });
const zoomCall = () => oai.call('zoom', { x1: 0, y1: 0, x2: 100, y2: 100, display: null });
const finish = () => oai.call('finish', { outcome: 'done', summary: 'ok' });

// Distinct pictures with the right magic bytes, so a test can tell them apart and search for them.
const picture = (word) => `/9j/${btoa(word.padEnd(9, '_')).replace(/=+$/, '').padEnd(12, 'A')}`;
const FULL_ONE = picture('FULLONE');
const FULL_TWO = picture('FULLTWO');
const ZOOMED = picture('ZOOMED');

// The PC answers a screenshot with the next full picture and a zoom with its own.
function screens(...fulls) {
  let n = 0;
  return (frame) => {
    if (frame.type === 'screen' && frame.action.name === 'zoom') return shot({ image_b64: ZOOMED, width: 640, height: 400 });
    if (frame.type === 'screen' && frame.action.name === 'screenshot') return shot({ image_b64: fulls[Math.min(n++, fulls.length - 1)] });
    return null;
  };
}

// The app signs in as `who`, starts a task on a new PC through /app, and the PC joins it.
async function startThroughApp(w, who = TECH, { handler = screens(FULL_ONE), name = 'Till' } = {}) {
  const app = await w.connect(who, { app: true, factor: true });
  const pc = await w.addPc({ access: 'any', name });
  const r = await w.appCall(app.access, 'POST', '/api/agent/tasks', { device_id: pc.id, instructions: 'The printer stopped printing.', keep_working: true });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await w.alarm(r.body.task_id); // connect
  const joined = await w.joinPc(pc, handler);
  return { app, pc, id: r.body.task_id, joined };
}
const frame = (w, token, id, slug = 'default') => w.appCall(token, 'GET', `/api/agent/tasks/${id}/frame`, undefined, { slug });

it('the frame is 404 until the task has taken a screenshot, then it is the last full one, with its time and type', async (t) => {
  const w = await appWorld(t);
  await w.ready();
  const { app, id } = await startThroughApp(w, TECH, { handler: screens(FULL_ONE, FULL_TWO) });
  const none = await frame(w, app.access, id);
  assert.equal(none.status, 404);
  assert.equal(none.body.error.code, 'no_frame');

  w.fake.queue('openai', shotCall(), shotCall());
  const before = w.now();
  await w.alarm(id); // a new conversation takes a screenshot, then the model asks for another
  const one = await frame(w, app.access, id);
  assert.equal(one.status, 200, JSON.stringify(one.body));
  assert.deepEqual(Object.keys(one.body).sort(), ['at', 'data', 'mime', 'rev']);
  assert.deepEqual([one.body.mime, one.body.data, one.body.at], ['image/jpeg', FULL_TWO, before]);
  assert.equal(Number.isInteger(one.body.rev), true);
  assert.equal(one.headers.get('cache-control'), 'no-store');

  // The task's status rev moves when a picture is kept, so a long poll wakes for it.
  const status = await w.appCall(app.access, 'GET', `/api/agent/tasks/${id}`);
  assert.ok(status.body.task.rev >= one.body.rev, 'the status rev is at least the picture\'s');
  assert.ok(!JSON.stringify(status.body).includes(FULL_TWO), 'the status never carries the picture');
});

it('a zoom never replaces the frame, and a later full screenshot does', async (t) => {
  const w = await appWorld(t);
  await w.ready();
  const { app, id } = await startThroughApp(w, TECH, { handler: screens(FULL_ONE, FULL_TWO) });
  w.fake.queue('openai', zoomCall(), zoomCall(), shotCall());
  await w.alarm(id); // fresh screenshot (FULL_ONE), then a zoom
  assert.equal((await frame(w, app.access, id)).body.data, FULL_ONE);
  const rev = (await frame(w, app.access, id)).body.rev;
  await w.alarm(id); // another zoom
  assert.deepEqual([(await frame(w, app.access, id)).body.data, (await frame(w, app.access, id)).body.rev], [FULL_ONE, rev], 'unchanged by zooms');
  await w.alarm(id); // a full screenshot
  const now = await frame(w, app.access, id);
  assert.equal(now.body.data, FULL_TWO);
  assert.ok(now.body.rev > rev);
});

it('the frame is gone when the task ends, however it ends, and after the object is evicted until the next screenshot', async (t) => {
  const w = await appWorld(t);
  await w.ready();
  const a = await startThroughApp(w, TECH);
  w.fake.queue('openai', shotCall(), shotCall(), finish());
  await w.alarm(a.id);
  assert.equal((await frame(w, a.app.access, a.id)).status, 200);
  // An evicted object loses it: the same storage, a new instance.
  w.restart(a.id);
  const lost = await frame(w, a.app.access, a.id);
  assert.deepEqual([lost.status, lost.body.error.code], [404, 'no_frame']);
  await w.alarm(a.id); // a fresh conversation, so a fresh screenshot
  assert.equal((await frame(w, a.app.access, a.id)).status, 200);
  await w.drive(a.id);
  assert.equal(w.taskRow(a.id).state, 'done');
  const ended = await frame(w, a.app.access, a.id);
  assert.deepEqual([ended.status, ended.body.error.code], [404, 'no_frame']);

  // A task stopped by its starter: gone at once, before the object has even cleaned up.
  const b = await startThroughApp(w, TECH, { name: 'Two' });
  w.fake.queue('openai', shotCall());
  await w.alarm(b.id);
  assert.equal((await frame(w, b.app.access, b.id)).status, 200);
  assert.equal((await w.appCall(b.app.access, 'POST', `/api/agent/tasks/${b.id}/stop`, {})).body.state, 'stopped');
  assert.equal((await frame(w, b.app.access, b.id)).status, 404);
  assert.equal(w.taskObject(b.id).task.frame, null, 'dropped from memory too');
});

it('only the task\'s starter or its session\'s current driver can read the frame, and only with sessions.control', async (t) => {
  const w = await appWorld(t);
  await w.ready();
  const a = await startThroughApp(w, TECH);
  w.fake.queue('openai', shotCall());
  await w.alarm(a.id);
  const lead = await w.connect(LEAD, { app: true, factor: true });
  const boss = await w.connect(BOSS, { app: true, factor: true });
  const view = await w.connect(VIEW, { app: true, factor: false });
  assert.equal(view.tokens.status, 200);

  assert.equal((await frame(w, a.app.access, a.id)).status, 200, 'the starter');
  for (const [who, token] of [['a Viewer', view.access], ['a technician who is neither', lead.access], ['an admin who is neither', boss.access]]) {
    const r = await frame(w, token, a.id);
    assert.equal(r.status, 403, who);
    assert.ok(!JSON.stringify(r.body).includes(FULL_ONE), `${who} sees no picture`);
  }
  assert.equal((await frame(w, view.access, a.id)).body.error.code, 'permission_denied');
  assert.equal((await frame(w, lead.access, a.id)).body.error.code, 'forbidden');

  // Someone with sessions.unattended takes the session over: they drive it now, and may read the frame.
  assert.equal((await w.tool(LEAD, 'device_connect', { device_id: a.pc.id, take_over: true })).takeover, undefined);
  assert.equal((await frame(w, lead.access, a.id)).status, 200, 'the driver');
  assert.equal((await frame(w, a.app.access, a.id)).status, 200, 'the starter still');
  assert.equal((await frame(w, boss.access, a.id)).status, 403);
});

it('the frame needs the second factor, a member, a running workspace, and a task that exists', async (t) => {
  const w = await appWorld(t);
  await w.ready();
  const a = await startThroughApp(w, TECH);
  w.fake.queue('openai', shotCall());
  await w.alarm(a.id);
  assert.equal((await frame(w, a.app.access, a.id)).status, 200);

  // Not a task, not an id, not a GET.
  assert.equal((await frame(w, a.app.access, 'a'.repeat(20))).status, 404);
  assert.equal((await frame(w, a.app.access, 'nope')).status, 400);
  assert.equal((await w.appCall(a.app.access, 'POST', `/api/agent/tasks/${a.id}/frame`, {})).status, 405);
  assert.equal((await w.appCall(a.app.access, 'DELETE', `/api/agent/tasks/${a.id}/frame`, {})).status, 405);
  // Access logins have no frame: the picture is the app's.
  const viaAccess = await w.api(TECH, 'GET', `/agent/tasks/${a.id}/frame`);
  assert.equal(viaAccess.status, 404);
  assert.ok(!JSON.stringify(viaAccess.body).includes(FULL_ONE));
  // No credential, a junk token, an MCP token.
  assert.equal((await frame(w, null, a.id)).status, 401);
  const mcp = await w.connect(TECH, { app: false });
  assert.equal((await frame(w, mcp.access, a.id)).status, 401);

  // The workspace is stopped: no picture, as no screenshot.
  await w.api(BOSS, 'POST', '/stop', {});
  const stopped = await frame(w, a.app.access, a.id);
  assert.deepEqual([stopped.status, stopped.body.error.code], [409, 'stopped']);
  await w.api(BOSS, 'DELETE', '/stop');
  assert.equal((await frame(w, a.app.access, a.id)).status, 200);

  // The authenticator is gone: the same as for a screenshot.
  w.loseFactor(a.app.userId);
  const noFactor = await frame(w, a.app.access, a.id);
  assert.deepEqual([noFactor.status, noFactor.body.error.code], [403, 'second_factor']);
  assert.ok(!JSON.stringify(noFactor.body).includes(FULL_ONE));
});

it('the starter who leaves the team, or whose account is disabled, can no longer read the frame', async (t) => {
  const w = await appWorld(t);
  await w.ready();
  const a = await startThroughApp(w, TECH);
  w.fake.queue('openai', shotCall());
  await w.alarm(a.id);
  assert.equal((await frame(w, a.app.access, a.id)).status, 200);
  await w.team.removeMember('default', BOSS, TECH);
  const gone = await frame(w, a.app.access, a.id);
  assert.equal(gone.status, 403);
  assert.ok(!JSON.stringify(gone.body).includes(FULL_ONE));
});

it('no storage write holds image bytes: not the task\'s storage, not D1, not KV, not a Session or a Registry', async (t) => {
  const w = await appWorld(t);
  await w.ready();
  const a = await startThroughApp(w, TECH, { handler: screens(FULL_ONE, FULL_TWO) });
  w.fake.queue('openai', shotCall(), zoomCall(), shotCall(), finish());
  for (let i = 0; i < 3; i++) await w.alarm(a.id);
  assert.equal((await frame(w, a.app.access, a.id)).body.data, FULL_TWO, 'the picture really flowed through the task');
  // Pause it so the object holds the picture while everything is searched, then look at the ended task too.
  const needles = [FULL_ONE, FULL_TWO, ZOOMED].map((p) => p.slice(4));
  const everywhere = () => {
    const found = [];
    const look = (where, text) => { for (const n of needles) if (text.includes(n)) found.push(`${where}: ${n}`); };
    // Every Durable Object's storage: the task, the sessions, the registries.
    for (const [name, o] of w.objects) look(`task ${name}`, JSON.stringify([...o.ctx.values]));
    for (const [sid, o] of w.sessions) look(`session ${sid.slice(0, 8)}`, JSON.stringify([...o.ctx.values, o.ctx.logs]));
    for (const [name, o] of w.registries) look(`registry ${name}`, JSON.stringify([...o.ctx.values]));
    // Every row of every table in D1, and everything D1 was ever asked to run.
    for (const { name } of w.db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
      look(`D1 ${name}`, JSON.stringify(w.db.sqlite.prepare(`SELECT * FROM ${name}`).all()));
    }
    look('D1 statements', JSON.stringify(w.db.seen));
    // Every KV value and key.
    look('KV', JSON.stringify([...w.kv.rows]));
    return found;
  };
  // The Session keeps the last full screenshot for the people watching it, in memory: the scan below covers its storage.
  const session = w.sessionFor(a.joined.sid).session;
  assert.ok(session.frame && needles.some((n) => session.frame.data.includes(n)), 'the Session holds a picture in memory');
  assert.deepEqual(everywhere(), [], 'while the task works');
  await w.drive(a.id);
  assert.equal(w.taskRow(a.id).state, 'done');
  assert.deepEqual(everywhere(), [], 'after it ends');
  assert.equal(w.taskObject(a.id).task.frame, null);
  assert.equal(session.frame, null, 'the Session dropped its picture when the session ended');
});

it('a tool call still in flight when the task ends does not put the picture back in memory', async (t) => {
  const w = await appWorld(t);
  await w.ready();
  const a = await startThroughApp(w, TECH, { handler: screens(FULL_ONE) });
  w.fake.queue('openai', shotCall());
  await w.alarm(a.id);
  const task = w.taskObject(a.id).task;
  assert.equal(task.frame?.data, FULL_ONE, 'the task holds a picture while it works');
  const late = { content: [{ type: 'image', data: FULL_TWO, mimeType: 'image/jpeg' }] };
  // Ending: cleanup has cleared the frame and the result of the call in flight comes in.
  task.st.ending = true;
  task.frame = null;
  task.holdFrame('screenshot', late);
  assert.equal(task.frame, null, 'ending');
  // Done: the same.
  task.st.ending = false;
  task.st.done = true;
  task.holdFrame('screenshot', late);
  assert.equal(task.frame, null, 'done');
  // Working again would hold it, so the guard is what keeps it out.
  task.st.done = false;
  task.holdFrame('screenshot', late);
  assert.equal(task.frame.data, FULL_TWO);
});
