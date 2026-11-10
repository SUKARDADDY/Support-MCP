// A stand-in for the Rust core that answers as the relay does (the shapes in
// docs/relay-v1-spec.md and src/mcp.js), so a screen can be driven end to end in a test.
import { render } from '@testing-library/react';
import { vi } from 'vitest';
import { App } from './App.jsx';

export const ACCOUNT = { id: 'acc1', relay: 'https://relay.example', team: 'default', team_name: 'Default', email: 'tech@example.com', signed_in: true };
export const ID = (c) => c.repeat(20);

export const device = (over = {}) => ({
  id: ID('a'), site_id: null, status: 'active', name: 'Front counter', access: 'any', control: 'full', owner_contact: '', os: 'Windows 11 Pro',
  machine: 'FRONT', app_version: '0.7.0', protocol: 1, paired_at: Date.parse('2026-09-12T10:00:00Z'), paired_by: 'tech@example.com', approved_by: null,
  last_seen: Date.now() - 60000, fields: {}, online: true, ...over,
});

const TECH = ['devices.view', 'devices.manage', 'sessions.create', 'sessions.view', 'sessions.control', 'sessions.end'];

export class ToolFail extends Error {
  constructor(message, code = 'tool') {
    super(message);
    this.code = code;
  }
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
    notifySettings: { events: { task_finished: true, task_problem: true, session_declined: true, device_online: true, device_missing: true, device_waiting: true }, watch: [] },
    teams: [{ slug: 'default', name: 'Default' }, { slug: 'acme', name: 'Acme Support' }],
    prefs: { desktop_notifications: true },
    recent: [],
    models: { models: [{ provider: 'anthropic', id: 'claude-sonnet' }], default_model: 'claude-sonnet', starters_pick_model: true, tasks: [], caps: {} },
    tasks: [],
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
      if (p === '/api') return { workspace: { slug: 'default', open: false }, me: { identity: 'tech@example.com', role_id: 'technician', permissions: state.permissions } };
      if (p === '/api/sites') return { sites: state.sites, next: null };
      if (p === '/api/customers') return { customers: state.customers, next: null };
      if (p === '/api/devices' && method === 'GET') return { devices: state.devices.map(({ online, ...d }) => d), next: null };
      if (p === '/api/pairing' && method === 'POST') { if (state.pairingGate) await state.pairingGate; return { pairing: state.pairing }; }
      if (p === '/api/pairing' && method === 'GET') return state.pairingList ? state.pairingList() : { pairings: state.pairingUsed ? [] : [{ id: state.pairing.id, expires_at: state.pairing.expires_at }], next: null };
      const approve = /^\/api\/devices\/(\w+)$/.exec(p);
      if (approve && method === 'PATCH') {
        if (state.approveError) throw state.approveError;
        const d = state.devices.find((x) => x.id === approve[1]);
        d.status = 'active';
        return { device: d };
      }
      if (p === '/api/agent/tasks' && method === 'GET') return { tasks: state.tasks };
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
      if (p === '/teams') return { teams: state.teams };
      if (p === '/notifications/settings') {
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
