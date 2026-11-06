// OAuth for MCP clients: the part of the relay that issues and checks access
// tokens, so Claude Code, Codex, Cursor and VS Code can sign in once and then
// act as the person.
//
// This file never imports @cloudflare/workers-oauth-provider. The Worker entry
// (src/index.js) imports it and passes what is needed to createOAuth(), so the
// router stays loadable by Node. The tests load the real library through a
// loader that stands in for `cloudflare:workers` (test/stubs/).
//
// We use the library's split roles, not its all-in-one provider:
//   - OAuthAuthorizationServer serves the discovery document, /oauth/token and
//     /oauth/register, and gives us the helpers the consent page uses
//     (parseAuthRequest, beginConsent, approveConsent, completeAuthorization).
//   - OAuthAuthorizationServer#validateToken checks a bearer token for one
//     exact resource address.
// The all-in-one provider fixes its protected addresses at construction and
// answers 401 itself before our Origin and content-type checks, so it cannot be
// used here. Our own router serves the protected resource documents (RFC 9728),
// the /oauth/authorize page (src/auth.js) and the 401 challenge.
//
// A resource address is the MCP address: PUBLIC_ORIGIN/mcp for the default
// workspace and PUBLIC_ORIGIN/w/<slug>/mcp for every other. A token is bound to
// exactly one of them.
import { ownOrigin } from './auth.js';
import { DEFAULT_WORKSPACE, teamFromEnv } from './workspace.js';
import { accountStore } from './accounts.js';
import { needsSecondFactor } from './permissions.js';

export const ACCESS_TOKEN_TTL_S = 3600; // one hour
export const REFRESH_TOKEN_TTL_S = 30 * 86400; // 30 days, rotating
export const PROTECTED_RESOURCE_PREFIX = '/.well-known/oauth-protected-resource';
export const AS_METADATA_PATH = '/.well-known/oauth-authorization-server';
export const AUTHORIZE_PATH = '/oauth/authorize';
export const TOKEN_PATH = '/oauth/token';
export const REGISTER_PATH = '/oauth/register';

// How long a list of workspace addresses is kept, and the least time between two
// refreshes forced by an address the list does not have. A workspace created
// after the Worker started is usable once the list is refreshed.
const LIST_TTL_MS = 10_000;
const MISS_GAP_MS = 2_000;

const WORKSPACE_PATH = /^\/w\/([a-z0-9-]{1,40})\/mcp$/;

// The MCP path of a workspace, and its full resource address.
export const mcpPath = (slug) => (slug === DEFAULT_WORKSPACE ? '/mcp' : `/w/${slug}/mcp`);
export const resourceUrl = (origin, slug) => `${origin}${mcpPath(slug)}`;

// The workspace a resource address names, or null if it is none of ours.
export function workspaceForResource(origin, resource) {
  if (typeof resource !== 'string' || !resource.startsWith(origin)) return null;
  const path = resource.slice(origin.length);
  if (path === '/mcp') return DEFAULT_WORKSPACE;
  const m = WORKSPACE_PATH.exec(path);
  return m && m[1] !== DEFAULT_WORKSPACE ? m[1] : null;
}

// A token this server issues is `<user id>:<grant id>:<secret>`. The user id is a
// UUID (src/accounts.js), the grant id 16 and the secret 32 characters of
// A-Z a-z 0-9 - _. Returns the user id, or null for any other shape.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function tokenUserId(token) {
  const parts = typeof token === 'string' ? token.split(':') : [];
  if (parts.length !== 3 || !UUID.test(parts[0]) || !/^[A-Za-z0-9_-]{16}$/.test(parts[1]) || !/^[A-Za-z0-9_-]{32}$/.test(parts[2])) return null;
  return parts[0];
}

// The Authorization header's bearer token: null when there is no Bearer
// credential (another scheme counts as none), '' for an empty one.
export function bearerToken(request) {
  const m = /^Bearer(?:\s+(.*))?$/i.exec((request.headers.get('authorization') || '').trim());
  return m ? (m[1] || '').trim() : null;
}

