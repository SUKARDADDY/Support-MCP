import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleRpc, listTools, parseToolOptions, negotiateProtocol, DEFAULT_PROTOCOL } from '../src/mcp.js';

const backend = {
  session_create: async (a) => ({ session_id: 'sid', one_liner: 'irm x | iex', code_expires_at: 1, label: a.label ?? null }),
  session_list: async () => ({ sessions: [] }),
  session_status: async () => ({ state: 'pending' }),
  run: async () => ({ exit_code: 0, stdout: 'ok', stderr: '', timed_out: false }),
  put_file: async () => ({ bytes: 3 }),
  get_file: async () => ({ data_b64: 'AAA', size: 3, eof: true }),
  session_end: async () => ({ ended: true }),
};

const BASE = ['get_file', 'put_file', 'run', 'session_create', 'session_end', 'session_list', 'session_status'];
const EXTRAS = ['block_input', 'request_full_control', 'send_sas', 'type_secret'];
const SPLIT = ['click', 'drag', 'move_mouse', 'press_key', 'screenshot', 'scroll', 'type_text', 'wait', 'zoom'];
const names = (options) => listTools(options).map((t) => t.name).sort();

test('the default shape is computer: the base tools, one computer tool, ui_tree and ui_act, and the extras', () => {
  assert.deepEqual(names(), [...BASE, 'computer', 'ui_act', 'ui_tree', ...EXTRAS].sort());
});

test('shape=split lists one tool per action in place of computer', () => {
  assert.deepEqual(names({ shape: 'split', ui: true }), [...BASE, ...SPLIT, 'ui_act', 'ui_tree', ...EXTRAS].sort());
});

test('ui=0 hides ui_tree and ui_act in both shapes, and keeps everything else', () => {
  assert.deepEqual(names({ shape: 'computer', ui: false }), [...BASE, 'computer', ...EXTRAS].sort());
  assert.deepEqual(names({ shape: 'split', ui: false }), [...BASE, ...SPLIT, ...EXTRAS].sort());
});

test('parseToolOptions reads shape and ui and rejects unknown values', () => {
  const q = (s) => new URLSearchParams(s);
  assert.deepEqual(parseToolOptions(q('')), { shape: 'computer', ui: true });
  assert.deepEqual(parseToolOptions(q('shape=split&ui=0')), { shape: 'split', ui: false });
  assert.deepEqual(parseToolOptions(q('shape=computer&ui=1')), { shape: 'computer', ui: true });
  for (const bad of ['shape=Computer', 'shape=', 'shape=both', 'ui=2', 'ui=', 'ui=false']) {
    assert.throws(() => parseToolOptions(q(bad)), /unknown/, bad);
  }
});

test('tools/list follows the connection options', async () => {
  const { status, body } = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, backend);
  assert.equal(status, 200);
  assert.equal(body.result.tools.length, 7 + 1 + 2 + 4);
  const split = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, backend, { shape: 'split', ui: false });
  assert.equal(split.body.result.tools.length, 7 + 9 + 4);
});

test('every tool takes a session_id, and the schemas stay JSON', () => {
  for (const options of [{ shape: 'computer', ui: true }, { shape: 'split', ui: true }]) {
    for (const t of listTools(options)) {
      assert.equal(t.inputSchema.type, 'object', t.name);
      if (!['session_create', 'session_list'].includes(t.name)) assert.ok(t.inputSchema.required.includes('session_id'), t.name);
    }
  }
  assert.doesNotThrow(() => JSON.stringify(listTools()));
});

