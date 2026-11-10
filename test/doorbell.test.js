// The doorbell: GET /device/ring (the Worker's checks, then the hand-off to the
// workspace's Registry object) and the Registry's own sockets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, socket, BOSS, HOST } from './device-sessions-world.js';
import { DOORBELL_FRAME_MAX } from '../src/registry.js';

const UPGRADE = { upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' };

// A Registry binding that records what the Worker hands it and answers 200 in place of the 101 Node cannot make.
function recordingRegistry(w) {
  const seen = [];
  w.env.REGISTRY = {
    idFromName: (n) => n,
    get: (name) => ({ fetch: async (request) => { seen.push({ name, url: request.url, headers: Object.fromEntries(request.headers), method: request.method }); return new Response('upgraded', { status: 200 }); } }),
  };
  return seen;
}

async function ring(w, key, { search = '?protocol=1', headers = {}, method = 'GET', base = HOST } = {}) {
  const r = await w.send(`/device/ring${search}`, { method, base, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers } });
  let body = null;
  try { body = await r.clone().json(); } catch (_) { /* not JSON */ }
  return { status: r.status, body, text: await r.text(), headers: r.headers };
}
const refuses = (res, status, code) => {
  assert.deepEqual([res.status, res.body?.error?.code], [status, code], res.text);
  assert.equal(res.body.protocol, 1);
};

test('the doorbell route keeps the device wire refusals, in order, before it touches the database for a bad key', async (t) => {
  const w = await world(t);
  const pc = await w.addPc();
  const seen = recordingRegistry(w);
  refuses(await ring(w, pc.key, { base: 'http://support.example.com', headers: UPGRADE }), 403, 'https_required');
  refuses(await ring(w, pc.key, { method: 'POST', headers: UPGRADE }), 405, 'method_not_allowed');
  assert.equal((await ring(w, pc.key, { method: 'POST', headers: UPGRADE })).headers.get('allow'), 'GET');
  refuses(await ring(w, pc.key, { headers: { ...UPGRADE, origin: 'https://evil.example' } }), 403, 'forbidden');
  refuses(await ring(w, pc.key, { search: `?protocol=1&key=${pc.key}`, headers: UPGRADE }), 400, 'bad_request');
  refuses(await ring(w, pc.key, { search: '?protocol=1&code=ABCDE-FGH23', headers: UPGRADE }), 400, 'bad_request');
  refuses(await ring(w, pc.key, { search: '', headers: UPGRADE }), 400, 'bad_request');
  refuses(await ring(w, pc.key, { search: '?protocol=x', headers: UPGRADE }), 400, 'bad_request');
  const old = await ring(w, pc.key, { search: '?protocol=2', headers: UPGRADE });
  refuses(old, 426, 'protocol_unsupported');
  refuses(await ring(w, null, { headers: UPGRADE }), 401, 'device_unknown');
  refuses(await ring(w, 'smd1.default.not-a-key', { headers: UPGRADE }), 401, 'device_unknown');
  refuses(await ring(w, pc.key, {}), 400, 'bad_request'); // not a WebSocket upgrade
  assert.equal(seen.length, 0, 'nothing reached the Registry');
  // A wrong secret, an unknown id and a removed PC are the same 401.
  const wrong = `${pc.key.slice(0, -3)}AAA`;
  const unknown = `smd1.default.${'a'.repeat(20)}.${pc.key.split('.')[3]}`;
  const a = await ring(w, wrong, { headers: UPGRADE });
  const b = await ring(w, unknown, { headers: UPGRADE });
  refuses(a, 401, 'device_unknown');
  assert.equal(a.text, b.text);
  assert.equal(seen.length, 0);
});

test('a malformed key never reaches the database', async (t) => {
  const w = await world(t);
  const seen = recordingRegistry(w);
  const before = w.db.seen.length;
  for (const key of [null, 'x', 'smd1.default.abc', 'Bearer']) refuses(await ring(w, key, { headers: UPGRADE }), 401, 'device_unknown');
  assert.equal(w.db.seen.length, before);
  assert.equal(seen.length, 0);
});

