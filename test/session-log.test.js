// The session log folds a run of identical screenshots into one row. The app takes a
// screenshot every few seconds while a tab is open; without this each would be a row.
// Only a screenshot of the same size and display by the same person, straight after
// another such screenshot and within a minute, joins it. Nothing else ever merges.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentWorld, shot, TECH, LEAD } from './agent-world.js';

const rpcShot = (w, who, sid, args = {}) => w.rpc(who, 'tools/call', { name: 'screenshot', arguments: { session_id: sid, ...args } });
const logOf = async (w, sid, who = TECH) => (await w.tool(who, 'session_status', { session_id: sid, log_tail: 50 })).log.filter((r) => r.kind === 'screen' || r.kind === 'run');

// A saved PC attached, with a stand-in for the PC that answers frames with `answer(frame)`.
async function attached(t, answer = () => null) {
  const w = await agentWorld(t);
  const pc = await w.addPc({ access: 'any' });
  const { sid, welcome } = await w.attach(pc, TECH);
  const p = w.pump({ sid, key: pc.key, generation: welcome.body.generation, handler: answer });
  t.after(() => p.stop());
  // The clock is the test's. The PC counts as attached for a minute after its last poll, so
  // moving time also moves that.
  const later = (ms) => { w.advance(ms); w.sessionFor(sid).ctx.values.set('http_seen_at', w.now()); };
  return { w, pc, sid, later };
}

test('screenshots by one person within a minute fold into one row that counts them, and its time moves', async (t) => {
  const { w, sid, later } = await attached(t);
  assert.equal((await rpcShot(w, TECH, sid)).status, 200);
  const first = (await logOf(w, sid))[0];
  assert.equal(first.detail, `[${TECH}] screenshot 1280x800`);
  later(3000);
  await rpcShot(w, TECH, sid);
  assert.deepEqual((await logOf(w, sid)).map((r) => r.detail), [`[${TECH}] screenshot 1280x800 (x2)`]);
  for (let i = 0; i < 8; i++) { later(5000); await rpcShot(w, TECH, sid); }
  const rows = await logOf(w, sid);
  assert.deepEqual(rows.map((r) => r.detail), [`[${TECH}] screenshot 1280x800 (x10)`]);
  assert.equal(rows[0].ts, w.now(), 'the row shows the latest one');
  // It keeps folding while the pictures keep coming, for longer than a minute in all, and a minute apart is a new row.
  later(60_001);
  await rpcShot(w, TECH, sid);
  assert.deepEqual((await logOf(w, sid)).map((r) => r.detail), [`[${TECH}] screenshot 1280x800 (x10)`, `[${TECH}] screenshot 1280x800`]);
  later(60_000);
  await rpcShot(w, TECH, sid);
  assert.deepEqual((await logOf(w, sid)).map((r) => r.detail).at(-1), `[${TECH}] screenshot 1280x800 (x2)`, 'exactly a minute still folds');
});

test('anything between two screenshots, a different person, size, display or a failure keeps them apart', async (t) => {
  let size = [1280, 800];
  let fail = false;
  const { w, pc, sid } = await attached(t, (frame) => {
    if (frame.type === 'screen' && frame.action.name === 'screenshot') return fail ? { ok: false, error: 'no screen' } : shot({ width: size[0], height: size[1] });
    if (frame.type === 'screen' && frame.action.name === 'click') return shot();
    return null;
  });
  const lines = async () => (await logOf(w, sid)).map((r) => r.detail.replace(`[${TECH}] `, '').replace(`[${LEAD}] `, 'LEAD '));
  await rpcShot(w, TECH, sid);
  // A click in between.
  await w.rpc(TECH, 'tools/call', { name: 'click', arguments: { session_id: sid, x: 5, y: 6 } });
  await rpcShot(w, TECH, sid);
  // The same screenshot with a different size, then a different display.
  size = [800, 600];
  await rpcShot(w, TECH, sid);
  size = [1280, 800];
  await rpcShot(w, TECH, sid, { display: 1 });
  await rpcShot(w, TECH, sid, { display: 1 });
  await rpcShot(w, TECH, sid, { display: 2 });
  // A failed screenshot is a row of its own and is not folded into.
  fail = true;
  await rpcShot(w, TECH, sid);
  await rpcShot(w, TECH, sid);
  fail = false;
  await rpcShot(w, TECH, sid);
  assert.deepEqual(await lines(), [
    'screenshot 1280x800', 'click 5,6', 'screenshot 1280x800', 'screenshot 800x600', 'screenshot 1280x800 display 1 (x2)', 'screenshot 1280x800 display 2',
    'screenshot failed', 'screenshot failed', 'screenshot 1280x800',
  ]);
  // Another person after a take-over: their screenshot is their own row, and so is the next of the first person's.
  assert.equal((await w.tool(LEAD, 'device_connect', { device_id: pc.id, take_over: true })).takeover, undefined);
  await rpcShot(w, LEAD, sid);
  await rpcShot(w, LEAD, sid);
  assert.deepEqual((await lines()).slice(-2), ['screenshot 1280x800', 'LEAD screenshot 1280x800 (x2)']);
});

test('the agent\'s screenshots fold with each other and not with the same person\'s own', async (t) => {
  const { w, sid } = await attached(t);
  const viaAgent = async () => {
    const res = await w.env.SESSION.get(w.env.SESSION.idFromString(sid)).fetch('https://do/command', {
      method: 'POST', body: JSON.stringify({ op: 'screen', action: { name: 'screenshot' }, actor: TECH, workspace: 'default', via: 'agent' }),
    });
    return res.json();
  };
  await rpcShot(w, TECH, sid);
  assert.equal((await viaAgent()).ok, true);
  assert.equal((await viaAgent()).ok, true);
  await rpcShot(w, TECH, sid);
  assert.deepEqual((await logOf(w, sid)).map((r) => r.detail), [
    `[${TECH}] screenshot 1280x800`, `[${TECH} via agent] screenshot 1280x800 (x2)`, `[${TECH}] screenshot 1280x800`,
  ]);
});

test('only the session log is folded: the team log, and every other session row, are as they were', async (t) => {
  const { w, sid } = await attached(t);
  for (let i = 0; i < 3; i++) await rpcShot(w, TECH, sid);
  const all = (await w.tool(TECH, 'session_status', { session_id: sid, log_tail: 50 })).log;
  assert.deepEqual(all.map((r) => r.kind), ['created', 'attached', 'hello', 'screen']);
  assert.deepEqual((await w.kinds()).slice(-2), ['device_paired', 'device_session_started'], 'the team log took no screenshot rows');
});
