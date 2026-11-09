// Fake OpenAI and Claude for the built-in agent's tests. One fetch replaces the
// network for both SDKs. Response bodies have the shapes step 0 recorded from the
// real providers (usage fields, reasoning items with encrypted content, thinking
// blocks), and the error bodies are the real ones, word for word.

// ---- real bodies from step 0 ------------------------------------------------------------
export const OPENAI_MODEL_404 = { error: { message: 'That model does not exist', type: 'invalid_request_error', param: 'id', code: null } };
export const OPENAI_MODEL_403 = {
  error: { message: 'Project `proj_REDACTED` does not have access to model `gpt-6.1-terra`', type: 'invalid_request_error', param: null, code: 'model_not_found' },
};
export const OPENAI_NO_REASONING_400 = {
  error: { message: "Unsupported parameter: 'reasoning.effort' is not supported with this model.", type: 'invalid_request_error', param: 'reasoning.effort', code: 'unsupported_parameter' },
};
export const CLAUDE_NO_EFFORT_400 = {
  type: 'error', error: { type: 'invalid_request_error', message: 'This model does not support the effort parameter.' }, request_id: 'req_011Cgryw6xygZ5DSn2nHHZL8',
};
// What the real 401 does: it echoes part of the key. The tests echo all of it.
export const openaiBadKey = (key) => ({
  error: { message: `Incorrect API key provided: ${key}. You can find your API key at https://platform.openai.com/account/api-keys.`, type: 'invalid_request_error', param: null, code: 'invalid_api_key' },
});

// ---- model records --------------------------------------------------------------------------
export const openaiModel = (id, shutdown = null) => ({ id, object: 'model', created: 1791908780, owned_by: 'system', shutdown_date: shutdown });
const sup = (v = true) => ({ supported: v });
// claude-sonnet-5-5 as the real API described it. Override with `caps`.
export const claudeModel = (id, { lifecycle = 'active', max_tokens = 128000, caps } = {}) => ({
  id, type: 'model', display_name: id, lifecycle, max_tokens,
  capabilities: caps === undefined ? {
    image_input: sup(),
    thinking: { supported: true, types: { enabled: sup(false), adaptive: sup(true), disabled: sup(false), between_tools: sup(true) } },
    effort: { supported: true, low: sup(), medium: sup(), high: sup(), xhigh: sup(), max: sup() },
  } : caps,
});
// claude-haiku-4-5-20251001: no adaptive thinking, no effort.
export const OLD_CLAUDE_CAPS = {
  image_input: sup(),
  thinking: { supported: true, types: { enabled: sup(true), adaptive: sup(false), disabled: sup(true), between_tools: sup(false) } },
  effort: { supported: false, low: sup(false), medium: sup(false), high: sup(false), xhigh: sup(false), max: sup(false) },
};

// ---- usage and replies -------------------------------------------------------------------------
// OpenAI: input_tokens includes the cached and cache-write tokens.
export const openaiUsage = ({ input = 1000, cached = 0, write = 0, output = 20, reasoning = 0 } = {}) => ({
  input_tokens: input, input_tokens_details: { cache_write_tokens: write, cached_tokens: cached },
  output_tokens: output, output_tokens_details: { reasoning_tokens: reasoning }, total_tokens: input + output,
});
// Claude: input_tokens is the uncached rest.
export const claudeUsage = ({ input = 100, create = 0, read = 0, output = 20 } = {}) => ({
  input_tokens: input, cache_creation_input_tokens: create, cache_read_input_tokens: read,
  cache_creation: { ephemeral_5m_input_tokens: create, ephemeral_1h_input_tokens: 0 },
  output_tokens: output, output_tokens_details: { thinking_tokens: 0 }, service_tier: 'standard', inference_geo: 'global', speed: 'standard',
});