test('an active and a waiting PC are handed to the workspace Registry without their key', async (t) => {
  const w = await world(t);
  const active = await w.addPc();
  const waiting = await w.addPc({ status: 'pending' });
  const seen = recordingRegistry(w);
  for (const pc of [active, waiting]) {
    const res = await ring(w, pc.key, { headers: UPGRADE });
    assert.equal(res.status, 200, res.text);
  }
  assert.deepEqual(seen.map((s) => s.name), ['registry', 'registry']);
  assert.deepEqual(seen.map((s) => new URL(s.url).searchParams.get('device')), [active.id, waiting.id]);
  for (const s of seen) {
    assert.equal(s.headers.authorization, undefined, 'the key is not passed on');
    assert.equal(s.headers.upgrade, 'websocket');
    assert.equal(new URL(s.url).pathname, '/doorbell');
  }
});

test('a PC in another workspace rings that workspace Registry', async (t) => {
  const w = await world(t);
  await w.team.createWorkspace(BOSS, { slug: 'acme', name: 'Acme' });
  const made = await w.devs.createPairingCode('acme', BOSS, {});
  const out = await w.devs.redeemCode({ protocol: 1, code: made.code, name: 'Acme PC' });
  const seen = recordingRegistry(w);
  assert.equal((await ring(w, out.key, { headers: UPGRADE })).status, 200);
  assert.deepEqual(seen.map((s) => s.name), ['registry:acme']);
});

test('a relay with no Registry binding answers 503, and the doorbell is not a POST address', async (t) => {
  const w = await world(t);
  const pc = await w.addPc();
  delete w.env.REGISTRY;
  const res = await ring(w, pc.key, { headers: UPGRADE });
  refuses(res, 503, 'unavailable');
  // The other addresses keep their rule: POST only.
  const get = await w.send('/device/hello', { method: 'GET' });
  assert.equal(get.status, 405);
});

// ---- the Registry's sockets ------------------------------------------------------------
function upgradeResponses(t) {
  const Real = globalThis.Response;
  const realPair = globalThis.WebSocketPair;
  globalThis.Response = class extends Real {
    constructor(body, init) {
      if (init && init.status === 101) {
        super(null, { status: 200 });
        Object.defineProperty(this, 'status', { value: 101 });
        this.webSocket = init.webSocket;
      } else super(body, init);
    }
  };
  globalThis.WebSocketPair = class { constructor() { this[0] = { client: true }; this[1] = socket([]); } };
  t.after(() => { globalThis.Response = Real; globalThis.WebSocketPair = realPair; });
}
const door = (w, id) => w.registryFor('registry').registry.fetch(new Request(`https://do/doorbell?device=${id}`, { headers: { upgrade: 'websocket' } }));

test('the Registry accepts a doorbell under the tag dev:<id>, and a new socket for the same PC closes the older one', async (t) => {
  const w = await world(t);
  upgradeResponses(t);
  const { ctx } = w.registryFor('registry');
  const id = 'a'.repeat(20);
  const first = await door(w, id);
  assert.equal(first.status, 101);
  const [one] = ctx.sockets;
  assert.deepEqual(one.tags, [`dev:${id}`]);
  const second = await door(w, id);
  assert.equal(second.status, 101);
  assert.equal(one.closed, true, 'the older socket is closed');
  assert.equal(ctx.sockets.length, 2);
  const other = await door(w, 'b'.repeat(20));
  assert.equal(other.status, 101);
  assert.equal(ctx.sockets[0].closed && !ctx.sockets[1].closed && !ctx.sockets[2].closed, true, 'another PC is left alone');
  // Who is online.
  const online = await (await w.registryFor('registry').registry.fetch(new Request('https://do/online'))).json();
  assert.deepEqual(online, { online: ['a'.repeat(20), 'b'.repeat(20)] });
  // A bad id and a plain GET are refused.
  assert.equal((await door(w, 'nope')).status, 400);
  assert.equal((await w.registryFor('registry').registry.fetch(new Request(`https://do/doorbell?device=${id}`))).status, 426);
});

