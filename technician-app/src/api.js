// What the screens ask of the relay, in the relay's own shapes (docs/relay-v1-spec.md), on
// top of the core's two calls: request (a route under /app/w/<team>) and tool (an MCP tool).
// Text that came from a customer's PC (names, notes, step details) passes through here as
// data and is only ever shown as text.

const PAGE_LIMIT = 20;

// Reads every page of a list that pages by `next`.
async function pages(read, key) {
  const out = [];
  let after = null;
  for (let i = 0; i < PAGE_LIMIT; i += 1) {
    const page = await read(after);
    out.push(...(page[key] ?? []));
    if (!page.next) break;
    after = page.next;
  }
  return out;
}

const normalizeDevice = (d) => ({
  id: d.id,
  name: String(d.name ?? ''),
  status: d.status === 'pending' ? 'pending' : 'active',
  siteId: d.site_id ?? null,
  access: d.access === 'any' ? 'any' : 'ask',
  control: d.control ?? null,
  os: d.os ?? null,
  machine: d.machine ?? null,
  appVersion: d.app_version ?? null,
  lastSeen: d.last_seen ?? null,
  pairedAt: d.paired_at ?? null,
  expiresAt: d.expires_at ?? null,
  online: d.online === true,
});

// The team's saved PCs, with which ones are online now (the MCP tool carries that).
export async function fetchDevices(core, account) {
  const rows = await pages(async (after) => (await core.tool(account, 'device_list', after ? { after } : {})).data, 'devices');
  return rows.map(normalizeDevice);
}

// Sites and customers, for the names under each PC.
export async function fetchPlaces(core, account) {
  const read = (path, key) => pages(async (after) => core.request(account, 'GET', `${path}?limit=500${after ? `&after=${after}` : ''}`), key);
  const [sites, customers] = await Promise.all([read('/api/sites', 'sites'), read('/api/customers', 'customers')]);
  const customerName = new Map(customers.map((c) => [c.id, String(c.name ?? '')]));
  const out = new Map();
  for (const s of sites) out.set(s.id, { name: String(s.name ?? ''), customer: customerName.get(s.customer_id) ?? '' });
  return out;
}

// Who you are on this team and what your role allows.
export async function fetchMe(core, account) {
  const v = await core.request(account, 'GET', '/api');
  return { identity: String(v?.me?.identity ?? ''), role: v?.me?.role_id ?? null, permissions: Array.isArray(v?.me?.permissions) ? v.me.permissions : [] };
}

export async function createPairing(core, account) {
  const v = await core.request(account, 'POST', '/api/pairing', {});
  return v.pairing;
}

// Approves a waiting PC with the six digits its owner reads out.
export const approveDevice = (core, account, id, confirm) => core.request(account, 'PATCH', `/api/devices/${id}`, { approve: { confirm } });

export async function connectDevice(core, account, deviceId, { takeOver = false } = {}) {
  return (await core.tool(account, 'device_connect', { device_id: deviceId, ...(takeOver ? { take_over: true } : {}) })).data;
}

export async function sessionStatus(core, account, sessionId, logTail = 40) {
  return (await core.tool(account, 'session_status', { session_id: sessionId, log_tail: logTail })).data;
}

export const endSession = (core, account, sessionId) => core.tool(account, 'session_end', { session_id: sessionId });

// A fresh screenshot: { image: { mime, data }, meta }.
export async function screenshot(core, account, sessionId) {
  const out = await core.tool(account, 'screenshot', { session_id: sessionId });
  return { image: out.image ?? null, meta: out.data };
}

export const createOneOff = async (core, account) => (await core.tool(account, 'session_create', {})).data;

// The agent's tasks.
export async function listTasks(core, account) {
  const v = await core.request(account, 'GET', '/api/agent/tasks');
  return Array.isArray(v?.tasks) ? v.tasks : [];
}
export async function taskStatus(core, account, taskId, waitS = 0) {
  const v = await core.request(account, 'GET', `/api/agent/tasks/${taskId}${waitS ? `?wait_s=${waitS}` : ''}`);
  return v.task;
}
export const taskFrame = (core, account, taskId) => core.request(account, 'GET', `/api/agent/tasks/${taskId}/frame`);
export const controlTask = (core, account, taskId, action) => core.request(account, 'POST', `/api/agent/tasks/${taskId}/${action}`, {});
export const startTask = (core, account, body) => core.request(account, 'POST', '/api/agent/tasks', body);
// The models a team offers and whether the starter may pick: the MCP tool with no task.
export async function agentModels(core, account) {
  const d = (await core.tool(account, 'agent_status', {})).data;
  return { models: Array.isArray(d.models) ? d.models : [], defaultModel: d.default_model ?? null, canPick: d.starters_pick_model === true, caps: d.caps ?? null };
}

// Notification settings: { events: { <event>: bool }, watch: [device id] }.
export const getNotifySettings = (core, account) => core.request(account, 'GET', '/notifications/settings');
export const patchNotifySettings = (core, account, patch) => core.request(account, 'PATCH', '/notifications/settings', patch);

export const listTeams = async (core, account) => (await core.request(account, 'GET', '/teams')).teams ?? [];

// A task that is still working (running, or paused and waiting to be resumed).
export const isLiveTask = (task) => task && (task.state === 'running' || task.state === 'paused');

// The one task, if any, that is working on this session.
export const taskOnSession = (tasks, sessionId) => tasks.find((x) => x.session_id === sessionId && isLiveTask(x)) ?? null;

// The relay's words for a refused call, or a plain fallback. Never HTML.
export function messageOf(e, fallback) {
  const m = e && typeof e === 'object' ? e.message : null;
  return typeof m === 'string' && m ? m : fallback;
}