test('descriptions carry the safety guidance and mark the aliases deprecated', () => {
  const by = Object.fromEntries(listTools({ shape: 'split', ui: true }).map((t) => [t.name, t.description]));
  const computer = listTools().find((t) => t.name === 'computer').description;
  for (const d of [computer, by.screenshot, by.type_secret]) assert.match(d, /untrusted/);
  for (const d of [computer, by.type_secret, by.send_sas]) assert.match(d, /sign-in screen, stop and tell the operator/);
  assert.match(computer, /Prefer ui_tree and ui_act/);
  assert.match(by.type_secret, /only with a secret the operator gave you/);
  assert.match(by.type_secret, /not even its length/);
  assert.match(by.block_input, /only when the operator asks/);
  assert.match(by.block_input, /10 minutes/);
  assert.match(by.session_create, /fallback: commands and files only/);
  assert.match(by.session_create, /aliases legacy and standard are deprecated/);
  const mode = listTools().find((t) => t.name === 'session_create').inputSchema.properties.windows_mode.description;
  assert.match(mode, /deprecated aliases; use app and powershell/);
  assert.match(by.run, /as:"system"/);
  assert.match(by.run, /needs full control/);
  // Normal mode: type_secret works, the other two are refused by the relay, and ui_act follows ui_tree's display.
  assert.match(by.type_secret, /normal mode and in full control/);
  assert.match(by.type_secret, /type_secret failed/);
  assert.match(by.block_input, /relay refuses it/);
  assert.match(by.send_sas, /relay refuses it/);
  assert.match(by.request_full_control, /UAC prompt/);
  assert.match(by.run, /nobody is signed in/);
  assert.match(by.ui_tree, /reports it as display/);
  assert.equal('display' in listTools({ shape: 'split', ui: true }).find((t) => t.name === 'ui_act').inputSchema.properties, false);
  const status = by.session_status;
  for (const word of ['control', 'caps', 'desktop', 'input_blocked_until', 'paused_until', 'client_version']) assert.match(status, new RegExp(word));
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

// A backend whose screen() records what it was asked and answers with a screenshot.
function screenBackend(answer = {}) {
  const calls = [];
  return {
    calls,
    ...backend,
    screen: async (a) => { calls.push(a); return { image_b64: '/9j/4AAQ', mime: 'image/jpeg', width: 1280, height: 800, display: 0, displays: 1, desktop: 'default', control: 'normal', ...answer }; },
    request_full_control: async () => ({ control: 'full' }),
  };
}
const call = (name, args, b, options) => handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, b, options);

test('a screen result is an image block followed by the metadata as JSON', async () => {
  const b = screenBackend();
  const r = await call('computer', { session_id: 's', action: 'screenshot' }, b);
  assert.equal(r.body.result.isError, undefined);
  const [image, meta, ...rest] = r.body.result.content;
  assert.equal(rest.length, 0);
  assert.deepEqual(image, { type: 'image', data: '/9j/4AAQ', mimeType: 'image/jpeg' });
  assert.equal(meta.type, 'text');
  assert.deepEqual(JSON.parse(meta.text), { width: 1280, height: 800, display: 0, displays: 1, desktop: 'default', control: 'normal' });
  assert.deepEqual(b.calls, [{ session_id: 's', action: { name: 'screenshot', display: 0 } }]);
});

test('a result without an image is only the metadata text', async () => {
  const r = await call('ui_tree', { session_id: 's' }, screenBackend({ image_b64: undefined, mime: undefined, text: 'Button "OK" [3]' }));
  assert.equal(r.body.result.content.length, 1);
  assert.equal(JSON.parse(r.body.result.content[0].text).text, 'Button "OK" [3]');
});

test('computer actions map to the normalized vocabulary', async () => {
  const b = screenBackend();
  const act = async (args) => { await call('computer', { session_id: 's', ...args }, b); return b.calls.at(-1).action; };
  assert.deepEqual(await act({ action: 'left_click', coordinate: [640, 412] }), { name: 'click', x: 640, y: 412, button: 'left', count: 1, display: 0, screenshot: true });
  assert.deepEqual(await act({ action: 'right_click', coordinate: [1, 2], screenshot: false }), { name: 'click', x: 1, y: 2, button: 'right', count: 1, display: 0, screenshot: false });
  assert.equal((await act({ action: 'middle_click', coordinate: [1, 2] })).button, 'middle');
  const dbl = await act({ action: 'double_click', coordinate: [1, 2], display: 1 });
  assert.deepEqual([dbl.count, dbl.display], [2, 1]);
  assert.equal((await act({ action: 'triple_click', coordinate: [1, 2] })).count, 3);
  assert.deepEqual(await act({ action: 'mouse_move', coordinate: [5, 6] }), { name: 'move', x: 5, y: 6, display: 0, screenshot: true });
  assert.deepEqual(await act({ action: 'left_click_drag', start_coordinate: [1, 2], coordinate: [3, 4] }), { name: 'drag', x1: 1, y1: 2, x2: 3, y2: 4, display: 0, screenshot: true });
  assert.deepEqual(await act({ action: 'scroll', coordinate: [9, 9], scroll_direction: 'down', scroll_amount: 5 }), { name: 'scroll', x: 9, y: 9, direction: 'down', amount: 5, display: 0, screenshot: true });
  assert.deepEqual(await act({ action: 'type', text: 'שלום' }), { name: 'type', text: 'שלום', display: 0, screenshot: true });
  assert.deepEqual(await act({ action: 'key', text: 'ctrl+s' }), { name: 'key', keys: 'ctrl+s', display: 0, screenshot: true });
  assert.deepEqual(await act({ action: 'wait', duration: 2 }), { name: 'wait', seconds: 2, display: 0, screenshot: true });
  assert.deepEqual(await act({ action: 'zoom', region: [0, 0, 100, 50] }), { name: 'zoom', x1: 0, y1: 0, x2: 100, y2: 50, display: 0 });
});

test('split and shared tools map to the same actions', async () => {
  const b = screenBackend();
  const opts = { shape: 'split', ui: true };
  const act = async (name, args) => { await call(name, { session_id: 's', ...args }, b, opts); return b.calls.at(-1).action; };
  assert.deepEqual(await act('click', { x: 1, y: 2, button: 'right', count: 2 }), { name: 'click', x: 1, y: 2, button: 'right', count: 2, display: 0, screenshot: true });
  assert.equal((await act('move_mouse', { x: 1, y: 2 })).name, 'move');
  assert.equal((await act('type_text', { text: 'hi' })).name, 'type');
  assert.deepEqual(await act('press_key', { keys: 'alt+tab' }), { name: 'key', keys: 'alt+tab', display: 0, screenshot: true });
  assert.equal((await act('drag', { x1: 1, y1: 2, x2: 3, y2: 4 })).name, 'drag');
  assert.equal((await act('screenshot', {})).name, 'screenshot');
  assert.deepEqual(await act('ui_tree', {}), { name: 'ui_tree', max_lines: 300 });
  assert.deepEqual(await act('ui_act', { ref: 12, verb: 'invoke' }), { name: 'ui_act', ref: 12, verb: 'invoke', display: 0, screenshot: true });
  assert.deepEqual(await act('block_input', { on: true }), { name: 'block_input', on: true, minutes: 10 });
  assert.equal((await act('send_sas', {})).name, 'send_sas');
  assert.equal((await act('type_secret', { text: 'pw' })).name, 'type_secret');
  // The shared tools behave the same in the computer shape.
  await call('send_sas', { session_id: 's' }, b);
  assert.equal(b.calls.at(-1).action.name, 'send_sas');
});

test('a bad screen call is a tool error and never reaches the backend', async () => {
  const b = screenBackend();
  for (const [name, args] of [
    ['computer', { action: 'left_click' }],
    ['computer', { action: 'left_click', coordinate: [1] }],
    ['computer', { action: 'teleport' }],
    ['computer', { action: 'zoom', region: [1, 2, 3] }],
    ['computer', { action: 'wait', duration: 11 }],
    ['ui_act', { ref: 1, verb: 'explode' }],
    ['block_input', {}],
  ]) {
    const r = await call(name, { session_id: 's', ...args }, b);
    assert.equal(r.body.result.isError, true, `${name} ${JSON.stringify(args)}`);
  }
  assert.equal(b.calls.length, 0);
});

test('a tool the connection does not list is unknown, even if the other shape has it', async () => {
  const b = screenBackend();
  const unknown = async (name, options) => (await call(name, { session_id: 's' }, b, options)).body.result;
  assert.match((await unknown('ui_tree', { shape: 'computer', ui: false })).content[0].text, /unknown tool/);
  assert.match((await unknown('ui_act', { shape: 'split', ui: false })).content[0].text, /unknown tool/);
  assert.match((await unknown('click', { shape: 'computer', ui: true })).content[0].text, /unknown tool/);
  assert.match((await unknown('computer', { shape: 'split', ui: true })).content[0].text, /unknown tool/);
  assert.match((await unknown('screen', { shape: 'computer', ui: true })).content[0].text, /unknown tool/);
  assert.equal(b.calls.length, 0);
});

test('request_full_control is a text result', async () => {
  const r = await call('request_full_control', { session_id: 's' }, screenBackend());
  assert.deepEqual(JSON.parse(r.body.result.content[0].text), { control: 'full' });
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
