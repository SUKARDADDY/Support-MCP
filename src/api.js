// The team API: members, roles and the team log of a workspace, under
// /api/v1/w/<slug>/..., plus POST and GET /api/v1/w to create a workspace and
// list the caller's. "default" always exists; any other slug exists once it has
// been created, and anything else is 404 before a permission is looked at. The
// gate is the same as /mcp and runs before any database access: an Origin
// header is refused, a write must be JSON, and Cloudflare Access must admit the
// caller. A browser sign-in cookie is not accepted here. Team management is
// never an MCP tool, so text on a customer's screen can't make an agent add a
// member.
import { TeamError, teamFromEnv } from './workspace.js';

const ROOT = '/api/v1/w';
const PREFIX = '/api/v1/w/';
const BODY_MAX = 16384;
const AUDIT_LIMIT_MAX = 500;
const AUDIT_LIMIT_DEFAULT = 100;

const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra } });
const fail = (status, code, message, extra) => json({ error: { code, message } }, status, extra);
const notAllowed = (allow) => fail(405, 'method_not_allowed', `use ${allow}`, { allow });

async function readBody(request) {
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > BODY_MAX) throw new TeamError(400, 'bad_request', 'the request body is too large');
  const text = await request.text();
  if (text.length > BODY_MAX) throw new TeamError(400, 'bad_request', 'the request body is too large');
  let body;
  try { body = JSON.parse(text); } catch (_) { throw new TeamError(400, 'bad_request', 'the body must be JSON'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TeamError(400, 'bad_request', 'the body must be a JSON object');
  return body;
}

function decodeSegment(s) {
  try { return decodeURIComponent(s); } catch (_) { throw new TeamError(400, 'bad_request', 'bad path'); }
}

function intParam(url, name, def, min, max) {
  const v = url.searchParams.get(name);
  if (v === null || v === '') return def;
  if (!/^\d+$/.test(v) || Number(v) < min || Number(v) > max) throw new TeamError(400, 'bad_request', `${name} must be a whole number from ${min} to ${max}`);
  return Number(v);
}

// Throws 403 unless the caller holds one of `permissions`. While the workspace
// is open a caller holds only sessions.*, so `onOpen` says what an open
// workspace means for the route: 'allow' (a read open to anyone, or the add
// that the store itself limits to the first member), 'first_member' (a team
// write: 409, add yourself as the first admin), or 'deny' (403, the default).
async function need(team, slug, caller, permissions, onOpen = 'deny') {
  let refusal = null;
  for (const p of permissions) {
    const a = await team.authorize(slug, caller, p);
    if (a.ok) return;
    if (a.reason === 'not_member') throw new TeamError(403, 'not_member', 'you are not a member of this team');
    if (a.reason === 'open') {
      if (onOpen === 'allow') return;
      if (onOpen === 'first_member') throw new TeamError(409, 'first_member', 'add yourself as the first admin before changing the team');
    }
    refusal = refusal || p;
  }
  throw new TeamError(403, 'permission_denied', `your role does not allow ${refusal}`);
}

// deps: { accessCaller(request, env, url) -> identity|null, isJsonContentType(request) -> bool } from app.js.
export async function handleApi(request, env, url, { accessCaller, isJsonContentType }) {
  const method = request.method;
  if (request.headers.has('origin')) return fail(403, 'forbidden', 'cross-site requests are refused');
  if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(method)) return notAllowed('GET, POST, PATCH, DELETE');
  if (method !== 'GET' && !isJsonContentType(request)) return fail(415, 'unsupported_media_type', 'send content-type: application/json');
  const caller = await accessCaller(request, env, url);
  if (!caller) return fail(403, 'forbidden', 'Cloudflare Access did not admit this request');

  try {
    if (url.pathname === ROOT) {
      if (method === 'GET') return json({ workspaces: await teamFromEnv(env).listWorkspaces(caller) });
      if (method === 'POST') return json({ workspace: await teamFromEnv(env).createWorkspace(caller, await readBody(request)) }, 201);
      return notAllowed('GET, POST');
    }
    if (!url.pathname.startsWith(PREFIX)) throw new TeamError(404, 'not_found', 'not found');
    const [slug, collection, item, ...extra] = url.pathname.slice(PREFIX.length).split('/');
    const team = teamFromEnv(env);
    // A slug that was never created, or is malformed, is 404 for everyone.
    if (!(await team.workspaceExists(slug))) throw new TeamError(404, 'not_found', 'no such workspace');
    if (extra.length || item === '') throw new TeamError(404, 'not_found', 'not found');

    if (collection === undefined) {
      if (method !== 'GET') return notAllowed('GET');
      const me = await team.whoami(slug, caller);
      if (!me.open && !me.member) throw new TeamError(403, 'not_member', 'you are not a member of this team');
      return json({
        workspace: { slug, open: me.open },
        me: { identity: me.identity, role_id: me.role_id, permissions: me.permissions },
        ...(me.open ? { recent_callers: await team.recentCallers(slug) } : {}),
      });
    }

    if (collection === 'members') {
      if (item === undefined) {
        if (method === 'GET') {
          await need(team, slug, caller, ['members.manage']);
          return json({ members: await team.listMembers(slug) });
        }
        if (method === 'POST') {
          await need(team, slug, caller, ['members.manage'], 'allow');
          return json({ member: await team.addMember(slug, caller, await readBody(request)) }, 201);
        }
        return notAllowed('GET, POST');
      }
      const identity = decodeSegment(item);
      if (method === 'PATCH') {
        await need(team, slug, caller, ['members.manage'], 'first_member');
        return json({ member: await team.updateMember(slug, caller, identity, await readBody(request)) });
      }
      if (method === 'DELETE') {
        await need(team, slug, caller, ['members.manage'], 'first_member');
        return json({ removed: await team.removeMember(slug, caller, identity) });
      }
      return notAllowed('PATCH, DELETE');
    }

    if (collection === 'roles') {
      if (item === undefined) {
        if (method === 'GET') {
          // Whoever manages members needs the role ids too. Open to anyone while open.
          await need(team, slug, caller, ['roles.manage', 'members.manage'], 'allow');
          return json({ roles: await team.listRoles(slug) });
        }
        if (method === 'POST') {
          await need(team, slug, caller, ['roles.manage'], 'first_member');
          return json({ role: await team.addRole(slug, caller, await readBody(request)) }, 201);
        }
        return notAllowed('GET, POST');
      }
      const roleId = decodeSegment(item);
      if (method === 'PATCH') {
        await need(team, slug, caller, ['roles.manage'], 'first_member');
        return json({ role: await team.updateRole(slug, caller, roleId, await readBody(request)) });
      }
      if (method === 'DELETE') {
        await need(team, slug, caller, ['roles.manage'], 'first_member');
        return json({ removed: await team.removeRole(slug, caller, roleId) });
      }
      return notAllowed('PATCH, DELETE');
    }

    if (collection === 'audit' && item === undefined) {
      if (method !== 'GET') return notAllowed('GET');
      const after = intParam(url, 'after', 0, 0, Number.MAX_SAFE_INTEGER);
      const limit = intParam(url, 'limit', AUDIT_LIMIT_DEFAULT, 1, AUDIT_LIMIT_MAX);
      // A page check covers the rows shown; verify=full checks the whole chain.
      // Like the other parameters, an empty value counts as left out and a
      // repeated one uses its first value.
      const verify = url.searchParams.get('verify') || null;
      if (verify !== null && verify !== 'full') throw new TeamError(400, 'bad_request', 'verify must be full, or left out to check only the rows shown');
      await need(team, slug, caller, ['audit.view']);
      return json(await team.readAudit(slug, { after, limit, full: verify === 'full' }));
    }

    throw new TeamError(404, 'not_found', 'not found');
  } catch (e) {
    if (e instanceof TeamError) return fail(e.status, e.code, e.message, e.status === 503 ? { 'retry-after': '1' } : undefined);
    return fail(500, 'internal', 'internal error');
  }
}
