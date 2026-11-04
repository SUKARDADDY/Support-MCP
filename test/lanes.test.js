// Two lanes, screen frames, control frames and the audit rules, driven through
// the Session Durable Object's /agent and /command routes and through /mcp.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../src/session.js';
import { createHandler } from '../src/app.js';

const SID = 'a'.repeat(64);
const JPEG = '/9j/4AAQ';
const PNG = 'iVBORw0KGgoAAAAA';
const NEW_CAPS = ['screen', 'uia', 'lanes', 'full'];

function fixture() {
  const values = new Map(), logs = [], registryBodies = [];
  const ctx = { getWebSockets: () => [], storage: {
    get: async (k) => Array.isArray(k) ? new Map(k.map((x) => [x, values.get(x)])) : values.get(k),
    put: async (o) => { for (const [k, v] of Object.entries(o)) values.set(k, v); },
    setAlarm: async () => {}, deleteAlarm: async () => {},
    sql: { exec(q, ...a) { if (q.startsWith('INSERT INTO log')) logs.push({ ts: a[0], kind: a[1], detail: a[2] }); return { toArray: () => logs.slice().reverse() }; } },
  } };
  const registry = { idFromName: (n) => n, get: () => ({ fetch: async (url, init) => { if (init?.body) registryBodies.push(init.body); return Response.json({ sessions: [] }); } }) };
  const session = new Session(ctx, { REGISTRY: registry });
  const req = (path, body, key = '') => session.fetch(new Request(`https://do${path}`, { method: 'POST', headers: { 'X-Attach-Key': key }, body: JSON.stringify(body) }));
  const env = { DEV_SKIP_ACCESS: '1', REGISTRY: registry, SESSION: { idFromName: () => SID, idFromString: () => SID, get: () => ({ fetch: (r, opts) => session.fetch(typeof r === 'string' ? new Request(r, opts) : r) }) } };
  return { session, values, logs, registryBodies, req, env };
}

// Waits on real time, not a tick count: hashing the attach key runs on the thread pool, which is slow on a busy CI
// runner. setImmediate and performance.now are used because some tests mock setTimeout and Date.
const until = async (cond, ms = 2000) => { const end = performance.now() + ms; while (!cond() && performance.now() < end) await new Promise((r) => setImmediate(r)); assert.ok(cond(), 'condition never held'); };

// An attached app session. `hello` is what the app says; no caps is an old client.
async function attach(hello = {}, mode = 'app') {
  const f = fixture();
  await f.req('/create', { sid: SID, windows_mode: mode });
  const { key } = await (await f.req('/consume', { windows_mode: mode })).json();
  const out = { machine: 'POS', user: 'pos', agent: 'windows-app-2', caps: NEW_CAPS, control: 'normal', ...hello };
  const welcome = await (await f.req('/agent', { type: 'hello', ...out }, key)).json();
  const g = welcome.generation;
  Object.assign(f, {
    key, generation: g,
    agent: (body) => f.req('/agent', { generation: g, ...body }, key),
    poll: async (body = {}) => (await f.agent({ type: 'poll', ...body })).json(),
    op: (body) => f.req('/command', { actor: 'op@example.com', ...body }).then((r) => r.json()),
    result: async (frame, body) => f.agent({ type: 'result', id: frame.id, ok: true, ...body }),
    status: async () => (await f.session.fetch(new Request('https://do/status?log_tail=100'))).json(),
    end: () => f.req('/end', {}),
  });
  return f;
}

const shotResult = (extra = {}) => ({ image_b64: JPEG, mime: 'image/jpeg', width: 1280, height: 800, display: 0, displays: 1, desktop: 'default', ...extra });
const screen = (name, extra = {}) => ({ op: 'screen', action: { name, ...extra } });

test('hello stores caps, control and the agent, and status reports them', async () => {
  const f = await attach({ caps: ['screen', 'lanes', 'bogus', 'full'] });
  const s = await f.status();
  assert.deepEqual(s.caps, ['screen', 'lanes', 'full']);
  assert.equal(s.control, 'normal');
  assert.equal(s.client_version, 'windows-app-2');
  assert.deepEqual([s.desktop, s.paused_until, s.input_blocked_until], [null, null, null]);
  assert.ok(f.logs.some((l) => l.kind === 'hello' && l.detail.includes('control=normal') && l.detail.includes('caps=screen,lanes,full')));
  // A bad control value is stored as null, and an old client reports no caps.
  const old = await attach({ caps: undefined, control: 'root', agent: 'windows-app-1' });
  const o = await old.status();
  assert.deepEqual([o.caps, o.control, o.client_version], [[], null, 'windows-app-1']);
});

