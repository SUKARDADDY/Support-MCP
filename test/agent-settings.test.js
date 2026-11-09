// The built-in agent's settings, keys and models through the team API: who may change
// them, what is stored and shown, the two-turn model check, and which model a task may use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { open } from '../src/crypto.js';
import { agentWorld, BOSS, TECH, VIEW, LEAD, OPENAI_KEY, CLAUDE_KEY, SECRET } from './agent-world.js';
import {
  ant, claudeModel, claudeUsage, CLAUDE_NO_EFFORT_400, OLD_CLAUDE_CAPS, oai, OPENAI_MODEL_403, OPENAI_MODEL_404, OPENAI_NO_REASONING_400, openaiBadKey, openaiUsage,
} from './agent-fakes.js';

// What a model that passes the check answers: it calls look, then reads the word.
const passes = (fake, provider, { word = 'PELICAN', usage } = {}) => {
  if (provider === 'openai') {
    fake.queue('openai', oai.call('look', {}, { usage: usage ?? openaiUsage({ input: 3952, write: 3949, output: 13 }) }), oai.call('answer', { word }, { usage: usage ?? openaiUsage({ input: 5177, cached: 3949, write: 1225, output: 19 }) }));
  } else {
    fake.queue('anthropic', ant.call('look', {}, { usage: usage ?? claudeUsage({ input: 4, create: 7038, output: 24 }) }), ant.call('answer', { word }, { usage: usage ?? claudeUsage({ input: 2, create: 1379, read: 7038, output: 50 }) }));
  }
};
const add = (w, body) => w.api(BOSS, 'POST', '/agent/models', body);
const settings = async (w) => (await w.api(BOSS, 'GET', '/agent')).body.agent;
const models = async (w) => (await settings(w)).models;

// ---- who may change settings -----------------------------------------------------------------
test('settings are for members.manage only: a technician, a viewer and a stranger are refused, and an open default workspace says to add the first admin', async (t) => {
  const w = await agentWorld(t);
  for (const who of [TECH, VIEW, LEAD]) {
    const r = await w.api(who, 'GET', '/agent');
    assert.deepEqual([r.status, r.body.error.code], [403, 'permission_denied'], who);
    assert.match(r.body.error.message, /members\.manage/);
    assert.equal((await w.api(who, 'PATCH', '/agent', { mode: 'agent' })).status, 403);
    assert.equal((await add(w, {})).status, 400, 'an admin with a bad body is a 400, not a 403');
  }
  assert.equal((await w.api('stranger@example.com', 'GET', '/agent')).body.error.code, 'not_member');
  assert.equal((await w.api('stranger@example.com', 'PATCH', '/agent', { mode: 'agent' })).body.error.code, 'not_member');
  const open = await agentWorld(t, { members: false });
  const r = await open.api('anyone@example.com', 'PATCH', '/agent', { mode: 'agent' });
  assert.deepEqual([r.status, r.body.error.code], [409, 'first_member']);
  assert.equal((await open.api('anyone@example.com', 'POST', '/agent/models', { provider: 'openai', id: 'gpt-4.1', prices: { input: 1, output: 1 } })).status, 409);
  assert.equal((await open.api('anyone@example.com', 'DELETE', '/agent/models/openai/gpt-4.1')).status, 409);
  assert.equal(open.settingsRow(), undefined, 'nothing was written');
});

