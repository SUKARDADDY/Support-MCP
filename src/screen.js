// Screen-control vocabulary shared by the MCP layer (src/mcp.js) and the Session
// Durable Object (src/session.js): the lanes, the normalized actions, the audit
// text for each, and the strict check of every field of an app result. Pure, so
// node --test drives it directly.
//
// Error messages here never repeat a value the caller sent. A typed secret must
// not reach an error string, a log row or a result.

export const LANES = ['cmd', 'screen'];
export const CAPS = ['screen', 'uia', 'lanes', 'full'];
export const CONTROLS = ['full', 'normal'];
export const DESKTOPS = ['default', 'secure', 'unknown'];
export const IMAGE_B64_MAX = 700000; // base64 chars of one screenshot
export const UI_VERBS = ['invoke', 'set_value', 'toggle', 'focus', 'expand', 'collapse', 'select'];
export const SCREEN_ACTIONS = [
  'screenshot', 'click', 'move', 'drag', 'scroll', 'type', 'key', 'wait', 'zoom',
  'ui_tree', 'ui_act', 'block_input', 'send_sas', 'type_secret',
];

const COORD_MAX = 20000; // pixels of the screenshot the model sees (at most 1280 x 800)
const DISPLAY_MAX = 15;
const TYPE_MAX = 5000; // chars per type call
const SECRET_MAX = 1000;
const KEYS_MAX = 100;
const VALUE_MAX = 5000; // ui_act set_value
const RESULT_TEXT_MAX = 200000; // chars of text in a result (ui_tree)
const REF_MAX = 1000000;

const present = (v) => v !== undefined && v !== null;
const isInt = (v, lo, hi) => Number.isSafeInteger(v) && v >= lo && v <= hi;

