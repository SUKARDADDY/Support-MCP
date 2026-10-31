import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../src/session.js';

function fixture(t) {
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const values = new Map();
  const logs = [];
  let alarm = null;
  const storage = {
    get: async (key) => Array.isArray(key)
      ? new Map(key.map((k) => [k, values.get(k)])) : values.get(key),
    put: async (data) => { for (const [k, v] of Object.entries(data)) values.set(k, v); },
    setAlarm: async (deadline) => { alarm = deadline; },
    deleteAlarm: async () => { alarm = null; },
    sql: { exec(query, ...args) {
      if (query.startsWith('INSERT INTO log')) {
        logs.push({ ts: args[0], kind: args[1], detail: args[2] });
      } else if (query.startsWith('SELECT ts,kind,detail')) {
        return { toArray: () => logs.slice(-args[0]).reverse() };
      } else if (!query.startsWith('CREATE TABLE')) {
        throw new Error(`Unexpected SQL: ${query}`);
      }
    } },
  };
  const sockets = [];
  const ctx = {
    storage,
    getWebSockets: (tag) => (tag ? sockets.filter((w) => w.tags.includes(tag)) : [...sockets]),
    getTags: (ws) => ws.tags,
    // What the runtime does on accept: the socket joins the tagged set.
    acceptWebSocket: (ws, tags) => { ws.tags = tags; sockets.push(ws); },
  };
  // The next registry push waits for registryHold.release(), if one is armed.
  let registryHold = null;
  const env = { REGISTRY: {
    idFromName: (name) => name,
    get: () => ({ fetch: async () => {
      const hold = registryHold;
      registryHold = null;
      if (hold) { hold.waiting(); await hold.gate; }
      return Response.json({ ok: true });
    } }),
  } };
  const session = new Session(ctx, env);
  const fakeSocket = (tag) => {
    const ws = {
      tags: [tag], sent: [], closed: false,
      send: (data) => ws.sent.push(data),
      close: () => { ws.closed = true; },
    };
    return ws;
  };
  return {
    session,
    values,
    logs,
    sockets,
    fakeSocket,
    holdRegistry: () => {
      let release;
      let waiting;
      const gate = new Promise((r) => { release = r; });
      const started = new Promise((r) => { waiting = r; });
      registryHold = { gate, waiting };
      return { started, release };
    },
    // A stand-in for an accepted hibernation socket with the given tag.
    socket: (tag) => {
      const ws = fakeSocket(tag);
      sockets.push(ws);
      return ws;
    },
    now: () => now,
    advance: (ms) => { now += ms; },
    alarm: () => alarm,
    fetch: (path, options) => session.fetch(new Request(`https://do${path}`, options)),
  };
}

async function createAndConsume(f) {
  const created = await f.fetch('/create', {
    method: 'POST', body: JSON.stringify({ code: 'abcdefghijklmnop', sid: 'a'.repeat(64) }),
  });
  assert.equal(created.status, 200);
  const consumed = await f.fetch('/consume');
  const body = await consumed.json();
  assert.equal(body.ok, true);
  return body.key;
}

test('a slow PC can connect after 30 minutes and until the two-hour startup deadline', async (t) => {
  const f = fixture(t);
  const key = await createAndConsume(f);
  const deadline = f.now() + 2 * 60 * 60 * 1000;
  assert.equal(f.alarm(), deadline);

  f.advance(31 * 60 * 1000);
  const probe = () => f.fetch('/ws', { headers: { 'X-Attach-Key': key } });
  assert.equal((await probe()).status, 426);
  await f.session.alarm();
  assert.equal(f.alarm(), deadline);
  assert.equal(f.values.get('state'), 'consumed');

  f.advance(89 * 60 * 1000 - 1);
  assert.equal((await probe()).status, 426);
  const status = await (await f.fetch('/status')).json();
  assert.equal(status.startup_expires_at, deadline);

  f.advance(1);
  assert.equal((await probe()).status, 410);
  const expired = await (await f.fetch('/status')).json();
  assert.equal(expired.state, 'ended');
  assert.equal(expired.ended_reason, 'consume TTL');
  assert.equal(expired.startup_expires_at, null);
  assert.equal(f.alarm(), null);
  assert.equal((await (await f.fetch('/consume')).json()).ok, false);
  assert.equal((await f.fetch('/create', {
    method: 'POST', body: JSON.stringify({ code: 'abcdefghijklmnop', sid: 'a'.repeat(64) }),
  })).status, 409);
});