test('a poll may report desktop and the two deadlines; status drops a deadline that has passed', async () => {
  const f = await attach();
  const future = Date.now() + 60000;
  await f.poll({ busy_lanes: ['cmd', 'screen'], desktop: 'secure', paused_until: future, input_blocked_until: Date.now() - 1000 });
  let s = await f.status();
  assert.deepEqual([s.desktop, s.paused_until, s.input_blocked_until], ['secure', future, null]);
  await f.poll({ busy_lanes: ['cmd', 'screen'], desktop: 'not-a-desktop', paused_until: 'soon' });
  s = await f.status();
  assert.deepEqual([s.desktop, s.paused_until], [null, null]);
  // A new hello starts from nothing.
  await f.poll({ busy_lanes: ['cmd', 'screen'], desktop: 'default' });
  await f.req('/agent', { type: 'hello', caps: NEW_CAPS, control: 'full' }, f.key);
  s = await f.status();
  assert.deepEqual([s.desktop, s.control], [null, 'full']);
});

test('the two lanes run at once: both frames are out, results arrive in either order', async () => {
  const f = await attach();
  const run = f.op({ op: 'run', command: 'sleep 30' });
  await until(() => f.session.httpCommands.cmd);
  const shot = f.op(screen('screenshot'));
  await until(() => f.session.httpCommands.screen);
  const first = await f.poll({ busy_lanes: [] });
  assert.equal(first.type, 'run');
  assert.equal(first.lane, 'cmd');
  assert.equal(first.as, 'user');
  const second = await f.poll({ busy_lanes: ['cmd'] });
  assert.deepEqual([second.type, second.lane, second.action], ['screen', 'screen', { name: 'screenshot', display: 0 }]);
  // The screen result lands while the command still runs.
  assert.equal((await (await f.result(second, shotResult())).json()).type, 'ack');
  const image = await shot;
  assert.deepEqual([image.ok, image.width, image.height, image.mime, image.control], [true, 1280, 800, 'image/jpeg', 'normal']);
  assert.equal(f.session.httpCommands.cmd.frame.id, first.id);
  await f.result(first, { stdout_b64: btoa('done'), stderr_b64: '', exit_code: 0 });
  assert.equal((await run).stdout, 'done');
  assert.deepEqual(f.session.httpCommands, { cmd: null, screen: null });
});

test('busy is per lane: a second command on a lane waits, the other lane is free', async () => {
  const f = await attach();
  const run = f.op({ op: 'run', command: 'one' });
  await until(() => f.session.httpCommands.cmd);
  const busy = 'agent busy; wait for the current operation';
  assert.equal((await f.op({ op: 'get_file', path: 'C:\\x' })).error, busy);
  assert.equal((await f.op({ op: 'put_file', path: 'C:\\x', data_b64: '' })).error, busy);
  const shot = f.op(screen('screenshot'));
  await until(() => f.session.httpCommands.screen);
  assert.equal((await f.op(screen('click', { x: 1, y: 2 }))).error, busy);
  assert.equal((await f.op({ op: 'control', action: 'request_full_control' })).error, busy);
  await f.end();
  await run; await shot;
});

test('a busy lane is not sent again, a free lane gets its frame, and a poll with every lane busy parks nothing', async () => {
  const f = await attach();
  const run = f.op({ op: 'run', command: 'one' });
  await until(() => f.session.httpCommands.cmd);
  const first = await f.poll({ busy_lanes: [] });
  assert.equal(first.type, 'run');
  assert.deepEqual(await f.poll({ busy_lanes: ['cmd', 'screen'] }), { type: 'idle' });
  assert.equal(f.session.httpPoll, null);
  // The cmd frame is queued and the client says cmd is busy: the poll parks instead of getting it again.
  const parked = f.poll({ busy_lanes: ['cmd'] });
  await until(() => f.session.httpPoll);
  // A screen command reaches the parked poll at once.
  const shot = f.op(screen('screenshot'));
  const frame = await parked;
  assert.equal(frame.type, 'screen');
  await f.result(frame, shotResult());
  await shot;
  // The cmd frame is not redelivered right away, even to a poll that says cmd is free.
  const early = f.poll({ busy_lanes: [] });
  await until(() => f.session.httpPoll);
  assert.equal(f.session.httpPoll.busy.size, 0);
  await f.result(first, { stdout_b64: '', stderr_b64: '', exit_code: 0 });
  await run;
  await f.end();
  assert.equal((await early).type, 'end');
});

