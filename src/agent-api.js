// The built-in agent's routes of the team API, under /api/v1/w/<slug>/agent. The
// caller has passed the Access gate in src/api.js. Settings, keys and models need
// members.manage. Starting, reading and controlling tasks need real membership
// (never open mode) with sessions.control, or sessions.view to read. Team settings
// are never an MCP tool: these routes are the only way to change them.
import { TeamError } from './workspace.js';
import { PROVIDERS } from './agent-models.js';
import { agentService } from './agent.js';

const TASK_BODY_MAX = 8192;

// h: { json, fail, notAllowed, readBody, need, decodeSegment } from src/api.js.
// segments: what follows /agent in the path.
export async function handleAgentApi(h, { env, team, slug, caller, method, request, url, origin, segments }) {
  const { json, notAllowed, readBody, need, decodeSegment } = h;
  const agent = agentService(env, { origin });
  const [part, a, b, ...rest] = segments;
  if (rest.length || part === '') throw new TeamError(404, 'not_found', 'not found');

  if (part === undefined) {
    if (method === 'GET') {
      await need(team, slug, caller, ['members.manage']);
      return json({ agent: await agent.settings(slug) });
    }
    if (method === 'PATCH') {
      await need(team, slug, caller, ['members.manage'], 'first_member');
      return json({ agent: await agent.patch(slug, caller, await readBody(request)) });
    }
    return notAllowed('GET, PATCH');
  }

  if (part === 'models') {
    if (a === undefined) {
      if (method !== 'POST') return notAllowed('POST');
      await need(team, slug, caller, ['members.manage'], 'first_member');
      return json(await agent.addModel(slug, caller, await readBody(request)), 201);
    }
    // /models/<provider>/<id>
    if (b === undefined || rest.length) throw new TeamError(404, 'not_found', 'not found');
    if (method !== 'DELETE') return notAllowed('DELETE');
    const provider = decodeSegment(a);
    if (!PROVIDERS.includes(provider)) throw new TeamError(404, 'not_found', 'not found');
    await need(team, slug, caller, ['members.manage'], 'first_member');
    return json(await agent.removeModel(slug, caller, provider, decodeSegment(b)));
  }

  if (part === 'tasks') {
    if (a === undefined) {
      if (method === 'GET') {
        await agent.member(slug, caller, 'sessions.view');
        return json(await agent.list(slug));
      }
      if (method === 'POST') {
        const body = await readBody(request, TASK_BODY_MAX);
        return json(await agent.start(slug, caller, body, null), 201);
      }
      return notAllowed('GET, POST');
    }
    const id = decodeSegment(a);
    if (b === undefined) {
      if (method !== 'GET') return notAllowed('GET');
      await agent.member(slug, caller, 'sessions.view');
      const wait = url.searchParams.get('wait_s');
      return json(await agent.status(slug, { task_id: id, ...(wait === null || wait === '' ? {} : { wait_s: /^\d+$/.test(wait) ? Number(wait) : -1 }) }));
    }
    if (!['pause', 'resume', 'stop'].includes(b)) throw new TeamError(404, 'not_found', 'not found');
    if (method !== 'POST') return notAllowed('POST');
    await agent.member(slug, caller, 'sessions.control');
    return json(await agent.control(slug, caller, { task_id: id, action: b }));
  }

  throw new TeamError(404, 'not_found', 'not found');
}
