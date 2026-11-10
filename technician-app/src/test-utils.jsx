// A stand-in for the Rust core that answers as the relay does (the shapes in
// docs/relay-v1-spec.md and src/mcp.js), so a screen can be driven end to end in a test.
import { render } from '@testing-library/react';
import { vi } from 'vitest';
import { App } from './App.jsx';
import { DEFAULT_DOC, effective } from './rules.js';

export const ACCOUNT = { id: 'acc1', relay: 'https://relay.example', team: 'default', team_name: 'Default', email: 'tech@example.com', signed_in: true };
export const ID = (c) => c.repeat(20);

export const device = (over = {}) => ({
  id: ID('a'), site_id: null, status: 'active', name: 'Front counter', access: 'any', control: 'full', owner_contact: '', os: 'Windows 11 Pro',
  machine: 'FRONT', app_version: '0.7.0', protocol: 1, paired_at: Date.parse('2026-09-12T10:00:00Z'), paired_by: 'tech@example.com', approved_by: null,
  last_seen: Date.now() - 60000, fields: {}, online: true, ...over,
});

const TECH = ['devices.view', 'devices.manage', 'sessions.create', 'sessions.view', 'sessions.control', 'sessions.end'];

// An error as the core hands one over: { code, message, status }.
export const relayFail = (status, code, message) => Object.assign(new Error(message), { code, status });
export const GOOD_CODE = '123456';
export const SID = (c = 's') => c.repeat(64);
export const AID = (c = 'a') => c.repeat(32);

export class ToolFail extends Error {
  constructor(message, code = 'tool') {
    super(message);
    this.code = code;
  }
}

// The default answers of the people, handover and queue tools: they change what the stand-in's relay holds.
const ME = 'tech@example.com';
const roomOf = (state, sid) => (state.sessions[sid] ??= { state: 'attached', driver: ME, log: [] });
export function peopleCall(state, args) {
  const room = roomOf(state, args.session_id);
  const list = (room.participants ??= [{ identity: room.driver ?? ME, name: 'Tess Tech', role: 'driver', since: Date.now() - 60000 }]);
  const name = (identity) => state.people.find((p) => p.identity === identity)?.name ?? null;
  if (args.action === 'invite') list.push({ identity: args.identity, name: name(args.identity), role: 'invited', since: Date.now() });
  if (args.action === 'join') list.forEach((p) => { if (p.identity === ME && p.role === 'invited') p.role = 'watcher'; });
  if (args.action === 'leave') room.participants = list.filter((p) => p.identity !== ME);
  if (args.action === 'remove') room.participants = list.filter((p) => p.identity !== args.identity);
  return { participants: structuredClone(room.participants) };
}
export function handoverCall(state, args) {
  const room = roomOf(state, args.session_id);
  const list = (room.participants ??= [{ identity: room.driver ?? ME, name: 'Tess Tech', role: 'driver', since: Date.now() - 60000 }]);
  if (args.action === 'offer') room.offer = { to: args.identity, by: room.driver, expires_at: Date.now() + 120000 };
  if (args.action === 'cancel' || args.action === 'decline') room.offer = null;
  if (args.action === 'accept' || args.action === 'take_over') {
    const old = room.driver;
    room.driver = ME;
    room.offer = null;
    room.participants = list.map((p) => (p.identity === ME ? { ...p, role: 'driver' } : p.identity === old ? { ...p, role: 'watcher' } : p));
  }
  return { driver: room.driver, participants: structuredClone(room.participants), offer: room.offer ?? null };
}
export function escalationCall(state, args) {
  const q = state.queue;
  if (args.action === 'list') {
    const keep = args.status === 'closed' ? (e) => e.closed_at : args.status === 'mine' ? (e) => !e.closed_at && (e.opened_by === ME || e.claimed_by === ME) : (e) => !e.closed_at && !e.claimed_by;
    return { escalations: structuredClone(q.filter(keep)) };
  }
  if (args.action === 'open') {
    const e = { id: ID('e'), kind: 'technician', device_id: null, device_name: null, session_id: args.session_id ?? null, task_id: null, summary: null, note: args.note ?? null, opened_by: ME, opened_at: Date.now(), claimed_by: null, claimed_at: null, closed_by: null, closed_at: null, close_note: null };
    q.push(e);
    return { escalation: e };
  }
  const e = q.find((x) => x.id === args.id);
  if (args.action === 'claim') {
    e.claimed_by = ME;
    e.claimed_at = Date.now();
    return e.session_id && state.sessions[e.session_id]?.state !== 'ended' && state.claimLive
      ? { escalation: e, session_id: e.session_id, driver: ME, ...(e.device_id ? { device_id: e.device_id, device_name: e.device_name } : { one_off: true }), participants: [] }
      : { escalation: e, ...(e.device_id ? { device_id: e.device_id, device_name: e.device_name } : { one_off: true }) };
  }
  e.closed_by = ME;
  e.closed_at = Date.now();
  e.close_note = args.note ?? null;
  return { escalation: e };
}