function coord(v, label) {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${label} must be a number`);
  const n = Math.round(v);
  if (n < 0 || n > COORD_MAX) throw new Error(`${label} is out of range (0 to ${COORD_MAX})`);
  return n;
}

function oneOf(v, list, label, def) {
  if (!present(v)) {
    if (def !== undefined) return def;
    throw new Error(`${label} is required`);
  }
  if (!list.includes(v)) throw new Error(`${label} must be one of ${list.join(', ')}`);
  return v;
}

function text(v, label, max) {
  if (typeof v !== 'string' || v.length === 0) throw new Error(`${label} must be a non-empty string`);
  if (v.length > max) throw new Error(`${label} is too long (max ${max} chars)`);
  return v;
}

function intField(v, label, lo, hi, def) {
  if (!present(v)) {
    if (def !== undefined) return def;
    throw new Error(`${label} is required`);
  }
  const n = typeof v === 'number' ? Math.round(v) : NaN;
  if (!isInt(n, lo, hi)) throw new Error(`${label} must be a whole number from ${lo} to ${hi}`);
  return n;
}

// Turn a loosely typed action into the one shape the relay forwards to the app.
// Throws an Error whose message is safe to show the operator.
export function normalizeAction(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('action required');
  const name = raw.name;
  if (!SCREEN_ACTIONS.includes(name)) throw new Error(`unknown screen action; use one of ${SCREEN_ACTIONS.join(', ')}`);
  const out = { name };
  const display = () => { out.display = intField(raw.display, 'display', 0, DISPLAY_MAX, 0); };
  const shot = () => {
    if (present(raw.screenshot) && typeof raw.screenshot !== 'boolean') throw new Error('screenshot must be true or false');
    out.screenshot = present(raw.screenshot) ? raw.screenshot : true;
  };
  switch (name) {
    case 'screenshot':
      display();
      break;
    case 'click':
      out.x = coord(raw.x, 'x');
      out.y = coord(raw.y, 'y');
      out.button = oneOf(raw.button, ['left', 'right', 'middle'], 'button', 'left');
      out.count = intField(raw.count, 'count', 1, 3, 1);
      display();
      shot();
      break;
    case 'move':
      out.x = coord(raw.x, 'x');
      out.y = coord(raw.y, 'y');
      display();
      shot();
      break;
    case 'drag':
      for (const k of ['x1', 'y1', 'x2', 'y2']) out[k] = coord(raw[k], k);
      display();
      shot();
      break;
    case 'scroll':
      out.x = coord(raw.x, 'x');
      out.y = coord(raw.y, 'y');
      out.direction = oneOf(raw.direction, ['up', 'down', 'left', 'right'], 'direction');
      out.amount = intField(raw.amount, 'amount', 1, 50, 3);
      display();
      shot();
      break;
    case 'type':
      out.text = text(raw.text, 'text', TYPE_MAX);
      display();
      shot();
      break;
    case 'key':
      out.keys = text(raw.keys, 'keys', KEYS_MAX);
      if (/[\u0000-\u001f]/.test(out.keys)) throw new Error('keys must not contain control characters');
      display();
      shot();
      break;
    case 'wait': {
      const s = present(raw.seconds) ? raw.seconds : 1;
      if (typeof s !== 'number' || !Number.isFinite(s) || s <= 0 || s > 10) throw new Error('seconds must be a number above 0 and at most 10');
      out.seconds = Math.max(0.1, Math.round(s * 10) / 10);
      display();
      shot();
      break;
    }
    case 'zoom':
      for (const k of ['x1', 'y1', 'x2', 'y2']) out[k] = coord(raw[k], k);
      if (out.x2 <= out.x1 || out.y2 <= out.y1) throw new Error('zoom region must have x2 > x1 and y2 > y1');
      display();
      break;
    case 'ui_tree':
      out.max_lines = intField(raw.max_lines, 'max_lines', 1, 2000, 300);
      break;
    case 'ui_act': {
      const ref = typeof raw.ref === 'string' && /^[0-9]{1,7}$/.test(raw.ref) ? Number(raw.ref) : raw.ref;
      out.ref = intField(ref, 'ref', 0, REF_MAX);
      out.verb = oneOf(raw.verb, UI_VERBS, 'verb');
      if (out.verb === 'set_value') out.value = text(raw.value, 'value', VALUE_MAX);
      else if (out.verb === 'select' && present(raw.value)) out.value = text(raw.value, 'value', VALUE_MAX);
      display();
      shot();
      break;
    }
    case 'block_input':
      if (typeof raw.on !== 'boolean') throw new Error('on must be true or false');
      out.on = raw.on;
      if (raw.on) out.minutes = intField(raw.minutes, 'minutes', 1, 10, 10);
      break;
    case 'send_sas':
      display();
      shot();
      break;
    case 'type_secret':
      out.text = text(raw.text, 'text', SECRET_MAX);
      display();
      shot();
      break;
  }
  return out;
}

// The audit text for one action. Typed text is a length only, `type_secret` has
// nothing at all, and ui_act never records its value. The `screenshot` action
// is logged by the Session once the image size is known.
export function auditText(a) {
  let s;
  switch (a.name) {
    case 'click':
      s = `click ${a.x},${a.y}${a.button !== 'left' ? ` ${a.button}` : ''}${a.count > 1 ? ` x${a.count}` : ''}`;
      break;
    case 'move': s = `move ${a.x},${a.y}`; break;
    case 'drag': s = `drag ${a.x1},${a.y1} ${a.x2},${a.y2}`; break;
    case 'scroll': s = `scroll ${a.direction} ${a.amount} at ${a.x},${a.y}`; break;
    case 'type': s = `type ${[...a.text].length} chars`; break;
    case 'key': s = `key ${a.keys}`; break;
    case 'wait': s = `wait ${a.seconds}s`; break;
    case 'zoom': s = `zoom ${a.x1},${a.y1},${a.x2},${a.y2}`; break;
    case 'ui_act': s = `ui_act ${a.verb} ${a.ref}`; break;
    case 'block_input': s = a.on ? `block_input on ${a.minutes}m` : 'block_input off'; break;
    case 'type_secret': return 'type_secret';
    default: s = a.name; // screenshot, ui_tree, send_sas
  }
  return a.display ? `${s} display ${a.display}` : s;
}

// ---- results -----------------------------------------------------------------

// First base64 characters of a JPEG (FF D8 FF) and of a PNG (89 'PNG' 0D 0A 1A 0A).
const IMAGE_MAGIC = { 'image/jpeg': '/9j/', 'image/png': 'iVBORw0KGgo' };
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

// Check and copy the optional fields every screen or control result may carry.
// An absent or null field is skipped. Anything else must be exactly right, or
// this throws and the relay answers the app with 400.
function copyMeta(b, out) {
  if (present(b.image_b64)) {
    const mime = b.mime;
    if (typeof b.image_b64 !== 'string' || b.image_b64.length > IMAGE_B64_MAX || b.image_b64.length % 4 !== 0
      || !B64_RE.test(b.image_b64)) throw new Error('bad image');
    if (!Object.hasOwn(IMAGE_MAGIC, mime) || !b.image_b64.startsWith(IMAGE_MAGIC[mime])) throw new Error('bad image type');
    if (!isInt(b.width, 1, 8192) || !isInt(b.height, 1, 8192)) throw new Error('bad image size');
    out.image_b64 = b.image_b64;
    out.mime = mime;
    out.width = b.width;
    out.height = b.height;
  } else if (present(b.mime) || present(b.width) || present(b.height)) {
    throw new Error('image fields without an image');
  }
  if (present(b.display)) {
    if (!isInt(b.display, 0, DISPLAY_MAX)) throw new Error('bad display');
    out.display = b.display;
  }
  if (present(b.displays)) {
    if (!isInt(b.displays, 1, DISPLAY_MAX + 1)) throw new Error('bad displays');
    out.displays = b.displays;
  }
  if (out.display !== undefined && out.displays !== undefined && out.display >= out.displays) throw new Error('bad display');
  if (present(b.desktop)) {
    if (!DESKTOPS.includes(b.desktop)) throw new Error('bad desktop');
    out.desktop = b.desktop;
  }
  if (present(b.text)) {
    if (typeof b.text !== 'string' || b.text.length > RESULT_TEXT_MAX) throw new Error('bad text');
    out.text = b.text;
  }
}

// An ok result for a `screen` frame. `name` is the action it answers.
export function decodeScreenResult(b, name) {
  if (b.ok !== true) throw new Error('bad ok');
  const out = { ok: true };
  copyMeta(b, out);
  if ((name === 'screenshot' || name === 'zoom') && !out.image_b64) throw new Error('missing image');
  if (name === 'ui_tree' && out.text === undefined) throw new Error('missing text');
  return out;
}

// An ok result for the `control` frame.
export function decodeControlResult(b) {
  if (b.ok !== true) throw new Error('bad ok');
  const out = { ok: true };
  if (present(b.control)) {
    if (!CONTROLS.includes(b.control)) throw new Error('bad control');
    out.control = b.control;
  }
  if (present(b.desktop)) {
    if (!DESKTOPS.includes(b.desktop)) throw new Error('bad desktop');
    out.desktop = b.desktop;
  }
  if (present(b.text)) {
    if (typeof b.text !== 'string' || b.text.length > 2000) throw new Error('bad text');
    out.text = b.text;
  }
  return out;
}

// Optional state the app may add to a poll. Invalid values are dropped, never
// an error: a poll must keep working. Returns only the fields that were sent.
export function decodePollReport(b) {
  const out = {};
  if ('desktop' in b) out.desktop = DESKTOPS.includes(b.desktop) ? b.desktop : null;
  for (const k of ['paused_until', 'input_blocked_until']) {
    if (k in b) out[k] = Number.isSafeInteger(b[k]) && b[k] > 0 ? b[k] : null;
  }
  return out;
}

// The caps a hello may report. Unknown names are dropped.
export function decodeCaps(v) {
  if (!Array.isArray(v)) return [];
  return CAPS.filter((c) => v.includes(c));
}

export function decodeControl(v) {
  return CONTROLS.includes(v) ? v : null;
}
