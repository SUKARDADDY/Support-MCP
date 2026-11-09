// The check an admin's new model must pass before a task may use it: two turns, no
// tools of the PC. Turn 1 asks the model to call a look tool. Turn 2 answers that
// call with a small picture of a word, and the model must call answer with the word.
// It proves the model calls tools and reads a screenshot, and it finds the request
// settings the model accepts. It runs inside an AgentTask object, which opens the key.
//
// The picture is a 1280 x 800 black and white PNG of "PELICAN" in a window, 1.5 KB.
import { CHECK_TIMEOUT_MS, adapterFor } from './agent-providers.js';
import { OUTPUT_FLOOR, costMicro } from './agent-models.js';

export const CHECK_WORD = 'PELICAN';
// Each of the check's calls may produce this many tokens.
export const CHECK_OUTPUT = 2048;
const CHECK_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAABQAAAAMgAQAAAABU4/JWAAAFnklEQVR42u3dP2/jZADH8d/jWsRIobhbtppbWAsTA+IMb4C3gBAv4MRe9FwHNiReAbq3wMZ2bsVwE+rKhIsYMt2lpYODHD8MaXpN88dN7cQP4vtdckp61aePHz9+4laKRERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERES089wOsmsFge9DBBAgQIAAAe4MeH3z+MIr4NXE8xF0ks4Xnh3ubhz/+3PQeg4MNEl+nqQfKZqkks4myZ/6Vb9/89fXOwKGNa+brBzq+vzyuCzPJT0thn/YC6c49OYQ5+P8y79/2T99Pc4k99k4/819aj/8fviTN3MwKBUmB0EUJJI+D8oDfSHtnXszgqNRrKGSPLqOpUqj+MV3dpfnTi0wDaXLRMeSXCQbTv9PkHgDLO49ercOJqX0fqFjSaaQLSU5qyr3BtiPRxooT9QfSYHi0VcnViqf+bObqUKVwzd7RZVLelmFb/TyW41Tb4BRLzl4L7lK414qmbNe8rE507sngyeeXEmkcKD+4ODkh/BI0mk4+MA+OXLXfU/2ErMbPE+5eQQQ4PoyRhAgQICPzKx/+XD7G9NJyCEGCBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQJ8eM5EXQMvjTGBpIkxxphYFyaWpLEJJens5qPEnpto+jVWem7srkfQxateSKVX0p1PBcy6OcRXa54fT/9ZTh/yboCrPuTrXJLS6ae6dnuSZLVPV9OHUUfAfKOB7QA4XPpstfCPRh8I2QRY1j7ruh3B5RUP/Um2D6yWPjtqg9UO0NWfOnbNT9LVIc6kw6LpqdEc2HPZik+4tTJ5z86tia6TEfxEkmScc/fX4XekZx6sg+HKiRlJ/fnrh+0CGCy/1lVSLO2p+TahKXD1x6AlC2OWeXQWl1I63c3kSjzd8t+OXjybh3knQLvxsfdiBIs7Ey9duPx5cYjffstoxi38moP3p0Dg1SEe3VnB7XRHY5psbLZwktRebHY6gs4Yk6645t2ezrbycg5KQaOdYOM7C6teWLwxk7ougJWUrn89UKdz8AFnprkZ5qTBfuvxwFfNf4BtAscmrV1owtlaFDfYb7V+FuebLZVbBZqHvoGPGuy3grZ/uGR+vcmaXlG2exO9hf1WE2BYs2vY3mF6YIOa1+O350yxpVFYXyLJVHVf0fBNQNDGDFt6+ubtrNoNgLW/+UhuZ2KD/VYD4P76l7ObWdjdnYXapePUxDfHu8F+6/G336pVp25Lu4StL9R2bjZaj4BVq5uu1oHRqiXbnxF069+yeDAH7cLxjjwChtMVMKs8HsH8zii6plf81oGBNJIm/q6DRiqk6/n1JegO6IwxkaZ/ZjHb3fwj/Th/xhif5qCVS8ZWUs85L38dm0oX0WxXaBu//2wfmCzuuvwawXjZRS/1CBjdfVOXejgHw2W3QhKPgMEMFrf57dpcqed3qqOG+60tXIvTbRyQNjuSpCybm3eRT8B9Sb3bNafwbwRNNvuDhpWn9mabj3Ud5o/ZQAS9DcZtEm6yarUzhM7vk0S+n8UAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAARIRERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERER0f+1fwF1GtksjhiNvwAAAABJRU5ErkJggg==';
const CLAUDE_OUTPUT_MAX = 16_000;
const SYSTEM = 'You are being checked before you are given a Windows PC to fix. First call the look tool. Then call the answer tool with the single large word you can read on the screen.';
const TOOLS = [
  { name: 'look', description: 'Look at the screen. It returns a screenshot.', schema: { type: 'object', properties: {}, required: [] } },
  { name: 'answer', description: 'Give the word you read on the screen.', schema: { type: 'object', properties: { word: { type: 'string' } }, required: ['word'] } },
];