// The relay's /rules routes: the team's document at /rules and a customer's override at /rules/<customer id>.
// A save needs the revision that was read and the good code, and is recorded in state.saves.
export async function rulesCall(state, account, method, customerId, body) {
  if (state.rulesGate) await state.rulesGate;
  if (state.rulesError) { const e = state.rulesError(method, customerId, body); if (e) throw e; }
  const rules = state.rulesFor?.(account) ?? state.rules; // a test may give each team its own
  const row = customerId ? rules.overrides[customerId] ?? { rev: 0, doc: {}, updated_at: null, updated_by: null } : rules.team;
  if (method === 'GET' && !customerId) {
    return { rules: structuredClone(rules.team), overrides: Object.entries(rules.overrides).map(([id, o]) => ({ customer_id: id, ...structuredClone(o) })), default_time_zone: rules.defaultTimeZone };
  }
  if (method === 'GET') return { customer_id: customerId, ...structuredClone(row), effective: { rev: rules.team.rev + row.rev, ...effective(rules.team.doc, row.doc, rules.defaultTimeZone) } };
  if (state.saveGate) await state.saveGate;
  if (body.rev !== row.rev) throw relayFail(409, 'stale', 'the rules changed since you read them; read them again');
  if (body.code !== state.goodCode) throw relayFail(403, 'second_factor', 'that code is wrong or was already used; wait for the next one from your authenticator');
  state.saves = [...(state.saves ?? []), { method, customerId, ...structuredClone(body) }];
  if (method === 'DELETE') { delete rules.overrides[customerId]; return { removed: { customer_id: customerId } }; }
  const saved = { rev: row.rev + 1, doc: structuredClone(body.doc), updated_at: Date.now(), updated_by: 'tech@example.com' };
  if (customerId) { rules.overrides[customerId] = saved; return { override: { customer_id: customerId, ...saved } }; }
  rules.team = saved;
  return { rules: saved };
}

// The approval waiting on a session, and the answer to it.
export async function approvalsCall(state, account, method, sid, id, body) {
  if (state.approvalsGate) await state.approvalsGate;
  if (state.approvalsError) { const e = state.approvalsError(method, sid, id); if (e) throw e; }
  const waiting = state.approvals[sid] ?? null;
  if (method === 'GET') return { approvals: waiting ? [structuredClone(waiting)] : [] };
  if (state.answerGate) await state.answerGate;
  if (!waiting || waiting.id !== id) throw relayFail(404, 'not_found', 'that approval is not waiting: it was answered or cancelled, or it timed out');
  if (body.approve && body.code !== state.goodCode) throw relayFail(403, 'second_factor', 'that code is wrong or was already used; wait for the next one from your authenticator');
  state.answers = [...(state.answers ?? []), { account, sid, id, ...structuredClone(body) }];
  delete state.approvals[sid];
  return { id, approved: body.approve };
}

