// The team API: members, roles, the team log, the stop switch, and the customers, sites, saved
// PCs, custom fields and pairing codes of a workspace, under
// /api/v1/w/<slug>/..., plus POST and GET /api/v1/w to create a workspace and
// list the caller's. "default" always exists; any other slug exists once it has
// been created, and anything else is 404 before a permission is looked at. The
// gate is the same as /mcp and runs before any database access: an Origin
// header is refused, a write must be JSON, and Cloudflare Access must admit the
// caller. A browser sign-in cookie is not accepted here. Team management is
// never an MCP tool, so text on a customer's screen can't make an agent add a
// member. A PC pairs and checks in at /device/ (src/device-api.js), not here.
//
// The technician app reaches a part of this router through /app/w/<slug>/api/...
// (src/app.js), which has already checked its bearer token and rewritten the path.
// There the caller is an OAuth caller, held to the rules MCP gives one: a real
// member (never open mode), the second factor for a permission that needs one,
// and only the routes the app uses (APP_ROUTES). Members, roles, the team log,
// the stop switch and the agent's settings and models are not among them.
//
// One route is not a collection: GET sessions/<64 hex session id>/frame, the last full screenshot of a
// live session, for the driver and for a person who joined it (src/session-people.js). It is held in the
// session's memory, so a watcher's app reads it here and an AI client is not sent large images it did not ask for.
import { TeamError, teamFromEnv } from './workspace.js';
import { ID_RE, devicesFromEnv } from './devices.js';
import { deviceHooks } from './device-sessions.js';
import { handleAgentApi } from './agent-api.js';
import { assertSecondFactor } from './oauth.js';
import { sessionPeople } from './session-people.js';

const ROOT = '/api/v1/w';
const PREFIX = '/api/v1/w/';
const BODY_MAX = 16384;
// Customer, site and device bodies carry up to 30 custom fields of 500 characters.
const RECORD_BODY_MAX = 32768;
const AUDIT_LIMIT_MAX = 500;
const AUDIT_LIMIT_DEFAULT = 100;

const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra } });
export const fail = (status, code, message, extra) => json({ error: { code, message } }, status, extra);
const notAllowed = (allow) => fail(405, 'method_not_allowed', `use ${allow}`, { allow });

