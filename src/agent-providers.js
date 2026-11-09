// The two model providers behind one shape: OpenAI's Responses API and Claude's
// Messages API, through the providers' own SDKs. Each adapter builds a request
// from the loop's own pieces, sends it once (maxRetries is 0: the runner retries
// with its own backoff and limits), and turns the answer into the same reply.
//
// A conversation is a list in the provider's own shape, only ever appended to:
// a Claude thinking block is bound to the whole history before it, and OpenAI
// reasoning items replayed with store: false must stay in order.
//
// A provider's error text is never shown. OpenAI's 401 echoes part of the key. The
// adapters throw ProviderError, whose message is one of a few fixed sentences; the
// status and the error's code and param ride on the object for the runner's choices
// and are never put in a message.
import { strictify } from './agent-tools.js';

// A model check's call may take this long. A task's call may take longer: up to 25,000 output
// tokens with reasoning is not quick.
export const CHECK_TIMEOUT_MS = 60_000;
export const TASK_TIMEOUT_MS = 180_000;
// Claude's thinking binding, step 0: with thinking on, a mismatch drops a block instead of failing.
const CLAUDE_BETA = 'thinking-binding-controls-2026-08-01';
// Input tokens counted for one screenshot when a call's size is estimated (a 1280 x 800
// PNG measured about 1,225 on OpenAI and about 1,365 on Claude).
export const IMAGE_TOKENS = 1800;

export const MESSAGES = Object.freeze({
  billing: 'the provider says the team\'s account is out of credit or at its spending limit',
  auth: 'the provider did not accept the team\'s key; enter it again',
  model: 'your key can\'t use this model, or it is no longer available',
  request: 'the provider refused the request',
  retry: 'the provider is busy or cannot be reached',
  other: 'the provider returned an error',
});

export class ProviderError extends Error {
  // kind: billing, auth, model, request, retry or other.
  constructor(kind, { status = null, param = null, code = null } = {}) {
    super(MESSAGES[kind]);
    this.kind = kind;
    this.status = status;
    this.param = param;
    this.code = code;
  }
}

// OpenAI's 429 codes that mean the team's money or quota, not a passing rate limit.
const OPENAI_BILLING = /credit|quota|billing|spend|usage_limit/i;

const pick = (e, key) => e?.[key] ?? e?.error?.[key] ?? e?.error?.error?.[key] ?? null;

// Fixed-message error for anything an SDK call threw.
export function classify(provider, e) {
  if (e instanceof ProviderError) return e;
  const status = Number.isInteger(e?.status) ? e.status : null;
  const code = pick(e, 'code');
  const type = pick(e, 'type');
  const param = pick(e, 'param');
  const info = { status, code: typeof code === 'string' ? code : null, param: typeof param === 'string' ? param : null };
  if (status === null) return new ProviderError('retry', info); // no answer: a timeout or a network failure
  if (status === 402) return new ProviderError('billing', info);
  if (status === 429) {
    const named = `${code ?? ''} ${type ?? ''}`;
    return new ProviderError(provider === 'openai' && OPENAI_BILLING.test(named) ? 'billing' : 'retry', info);
  }
  if (status === 401) return new ProviderError('auth', info);
  if (status === 403) return new ProviderError(code === 'model_not_found' ? 'model' : 'auth', info);
  if (status === 404) return new ProviderError('model', info);
  if (status === 408 || status === 409 || status >= 500) return new ProviderError('retry', info);
  if (status >= 400) return new ProviderError('request', info);
  return new ProviderError('other', info);
}

const text = (t) => ({ type: 'text', text: t });

// Parts the runner builds: { type: 'text', text } and { type: 'image', data, mime }.
// All the text parts of a list, joined, for a provider call that takes a string.
const joined = (parts) => parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n');

// Tokens of a conversation item, estimated from its size: its characters over 3,
// and a fixed figure for each image (the base64 is not counted as text).
export function estimateTokens(value) {
  let chars = 0;
  let images = 0;
  const walk = (v) => {
    if (typeof v === 'string') { chars += v.length; return; }
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (v && typeof v === 'object') {
      if (v.type === 'input_image' || v.type === 'image') { images += 1; return; }
      for (const x of Object.values(v)) walk(x);
    }
  };
  walk(value);
  return Math.ceil(chars / 3) + images * IMAGE_TOKENS;
}

