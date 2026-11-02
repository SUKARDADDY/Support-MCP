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
  assert.equal(body.result.tools.length, 14);
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

// A Session binding that records every touch and answers /consume.
const SID = 'c'.repeat(64);
const KEY = 'd'.repeat(64);
const CODE = 'abcdefghijklmnop';
function consumableEnv() {
  const calls = [];
  return {
    calls,
    env: {
      ...env,
      SESSION: {
        idFromName: (name) => {
          calls.push(`idFromName ${name}`);
          return { toString: () => SID };
        },
        idFromString: trap,
        get: () => ({
          fetch: async (u) => {
            calls.push(`fetch ${u}`);
            return Response.json({ ok: true, key: KEY });
          },
        }),
      },
    },
  };
}
const PS51 = 'Mozilla/5.0 (Windows NT 10.0; Microsoft Windows 10.0.19045; en-US) WindowsPowerShell/5.1.19041.4648';
const PS7 = 'Mozilla/5.0 (Windows NT 10.0; Microsoft Windows 10.0.19045; en-US) PowerShell/7.4.1';

test('/j from a link preview or browser => harmless text, code not consumed', async () => {
  const agents = [
    'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Microsoft Teams',
    'WhatsApp/2.23.20.0 A',
    'TelegramBot (like TwitterBot)',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
    'curl/8.5.0',
    null,
  ];
  for (const ua of agents) {
    const { env: e, calls } = consumableEnv();
    const r = await handler.fetch(new Request(`${PROD}/j/${CODE}`, { headers: ua ? { 'user-agent': ua } : {} }), e);
    assert.equal(r.status, 200, String(ua));
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const body = await r.text();
    assert.match(body, /^Write-Host '.*Paste the whole command into PowerShell/);
    assert.doesNotMatch(body, new RegExp(KEY));
    assert.deepEqual(calls, [], `Durable Object touched for ${ua}`);
  }
});

test('/j from irm in Windows PowerShell 5.1 and PowerShell 7 serves the script and consumes the code', async () => {
  for (const ua of [PS51, PS7]) {
    const { env: e, calls } = consumableEnv();
    const r = await handler.fetch(new Request(`${PROD}/j/${CODE}`, { headers: { 'user-agent': ua } }), e);
    assert.equal(r.status, 200, ua);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const body = await r.text();
    assert.ok(body.includes(`$Sid = '${SID}'`));
    assert.ok(body.includes(`$Key = '${KEY}'`));
    assert.ok(body.includes("$Origin = 'https://support.example.com'"));
    assert.deepEqual(calls, [`idFromName ${CODE}`, 'fetch https://do/consume'], ua);
  }
});

test('/j over plain http on a real host => use-https script, code not consumed', async () => {
  const { env: e, calls } = consumableEnv();
  const r = await handler.fetch(
    new Request(`http://support.example.com/j/${CODE}`, { headers: { 'user-agent': PS51 } }),
    e,
  );
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const body = await r.text();
  assert.match(body, /^Write-Host 'This support link must use https\./);
  assert.doesNotMatch(body, new RegExp(KEY));
  assert.deepEqual(calls, []);
});

test('/j keeps the origin it arrived on for loopback dev, and pins https elsewhere', async () => {
  const dev = consumableEnv();
  const local = await handler.fetch(
    new Request(`http://127.0.0.1:8787/j/${CODE}`, { headers: { 'user-agent': PS51 } }),
    dev.env,
  );
  assert.equal(local.status, 200);
  assert.ok((await local.text()).includes("$Origin = 'http://127.0.0.1:8787'"));
  assert.equal(dev.calls.length, 2);

  const prod = consumableEnv();
  const withPort = await handler.fetch(
    new Request(`https://support.example.com:8443/j/${CODE}`, { headers: { 'user-agent': PS7 } }),
    prod.env,
  );
  assert.ok((await withPort.text()).includes("$Origin = 'https://support.example.com:8443'"));
});

test('/ws over plain http on a real host => 403 before any Durable Object work', async () => {
  const r = await handler.fetch(
    new Request(`http://support.example.com/ws?sid=${SID}`, { headers: { 'x-attach-key': KEY } }),
    env,
  );
  assert.equal(r.status, 403);
});

test('/ws over http on loopback still reaches the Session', async () => {
  const seen = [];
  const e = {
    ...env,
    SESSION: {
      idFromName: trap,
      idFromString: (sid) => sid,
      get: () => ({ fetch: async (req) => { seen.push(new URL(req.url).pathname); return new Response('gone', { status: 410 }); } }),
    },
  };
  const r = await handler.fetch(new Request(`http://localhost:8787/ws?sid=${SID}`), e);
  assert.equal(r.status, 410);
  assert.deepEqual(seen, ['/ws']);
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