const NOT_ABLE = 'this model can\'t read screenshots or call tools';
const NO_ROOM = 'the check ran out of room; try again';
const TOO_SMALL = 'output limit too small';

// spec: { provider, id, prices, long, output_limit } (what the model costs, and for a model
// in the table its output limit, where the check starts). adminLimit: the output limit the
// admin asked for, or undefined. Returns
//   { ok: true, settings, output_limit, cost_micro }
//   { ok: false, message, cost_micro }
// message is a fixed sentence. cost_micro is what the check's calls cost.
export async function runModelCheck({ spec, adminLimit, apiKey, fetch }) {
  const adapter = await adapterFor(spec.provider, { apiKey, fetch, timeoutMs: CHECK_TIMEOUT_MS });
  let cost = 0;
  const fail = (message) => ({ ok: false, message, cost_micro: cost });
  let settings;
  let saved; // the output limit a task will use
  let callLimit = CHECK_OUTPUT;
  try {
    const info = await adapter.getModel(spec.id);
    if (spec.provider === 'anthropic') {
      if (typeof info.lifecycle === 'string' && info.lifecycle === 'retired') return fail('this model is retired');
      const caps = info.capabilities ?? null;
      if (caps?.image_input?.supported === false) return fail('this model can\'t read screenshots');
      // No capabilities at all is tried as if everything were supported.
      const thinking = caps === null ? true : caps.thinking?.types?.adaptive?.supported === true;
      const effort = caps === null ? true : caps.effort?.medium?.supported === true;
      const modelMax = Number.isInteger(info.max_tokens) ? info.max_tokens : null;
      const wanted = adminLimit ?? spec.output_limit ?? (modelMax === null ? 8000 : CLAUDE_OUTPUT_MAX);
      saved = Math.min(wanted, CLAUDE_OUTPUT_MAX, modelMax ?? Infinity);
      settings = { thinking: thinking ? 'adaptive' : null, effort: effort ? 'medium' : null };
    } else {
      saved = adminLimit ?? spec.output_limit ?? 8000;
      settings = { reasoning_effort: 'medium' };
    }
    if (saved < OUTPUT_FLOOR) return fail(TOO_SMALL);

    const tools = adapter.tools(TOOLS);
    const conv = [];
    const tried = { reasoning: false, max: false };
    // One call, with the retries a 400 allows (OpenAI only: Claude's errors name no parameter).
    const turn = async () => {
      for (;;) {
        try {
          const run = { ...spec, settings };
          const reply = await adapter.call(run, { system: SYSTEM, tools, conv, maxOutput: callLimit });
          cost += costMicro(spec, reply.usage);
          return reply;
        } catch (e) {
          const param = e?.kind === 'request' && typeof e.param === 'string' ? e.param : '';
          if (spec.provider === 'openai' && param.startsWith('reasoning') && !tried.reasoning) {
            tried.reasoning = true;
            settings = { ...settings, reasoning_effort: null };
          } else if (spec.provider === 'openai' && param === 'max_output_tokens' && !tried.max) {
            tried.max = true;
            callLimit = OUTPUT_FLOOR;
            saved = OUTPUT_FLOOR;
          } else {
            throw e;
          }
        }
      }
    };

    adapter.addTurn(conv, { user: [{ type: 'text', text: 'Run the check now.' }] });
    const first = await turn();
    if (first.stop === 'cut') return fail(NO_ROOM);
    const look = first.calls.find((c) => c.name === 'look');
    if (!look) return fail(NOT_ABLE);
    conv.push(...adapter.keep(first));
    // The look call gets the picture. Any other call in the same reply gets a plain answer.
    adapter.addTurn(conv, {
      results: first.calls.map((c) => ({
        id: c.id, parts: c === look ? [{ type: 'image', data: CHECK_PNG_B64, mime: 'image/png' }] : [{ type: 'text', text: 'not run' }],
      })),
    });
    const second = await turn();
    if (second.stop === 'cut') return fail(NO_ROOM);
    const answer = second.calls.find((c) => c.name === 'answer');
    if (!answer || typeof answer.args?.word !== 'string' || answer.args.word.trim().toUpperCase() !== CHECK_WORD) return fail(NOT_ABLE);
    if (saved < OUTPUT_FLOOR) return fail(TOO_SMALL);
    return { ok: true, settings, output_limit: saved, cost_micro: cost };
  } catch (e) {
    // Only a ProviderError's fixed sentence is shown. Anything else is "other".
    return fail(e && e.kind ? e.message : 'the check failed');
  }
}
