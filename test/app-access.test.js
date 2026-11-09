// The technician app's way in: its own OAuth grant for /app/w/<slug>, and the
// gate on every /app route. The real OAuth library and the real router, with an
// in-memory KV and D1. A scripted app signs in as the Rust core does: a public
// client, a loopback address, PKCE, and a browser that approves on the consent page.
//
// The library imports `cloudflare:workers`; `npm test` preloads a stand-in. Run
// bare, `node --test` skips this file with a message instead of failing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appWorld, skip, BOSS, TECH, VIEW, HOST, JSON_HEADERS, unesc } from './app-world.js';
import { oai } from './agent-fakes.js';
import { appResourceUrl, challengeHeader, resourceTarget, resourceUrl, workspaceForAppResource } from '../src/oauth.js';

const it = (name, fn) => test(name, { skip }, fn);
const challenge = (workspace, invalid) => challengeHeader(HOST, workspace, { invalid, app: true });

// ---- the grant ---------------------------------------------------------------------------
it('small helpers: the app address of a workspace, default included', () => {
  assert.equal(appResourceUrl(HOST, 'default'), `${HOST}/app/w/default`);
  assert.equal(appResourceUrl(HOST, 'acme'), `${HOST}/app/w/acme`);
  assert.equal(workspaceForAppResource(HOST, `${HOST}/app/w/default`), 'default');
  assert.equal(workspaceForAppResource(HOST, `${HOST}/app/w/acme`), 'acme');
  for (const bad of [`${HOST}/app/w/ACME`, `${HOST}/app/w/acme/api`, `${HOST}/app/acme`, `${HOST}/mcp`, 'https://other.example/app/w/acme', undefined, 7]) {
    assert.equal(workspaceForAppResource(HOST, bad), null, String(bad));
  }
  assert.deepEqual(resourceTarget(HOST, `${HOST}/app/w/acme`), { workspace: 'acme', app: true });
  assert.deepEqual(resourceTarget(HOST, `${HOST}/w/acme/mcp`), { workspace: 'acme', app: false });
  assert.deepEqual(resourceTarget(HOST, `${HOST}/mcp`), { workspace: 'default', app: false });
  assert.equal(resourceTarget(HOST, `${HOST}/app/w/acme/mcp`), null);
  assert.equal(challenge('acme', true), `Bearer resource_metadata="${HOST}/.well-known/oauth-protected-resource/app/w/acme", error="invalid_token"`);
});