test('the pairing link still expires after ten minutes', async (t) => {
  const f = fixture(t);
  await f.fetch('/create', {
    method: 'POST', body: JSON.stringify({ code: 'abcdefghijklmnop', sid: 'a'.repeat(64) }),
  });
  const status = await (await f.fetch('/status')).json();
  assert.equal(status.startup_expires_at, null);
  f.advance(10 * 60 * 1000);
  assert.equal((await (await f.fetch('/consume')).json()).ok, false);
  assert.equal(f.values.get('ended_reason'), 'code TTL');
});

test('the alarm ends an unconnected session at the two-hour deadline, not at 30 minutes', async (t) => {
  const f = fixture(t);
  await createAndConsume(f);
  const deadline = f.now() + 2 * 60 * 60 * 1000;

  f.advance(30 * 60 * 1000 + 1);
  await f.session.alarm();
  assert.equal(f.values.get('state'), 'consumed');
  assert.equal(f.alarm(), deadline);

  f.advance(90 * 60 * 1000 - 2);
  await f.session.alarm();
  assert.equal(f.values.get('state'), 'consumed');

  f.advance(1);
  await f.session.alarm();
  assert.equal(f.values.get('state'), 'ended');
  assert.equal(f.values.get('ended_reason'), 'consume TTL');
  assert.equal(f.alarm(), null);
});

// Put a consumed session into the attached state with `tag` as the current socket.
async function attachAs(f, tag) {
  await createAndConsume(f);
  f.values.set('state', 'attached');
  f.values.set('expires_at', f.now() + 24 * 60 * 60 * 1000);
  f.values.set('ws_tag', tag);
}

async function nextFrame(ws) {
  for (let i = 0; i < 100 && !ws.sent.length; i++) await new Promise((r) => setImmediate(r));
  assert.ok(ws.sent.length, 'the relay sent no frame to the socket');
  return JSON.parse(ws.sent[ws.sent.length - 1]);
}

// Holds the next SHA-256 digest until release() runs. Returns a promise that
// settles once a hash is waiting, so a test can act while the attach key hashes.
function holdNextHash(t) {
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  let release;
  let waiting;
  const gate = new Promise((r) => { release = r; });
  const started = new Promise((r) => { waiting = r; });
  t.mock.method(crypto.subtle, 'digest', async (...args) => {
    waiting();
    await gate;
    return digest(...args);
  });
  return { started, release };
}

test('an operator end while the attach key hashes keeps the session ended', async (t) => {
  const f = fixture(t);
  const key = await createAndConsume(f);
  const hold = holdNextHash(t);
  const probe = f.fetch('/ws', { headers: { 'X-Attach-Key': key } });
  await hold.started;
  assert.equal((await f.fetch('/end', { method: 'POST', body: '{}' })).status, 200);
  hold.release();
  assert.equal((await probe).status, 410);
  assert.equal(f.values.get('state'), 'ended');
  assert.equal(f.values.get('ended_reason'), 'ended_by_operator');
  assert.equal(f.values.get('ws_gen'), 0);
});

test('the deadline passing while the attach key hashes keeps the session ended', async (t) => {
  const f = fixture(t);
  const key = await createAndConsume(f);
  const hold = holdNextHash(t);
  const probe = f.fetch('/ws', { headers: { 'X-Attach-Key': key } });
  await hold.started;
  f.advance(2 * 60 * 60 * 1000);
  hold.release();
  assert.equal((await probe).status, 410);
  assert.equal(f.values.get('state'), 'ended');
  assert.equal(f.values.get('ended_reason'), 'consume TTL');
});

