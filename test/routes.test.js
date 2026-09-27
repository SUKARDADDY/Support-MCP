// Route-level tests: drive the real router (src/app.js) with Request objects.
// The env has no DO bindings that do anything useful: every path tested here
// must answer before touching a Durable Object (a touch throws and fails).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../src/app.js';

const handler = createHandler("$Sid = '{{SID}}'\n$Key = '{{KEY}}'\n$Origin = '{{ORIGIN}}'\n$AgentB64 = '{{AGENT_B64}}'\n");

const trap = () => {
  throw new Error('Durable Object touched');
};
const env = {
  ACCESS_TEAM_DOMAIN: 'example-team.cloudflareaccess.com',
  ACCESS_AUD: 'aud',
  SESSION: { idFromName: trap, idFromString: trap, get: trap },
  REGISTRY: { idFromName: trap, get: trap },
};
const PROD = 'https://support.example.com';
const rpc = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

test('POST /mcp on the deployed host without a JWT => 403', async () => {
  const r = await handler.fetch(
    new Request(`${PROD}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: rpc }),
    env,
  );
  assert.equal(r.status, 403);
});

test('POST /mcp with a malformed JWT => 403 (no network needed)', async () => {
  const r = await handler.fetch(
    new Request(`${PROD}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-access-jwt-assertion': 'not.a.jwt' },
      body: rpc,
    }),
    env,
  );
  assert.equal(r.status, 403);
});

test('POST /mcp with an Origin header => 403, even under the localhost bypass', async () => {
  for (const [base, e] of [[PROD, env], ['http://127.0.0.1:8787', { ...env, DEV_SKIP_ACCESS: '1' }]]) {
    const r = await handler.fetch(
      new Request(`${base}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
        body: rpc,
      }),
      e,
    );
    assert.equal(r.status, 403, base);
  }
});

test('POST /mcp with a non-JSON content type => 415', async () => {
  for (const ct of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', null]) {
    const headers = ct ? { 'content-type': ct } : {};
    const r = await handler.fetch(new Request(`${PROD}/mcp`, { method: 'POST', headers, body: rpc }), env);
    // Request() defaults a string body to text/plain when no type is given
    assert.equal(r.status, 415, String(ct));
  }
});

test('localhost bypass: JSON POST reaches the MCP handler (tools/list)', async () => {
  const r = await handler.fetch(
    new Request('http://127.0.0.1:8787/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: rpc,
    }),
    { ...env, DEV_SKIP_ACCESS: '1' },
  );
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.result.tools.length, 7);
});

test('GET /mcp => 405', async () => {
  const r = await handler.fetch(new Request(`${PROD}/mcp`), env);
  assert.equal(r.status, 405);
});

test('/j with a non-GET method => 405 and the code is not consumed', async () => {
  for (const method of ['HEAD', 'POST', 'PUT', 'DELETE']) {
    const r = await handler.fetch(new Request(`${PROD}/j/abcdefghijklmnop`, { method }), env);
    assert.equal(r.status, 405, method);
    assert.equal(r.headers.get('allow'), 'GET');
  }
});

test('/j with malformed percent-encoding => harmless 404 script, not 500', async () => {
  const r = await handler.fetch(new Request(`${PROD}/j/%E0%A4%A`), env);
  assert.equal(r.status, 404);
  assert.match(await r.text(), /^Write-Host 'This support link is invalid or expired\.'/);
});

test('/ws with the key in the query string => 401', async () => {
  const sid = 'a'.repeat(64);
  const r = await handler.fetch(new Request(`${PROD}/ws?sid=${sid}&key=${'b'.repeat(64)}`), env);
  assert.equal(r.status, 401);
});

test('/healthz stays public', async () => {
  const r = await handler.fetch(new Request(`${PROD}/healthz`), env);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, service: 'support-mcp', stage: 'relay-v1' });
});
