// The tools the built-in agent's model sees: the session tools an MCP client has,
// without session_id (the runner fills it in), minus the tools that are not the
// agent's to use, plus note and finish. Pure, so node --test drives it directly.
//
// Not the agent's: type_secret (a background task has no operator who gave it a
// secret), block_input, send_sas and request_full_control (these need a person),
// the tools that make, list or end sessions and the saved-PC tools (the runner
// owns the session), and the agent's own tools. Team settings are never a tool.
import { listTools } from './mcp.js';
import { auditText, normalizeAction } from './screen.js';

export const SUMMARY_MAX = 600;
export const NOTE_MAX = 400;
export const OUTCOMES = Object.freeze(['done', 'stuck', 'needs_human']);

const NOT_THE_AGENTS = new Set([
  'type_secret', 'block_input', 'send_sas', 'request_full_control', 'session_create', 'session_list', 'session_end',
  'device_list', 'device_connect', 'agent_start', 'agent_status', 'agent_control',
]);

// A sentence that names a tool the agent does not have is dropped from a
// description, so no description points at type_secret, send_sas and the rest.
function rewrite(description) {
  const sentences = description.split(/(?<=\.)\s+/);
  return sentences.filter((s) => ![...NOT_THE_AGENTS].some((name) => s.includes(name))).join(' ');
}

// What the model is told about the two tools that are the runner's own.
const OWN_TOOLS = [
  {
    name: 'note',
    description: 'Write a short progress note (at most 400 characters): what you found and what you will do next. The technician reads your notes, and a note is how you continue if your conversation restarts. Write one every few actions.',
    inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'the note' } }, required: ['text'] },
  },
  {
    name: 'finish',
    description: `End the task. outcome is done (the problem is solved), stuck (you could not solve it) or needs_human (a person must do something, such as type a password or decide). summary is at most ${SUMMARY_MAX} characters: what was wrong, what you did, and the state the PC is in now. The next task on this PC reads it.`,
    inputSchema: {
      type: 'object',
      properties: { outcome: { type: 'string', enum: [...OUTCOMES] }, summary: { type: 'string' } },
      required: ['outcome', 'summary'],
    },
  },
];

const withoutSession = (schema) => {
  const s = JSON.parse(JSON.stringify(schema));
  if (s.properties) delete s.properties.session_id;
  if (s.required) s.required = s.required.filter((x) => x !== 'session_id');
  return s;
};

// [{ name, description, schema }], in a fixed order.
export function agentTools() {
  const session = listTools({ ui: true }).filter((t) => !NOT_THE_AGENTS.has(t.name))
    .map((t) => ({ name: t.name, description: rewrite(t.description), schema: withoutSession(t.inputSchema) }));
  return [...session, ...OWN_TOOLS.map((t) => ({ name: t.name, description: t.description, schema: t.inputSchema }))];
}

// The names the model may call. A call to any other name is not run.
export const AGENT_TOOL_NAMES = Object.freeze(new Set(agentTools().map((t) => t.name)));
export const RUNNER_TOOLS = Object.freeze(new Set(['note', 'finish']));

// OpenAI's strict mode wants every property listed as required, an optional one
// typed as also null, and no extra properties. Step 0 checked this against the real tool list.
export function strictify(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const s = { ...schema };
  if (s.type === 'object' || s.properties) {
    const props = {};
    const required = new Set(s.required || []);
    for (const [k, v] of Object.entries(s.properties || {})) {
      let p = strictify(v);
      if (!required.has(k)) {
        p = { ...p };
        if (p.type) p.type = Array.isArray(p.type) ? [...new Set([...p.type, 'null'])] : [p.type, 'null'];
        else p = { anyOf: [p, { type: 'null' }] };
        if (p.enum) p.enum = [...p.enum, null];
      }
      props[k] = p;
    }
    s.properties = props;
    s.required = Object.keys(props);
    s.additionalProperties = false;
    s.type = 'object';
  }
  if (s.items) s.items = strictify(s.items);
  return s;
}

// Strict mode sends null for an option the model left out. The relay never sees them.
export function stripNulls(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  return Object.fromEntries(Object.entries(args).filter(([, v]) => v !== null));
}

// What a step record shows about a call: the verb and a short detail, never typed
// text (a length only, as the session log shows it).
export function stepDetail(name, args) {
  const a = args && typeof args === 'object' ? args : {};
  const cut = (v, n) => String(v ?? '').replace(/\s+/g, ' ').slice(0, n);
  if (name === 'run') return `${a.as === 'system' ? '(system) ' : ''}${cut(a.command, 120)}`;
  if (name === 'put_file') return cut(a.path, 120);
  if (name === 'get_file') return cut(a.path, 120);
  if (name === 'session_status') return '';
  const screen = { move_mouse: 'move', type_text: 'type', press_key: 'key' }[name] ?? name;
  try {
    const text = auditText(normalizeAction({ ...a, name: screen }));
    return text === screen ? '' : text.replace(/^\S+\s?/, '');
  } catch (_) {
    return '';
  }
}