// The base URLs are set here, so a stray OPENAI_BASE_URL or ANTHROPIC_BASE_URL in the
// environment can never send a team's key somewhere else.
// The SDKs are loaded when an adapter is first made, so a Worker that never runs an agent task
// does not pay their start-up time on every cold start.
// The reply every adapter returns:
//   items   what to append to the conversation (the provider's own shape)
//   text    the model's words, if any
//   calls   [{ id, name, args }] with args an object, or null when it was not valid JSON
//   stop    'tool_use', 'end', 'cut' (ran out of output) or 'refusal'
//   usage   { input (uncached), cached, cache_write, output }

// ---- OpenAI -------------------------------------------------------------------
function openaiAdapter(OpenAI, { apiKey, fetch, timeoutMs }) {
  const client = new OpenAI({ apiKey, baseURL: 'https://api.openai.com/v1', maxRetries: 0, timeout: timeoutMs, ...(fetch ? { fetch } : {}) });
  const content = (parts) => parts.map((p) => (p.type === 'image'
    ? { type: 'input_image', image_url: `data:${p.mime};base64,${p.data}`, detail: 'original' }
    : { type: 'input_text', text: p.text }));
  const usageOf = (u = {}) => {
    const cached = u.input_tokens_details?.cached_tokens ?? 0;
    const cacheWrite = u.input_tokens_details?.cache_write_tokens ?? 0;
    return { input: Math.max(0, (u.input_tokens ?? 0) - cached - cacheWrite), cached, cache_write: cacheWrite, output: u.output_tokens ?? 0 };
  };
  // A reasoning item with nothing after it is refused when replayed.
  const withoutTrailingReasoning = (items) => {
    const out = [...items];
    while (out.length && out.at(-1).type === 'reasoning') out.pop();
    return out;
  };
  return {
    provider: 'openai',
    tools: (list) => list.map((t) => ({ type: 'function', name: t.name, description: t.description, strict: true, parameters: strictify(t.schema) })),
    // Add one turn: the results of the model's calls (a screenshot goes inside its
    // function_call_output, step 0), then any user words.
    addTurn(conv, { results = [], user = null }) {
      for (const r of results) {
        const onlyText = r.parts.every((p) => p.type === 'text');
        conv.push({ type: 'function_call_output', call_id: r.id, output: onlyText ? joined(r.parts) : content(r.parts) });
      }
      if (user) conv.push({ role: 'user', content: content(user) });
    },
    // What goes into the conversation from a reply. A reply that ran out of room and called
    // nothing leaves no lone reasoning item behind.
    keep: (reply) => (reply.stop === 'cut' && !reply.calls.length ? withoutTrailingReasoning(reply.items) : reply.items),
    async call(spec, { system, tools, conv, maxOutput, cacheKey, signal }) {
      const body = {
        model: spec.id, store: false, service_tier: 'default', parallel_tool_calls: false, truncation: 'disabled',
        include: ['reasoning.encrypted_content'], max_output_tokens: maxOutput, tools, instructions: system, input: conv,
        ...(cacheKey ? { prompt_cache_key: cacheKey } : {}),
        ...(spec.settings.reasoning_effort ? { reasoning: { effort: spec.settings.reasoning_effort } } : {}),
      };
      let r;
      try {
        r = await client.responses.create(body, signal ? { signal } : undefined);
      } catch (e) {
        throw classify('openai', e);
      }
      if (r.status === 'failed') throw new ProviderError('other', { status: 200, code: typeof r.error?.code === 'string' ? r.error.code : null });
      const output = Array.isArray(r.output) ? r.output : [];
      const calls = output.filter((o) => o.type === 'function_call').map((o) => {
        let args = null;
        try { args = JSON.parse(o.arguments); } catch (_) { /* not valid JSON */ }
        return { id: o.call_id, name: o.name, args: args && typeof args === 'object' && !Array.isArray(args) ? args : null };
      });
      const words = output.filter((o) => o.type === 'message').flatMap((o) => o.content ?? []);
      const refused = words.some((c) => c.type === 'refusal');
      const stop = r.status === 'incomplete' ? 'cut' : refused ? 'refusal' : calls.length ? 'tool_use' : 'end';
      return { items: output, text: words.filter((c) => c.type === 'output_text').map((c) => c.text).join('\n'), calls, stop, usage: usageOf(r.usage) };
    },
    async getModel(id) {
      try { return await client.models.retrieve(id); } catch (e) { throw classify('openai', e); }
    },
  };
}