test('a result from an older socket cannot resolve a command sent to the current socket', async (t) => {
  const f = fixture(t);
  const older = f.socket('g1');
  const current = f.socket('g2');
  await attachAs(f, 'g2');
  t.after(() => f.session.failPending(() => true, 'test over'));

  const command = f.fetch('/command', {
    method: 'POST', body: JSON.stringify({ op: 'run', command: 'whoami' }),
  });
  const frame = await nextFrame(current);
  assert.equal(frame.type, 'run');

  await f.session.webSocketMessage(older, JSON.stringify({
    type: 'result', id: frame.id, ok: true, exit_code: 0, stdout: 'from the older socket', stderr: '',
  }));
  assert.equal(f.session.pending.has(frame.id), true);

  await f.session.webSocketMessage(current, JSON.stringify({
    type: 'result', id: frame.id, ok: true, exit_code: 0, stdout: 'from the current socket', stderr: '',
  }));
  assert.equal(f.session.pending.has(frame.id), false);
  assert.equal((await (await command).json()).stdout, 'from the current socket');
});

test('the relay ignores hello and end from a socket that is not current', async (t) => {
  const f = fixture(t);
  const older = f.socket('g1');
  const current = f.socket('g2');
  await attachAs(f, 'g2');

  await f.session.webSocketMessage(older, JSON.stringify({ type: 'hello', machine: 'OLD-PC', user: 'old' }));
  assert.equal(f.values.get('machine'), null);

  await f.session.webSocketMessage(older, JSON.stringify({ type: 'end', reason: 'customer' }));
  assert.equal(f.values.get('state'), 'attached');

  await f.session.webSocketMessage(current, JSON.stringify({ type: 'hello', machine: 'NEW-PC', user: 'new' }));
  assert.equal(f.values.get('machine'), 'NEW-PC');

  await f.session.webSocketMessage(current, JSON.stringify({ type: 'end', reason: 'customer' }));
  assert.equal(f.values.get('state'), 'ended');
  assert.equal(f.values.get('ended_reason'), 'customer');
});

async function create(f) {
  const created = await f.fetch('/create', {
    method: 'POST', body: JSON.stringify({ code: 'abcdefghijklmnop', sid: 'a'.repeat(64) }),
  });
  assert.equal(created.status, 200);
}

const sha256 = async (str) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)))]
  .map((b) => b.toString(16).padStart(2, '0')).join('');
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

test('two concurrent consumes mint one key: the loser gets not-pending', async (t) => {
  const f = fixture(t);
  await create(f);
  const hold = holdNextHash(t);
  const first = f.fetch('/consume', { method: 'POST', body: '{}' });
  const second = f.fetch('/consume', { method: 'POST', body: '{}' });
  await hold.started;
  await settle(); // both requests are now parked in the hash
  hold.release();
  const results = [await (await first).json(), await (await second).json()];
  const winners = results.filter((r) => r.ok);
  const losers = results.filter((r) => !r.ok);
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);
  assert.equal(losers[0].reason, 'not-pending');
  // The stored hash belongs to the key that was handed out.
  assert.equal(f.values.get('key_hash'), await sha256(winners[0].key));
  assert.equal(f.logs.filter((l) => l.kind === 'consumed').length, 1);
});

// Node's Response refuses status 101 and has no WebSocketPair. Stand in for
// both so a test can drive a real `Upgrade: websocket` attach through doWs.
function stubUpgrade(t) {
  const RealResponse = globalThis.Response;
  class UpgradeResponse extends RealResponse {
    constructor(body, init) {
      if (init && init.status === 101) {
        super(body, { ...init, status: 200 });
        Object.defineProperty(this, 'status', { value: 101 });
        this.webSocket = init.webSocket;
      } else {
        super(body, init);
      }
    }
  }
  const hadPair = Object.hasOwn(globalThis, 'WebSocketPair');
  const realPair = globalThis.WebSocketPair;
  globalThis.Response = UpgradeResponse;
  globalThis.WebSocketPair = class {
    constructor() {
      this[0] = { client: true };
      this[1] = { sent: [], closed: false, send(d) { this.sent.push(d); }, close() { this.closed = true; } };
    }
  };
  t.after(() => {
    globalThis.Response = RealResponse;
    if (hadPair) globalThis.WebSocketPair = realPair;
    else delete globalThis.WebSocketPair;
  });
}

const upgrade = (key) => ({ headers: { 'X-Attach-Key': key, Upgrade: 'websocket' } });

