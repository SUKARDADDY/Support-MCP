// The built-in agent's model table, its cost arithmetic, which model a task may use,
// and the tools its model sees. Pure: no database, no Durable Object.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OUTPUT_FLOOR, TABLE_MODELS, costMicro, defaultModelId, fitOutput, monthBounds, normalizeOutputLimit, normalizePrices, pickSpec,
  reserveMicro, specOf, usableSpecs,
} from '../src/agent-models.js';
import { AGENT_TOOL_NAMES, agentTools, stepDetail, strictify, stripNulls } from '../src/agent-tools.js';
import { estimateTokens } from '../src/agent-providers.js';

const spec = (id) => specOf({ provider: TABLE_MODELS[id].provider, id });
const settings = (over = {}) => ({ default_model: null, models: [], starters_pick_model: true, ...over });
const both = { openai: true, anthropic: true };

test('the table holds the five models with the prices step 0 checked against the pricing pages', () => {
  assert.deepEqual(Object.keys(TABLE_MODELS), ['gpt-6.1-terra', 'gpt-6.1-sol', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
  const p = (id) => ({ ...TABLE_MODELS[id].prices });
  assert.deepEqual(p('gpt-6.1-terra'), { input: 1, cached_input: 0.05, cache_write: 1.25, output: 5 });
  assert.deepEqual(p('gpt-6.1-sol'), { input: 2, cached_input: 0.10, cache_write: 2.50, output: 10 });
  assert.deepEqual(p('claude-opus-5-5'), { input: 4, cached_input: 0.20, cache_write: 5, output: 20 });
  assert.deepEqual(p('claude-sonnet-5-5'), { input: 2, cached_input: 0.10, cache_write: 2.50, output: 10 });
  assert.deepEqual(p('claude-haiku-5-5'), { input: 0.10, cached_input: 0.01, cache_write: 0.125, output: 0.50 });
  assert.equal(TABLE_MODELS['gpt-6.1-terra'].output_limit, 25000);
  assert.equal(TABLE_MODELS['claude-sonnet-5-5'].output_limit, 16000);
  assert.deepEqual(TABLE_MODELS['gpt-6.1-sol'].long, { over: 272000, input: 2, cached_input: 2, cache_write: 2, output: 1.5 });
  assert.deepEqual(TABLE_MODELS['claude-haiku-5-5'].long, { over: 100000, input: 5, cached_input: 5, cache_write: 5, output: 5 });
  assert.equal(TABLE_MODELS['claude-opus-5-5'].long, null);
});

test('cost is worked out by hand from step 0\'s real usage fields: OpenAI counts cached and cache-write tokens inside input_tokens', () => {
  // Terra, turn 2 of step 0: input_tokens 5177 = 3 uncached + 3949 cached + 1225 written; 19 output tokens.
  // 3 x $1 + 3949 x $0.05 + 1225 x $1.25 + 19 x $5 = 3 + 197.45 + 1531.25 + 95 = 1826.7 micro-dollars, rounded up.
  assert.equal(costMicro(spec('gpt-6.1-terra'), { input: 5177 - 3949 - 1225, cached: 3949, cache_write: 1225, output: 19 }), 1827);
  // Sonnet, turn 2 of step 0: input_tokens 2 is the uncached rest; 1379 written (5-minute price), 7038 read, 50 out.
  // 2 x $2 + 1379 x $2.50 + 7038 x $0.10 + 50 x $10 = 4 + 3447.5 + 703.8 + 500 = 4655.3.
  assert.equal(costMicro(spec('claude-sonnet-5-5'), { input: 2, cached: 7038, cache_write: 1379, output: 50 }), 4656);
  // An exact figure is not rounded up.
  assert.equal(costMicro(spec('gpt-6.1-terra'), { input: 1000, cached: 0, cache_write: 0, output: 20 }), 1100);
});

test('past the long-context threshold every price is multiplied: 2x input and 1.5x output on GPT-6.1, 5x on Haiku', () => {
  assert.equal(costMicro(spec('gpt-6.1-terra'), { input: 272000, cached: 0, cache_write: 0, output: 1000 }), 272000 + 5000, 'at the threshold: not past it');
  assert.equal(costMicro(spec('gpt-6.1-terra'), { input: 300000, cached: 0, cache_write: 0, output: 1000 }), 600000 + 7500);
  assert.equal(costMicro(spec('claude-haiku-5-5'), { input: 100000, cached: 0, cache_write: 0, output: 1000 }), 10000 + 500);
  assert.equal(costMicro(spec('claude-haiku-5-5'), { input: 120000, cached: 0, cache_write: 0, output: 1000 }), 60000 + 2500);
  assert.equal(costMicro(spec('claude-sonnet-5-5'), { input: 900000, cached: 0, cache_write: 0, output: 0 }), 1800000, 'Claude has no long-context price');
});

test('a reservation prices the worst case, and the output limit shrinks to fit what is left, never under 4,000 tokens', () => {
  const terra = spec('gpt-6.1-terra');
  // 10,000 input tokens at the dearest input price (a cache write, $1.25) and 25,000 output tokens at $5.
  assert.equal(reserveMicro(terra, 10000, 25000), 12500 + 125000);
  assert.equal(fitOutput(terra, 10000, 1_000_000), 25000, 'plenty of room: the model\'s own limit');
  assert.equal(fitOutput(terra, 10000, 50000), 7500, '(50,000 - 12,500) / 5');
  assert.equal(reserveMicro(terra, 10000, 7500), 12500 + 37500);
  assert.equal(fitOutput(terra, 10000, 12500 + OUTPUT_FLOOR * 5), OUTPUT_FLOOR, 'exactly the floor');
  assert.equal(fitOutput(terra, 10000, 12500 + OUTPUT_FLOOR * 5 - 1), 0, 'one micro-dollar less: the cap is reached');
  assert.equal(fitOutput(terra, 10000, 5000), 0, 'the input alone does not fit');
  // Opus costs more per token: $0.10 cannot buy the floor with 8,000 input tokens.
  assert.equal(fitOutput(spec('claude-opus-5-5'), 8000, 100000), 0);
  // The long-context price counts in the worst case.
  assert.equal(reserveMicro(terra, 300000, 1000), 300000 * 2.5 + 1000 * 7.5);
});

test('prices an admin types: input and output are required, cached input defaults to input and a cache write to 1.25 times it', () => {
  assert.deepEqual(normalizePrices({ input: 2, output: 8 }), { input: 2, cached_input: 2, cache_write: 2.5, output: 8 });
  assert.deepEqual(normalizePrices({ input: 2, output: 8, cached_input: 0.5, cache_write: 3 }), { input: 2, cached_input: 0.5, cache_write: 3, output: 8 });
  for (const bad of [undefined, null, [], 'x', {}, { input: 2 }, { output: 2 }, { input: 0, output: 1 }, { input: -1, output: 1 }, { input: '2', output: 1 },
    { input: 1, output: 1001 }, { input: 1, output: 1, extra: 1 }, { input: 1, output: NaN }]) {
    assert.throws(() => normalizePrices(bad), Error, JSON.stringify(bad));
  }
  assert.equal(normalizeOutputLimit(4000), 4000);
  assert.throws(() => normalizeOutputLimit(3999), /output limit too small/);
  assert.throws(() => normalizeOutputLimit(1.5), /whole number/);
  assert.throws(() => normalizeOutputLimit(1_000_000), /whole number/);
});

test('a model is usable only when it is the team\'s default or was added, and its provider has a key', () => {
  const none = { openai: false, anthropic: false };
  assert.equal(defaultModelId(settings(), both), 'gpt-6.1-terra');
  assert.equal(defaultModelId(settings(), { openai: false, anthropic: true }), 'claude-sonnet-5-5', 'with only a Claude key');
  assert.equal(defaultModelId(settings({ default_model: 'claude-opus-5-5' }), both), 'claude-opus-5-5');
  assert.deepEqual(usableSpecs(settings(), both).map((s) => s.id), ['gpt-6.1-terra'], 'the other four table models are not usable until added');
  assert.deepEqual(usableSpecs(settings(), none), [], 'no key, nothing is usable');
  const added = [
    { provider: 'anthropic', id: 'claude-opus-5-5', prices: null, output_limit: 16000, settings: { thinking: 'adaptive', effort: 'medium' } },
    { provider: 'openai', id: 'gpt-4.1', prices: { input: 2, cached_input: 0.5, cache_write: 2.5, output: 8 }, output_limit: 8000, settings: { reasoning_effort: null } },
  ];
  assert.deepEqual(usableSpecs(settings({ models: added }), both).map((s) => s.id), ['gpt-6.1-terra', 'claude-opus-5-5', 'gpt-4.1']);
  assert.deepEqual(usableSpecs(settings({ models: added }), { openai: true, anthropic: false }).map((s) => s.id), ['gpt-6.1-terra', 'gpt-4.1'], 'an added model whose key was removed is not usable');
  // An added model carries its own settings and prices; a table model added keeps the table's prices.
  const gpt41 = usableSpecs(settings({ models: added }), both).find((s) => s.id === 'gpt-4.1');
  assert.deepEqual([gpt41.settings, gpt41.long, gpt41.prices.output], [{ reasoning_effort: null }, null, 8]);
  const opus = usableSpecs(settings({ models: added }), both).find((s) => s.id === 'claude-opus-5-5');
  assert.deepEqual([opus.prices, opus.long], [TABLE_MODELS['claude-opus-5-5'].prices, null]);
});

test('a task may name a model only while the team lets starters pick, and only a usable one', () => {
  const added = [{ provider: 'anthropic', id: 'claude-opus-5-5', prices: null, output_limit: 16000, settings: {} }];
  assert.equal(pickSpec(settings(), both).spec.id, 'gpt-6.1-terra', 'no model named: the default');
  assert.equal(pickSpec(settings(), both, 'gpt-6.1-terra').spec.id, 'gpt-6.1-terra');
  assert.match(pickSpec(settings(), both, 'claude-opus-5-5').error, /not available/, 'a table model that is neither the default nor added');
  assert.equal(pickSpec(settings({ models: added }), both, 'claude-opus-5-5').spec.id, 'claude-opus-5-5', 'added, and starters may pick');
  assert.equal(pickSpec(settings({ models: added, starters_pick_model: false }), both, 'claude-opus-5-5').error, 'this team uses one model');
  assert.equal(pickSpec(settings({ models: added, starters_pick_model: false }), both, 'gpt-6.1-terra').spec.id, 'gpt-6.1-terra', 'the default is always fine');
  assert.equal(pickSpec(settings({ models: added, starters_pick_model: false }), both).spec.id, 'gpt-6.1-terra');
  assert.match(pickSpec(settings({ models: added }), { openai: true, anthropic: false }, 'claude-opus-5-5').error, /no Claude key/);
  assert.match(pickSpec(settings(), both, 'not-a-model').error, /not available/);
});

test('the month is the calendar month in UTC', () => {
  const [start, end] = monthBounds(Date.UTC(2026, 10, 9, 12));
  assert.deepEqual([start, end], [Date.UTC(2026, 10, 1), Date.UTC(2026, 11, 1)]);
  assert.deepEqual(monthBounds(Date.UTC(2026, 11, 31, 23, 59)), [Date.UTC(2026, 11, 1), Date.UTC(2027, 0, 1)]);
});

// ---- the tools the model sees ---------------------------------------------------------------
test('the agent\'s tools are the session tools without session_id and the PC, session and team tools, plus note and finish', () => {
  const tools = agentTools();
  assert.deepEqual(tools.map((t) => t.name), [
    'session_status', 'run', 'put_file', 'get_file', 'restart_pc', 'shutdown_pc', 'list_programs', 'install_program', 'uninstall_program', 'close_program', 'screenshot', 'click', 'move_mouse', 'drag', 'scroll', 'type_text', 'press_key', 'wait', 'zoom',
    'ui_tree', 'ui_act', 'note', 'finish',
  ]);
  for (const gone of ['type_secret', 'block_input', 'send_sas', 'request_full_control', 'session_create', 'session_list', 'session_end', 'device_list', 'device_connect',
    'agent_start', 'agent_status', 'agent_control']) {
    assert.ok(!AGENT_TOOL_NAMES.has(gone), gone);
  }
  for (const t of tools) {
    assert.ok(!Object.hasOwn(t.schema.properties ?? {}, 'session_id'), `${t.name} has no session_id`);
    assert.ok(!(t.schema.required ?? []).includes('session_id'), t.name);
    assert.doesNotMatch(t.description, /type_secret|send_sas|block_input|request_full_control|session_create|session_list|session_end|device_connect|device_list|agent_/, `${t.name}: no description points at a tool the agent does not have`);
    assert.doesNotMatch(JSON.stringify(t.schema), /type_secret/, t.name);
  }
  assert.match(tools.find((t) => t.name === 'screenshot').description, /untrusted/, 'the safety guidance stays');
  assert.ok(JSON.stringify(tools).length < 24000, 'about 5,000 tokens: 4,000 measured in step 0, and the six rule-governed tools add about 1,000');
});

test('strict mode: every property required, an optional one also null, no extra properties, and nulls are stripped before the relay sees them', () => {
  for (const t of agentTools()) {
    const s = strictify(t.schema);
    assert.equal(s.additionalProperties, false, t.name);
    assert.deepEqual([...s.required].sort(), Object.keys(s.properties).sort(), t.name);
  }
  const click = strictify(agentTools().find((t) => t.name === 'click').schema);
  assert.equal(click.properties.x.type, 'integer');
  assert.deepEqual(click.properties.button.type, ['string', 'null']);
  assert.deepEqual(click.properties.button.enum, ['left', 'right', 'middle', null]);
  assert.deepEqual(stripNulls({ x: 1, y: 2, button: null, count: null, screenshot: false }), { x: 1, y: 2, screenshot: false });
});

test('a step record shows the verb and a short detail, and never typed text', () => {
  assert.equal(stepDetail('type_text', { text: 'my password is hunter2' }), '22 chars');
  assert.equal(stepDetail('click', { x: 640, y: 412 }), '640,412');
  assert.equal(stepDetail('press_key', { keys: 'ctrl+s' }), 'ctrl+s');
  assert.equal(stepDetail('run', { command: 'Get-Printer', as: 'system' }), '(system) Get-Printer');
  assert.equal(stepDetail('run', { command: 'x'.repeat(500) }).length, 120);
  assert.equal(stepDetail('ui_act', { ref: 3, verb: 'set_value', value: 'VALUE-NOT-SHOWN' }), 'set_value 3');
  assert.equal(stepDetail('put_file', { path: 'C:\\a.txt', data_b64: 'SECRETDATA' }), 'C:\\a.txt');
  assert.equal(stepDetail('screenshot', {}), '');
  // The tools the team's rules govern show what they act on, and an installer's arguments never.
  assert.equal(stepDetail('restart_pc', { delay_s: 60 }), 'in 60 s');
  assert.equal(stepDetail('shutdown_pc', {}), 'in 30 s');
  assert.equal(stepDetail('list_programs', {}), '');
  assert.equal(stepDetail('install_program', { path: 'C:\\setup.msi', args: '/password=hunter2' }), 'C:\\setup.msi');
  assert.equal(stepDetail('uninstall_program', { program_id: 'app-1' }), 'app-1');
  assert.equal(stepDetail('close_program', { name: 'OUTLOOK.EXE', force: true }), 'OUTLOOK.EXE (force)');
  assert.equal(stepDetail('close_program', { pid: 4120 }), 'pid 4120');
  assert.ok(!JSON.stringify([stepDetail('type_text', { text: 'hunter2' }), stepDetail('put_file', { path: 'p', data_b64: 'hunter2' })]).includes('hunter2'));
});

test('a request is sized from its text and a fixed figure per image, so base64 is not counted as text', () => {
  const img = { type: 'input_image', image_url: `data:image/png;base64,${'A'.repeat(500000)}`, detail: 'original' };
  const claude = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(500000) } };
  assert.equal(estimateTokens([img]), 1800);
  assert.equal(estimateTokens([{ content: [claude, { type: 'text', text: 'abc' }] }]), 1800 + 3);
  assert.equal(estimateTokens('x'.repeat(300)), 100);
});
