// The built-in agent's runner: one step per alarm against fake providers and a fake PC.
// Each test drives AgentTask objects the way Cloudflare's alarms would, with time moved by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentWorld, BOSS, TECH, VIEW, LEAD, OPENAI_KEY, CLAUDE_KEY, JPEG, shot } from './agent-world.js';
import { ant, claudeUsage, oai, openaiUsage } from './agent-fakes.js';

const NOW = 1_800_000_000_000;
const tools = (call) => (call.body.tools ?? []).map((t) => t.name);

// ---- the loop, on both adapters ----------------------------------------------------------------
test('OpenAI: the loop runs a task to its end, marks the session log "via agent", stores only redacted steps, and ends the session it opened', async (t) => {
  const w = await agentWorld(t);
  await w.ready();
  w.fake.queue('openai',
    oai.call('note', { text: 'The queue is stuck; I will clear it.' }),
    oai.call('click', { x: 640, y: 412, button: null, count: null, display: null, screenshot: null }),
    oai.call('type_text', { text: 'my password is hunter2', display: null, screenshot: null }),
    oai.call('run', { command: 'Get-Printer', timeout_s: null, as: 'system' }),
    oai.call('finish', { outcome: 'done', summary: 'Cleared the print queue. The printer prints again.' }));
  const { id, pc, joined } = await w.startOnPc(BOSS);
  await w.drive(id);
  const row = w.taskRow(id);
  assert.deepEqual([row.state, row.end_reason, row.summary, row.steps, row.opened_session], ['done', 'finished', 'Cleared the print queue. The printer prints again.', 4, 1]);
  assert.deepEqual(joined.frames.map((f) => f.type + (f.action ? `:${f.action.name}` : '')), ['screen:screenshot', 'screen:click', 'screen:type', 'run'], 'the PC saw the screenshot, the click, the typing and the command');
  assert.deepEqual([joined.frames[3].command, joined.frames[3].as], ['Get-Printer', 'system'], 'as: system is allowed');
  // The saved-PC session the task opened is over, and the PC is free.
  assert.equal(w.stateOf(row.sid), 'ended');
  assert.equal(w.pointer(pc.id), null);
  // The session log marks the agent's actions, and the actor stays the starter.
  const log = await w.tool(BOSS, 'session_status', { session_id: row.sid, log_tail: 50 });
  const acts = log.log.filter((r) => ['screen', 'run'].includes(r.kind)).map((r) => r.detail);
  assert.deepEqual(acts, ['[boss@example.com via agent] screenshot 1280x800', '[boss@example.com via agent] click 640,412', '[boss@example.com via agent] type 22 chars', '[boss@example.com via agent] (system) Get-Printer']);
  // The step record: verbs and short details. Typed text, images and the model's words are not stored.
  const st = w.step(id);
  assert.deepEqual(st.steps.map((s) => [s.verb, s.detail]), [['screenshot', 'new conversation'], ['click', '640,412'], ['type_text', '22 chars'], ['run', '(system) Get-Printer']]);
  assert.deepEqual(st.notes.map((n) => n.text), ['The queue is stuck; I will clear it.']);
  const everything = JSON.stringify([...w.taskObject(id).ctx.values.entries(), w.taskRow(id), await w.log(), await w.team.readAudit('default', { limit: 500 })]);
  for (const needle of ['hunter2', JPEG, 'enc_', 'password is']) assert.ok(!everything.includes(needle), `${needle} was stored`);
  // The team log: started and ended, with ids and the outcome.
  const rows = (await w.log()).filter((r) => r.kind.startsWith('agent_task'));
  assert.deepEqual(rows.map((r) => [r.kind, r.actor]), [['agent_task_started', BOSS], ['agent_task_ended', 'relay']]);
  assert.equal(rows[0].detail, `${id} openai/gpt-6.1-terra pc ${pc.id}`);
  assert.equal(rows[1].detail, `${id} done finished`);
});

