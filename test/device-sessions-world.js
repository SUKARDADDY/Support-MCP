// A whole relay for the saved-PC session tests: the real Worker router, the real
// Session and Registry objects behind small Durable Object stand-ins, the D1
// stand-in with every migration, and Access logins signed by a local key. Time
// moves only when a test moves it. Nothing touches the network.
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openD1 } from './d1-fake.js';
import { createHandler } from '../src/app.js';
import { Session } from '../src/session.js';
import { Registry } from '../src/registry.js';
import { teamStore } from '../src/workspace.js';
import { devicesFromEnv } from '../src/devices.js';
import { importRsaJwk } from '../src/jwt.js';

export const TEAM = 'device-sessions-test.cloudflareaccess.com';
export const AUD = 'device-sessions-test-aud';
export const HOST = 'https://support.example.com';
export const SECRET = 'a-deployment-secret-of-at-least-32-characters';
export const BOSS = 'boss@example.com';
export const TECH = 'tech@example.com';
export const VIEW = 'view@example.com';
export const LEAD = 'lead@example.com'; // devices.manage, sessions.control and sessions.unattended, but not admin
export const OTHER = 'other@example.com';

const kp = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', kp.publicKey)), kid: 'k1' };
await importRsaJwk(jwk, crypto.subtle);
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url) === `https://${TEAM}/cdn-cgi/access/certs`) return Response.json({ keys: [jwk] });
  return realFetch(url, init);
};
const b64url = (u8) => btoa(String.fromCharCode(...u8)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const enc = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
export async function accessToken(who) {
  const input = `${enc({ alg: 'RS256', kid: 'k1', typ: 'JWT' })}.${enc({ aud: AUD, iss: `https://${TEAM}`, exp: Math.floor(Date.now() / 1000) + 600, email: who })}`;
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', kp.privateKey, new TextEncoder().encode(input)));
  return `${input}.${b64url(sig)}`;
}

// A stand-in for a Durable Object's context. Sockets are plain objects.
function context({ sql } = {}) {
  const values = new Map();
  const logs = [];
  const sockets = [];
  const waited = []; // promises handed to waitUntil
  let alarm = null;
  const ctx = {
    values, logs, sockets, waited,
    waitUntil: (promise) => { waited.push(promise); },
    alarm: () => alarm,
    storage: {
      get: async (key) => (Array.isArray(key) ? new Map(key.map((k) => [k, values.get(k)])) : values.get(key)),
      put: async (data) => { for (const [k, v] of Object.entries(data)) values.set(k, v); },
      setAlarm: async (deadline) => { alarm = deadline; },
      deleteAlarm: async () => { alarm = null; },
      sql: sql ?? {
        exec(query, ...args) {
          if (query.startsWith('INSERT INTO log')) logs.push({ ts: args[0], kind: args[1], detail: args[2] });
          else if (query.startsWith('SELECT ts,kind,detail')) return { toArray: () => logs.slice(-args[0]).reverse() };
          else if (query.startsWith('UPDATE log SET')) Object.assign(logs.at(-1), { ts: args[0], detail: args[1] });
          else if (!query.startsWith('CREATE TABLE')) throw new Error(`Unexpected SQL: ${query}`);
          return { toArray: () => [] };
        },
      },
    },
    getWebSockets: (tag) => sockets.filter((w) => !w.closed && (!tag || w.tags.includes(tag))),
    getTags: (ws) => ws.tags,
    acceptWebSocket: (ws, tags) => { ws.tags = tags; sockets.push(ws); },
  };
  return ctx;
}

// A hibernated socket as the objects see it: it records what it was sent.
export function socket(tags) {
  const ws = { tags, sent: [], closed: false, closeCode: null, send: (d) => ws.sent.push(d), close: (code) => { ws.closed = true; ws.closeCode = code ?? null; } };
  return ws;
}

// The Registry's own SQLite, over node:sqlite.
function registryContext() {
  const sqlite = new DatabaseSync(':memory:');
  return context({
    sql: {
      exec(query, ...args) {
        const st = sqlite.prepare(query);
        if (/^\s*(SELECT)/i.test(query)) return { toArray: () => st.all(...args).map((r) => ({ ...r })) };
        st.run(...args);
        return { toArray: () => [] };
      },
    },
  });
}

// handlerOptions is createHandler's third argument (OAuth, a mailer, ...).
export async function world(t, { time = 1_800_000_000_000, env: extra = {}, members = true, handlerOptions = {} } = {}) {
  let now = time;
  t.mock.method(Date, 'now', () => now);
  const db = openD1();
  const env = { DB: db, AUTH_SECRET: SECRET, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, DEPLOYMENT_ADMINS: BOSS, ...extra };
  const sessions = new Map(); // sid -> { session, ctx }
  const registries = new Map(); // name -> { registry, ctx }
  const registryCalls = []; // { name, path } for every request to a Registry
  const sessionCalls = []; // { sid, path, body } for every request to a Session from the Worker or the store

  const sidOf = (name) => createHash('sha256').update(`session:${name}`).digest('hex');
  const sessionFor = (sid) => {
    if (!sessions.has(sid)) {
      const ctx = context();
      sessions.set(sid, { ctx, session: new Session(ctx, env) });
    }
    return sessions.get(sid);
  };
  env.SESSION = {
    idFromName: (name) => ({ toString: () => sidOf(name) }),
    idFromString: (s) => ({ toString: () => s }),
    get: (id) => {
      const sid = id.toString();
      return {
        fetch: async (u, init) => {
          const request = typeof u === 'string' ? new Request(u, init) : u;
          let body = null;
          try { body = JSON.parse(await request.clone().text()); } catch (_) { /* not JSON */ }
          sessionCalls.push({ sid, path: new URL(request.url).pathname, body, headers: Object.fromEntries(request.headers) });
          return sessionFor(sid).session.fetch(request);
        },
      };
    },
  };
  const registryFor = (name) => {
    if (!registries.has(name)) {
      const ctx = registryContext();
      registries.set(name, { ctx, registry: new Registry(ctx, env) });
    }
    return registries.get(name);
  };
  env.REGISTRY = {
    idFromName: (n) => n,
    get: (name) => ({
      fetch: async (u, init) => {
        const request = typeof u === 'string' ? new Request(u, init) : u;
        registryCalls.push({ name, path: new URL(request.url).pathname });
        return registryFor(name).registry.fetch(request);
      },
    }),
  };

  const team = teamStore(db, { deploymentAdmins: BOSS });
  if (members) {
    await team.addMember('default', BOSS, { identity: BOSS, role_id: 'admin' });
    await team.addMember('default', BOSS, { identity: TECH, role_id: 'technician' });
    await team.addMember('default', BOSS, { identity: VIEW, role_id: 'viewer' });
    await team.addRole('default', BOSS, { id: 'lead', permissions: ['devices.view', 'devices.manage', 'sessions.view', 'sessions.control', 'sessions.end', 'sessions.unattended'] });
    await team.addMember('default', BOSS, { identity: LEAD, role_id: 'lead' });
  }
  const devs = devicesFromEnv(env);
  const handler = createHandler('powershell agent', null, handlerOptions);

  const send = async (path, init = {}) => handler.fetch(new Request(`${init.base ?? HOST}${path}`, init), env);
  // One MCP tool call as `who`. A tool error is { error: text }; a result is its JSON.
  async function tool(who, name, args = {}, base = '/mcp') {
    const r = await send(base, {
      method: 'POST', headers: { 'content-type': 'application/json', 'cf-access-jwt-assertion': await accessToken(who) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    const result = (await r.json()).result;
    const text = result.content[0].text;
    if (result.isError) return { error: text };
    try { return JSON.parse(text); } catch (_) { return { text }; }
  }
  // Any MCP method as `who`, with the raw JSON-RPC body back.
  async function rpc(who, method, params, base = '/mcp') {
    const r = await send(base, {
      method: 'POST', headers: { 'content-type': 'application/json', 'cf-access-jwt-assertion': await accessToken(who) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }),
    });
    return { status: r.status, body: await r.json() };
  }
  // A call to the team API.
  async function api(who, method, path, body, slug = 'default') {
    const r = await send(`/api/v1/w/${slug}${path}`, {
      method, headers: { 'content-type': 'application/json', 'cf-access-jwt-assertion': await accessToken(who) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: r.status, body: await r.json() };
  }
  // The PC's calls.
  const bearer = (key) => ({ authorization: `Bearer ${key}` });
  async function hello(key, body = { protocol: 1 }) {
    const r = await send('/device/hello', { method: 'POST', headers: { 'content-type': 'application/json', ...bearer(key) }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  }
  async function agent(sid, key, body, headers = {}) {
    const r = await send(`/agent?sid=${sid}`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(key ? bearer(key) : {}), ...headers }, body: JSON.stringify(body),
    });
    let json = null;
    try { json = await r.json(); } catch (_) { /* no body */ }
    return { status: r.status, body: json };
  }
  // A saved PC, paired for real. Returns { id, key }.
  async function addPc({ name = 'Till', access = 'ask', control = 'full', version = '1.0.0', status = 'active' } = {}) {
    if (status === 'pending') {
      const out = await devs.requestJoin({ protocol: 1, workspace: 'default', name, access, control, app_version: version });
      return { id: out.device_id, key: out.key };
    }
    const made = await devs.createPairingCode('default', BOSS, {});
    const out = await devs.redeemCode({ protocol: 1, code: made.code, name, access, control, os: 'Windows 11', machine: 'M1', app_version: version });
    return { id: out.device_id, key: out.key };
  }
  const sql = (text, ...p) => db.sqlite.prepare(text).all(...p);
  const pointer = (id) => {
    const row = sql('SELECT session FROM devices WHERE id = ?', id)[0];
    return row && row.session ? JSON.parse(row.session) : null;
  };
  const log = async (slug = 'default') => (await team.readAudit(slug, { limit: 500 })).rows;
  const kinds = async (slug = 'default') => (await log(slug)).map((r) => r.kind);
  // A doorbell connected for a PC: the Registry holds a socket tagged for it.
  const ringSocket = (id, slug = 'default') => {
    const name = slug === 'default' ? 'registry' : `registry:${slug}`;
    const ws = socket([`dev:${id}`]);
    registryFor(name).ctx.sockets.push(ws);
    return ws;
  };
  // Connect, as `who`, and run the PC side up to the hello. Returns { sid, welcome }.
  async function attach(pc, who = BOSS, { control = 'full', caps = ['screen', 'lanes'], version = '1.0.0' } = {}) {
    const started = await tool(who, 'device_connect', { device_id: pc.id });
    const welcome = await agent(started.session_id, pc.key, { type: 'hello', machine: 'M1', user: 'dana', control, caps, version });
    return { sid: started.session_id, started, welcome };
  }
  return {
    env, db, team, devs, handler, now: () => now, advance: (ms) => { now += ms; },
    sessions, sessionFor, registries, registryFor, registryCalls, sessionCalls,
    send, tool, rpc, api, hello, agent, bearer, addPc, sql, pointer, log, kinds, ringSocket, attach,
    stateOf: (sid) => sessionFor(sid).ctx.values.get('state'),
    reasonOf: (sid) => sessionFor(sid).ctx.values.get('ended_reason'),
  };
}