export async function readBody(request, max = BODY_MAX) {
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > max) throw new TeamError(400, 'bad_request', 'the request body is too large');
  const text = await request.text();
  if (text.length > max) throw new TeamError(400, 'bad_request', 'the request body is too large');
  let body;
  try { body = JSON.parse(text); } catch (_) { throw new TeamError(400, 'bad_request', 'the body must be JSON'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TeamError(400, 'bad_request', 'the body must be a JSON object');
  return body;
}

function decodeSegment(s) {
  try { return decodeURIComponent(s); } catch (_) { throw new TeamError(400, 'bad_request', 'bad path'); }
}

export function intParam(url, name, def, min, max) {
  const v = url.searchParams.get(name);
  if (v === null || v === '') return def;
  if (!/^\d+$/.test(v) || Number(v) < min || Number(v) > max) throw new TeamError(400, 'bad_request', `${name} must be a whole number from ${min} to ${max}`);
  return Number(v);
}

// An id from a path or a query: 20 lowercase base32 characters. In a path any
// other value is a missing item; in a query it is a bad request. `name` is the
// query parameter, or null for a path segment. Empty or absent is null.
function idParam(url, name) {
  const v = url.searchParams.get(name);
  if (v === null || v === '') return null;
  if (!ID_RE.test(v)) throw new TeamError(400, 'bad_request', `${name} must be an id`);
  return v;
}
function itemId(segment) {
  const id = decodeSegment(segment);
  if (!ID_RE.test(id)) throw new TeamError(404, 'not_found', 'not found');
  return id;
}

// Throws 403 unless the caller holds one of `permissions`. While the workspace
// is open a caller holds only sessions.*, so `onOpen` says what an open
// workspace means for the route: 'allow' (a read open to anyone, or the add
// that the store itself limits to the first member), 'first_member' (a team
// write: 409, add yourself as the first admin), or 'deny' (403, the default).
// `app` is { env, caller } for an app caller (see handleApi): then only a real
// member passes, and a permission that needs a second factor needs the grant's.
async function needRole(team, slug, caller, permissions, onOpen = 'deny', app = null) {
  let refusal = null;
  for (const p of permissions) {
    const a = await team.authorize(slug, caller, p, { membersOnly: app !== null });
    if (a.ok) {
      if (app) await needSecondFactor(app, p);
      return;
    }
    if (a.reason === 'not_member') throw new TeamError(403, 'not_member', 'you are not a member of this team');
    if (a.reason === 'open') {
      if (onOpen === 'allow') return;
      if (onOpen === 'first_member') throw new TeamError(409, 'first_member', 'add yourself as the first admin before changing the team');
    }
    refusal = refusal || p;
  }
  throw new TeamError(403, 'permission_denied', `your role does not allow ${refusal}`);
}

// The same check MCP makes for an OAuth caller (assertSecondFactor, src/oauth.js),
// as a refusal the API can answer.
async function needSecondFactor(app, permission) {
  try {
    await assertSecondFactor(app.env, app.caller, permission);
  } catch (e) {
    throw new TeamError(403, 'second_factor', e.message);
  }
}

// What the technician app may reach, by collection (the segment after the
// workspace) and method. Anything else answers 404, as if the route did not exist.
function appAllows(collection, item, method, extra = []) {
  if (collection === undefined) return true; // who am I
  if (collection === 'sessions') return method === 'GET' && item !== undefined && extra.length === 1 && extra[0] === 'frame';
  if (collection === 'fields') return method === 'GET' && item === undefined;
  if (collection === 'agent') return item === 'tasks'; // never settings or models
  return ['customers', 'sites', 'devices', 'pairing'].includes(collection);
}

// deps: { accessCaller(request, env, url) -> identity|null, isJsonContentType(request) -> bool, origin } from app.js.
// origin is this relay's address, for the install link in a pairing answer.
// app is { caller } for a call from the technician app: the OAuth caller src/app.js
// checked. Then Access is not consulted; the caller is that person.
export async function handleApi(request, env, url, { accessCaller, isJsonContentType, origin, app = null }) {
  const method = request.method;
  if (request.headers.has('origin')) return fail(403, 'forbidden', 'cross-site requests are refused');
  if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(method)) return notAllowed('GET, POST, PATCH, DELETE');
  if (method !== 'GET' && !isJsonContentType(request)) return fail(415, 'unsupported_media_type', 'send content-type: application/json');
  const caller = app ? app.caller.email : await accessCaller(request, env, url);
  if (!caller) return fail(403, 'forbidden', 'Cloudflare Access did not admit this request');
  const appCheck = app ? { env, caller: app.caller } : null;
  const need = (team, slug, who, permissions, onOpen) => needRole(team, slug, who, permissions, onOpen, appCheck);

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
    if (app && !appAllows(collection, item, method, extra)) throw new TeamError(404, 'not_found', 'not found');
    // The built-in agent has routes more than one segment deep (src/agent-api.js).
    if (collection === 'agent') {
      const segments = url.pathname.slice(PREFIX.length).split('/').slice(2);
      return await handleAgentApi({ json, notAllowed, readBody, need, decodeSegment },
        { env, team, slug, caller, method, request, url, origin, segments, app });
    }
    // The last picture of a live session. A session id is 64 hex characters, not a 20-character item id.
    if (collection === 'sessions') {
      if (item === undefined || extra.length !== 1 || extra[0] !== 'frame') throw new TeamError(404, 'not_found', 'not found');
      const sid = decodeSegment(item);
      if (!/^[0-9a-f]{64}$/.test(sid)) throw new TeamError(404, 'not_found', 'not found');
      if (method !== 'GET') return notAllowed('GET');
      await need(team, slug, caller, ['sessions.control']);
      // The picture is the PC's screen: read on the terms a screenshot is. The app's sign-in must hold the second
      // factor of each permission the rule asks for; an Access login is exempt, as it is for every tool.
      const caps = app ? { factor: (permission) => assertSecondFactor(env, app.caller, permission) } : {};
      return json(await sessionPeople(env).frame(slug, caller, sid, caps));
    }
    if (extra.length || item === '') throw new TeamError(404, 'not_found', 'not found');

    if (collection === undefined) {
      if (method !== 'GET') return notAllowed('GET');
      // The app never uses open mode, and reading who is a member must not record it as a caller.
      if (app && !(await team.getMember(slug, caller))) throw new TeamError(403, 'not_member', 'you are not a member of this team');
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

    // Stop and resume. A stopped workspace ends every live session now and answers
    // no tool call until it is resumed. Whoever may end sessions can stop it; resuming
    // needs members.manage. Both are rows in the team log, so the state has no column
    // to tamper with. Stopping again re-ends any session the first stop missed.
    if (collection === 'stop' && item === undefined) {
      if (method === 'GET') {
        await need(team, slug, caller, ['sessions.view']);
        return json(await team.stopState(slug));
      }
      if (method === 'POST') {
        await need(team, slug, caller, ['sessions.end']);
        const state = await team.stopWorkspace(slug, caller);
        return json({ ...state, sessions_ended: await deviceHooks(env).stopAll(slug, caller) });
      }
      if (method === 'DELETE') {
        await need(team, slug, caller, ['members.manage'], 'first_member');
        return json(await team.resumeWorkspace(slug, caller));
      }
      return notAllowed('GET, POST, DELETE');
    }

    // Customers, sites, saved PCs, custom fields and pairing codes. Reading takes
    // devices.view, changing takes devices.manage (custom field definitions take
    // fields.manage). Lists page by id: ?after=<id>&limit=. A record in another
    // workspace is 404, as if it were missing.
    const devs = devicesFromEnv(env, team);
    // Lists page like the log, with the same bounds.
    const page = () => ({ after: idParam(url, 'after') ?? '', limit: intParam(url, 'limit', AUDIT_LIMIT_DEFAULT, 1, AUDIT_LIMIT_MAX) });
    const entity = collection === 'customers' ? 'customer' : collection === 'sites' ? 'site' : null;
    if (entity) {
      if (item === undefined) {
        if (method === 'GET') {
          await need(team, slug, caller, ['devices.view']);
          return json(await devs.listRecords(entity, slug, { ...page(), filter: entity === 'site' ? idParam(url, 'customer') : null }));
        }
        if (method === 'POST') {
          await need(team, slug, caller, ['devices.manage'], 'first_member');
          return json({ [entity]: await devs.addRecord(entity, slug, caller, await readBody(request, RECORD_BODY_MAX)) }, 201);
        }
        return notAllowed('GET, POST');
      }
      const id = itemId(item);
      if (method === 'GET') {
        await need(team, slug, caller, ['devices.view']);
        return json({ [entity]: await devs.getRecord(entity, slug, id) });
      }
      if (method === 'PATCH') {
        await need(team, slug, caller, ['devices.manage'], 'first_member');
        return json({ [entity]: await devs.updateRecord(entity, slug, caller, id, await readBody(request, RECORD_BODY_MAX)) });
      }
      if (method === 'DELETE') {
        await need(team, slug, caller, ['devices.manage'], 'first_member');
        return json({ removed: await devs.removeRecord(entity, slug, caller, id) });
      }
      return notAllowed('GET, PATCH, DELETE');
    }

    if (collection === 'devices') {
      if (item === undefined) {
        if (method !== 'GET') return notAllowed('GET');
        await need(team, slug, caller, ['devices.view']);
        const status = url.searchParams.get('status') || null;
        if (status !== null && status !== 'pending' && status !== 'active') throw new TeamError(400, 'bad_request', 'status must be pending or active');
        return json(await devs.listDevices(slug, { ...page(), site: idParam(url, 'site'), status }));
      }
      const id = itemId(item);
      if (method === 'GET') {
        await need(team, slug, caller, ['devices.view']);
        return json({ device: await devs.getDevice(slug, id) });
      }
      if (method === 'PATCH') {
        await need(team, slug, caller, ['devices.manage'], 'first_member');
        return json({ device: await devs.updateDevice(slug, caller, id, await readBody(request, RECORD_BODY_MAX)) });
      }
      if (method === 'DELETE') {
        await need(team, slug, caller, ['devices.manage'], 'first_member');
        return json({ removed: await devs.removeDevice(slug, caller, id) });
      }
      return notAllowed('GET, PATCH, DELETE');
    }

    if (collection === 'fields') {
      if (item === undefined) {
        if (method === 'GET') {
          await need(team, slug, caller, ['devices.view']);
          return json({ fields: await devs.listFields(slug) });
        }
        if (method === 'POST') {
          await need(team, slug, caller, ['fields.manage'], 'first_member');
          return json({ field: await devs.addField(slug, caller, await readBody(request)) }, 201);
        }
        return notAllowed('GET, POST');
      }
      const id = itemId(item);
      if (method === 'PATCH') {
        await need(team, slug, caller, ['fields.manage'], 'first_member');
        return json({ field: await devs.updateField(slug, caller, id, await readBody(request)) });
      }
      if (method === 'DELETE') {
        await need(team, slug, caller, ['fields.manage'], 'first_member');
        return json({ removed: await devs.removeField(slug, caller, id) });
      }
      return notAllowed('PATCH, DELETE');
    }

    // A pairing code is shown once, in the 201 answer, and never again. The
    // answer also carries the install link with that code, ready to send.
    if (collection === 'pairing') {
      if (item === undefined) {
        if (method === 'GET') {
          await need(team, slug, caller, ['devices.manage']);
          return json({ pairings: await devs.listPairingCodes(slug) });
        }
        if (method === 'POST') {
          await need(team, slug, caller, ['devices.manage'], 'first_member');
          const pairing = await devs.createPairingCode(slug, caller, await readBody(request));
          return json({ pairing: { ...pairing, link: `${origin}/install?code=${pairing.code}` } }, 201);
        }
        return notAllowed('GET, POST');
      }
      if (method !== 'DELETE') return notAllowed('DELETE');
      const id = itemId(item);
      await need(team, slug, caller, ['devices.manage'], 'first_member');
      return json({ removed: await devs.revokePairingCode(slug, caller, id) });
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
