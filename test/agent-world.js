// A whole relay with the built-in agent for its tests: the saved-PC world of
// device-sessions-world.js plus AgentTask objects behind a small Durable Object
// stand-in, fake providers instead of the network, and a stand-in for the PC that
// answers the agent's commands. Time moves only when a test (or drive) moves it.
import { world, BOSS, TECH, VIEW, LEAD, OTHER, SECRET } from './device-sessions-world.js';
import { AgentTask } from '../src/agent-task.js';
import { fakeProviders } from './agent-fakes.js';

export { BOSS, TECH, VIEW, LEAD, OTHER, SECRET };
export const OPENAI_KEY = 'sk-proj-CANARY-openai-0123456789abcdefghijklmnopqrstuv-WXYZ';
export const CLAUDE_KEY = 'sk-ant-api03-CANARY-claude-0123456789abcdefghijklmnopqrstuvwxyz-QRST';
export const JPEG = '/9j/4AAQ';

const tick = () => new Promise((r) => setImmediate(r));
export const until = async (fn, ms = 10_000) => {
  const end = performance.now() + ms;
  while (!fn() && performance.now() < end) await tick();
  if (!fn()) throw new Error('timed out waiting');
};

// A Durable Object's storage: values copied in and out, as the real one serializes them.
function doContext() {
  const values = new Map();
  let alarm = null;
  return {
    values,
    alarm: () => alarm,
    // An alarm that fires is consumed; the handler sets the next one. One that throws is run again.
    fire: () => { alarm = null; },
    retry: (at) => { alarm = at; },
    storage: {
      get: async (key) => (Array.isArray(key) ? new Map(key.map((k) => [k, values.has(k) ? structuredClone(values.get(k)) : undefined])) : values.has(key) ? structuredClone(values.get(key)) : undefined),
      put: async (data) => { for (const [k, v] of Object.entries(data)) values.set(k, structuredClone(v)); },
      setAlarm: async (at) => { alarm = at; },
      deleteAlarm: async () => { alarm = null; },
    },
  };
}

// What the PC answers to each frame: a screenshot for a screen frame, and so on.
export const shot = (extra = {}) => ({ image_b64: JPEG, mime: 'image/jpeg', width: 1280, height: 800, display: 0, displays: 1, desktop: 'default', ...extra });
const defaultAnswer = (frame) => {
  if (frame.type === 'run') return { stdout_b64: btoa('ok'), stderr_b64: '', exit_code: 0 };
  if (frame.type === 'put_file') return { bytes: 3 };
  if (frame.type === 'get_file') return { data_b64: 'AAAA', size: 3, eof: true };
  return shot();
};

