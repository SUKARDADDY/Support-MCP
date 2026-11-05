// The downloaded Windows app: bundle integrity, the download flow, the HTTPS
// polling transport, and the app/powershell modes with their aliases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Session } from '../src/session.js';
import { createHandler } from '../src/app.js';
import { buildAppDownload, normalizeWindowsMode, clientMode } from '../src/template.js';

const SID = 'a'.repeat(64), KEY = 'b'.repeat(64), ORIGIN = 'https://support.example.com';
const bundle = JSON.parse(await readFile(new URL('../src/app-bundle.json', import.meta.url)));

function fixture() {
  const values = new Map(), logs = [];
  const ctx = { getWebSockets: () => [], storage: {
    get: async k => Array.isArray(k) ? new Map(k.map(x => [x, values.get(x)])) : values.get(k),
    put: async o => { for (const [k, v] of Object.entries(o)) values.set(k, v); },
    setAlarm: async () => {}, deleteAlarm: async () => {},
    sql: { exec(q, ...a) { if (q.startsWith('INSERT INTO log')) logs.push({ ts: a[0], kind: a[1], detail: a[2] }); return { toArray: () => logs.slice().reverse() }; } },
  } };
  const registry = { idFromName: n => n, get: () => ({ fetch: async () => Response.json({ sessions: [] }) }) };
  const session = new Session(ctx, { REGISTRY: registry });
  const req = (path, body, key = '') => session.fetch(new Request(`https://do${path}`, { method: 'POST', headers: { 'X-Attach-Key': key }, body: JSON.stringify(body) }));
  const env = { DEV_SKIP_ACCESS: '1', REGISTRY: registry, SESSION: { idFromName: () => SID, idFromString: () => SID, get: () => ({ fetch: (r, opts) => session.fetch(typeof r === 'string' ? new Request(r, opts) : r) }) } };
  return { session, values, logs, req, env };
}

const newHandler = () => createHandler('powershell agent', bundle);