test('a parked poll learns that a lane is free when its result arrives', async () => {
  const f = await attach();
  const shot = f.op(screen('screenshot'));
  await until(() => f.session.httpCommands.screen);
  const frame = await f.poll({ busy_lanes: [] });
  const parked = f.poll({ busy_lanes: ['screen'] });
  await until(() => f.session.httpPoll);
  assert.deepEqual([...f.session.httpPoll.busy], ['screen']);
  await f.result(frame, shotResult());
  await shot;
  assert.deepEqual([...f.session.httpPoll.busy], []);
  const next = f.op(screen('move', { x: 1, y: 2 }));
  assert.equal((await parked).action.name, 'move');
  await f.end();
  await next;
});

test('a frame that was sent is not sent again within five seconds, then is', async (t) => {
  const f = await attach();
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const run = f.op({ op: 'run', command: 'one' });
  await until(() => f.session.httpCommands.cmd);
  const frame = await f.poll({ busy_lanes: [] });
  assert.equal(frame.type, 'run');
  const raced = f.poll({ busy_lanes: [] });
  await until(() => f.session.httpPoll);
  now += 5000;
  const lost = await f.poll({ busy_lanes: [] });
  assert.equal(lost.id, frame.id);
  await f.end();
  await raced; await run;
});

test('a frame sent into a poll the app aborted goes out when the guard ends, not after the full 25 s park', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 });
  const f = await attach();
  // The app is running a command and parks a poll for the screen lane.
  const run = f.op({ op: 'run', command: 'one' });
  await until(() => f.session.httpCommands.cmd);
  const first = await f.poll({ busy_lanes: [] });
  assert.equal(first.type, 'run');
  const parked = f.poll({ busy_lanes: ['cmd'] });
  await until(() => f.session.httpPoll);
  // The command finishes and the app aborts that poll (Wake) before posting the result. The relay
  // does not know the poll is dead, so a screen frame queued now is written to it and counts as sent.
  await f.result(first, { stdout_b64: '', stderr_b64: '', exit_code: 0 });
  await run;
  const shot = f.op(screen('screenshot'));
  const lost = await parked;
  assert.equal(lost.type, 'screen');
  // The app's next poll arrives at once. The frame is inside the guard window, so it parks.
  t.mock.timers.tick(200);
  let got = null;
  const next = f.poll({ busy_lanes: [] }).then((r) => { got = r; return r; });
  await until(() => f.session.httpPoll);
  t.mock.timers.tick(4000);
  await new Promise((r) => setImmediate(r));
  assert.equal(got, null, 'still held back inside the guard window');
  // At 5 s after the frame was sent it is delivered, 20 s before the old 25 s park would have ended.
  t.mock.timers.tick(900);
  await next;
  assert.equal(got.type, 'screen');
  assert.equal(got.id, lost.id);
  assert.equal(f.session.httpPoll, null);
  await f.result(got, shotResult());
  assert.equal((await shot).ok, true);
  // Without a held-back frame a poll still parks the full 25 s and then answers idle.
  let idle = null;
  const quiet = f.poll({ busy_lanes: ['cmd'] }).then((r) => { idle = r; });
  await until(() => f.session.httpPoll);
  t.mock.timers.tick(24999);
  await new Promise((r) => setImmediate(r));
  assert.equal(idle, null);
  t.mock.timers.tick(1);
  await quiet;
  assert.deepEqual(idle, { type: 'idle' });
  await f.end();
});

test('the relay waits 35 ms per typed character on top of the base wait', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 });
  const f = await attach();
  let out = null;
  const p = f.op(screen('type', { text: 'a'.repeat(1000) })).then((r) => { out = r; });
  await until(() => f.session.httpCommands.screen);
  const base = 30000 + 15000 + 1000 * 35;
  t.mock.timers.tick(base - 1);
  await new Promise((r) => setImmediate(r));
  assert.equal(out, null, 'still waiting just before the budget');
  t.mock.timers.tick(1);
  await p;
  assert.deepEqual([out.ok, out.error], [false, 'timeout waiting for agent']);
});

