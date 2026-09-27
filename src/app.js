// support-mcp relay router: Access JWT gate + MCP JSON-RPC handler + the
// public customer paths (/healthz, /j/<code>, /ws). Kept free of the .ps1
// import and the DO classes so node --test can drive it route-level; index.js
// wires it to the real agent template.
import { verifyAccessJwt, importRsaJwk, localBypassAllowed, callerIdentity } from './jwt.js';
import { handleRpc } from './mcp.js';
import { buildBootstrap, INVALID_LINK_SCRIPT, METHOD_NOT_ALLOWED_SCRIPT } from './template.js';

const CODE_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'; // RFC4648 base32, lowercased
function newCode() {
  const u = new Uint8Array(16);
  crypto.getRandomValues(u);
  let s = '';
  for (let i = 0; i < 16; i++) s += CODE_ALPHABET[u[i] & 31];
  return s; // 16 chars * 5 bits = 80 bits
}

// ---- JWKS cache (module scope, ~1h) ----------------------------------------
// Normal refresh may use the edge cache. A refetch forced by an unknown `kid`
// (key rotation) bypasses every cache and is limited to one per 60 s so a
// stream of junk tokens cannot turn into a stream of certs fetches.
const JWKS_TTL_MS = 3600_000;
const JWKS_FORCED_MIN_GAP_MS = 60_000;
let jwksCache = { at: 0, keys: new Map(), domain: '' };
let jwksForcedAt = 0;

async function fetchJwks(domain, forced) {
  const url = `https://${domain}/cdn-cgi/access/certs`;
  const init = forced ? { cache: 'no-store' } : { cf: { cacheTtl: 3600 } };
  const r = await fetch(url, init);
  if (!r.ok) throw new Error('jwks fetch failed');
  const { keys } = await r.json();
  const map = new Map();
  for (const jwk of keys || []) {
    if (jwk.kid) map.set(jwk.kid, await importRsaJwk(jwk, crypto.subtle));
  }
  jwksCache = { at: Date.now(), keys: map, domain };
}

// Lazy: nothing is fetched until a well-formed token asks for a kid.
function keyResolverFor(env) {
  const domain = env.ACCESS_TEAM_DOMAIN;
  return async (kid) => {
    const fresh = jwksCache.domain === domain && Date.now() - jwksCache.at < JWKS_TTL_MS;
    if (!fresh) await fetchJwks(domain, false);
    if (jwksCache.keys.has(kid)) return jwksCache.keys.get(kid);
    const now = Date.now();
    if (now - jwksForcedAt < JWKS_FORCED_MIN_GAP_MS) return null;
    jwksForcedAt = now;
    await fetchJwks(domain, true);
    return jwksCache.keys.get(kid) || null;
  };
}

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...extra } });
}
const noStore = { 'cache-control': 'no-store' };
const psText = (body, status, extra = {}) =>
  new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', ...noStore, ...extra } });

// ---- MCP backend: each tool talks to the DOs -------------------------------
function makeBackend(env, origin, devTtlMs, actor) {
  const sessionStub = (sid) => {
    if (!/^[0-9a-f]{64}$/.test(String(sid || ''))) throw new Error('session_id required (64 hex chars)');
    return env.SESSION.get(env.SESSION.idFromString(sid));
  };
  async function cmd(sid, body) {
    const r = await sessionStub(sid).fetch('https://do/command', {
      method: 'POST',
      body: JSON.stringify({ ...body, actor }),
    });
    return r.json();
  }
  return {
    async session_create(args) {
      const code = newCode();
      const id = env.SESSION.idFromName(code);
      const sid = id.toString();
      const r = await env.SESSION.get(id).fetch('https://do/create', {
        method: 'POST',
        body: JSON.stringify({ code, sid, label: args.label ?? null, ttl_ms: devTtlMs, actor }),
      });
      const out = await r.json();
      if (!out.ok) throw new Error(out.error || 'session_create failed');
      return {
        session_id: sid,
        one_liner: `irm ${origin}/j/${code} | iex`,
        code_expires_at: out.code_expires_at,
      };
    },
    async session_list() {
      const r = await env.REGISTRY.get(env.REGISTRY.idFromName('registry')).fetch('https://do/list');
      const { sessions } = await r.json();
      return { sessions };
    },
    async session_status(args) {
      const tail = args.log_tail == null ? 20 : args.log_tail;
      const r = await sessionStub(args.session_id).fetch(`https://do/status?log_tail=${encodeURIComponent(tail)}`);
      return r.json();
    },
    async run(args) {
      const r = await cmd(args.session_id, { op: 'run', command: args.command, timeout_s: args.timeout_s });
      if (r.ok === false) throw new Error(r.error || 'run failed');
      return {
        exit_code: typeof r.exit_code === 'number' ? r.exit_code : null,
        stdout: r.stdout,
        stderr: r.stderr,
        timed_out: !!r.timed_out,
      };
    },
    async put_file(args) {
      const r = await cmd(args.session_id, { op: 'put_file', path: args.path, data_b64: args.data_b64, append: args.append });
      if (r.ok === false) throw new Error(r.error || 'put_file failed');
      return { bytes: r.bytes };
    },
    async get_file(args) {
      const r = await cmd(args.session_id, { op: 'get_file', path: args.path, offset: args.offset, length: args.length });
      if (r.ok === false) throw new Error(r.error || 'get_file failed');
      return { data_b64: r.data_b64, size: r.size, eof: r.eof };
    },
    async session_end(args) {
      const r = await sessionStub(args.session_id).fetch('https://do/end', {
        method: 'POST',
        body: JSON.stringify({ actor }),
      });
      return r.json();
    },
  };
}