async function createVia(f, handler, args) {
  const rpc = await handler.fetch(new Request('http://127.0.0.1/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'session_create', arguments: args } }) }), f.env);
  const out = (await rpc.json()).result;
  return out.isError ? { error: out.content[0].text } : JSON.parse(out.content[0].text);
}

async function statusVia(f, handler) {
  const rpc = await handler.fetch(new Request('http://127.0.0.1/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'session_status', arguments: { session_id: SID } } }) }), f.env);
  return JSON.parse((await rpc.json()).result.content[0].text);
}

test('app bundle matches its source and manifest, targets the v4 CLR and x86', async () => {
  for (const [file, key] of [['agent-app.cs', 'source_sha256'], ['agent-app.manifest', 'manifest_sha256']]) {
    const source = await readFile(new URL(`../src/${file}`, import.meta.url));
    assert.equal(createHash('sha256').update(source).digest('hex'), bundle[key], `Rebuild the app bundle after changing ${file}`);
  }
  // Built against the .NET 4.5.2 reference assemblies, so it cannot bind to a method a 4.5.2 PC lacks (String.Format with a provider and three arguments is new in 4.6).
  assert.equal(bundle.reference_framework, 'net452', 'Rebuild the app bundle with scripts/build-app.ps1 -ReferenceDir <4.5.2 reference assemblies>');
  const exe = Buffer.from(bundle.exe_b64, 'base64');
  assert.equal(exe.subarray(0, 2).toString(), 'MZ');
  assert.equal(exe.readUInt16LE(exe.readUInt32LE(0x3c) + 4), 0x14c);
  assert.ok(exe.includes(Buffer.from('v4.0.30319')));
  assert.ok(exe.includes(Buffer.from('asInvoker')));
});

test('download overlay preserves the executable and session configuration; credentials never enter the URL', () => {
  const out = Buffer.from(buildAppDownload(bundle, { sid: SID, key: KEY, origin: ORIGIN, startup_expires_at: 12345 }));
  const binary = Buffer.from(bundle.exe_b64, 'base64');
  assert.deepEqual(out.subarray(0, binary.length), binary);
  const tail = Buffer.byteLength('SUPPORTMCPCFG1') + 4;
  assert.equal(out.subarray(-(tail - 4)).toString(), 'SUPPORTMCPCFG1');
  const n = out.readUInt32LE(out.length - tail);
  assert.deepEqual(JSON.parse(out.subarray(out.length - tail - n, out.length - tail)), { sid: SID, key: KEY, origin: ORIGIN, startup_expires_at: 12345 });
  assert.throws(() => buildAppDownload(bundle, { sid: SID, key: KEY, origin: ORIGIN, startup_expires_at: NaN }));
  assert.throws(() => buildAppDownload(bundle, { sid: SID, key: KEY, origin: "https://x'evil", startup_expires_at: 1 }));
});

test('the app, its page and its download carry no vendor branding', async () => {
  const brand = ['race', 'us'].join(''); // the private deployment's name, kept out of this repository
  const source = (await readFile(new URL('../src/agent-app.cs', import.meta.url), 'latin1')).toLowerCase();
  assert.ok(!source.includes(brand));
  assert.ok(!Buffer.from(bundle.exe_b64, 'base64').toString('latin1').toLowerCase().includes(brand));
  const f = fixture(), handler = newHandler();
  const created = await createVia(f, handler, {});
  const html = await (await handler.fetch(new Request(created.download_url), f.env)).text();
  assert.ok(!html.toLowerCase().includes(brand));
  assert.match(html, /<span>Remote support<\/span>/);
});

test('windows_mode defaults to the app, and legacy and standard are aliases', async () => {
  const handler = newHandler();
  const byDefault = await createVia(fixture(), handler, { label: 'default' });
  assert.equal(byDefault.windows_mode, 'app');
  assert.match(byDefault.download_url, /^http:\/\/127\.0\.0\.1\/j\/[a-z2-7]{16}\?client=app$/);
  assert.match(byDefault.one_liner, /^Start-Process 'http:\/\/127\.0\.0\.1\/j\/[a-z2-7]{16}\?client=app'$/);
  assert.ok(!JSON.stringify(byDefault).includes(KEY));

  for (const mode of ['app', 'legacy']) {
    const f = fixture();
    const created = await createVia(f, handler, { windows_mode: mode });
    assert.equal(created.windows_mode, 'app', mode);
    assert.match(created.download_url, /\?client=app$/, mode);
    assert.equal(f.values.get('windows_mode'), 'app', mode);
    assert.equal((await statusVia(f, handler)).windows_mode, 'app', mode);
  }
  for (const mode of ['powershell', 'standard']) {
    const f = fixture();
    const created = await createVia(f, handler, { windows_mode: mode });
    assert.equal(created.windows_mode, 'powershell', mode);
    assert.ok(!('download_url' in created), mode);
    assert.match(created.one_liner, /^irm http:\/\/127\.0\.0\.1\/j\/[a-z2-7]{16} \| iex$/, mode);
    assert.equal(f.values.get('windows_mode'), 'powershell', mode);
    assert.equal((await statusVia(f, handler)).windows_mode, 'powershell', mode);
  }
  for (const mode of ['macos', 'APP', '', 'constructor', '__proto__']) {
    const f = fixture();
    const created = await createVia(f, handler, { windows_mode: mode });
    assert.match(created.error, /windows_mode must be app or powershell/, JSON.stringify(mode));
    assert.equal(f.values.get('state'), undefined, 'a rejected mode creates nothing');
  }
});

test('mode helpers map aliases to the canonical names', () => {
  assert.deepEqual(['app', 'legacy', 'powershell', 'standard'].map(normalizeWindowsMode), ['app', 'app', 'powershell', 'powershell']);
  assert.throws(() => normalizeWindowsMode('toString'));
  assert.equal(clientMode('app'), 'app');
  assert.equal(clientMode('legacy'), 'app');
  for (const v of ['powershell', 'standard', 'x', '', null, 'constructor']) assert.equal(clientMode(v), null, String(v));
});

test('page views and refreshes preserve pairing; only the download form consumes it', async () => {
  const f = fixture(), handler = newHandler();
  const created = await createVia(f, handler, { windows_mode: 'app', label: 'POS' });
  const url = created.download_url;
  assert.ok(!url.includes(KEY));
  assert.equal((await handler.fetch(new Request(url, { method: 'HEAD' }), f.env)).status, 405);
  assert.equal(f.values.get('state'), 'pending');
  for (let i = 0; i < 3; i++) {
    const page = await handler.fetch(new Request(url), f.env);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /^text\/html/);
    // Chrome suppresses the POST Origin with no-referrer, which would reject
    // a real button click. Keep it on same-origin submissions only.
    assert.equal(page.headers.get('referrer-policy'), 'same-origin');
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.match(await page.text(), /<form method="post"[^>]+><button type="submit">Download the support app/);
    assert.equal(f.values.get('state'), 'pending');
  }
  // The legacy alias serves the same page, still without consuming the code.
  assert.equal((await handler.fetch(new Request(url.replace('client=app', 'client=legacy')), f.env)).status, 200);
  assert.equal(f.values.get('state'), 'pending');
  for (const origin of [null, 'https://other.example']) {
    const r = await handler.fetch(new Request(url, { method: 'POST', headers: origin ? { origin } : {} }), f.env);
    assert.equal(r.status, 403);
    assert.equal(f.values.get('state'), 'pending');
  }
  const post = () => new Request(url, { method: 'POST', headers: { origin: new URL(url).origin } });
  const download = await handler.fetch(post(), f.env);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('cache-control'), 'no-store');
  assert.equal(download.headers.get('content-type'), 'application/octet-stream');
  assert.match(download.headers.get('content-disposition'), /attachment; filename="remote-support-aaaaaaaa.exe"/);
  const body = Buffer.from(await download.arrayBuffer());
  assert.equal(body.subarray(0, 2).toString(), 'MZ');
  assert.ok(body.includes(Buffer.from('"key":"')), 'the session key rides in the file, not the URL');
  assert.equal(f.values.get('state'), 'consumed');
  const repeated = await handler.fetch(post(), f.env);
  assert.equal(repeated.status, 409);
  assert.match(await repeated.text(), /Check your downloads/);
  const revisit = await handler.fetch(new Request(url), f.env);
  assert.equal(revisit.status, 409);
  assert.match(await revisit.text(), /remote-support-aaaaaaaa.exe/);
});

test('the legacy client alias downloads the app, and other client values are refused', async () => {
  const f = fixture(), handler = newHandler();
  const created = await createVia(f, handler, {});
  const alias = created.download_url.replace('client=app', 'client=legacy');
  const r = await handler.fetch(new Request(alias, { method: 'POST', headers: { origin: new URL(alias).origin } }), f.env);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/octet-stream');
  for (const client of ['standard', 'powershell', 'macos', '']) {
    const bad = created.download_url.replace('client=app', `client=${client}`);
    assert.equal((await handler.fetch(new Request(bad), f.env)).status, 404, client);
  }
});

test('a PowerShell code cannot be used up by the app page, and an app code not by irm', async () => {
  const handler = newHandler();
  const ps = fixture();
  const psCreated = await createVia(ps, handler, { windows_mode: 'powershell' });
  const asApp = psCreated.one_liner.replace(/^irm /, '').replace(/ \| iex$/, '') + '?client=app';
  const page = await handler.fetch(new Request(asApp), ps.env);
  assert.equal(page.status, 410);
  assert.equal((await handler.fetch(new Request(asApp, { method: 'POST', headers: { origin: new URL(asApp).origin } }), ps.env)).status, 410);
  assert.equal(ps.values.get('state'), 'pending');

  const app = fixture();
  const appCreated = await createVia(app, handler, {});
  const irm = new Request(appCreated.download_url.replace('?client=app', ''), { headers: { 'user-agent': 'WindowsPowerShell/5.1.19041.4648' } });
  const r = await handler.fetch(irm, app.env);
  assert.equal(r.status, 404);
  assert.equal(app.values.get('state'), 'pending');
});

test('download page is a self-contained bilingual card with the security headers intact', async () => {
  const f = fixture(), handler = newHandler();
  const created = await createVia(f, handler, {});
  const page = await handler.fetch(new Request(created.download_url), f.env);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(page.headers.get('referrer-policy'), 'same-origin');
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
  assert.match(html, /<title>Remote support<\/title>/);
  assert.match(html, /<form method="post" action="\/j\/[a-z2-7]{16}\?client=app">/);
  for (const text of ['Download the support app.', 'Open the downloaded file.', 'More info', 'Run anyway', 'Windows protected your PC']) assert.ok(html.includes(text), text);
  // The app's own question comes before the Windows prompt.
  assert.ok(html.includes('Give support full control of this PC?&rdquo; Click <strong>Allow</strong>, then <strong>Yes</strong> when Windows asks for permission.'));
  assert.ok(html.includes('If your antivirus removes the file, tell support.'));
  assert.ok(html.includes('אם האנטי-וירוס מוחק את הקובץ, ספרו לתמיכה.'));
  // Edge holds an uncommon exe until the customer keeps it: its own step, between Download and Open.
  const edge = html.indexOf('isn&rsquo;t commonly downloaded');
  assert.ok(html.indexOf('Download the support app.') < edge && edge < html.indexOf('Open the downloaded file.'), 'Edge step sits between Download and Open');
  for (const text of ['If Microsoft Edge says the file', 'three dots', '<strong>Keep</strong>', '<strong>Show more</strong>', '<strong>Keep anyway</strong>']) assert.ok(html.includes(text), text);
  for (const text of ['אם Microsoft Edge מציג', 'שלוש הנקודות', '<bdi dir="ltr"><strong>Keep</strong></bdi>', '<bdi dir="ltr"><strong>Show more</strong></bdi>', '<bdi dir="ltr"><strong>Keep anyway</strong></bdi>']) assert.ok(html.includes(text), text);
  // The quote marks sit inside the bdi, so they stay beside the English words in right-to-left text.
  assert.ok(html.includes('<bdi dir="ltr">&ldquo;Windows protected your PC&rdquo;</bdi>'));
  assert.ok(html.includes('<bdi dir="ltr"><strong>&ldquo;isn&rsquo;t commonly downloaded&rdquo;</strong></bdi>'));
  assert.match(html, /bdi\{white-space:nowrap\}/, 'a quoted English phrase never wraps away from its quote marks');
  assert.ok((html.match(/lang="he" dir="rtl"/g) || []).length >= 7);
  // IE11 has no :focus-visible and drops a rule it cannot parse, so plain :focus is its own rule.
  assert.match(html, /button:focus\{outline:3px solid #9DB9F5;outline-offset:3px\}/);
  assert.match(html, /button:focus:not\(:focus-visible\)\{outline:none\}/);
  assert.ok(html.indexOf('button:focus{') < html.indexOf('button:focus:not(:focus-visible)'), 'plain :focus comes first');
  assert.equal((html.match(/<form/g) || []).length, 1);
  assert.ok(!/<script|https?:\/\/|src=|<link|@import|url\(/.test(html), 'no scripts or external requests');
});

test('the app link over plain http on a real host is refused and the code stays unused', async () => {
  const f = fixture(), handler = newHandler();
  await f.req('/create', { sid: SID, windows_mode: 'app' });
  const url = 'http://support.example.com/j/abcdefghijklmnop?client=app';
  for (const method of ['GET', 'POST']) {
    const r = await handler.fetch(new Request(url, { method, headers: { origin: 'http://support.example.com' } }), f.env);
    assert.equal(r.status, 403, method);
    assert.match(await r.text(), /must use https/);
  }
  assert.equal(f.values.get('state'), 'pending');
});

test('expired app pages explain the next step without showing a PowerShell error', async () => {
  const f = fixture(), handler = newHandler();
  await f.req('/create', { sid: SID, windows_mode: 'app' });
  f.values.set('code_expires_at', Date.now() - 1);
  const url = `${ORIGIN}/j/abcdefghijklmnop?client=app`;
  const page = await handler.fetch(new Request(url), f.env);
  assert.equal(page.status, 410);
  assert.match(await page.text(), /This support link has expired/);
  assert.equal(f.values.get('state'), 'ended');
  assert.equal((await handler.fetch(new Request(url, { method: 'POST', headers: { origin: ORIGIN } }), f.env)).status, 410);
  const malformed = await handler.fetch(new Request(`${ORIGIN}/j/%E0%A4%A?client=app`), f.env);
  assert.equal(malformed.status, 404);
  assert.match(await malformed.text(), /This support link has expired/);
});

test('app sessions authenticate only the HTTP transport and report mode and rights', async () => {
  const f = fixture(); await f.req('/create', { sid: SID, windows_mode: 'app' });
  const { key, startup_expires_at } = await (await f.req('/consume', { windows_mode: 'app' })).json();
  assert.ok(Number.isSafeInteger(startup_expires_at));
  assert.equal((await f.req('/agent', { type: 'hello' }, 'bad')).status, 401);
  assert.equal((await f.session.fetch(new Request('https://do/ws', { headers: { 'X-Attach-Key': key } }))).status, 401);
  const hello = await (await f.req('/agent', { type: 'hello', machine: 'POS', user: 'pos', ps: '2.0-compatible', agent: 'windows-app-1' }, key)).json();
  assert.equal(hello.type, 'welcome');
  assert.ok(hello.server_time <= hello.expires_at);
  const status = await (await f.session.fetch(new Request('https://do/status'))).json();
  assert.equal(status.windows_mode, 'app'); assert.equal(status.state, 'attached');
  assert.equal(status.attached, true); assert.equal(status.ps, '2.0-compatible'); assert.equal(status.startup_expires_at, null);
  assert.deepEqual(f.logs.map(l => l.kind), ['created', 'consumed', 'attached', 'hello']);
  const command = f.req('/command', { op: 'run', command: 'whoami', actor: 'op@example.com' });
  while (!f.session.httpCommands.cmd) await new Promise(r => setImmediate(r));
  assert.equal((await (await f.req('/command', { op: 'run', command: 'second' })).json()).error, 'agent busy; wait for the current operation');
  const frame = await (await f.req('/agent', { type: 'poll', generation: hello.generation }, key)).json();
  assert.equal(frame.type, 'run');
  const result = { type: 'result', id: frame.id, generation: hello.generation, ok: true, stdout_b64: btoa('pos'), stderr_b64: '', exit_code: 0 };
  assert.equal((await (await f.req('/agent', result, key)).json()).type, 'ack');
  assert.equal((await (await f.req('/agent', result, key)).json()).type, 'ack');
  assert.equal((await (await command).json()).stdout, 'pos');
  assert.ok(f.logs.some(l => l.kind === 'run' && l.detail === '[op@example.com] whoami'));
  const next = await (await f.req('/agent', { type: 'hello' }, key)).json();
  assert.equal(next.expires_at, hello.expires_at);
  assert.equal((await f.req('/agent', { type: 'end', generation: hello.generation }, key)).status, 409);
  await f.req('/agent', { type: 'end', generation: next.generation }, key);
  assert.equal((await f.req('/agent', { type: 'hello' }, key)).status, 410);
  assert.equal(f.values.get('ended_reason'), 'customer');
});

test('app sessions bound what the client reports and what a result may carry', async () => {
  const f = fixture(); await f.req('/create', { sid: SID, windows_mode: 'app' });
  const { key } = await (await f.req('/consume', { windows_mode: 'app' })).json();
  const hello = await (await f.req('/agent', { type: 'hello', machine: 'm'.repeat(500), user: 'u'.repeat(500), ps: 'p'.repeat(500) }, key)).json();
  assert.equal(f.values.get('machine').length, 101); assert.equal(f.values.get('user').length, 101); assert.equal(f.values.get('ps').length, 41);
  const command = f.req('/command', { op: 'get_file', path: 'C:\\x' });
  while (!f.session.httpCommands.cmd) await new Promise(r => setImmediate(r));
  const frame = await (await f.req('/agent', { type: 'poll', generation: hello.generation }, key)).json();
  const bad = await f.req('/agent', { type: 'result', id: frame.id, generation: hello.generation, ok: true, data_b64: 'AA==', size: -1, eof: true }, key);
  assert.equal(bad.status, 400);
  assert.equal((await (await f.req('/agent', { type: 'result', id: frame.id, generation: hello.generation, ok: true, data_b64: 'AA==', size: 1, eof: true }, key)).json()).type, 'ack');
  assert.deepEqual(await (await command).json(), { ok: true, data_b64: 'AA==', size: 1, eof: true });
  assert.equal((await f.req('/agent', { type: 'nonsense', generation: hello.generation }, key)).status, 400);
});

test('PowerShell sessions cannot attach through the app endpoint, nor app codes through /consume', async () => {
  const f = fixture(); await f.req('/create', { sid: SID });
  assert.equal(f.values.get('windows_mode'), 'powershell');
  assert.equal((await (await f.req('/consume', { windows_mode: 'app' })).json()).ok, false);
  const { key } = await (await f.req('/consume', {})).json();
  assert.equal((await f.req('/agent', { type: 'hello' }, key)).status, 401);
  assert.equal((await fixture().req('/create', { sid: SID, windows_mode: 'standard' })).status, 400, 'aliases are resolved before the session, which only stores canonical names');
});

test('app status reports administrator, normal, and unknown rights without extending expiry', async () => {
  const f = fixture(); await f.req('/create', { sid: SID, windows_mode: 'app' });
  const { key } = await (await f.req('/consume', { windows_mode: 'app' })).json();
  let expiry;
  for (const elevated of [true, false, undefined, 'true']) {
    const hello = await (await f.req('/agent', { type: 'hello', machine: 'POS', user: 'pos', elevated }, key)).json();
    assert.equal(hello.type, 'welcome');
    expiry ??= hello.expires_at;
    assert.equal(hello.expires_at, expiry);
    const status = await (await f.session.fetch(new Request('https://do/status'))).json();
    assert.equal(status.elevated, typeof elevated === 'boolean' ? elevated : null);
  }
});

test('app expiry and operator end release waiting polls and commands permanently', async () => {
  for (const expiry of [false, true]) {
    const f = fixture(); await f.req('/create', { sid: SID, windows_mode: 'app' });
    const { key } = await (await f.req('/consume', { windows_mode: 'app' })).json();
    const { generation } = await (await f.req('/agent', { type: 'hello' }, key)).json();
    const poll = f.req('/agent', { type: 'poll', generation }, key);
    while (!f.session.httpPoll) await new Promise(r => setImmediate(r));
    if (expiry) { f.values.set('expires_at', Date.now() - 1); await f.session.alarm(); } else await f.req('/end', {});
    assert.equal((await (await poll).json()).type, 'end');
    assert.equal((await f.req('/agent', { type: 'hello' }, key)).status, 410);
  }
});

// ---- the /agent route -------------------------------------------------------
const agentRequest = (url, init = {}) => new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-attach-key': KEY, ...init.headers }, body: init.body ?? '{"type":"poll"}' });

test('/agent refuses plain http on a real host, wrong methods, browsers, key-in-URL and non-JSON', async () => {
  const handler = newHandler();
  const touched = [];
  const env = { SESSION: { idFromString: () => { touched.push('idFromString'); throw new Error('Durable Object touched'); }, idFromName: () => { throw new Error('touched'); }, get: () => { throw new Error('touched'); } } };
  const base = `https://support.example.com/agent?sid=${SID}`;
  assert.equal((await handler.fetch(agentRequest(`http://support.example.com/agent?sid=${SID}`), env)).status, 403);
  assert.equal((await handler.fetch(new Request(base), env)).status, 405);
  assert.equal((await handler.fetch(agentRequest(base, { headers: { origin: 'https://evil.example' } }), env)).status, 403);
  assert.equal((await handler.fetch(agentRequest(`${base}&key=${KEY}`), env)).status, 403);
  assert.equal((await handler.fetch(agentRequest(base, { headers: { 'content-type': 'text/plain' } }), env)).status, 415);
  assert.equal((await handler.fetch(agentRequest('https://support.example.com/agent?sid=short'), env)).status, 401);
  assert.equal((await handler.fetch(agentRequest(base, { body: 'x'.repeat(750001) }), env)).status, 413);
  assert.deepEqual(touched, []);
});

test('/agent over http on loopback reaches the session, and passes the key only as a header', async () => {
  const handler = newHandler();
  const seen = [];
  const env = { SESSION: { idFromString: (s) => s, get: () => ({ fetch: async (req) => {
    seen.push([new URL(req.url).pathname, req.headers.get('x-attach-key'), await req.text()]);
    return Response.json({ type: 'idle' });
  } }) } };
  const r = await handler.fetch(agentRequest(`http://127.0.0.1:8787/agent?sid=${SID}`), env);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.deepEqual(seen, [['/agent', KEY, '{"type":"poll"}']]);
});

// ---- inline expiry in /agent ------------------------------------------------
// These tests never call alarm(). The request itself must notice the deadline.
const HOUR = 60 * 60 * 1000;

function clocked(t) {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  return { advance: (ms) => { now += ms; }, now: () => now };
}

// Runs `hook` inside the next SHA-256 the session computes, which is where
// /agent yields to other requests between its first and second deadline check.
function duringHash(t, hook) {
  const subtle = globalThis.crypto.subtle, original = subtle.digest.bind(subtle);
  let armed = true;
  t.mock.method(subtle, 'digest', async (...args) => {
    if (armed) { armed = false; await hook(); }
    return original(...args);
  });
}

async function attached(f) {
  await f.req('/create', { sid: SID, windows_mode: 'app' });
  const { key } = await (await f.req('/consume', { windows_mode: 'app' })).json();
  return key;
}

test('/agent refuses a hello after the two-hour first-connect limit and ends the session', async (t) => {
  const clock = clocked(t);
  const f = fixture(), key = await attached(f);
  clock.advance(2 * HOUR);
  const r = await f.req('/agent', { type: 'hello', machine: 'late' }, key);
  assert.equal(r.status, 410);
  assert.equal(f.values.get('state'), 'ended');
  assert.equal(f.values.get('ended_reason'), 'consume TTL');
  assert.equal(f.values.get('machine'), null);
  assert.ok(!f.logs.some((l) => l.kind === 'attached'));
});

test('/agent refuses every call after the 24-hour expiry and ends the session', async (t) => {
  for (const message of [{ type: 'hello' }, { type: 'poll' }, { type: 'result', id: 'x' }, { type: 'end' }]) {
    const clock = clocked(t);
    const f = fixture(), key = await attached(f);
    const { generation } = await (await f.req('/agent', { type: 'hello' }, key)).json();
    clock.advance(24 * HOUR);
    const r = await f.req('/agent', { generation, ...message }, key);
    assert.equal(r.status, 410, message.type);
    assert.equal(f.values.get('state'), 'ended', message.type);
    assert.equal(f.values.get('ended_reason'), 'expired', message.type);
    t.mock.restoreAll();
  }
});

test('/agent answers an expired session before it looks at the key', async (t) => {
  const clock = clocked(t);
  const f = fixture(), key = await attached(f);
  await f.req('/agent', { type: 'hello' }, key);
  clock.advance(24 * HOUR);
  // Same order as /ws: an ended session is 410 for everyone, a live one is 401 for a wrong key.
  assert.equal((await f.req('/agent', { type: 'poll' }, 'wrong')).status, 410);
  assert.equal(f.values.get('state'), 'ended');
});

test('/agent refuses a hello whose session expires while the relay is hashing the key', async (t) => {
  const clock = clocked(t);
  const f = fixture(), key = await attached(f);
  duringHash(t, () => clock.advance(2 * HOUR));
  const r = await f.req('/agent', { type: 'hello', machine: 'racing' }, key);
  assert.equal(r.status, 410);
  assert.equal(f.values.get('state'), 'ended');
  assert.equal(f.values.get('ended_reason'), 'consume TTL');
  assert.ok(!f.logs.some((l) => l.kind === 'attached'));
});

test('/agent refuses a hello that races an operator end', async (t) => {
  const f = fixture(), key = await attached(f);
  duringHash(t, async () => { await f.req('/end', {}); });
  const r = await f.req('/agent', { type: 'hello', machine: 'racing' }, key);
  assert.equal(r.status, 410);
  assert.equal(f.values.get('state'), 'ended');
  assert.equal(f.values.get('ended_reason'), 'ended_by_operator');
  assert.ok(!f.logs.some((l) => l.kind === 'attached'));
  assert.equal((await f.req('/agent', { type: 'hello' }, key)).status, 410);
});

// ---- same-origin POST without an Origin header -------------------------------
test('the download POST accepts a matching Origin, or no Origin with a Referer from our own /j page', async () => {
  const f = fixture(), handler = newHandler();
  await f.req('/create', { sid: SID, windows_mode: 'app' });
  const url = `${ORIGIN}/j/abcdefghijklmnop?client=app`;
  const post = (headers) => handler.fetch(new Request(url, { method: 'POST', headers }), f.env);
  const refused = [
    ['Origin present but foreign, even with a good Referer', { origin: 'https://other.example', referer: url }],
    ['Origin "null", even with a good Referer', { origin: 'null', referer: url }],
    ['no Origin and a foreign Referer', { referer: 'https://other.example/j/abcdefghijklmnop' }],
    ['no Origin and a Referer on a lookalike host', { referer: 'https://support.example.com.evil.example/j/abcdefghijklmnop' }],
    ['no Origin and a Referer outside /j/', { referer: `${ORIGIN}/healthz` }],
    ['neither Origin nor Referer', {}],
  ];
  for (const [name, headers] of refused) {
    assert.equal((await post(headers)).status, 403, name);
    assert.equal(f.values.get('state'), 'pending', name);
  }
  const ok = await post({ referer: url });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'application/octet-stream');
  assert.equal(f.values.get('state'), 'consumed');
  // Single use still holds on this path.
  assert.equal((await post({ referer: url })).status, 409);

  const g = fixture();
  await g.req('/create', { sid: SID, windows_mode: 'app' });
  const exact = await handler.fetch(new Request(url, { method: 'POST', headers: { origin: ORIGIN } }), g.env);
  assert.equal(exact.status, 200);
});

// ---- relative startup budget --------------------------------------------------
test('the download carries a relative startup budget next to the absolute deadline', async () => {
  const f = fixture(), handler = newHandler();
  await f.req('/create', { sid: SID, windows_mode: 'app' });
  const url = `${ORIGIN}/j/abcdefghijklmnop?client=app`;
  const body = Buffer.from(await (await handler.fetch(new Request(url, { method: 'POST', headers: { origin: ORIGIN } }), f.env)).arrayBuffer());
  const tail = Buffer.byteLength('SUPPORTMCPCFG1') + 4;
  const n = body.readUInt32LE(body.length - tail);
  const config = JSON.parse(body.subarray(body.length - tail - n, body.length - tail));
  assert.ok(Number.isSafeInteger(config.startup_ms) && config.startup_ms > 2 * HOUR - 60000 && config.startup_ms <= 2 * HOUR, String(config.startup_ms));
  assert.ok(Math.abs(config.startup_expires_at - (Date.now() + config.startup_ms)) < 5000);
});

test('startup_ms is optional but validated when present', () => {
  const base = { sid: SID, key: KEY, origin: ORIGIN, startup_expires_at: 12345 };
  const config = (out) => { const b = Buffer.from(out); const tail = Buffer.byteLength('SUPPORTMCPCFG1') + 4; const n = b.readUInt32LE(b.length - tail); return JSON.parse(b.subarray(b.length - tail - n, b.length - tail)); };
  assert.ok(!('startup_ms' in config(buildAppDownload(bundle, base))));
  assert.equal(config(buildAppDownload(bundle, { ...base, startup_ms: 7200000 })).startup_ms, 7200000);
  for (const bad of [0, -1, 7200001, 1.5, NaN, '60000', null]) assert.throws(() => buildAppDownload(bundle, { ...base, startup_ms: bad }), /bad startup budget/, String(bad));
});

// ---- busy polling -------------------------------------------------------------
test('a busy poll is a sign of life: answered at once, never re-sent the frame, never parked', async () => {
  const f = fixture(); const key = await attached(f);
  const hello = await (await f.req('/agent', { type: 'hello' }, key)).json();
  const command = f.req('/command', { op: 'run', command: 'whoami' });
  while (!f.session.httpCommands.cmd) await new Promise((r) => setImmediate(r));
  const busy = await (await f.req('/agent', { type: 'poll', generation: hello.generation, busy: true }, key)).json();
  assert.deepEqual(busy, { type: 'idle' });
  assert.equal(f.session.httpPoll, null, 'a busy poll is not parked');
  const seenBefore = f.values.get('http_seen_at');
  assert.ok(seenBefore > 0, 'a busy poll still counts as a sign of life');
  const frame = await (await f.req('/agent', { type: 'poll', generation: hello.generation }, key)).json();
  assert.equal(frame.type, 'run');
  assert.equal((await (await f.req('/agent', { type: 'poll', generation: hello.generation, busy: true }, key)).json()).type, 'idle');
  const result = { type: 'result', id: frame.id, generation: hello.generation, ok: true, stdout_b64: '', stderr_b64: '', exit_code: 0 };
  await f.req('/agent', result, key);
  assert.equal((await command).status, 200);
  // After the result, an idle (not busy) poll long-polls as usual.
  const poll = f.req('/agent', { type: 'poll', generation: hello.generation }, key);
  while (!f.session.httpPoll) await new Promise((r) => setImmediate(r));
  await f.req('/end', {});
  assert.equal((await (await poll).json()).type, 'end');
});

// ---- /agent body size ---------------------------------------------------------
test('/agent refuses a declared oversize body before reading any of it', async () => {
  const handler = newHandler();
  let pulled = false;
  const env = { SESSION: { idFromString: () => { throw new Error('Durable Object touched'); }, get: () => { throw new Error('touched'); } } };
  const body = new ReadableStream({ pull(controller) { pulled = true; controller.enqueue(new TextEncoder().encode('{}')); controller.close(); } }, { highWaterMark: 0 });
  const r = await handler.fetch(new Request(`https://support.example.com/agent?sid=${SID}`, {
    method: 'POST', duplex: 'half', body,
    headers: { 'content-type': 'application/json', 'x-attach-key': KEY, 'content-length': '750001' },
  }), env);
  assert.equal(r.status, 413);
  assert.equal(pulled, false, 'the body stream was never read');
  // A body with no Content-Length is still checked after it is read.
  const unsized = await handler.fetch(agentRequest(`https://support.example.com/agent?sid=${SID}`, { body: 'x'.repeat(750001) }), env);
  assert.equal(unsized.status, 413);
});