test('an old client keeps one lane and the busy flag, gets lane cmd on its frames, and cannot do screen work', async () => {
  const f = await attach({ caps: undefined, control: undefined, agent: 'windows-app-1' });
  const tooOld = 'this support app is too old for screen control';
  for (const body of [screen('screenshot'), screen('click', { x: 1, y: 2 }), { op: 'control', action: 'request_full_control' }]) {
    assert.equal((await f.op(body)).error, tooOld);
  }
  assert.equal(f.session.httpCommands.screen, null);
  const run = f.op({ op: 'run', command: 'whoami' });
  await until(() => f.session.httpCommands.cmd);
  assert.equal((await f.op({ op: 'run', command: 'two' })).error, 'agent busy; wait for the current operation');
  const frame = await f.poll({ busy: false });
  assert.deepEqual([frame.type, frame.lane, 'as' in frame], ['run', 'cmd', false]);
  assert.deepEqual(await f.poll({ busy: true }), { type: 'idle' });
  assert.deepEqual(await f.poll({ busy: true, busy_lanes: [] }), { type: 'idle' }, 'an old client\'s busy flag still counts');
  await f.result(frame, { stdout_b64: btoa('pos'), stderr_b64: '', exit_code: 0 });
  assert.equal((await run).stdout, 'pos');
  assert.equal((await f.op({ op: 'run', command: 'x', as: 'system' })).error, 'this support app is too old to run as system');
});

test('a client with lanes but no screen cap is refused screen work with its own message', async () => {
  // The app reports no screen cap when it was resumed from a consent that predates screen control.
  const f = await attach({ caps: ['lanes'] });
  const want = 'the customer has not approved screen control for this session';
  assert.equal((await f.op(screen('screenshot'))).error, want);
  assert.equal((await f.op(screen('type_secret', { text: 'x' }))).error, want);
  assert.equal(f.session.httpCommands.screen, null);
  // Commands still work.
  const run = f.op({ op: 'run', command: 'whoami' });
  await until(() => f.session.httpCommands.cmd);
  await f.end();
  await run;
});

test('the PowerShell fallback has no screen access, attached or not, and cannot run as system', async () => {
  const none = fixture();
  await none.req('/create', { sid: SID });
  const msg = 'the PowerShell fallback has no screen access';
  assert.equal((await (await none.req('/command', screen('screenshot'))).json()).error, msg, 'before it is attached');
  const { key } = await (await none.req('/consume', {})).json();
  assert.ok(key);
  assert.equal((await (await none.req('/command', { op: 'control', action: 'request_full_control' })).json()).error, msg);
  assert.equal((await (await none.req('/command', { op: 'run', command: 'x', as: 'system' })).json()).error, 'agent not attached');
  // An attached PowerShell session over the websocket.
  const ws = { sent: [], send(d) { this.sent.push(d); }, close() {}, tags: ['g1'] };
  none.session.ctx.getWebSockets = () => [ws];
  none.session.ctx.getTags = (w) => w.tags;
  none.values.set('state', 'attached');
  none.values.set('ws_tag', 'g1');
  none.values.set('expires_at', Date.now() + 1e6);
  assert.equal((await (await none.req('/command', screen('click', { x: 1, y: 2 }))).json()).error, msg);
  assert.equal((await (await none.req('/command', { op: 'run', command: 'x', as: 'system' })).json()).error, 'the PowerShell fallback cannot run as system');
  assert.equal(ws.sent.length, 0, 'nothing was sent to the PowerShell agent');
});

test('run takes as: user by default, system is passed through, anything else is refused', async () => {
  const f = await attach({ control: 'full' });
  const frameFor = async (extra) => {
    const p = f.op({ op: 'run', command: 'whoami', ...extra });
    await until(() => f.session.httpCommands.cmd);
    const frame = await f.poll({ busy_lanes: [] });
    await f.result(frame, { stdout_b64: '', stderr_b64: '', exit_code: 0 });
    await p;
    return frame;
  };
  assert.equal((await frameFor({})).as, 'user');
  assert.equal((await frameFor({ as: 'user' })).as, 'user');
  assert.equal((await frameFor({ as: 'system' })).as, 'system');
  assert.equal((await f.op({ op: 'run', command: 'x', as: 'root' })).error, 'as must be user or system');
  assert.equal(f.logs.filter((l) => l.kind === 'run').map((l) => l.detail).includes('[op@example.com] (system) whoami'), true);
});

test('run as system is refused unless the stored control is full, and nothing is sent to the app', async () => {
  const msg = 'as: "system" needs full control';
  for (const control of ['normal', undefined, 'root']) {
    const f = await attach({ control });
    assert.equal((await f.op({ op: 'run', command: 'whoami', as: 'system' })).error, msg);
    assert.equal(f.session.httpCommands.cmd, null, 'no frame was queued');
    assert.equal(f.logs.filter((l) => l.kind === 'run').length, 0, 'nothing was logged as run');
    // The default and as: user still work in normal mode.
    const run = f.op({ op: 'run', command: 'whoami' });
    await until(() => f.session.httpCommands.cmd);
    const frame = await f.poll({ busy_lanes: [] });
    assert.equal(frame.as, 'user');
    await f.result(frame, { stdout_b64: '', stderr_b64: '', exit_code: 0 });
    assert.equal((await run).ok, true);
  }
  // The stored control decides, not the caps: a client that says "full" in caps but control normal is refused.
  const f = await attach({ caps: NEW_CAPS, control: 'normal' });
  assert.equal((await f.op({ op: 'run', command: 'x', as: 'system' })).error, msg);
  // After a full-control hello it is allowed.
  await f.req('/agent', { type: 'hello', caps: NEW_CAPS, control: 'full' }, f.key);
  const full = f.op({ op: 'run', command: 'x', as: 'system' });
  await until(() => f.session.httpCommands.cmd);
  assert.equal(f.session.httpCommands.cmd.frame.as, 'system');
  await f.end();
  await full;
});