// ---- Claude -------------------------------------------------------------------
function claudeAdapter(Anthropic, { apiKey, fetch, timeoutMs }) {
  // Step 0 verified x-api-key and API version 2023-06-01. The SDK's own defaults are a bearer
  // token and a newer version, so both are pinned here; apiKey and authToken null keep it from
  // reading either from the environment.
  const client = new Anthropic({
    apiKey: null, authToken: null, baseURL: 'https://api.anthropic.com', maxRetries: 0, timeout: timeoutMs,
    defaultHeaders: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, ...(fetch ? { fetch } : {}),
  });
  const content = (parts) => parts.map((p) => (p.type === 'image'
    ? { type: 'image', source: { type: 'base64', media_type: p.mime, data: p.data } }
    : text(p.text)));
  const usageOf = (u = {}) => ({
    input: u.input_tokens ?? 0, cached: u.cache_read_input_tokens ?? 0, cache_write: u.cache_creation_input_tokens ?? 0, output: u.output_tokens ?? 0,
  });
  return {
    provider: 'anthropic',
    tools: (list) => list.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema })),
    // Add one turn: one user message holding the tool results first, then any user words.
    addTurn(conv, { results = [], user = null }) {
      const blocks = results.map((r) => ({
        type: 'tool_result', tool_use_id: r.id, content: content(r.parts), ...(r.isError ? { is_error: true } : {}),
      }));
      if (user) blocks.push(...content(user));
      conv.push({ role: 'user', content: blocks });
    },
    // A reply that ran out of room and called nothing is dropped: an assistant turn of
    // thinking alone is not a valid turn to replay.
    keep: (reply) => (reply.stop === 'cut' && !reply.calls.length ? [] : reply.items),
    async call(spec, { system, tools, conv, maxOutput, signal }) {
      const thinking = spec.settings.thinking === 'adaptive';
      // Prompt caching on the system prompt, the last tool and the last block of the last message,
      // marked on copies so the stored conversation stays as the model gave it.
      const messages = conv.slice();
      if (messages.length) {
        const last = messages.at(-1);
        const blocks = Array.isArray(last.content) ? [...last.content] : [text(String(last.content))];
        blocks[blocks.length - 1] = { ...blocks.at(-1), cache_control: { type: 'ephemeral' } };
        messages[messages.length - 1] = { ...last, content: blocks };
      }
      const body = {
        model: spec.id, max_tokens: maxOutput,
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        tools: tools.map((t, i) => (i === tools.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t)),
        tool_choice: { type: 'auto', disable_parallel_tool_use: true },
        messages,
        ...(thinking ? { thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } } } : {}),
        ...(spec.settings.effort ? { output_config: { effort: spec.settings.effort } } : {}),
      };
      let r;
      try {
        r = await client.messages.create(body, { ...(thinking ? { headers: { 'anthropic-beta': CLAUDE_BETA } } : {}), ...(signal ? { signal } : {}) });
      } catch (e) {
        throw classify('anthropic', e);
      }
      const blocks = Array.isArray(r.content) ? r.content : [];
      const calls = blocks.filter((b) => b.type === 'tool_use').map((b) => ({
        id: b.id, name: b.name, args: b.input && typeof b.input === 'object' && !Array.isArray(b.input) ? b.input : null,
      }));
      const stop = r.stop_reason === 'max_tokens' ? 'cut' : r.stop_reason === 'refusal' ? 'refusal' : calls.length ? 'tool_use' : 'end';
      return {
        items: [{ role: 'assistant', content: blocks }],
        text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n'),
        calls, stop, usage: usageOf(r.usage),
      };
    },
    async getModel(id) {
      try { return await client.models.retrieve(id); } catch (e) { throw classify('anthropic', e); }
    },
  };
}

// An adapter for a provider. fetch is for tests: it replaces the network.
export async function adapterFor(provider, { apiKey, fetch, timeoutMs = TASK_TIMEOUT_MS } = {}) {
  if (provider === 'openai') return openaiAdapter((await import('openai')).default, { apiKey, fetch, timeoutMs });
  if (provider === 'anthropic') return claudeAdapter((await import('@anthropic-ai/sdk')).default, { apiKey, fetch, timeoutMs });
  throw new TypeError('unknown provider');
}