test('OpenAI requests: store false, service tier default, one call at a time, strict schemas, reasoning effort, the key in the header only, and the task id as the cache key', async (t) => {
  const w = await agentWorld(t);
  await w.ready();
  w.fake.queue('openai', oai.call('screenshot', { display: null }), oai.call('finish', { outcome: 'done', summary: 'ok' }));
  const { id } = await w.startOnPc(BOSS);
  await w.drive(id);
  const [first, second] = w.fake.sent('openai');
  for (const c of [first, second]) {
    assert.equal(c.path, '/v1/responses');
    assert.deepEqual([c.body.store, c.body.service_tier, c.body.parallel_tool_calls, c.body.truncation], [false, 'default', false, 'disabled']);
    assert.deepEqual(c.body.include, ['reasoning.encrypted_content']);
    assert.deepEqual(c.body.reasoning, { effort: 'medium' });
    assert.equal(c.body.model, 'gpt-6.1-terra');
    assert.equal(c.body.prompt_cache_key, id);
    assert.equal(c.headers.authorization, `Bearer ${OPENAI_KEY}`);
    assert.ok(!JSON.stringify(c.body).includes('CANARY'), 'the key is not in the body');
    assert.match(c.body.instructions, /untrusted/);
    assert.deepEqual(tools(c), ['session_status', 'run', 'put_file', 'get_file', 'restart_pc', 'shutdown_pc', 'list_programs', 'install_program', 'uninstall_program', 'close_program', 'screenshot', 'click', 'move_mouse', 'drag', 'scroll', 'type_text', 'press_key', 'wait', 'zoom', 'ui_tree', 'ui_act', 'note', 'finish']);
    for (const tool of c.body.tools) {
      assert.deepEqual([tool.type, tool.strict, tool.parameters.additionalProperties], ['function', true, false], tool.name);
      assert.deepEqual([...tool.parameters.required].sort(), Object.keys(tool.parameters.properties).sort(), `${tool.name}: every property is required`);
      assert.ok(!('session_id' in tool.parameters.properties), tool.name);
    }
  }
  // The first user message holds the task and the screenshot taken at the start.
  const user = first.body.input[0];
  assert.equal(user.role, 'user');
  assert.match(user.content[0].text, /^Task from boss@example\.com:\nThe printer stopped printing\./);
  assert.deepEqual([user.content[1].type, user.content[1].detail], ['input_image', 'original']);
  assert.ok(user.content[1].image_url.startsWith(`data:image/jpeg;base64,${JPEG}`));
  // The output limit is the model's own (25,000) when the caps leave room.
  assert.equal(first.body.max_output_tokens, 25000);
});

test('OpenAI replays the whole conversation each turn, append-only: reasoning items, calls and results in order, a screenshot inside the function_call_output', async (t) => {
  const w = await agentWorld(t);
  await w.ready();
  w.fake.queue('openai',
    oai.call('screenshot', { display: null }),
    oai.call('click', { x: 1, y: 2, button: null, count: null, display: null, screenshot: null }),
    oai.call('finish', { outcome: 'done', summary: 'ok' }));
  const { id } = await w.startOnPc(BOSS);
  await w.drive(id);
  const [one, two, three] = w.fake.sent('openai');
  assert.equal(one.body.input.length, 1);
  const kinds = (c) => c.body.input.map((i) => i.type ?? i.role);
  assert.deepEqual(kinds(two), ['user', 'reasoning', 'function_call', 'function_call_output']);
  assert.deepEqual(kinds(three), ['user', 'reasoning', 'function_call', 'function_call_output', 'reasoning', 'function_call', 'function_call_output']);
  // Append-only: each request begins with the whole of the one before it.
  assert.deepEqual(three.body.input.slice(0, 4), two.body.input);
  assert.match(two.body.input[1].encrypted_content, /^enc_/, 'the reasoning item keeps its encrypted content');
  const out = two.body.input[3];
  assert.equal(out.call_id, two.body.input[2].call_id);
  assert.ok(Array.isArray(out.output), 'a screenshot goes inside the function_call_output');
  assert.deepEqual(out.output.map((p) => p.type), ['input_image', 'input_text'], 'the image first, then what the relay said about it');
  assert.deepEqual(out.output[0].detail, 'original');
  assert.match(out.output[1].text, /^<untrusted label="result of screenshot">/, 'the text that came from the PC is marked');
});