test('block_input and send_sas are refused in normal mode and never reach the app; type_secret is forwarded', async () => {
  const f = await attach({ control: 'normal' });
  for (const [name, extra] of [['block_input', { on: true }], ['block_input', { on: false }], ['send_sas', {}]]) {
    assert.equal((await f.op(screen(name, extra))).error, `${name} needs full control`);
    assert.equal(f.session.httpCommands.screen, null);
  }
  assert.equal(f.logs.filter((l) => l.kind === 'screen').length, 0, 'a refused action is not logged as done');
  const p = f.op(screen('type_secret', { text: 'pw-123' }));
  await until(() => f.session.httpCommands.screen);
  const frame = await f.poll({ busy_lanes: [] });
  assert.deepEqual([frame.type, frame.lane, frame.action.name, frame.action.text], ['screen', 'screen', 'type_secret', 'pw-123']);
  await f.result(frame, shotResult());
  assert.equal((await p).ok, true);
  // In full control the other two go through. The new hello starts a new generation.
  const { generation } = await (await f.req('/agent', { type: 'hello', caps: NEW_CAPS, control: 'full' }, f.key)).json();
  const again = (body) => f.req('/agent', { generation, ...body }, f.key);
  for (const [name, extra] of [['block_input', { on: true, minutes: 5 }], ['send_sas', {}]]) {
    const q = f.op(screen(name, extra));
    await until(() => f.session.httpCommands.screen);
    const fr = await (await again({ type: 'poll', busy_lanes: [] })).json();
    assert.equal(fr.action.name, name);
    await again({ type: 'result', id: fr.id, ok: true });
    assert.equal((await q).ok, true);
  }
});

test('screen frames carry the lane and the normalized action; a bad action is refused before anything is sent', async () => {
  const f = await attach();
  const p = f.op(screen('click', { x: 640.4, y: 412, button: 'right', junk: 1 }));
  await until(() => f.session.httpCommands.screen);
  const frame = await f.poll({ busy_lanes: ['cmd'] });
  assert.deepEqual(frame, { type: 'screen', id: frame.id, lane: 'screen', action: { name: 'click', x: 640, y: 412, button: 'right', count: 1, display: 0, screenshot: true } });
  await f.result(frame, shotResult({ displays: 2 }));
  const out = await p;
  assert.deepEqual([out.ok, out.displays, out.desktop, out.control], [true, 2, 'default', 'normal']);
  for (const action of [{ name: 'click', x: 'a', y: 1 }, { name: 'dance' }, { name: 'type', text: '' }]) {
    const r = await f.op({ op: 'screen', action });
    assert.equal(r.ok, false);
  }
  assert.equal(f.session.httpCommands.screen, null);
  assert.equal((await f.op({ op: 'screen' })).ok, false);
});

test('a screen result is validated field by field; a bad one gets 400 and leaves the command waiting', async () => {
  const f = await attach();
  const p = f.op(screen('screenshot'));
  await until(() => f.session.httpCommands.screen);
  const frame = await f.poll({ busy_lanes: [] });
  const long = '/9j/' + 'A'.repeat(700000);
  const bad = [
    shotResult({ image_b64: long }), shotResult({ image_b64: 'not base64!!' }), shotResult({ image_b64: PNG }),
    shotResult({ mime: 'image/gif' }), shotResult({ width: 0 }), shotResult({ height: 1.5 }), shotResult({ width: '1280' }),
    shotResult({ display: 3, displays: 2 }), shotResult({ desktop: 'winlogon' }), shotResult({ text: 5 }),
    { image_b64: undefined, mime: undefined, width: undefined, height: undefined }, // a screenshot with no image
  ];
  for (const body of bad) {
    const r = await f.result(frame, body);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
    assert.deepEqual(await r.json(), { error: 'invalid result' });
    assert.equal(f.session.pending.has(frame.id), true);
  }
  assert.equal((await f.result(frame, shotResult({ image_b64: PNG, mime: 'image/png' }))).status, 200);
  assert.equal((await p).mime, 'image/png');
});