let counter = 0;
export const oai = {
  // A reply that calls one tool, after a reasoning item that carries encrypted content.
  call(name, args = {}, { usage = openaiUsage(), reasoning = true, status = 'completed', model = 'gpt-6.1-terra' } = {}) {
    const n = ++counter;
    return {
      id: `resp_${n}`, object: 'response', status, model,
      output: [
        ...(reasoning ? [{ id: `rs_${n}`, type: 'reasoning', encrypted_content: `enc_${n}`, summary: [] }] : []),
        { id: `fc_${n}`, type: 'function_call', call_id: `call_${n}`, name, arguments: typeof args === 'string' ? args : JSON.stringify(args), status: 'completed' },
      ],
      usage,
    };
  },
  // A reply with words and no tool call.
  say(text, { usage = openaiUsage(), status = 'completed', reasoning = false } = {}) {
    const n = ++counter;
    return {
      id: `resp_${n}`, object: 'response', status,
      output: [
        ...(reasoning ? [{ id: `rs_${n}`, type: 'reasoning', encrypted_content: `enc_${n}`, summary: [] }] : []),
        ...(text === null ? [] : [{ id: `msg_${n}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }]),
      ],
      usage,
    };
  },
};
export const ant = {
  call(name, input = {}, { usage = claudeUsage(), thinking = true, model = 'claude-sonnet-5-5' } = {}) {
    const n = ++counter;
    return {
      id: `msg_${n}`, type: 'message', role: 'assistant', model, stop_reason: 'tool_use', stop_sequence: null,
      content: [
        ...(thinking ? [{ type: 'thinking', thinking: 'thinking about it', signature: `sig_${n}` }] : []),
        { type: 'tool_use', id: `toolu_${n}`, name, input },
      ],
      usage,
    };
  },
  say(text, { usage = claudeUsage(), stop = 'end_turn' } = {}) {
    const n = ++counter;
    return { id: `msg_${n}`, type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', stop_reason: stop, stop_sequence: null, content: [{ type: 'text', text }], usage };
  },
};

// A scripted reply: a body (200) or { status, json }.
const asReply = (r) => (r && typeof r === 'object' && 'status' in r && 'json' in r ? r : { status: 200, json: r });

// One fetch for both providers. queue() adds the replies the next model calls get, in
// order; a function is called with the request body. model() sets what a model's
// record answers (default: it exists). calls holds every request the SDKs sent.
export function fakeProviders() {
  const calls = [];
  const queues = { openai: [], anthropic: [] };
  const models = { openai: new Map(), anthropic: new Map() };
  const fake = {
    calls,
    queue(provider, ...replies) { queues[provider].push(...replies); },
    model(provider, id, reply) { models[provider].set(id, asReply(reply)); },
    // The model calls (not the model-record reads) one provider received.
    sent: (provider) => calls.filter((c) => c.provider === provider && c.method === 'POST'),
    reads: (provider) => calls.filter((c) => c.provider === provider && c.method === 'GET'),
    pending: (provider) => queues[provider].length,
    // Forget replies a test did not use.
    clear(provider) { queues[provider].length = 0; },
    async fetch(input, init = {}) {
      const url = new URL(typeof input === 'string' ? input : input.url);
      const provider = url.host === 'api.openai.com' ? 'openai' : url.host === 'api.anthropic.com' ? 'anthropic' : null;
      if (!provider) throw new Error(`the fake providers got a request for ${url.host}`);
      const method = (init.method ?? 'GET').toUpperCase();
      const body = init.body ? JSON.parse(init.body) : null;
      const call = { provider, method, path: url.pathname, body, headers: Object.fromEntries(new Headers(init.headers ?? {})) };
      calls.push(call);
      const respond = ({ status, json }) => new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
      if (method === 'GET' && /\/v1\/models\//.test(url.pathname)) {
        const id = decodeURIComponent(url.pathname.split('/').pop());
        const set = models[provider].get(id);
        if (set) return respond(set);
        return respond({ status: 200, json: provider === 'openai' ? openaiModel(id) : claudeModel(id) });
      }
      const queue = queues[provider];
      if (method === 'POST' && queue.length) {
        const next = queue.shift();
        return respond(asReply(typeof next === 'function' ? await next(body, call) : next));
      }
      return respond({ status: 500, json: { error: { message: 'the fake provider has no scripted reply' } } });
    },
  };
  return fake;
}