export async function agentWorld(t, opts = {}) {
  const w = await world(t, opts);
  const fake = fakeProviders();
  const objects = new Map(); // object name -> { ctx, task }
  const hooks = { fail: null, tool: null };
  const tuning = { fetch: fake.fetch, fail: (point) => hooks.fail?.(point), get tool() { return hooks.tool ?? undefined; } };
  const objectFor = (name) => {
    if (!objects.has(name)) {
      const ctx = doContext();
      objects.set(name, { ctx, task: new AgentTask(ctx, w.env, tuning) });
    }
    return objects.get(name);
  };
  w.env.AGENT_TASK = {
    idFromName: (name) => ({ toString: () => name }),
    get: (id) => ({ fetch: async (u, init) => objectFor(id.toString()).task.fetch(typeof u === 'string' ? new Request(u, init) : u) }),
  };
  const taskObject = (id, slug = 'default') => objects.get(`task:${slug}:${id}`);

  // One alarm as Cloudflare runs it: the alarm is consumed first, and one that throws is set to run again.
  async function run(o) {
    o.ctx.fire();
    try {
      await o.task.alarm();
    } catch (e) {
      o.ctx.retry(w.now());
      throw e;
    }
  }
  // Run the task's alarms, moving time to each one, until none is set or `stop` says so.
  async function drive(id, { steps = 200, stop = null, slug = 'default' } = {}) {
    const o = taskObject(id, slug);
    for (let i = 0; i < steps; i++) {
      const at = o.ctx.alarm();
      if (at === null) return i;
      if (at > w.now()) w.advance(at - w.now());
      await run(o);
      if (stop && stop()) return i + 1;
    }
    throw new Error('the task never settled');
  }
  // One alarm, without moving time.
  const alarm = (id, slug = 'default') => run(taskObject(id, slug));
  // The object as if its host restarted: same storage, a new instance, no conversation.
  const restart = (id, slug = 'default') => {
    const o = taskObject(id, slug);
    o.task = new AgentTask(o.ctx, w.env, tuning);
  };

  // The PC answers the agent's commands. handler(frame) returns the result fields (or
  // null for the default answer); every frame it saw is in `frames`.
  function pump({ sid, key, generation, handler = null, headers = {} }) {
    let stopped = false;
    const frames = [];
    const session = w.sessionFor(sid).session;
    const loop = (async () => {
      while (!stopped) {
        await until(() => stopped || session.httpCommands.cmd || session.httpCommands.screen, 600_000);
        if (stopped) break;
        const got = (await w.agent(sid, key, { type: 'poll', generation, busy_lanes: [] }, headers)).body;
        if (!got || got.type === 'idle' || !got.id) continue;
        frames.push(got);
        const custom = handler ? await handler(got) : null;
        if (custom === 'drop') continue; // the PC never answers
        const result = custom ?? defaultAnswer(got);
        await w.agent(sid, key, { type: 'result', generation, id: got.id, ok: result.ok ?? true, ...result }, headers);
      }
    })();
    return { frames, stop: async () => { stopped = true; await loop; } };
  }

  // A saved PC that has joined the session a task opened, with a pump to answer it.
  async function joinPc(pc, handler = null) {
    const sid = w.pointer(pc.id).id;
    const welcome = await w.agent(sid, pc.key, { type: 'hello', machine: 'M1', user: 'dana', control: 'full', caps: ['screen', 'lanes'], version: '0.6.0' });
    const p = pump({ sid, key: pc.key, generation: welcome.body.generation, handler });
    t.after(() => p.stop());
    return { sid, ...p };
  }

  // The team's agent set up and ready: both caps, and the keys it names.
  async function ready({ caps = { task_cap_usd: 5, month_cap_usd: 50 }, keys = ['openai'], extra = {} } = {}) {
    const body = { ...caps, ...extra };
    if (keys.includes('openai')) body.openai_key = OPENAI_KEY;
    if (keys.includes('anthropic')) body.anthropic_key = CLAUDE_KEY;
    const r = await w.api(BOSS, 'PATCH', '/agent', body);
    if (r.status !== 200) throw new Error(`could not set up the agent: ${JSON.stringify(r.body)}`);
    return r.body.agent;
  }

  // Start a task on a saved PC and run it until the PC can join. Returns { id, pc, joined }.
  async function startOnPc(who, args = {}, { pc = null, handler = null, join = true } = {}) {
    const device = pc ?? await w.addPc({ access: 'any', name: 'Till' });
    const out = await w.tool(who, 'agent_start', { device_id: device.id, instructions: 'The printer stopped printing.', keep_working: true, ...args });
    if (out.error) throw new Error(`agent_start: ${out.error}`);
    await alarm(out.task_id); // connect
    const joined = join ? await joinPc(device, handler) : null;
    return { id: out.task_id, pc: device, joined, out };
  }

  const taskRow = (id, slug = 'default') => w.sql('SELECT * FROM agent_tasks WHERE workspace = ? AND id = ?', slug, id)[0];
  const settingsRow = (slug = 'default') => w.sql('SELECT * FROM agent_settings WHERE workspace = ?', slug)[0];
  const step = (id, slug = 'default') => objects.get(`task:${slug}:${id}`).ctx.values.get('st');
  return { ...w, fake, hooks, objects, taskObject, drive, alarm, restart, pump, joinPc, ready, startOnPc, taskRow, settingsRow, stateOf: w.stateOf, step };
}