test('an app error result passes through without image fields', async () => {
  const f = await attach();
  const p = f.op(screen('click', { x: 1, y: 2 }));
  await until(() => f.session.httpCommands.screen);
  const frame = await f.poll({ busy_lanes: [] });
  assert.equal((await f.agent({ type: 'result', id: frame.id, ok: false, error: 'customer is using the PC; try again in a few seconds', image_b64: JPEG })).status, 200);
  assert.deepEqual(await p, { ok: false, error: 'customer is using the PC; try again in a few seconds' });
});

test('audit rows: typed text is a length, type_secret is bare, screenshots log their size', async () => {
  const f = await attach({ control: 'full' });
  const drive = async (body, result) => {
    const p = f.op(body);
    await until(() => f.session.httpCommands.screen);
    const frame = await f.poll({ busy_lanes: [] });
    await f.result(frame, result);
    return p;
  };
  await drive(screen('screenshot'), shotResult());
  await drive(screen('click', { x: 640, y: 412 }), shotResult());
  await drive(screen('type', { text: 'my password is hunter2' }), shotResult());
  await drive(screen('key', { keys: 'ctrl+s' }), shotResult());
  await drive(screen('ui_act', { ref: 12, verb: 'invoke' }), {});
  await drive(screen('ui_act', { ref: 3, verb: 'set_value', value: 'VALUE-NOT-LOGGED' }), {});
  await drive(screen('block_input', { on: true, minutes: 10 }), {});
  await drive(screen('send_sas'), shotResult({ desktop: 'secure' }));
  await drive(screen('type_secret', { text: 'TOPSECRET-PW' }), shotResult());
  await drive(screen('screenshot', { display: 1 }), shotResult({ display: 1, displays: 2, width: 800, height: 600 }));
  const rows = f.logs.filter((l) => l.kind === 'screen').map((l) => l.detail);
  assert.deepEqual(rows, [
    '[op@example.com] screenshot 1280x800', '[op@example.com] click 640,412', '[op@example.com] type 22 chars', '[op@example.com] key ctrl+s',
    '[op@example.com] ui_act invoke 12', '[op@example.com] ui_act set_value 3', '[op@example.com] block_input on 10m',
    '[op@example.com] send_sas', '[op@example.com] type_secret', '[op@example.com] screenshot 800x600 display 1',
  ]);
  // Neither the typed text, the secret, the value nor any image is in a log row, storage, or the registry.
  const everything = JSON.stringify([f.logs, [...f.values], f.registryBodies, await f.status()]);
  for (const needle of ['hunter2', 'TOPSECRET', 'VALUE-NOT-LOGGED', JPEG, PNG]) assert.ok(!everything.includes(needle), `${needle} was stored`);
});

test('a failed screenshot is logged as failed, with no size', async () => {
  const f = await attach();
  const p = f.op(screen('screenshot'));
  await until(() => f.session.httpCommands.screen);
  const frame = await f.poll({ busy_lanes: [] });
  await f.agent({ type: 'result', id: frame.id, ok: false, error: 'no display' });
  assert.equal((await p).ok, false);
  assert.equal(f.logs.filter((l) => l.kind === 'screen').at(-1).detail, '[op@example.com] screenshot failed');
});

test('type_secret is never returned, even if the app echoes it in text or in an error', async () => {
  const f = await attach();
  const secret = 'hunter2-secret';
  let p = f.op(screen('type_secret', { text: secret }));
  await until(() => f.session.httpCommands.screen);
  let frame = await f.poll({ busy_lanes: [] });
  assert.equal(frame.action.text, secret, 'the app itself must receive the text');
  await f.result(frame, shotResult({ text: `typed ${secret}` }));
  let out = await p;
  assert.equal(out.ok, true);
  assert.ok(!JSON.stringify(out).includes(secret));
  p = f.op(screen('type_secret', { text: secret }));
  await until(() => f.session.httpCommands.screen);
  frame = await f.poll({ busy_lanes: [] });
  await f.agent({ type: 'result', id: frame.id, ok: false, error: `field rejected ${secret}` });
  out = await p;
  // The app's error text is dropped whole, not scrubbed.
  assert.deepEqual(out, { ok: false, error: 'type_secret failed' });
  for (const error of ['customer is using the PC; try again in a few seconds', '', undefined]) {
    p = f.op(screen('type_secret', { text: secret }));
    await until(() => f.session.httpCommands.screen);
    frame = await f.poll({ busy_lanes: [] });
    await f.agent({ type: 'result', id: frame.id, ok: false, error, text: secret });
    assert.deepEqual(await p, { ok: false, error: 'type_secret failed' });
  }
  // Other actions keep the app's error text.
  p = f.op(screen('type', { text: 'x' }));
  await until(() => f.session.httpCommands.screen);
  frame = await f.poll({ busy_lanes: [] });
  await f.agent({ type: 'result', id: frame.id, ok: false, error: 'customer is using the PC; try again in a few seconds' });
  assert.equal((await p).error, 'customer is using the PC; try again in a few seconds');
  // A too-long secret is refused without echoing it.
  const tooLong = await f.op(screen('type_secret', { text: `${secret}`.repeat(200) }));
  assert.equal(tooLong.ok, false);
  assert.ok(!JSON.stringify(tooLong).includes(secret));
  assert.ok(!JSON.stringify([f.logs, f.registryBodies]).includes(secret));
});