// WWW-Authenticate for a 401 on an MCP address. It points a client at the
// resource's metadata, which names our authorization server.
export function challengeHeader(origin, workspace, { invalid = false } = {}) {
  if (!origin) return 'Bearer';
  const doc = `${origin}${PROTECTED_RESOURCE_PREFIX}${mcpPath(workspace)}`;
  return `Bearer resource_metadata="${doc}"${invalid ? ', error="invalid_token"' : ''}`;
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
};

const jsonResponse = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra } });

// lib is { OAuthAuthorizationServer, AuthorizationError, CimdFetchError } from
// the library. tuning is for tests: { listTtlMs, missGapMs }.
export function createOAuth(lib, tuning = {}) {
  const listTtlMs = tuning.listTtlMs ?? LIST_TTL_MS;
  const missGapMs = tuning.missGapMs ?? MISS_GAP_MS;
  // Per isolate, per database: the workspace addresses and the server built from them.
  const lists = new WeakMap();

  // Is OAuth set up for this request? It needs the KV namespace and an address
  // to be the issuer: PUBLIC_ORIGIN, or the loopback address in development.
  function available(env, url) {
    if (!env.OAUTH_KV || typeof env.OAUTH_KV.get !== 'function') return null;
    const where = ownOrigin(env, url);
    return where.error ? null : { origin: where.origin };
  }

  function buildServer(origin, slugs, { cimd }) {
    const resources = [resourceUrl(origin, DEFAULT_WORKSPACE), ...slugs.map((slug) => resourceUrl(origin, slug))];
    return new lib.OAuthAuthorizationServer({
      issuer: origin,
      resources,
      authorizeEndpoint: AUTHORIZE_PATH,
      tokenEndpoint: TOKEN_PATH,
      clientRegistrationEndpoint: REGISTER_PATH,
      accessTokenTTL: ACCESS_TOKEN_TTL_S,
      refreshTokenTTL: REFRESH_TOKEN_TTL_S,
      // A client may use an https address as its client_id and the server reads
      // its metadata there. It needs the global_fetch_strictly_public flag.
      clientIdMetadataDocumentEnabled: cimd,
      // RFC 8252 native apps return through their own link, such as cursor://.
      // This is safe only because every authorization request must carry PKCE
      // (S256), which src/auth.js enforces for every client, and because the
      // consent page names the full return address. The page's form-action is
      // built by redirectSource() in src/auth.js, which refuses any scheme it
      // does not know how to write safely.
      allowPrivateUseRedirectUris: true,
    });
  }

  // Reads the list from D1 and rebuilds the server only if it changed.
  async function loadList(env, origin) {
    const key = env.DB || env;
    const previous = lists.get(key);
    const sameHost = previous && previous.origin === origin;
    const slugs = await teamFromEnv(env).workspaceSlugs();
    const same = sameHost && previous.slugs.size === slugs.length && slugs.every((s) => previous.slugs.has(s));
    const entry = { origin, at: Date.now(), slugs: new Set(slugs), server: same ? previous.server : buildServer(origin, slugs, { cimd: true }) };
    lists.set(key, entry);
    return entry;
  }

  // The authorization server for every workspace address that exists now. The
  // list comes from D1, is kept for a few seconds, and is read again at once
  // when `wantSlug` is not in it (a workspace made a moment ago). One read per
  // missGapMs at most, so a stream of unknown addresses cannot become a stream
  // of D1 reads.
  async function serverFor(env, origin, wantSlug) {
    const entry = lists.get(env.DB || env);
    const now = Date.now();
    const sameHost = entry && entry.origin === origin;
    const stale = !sameHost || now - entry.at >= listTtlMs;
    const missed = sameHost && wantSlug && wantSlug !== DEFAULT_WORKSPACE && !entry.slugs.has(wantSlug) && now - entry.at >= missGapMs;
    return (stale || missed ? await loadList(env, origin) : entry).server;
  }

  // Did a forced re-read of the list (at most one per missGapMs) change it?
  // Used when /oauth/token refuses a request, which is how a code exchange in
  // another Worker instance meets a workspace made after its list was read.
  async function listChangedOnMiss(env, origin) {
    const entry = lists.get(env.DB || env);
    if (!entry || entry.origin !== origin || Date.now() - entry.at < missGapMs) return false;
    return (await loadList(env, origin)).server !== entry.server;
  }

  async function workspaceKnown(env, origin, slug) {
    if (slug === DEFAULT_WORKSPACE) return true;
    await serverFor(env, origin, slug);
    return lists.get(env.DB || env).slugs.has(slug);
  }

  // The library's helpers for the consent page. `resource` is the request's
  // resource parameter, so a workspace made a moment ago is in the list.
  async function api(env, origin, resource) {
    const slug = workspaceForResource(origin, resource);
    return (await serverFor(env, origin, slug)).getOAuthApi(env);
  }

  // Is this /oauth/token answer a refusal that an unknown workspace address causes?
  async function refusedForResource(response) {
    try {
      const body = await response.clone().json();
      return body && (body.error === 'invalid_target' || body.error === 'invalid_grant');
    } catch (_) {
      return false;
    }
  }

  // The discovery document lists every address in `protected_resources`. That
  // would publish every team's name, so it is removed from what we serve.
  async function withoutResourceList(response) {
    const type = response.headers.get('content-type') || '';
    if (response.status !== 200 || !type.includes('json')) return response;
    let doc;
    try { doc = await response.clone().json(); } catch (_) { return response; }
    if (!doc || typeof doc !== 'object' || !('protected_resources' in doc)) return response;
    delete doc.protected_resources;
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    return new Response(JSON.stringify(doc), { status: response.status, headers });
  }

  // /.well-known/oauth-authorization-server, /oauth/token and /oauth/register.
  async function serveServer(request, env, ctx, url) {
    const where = available(env, url);
    if (!where) return new Response('not found', { status: 404 });
    const context = ctx || { waitUntil() {}, passThroughOnException() {} };
    // A token request names no workspace we can read without opening the code,
    // so a refusal is the miss signal: if re-reading the list finds a workspace
    // the server did not have, the request runs once more on the new server.
    // A refusal never uses up a code, so the second run is safe.
    const isToken = url.pathname === TOKEN_PATH && request.method === 'POST';
    const again = isToken ? request.clone() : null;
    let server = await serverFor(env, where.origin, null);
    let response = await server.fetch(request, env, context);
    if (isToken && response.status === 400 && (await refusedForResource(response)) && (await listChangedOnMiss(env, where.origin))) {
      server = await serverFor(env, where.origin, null);
      response = await server.fetch(again, env, context);
    }
    return url.pathname === AS_METADATA_PATH ? withoutResourceList(response) : response;
  }

  // RFC 9728 documents. The bare path and /mcp name the default workspace;
  // /w/<slug>/mcp names that workspace, and 404 if it was never created.
  async function serveResourceMetadata(request, env, url) {
    const where = available(env, url);
    if (!where) return new Response('not found', { status: 404 });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405, headers: { ...CORS, allow: 'GET, HEAD, OPTIONS' } });
    }
    const rest = url.pathname.slice(PROTECTED_RESOURCE_PREFIX.length);
    let slug = null;
    if (rest === '' || rest === '/mcp') slug = DEFAULT_WORKSPACE;
    else {
      const m = WORKSPACE_PATH.exec(rest);
      if (m && m[1] !== DEFAULT_WORKSPACE && (await workspaceKnown(env, where.origin, m[1]))) slug = m[1];
    }
    if (slug === null) return jsonResponse({ error: 'not_found' }, 404, CORS);
    const body = {
      resource: resourceUrl(where.origin, slug),
      authorization_servers: [where.origin],
      bearer_methods_supported: ['header'],
      resource_name: 'Support-MCP',
    };
    return request.method === 'HEAD'
      ? new Response(null, { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS } })
      : jsonResponse(body, 200, CORS);
  }

  // Checks a bearer token for exactly this workspace's MCP address. A server
  // that declares only this one address is enough: a token for another address
  // is not found under it, and a workspace that does not exist has no tokens.
  // Before KV is read, the token must have the shape this server issues and name
  // a person who exists and is enabled (one D1 read; D1's free read limit is far
  // above KV's). Anything else is refused with no KV read, so junk bearer tokens
  // cannot use up the day's KV reads. Returns the caller, or why not.
  async function checkBearer(env, origin, workspace, token) {
    if (!token || token.length > 2000) return { ok: false };
    const wanted = tokenUserId(token);
    if (!wanted) return { ok: false };
    try {
      const user = await accountStore(env.DB, { secret: env.AUTH_SECRET }).userById(wanted);
      if (!user || user.disabled_at) return { ok: false };
    } catch (_) {
      return { ok: false, unavailable: true };
    }
    const resource = resourceUrl(origin, workspace);
    let found;
    try {
      found = await buildServer(origin, workspace === DEFAULT_WORKSPACE ? [] : [workspace], { cimd: false }).validateToken(resource, token, env);
    } catch (_) {
      // KV failed (its daily limit, say). The token may be fine, so this is
      // not a 401: the client must not throw its sign-in away.
      return { ok: false, unavailable: true };
    }
    const props = found && found.props;
    if (!props || typeof props.email !== 'string' || typeof props.user_id !== 'string' || props.workspace !== workspace || props.user_id !== found.userId) {
      return { ok: false };
    }
    return { ok: true, email: props.email, userId: props.user_id, factor: typeof props.factor === 'number' ? props.factor : null };
  }

  // Ends every grant the person has, which ends their tokens.
  async function revokeGrants(env, origin, userId) {
    const helpers = buildServer(origin, [], { cimd: false }).getOAuthApi(env);
    let cursor;
    do {
      const page = await helpers.listUserGrants(userId, { limit: 100, cursor });
      for (const grant of page.items) await helpers.revokeGrant(grant.id, userId);
      cursor = page.cursor;
    } while (cursor);
  }

  return {
    lib, available, api, serveServer, serveResourceMetadata, checkBearer, revokeGrants, workspaceKnown, workspaceForResource,
    AuthorizationError: lib.AuthorizationError,
    CimdFetchError: lib.CimdFetchError,
  };
}

// ---- checks made on every call by an OAuth caller ---------------------------
// A token proves who connected and when. Whether they may still act is read
// live from the database on every tool call, as it is for an Access login.
// (The caller's role is checked by the same team.authorize call as for Access.)

// The person must still exist, be enabled and be invited to some team.
export async function assertPersonActive(env, team, caller) {
  const accounts = accountStore(env.DB, { secret: env.AUTH_SECRET });
  const user = await accounts.userById(caller.userId);
  if (!user || user.disabled_at || user.email !== caller.email || !(await team.isInvited(user.email))) {
    throw new Error('you are not a member of this team');
  }
}

// A permission that needs a second factor needs two things: the grant was made
// in a sign-in that passed an authenticator code, and the person's authenticator
// is still the one that code came from. A reset or replaced authenticator ends
// that, until the client signs in again.
export async function assertSecondFactor(env, caller, permission) {
  if (!needsSecondFactor(permission)) return;
  const accounts = accountStore(env.DB, { secret: env.AUTH_SECRET });
  const factor = await accounts.getFactor(caller.userId);
  if (caller.factor === null || !factor || factor.created_at !== caller.factor) {
    throw new Error('a second factor is required: connect this client again and enter your authenticator code');
  }
}