test('the Registry ignores text from a PC and closes the socket on a frame over 1 KB', async (t) => {
  const w = await world(t);
  const { registry, ctx } = w.registryFor('registry');
  const ws = socket([`dev:${'a'.repeat(20)}`]);
  ctx.sockets.push(ws);
  await registry.webSocketMessage(ws, '{"type":"ring"}');
  await registry.webSocketMessage(ws, 'x'.repeat(DOORBELL_FRAME_MAX));
  await registry.webSocketMessage(ws, new ArrayBuffer(10));
  assert.deepEqual([ws.closed, ws.sent], [false, []], 'nothing is read or answered');
  await registry.webSocketMessage(ws, 'x'.repeat(DOORBELL_FRAME_MAX + 1));
  assert.deepEqual([ws.closed, ws.closeCode], [true, 1009]);
  const big = socket([`dev:${'b'.repeat(20)}`]);
  await registry.webSocketMessage(big, new ArrayBuffer(DOORBELL_FRAME_MAX + 1));
  assert.equal(big.closed, true);
  // A multi-byte frame is counted in bytes.
  const wide = socket([`dev:${'c'.repeat(20)}`]);
  await registry.webSocketMessage(wide, 'é'.repeat(600));
  assert.equal(wide.closed, true);
});

test('a ring reaches one PC, or every PC for a stop, and the Registry sends nothing else', async (t) => {
  const w = await world(t);
  const { registry, ctx } = w.registryFor('registry');
  const a = socket([`dev:${'a'.repeat(20)}`]);
  const b = socket([`dev:${'b'.repeat(20)}`]);
  ctx.sockets.push(a, b);
  const post = async (body) => (await registry.fetch(new Request('https://do/ring', { method: 'POST', body: JSON.stringify(body) }))).json();
  assert.deepEqual(await post({ device_id: 'a'.repeat(20) }), { rang: true });
  assert.deepEqual([a.sent, b.sent], [['{"type":"ring"}'], []]);
  assert.deepEqual(await post({ device_id: 'c'.repeat(20) }), { rang: false }, 'a PC with no doorbell is not rung');
  assert.deepEqual(await post({ device_id: 'not an id' }), { rang: false });
  assert.deepEqual(await post({ all: true }), { rang: true });
  assert.deepEqual([a.sent.length, b.sent.length], [2, 1]);
  for (const text of [...a.sent, ...b.sent]) assert.equal(text, '{"type":"ring"}');
  // A removed PC is rung and its doorbell closed.
  await post({ device_id: 'b'.repeat(20), close: true });
  assert.deepEqual([a.closed, b.closed, b.sent.length], [false, true, 2]);
  assert.deepEqual((await (await registry.fetch(new Request('https://do/online'))).json()).online, ['a'.repeat(20)]);
  // A socket that throws on send does not stop the others.
  const dead = socket([`dev:${'d'.repeat(20)}`]);
  dead.send = () => { throw new Error('closed'); };
  ctx.sockets.push(dead);
  assert.deepEqual(await post({ all: true }), { rang: true });
});

test('a list of PCs is rung where connected, and at most `max` of them, in the order given', async (t) => {
  const w = await world(t);
  const { registry, ctx } = w.registryFor('registry');
  const ids = ['a', 'b', 'c', 'd'].map((c) => c.repeat(20));
  const bells = ids.map((id) => socket([`dev:${id}`]));
  ctx.sockets.push(bells[0], bells[2], bells[3]); // b has no doorbell
  const post = async (body) => (await registry.fetch(new Request('https://do/ring', { method: 'POST', body: JSON.stringify(body) }))).json();
  assert.deepEqual(await post({ device_ids: ids }), { rang: true, count: 3 });
  assert.deepEqual(bells.map((b) => b.sent.length), [1, 0, 1, 1]);
  assert.deepEqual(await post({ device_ids: [...ids, ids[0], 'not an id'], max: 2 }), { rang: true, count: 2 }, 'the first two with a doorbell; a repeat or a bad id counts for nothing');
  assert.deepEqual(bells.map((b) => b.sent.length), [2, 0, 2, 1]);
  assert.deepEqual(await post({ device_ids: [] }), { rang: false, count: 0 });
  assert.deepEqual(await post({ device_ids: ['b'.repeat(20)] }), { rang: false, count: 0 });
});

test('closing or an error on a doorbell takes it out of the online list', async (t) => {
  const w = await world(t);
  const { registry, ctx } = w.registryFor('registry');
  const ws = socket([`dev:${'a'.repeat(20)}`]);
  ctx.sockets.push(ws);
  await registry.webSocketClose(ws, 1006, '');
  assert.equal(ws.closed, true);
  await registry.webSocketError(ws);
  assert.deepEqual((await (await registry.fetch(new Request('https://do/online'))).json()).online, []);
});