test('request_full_control is logged, and a new full-control hello answers it', async () => {
  const f = await attach();
  const p = f.op({ op: 'control', action: 'request_full_control' });
  await until(() => f.session.httpCommands.screen);
  const frame = await f.poll({ busy_lanes: [] });
  assert.deepEqual(frame, { type: 'control', id: frame.id, lane: 'screen', action: 'request_full_control' });
  // The service takes the connection over: a new generation says hello.
  const hello = await (await f.req('/agent', { type: 'hello', caps: NEW_CAPS, control: 'full', agent: 'windows-app-2' }, f.key)).json();
  assert.equal(hello.generation, f.generation + 1);
  assert.deepEqual(await p, { ok: true, control: 'full', text: 'full control is on' });
  assert.equal((await f.status()).control, 'full');
  assert.deepEqual(f.session.httpCommands, { cmd: null, screen: null });
  assert.ok(f.logs.some((l) => l.kind === 'control' && l.detail === '[op@example.com] request_full_control'));
});

test('request_full_control: a result, a refusal, and a hello without full control', async () => {
  const f = await attach();
  let p = f.op({ op: 'control', action: 'request_full_control' });
  await until(() => f.session.httpCommands.screen);
  let frame = await f.poll({ busy_lanes: [] });
  assert.equal((await f.result(frame, { control: 'full', desktop: 'default', image_b64: JPEG })).status, 200);
  assert.deepEqual(await p, { ok: true, control: 'full', desktop: 'default' });
  p = f.op({ op: 'control', action: 'request_full_control' });
  await until(() => f.session.httpCommands.screen);
  frame = await f.poll({ busy_lanes: [] });
  assert.equal((await f.result(frame, { control: 'root' })).status, 400);
  await f.agent({ type: 'result', id: frame.id, ok: false, error: 'the customer declined' });
  assert.deepEqual(await p, { ok: false, error: 'the customer declined' });
  p = f.op({ op: 'control', action: 'request_full_control' });
  await until(() => f.session.httpCommands.screen);
  await f.req('/agent', { type: 'hello', caps: NEW_CAPS, control: 'normal' }, f.key);
  assert.equal((await p).ok, false);
  assert.equal((await f.op({ op: 'control', action: 'something_else' })).error, 'bad action');
});

test('a new hello fails the commands of the old generation', async () => {
  const f = await attach();
  const run = f.op({ op: 'run', command: 'x' });
  const shot = f.op(screen('screenshot'));
  await until(() => f.session.httpCommands.cmd && f.session.httpCommands.screen);
  await f.req('/agent', { type: 'hello', caps: NEW_CAPS }, f.key);
  assert.equal((await run).error, 'agent replaced');
  assert.equal((await shot).error, 'agent replaced');
});

test('a screen result stores the desktop it saw', async () => {
  const f = await attach();
  const p = f.op(screen('screenshot'));
  await until(() => f.session.httpCommands.screen);
  await f.result(await f.poll({ busy_lanes: [] }), shotResult({ desktop: 'secure' }));
  await p;
  assert.equal((await f.status()).desktop, 'secure');
});

