// What the screens ask of the relay, in the relay's own shapes (docs/relay-v1-spec.md), on
// top of the core's two calls: request (a route under /app/w/<team>) and tool (an MCP tool).
// Text that came from a customer's PC (names, notes, step details) passes through here as
// data and is only ever shown as text.

import { hasKey, t } from './i18n/index.js';

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
  for (const s of sites) out.set(s.id, { name: String(s.name ?? ''), customer: customerName.get(s.customer_id) ?? '', customerId: s.customer_id ?? null });
  return out;
}

// Every customer of the team, [{ id, name }], for the Rules screen's picker.
export async function fetchCustomers(core, account) {
  const rows = await pages((after) => core.request(account, 'GET', `/api/customers?limit=500${after ? `&after=${after}` : ''}`), 'customers');
  return rows.map((c) => ({ id: c.id, name: String(c.name ?? '') }));
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

// The pairing codes that can still be used (the relay never shows the code again): [{ id, expires_at, ... }].
export async function listPairings(core, account) {
  const v = await core.request(account, 'GET', '/api/pairing');
  // A reply without the list is a failed read, not an empty list: an empty one would read as "every code is used".
  if (!Array.isArray(v?.pairings)) throw new Error('the pairing list is missing from the relay\'s answer');
  return v.pairings;
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
// The task, with the team's spending caps ({ task_cap_usd, month_cap_usd, month_spent_usd }) as
// `caps` when the relay sent them.
export async function taskStatus(core, account, taskId, waitS = 0) {
  const v = await core.request(account, 'GET', `/api/agent/tasks/${taskId}${waitS ? `?wait_s=${waitS}` : ''}`);
  return v.caps && v.task ? { ...v.task, caps: v.caps } : v.task;
}
export const taskFrame = (core, account, taskId) => core.request(account, 'GET', `/api/agent/tasks/${taskId}/frame`);
export const controlTask = (core, account, taskId, action) => core.request(account, 'POST', `/api/agent/tasks/${taskId}/${action}`, {});
// Only App's startAgentTask calls this: it stops the screenshots of the open tabs first (a test holds that).
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

// ---- people in a session, handover and the queue (the tools people_list, session_participants,
// session_handover and escalation; their errors start with a code the core hands over as `code`) ----

// The team's people you may invite: [{ identity, name, can_control }].
export async function listPeople(core, account) {
  const d = (await core.tool(account, 'people_list', {})).data;
  return Array.isArray(d?.people) ? d.people : [];
}

// invite, join, leave or remove: the session's people afterwards, [{ identity, name, role, since }].
export async function participantsAction(core, account, sessionId, action, identity = null) {
  const d = (await core.tool(account, 'session_participants', { session_id: sessionId, action, ...(identity ? { identity } : {}) })).data;
  return Array.isArray(d?.participants) ? d.participants : [];
}

// offer, accept, decline, cancel or take_over: { driver, participants, offer }.
export async function handoverAction(core, account, sessionId, action, identity = null) {
  const d = (await core.tool(account, 'session_handover', { session_id: sessionId, action, ...(identity ? { identity } : {}) })).data;
  return { driver: d?.driver ?? null, participants: Array.isArray(d?.participants) ? d.participants : [], offer: d?.offer ?? null };
}

// The last full screenshot of a live session, for a joined watcher: { rev, at, mime, data }.
export const sessionFrame = (core, account, sessionId) => core.request(account, 'GET', `/api/sessions/${sessionId}/frame`);

// The queue: status is open, mine or closed. Notes and summaries are text people and an agent wrote: shown as text only.
export async function listQueue(core, account, status) {
  const d = (await core.tool(account, 'escalation', { action: 'list', status })).data;
  return Array.isArray(d?.escalations) ? d.escalations : [];
}
export async function openEscalation(core, account, sessionId, note) {
  const d = (await core.tool(account, 'escalation', { action: 'open', session_id: sessionId, ...(note ? { note } : {}) })).data;
  return d?.escalation ?? null;
}
// A live claim answers with the session (session_id, driver); a ticket with the PC (device_id) or one_off.
export async function claimEscalation(core, account, id) {
  return (await core.tool(account, 'escalation', { action: 'claim', id })).data ?? {};
}
export async function closeEscalation(core, account, id, note) {
  const d = (await core.tool(account, 'escalation', { action: 'close', id, ...(note ? { note } : {}) })).data;
  return d?.escalation ?? null;
}

// ---- the team's rules and the approvals they ask for (the team API's /rules and the app's
// sessions/<id>/approvals; text in a rules document is the team's own, and the summary of an approval
// is built by the relay from the action, so both are shown as text) ----

const normalizeRow = (r) => ({ rev: Number.isSafeInteger(r?.rev) ? r.rev : 0, doc: r?.doc && typeof r.doc === 'object' ? r.doc : {}, updatedAt: r?.updated_at ?? null, updatedBy: r?.updated_by ?? null });

// The team's rules and every customer's override: { team: { rev, doc }, overrides: Map(customer id -> { rev, doc }), defaultTimeZone }.
// A customer with no override has none in the map: revision 0 and an empty document.
export async function fetchRules(core, account) {
  const v = await core.request(account, 'GET', '/api/rules');
  if (!v?.rules || typeof v.rules !== 'object') throw new Error('the rules are missing from the relay\'s answer');
  return {
    team: normalizeRow(v.rules),
    overrides: new Map((Array.isArray(v.overrides) ? v.overrides : []).map((o) => [o.customer_id, normalizeRow(o)])),
    defaultTimeZone: typeof v.default_time_zone === 'string' && v.default_time_zone ? v.default_time_zone : 'UTC',
  };
}

// One customer's override and the rules in force for that customer, as the relay works them out.
export async function fetchCustomerRules(core, account, customerId) {
  const v = await core.request(account, 'GET', `/api/rules/${customerId}`);
  if (!v?.effective || typeof v.effective !== 'object') throw new Error('the rules are missing from the relay\'s answer');
  return { ...normalizeRow(v), effective: v.effective };
}

// Saves the whole team document (customerId null) or a customer's override. `rev` is the revision that was read and `code`
// a fresh code from the person's authenticator. Answers the saved row.
export async function saveRules(core, account, customerId, doc, rev, code) {
  const v = await core.request(account, 'PATCH', customerId ? `/api/rules/${customerId}` : '/api/rules', { doc, rev, code });
  return normalizeRow(customerId ? v?.override : v?.rules);
}

// Removes a customer's override, so the customer has the team's rules again.
export const removeOverride = (core, account, customerId, rev, code) => core.request(account, 'DELETE', `/api/rules/${customerId}`, { rev, code });

// The approval waiting on a session: [] or one { id, summary, actor, via, action, created_at, expires_at, device_id, device_name }.
export async function listApprovals(core, account, sessionId) {
  const v = await core.request(account, 'GET', `/api/sessions/${sessionId}/approvals`);
  return Array.isArray(v?.approvals) ? v.approvals : [];
}

// Approve (with a fresh authenticator code) or deny (no code) the waiting approval.
export const answerApproval = (core, account, sessionId, id, approve, code) => core.request(account, 'POST', `/api/sessions/${sessionId}/approvals/${id}`, { approve, ...(approve ? { code } : {}) });

// What to tell the person about a code the relay refused (a wrong or used code, no authenticator, too many tries), or null
// when the refusal was about something else.
export function codeProblem(e) {
  if (e?.code === 'locked') return t('code.locked');
  if (e?.code !== 'second_factor') return null;
  return /authenticator on your account/i.test(String(e.message ?? '')) ? t('code.none') : t('code.wrong');
}

// A tool's refusal as the PC or the rules wrote it, "<code>: <sentence>", in our words for the code when there are some
// ("refuse.<code>" in en.json). Used for the details of an agent's failed steps and the reasons a task ended. Anything
// else, or no text, stays as it is.
export function codedText(text) {
  const m = /^([a-z][a-z_]{1,39}): /.exec(String(text ?? ''));
  return m && hasKey(`refuse.${m[1]}`) ? t(`refuse.${m[1]}`) : text;
}

// The words of a message of the core's own, by the stable `reason` it carries, in en.json
// ("error.<reason>"); `message` (the core's English, or the relay's own text) when there is no line for it.
export function reasonText(reason, message) {
  return typeof reason === 'string' && hasKey(`error.${reason}`) ? t(`error.${reason}`) : message;
}

// What to tell the person about a refused call to the tools above: our words for the codes they use
// ("refuse.<code>" in en.json), else messageOf.
export function refusalText(e, fallback) {
  const code = e?.code;
  return typeof code === 'string' && hasKey(`refuse.${code}`) ? t(`refuse.${code}`) : messageOf(e, fallback);
}

// What to tell the person about a refused call: the core's message in en.json, or the relay's
// own words, or a plain fallback. Never HTML.
export function messageOf(e, fallback) {
  if (!e || typeof e !== 'object') return fallback;
  const m = reasonText(e.reason, e.message);
  return typeof m === 'string' && m ? m : fallback;
}
