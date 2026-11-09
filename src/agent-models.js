// The built-in agent's models: the five in the code, the ones an admin adds, what
// each costs, and which a task may use. Pure, so node --test drives it directly.
//
// Money is in micro-dollars (millionths of a dollar), as whole numbers. A price is
// dollars per million tokens, so one token costs exactly its price in micro-dollars.

export const PROVIDERS = Object.freeze(['openai', 'anthropic']);
export const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
// A call's output limit never shrinks below this. A cap too small for it ends the task.
export const OUTPUT_FLOOR = 4000;
export const MAX_ADDED_MODELS = 10;
// Every request is kept under this many input tokens, so the long-context prices
// only count in a reservation's worst case.
export const INPUT_SOFT_MAX = 100_000;
const PRICE_MAX = 1000; // dollars per million tokens
const OUTPUT_LIMIT_MAX = 200_000;

// Prices: input, cached_input (a cache read), cache_write and output, in dollars per
// million tokens. long: past `over` input tokens, each price is multiplied.
const LONG_OPENAI = Object.freeze({ over: 272_000, input: 2, cached_input: 2, cache_write: 2, output: 1.5 });
const LONG_HAIKU = Object.freeze({ over: 100_000, input: 5, cached_input: 5, cache_write: 5, output: 5 });
const price = (input, cached_input, cache_write, output) => Object.freeze({ input, cached_input, cache_write, output });

// settings is what a call sends beyond the basics. OpenAI: reasoning_effort (null:
// no reasoning). Claude: thinking ("adaptive" or null) and effort (or null).
export const TABLE_MODELS = Object.freeze({
  'gpt-6.1-terra': Object.freeze({
    provider: 'openai', settings: Object.freeze({ reasoning_effort: 'medium' }), output_limit: 25_000, prices: price(1, 0.05, 1.25, 5), long: LONG_OPENAI,
  }),
  'gpt-6.1-sol': Object.freeze({
    provider: 'openai', settings: Object.freeze({ reasoning_effort: 'medium' }), output_limit: 25_000, prices: price(2, 0.10, 2.50, 10), long: LONG_OPENAI,
  }),
  'claude-opus-5-5': Object.freeze({
    provider: 'anthropic', settings: Object.freeze({ thinking: 'adaptive', effort: 'medium' }), output_limit: 16_000, prices: price(4, 0.20, 5, 20), long: null,
  }),
  'claude-sonnet-5-5': Object.freeze({
    provider: 'anthropic', settings: Object.freeze({ thinking: 'adaptive', effort: 'medium' }), output_limit: 16_000, prices: price(2, 0.10, 2.50, 10), long: null,
  }),
  'claude-haiku-5-5': Object.freeze({
    provider: 'anthropic', settings: Object.freeze({ thinking: 'adaptive', effort: 'medium' }), output_limit: 16_000, prices: price(0.10, 0.01, 0.125, 0.50), long: LONG_HAIKU,
  }),
});

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---- prices ---------------------------------------------------------------------
// The prices an admin typed for a model outside the table. input and output are
// required; cached_input defaults to input and cache_write to 1.25 times input.
// Returns the four prices, or throws an Error whose message is safe to show.
export function normalizePrices(v) {
  if (!isObject(v)) throw new Error('prices must be an object with input and output, in dollars per million tokens');
  const known = ['input', 'output', 'cached_input', 'cache_write'];
  for (const k of Object.keys(v)) if (!known.includes(k)) throw new Error(`unknown price: ${k.slice(0, 40)}`);
  const num = (k, def) => {
    const x = v[k] === undefined || v[k] === null ? def : v[k];
    if (typeof x !== 'number' || !Number.isFinite(x) || x <= 0 || x > PRICE_MAX) throw new Error(`${k} must be a number above 0 and at most ${PRICE_MAX} (dollars per million tokens)`);
    return x;
  };
  const input = num('input');
  const output = num('output');
  return { input, cached_input: num('cached_input', input), cache_write: num('cache_write', input * 1.25), output };
}

export function normalizeOutputLimit(v) {
  if (!Number.isInteger(v) || v > OUTPUT_LIMIT_MAX) throw new Error(`output_limit must be a whole number up to ${OUTPUT_LIMIT_MAX}`);
  if (v < OUTPUT_FLOOR) throw new Error('output limit too small');
  return v;
}

// ---- cost -----------------------------------------------------------------------
// usage: { input, cached, cache_write, output } token counts, with `input` the
// uncached part only (the adapters work that out, because OpenAI counts cached and
// cache-write tokens inside input_tokens and Claude does not). Output includes
// reasoning or thinking tokens. The result is a whole number of micro-dollars,
// rounded up.
export function costMicro(spec, usage) {
  const total = usage.input + usage.cached + usage.cache_write;
  const long = spec.long && total > spec.long.over ? spec.long : null;
  const m = (k) => (long ? long[k] : 1);
  const p = spec.prices;
  const sum = usage.input * p.input * m('input') + usage.cached * p.cached_input * m('cached_input')
    + usage.cache_write * p.cache_write * m('cache_write') + usage.output * p.output * m('output');
  return Math.ceil(Math.round(sum * 1000) / 1000);
}