// ---- /mcp ----------------------------------------------------------------------
const handler = createHandler('powershell agent', { exe_b64: '', source_sha256: '', manifest_sha256: '' });
const mcp = async (f, query, method, params) => {
  const r = await handler.fetch(new Request(`http://127.0.0.1/mcp${query}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }), f.env);
  return { status: r.status, body: await r.json() };
};

test('/mcp offers only the split tools, honours ui, and refuses shape and unknown values', async () => {
  const f = fixture();
  const names = async (q) => (await mcp(f, q, 'tools/list')).body.result.tools.map((t) => t.name);
  const all = await names('');
  assert.ok(all.includes('click') && all.includes('type_text') && all.includes('ui_act') && !all.includes('computer'));
  assert.ok(!(await names('?ui=0')).includes('ui_tree'));
  assert.ok((await names('?ui=1')).includes('ui_act'));
  for (const q of ['?shape=split', '?shape=computer', '?shape=', '?shape=split&ui=1']) {
    const r = await mcp(f, q, 'tools/list');
    assert.equal(r.status, 400, q);
    assert.match(r.body.error, /shape parameter was removed/);
  }
  for (const q of ['?ui=2', '?ui=yes']) {
    const r = await mcp(f, q, 'tools/list');
    assert.equal(r.status, 400, q);
    assert.match(r.body.error, /unknown/);
  }
});

test('/mcp returns an image block then the metadata for a screenshot, end to end', async () => {
  const f = await attach();
  const call = mcp(f, '', 'tools/call', { name: 'screenshot', arguments: { session_id: SID } });
  await until(() => f.session.httpCommands.screen);
  await f.result(await f.poll({ busy_lanes: [] }), shotResult());
  const { body } = await call;
  const [image, meta] = body.result.content;
  assert.deepEqual(image, { type: 'image', data: JPEG, mimeType: 'image/jpeg' });
  assert.deepEqual(JSON.parse(meta.text), { width: 1280, height: 800, display: 0, displays: 1, desktop: 'default', control: 'normal' });
  assert.ok(!('isError' in body.result));
});

test('/mcp surfaces relay errors for screen tools as tool errors', async () => {
  const f = await attach({ caps: undefined });
  const { body } = await mcp(f, '', 'tools/call', { name: 'click', arguments: { session_id: SID, x: 1, y: 2 } });
  assert.equal(body.result.isError, true);
  assert.equal(body.result.content[0].text, 'this support app is too old for screen control');
});

test('/mcp run passes as to the app', async () => {
  const f = await attach({ control: 'full' });
  const call = mcp(f, '', 'tools/call', { name: 'run', arguments: { session_id: SID, command: 'whoami', as: 'system' } });
  await until(() => f.session.httpCommands.cmd);
  const frame = await f.poll({ busy_lanes: [] });
  assert.equal(frame.as, 'system');
  await f.result(frame, { stdout_b64: btoa('nt authority\\system'), stderr_b64: '', exit_code: 0 });
  assert.equal(JSON.parse((await call).body.result.content[0].text).stdout, 'nt authority\\system');
});

test('/mcp session_status reports control, caps and client_version', async () => {
  const f = await attach({ control: 'full' });
  const { body } = await mcp(f, '', 'tools/call', { name: 'session_status', arguments: { session_id: SID } });
  const s = JSON.parse(body.result.content[0].text);
  assert.deepEqual([s.control, s.caps, s.client_version, s.windows_mode], ['full', NEW_CAPS, 'windows-app-2', 'app']);
});

test('a block_input result sets input_blocked_until at once, and off clears it', async () => {
  const f = await attach({ control: 'full' });
  const drive = async (extra, body) => {
    const q = f.op(screen('block_input', extra));
    await until(() => f.session.httpCommands.screen);
    const fr = await f.poll({ busy_lanes: [] });
    await f.result(fr, body);
    return q;
  };
  const until10 = Date.now() + 600000;
  assert.equal((await drive({ on: true, minutes: 10 }, { input_blocked_until: until10, desktop: 'default' })).input_blocked_until, until10);
  assert.equal((await f.status()).input_blocked_until, until10, 'stored from the result, before any poll');
  await drive({ on: false }, { desktop: 'default' });
  assert.equal((await f.status()).input_blocked_until, null, 'off clears it at once');
  // A bad value makes the result invalid; the relay answers 400 and stores nothing.
  const q = f.op(screen('block_input', { on: true }));
  await until(() => f.session.httpCommands.screen);
  const fr = await f.poll({ busy_lanes: [] });
  assert.equal((await f.result(fr, { input_blocked_until: 'soon' })).status, 400);
  await f.result(fr, { input_blocked_until: until10 });
  await q;
});

test('an input whose screenshot failed is still a success, with the note and no image', async () => {
  const f = await attach({ control: 'full' });
  const q = f.op(screen('click', { x: 600, y: 450 }));
  await until(() => f.session.httpCommands.screen);
  const fr = await f.poll({ busy_lanes: [] });
  await f.result(fr, { text: 'input sent; no screenshot: cannot capture the screen', desktop: 'default', display: 0, displays: 1 });
  const r = await q;
  assert.deepEqual([r.ok, r.text, r.image_b64, r.desktop], [true, 'input sent; no screenshot: cannot capture the screen', undefined, 'default']);
});