// Builds the stand-in. `state` is what the relay holds; tests change it between steps.
export function fakeCore(initial = {}) {
  const state = {
    accounts: [ACCOUNT],
    permissions: TECH,
    devices: [device(), device({ id: ID('b'), name: 'Back office', access: 'ask', online: true, site_id: ID('s') }), device({ id: ID('c'), name: 'Kitchen screen', online: false, last_seen: Date.now() - 86400000 })],
    sites: [{ id: ID('s'), customer_id: ID('k'), name: "Hadar's Bakery" }],
    customers: [{ id: ID('k'), name: 'Hadar Bakery Ltd' }],
    pairing: { id: ID('p'), code: 'K7Q42-M9H3X', expires_at: Date.now() + 600000, site_id: null, link: 'https://relay.example/install?code=K7Q42-M9H3X' },
    connect: () => ({ session_id: 's'.repeat(64), state: 'attached', asks: false, rang: true }),
    sessions: {},
    notifySettings: { events: { task_finished: true, task_problem: true, session_declined: true, device_online: true, device_missing: true, device_waiting: true, escalation_opened: true, escalation_claimed: true }, watch: [] },
    people: [{ identity: 'tech@example.com', name: 'Tess Tech', can_control: true }, { identity: 'lead@example.com', name: 'Lee Lead', can_control: true }, { identity: 'viewer@example.com', name: null, can_control: false }],
    queue: [],
    teams: [{ slug: 'default', name: 'Default' }, { slug: 'acme', name: 'Acme Support' }],
    prefs: { desktop_notifications: true },
    recent: [],
    models: { models: [{ provider: 'anthropic', id: 'claude-sonnet' }], default_model: 'claude-sonnet', starters_pick_model: true, tasks: [], caps: {} },
    tasks: [],
    // The team's rules and the customers' overrides, as /rules answers; `goodCode` is the authenticator code the relay accepts once.
    rules: { team: { rev: 0, doc: structuredClone(DEFAULT_DOC), updated_at: null, updated_by: null }, overrides: {}, defaultTimeZone: 'UTC' },
    goodCode: GOOD_CODE,
    approvals: {}, // session id -> the approval waiting on it
    autostart: false,
    update: null,
    ...initial,
  };
  const calls = [];
  const handlers = new Map();
  const log = (kind, ...args) => calls.push({ kind, args });

  const core = {
    appInfo: vi.fn(async () => ({ version: '0.7.0', default_relay: 'https://default.example', default_team: 'default' })),
    accounts: vi.fn(async () => structuredClone(state.accounts)),
    signIn: vi.fn(async (relay, team) => {
      if (state.signInError) throw state.signInError;
      const a = { ...ACCOUNT, id: `acc-${team}`, relay, team, team_name: team };
      state.accounts = [...state.accounts.filter((x) => x.id !== a.id), a];
      return a;
    }),
    signInCancel: vi.fn(async () => {}),
    signOut: vi.fn(async (id) => { state.accounts = state.accounts.filter((a) => a.id !== id); }),
    recentNotifications: vi.fn(async () => structuredClone(state.recent)),
    prefs: vi.fn(async () => ({ ...state.prefs })),
    setPrefs: vi.fn(async (p) => { state.prefs = p; }),
    autostart: vi.fn(async () => state.autostart),
    setAutostart: vi.fn(async (on) => { state.autostart = on; }),
    updateStatus: vi.fn(async () => state.update),
    checkForUpdate: vi.fn(async () => state.update),
    setWindowTheme: vi.fn(async () => {}),
    on: vi.fn(async (event, handler) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(handler);
      return () => handlers.get(event).delete(handler);
    }),
    request: vi.fn(async (account, method, path, body) => {
      log('request', method, path, body);
      const [p, q] = path.split('?');
      if (state.requestError?.(method, p)) throw state.requestError(method, p);
      if (p === '/api') return { workspace: { slug: 'default', open: false }, me: { identity: 'tech@example.com', role_id: 'technician', permissions: state.permissions, ...(state.meFor?.(account) ?? {}) } };
      if (p === '/api/sites') return { sites: state.sites, next: null };
      if (p === '/api/customers') return { customers: state.customers, next: null };
      if (p === '/api/devices' && method === 'GET') return { devices: state.devices.map(({ online, ...d }) => d), next: null };
      if (p === '/api/pairing' && method === 'POST') { if (state.pairingGate) await state.pairingGate; return { pairing: state.pairing }; }
      if (p === '/api/pairing' && method === 'GET') return state.pairingList ? state.pairingList() : { pairings: state.pairingUsed ? [] : [{ id: state.pairing.id, expires_at: state.pairing.expires_at }], next: null };
      const approve = /^\/api\/devices\/(\w+)$/.exec(p);
      if (approve && method === 'PATCH') {
        if (state.approveGate) await state.approveGate;
        if (state.approveError) throw state.approveError;
        const d = state.devices.find((x) => x.id === approve[1]);
        d.status = 'active';
        return { device: d };
      }
      if (p === '/api/agent/tasks' && method === 'GET') { if (state.tasksGate) await state.tasksGate; return { tasks: state.tasks }; }
      if (p === '/api/agent/tasks' && method === 'POST') {
        const id = ID('t');
        state.started = body;
        // The relay knows the task it started, so the screens can follow it. One started on a PC
        // has no session yet: the relay connects, and the status carries the session later.
        const started = { id, state: 'running', title: String(body.instructions ?? ''), device_id: body.device_id ?? null, session_id: body.session_id ?? null, created_at: Date.now(), ended_at: null, model: null, phase: 'working', rev: 1, steps: [], notes: [] };
        state.tasks.push(started);
        return { task_id: id, state: 'running', device_id: started.device_id, session_id: started.session_id };
      }
      const task = /^\/api\/agent\/tasks\/(\w+)(?:\/(frame|pause|resume|stop))?$/.exec(p);
      if (task) {
        const t = state.tasks.find((x) => x.id === task[1]);
        if (task[2] === 'frame') {
          if (state.frame) return state.frame(q);
          throw Object.assign(new Error('the task has no picture yet'), { code: 'no_frame', status: 404 });
        }
        if (task[2]) { state.controlled = [...(state.controlled ?? []), task[2]]; return { task_id: task[1], state: task[2] === 'stop' ? 'stopped' : task[2] === 'pause' ? 'paused' : 'running' }; }
        return { task: state.taskStatus ? state.taskStatus(t, q) : t, ...(state.taskCaps ? { caps: state.taskCaps } : {}) };
      }
      const frame = /^\/api\/sessions\/(\w+)\/frame$/.exec(p);
      if (frame) {
        if (state.sessionFrame) return state.sessionFrame(frame[1], account);
        throw Object.assign(new Error('this session has no picture yet'), { code: 'no_frame', status: 404 });
      }
      const rulesRoute = /^\/api\/rules(?:\/(\w+))?$/.exec(p);
      if (rulesRoute) return rulesCall(state, account, method, rulesRoute[1] ?? null, body);
      const approvalsRoute = /^\/api\/sessions\/(\w+)\/approvals(?:\/(\w+))?$/.exec(p);
      if (approvalsRoute) return approvalsCall(state, account, method, approvalsRoute[1], approvalsRoute[2] ?? null, body);
      if (p === '/teams') return { teams: state.teams };
      if (p === '/notifications/settings') {
        if (state.notifySettingsFor) return state.notifySettingsFor(account);
        if (method === 'PATCH') {
          state.patches = [...(state.patches ?? []), body];
          state.notifySettings = { events: { ...state.notifySettings.events, ...(body.events ?? {}) }, watch: body.watch ?? state.notifySettings.watch };
        }
        return structuredClone(state.notifySettings);
      }
      throw new Error(`unexpected request ${method} ${path}`);
    }),
    tool: vi.fn(async (account, name, args) => {
      log('tool', name, args);
      switch (name) {
        case 'device_list': return { data: state.deviceList ? await state.deviceList(account) : { devices: structuredClone(state.devices), next: null }, image: null };
        case 'device_connect': {
          const out = await state.connect(args, account);
          if (out instanceof Error) throw out;
          return { data: out, image: null };
        }
        case 'session_status': return { data: state.sessionStatus ? await state.sessionStatus(args) : { state: 'attached', driver: 'tech@example.com', log: [], ...(state.sessions[args.session_id] ?? {}) }, image: null };
        case 'session_end':
          if (state.endGate) await state.endGate;
          if (state.endError) throw state.endError;
          state.ended = [...(state.ended ?? []), args.session_id];
          return { data: { ended: true }, image: null };
        case 'session_create': if (state.oneOffGate) await state.oneOffGate; return { data: { session_id: 'o'.repeat(64), windows_mode: 'app', download_url: 'https://relay.example/j/abcdefghijklmnop?client=app', code_expires_at: Date.now() + 600000 }, image: null };
        case 'screenshot': {
          if (state.screenshot) return state.screenshot(args);
          return { data: { width: 1280, height: 800 }, image: { mime: 'image/jpeg', data: 'QUJD' } };
        }
        case 'agent_status': return { data: state.models, image: null };
        case 'people_list': return { data: state.peopleList ? await state.peopleList(account) : { people: structuredClone(state.people) }, image: null };
        case 'session_participants': return { data: state.participantsCall ? await state.participantsCall(args, account) : peopleCall(state, args), image: null };
        case 'session_handover': return { data: state.handoverCall ? await state.handoverCall(args, account) : handoverCall(state, args), image: null };
        case 'escalation': return { data: state.escalationCall ? await state.escalationCall(args, account) : escalationCall(state, args), image: null };
        default: throw new Error(`unexpected tool ${name}`);
      }
    }),
  };
  const emit = (event, payload) => (handlers.get(event) ?? new Set()).forEach((h) => h(payload));
  return { core, state, calls, emit };
}

export const FAST = { connectPollMs: 10, devicePollMs: 60000, watchMs: 20, screenshotMs: 20, taskCheckMs: 40, statusMs: 30, taskGapMs: 15, taskRetryMs: 20 };

export function renderApp(fake = fakeCore(), tuning = FAST) {
  const view = render(<App core={fake.core} tuning={tuning} />);
  return { ...view, ...fake };
}