it('the app signs in with the real library: a public client on a loopback port, then its token works on /app and not on /mcp', async (t) => {
  const w = await appWorld(t);
  const app = await w.connect(TECH, { app: true });
  assert.equal(app.status, 200, 'the consent page opened');
  assert.equal(app.tokens.status, 200, JSON.stringify(app.tokens.body));
  assert.ok(app.back.href.startsWith('http://127.0.0.1:53122/callback?'), 'the code returned to the app on its port');
  assert.ok(app.refresh, 'a refresh token came with it');

  // The MCP tools over the app's address.
  const listed = await w.appTool(app.access, 'session_list');
  assert.equal(listed.status, 200);
  assert.ok(Array.isArray(listed.sessions));
  // The app's token is no MCP token.
  assert.equal((await w.appTool(app.access, 'session_list', {}, { base: '/mcp' })).status, 401);
  assert.equal((await w.appTool(app.access, 'session_list', {}, { base: '/w/acme/mcp' })).status, 401);

  // An MCP client's token is no app token, though it is the same person in the same team.
  const mcp = await w.connect(TECH, { app: false });
  assert.equal(mcp.tokens.status, 200);
  assert.equal((await w.appTool(mcp.access, 'session_list', {}, { base: '/mcp' })).status, 200);
  const refused = await w.appTool(mcp.access, 'session_list');
  assert.equal(refused.status, 401);
  const r = await w.appCall(mcp.access, 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(r.status, 401);
  assert.equal(r.headers.get('www-authenticate'), challenge('default', true));
});

it('an app token is for one workspace: it works only on its own team address', async (t) => {
  const w = await appWorld(t);
  w.db.sqlite.prepare("INSERT INTO workspaces(slug, name, created_by, created_at) VALUES ('acme', 'Acme Support', ?, 1)").run(BOSS);
  w.db.sqlite.prepare("INSERT INTO members(workspace, identity, kind, name, role_id, added_at, added_by) VALUES ('acme', ?, 'person', NULL, 'technician', 1, 'test')").run(TECH);
  const acme = await w.connect(TECH, { app: true, workspace: 'acme' });
  assert.equal(acme.status, 200);
  assert.equal(acme.tokens.status, 200, JSON.stringify(acme.tokens.body));
  assert.equal((await w.appTool(acme.access, 'session_list', {}, { base: '/app/w/acme/mcp' })).status, 200);
  assert.equal((await w.appTool(acme.access, 'session_list', {}, { base: '/app/w/default/mcp' })).status, 401, 'the default team is another address');
  const home = await w.connect(TECH, { app: true, workspace: 'default' });
  assert.equal((await w.appTool(home.access, 'session_list', {}, { base: '/app/w/acme/mcp' })).status, 401);
});

it('the consent page for the app says what it can do, in the plan\'s words', async (t) => {
  const w = await appWorld(t);
  const app = await w.connect(TECH, { app: true });
  const text = unesc(app.html);
  assert.ok(text.includes("Support technician app: works as you in Default, including seeing PCs and their screens, pairing and approving PCs, changing how they can be reached, and starting agent tasks. It can't change members, roles or agent keys. Only approve this if you just started signing in from the app."), text);
  assert.ok(!text.includes('Run commands, move files'), 'not the MCP list of abilities');
  const mcp = await w.connect(TECH, { app: false });
  assert.ok(unesc(mcp.html).includes('Run commands, move files and control the screen'), 'an MCP client still sees its abilities');
  assert.ok(!unesc(mcp.html).includes('works as you in'));
});

it('the app refreshes its token with or without naming the resource, and a refresh keeps the app address', async (t) => {
  const w = await appWorld(t);
  const app = await w.connect(TECH, { app: true, withResource: false });
  assert.equal(app.tokens.status, 200, `the code exchange needs no resource: ${JSON.stringify(app.tokens.body)}`);
  assert.equal((await w.appTool(app.access, 'session_list')).status, 200);
  for (const withResource of [false, true]) {
    const refreshed = await w.tokenRequest({
      grant_type: 'refresh_token', refresh_token: app.refresh, client_id: app.clientId, ...(withResource ? { resource: app.resource } : {}),
    });
    assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
    assert.equal((await w.appTool(refreshed.body.access_token, 'session_list')).status, 200);
    assert.equal((await w.appTool(refreshed.body.access_token, 'session_list', {}, { base: '/mcp' })).status, 401);
    app.refresh = refreshed.body.refresh_token;
  }
  // Naming another address than the grant's is refused.
  const wrong = await w.tokenRequest({ grant_type: 'refresh_token', refresh_token: app.refresh, client_id: app.clientId, resource: resourceUrl(HOST, 'default') });
  assert.equal(wrong.status, 400);
});

it('discovery names the app address: a resource document per workspace, and a 404 for one that does not exist', async (t) => {
  const w = await appWorld(t);
  const doc = await w.send('/.well-known/oauth-protected-resource/app/w/default');
  assert.equal(doc.status, 200);
  const body = await doc.json();
  assert.equal(body.resource, `${HOST}/app/w/default`);
  assert.deepEqual(body.authorization_servers, [HOST]);
  assert.equal((await w.send('/.well-known/oauth-protected-resource/app/w/nowhere')).status, 404);
  // The document of an MCP address is as before.
  assert.equal((await (await w.send('/.well-known/oauth-protected-resource/mcp')).json()).resource, `${HOST}/mcp`);
  // The authorization server document still lists no resources.
  const as = await (await w.send('/.well-known/oauth-authorization-server')).json();
  assert.equal(as.protected_resources, undefined);
});

// ---- the gate on /app ------------------------------------------------------------------------
it('every /app route answers 401 with a challenge for the app address when there is no valid bearer', async (t) => {
  const w = await appWorld(t);
  const app = await w.connect(TECH, { app: true });
  for (const [method, path] of [['POST', '/mcp'], ['GET', '/api'], ['GET', '/teams'], ['GET', '/notifications'], ['GET', '/nowhere']]) {
    const none = await w.appCall(null, method, path, method === 'POST' ? {} : undefined);
    assert.equal(none.status, 401, `${method} ${path} without a credential`);
    assert.equal(none.headers.get('www-authenticate'), challenge('default', false));
    const junk = await w.appCall('not-a-token', method, path, method === 'POST' ? {} : undefined);
    assert.equal(junk.status, 401, `${method} ${path} with junk`);
    assert.equal(junk.headers.get('www-authenticate'), challenge('default', true));
  }
  // An Access login is no credential here, even a good one.
  const jwtHeaders = { 'cf-access-jwt-assertion': 'x', authorization: '' };
  const viaAccess = await w.send('/app/w/default/mcp', { method: 'POST', headers: { ...JSON_HEADERS, ...jwtHeaders }, body: '{}' });
  assert.equal(viaAccess.status, 401);
  // A signed-in browser cookie is no credential either.
  const b = await w.browser(TECH, { factor: true });
  assert.equal((await b.fetch('/app/w/default/teams')).status, 401);
  assert.ok(app.access);
});

it('every /app route refuses an Origin header and a write that is not JSON, before it looks at the token', async (t) => {
  const w = await appWorld(t);
  const app = await w.connect(TECH, { app: true });
  const withOrigin = await w.appCall(app.access, 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { headers: { origin: 'https://evil.example' } });
  assert.equal(withOrigin.status, 403);
  assert.equal(withOrigin.body.error.code, 'forbidden');
  assert.equal((await w.appCall(null, 'GET', '/teams', undefined, { headers: { origin: HOST } })).status, 403, 'an Origin is refused even with no token');
  const form = await w.send('/app/w/default/mcp', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Bearer ${app.access}` }, body: 'a=b' });
  assert.equal(form.status, 415);
  const plain = await w.send('/app/w/default/mcp', { method: 'POST', headers: { authorization: `Bearer ${app.access}` }, body: '{}' });
  assert.equal(plain.status, 415);
  const del = await w.send('/app/w/default/api/devices/x', { method: 'DELETE', headers: { authorization: `Bearer ${app.access}` } });
  assert.equal(del.status, 415, 'a DELETE needs the JSON header too');
  assert.equal((await w.send('/app/w/default/mcp', { method: 'PUT', headers: { ...JSON_HEADERS, authorization: `Bearer ${app.access}` }, body: '{}' })).status, 405);
  assert.equal((await w.appCall(app.access, 'GET', '/mcp')).status, 405, 'the tools take POST');
  assert.equal((await w.appCall(app.access, 'GET', '/nowhere')).status, 404);
});

it('a checked app token is remembered for 60 seconds and then checked again', async (t) => {
  const w = await appWorld(t);
  const app = await w.connect(TECH, { app: true });
  assert.equal((await w.appTool(app.access, 'session_list')).status, 200);
  const reads = w.kv.reads;
  for (let i = 0; i < 5; i++) assert.equal((await w.appTool(app.access, 'session_list')).status, 200);
  assert.equal(w.kv.reads, reads, 'five more calls read no KV');
  w.advance(59_000);
  assert.equal((await w.appTool(app.access, 'session_list')).status, 200);
  assert.equal(w.kv.reads, reads, 'still remembered at 59 seconds');
  w.advance(2_000);
  assert.equal((await w.appTool(app.access, 'session_list')).status, 200);
  assert.ok(w.kv.reads > reads, 'checked again after a minute');
  // The cache is for the app's address only: an MCP token is read from KV every time.
  const mcp = await w.connect(TECH, { app: false });
  const before = w.kv.reads;
  await w.appTool(mcp.access, 'session_list', {}, { base: '/mcp' });
  await w.appTool(mcp.access, 'session_list', {}, { base: '/mcp' });
  assert.ok(w.kv.reads >= before + 2, 'MCP tokens are not remembered');
  // A token stays bound to its address through the cache.
  assert.equal((await w.appTool(app.access, 'session_list', {}, { base: '/app/w/acme/mcp' })).status, 401);
});

it('an app token stops working at the next call once its person is removed from every team', async (t) => {
  const w = await appWorld(t);
  const app = await w.connect(VIEW, { app: true, factor: false });
  assert.equal(app.tokens.status, 200, JSON.stringify(app.tokens.body));
  assert.equal((await w.appTool(app.access, 'session_list')).status, 200);
  await w.team.removeMember('default', BOSS, VIEW);
  const after = await w.appTool(app.access, 'session_list');
  assert.equal(after.status, 200);
  assert.match(after.error, /not a member/);
});

// ---- time to build the OAuth server ----------------------------------------------------------
// The library checks its list of addresses pairwise, so a server for 500 workspaces
// takes about 220 ms to build and 1,000 addresses about 900 ms. The app's address is
// never added to that list: a request for it gets a server that declares only it.
it('500 workspaces: an app authorize or token request builds its own small server, well under 400 ms', async (t) => {
  const w = await appWorld(t);
  const insert = w.db.sqlite.prepare("INSERT INTO workspaces(slug, name, created_by, created_at) VALUES (?, ?, 'root', 1)");
  for (let i = 0; i < 500; i++) insert.run(`team-${String(i).padStart(3, '0')}`, `Team ${i}`);
  assert.equal(w.sql('SELECT COUNT(*) AS n FROM workspaces')[0].n, 500);

  // The first request on a fresh relay: nothing is warm.
  const clientId = await w.register();
  const b = await w.browser(TECH, { factor: true });
  const challengeValue = 'a'.repeat(43);
  const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: 'http://127.0.0.1:53122/callback', state: 's', code_challenge: challengeValue, code_challenge_method: 'S256', resource: appResourceUrl(HOST, 'default') });
  let t0 = performance.now();
  const page = await b.fetch(`/oauth/authorize?${q}`);
  const authorizeMs = performance.now() - t0;
  assert.equal(page.status, 200);
  assert.ok(authorizeMs < 400, `authorize took ${authorizeMs.toFixed(0)} ms`);

  t0 = performance.now();
  const refused = await w.tokenRequest({ grant_type: 'authorization_code', code: 'x', client_id: clientId, redirect_uri: 'http://127.0.0.1:53122/callback', resource: appResourceUrl(HOST, 'default') });
  const tokenMs = performance.now() - t0;
  assert.equal(refused.status, 400);
  assert.ok(tokenMs < 400, `token took ${tokenMs.toFixed(0)} ms`);

  // And a whole sign-in for the app, then a call with its token, with the 500 in place.
  const app = await w.connect(TECH, { app: true });
  assert.equal(app.tokens.status, 200);
  t0 = performance.now();
  assert.equal((await w.appTool(app.access, 'session_list')).status, 200);
  assert.ok(performance.now() - t0 < 400, 'checking the token');
});

// ---- the team API behind the app -------------------------------------------------------------------
const shotCall = () => oai.call('screenshot', { display: null });
const finish = (summary = 'ok') => oai.call('finish', { outcome: 'done', summary });
const code = (r) => r.body && r.body.error && r.body.error.code;

it('the app reaches the team API under /app/w/<team>/api with its own token, and /api/v1 still takes only Access', async (t) => {
  const w = await appWorld(t);
  const pc = await w.addPc({ name: 'Till' });
  const app = await w.connect(TECH, { app: true });
  const me = await w.appCall(app.access, 'GET', '/api');
  assert.equal(me.status, 200);
  assert.deepEqual([me.body.workspace, me.body.me.identity, me.body.me.role_id], [{ slug: 'default', open: false }, TECH, 'technician']);
  const list = await w.appCall(app.access, 'GET', '/api/devices');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.devices.map((d) => d.id), [pc.id]);
  assert.equal((await w.appCall(app.access, 'GET', `/api/devices/${pc.id}`)).body.device.name, 'Till');
  assert.equal((await w.appCall(app.access, 'GET', '/api/customers')).status, 200);
  assert.equal((await w.appCall(app.access, 'GET', '/api/sites')).status, 200);
  assert.equal((await w.appCall(app.access, 'GET', '/api/fields')).status, 200);
  assert.equal((await w.appCall(app.access, 'GET', '/api/pairing')).status, 200);
  assert.equal((await w.appCall(app.access, 'GET', '/api/agent/tasks')).status, 200);
  // A paged list keeps its query through the rewrite.
  assert.equal((await w.appCall(app.access, 'GET', '/api/devices?status=pending')).body.devices.length, 0);
  assert.equal((await w.appCall(app.access, 'GET', '/api/devices?status=nope')).status, 400);
  // The Access-only team API takes no bearer, an app token included.
  const old = await w.send('/api/v1/w/default/devices', { headers: { authorization: `Bearer ${app.access}` } });
  assert.equal(old.status, 403);
  assert.equal((await w.send('/api/v1/w', { headers: { authorization: `Bearer ${app.access}` } })).status, 403);
});

it('the app\'s team API is an allowlist: members, roles, the log, stop, and the agent\'s settings and models answer 404, even for an admin', async (t) => {
  const w = await appWorld(t);
  const admin = await w.connect(BOSS, { app: true });
  assert.equal(admin.tokens.status, 200);
  assert.equal((await w.appCall(admin.access, 'GET', '/api')).body.me.role_id, 'admin');
  const gone = [
    ['GET', '/api/members'], ['POST', '/api/members', { identity: 'x@example.com', role_id: 'viewer' }], ['PATCH', `/api/members/${TECH}`, { role_id: 'viewer' }], ['DELETE', `/api/members/${TECH}`],
    ['GET', '/api/roles'], ['POST', '/api/roles', { id: 'x', permissions: [] }], ['DELETE', '/api/roles/viewer'],
    ['GET', '/api/audit'], ['GET', '/api/stop'], ['POST', '/api/stop', {}], ['DELETE', '/api/stop'],
    ['GET', '/api/agent'], ['PATCH', '/api/agent', { mode: 'agent' }], ['POST', '/api/agent/models', { provider: 'openai', id: 'gpt-x' }], ['DELETE', '/api/agent/models/openai/gpt-x'],
    ['POST', '/api/fields', { entity: 'device', label: 'x' }], ['PATCH', '/api/fields/aaaaaaaaaaaaaaaaaaaa', { label: 'x' }], ['DELETE', '/api/fields/aaaaaaaaaaaaaaaaaaaa'],
    ['GET', '/api/nowhere'],
  ];
  for (const [method, path, body] of gone) {
    const r = await w.appCall(admin.access, method, path, body ?? (method === 'GET' ? undefined : {}));
    assert.equal(r.status, 404, `${method} ${path}`);
    assert.equal(code(r), 'not_found', `${method} ${path}`);
  }
  assert.equal(w.sql("SELECT COUNT(*) AS n FROM members WHERE workspace = 'default'")[0].n, 4, 'nobody was added or removed');
  assert.equal(w.sql('SELECT COUNT(*) AS n FROM agent_settings')[0].n, 0, 'the agent\'s settings were not touched');
  assert.equal((await w.appCall(admin.access, 'GET', '/api/agent/tasks')).status, 200, 'the tasks routes are open');
});

it('/app/w/<team>/teams lists the person\'s teams, and the app never serves a person who is not a member of this one', async (t) => {
  const w = await appWorld(t);
  w.db.sqlite.prepare("INSERT INTO workspaces(slug, name, created_by, created_at) VALUES ('acme', 'Acme Support', ?, 1)").run(BOSS);
  w.db.sqlite.prepare("INSERT INTO members(workspace, identity, kind, name, role_id, added_at, added_by) VALUES ('acme', ?, 'person', NULL, 'viewer', 1, 'test')").run(TECH);
  const app = await w.connect(TECH, { app: true });
  const teams = await w.appCall(app.access, 'GET', '/teams');
  assert.equal(teams.status, 200);
  assert.deepEqual(teams.body, { teams: [{ slug: 'acme', name: 'Acme Support' }, { slug: 'default', name: 'Default' }] });
  assert.equal((await w.appCall(app.access, 'POST', '/teams', {})).status, 405);
  // Left this team: the token stops working here (403), while the account may live on in another.
  w.db.sqlite.prepare("DELETE FROM members WHERE workspace = 'default' AND identity = ?").run(TECH);
  for (const path of ['/teams', '/api', '/api/devices']) {
    const r = await w.appCall(app.access, 'GET', path);
    assert.equal(r.status, 403, path);
    assert.equal(code(r), 'not_member', path);
  }
});

it('the app is for members only: no sign-in in an open team, and a team that becomes open serves nobody', async (t) => {
  const open = await appWorld(t, { members: false });
  const none = await open.connect(TECH, { app: true, factor: false });
  assert.notEqual(none.status, 200, 'no consent page: the team has no members');
  assert.equal(none.access, undefined);

  const w = await appWorld(t);
  const app = await w.connect(TECH, { app: true });
  assert.equal((await w.appCall(app.access, 'GET', '/api/devices')).status, 200);
  w.db.sqlite.prepare("DELETE FROM members WHERE workspace = 'default'").run();
  for (const path of ['/api', '/api/devices', '/api/agent/tasks', '/teams']) {
    const r = await w.appCall(app.access, 'GET', path);
    assert.equal(r.status, 403, path);
    assert.equal(code(r), 'not_member', path);
  }
  assert.equal(w.sql('SELECT COUNT(*) AS n FROM callers')[0].n, 0, 'open mode did not record the app caller');
});

it('the second factor: pairing, starting a task and stopping one are refused through /app once the grant\'s authenticator is gone, and reads still work', async (t) => {
  const w = await appWorld(t);
  await w.ready();
  const pc = await w.addPc({ access: 'any' });
  const mine = await w.startOnPc(BOSS, {}, { pc });
  const app = await w.connect(TECH, { app: true, factor: true });

  // With the authenticator in place the same calls work.
  const paired = await w.appCall(app.access, 'POST', '/api/pairing', {});
  assert.equal(paired.status, 201, JSON.stringify(paired.body));
  assert.match(paired.body.pairing.link, /\/install\?code=/);

  w.loseFactor(app.userId);
  const refused = [
    ['POST', '/api/pairing', {}],
    ['DELETE', `/api/pairing/${paired.body.pairing.id}`, {}],
    ['PATCH', `/api/devices/${pc.id}`, { name: 'Renamed' }],
    ['DELETE', `/api/devices/${pc.id}`, {}],
    ['POST', '/api/customers', { name: 'Acme' }],
    ['POST', '/api/agent/tasks', { device_id: pc.id, instructions: 'fix it' }],
    ['POST', `/api/agent/tasks/${mine.id}/stop`, {}],
    ['POST', `/api/agent/tasks/${mine.id}/pause`, {}],
  ];
  for (const [method, path, body] of refused) {
    const r = await w.appCall(app.access, method, path, body);
    assert.equal(r.status, 403, `${method} ${path}`);
    assert.equal(code(r), 'second_factor', `${method} ${path}: ${JSON.stringify(r.body)}`);
  }
  assert.equal(w.taskRow(mine.id).state, 'running', 'the task was not stopped');
  assert.equal(w.sql('SELECT COUNT(*) AS n FROM agent_tasks')[0].n, 1, 'no task was started');
  assert.equal(w.sql('SELECT name FROM devices WHERE id = ?', pc.id)[0].name, 'Till');
  // What needs no second factor still works.
  for (const path of ['/api', '/api/devices', '/api/customers', '/api/agent/tasks', `/api/agent/tasks/${mine.id}`]) {
    assert.equal((await w.appCall(app.access, 'GET', path)).status, 200, path);
  }
  // The MCP tools over the app's address are held to the same rule.
  assert.match((await w.appTool(app.access, 'agent_start', { device_id: pc.id, instructions: 'x' })).error, /second factor is required/);
});

it('a Viewer is refused every change through /app, with the role and not the factor as the reason', async (t) => {
  const w = await appWorld(t);
  await w.ready();
  const pc = await w.addPc({ access: 'any' });
  const app = await w.connect(VIEW, { app: true, factor: false });
  assert.equal(app.tokens.status, 200);
  for (const [method, path, body] of [
    ['POST', '/api/pairing', {}], ['PATCH', `/api/devices/${pc.id}`, { name: 'x' }], ['POST', '/api/agent/tasks', { device_id: pc.id, instructions: 'x' }],
  ]) {
    const r = await w.appCall(app.access, method, path, body);
    assert.equal(r.status, 403, `${method} ${path}`);
    assert.equal(code(r), 'permission_denied', `${method} ${path}`);
  }
  assert.equal((await w.appCall(app.access, 'GET', '/api/devices')).status, 200);
  assert.equal((await w.appCall(app.access, 'GET', '/api/agent/tasks')).status, 200);
});

it('a task started through /app is the app caller\'s: it records the person, and stops when they lose the role or their account', async (t) => {
  const w = await appWorld(t);
  await w.ready();
  const app = await w.connect(TECH, { app: true, factor: true });
  const start = async (pc) => {
    const r = await w.appCall(app.access, 'POST', '/api/agent/tasks', { device_id: pc.id, instructions: 'The printer stopped printing.', keep_working: true });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await w.alarm(r.body.task_id); // connect
    await w.joinPc(pc);
    return r.body.task_id;
  };
  const a = await start(await w.addPc({ access: 'any', name: 'One' }));
  assert.equal(w.taskRow(a).started_by, TECH);
  assert.equal(w.taskRow(a).started_by_user, app.userId, 'the person is recorded');
  assert.equal(w.taskObject(a).ctx.values.get('cfg').user.userId, app.userId);

  // Removed from the team: the next step ends the task.
  w.fake.queue('openai', shotCall());
  await w.alarm(a);
  await w.team.removeMember('default', BOSS, TECH);
  await w.drive(a);
  assert.equal(w.taskRow(a).state, 'stopped');
  assert.match(w.taskRow(a).end_reason, /not a member/);

  // A disabled account, though still a member: an Access-started task would not notice, an app task does.
  await w.team.addMember('default', BOSS, { identity: TECH, role_id: 'technician' });
  const b = await start(await w.addPc({ access: 'any', name: 'Two' }));
  w.db.sqlite.prepare('UPDATE users SET disabled_at = ? WHERE id = ?').run(Date.now(), app.userId);
  w.fake.queue('openai', shotCall(), finish());
  await w.drive(b);
  assert.equal(w.taskRow(b).state, 'stopped');
  assert.match(w.taskRow(b).end_reason, /not a member/);
});