test('a workspace that never touched its settings has mode both, the built-in default model and no caps, so no task can start', async (t) => {
  const w = await agentWorld(t);
  const a = await settings(w);
  assert.deepEqual([a.mode, a.default_model, a.effective_default, a.starters_pick_model, a.task_cap_usd, a.month_cap_usd, a.ready],
    ['both', null, 'gpt-6.1-terra', true, null, null, false]);
  assert.deepEqual(a.keys, { openai: { set: false, hint: null }, anthropic: { set: false, hint: null } });
  assert.deepEqual(a.models, []);
  assert.deepEqual(a.usable_models, []);
  assert.deepEqual(a.table_models.map((m) => m.id), ['gpt-6.1-terra', 'gpt-6.1-sol', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
  assert.equal(w.settingsRow(), undefined);
  assert.deepEqual((await w.api(BOSS, 'GET', '/agent', undefined, 'default')).body.agent.month, { spent_usd: 0, cap_usd: null });
});

test('PATCH changes only the fields sent, shows only the last four characters of a key, and logs field names, never the key', async (t) => {
  const w = await agentWorld(t);
  const first = await w.api(BOSS, 'PATCH', '/agent', { task_cap_usd: 2.5, month_cap_usd: 40, openai_key: OPENAI_KEY, starters_pick_model: false });
  assert.equal(first.status, 200);
  const a = first.body.agent;
  assert.deepEqual([a.task_cap_usd, a.month_cap_usd, a.starters_pick_model, a.mode], [2.5, 40, false, 'both']);
  assert.deepEqual(a.keys, { openai: { set: true, hint: 'WXYZ' }, anthropic: { set: false, hint: null } });
  assert.equal(a.ready, true);
  const second = await w.api(BOSS, 'PATCH', '/agent', { mode: 'agent', anthropic_key: CLAUDE_KEY });
  assert.deepEqual([second.body.agent.mode, second.body.agent.task_cap_usd, second.body.agent.keys.openai.hint, second.body.agent.keys.anthropic.hint], ['agent', 2.5, 'WXYZ', 'QRST']);
  assert.equal(w.settingsRow().task_cap_microusd, 2_500_000);
  assert.equal(w.settingsRow().updated_by, BOSS);
  // No key in any answer, the table, or the log.
  const everything = JSON.stringify([first.body, second.body, (await w.api(BOSS, 'GET', '/agent')).body, await w.log()]);
  for (const key of [OPENAI_KEY, CLAUDE_KEY]) assert.ok(!everything.includes(key), 'a key is shown');
  assert.ok(!everything.includes('CANARY'));
  const rows = (await w.log()).filter((r) => r.kind === 'agent_settings_changed');
  assert.deepEqual(rows.map((r) => [r.actor, r.detail]), [[BOSS, 'starters_pick_model, task_cap_usd, month_cap_usd, openai_key'], [BOSS, 'mode, anthropic_key']]);
  // Removing a key, and clearing a cap.
  const cleared = await w.api(BOSS, 'PATCH', '/agent', { openai_key: null, task_cap_usd: null });
  assert.deepEqual([cleared.body.agent.keys.openai, cleared.body.agent.task_cap_usd], [{ set: false, hint: null }, null]);
  assert.equal(w.settingsRow().openai_key_enc, null);
  // The same value again is no change and no log row.
  const rowsBefore = (await w.log()).length;
  await w.api(BOSS, 'PATCH', '/agent', { mode: 'agent' });
  assert.equal((await w.log()).length, rowsBefore);
});

test('a key is sealed with AES-GCM under AUTH_SECRET with the workspace as associated data, and opens only for that workspace and use', async (t) => {
  const w = await agentWorld(t);
  await w.ready({ keys: ['openai', 'anthropic'] });
  const row = w.settingsRow();
  assert.ok(!row.openai_key_enc.includes('CANARY') && !row.anthropic_key_enc.includes('CANARY'), 'not stored as text');
  assert.equal(await open(SECRET, 'agent-key-openai', row.openai_key_enc, 'default'), OPENAI_KEY);
  assert.equal(await open(SECRET, 'agent-key-anthropic', row.anthropic_key_enc, 'default'), CLAUDE_KEY);
  assert.equal(await open(SECRET, 'agent-key-openai', row.openai_key_enc, 'acme'), null, 'another workspace cannot open it');
  assert.equal(await open(SECRET, 'agent-key-anthropic', row.openai_key_enc, 'default'), null, 'nor the other provider\'s use');
  assert.equal(await open('another-secret-of-at-least-32-characters!', 'agent-key-openai', row.openai_key_enc, 'default'), null, 'nor a rotated secret');
  assert.equal(row.openai_key_hint, 'WXYZ');
});

test('saving a key needs AUTH_SECRET of at least 32 characters; everything else works without one', async (t) => {
  const w = await agentWorld(t, { env: { AUTH_SECRET: 'short' } });
  const r = await w.api(BOSS, 'PATCH', '/agent', { openai_key: OPENAI_KEY });
  assert.deepEqual([r.status, r.body.error.code], [503, 'unavailable']);
  assert.match(r.body.error.message, /AUTH_SECRET/);
  assert.equal(w.settingsRow(), undefined);
  assert.equal((await w.api(BOSS, 'PATCH', '/agent', { month_cap_usd: 10 })).status, 200);
  assert.equal((await w.api(BOSS, 'PATCH', '/agent', { openai_key: null })).status, 200, 'removing a key needs no secret');
});

test('PATCH refuses unknown fields, bad values and an empty body', async (t) => {
  const w = await agentWorld(t);
  const bad = async (body, match) => {
    const r = await w.api(BOSS, 'PATCH', '/agent', body);
    assert.deepEqual([r.status, r.body.error.code], [400, 'bad_request'], JSON.stringify(body));
    assert.match(r.body.error.message, match, JSON.stringify(body));
  };
  await bad({}, /send mode/);
  await bad({ nope: 1 }, /unknown setting: nope/);
  await bad({ mode: 'all' }, /mode must be/);
  await bad({ starters_pick_model: 'yes' }, /true or false/);
  for (const v of [0, -1, '5', 100001]) await bad({ task_cap_usd: v }, /task_cap_usd must be/);
  await bad({ month_cap_usd: 0.0000001 }, /month_cap_usd must be/);
  await bad({ openai_key: 'short' }, /openai_key must be/);
  await bad({ openai_key: 'has a space in it, so it is not a key' }, /openai_key must be/);
  await bad({ anthropic_key: 12 }, /anthropic_key must be/);
  await bad({ default_model: '' }, /model id/);
  assert.equal(w.settingsRow(), undefined);
});

test('an explicit default model must be in the table or added, with its provider\'s key saved', async (t) => {
  const w = await agentWorld(t);
  await w.ready();
  const unknown = await w.api(BOSS, 'PATCH', '/agent', { default_model: 'gpt-4.1' });
  assert.deepEqual([unknown.status, unknown.body.error.code], [400, 'unknown_model']);
  const noKey = await w.api(BOSS, 'PATCH', '/agent', { default_model: 'claude-opus-5-5' });
  assert.deepEqual([noKey.status, noKey.body.error.code], [409, 'no_key']);
  // Both in one request: the key counts.
  const ok = await w.api(BOSS, 'PATCH', '/agent', { default_model: 'claude-opus-5-5', anthropic_key: CLAUDE_KEY });
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.body.agent.default_model, ok.body.agent.effective_default], ['claude-opus-5-5', 'claude-opus-5-5']);
  assert.deepEqual(ok.body.agent.usable_models.map((m) => m.id), ['claude-opus-5-5'], 'the default is usable without being added');
  assert.equal((await w.api(BOSS, 'PATCH', '/agent', { default_model: null })).body.agent.default_model, null);
});