// ---- Access gate -----------------------------------------------------------
// Returns the caller identity string when allowed, or null.
async function accessCaller(request, env, url) {
  if (localBypassAllowed(env, url.hostname)) return 'local-dev';
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return null;
  try {
    const payload = await verifyAccessJwt(token, {
      aud: env.ACCESS_AUD,
      iss: `https://${env.ACCESS_TEAM_DOMAIN}`,
      keyResolver: keyResolverFor(env),
      subtle: crypto.subtle,
    });
    return callerIdentity(payload);
  } catch (_) {
    return null;
  }
}

function isJsonContentType(request) {
  const ct = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  return ct === 'application/json';
}

// ---- routes ----------------------------------------------------------------
async function handleJ(request, env, url, origin, agentText) {
  // Only GET consumes the code. Any other method (HEAD from a link preview,
  // POST from a scanner) gets a harmless 405 and leaves the code untouched.
  if (request.method !== 'GET') return psText(request.method === 'HEAD' ? null : METHOD_NOT_ALLOWED_SCRIPT, 405, { allow: 'GET' });
  let code;
  try {
    code = decodeURIComponent(url.pathname.slice(3));
  } catch (_) {
    return psText(INVALID_LINK_SCRIPT, 404);
  }
  if (!/^[a-z2-7]{16}$/.test(code)) return psText(INVALID_LINK_SCRIPT, 404);
  const id = env.SESSION.idFromName(code);
  const r = await env.SESSION.get(id).fetch('https://do/consume', { method: 'POST', body: '{}' });
  const out = await r.json();
  if (!out.ok) return psText(INVALID_LINK_SCRIPT, 404);
  let script;
  try {
    script = buildBootstrap(agentText, { sid: id.toString(), key: out.key, origin });
  } catch (_) {
    return psText(INVALID_LINK_SCRIPT, 404);
  }
  return psText(script, 200);
}

function handleWs(request, env, url) {
  // The attach key travels ONLY in the X-Attach-Key header; a key in the query
  // string (which lands in access logs) is refused outright.
  if (url.searchParams.has('key')) return new Response('unauthorized', { status: 401 });
  const sid = url.searchParams.get('sid') || '';
  if (!/^[0-9a-f]{64}$/.test(sid)) return new Response('unauthorized', { status: 401 });
  let id;
  try {
    id = env.SESSION.idFromString(sid);
  } catch (_) {
    return new Response('unauthorized', { status: 401 });
  }
  return env.SESSION.get(id).fetch(new Request(`https://do/ws?sid=${sid}`, request));
}

async function handleMcp(request, env, url, origin, devTtlMs) {
  // CSRF: the Access app also admits a browser identity (cookie). MCP clients
  // never send Origin; browsers always do on cross-origin POST. Refuse it, and
  // require a JSON content type (a form post cannot set one without CORS).
  if (request.headers.has('origin')) return json({ error: 'forbidden' }, 403);
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405, { allow: 'POST' });
  if (!isJsonContentType(request)) return json({ error: 'unsupported media type' }, 415);
  const actor = await accessCaller(request, env, url);
  if (!actor) return json({ error: 'forbidden' }, 403);
  let msg;
  try {
    msg = await request.json();
  } catch (_) {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }, 200);
  }
  const backend = makeBackend(env, origin, devTtlMs, actor);
  const { status, body } = await handleRpc(msg, backend);
  if (body === null) return new Response(null, { status });
  return json(body, status);
}

export function createHandler(agentText) {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      const p = url.pathname;
      const origin = `${url.protocol}//${url.host}`;
      const devTtlMs =
        localBypassAllowed(env, url.hostname) && env.SESSION_TTL_MS ? Number(env.SESSION_TTL_MS) : 0;

      if (p === '/healthz') return json({ ok: true, service: 'support-mcp', stage: 'relay-v1' });
      if (p.startsWith('/j/')) return handleJ(request, env, url, origin, agentText);
      if (p === '/ws') return handleWs(request, env, url);
      if (p === '/mcp') return handleMcp(request, env, url, origin, devTtlMs);
      return new Response('not found', { status: 404 });
    },
  };
}