// The dearest a call's input tokens can cost per token: every token uncached or a
// cache write, whichever is dearer, at the long-context price when it applies.
function worstInputPrice(spec, inputTokens) {
  const long = spec.long && inputTokens > spec.long.over ? spec.long : null;
  const p = spec.prices;
  return Math.max(p.input * (long ? long.input : 1), p.cached_input * (long ? long.cached_input : 1), p.cache_write * (long ? long.cache_write : 1));
}
const outputPrice = (spec, inputTokens) => spec.prices.output * (spec.long && inputTokens > spec.long.over ? spec.long.output : 1);

// The most a call can cost: inputTokens estimated, outputTokens allowed.
export function reserveMicro(spec, inputTokens, outputTokens) {
  return Math.ceil(Math.round((inputTokens * worstInputPrice(spec, inputTokens) + outputTokens * outputPrice(spec, inputTokens)) * 1000) / 1000);
}

// The output limit for a call that must fit `remainingMicro`: the model's own limit,
// or less to fit. 0 when it would fall under the floor, which means "cap reached".
export function fitOutput(spec, inputTokens, remainingMicro) {
  const room = remainingMicro - inputTokens * worstInputPrice(spec, inputTokens);
  if (!(room > 0)) return 0;
  const fits = Math.floor(room / outputPrice(spec, inputTokens));
  const n = Math.min(spec.output_limit, fits);
  return n < OUTPUT_FLOOR ? 0 : n;
}

// ---- which model ------------------------------------------------------------------
// The spec a task runs with: provider, id, request settings, output limit, prices
// and long-context multipliers. An added model carries the settings its check found
// and its own prices (null: the table's).
export function specOf(entry) {
  const table = Object.hasOwn(TABLE_MODELS, entry.id) && TABLE_MODELS[entry.id].provider === entry.provider ? TABLE_MODELS[entry.id] : null;
  return {
    provider: entry.provider,
    id: entry.id,
    settings: entry.settings ?? table?.settings ?? {},
    output_limit: entry.output_limit ?? table?.output_limit,
    prices: entry.prices ?? table?.prices ?? null,
    long: entry.prices ? null : (table?.long ?? null),
  };
}

const tableSpec = (id) => (Object.hasOwn(TABLE_MODELS, id) ? specOf({ provider: TABLE_MODELS[id].provider, id }) : null);

// The model used when a team names no default: GPT-6.1 Terra with an OpenAI key,
// Claude Sonnet 5.5 with only a Claude key.
export function defaultModelId(settings, keys) {
  if (settings.default_model) return settings.default_model;
  return !keys.openai && keys.anthropic ? 'claude-sonnet-5-5' : 'gpt-6.1-terra';
}

// A spec for a model id as the team has it: added models first, then the table.
export function findSpec(settings, id) {
  const added = settings.models.find((m) => m.id === id);
  return added ? specOf(added) : tableSpec(id);
}

// The models a task may use now: the team's default and the ones it added, each
// only while its provider has a key. keys: { openai: bool, anthropic: bool }.
export function usableSpecs(settings, keys) {
  const ids = [defaultModelId(settings, keys), ...settings.models.map((m) => m.id)];
  const out = [];
  for (const id of new Set(ids)) {
    const spec = findSpec(settings, id);
    if (spec && keys[spec.provider]) out.push(spec);
  }
  return out;
}

// The model a new task runs: the named one, or the team's default. Returns
// { spec } or { error }, the error being text safe to show.
export function pickSpec(settings, keys, requested) {
  const def = defaultModelId(settings, keys);
  const id = requested ?? def;
  if (id !== def && !settings.starters_pick_model) return { error: 'this team uses one model' };
  const spec = usableSpecs(settings, keys).find((s) => s.id === id);
  if (!spec) {
    const known = findSpec(settings, id);
    if (known && !keys[known.provider]) return { error: `the team has no ${known.provider === 'openai' ? 'OpenAI' : 'Claude'} key saved` };
    return { error: 'that model is not available to this team' };
  }
  return { spec };
}

// What the API shows for a spec.
export const specOut = (spec) => ({
  provider: spec.provider, id: spec.id, output_limit: spec.output_limit,
  prices: spec.prices ? { ...spec.prices } : null, long_context: spec.long ? { ...spec.long } : null,
});

// ---- time -----------------------------------------------------------------------
// The calendar month (UTC) that holds `now`: [start, end) in milliseconds.
export function monthBounds(now) {
  const d = new Date(now);
  return [Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1), Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)];
}

export const usd = (micro) => (micro === null || micro === undefined ? null : Number((micro / 1e6).toFixed(6)));
