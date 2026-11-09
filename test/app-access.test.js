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
