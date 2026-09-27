import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleRpc, TOOLS, negotiateProtocol, DEFAULT_PROTOCOL } from '../src/mcp.js';

const backend = {
  session_create: async (a) => ({ session_id: 'sid', one_liner: 'irm x | iex', code_expires_at: 1, label: a.label ?? null }),
  session_list: async () => ({ sessions: [] }),
  session_status: async () => ({ state: 'pending' }),
  run: async () => ({ exit_code: 0, stdout: 'ok', stderr: '', timed_out: false }),
  put_file: async () => ({ bytes: 3 }),
  get_file: async () => ({ data_b64: 'AAA', size: 3, eof: true }),
  session_end: async () => ({ ended: true }),
};

test('exactly 7 tools, expected names', () => {
  assert.equal(TOOLS.length, 7);
  assert.deepEqual(
    TOOLS.map((t) => t.name).sort(),
    ['get_file', 'put_file', 'run', 'session_create', 'session_end', 'session_list', 'session_status'],
  );
});

test('tools/list returns the 7 tools', async () => {
  const { status, body } = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, backend);
  assert.equal(status, 200);
  assert.equal(body.result.tools.length, 7);
});

test('initialize negotiates protocol', async () => {
  assert.equal(negotiateProtocol('2025-03-26'), '2025-03-26');
  assert.equal(negotiateProtocol('2025-06-18'), '2025-06-18');
  assert.equal(negotiateProtocol('1999-01-01'), DEFAULT_PROTOCOL);
  const r = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, backend);
  assert.equal(r.body.result.protocolVersion, '2025-03-26');
  assert.equal(r.body.result.serverInfo.name, 'support-mcp');
});

test('notifications/initialized => 202 no body', async () => {
  const r = await handleRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, backend);
  assert.equal(r.status, 202);
  assert.equal(r.body, null);
});

test('ping => empty result', async () => {
  const r = await handleRpc({ jsonrpc: '2.0', id: 5, method: 'ping' }, backend);
  assert.deepEqual(r.body.result, {});
});

test('tools/call run returns text content', async () => {
  const r = await handleRpc(
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'run', arguments: { session_id: 's', command: 'whoami' } } },
    backend,
  );
  assert.equal(r.status, 200);
  const txt = JSON.parse(r.body.result.content[0].text);
  assert.equal(txt.stdout, 'ok');
  assert.ok(!r.body.result.isError);
});

test('tool error surfaces as isError text, not JSON-RPC error', async () => {
  const bad = { ...backend, run: async () => { throw new Error('agent not attached'); } };
  const r = await handleRpc(
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'run', arguments: {} } },
    bad,
  );
  assert.equal(r.body.result.isError, true);
  assert.match(r.body.result.content[0].text, /agent not attached/);
  assert.equal(r.body.error, undefined);
});

test('unknown tool => isError', async () => {
  const r = await handleRpc(
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope', arguments: {} } },
    backend,
  );
  assert.equal(r.body.result.isError, true);
});

test('unknown method => JSON-RPC method not found', async () => {
  const r = await handleRpc({ jsonrpc: '2.0', id: 9, method: 'floop' }, backend);
  assert.equal(r.body.error.code, -32601);
});