test('a websocket upgrade with the right key attaches, welcomes, and sets the 24-hour expiry', async (t) => {
  stubUpgrade(t);
  const f = fixture(t);
  const key = await createAndConsume(f);
  const r = await f.fetch('/ws', upgrade(key));
  assert.equal(r.status, 101);
  assert.deepEqual(r.webSocket, { client: true });
  assert.equal(f.values.get('state'), 'attached');
  assert.equal(f.values.get('ws_tag'), 'g1');
  const expiresAt = f.now() + 24 * 60 * 60 * 1000;
  assert.equal(f.values.get('expires_at'), expiresAt);
  assert.equal(f.alarm(), expiresAt);
  assert.equal(f.sockets.length, 1);
  assert.deepEqual(f.sockets[0].tags, ['g1']);
  assert.deepEqual(JSON.parse(f.sockets[0].sent[0]), { type: 'welcome', expires_at: expiresAt });

  // A reattach replaces the socket and keeps the original expiry.
  f.advance(60 * 1000);
  const again = await f.fetch('/ws', upgrade(key));
  assert.equal(again.status, 101);
  assert.equal(f.values.get('ws_tag'), 'g2');
  assert.equal(f.values.get('expires_at'), expiresAt);
  assert.equal(f.sockets[0].closed, true);
  assert.equal(f.sockets[1].closed, false);

  // A wrong key never reaches the upgrade.
  assert.equal((await f.fetch('/ws', upgrade('0'.repeat(64)))).status, 401);
  assert.equal(f.sockets.length, 2);
});

test('an operator end while the attach key hashes accepts no socket on an upgrade', async (t) => {
  stubUpgrade(t);
  const f = fixture(t);
  const key = await createAndConsume(f);
  const hold = holdNextHash(t);
  const attach = f.fetch('/ws', upgrade(key));
  await hold.started;
  assert.equal((await f.fetch('/end', { method: 'POST', body: '{}' })).status, 200);
  hold.release();
  assert.equal((await attach).status, 410);
  assert.equal(f.sockets.length, 0);
  assert.equal(f.values.get('state'), 'ended');
  assert.equal(f.values.get('ws_gen'), 0);
});

test('an operator end during the first-attach registry push closes the new socket', async (t) => {
  stubUpgrade(t);
  const f = fixture(t);
  const key = await createAndConsume(f);
  const registry = f.holdRegistry();
  const attach = f.fetch('/ws', upgrade(key));
  await registry.started;
  assert.equal((await f.fetch('/end', { method: 'POST', body: '{}' })).status, 200);
  registry.release();
  assert.equal((await attach).status, 101);
  // The socket was accepted before the push, so the end reached it.
  assert.equal(f.sockets.length, 1);
  assert.equal(f.sockets[0].closed, true);
  assert.equal(f.values.get('state'), 'ended');
  assert.equal(f.values.get('ended_reason'), 'ended_by_operator');
});

test('hello logs truncated values and is accepted once per socket', async (t) => {
  const f = fixture(t);
  const first = f.socket('g1');
  await attachAs(f, 'g1');

  const long = 'x'.repeat(5000);
  await f.session.webSocketMessage(first, JSON.stringify({
    type: 'hello', machine: long, user: long, ps: long, agent: long,
  }));
  const row = f.logs.find((l) => l.kind === 'hello');
  assert.ok(row.detail.length < 300, `hello log row is ${row.detail.length} chars`);
  assert.equal(f.values.get('machine'), `${'x'.repeat(100)}…`);
  assert.equal(f.values.get('ps'), `${'x'.repeat(40)}…`);

  // A second hello on the same socket changes nothing and logs nothing.
  await f.session.webSocketMessage(first, JSON.stringify({ type: 'hello', machine: 'SPOOF', user: 'spoof', ps: '1' }));
  assert.equal(f.values.get('machine'), `${'x'.repeat(100)}…`);
  assert.equal(f.logs.filter((l) => l.kind === 'hello').length, 1);

  // A reattach is a new socket with a new tag, so it may say hello once.
  const second = f.socket('g2');
  f.values.set('ws_tag', 'g2');
  await f.session.webSocketMessage(second, JSON.stringify({ type: 'hello', machine: 'NEW-PC', user: 'u', ps: '5.1', agent: '1' }));
  assert.equal(f.values.get('machine'), 'NEW-PC');
  await f.session.webSocketMessage(second, JSON.stringify({ type: 'hello', machine: 'AGAIN', user: 'u' }));
  assert.equal(f.values.get('machine'), 'NEW-PC');
  assert.equal(f.logs.filter((l) => l.kind === 'hello').length, 2);
});