// ---- the model check ---------------------------------------------------------------------------
test('a table model is added without prices, runs the two-turn check, and keeps the table\'s prices; the answer shows the check\'s cost', async (t) => {
  const w = await agentWorld(t);
  await w.ready({ keys: ['openai', 'anthropic'] });
  passes(w.fake, 'anthropic');
  const r = await add(w, { provider: 'anthropic', id: 'claude-sonnet-5-5' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.checked, true);
  assert.deepEqual(r.body.model.prices, { input: 2, cached_input: 0.10, cache_write: 2.5, output: 10 });
  assert.deepEqual(r.body.model.settings, { thinking: 'adaptive', effort: 'medium' });
  assert.equal(r.body.model.output_limit, 16000);
  // Hand figure from step 0's usage: turn 1 is 4 x $2 + 7038 x $2.50 + 24 x $10 = 17,843; turn 2 is 4,655.3 -> 4,656 (rounded per call).
  assert.equal(r.body.check_cost_usd, (17843 + 4656) / 1e6);
  const stored = await models(w);
  assert.equal(stored.length, 1);
  assert.deepEqual([stored[0].provider, stored[0].id, stored[0].prices], ['anthropic', 'claude-sonnet-5-5', null]);
  assert.deepEqual((await w.log()).filter((x) => x.kind === 'agent_settings_changed').map((x) => x.detail).at(-1), 'model added anthropic/claude-sonnet-5-5');
  // Two calls to the provider, each at most 2,048 output tokens, the real image in the second.
  const sent = w.fake.sent('anthropic');
  assert.equal(sent.length, 2);
  assert.ok(sent.every((c) => c.body.max_tokens === 2048));
  assert.ok(sent.every((c) => c.headers['x-stainless-timeout'] === '60'), 'each call of the check times out after 60 seconds');
  assert.equal(sent[0].body.model, 'claude-sonnet-5-5');
  const image = sent[1].body.messages.at(-1).content[0].content[0];
  assert.deepEqual([image.type, image.source.type, image.source.media_type], ['image', 'base64', 'image/png']);
  assert.ok(image.source.data.startsWith('iVBORw0KGgo') && image.source.data.length < 4000, 'a small PNG');
});

test('a model outside the table is refused without prices, and added with them; its prices are the admin\'s and show next to the model', async (t) => {
  const w = await agentWorld(t);
  await w.ready();
  const none = await add(w, { provider: 'openai', id: 'gpt-4.1' });
  assert.deepEqual([none.status, none.body.error.code], [400, 'bad_request']);
  assert.match(none.body.error.message, /needs prices/);
  assert.equal(w.fake.calls.length, 0, 'no provider call');
  for (const prices of [{ input: 2 }, { input: 0, output: 1 }, { input: 'x', output: 1 }]) {
    assert.equal((await add(w, { provider: 'openai', id: 'gpt-4.1', prices })).status, 400);
  }
  assert.equal(w.fake.calls.length, 0);
  passes(w.fake, 'openai');
  w.fake.queue; // (the 400 below is queued first)
  const r = await add(w, { provider: 'openai', id: 'gpt-4.1', prices: { input: 2, cached_input: 0.5, output: 8 } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(r.body.model.prices, { input: 2, cached_input: 0.5, cache_write: 2.5, output: 8 }, 'a cache write defaults to 1.25 times input');
  assert.deepEqual(r.body.model.long_context, null);
  const a = await settings(w);
  assert.deepEqual(a.usable_models.map((m) => m.id), ['gpt-6.1-terra', 'gpt-4.1']);
  assert.deepEqual(a.models[0].prices, { input: 2, cached_input: 0.5, cache_write: 2.5, output: 8 });
  // Prices for a model in the table come from the table.
  assert.match((await add(w, { provider: 'anthropic', id: 'claude-opus-5-5', prices: { input: 1, output: 1 } })).body.error.message, /come from the table/);
});

test('a Claude model whose capabilities say no image input is refused; null capabilities are tried; a retired model is refused', async (t) => {
  const w = await agentWorld(t);
  await w.ready({ keys: ['anthropic'] });
  w.fake.model('anthropic', 'claude-text-only', claudeModel('claude-text-only', { caps: { ...OLD_CLAUDE_CAPS, image_input: { supported: false } } }));
  const noImage = await add(w, { provider: 'anthropic', id: 'claude-text-only', prices: { input: 1, output: 5 } });
  assert.deepEqual([noImage.status, noImage.body.error.code], [422, 'model_refused']);
  assert.equal(noImage.body.error.message, 'this model can\'t read screenshots');
  assert.equal(w.fake.sent('anthropic').length, 0, 'refused before any call that costs');
  w.fake.model('anthropic', 'claude-gone', claudeModel('claude-gone', { lifecycle: 'retired' }));
  assert.equal((await add(w, { provider: 'anthropic', id: 'claude-gone', prices: { input: 1, output: 5 } })).body.error.message, 'this model is retired');
  // Null capabilities: tried as if everything were supported.
  w.fake.model('anthropic', 'claude-unknown', claudeModel('claude-unknown', { caps: null, max_tokens: null }));
  passes(w.fake, 'anthropic');
  const r = await add(w, { provider: 'anthropic', id: 'claude-unknown', prices: { input: 1, output: 5 } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(r.body.model.settings, { thinking: 'adaptive', effort: 'medium' });
  assert.equal(r.body.model.output_limit, 8000, 'no max_tokens: 8,000');
  assert.equal(w.fake.sent('anthropic')[0].body.thinking.type, 'adaptive');
});

test('Claude settings come only from capabilities: an old model gets no thinking and no effort, and a Claude 400 is never retried', async (t) => {
  const w = await agentWorld(t);
  await w.ready({ keys: ['anthropic'] });
  w.fake.model('anthropic', 'claude-haiku-4-5-20251001', claudeModel('claude-haiku-4-5-20251001', { caps: OLD_CLAUDE_CAPS, max_tokens: 64000 }));
  passes(w.fake, 'anthropic');
  const r = await add(w, { provider: 'anthropic', id: 'claude-haiku-4-5-20251001', prices: { input: 1, output: 5 } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(r.body.model.settings, { thinking: null, effort: null });
  assert.equal(r.body.model.output_limit, 16000, 'the lower of 16,000 and the model\'s max_tokens');
  for (const c of w.fake.sent('anthropic')) {
    assert.ok(!('thinking' in c.body) && !('output_config' in c.body), 'neither is sent');
    assert.equal(c.headers['anthropic-beta'], undefined, 'the binding header only goes with thinking');
  }
  // Anthropic's 400 carries no param, so there is nothing to retry: one call, a fixed message.
  w.fake.model('anthropic', 'claude-odd', claudeModel('claude-odd'));
  w.fake.queue('anthropic', { status: 400, json: CLAUDE_NO_EFFORT_400 });
  const before = w.fake.sent('anthropic').length;
  const refused = await add(w, { provider: 'anthropic', id: 'claude-odd', prices: { input: 1, output: 5 } });
  assert.deepEqual([refused.status, refused.body.error.message], [422, 'the provider refused the request']);
  assert.equal(w.fake.sent('anthropic').length - before, 1);
  assert.ok(!JSON.stringify(refused.body).includes('effort parameter'), 'the provider\'s text is not shown');
});

test('a model that calls no tool in turn 1, or gives the wrong word in turn 2, is refused; a reply that ran out of room says so', async (t) => {
  const w = await agentWorld(t);
  await w.ready({ keys: ['openai'] });
  const refuse = async (id) => (await add(w, { provider: 'openai', id, prices: { input: 1, output: 1 } })).body.error;
  w.fake.queue('openai', oai.say('I can see the screen just fine.'));
  assert.equal((await refuse('m-no-tool')).message, 'this model can\'t read screenshots or call tools');
  assert.equal(w.fake.sent('openai').length, 1, 'it stopped at turn 1');
  passes(w.fake, 'openai', { word: 'PENGUIN' });
  assert.equal((await refuse('m-wrong-word')).message, 'this model can\'t read screenshots or call tools');
  w.fake.queue('openai', oai.call('look', {}), oai.call('answer', { word: null }));
  assert.equal((await refuse('m-null-word')).message, 'this model can\'t read screenshots or call tools');
  w.fake.queue('openai', oai.call('answer', { word: 'PELICAN' }));
  assert.equal((await refuse('m-wrong-tool')).message, 'this model can\'t read screenshots or call tools');
  w.fake.queue('openai', oai.say(null, { status: 'incomplete', reasoning: true }));
  assert.equal((await refuse('m-out-of-room')).message, 'the check ran out of room; try again');
  assert.deepEqual(await models(w), [], 'nothing was added');
  // Case does not matter.
  passes(w.fake, 'openai', { word: ' pelican ' });
  assert.equal((await add(w, { provider: 'openai', id: 'm-lower', prices: { input: 1, output: 1 } })).status, 201);
});

test('a 400 naming reasoning is retried once without it and the model is saved without reasoning; a second 400 for it is a refusal', async (t) => {
  const w = await agentWorld(t);
  await w.ready();
  w.fake.queue('openai', { status: 400, json: OPENAI_NO_REASONING_400 });
  passes(w.fake, 'openai');
  const r = await add(w, { provider: 'openai', id: 'gpt-4.1', prices: { input: 2, output: 8 } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(r.body.model.settings, { reasoning_effort: null });
  const sent = w.fake.sent('openai');
  assert.equal(sent.length, 3, 'the refused try, then the two turns');
  assert.deepEqual(sent[0].body.reasoning, { effort: 'medium' });
  assert.ok(!('reasoning' in sent[1].body) && !('reasoning' in sent[2].body), 'sent without reasoning from then on');
  assert.equal(r.body.model.output_limit, 8000);
  // Each retry is made at most once: a second 400 for the same parameter ends it.
  w.fake.queue('openai', { status: 400, json: OPENAI_NO_REASONING_400 }, { status: 400, json: OPENAI_NO_REASONING_400 });
  const again = await add(w, { provider: 'openai', id: 'gpt-4o', prices: { input: 2, output: 8 } });
  assert.deepEqual([again.status, again.body.error.message], [422, 'the provider refused the request']);
});

test('a 400 naming max_output_tokens is retried once with 4,000; an output limit under 4,000 is refused', async (t) => {
  const w = await agentWorld(t);
  await w.ready();
  w.fake.queue('openai', { status: 400, json: { error: { message: 'x', type: 'invalid_request_error', param: 'max_output_tokens', code: 'invalid_value' } } });
  passes(w.fake, 'openai');
  const r = await add(w, { provider: 'openai', id: 'gpt-small', prices: { input: 1, output: 1 } });
  assert.equal(r.status, 201);
  assert.equal(r.body.model.output_limit, 4000);
  assert.equal(w.fake.sent('openai')[1].body.max_output_tokens, 4000);
  const small = await add(w, { provider: 'openai', id: 'gpt-tiny', prices: { input: 1, output: 1 }, output_limit: 3999 });
  assert.deepEqual([small.status, small.body.error.message], [400, 'output limit too small']);
  w.fake.model('anthropic', 'claude-tiny', claudeModel('claude-tiny', { max_tokens: 3000 }));
  await w.api(BOSS, 'PATCH', '/agent', { anthropic_key: CLAUDE_KEY });
  const claude = await add(w, { provider: 'anthropic', id: 'claude-tiny', prices: { input: 1, output: 1 } });
  assert.deepEqual([claude.status, claude.body.error.message], [422, 'output limit too small']);
  assert.equal(w.fake.sent('anthropic').length, 0);
  // The check's own calls always ask for 2,048 at most, and an admin's limit is saved as given.
  passes(w.fake, 'openai');
  const set = await add(w, { provider: 'openai', id: 'gpt-set', prices: { input: 1, output: 1 }, output_limit: 12000 });
  assert.equal(set.body.model.output_limit, 12000);
  assert.ok(w.fake.sent('openai').slice(-2).every((c) => c.body.max_output_tokens === 2048));
});

test('replayed OpenAI reasoning items carry their encrypted content, and every request sends store false', async (t) => {
  const w = await agentWorld(t);
  await w.ready();
  passes(w.fake, 'openai');
  assert.equal((await add(w, { provider: 'openai', id: 'gpt-6.1-sol' })).status, 201);
  const [one, two] = w.fake.sent('openai');
  for (const c of [one, two]) {
    assert.deepEqual(c.body.include, ['reasoning.encrypted_content']);
    assert.equal(c.body.store, false);
    assert.equal(c.body.service_tier, 'default');
  }
  const reasoning = two.body.input.find((i) => i.type === 'reasoning');
  assert.match(reasoning.encrypted_content, /^enc_/);
  assert.deepEqual(two.body.input.map((i) => i.type ?? i.role), ['user', 'reasoning', 'function_call', 'function_call_output'], 'in the order the model gave them');
});

test('a key that cannot use the model: the record read answers 404 and a call answers 403, and both say so in fixed words', async (t) => {
  const w = await agentWorld(t);
  await w.ready();
  w.fake.model('openai', 'gpt-6.1-sol', { status: 404, json: OPENAI_MODEL_404 });
  const a = await add(w, { provider: 'openai', id: 'gpt-6.1-sol' });
  assert.deepEqual([a.status, a.body.error.message], [422, 'your key can\'t use this model, or it is no longer available']);
  assert.equal(w.fake.sent('openai').length, 0);
  w.fake.queue('openai', { status: 403, json: OPENAI_MODEL_403 });
  const b = await add(w, { provider: 'openai', id: 'gpt-hidden', prices: { input: 1, output: 1 } });
  assert.equal(b.body.error.message, 'your key can\'t use this model, or it is no longer available');
  assert.ok(!JSON.stringify(b.body).includes('proj_'), 'the provider\'s text is not shown');
  assert.deepEqual(await models(w), []);
});

test('an unreachable provider, a bad key and billing on the check each say so in fixed words', async (t) => {
  const w = await agentWorld(t);
  await w.ready();
  const msg = async (reply) => { w.fake.queue('openai', reply); return (await add(w, { provider: 'openai', id: 'gpt-x', prices: { input: 1, output: 1 } })).body.error.message; };
  assert.equal(await msg({ status: 401, json: openaiBadKey(OPENAI_KEY) }), 'the provider did not accept the team\'s key; enter it again');
  assert.equal(await msg({ status: 503, json: { error: { message: 'overloaded' } } }), 'the provider is busy or cannot be reached');
  assert.equal(await msg({ status: 429, json: { error: { message: 'You exceeded your current quota', type: 'insufficient_quota', code: 'insufficient_quota' } } }), 'the provider says the team\'s account is out of credit or at its spending limit');
  assert.equal(await msg({ status: 429, json: { error: { message: 'slow down', type: 'requests', code: 'rate_limit_exceeded' } } }), 'the provider is busy or cannot be reached');
});

test('the check needs the provider\'s key saved, and a team adds at most ten models', async (t) => {
  const w = await agentWorld(t);
  await w.ready({ keys: ['openai'] });
  const r = await add(w, { provider: 'anthropic', id: 'claude-opus-5-5' });
  assert.deepEqual([r.status, r.body.error.code], [409, 'no_key']);
  assert.equal(w.fake.calls.length, 0);
  for (let i = 0; i < 10; i++) {
    passes(w.fake, 'openai');
    assert.equal((await add(w, { provider: 'openai', id: `gpt-m${i}`, prices: { input: 1, output: 1 } })).status, 201, `model ${i}`);
  }
  const before = w.fake.calls.length;
  const eleventh = await add(w, { provider: 'openai', id: 'gpt-m10', prices: { input: 1, output: 1 } });
  assert.deepEqual([eleventh.status, eleventh.body.error.code], [409, 'model_limit']);
  assert.equal(w.fake.calls.length, before, 'refused before any provider call');
  assert.equal((await models(w)).length, 10);
});

test('bad model bodies are refused before any provider call', async (t) => {
  const w = await agentWorld(t);
  await w.ready();
  for (const body of [{}, { provider: 'google', id: 'x' }, { provider: 'openai' }, { provider: 'openai', id: '../x' }, { provider: 'openai', id: 'a b' }, { provider: 'openai', id: 'x'.repeat(101) },
    { provider: 'openai', id: 'gpt-x', prices: { input: 1, output: 1 }, extra: 1 }, { provider: 'openai', id: 'gpt-x', prices: { input: 1, output: 1 }, output_limit: 'big' }]) {
    const r = await add(w, body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  assert.equal(w.fake.calls.length, 0);
});

test('a clash on the model list is a 409 that makes no second provider call; a retry afterwards works', async (t) => {
  const w = await agentWorld(t);
  await w.ready();
  // While the check runs, another admin adds a model: the list the check read is stale.
  w.fake.queue('openai', oai.call('look', {}), async () => {
    await w.team.addMember('default', BOSS, { identity: 'admin2@example.com', role_id: 'admin' });
    const raw = JSON.stringify([{ provider: 'openai', id: 'gpt-other', prices: { input: 1, cached_input: 1, cache_write: 1.25, output: 1 }, output_limit: 8000, settings: {}, checked_at: 1 }]);
    w.sql("INSERT INTO agent_settings(workspace, models, updated_at, updated_by) VALUES ('default', ?, 1, 'x') ON CONFLICT(workspace) DO UPDATE SET models = excluded.models", raw);
    return oai.call('answer', { word: 'PELICAN' });
  });
  const r = await add(w, { provider: 'openai', id: 'gpt-mine', prices: { input: 1, output: 1 } });
  assert.deepEqual([r.status, r.body.error.code], [409, 'try_again']);
  assert.equal(w.fake.sent('openai').length, 2, 'the two turns of the one check, and no more');
  assert.deepEqual((await models(w)).map((m) => m.id), ['gpt-other'], 'the other admin\'s list stands');
  passes(w.fake, 'openai');
  assert.equal((await add(w, { provider: 'openai', id: 'gpt-mine', prices: { input: 1, output: 1 } })).status, 201);
  assert.deepEqual((await models(w)).map((m) => m.id), ['gpt-other', 'gpt-mine']);
});

test('new prices for a model already added make no provider call, and the log names who changed them', async (t) => {
  const w = await agentWorld(t);
  await w.ready();
  passes(w.fake, 'openai');
  await add(w, { provider: 'openai', id: 'gpt-4.1', prices: { input: 2, output: 8 } });
  const before = w.fake.calls.length;
  const r = await add(w, { provider: 'openai', id: 'gpt-4.1', prices: { input: 3, output: 9 } });
  assert.equal(r.status, 201);
  assert.equal(r.body.checked, false);
  assert.equal(w.fake.calls.length, before, 'no provider call');
  assert.deepEqual((await models(w))[0].prices, { input: 3, cached_input: 3, cache_write: 3.75, output: 9 });
  assert.deepEqual((await models(w))[0].output_limit, 8000, 'the check\'s findings stay');
  const rows = (await w.log()).filter((x) => x.kind === 'agent_settings_changed');
  assert.deepEqual([rows.at(-1).actor, rows.at(-1).detail], [BOSS, 'prices openai/gpt-4.1']);
  // A table model's prices cannot be changed this way.
  assert.equal((await add(w, { provider: 'openai', id: 'gpt-6.1-terra', prices: { input: 1, output: 1 } })).status, 400);
});

test('removing a model deletes it from the list, needs members.manage, and clears it as the default', async (t) => {
  const w = await agentWorld(t);
  await w.ready();
  passes(w.fake, 'openai');
  await add(w, { provider: 'openai', id: 'gpt-4.1', prices: { input: 2, output: 8 } });
  await w.api(BOSS, 'PATCH', '/agent', { default_model: 'gpt-4.1' });
  assert.equal((await w.api(TECH, 'DELETE', '/agent/models/openai/gpt-4.1')).status, 403);
  assert.equal((await w.api(BOSS, 'DELETE', '/agent/models/openai/nope')).status, 404);
  assert.equal((await w.api(BOSS, 'DELETE', '/agent/models/google/gpt-4.1')).status, 404);
  assert.equal((await w.api(BOSS, 'DELETE', '/agent/models/openai')).status, 404);
  assert.equal((await w.api(BOSS, 'GET', '/agent/models/openai/gpt-4.1')).status, 405);
  const r = await w.api(BOSS, 'DELETE', '/agent/models/openai/gpt-4.1');
  assert.deepEqual([r.status, r.body], [200, { removed: true }]);
  const a = await settings(w);
  assert.deepEqual([a.models, a.default_model, a.effective_default], [[], null, 'gpt-6.1-terra']);
  assert.equal((await w.log()).filter((x) => x.kind === 'agent_settings_changed').at(-1).detail, 'model removed openai/gpt-4.1');
});

test('the agent routes admit only the methods they name, and nothing deeper', async (t) => {
  const w = await agentWorld(t);
  assert.equal((await w.api(BOSS, 'DELETE', '/agent')).status, 405);
  assert.equal((await w.api(BOSS, 'GET', '/agent/models')).status, 405);
  assert.equal((await w.api(BOSS, 'PUT', '/agent/tasks', {})).status, 405);
  assert.equal((await w.api(BOSS, 'GET', '/agent/nope')).status, 404);
  assert.equal((await w.api(BOSS, 'GET', '/agent/tasks/aaaaaaaaaaaaaaaaaaaa/pause')).status, 405);
  assert.equal((await w.api(BOSS, 'GET', '/agent/')).status, 404);
  assert.equal((await w.api(BOSS, 'POST', '/agent/tasks/aaaaaaaaaaaaaaaaaaaa/jump', {})).status, 404);
  assert.equal((await w.api(BOSS, 'GET', '/agent/tasks/aaaaaaaaaaaaaaaaaaaa/x/y')).status, 404);
});