test('Claude: the loop runs the same, with adaptive thinking bound to the history, effort, caching, and a screenshot inside the tool_result', async (t) => {
  const w = await agentWorld(t);
  await w.ready({ keys: ['anthropic'] });
  w.fake.queue('anthropic',
    ant.call('screenshot', { display: null }),
    ant.call('click', { x: 5, y: 6 }),
    ant.call('finish', { outcome: 'done', summary: 'Fixed.' }));
  const { id, joined } = await w.startOnPc(BOSS);
  await w.drive(id);
  const row = w.taskRow(id);
  assert.deepEqual([row.state, row.provider, row.model, row.summary], ['done', 'anthropic', 'claude-sonnet-5-5', 'Fixed.']);
  assert.deepEqual(joined.frames.map((f) => f.action?.name), ['screenshot', 'screenshot', 'click']);
  const [one, two, three] = w.fake.sent('anthropic');
  for (const c of [one, two, three]) {
    assert.equal(c.path, '/v1/messages');
    assert.equal(c.headers['x-api-key'], CLAUDE_KEY);
    assert.equal(c.headers['anthropic-beta'], 'thinking-binding-controls-2026-08-01');
    assert.deepEqual(c.body.thinking, { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } });
    assert.deepEqual(c.body.output_config, { effort: 'medium' });
    assert.equal(c.body.max_tokens, 16000);
    assert.equal(c.headers['x-stainless-timeout'], '180', 'a task\'s call may take 3 minutes');
    assert.equal(c.headers['anthropic-version'], '2023-06-01', 'the version step 0 verified');
    assert.deepEqual(c.body.tool_choice, { type: 'auto', disable_parallel_tool_use: true });
    assert.deepEqual(c.body.system[0].cache_control, { type: 'ephemeral' });
    assert.deepEqual(c.body.tools.at(-1).cache_control, { type: 'ephemeral' });
    assert.equal(c.body.tools.filter((x) => x.cache_control).length, 1);
    const lastMessage = c.body.messages.at(-1);
    assert.deepEqual(lastMessage.content.at(-1).cache_control, { type: 'ephemeral' }, 'caching on the tail');
    assert.equal(c.body.tools.find((x) => x.name === 'click').input_schema.required.includes('session_id'), false);
    assert.ok(!JSON.stringify(c.body).includes('CANARY'));
  }
  // Append-only, and the thinking block comes back as the model gave it.
  assert.deepEqual(two.body.messages.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.deepEqual(three.body.messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant', 'user']);
  assert.deepEqual(three.body.messages[1], two.body.messages[1]);
  assert.deepEqual(two.body.messages[1].content[0], { type: 'thinking', thinking: 'thinking about it', signature: two.body.messages[1].content[0].signature });
  assert.match(two.body.messages[1].content[0].signature, /^sig_/);
  const result = two.body.messages[2].content[0];
  assert.equal(result.type, 'tool_result');
  assert.equal(result.tool_use_id, two.body.messages[1].content[1].id);
  assert.deepEqual(result.content.map((p) => p.type), ['image', 'text']);
  assert.deepEqual([result.content[0].source.type, result.content[0].source.media_type], ['base64', 'image/jpeg']);
  // The cache marks sit on copies: the earlier messages carry none.
  assert.ok(!JSON.stringify(three.body.messages.slice(0, -1)).includes('cache_control'));
});

test('cost comes from all the usage fields, once per provider: OpenAI subtracts cached and cache-write tokens from input, Claude\'s input is the uncached rest', async (t) => {
  const w = await agentWorld(t);
  await w.ready({ keys: ['openai', 'anthropic'], extra: { default_model: 'gpt-6.1-terra' } });
  // Terra: 3 + 3949 x 0.05 + 1225 x 1.25 + 19 x 5 = 1826.7 -> 1827; then 100 in, 10 out = 150 -> total 1977.
  w.fake.queue('openai',
    oai.call('screenshot', { display: null }, { usage: openaiUsage({ input: 5177, cached: 3949, write: 1225, output: 19 }) }),
    oai.call('finish', { outcome: 'done', summary: 'ok' }, { usage: openaiUsage({ input: 100, output: 10 }) }));
  const a = await w.startOnPc(BOSS);
  await w.drive(a.id);
  assert.equal(w.taskRow(a.id).cost_microusd, 1827 + 150);
  assert.equal(w.taskRow(a.id).reserved_microusd, 0);
  // Sonnet: 2 x 2 + 1379 x 2.5 + 7038 x 0.1 + 50 x 10 = 4655.3 -> 4656; then 1 in, 5 out = 52 -> total 4708.
  await w.api(BOSS, 'PATCH', '/agent', { default_model: 'claude-sonnet-5-5' });
  w.fake.queue('anthropic',
    ant.call('screenshot', { display: null }, { usage: claudeUsage({ input: 2, create: 1379, read: 7038, output: 50 }) }),
    ant.call('finish', { outcome: 'done', summary: 'ok' }, { usage: claudeUsage({ input: 1, output: 5 }) }));
  const b = await w.startOnPc(BOSS);
  await w.drive(b.id);
  assert.equal(w.taskRow(b.id).cost_microusd, 4656 + 52);
  // The status shows the cost and the prices beside it.
  const status = await w.tool(BOSS, 'agent_status', { task_id: b.id });
  assert.equal(status.task.cost_usd, 0.004708);
  assert.deepEqual(status.task.prices, { input: 2, cached_input: 0.1, cache_write: 2.5, output: 10 });
  assert.deepEqual([status.caps.task_cap_usd, status.caps.month_cap_usd, status.caps.month_spent_usd], [5, 50, (1977 + 4708) / 1e6]);
});

// ---- a reply with no tool call, several calls, bad calls ------------------------------------------
test('a reply with no tool call gets "Call a tool, or call finish."; two in a row end the task as stuck; a tool call in between resets the count', async (t) => {
  const w = await agentWorld(t);
  await w.ready();
  w.fake.queue('openai',
    oai.say('I think the printer is fine.'),
    oai.call('screenshot', { display: null }),
    oai.say('Hmm.', { reasoning: true }),
    oai.call('finish', { outcome: 'done', summary: 'ok' }));
  const a = await w.startOnPc(BOSS);
  await w.drive(a.id);
  assert.equal(w.taskRow(a.id).state, 'done', 'one at a time never ends the task');
  const sent = w.fake.sent('openai');
  const nudge = sent[1].body.input.at(-1);
  assert.deepEqual([nudge.role, nudge.content[0].text], ['user', 'Call a tool, or call finish.']);
  assert.equal(sent[1].body.input[1].type, 'message', 'the model\'s words stay in the conversation');
  // Two in a row.
  w.fake.queue('openai', oai.say('Done, I think.'), oai.say('Really done.'));
  const b = await w.startOnPc(BOSS);
  await w.drive(b.id);
  assert.deepEqual([w.taskRow(b.id).state, w.taskRow(b.id).end_reason], ['stuck', 'the model stopped calling tools']);
  assert.equal(w.stateOf(w.taskRow(b.id).sid), 'ended');
});

test('a reply that ran out of output is answered like one with no tool call, and its calls are not run', async (t) => {
  const w = await agentWorld(t);
  await w.ready();
  w.fake.queue('openai',
    oai.say(null, { status: 'incomplete', reasoning: true }),
    oai.call('screenshot', { display: null }),
    oai.call('finish', { outcome: 'done', summary: 'ok' }));
  const a = await w.startOnPc(BOSS);
  await w.drive(a.id);
  assert.equal(w.taskRow(a.id).state, 'done');
  const second = w.fake.sent('openai')[1].body.input;
  assert.deepEqual(second.map((i) => i.type ?? i.role), ['user', 'user'], 'a lone reasoning item is not replayed');
  assert.equal(second[1].content[0].text, 'Your reply was cut off. Call a tool, or call finish.');
  // Claude: a cut-off reply with a call is answered in the tool result.
  await w.api(BOSS, 'PATCH', '/agent', { anthropic_key: CLAUDE_KEY, default_model: 'claude-sonnet-5-5' });
  const cut = ant.call('click', { x: 1, y: 2 });
  cut.stop_reason = 'max_tokens';
  w.fake.queue('anthropic', cut, ant.call('screenshot', {}), ant.call('finish', { outcome: 'done', summary: 'ok' }));
  const b = await w.startOnPc(BOSS);
  await w.drive(b.id);
  assert.equal(w.taskRow(b.id).state, 'done');
  assert.equal(b.joined.frames.filter((f) => f.action?.name === 'click').length, 0, 'the cut-off click was not run');
  const turn = w.fake.sent('anthropic')[1].body.messages.at(-1).content;
  assert.deepEqual(turn.map((c) => c.type), ['tool_result', 'text']);
  assert.equal(turn[0].is_error, true);
});

test('several calls in one reply run only the first; the rest are answered "not run"; an unknown tool, type_secret and bad arguments are answered and never reach the PC', async (t) => {
  const w = await agentWorld(t);
  await w.ready();
  const two = oai.call('click', { x: 1, y: 2, button: null, count: null, display: null, screenshot: null });
  two.output.push({ id: 'fc_x', type: 'function_call', call_id: 'call_second', name: 'press_key', arguments: '{"keys":"Return"}', status: 'completed' });
  w.fake.queue('openai',
    two,
    oai.call('type_secret', { text: 'hunter2' }),
    oai.call('request_full_control', {}),
    oai.call('device_connect', { device_id: 'a'.repeat(20) }),
    oai.call('click', '{not json'),
    oai.call('click', { x: 'left', y: 2 }),
    oai.call('screenshot', { display: null, session_id: 'f'.repeat(64) }),
    oai.call('finish', { outcome: 'nonsense', summary: 'x' }),
    oai.call('finish', { outcome: 'needs_human', summary: 'A password is needed to sign in.' }));
  const a = await w.startOnPc(BOSS);
  await w.drive(a.id);
  const row = w.taskRow(a.id);
  assert.deepEqual([row.state, row.end_reason, row.summary], ['stuck', 'finished: needs a person', 'A password is needed to sign in.']);
  const frames = a.joined.frames.map((f) => f.action?.name);
  assert.deepEqual(frames, ['screenshot', 'click', 'screenshot'], 'the first click, and the last screenshot: nothing else reached the PC');
  assert.equal(a.joined.frames.at(-1).action.display, 0);
  const inputs = w.fake.sent('openai').map((c) => c.body.input);
  const outputs = (input) => input.filter((i) => i.type === 'function_call_output').map((i) => (typeof i.output === 'string' ? i.output : i.output.map((p) => p.text ?? '[image]').join(' ')));
  const last = outputs(inputs.at(-1));
  assert.match(last[0], /<untrusted label="result of click">/, 'the click ran');
  assert.equal(last[1], 'Only one tool call per reply. This one was not run.', 'the second call of the first reply');
  assert.deepEqual(last.slice(2, 6), ['unknown tool', 'unknown tool', 'unknown tool', 'the arguments were not a JSON object; call again']);
  assert.match(last[6], /argument|must be a whole number|x must/, 'the relay\'s own validation answered a bad x');
  assert.match(last[8], /^outcome must be done/);
});

// ---- idempotency --------------------------------------------------------------------------------
test('an action already sent is never sent again: a repeat alarm after a crash sends nothing and tells the model "outcome unknown; take a screenshot"', async (t) => {
  const w = await agentWorld(t);
  await w.ready();
  w.fake.queue('openai',
    oai.call('click', { x: 10, y: 20, button: null, count: null, display: null, screenshot: null }),
    oai.call('screenshot', { display: null }),
    oai.call('finish', { outcome: 'done', summary: 'ok' }));
  const a = await w.startOnPc(BOSS);
  // The object dies after the click went out and before its result was saved.
  let crashes = 0;
  w.hooks.fail = (point) => { if (point === 'afterSend' && !crashes++) throw new Error('crash'); };
  await assert.rejects(w.drive(a.id), /crash/);
  assert.equal(a.joined.frames.filter((f) => f.action?.name === 'click').length, 1, 'the click went out once');
  assert.equal(w.step(a.id).pending.state, 'sending', 'it was recorded as "sending" before it went out');
  // The platform runs the alarm again.
  await w.drive(a.id);
  assert.equal(a.joined.frames.filter((f) => f.action?.name === 'click').length, 1, 'the repeat alarm sent nothing');
  assert.equal(w.taskRow(a.id).state, 'done');
  const next = w.fake.sent('openai')[1].body.input;
  const answered = next.filter((i) => i.type === 'function_call_output');
  assert.deepEqual(answered.map((i) => i.output), ['outcome unknown; take a screenshot']);
  assert.equal(answered[0].call_id, next.find((i) => i.type === 'function_call').call_id);
  assert.ok(w.step(a.id).steps.some((s) => s.verb === 'unknown'));
});

test('after a restart the conversation is gone: a fresh one starts from the last note and a new screenshot, and says the last action may not have reached the PC', async (t) => {
  const w = await agentWorld(t);
  await w.ready();
  w.fake.queue('openai',
    oai.call('note', { text: 'Found the spooler stopped.' }),
    oai.call('run', { command: 'Restart-Service spooler', timeout_s: null, as: null }),
    oai.call('finish', { outcome: 'done', summary: 'ok' }));
  const a = await w.startOnPc(BOSS);
  let crashes = 0;
  w.hooks.fail = (point) => { if (point === 'afterSend' && !crashes++) throw new Error('crash'); };
  await assert.rejects(w.drive(a.id), /crash/);
  w.restart(a.id);
  await w.drive(a.id);
  assert.equal(a.joined.frames.filter((f) => f.type === 'run').length, 1, 'the command was not sent again');
  const [, , third] = w.fake.sent('openai');
  assert.equal(third.body.input.length, 1, 'a new conversation, not a continuation');
  const text = third.body.input[0].content[0].text;
  assert.match(text, /<untrusted label="your last progress note in this task">\nFound the spooler stopped\.\n<\/untrusted>/);
  assert.match(text, /may or may not have reached the PC/);
  assert.equal(third.body.input[0].content[1].type, 'input_image', 'with a new screenshot');
  assert.equal(w.taskRow(a.id).state, 'done');
});

test('Stop pressed during a model call means the action is not sent; so does Pause, and the call is answered when the task resumes', async (t) => {
  const w = await agentWorld(t);
  await w.ready();
  // Stop.
  const stopDuring = async () => {
    await w.tool(BOSS, 'agent_control', { task_id: stopped.id, action: 'stop' });
    return oai.call('click', { x: 1, y: 2, button: null, count: null, display: null, screenshot: null });
  };
  const stopped = await w.startOnPc(BOSS);
  w.fake.queue('openai', stopDuring);
  await w.drive(stopped.id);
  assert.equal(w.taskRow(stopped.id).state, 'stopped');
  assert.equal(stopped.joined.frames.filter((f) => f.action?.name === 'click').length, 0, 'the click was never sent');
  assert.equal(w.stateOf(w.taskRow(stopped.id).sid), 'ended', 'and the session the task opened is over');
  // Pause.
  const paused = await w.startOnPc(BOSS);
  w.fake.queue('openai', async () => {
    await w.tool(BOSS, 'agent_control', { task_id: paused.id, action: 'pause' });
    return oai.call('click', { x: 1, y: 2, button: null, count: null, display: null, screenshot: null });
  }, oai.call('finish', { outcome: 'done', summary: 'ok' }));
  await w.drive(paused.id, { stop: () => w.taskRow(paused.id).state === 'paused' });
  assert.equal(w.taskRow(paused.id).state, 'paused');
  assert.equal(paused.joined.frames.filter((f) => f.action?.name === 'click').length, 0);
  const calls = w.fake.sent('openai').length;
  await w.alarm(paused.id); // a stray alarm does nothing while paused
  assert.equal(w.taskObject(paused.id).ctx.alarm(), w.taskRow(paused.id).created_at + 2 * 3600_000, 'a paused task keeps one alarm: the time limit');
  assert.equal(w.fake.sent('openai').length, calls, 'no model call while paused');
  await w.tool(BOSS, 'agent_control', { task_id: paused.id, action: 'resume' });
  await w.drive(paused.id);
  assert.equal(w.taskRow(paused.id).state, 'done');
  const answered = w.fake.sent('openai').at(-1).body.input.filter((i) => i.type === 'function_call_output');
  assert.equal(answered[0].output, 'not run: the task was paused');
});
