// A team's rules for what anyone, person or AI, may do to a saved PC: the document, its checks, the
// defaults, the merge of a customer's overrides over the team's, business hours turned into exact UTC
// times, and decide(), the one function that judges an action against rules. Pure data and checks,
// no storage. The PC runs the same cases (test/fixtures/rules-cases.json) against its own copy of decide,
// so a change here changes that file first.
//
// The document (the API body and the PC's device.json):
//   { time_zone: "Asia/Jerusalem" | null, hours: null | { mon: ["08:00", "18:00"], ... },
//     restart, shutdown, install, uninstall, close_program: an action value,
//     protected_programs: [name], protected_folders: [absolute path] }
// A customer override is the same fields, all optional: a field it sets replaces the team's (a list
// replaces, it never merges). rev is the row's revision and lives beside the document, not in it.
//
// An action value is allow, approve (a technician approves in the app), approve_in_hours (approve during
// business hours, allow outside them), outside_hours (refuse during business hours) or never.
//
// The relay turns business hours into exact UTC spans for the PC (hoursUtc), so the PC needs no time zone
// logic. Names the PC and the relay compare are plain strings here: the relay never expands a Windows
// short name (PROGRA~1) or follows a link. The PC does both before it decides.
import { bytesToHex } from './crypto.js';

export const ACTIONS = Object.freeze(['restart', 'shutdown', 'install', 'uninstall', 'close_program']);
export const ACTION_VALUES = Object.freeze(['allow', 'approve', 'approve_in_hours', 'outside_hours', 'never']);
const HOUR_VALUES = Object.freeze(['approve_in_hours', 'outside_hours']);
// Files are guarded by the protected folders alone, so they have no action value of their own.
export const FILE_ACTIONS = Object.freeze(['put_file', 'get_file']);
export const DAYS = Object.freeze(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
export const LIST_MAX = 50;
export const PROGRAM_MAX = 100;
export const FOLDER_MAX = 260;
// The span of business hours the relay resolves ahead, in seconds.
export const HOURS_HORIZON_S = 8 * 86400;
const DAY_MS = 86_400_000;

const FIELDS = Object.freeze(['time_zone', 'hours', ...ACTIONS, 'protected_programs', 'protected_folders']);

// The rules of a team with no row. The PC uses the same ones before its first rules arrive.
export const DEFAULT_RULES = Object.freeze({
  time_zone: null,
  hours: null,
  restart: 'approve',
  shutdown: 'approve',
  install: 'approve',
  uninstall: 'approve',
  close_program: 'allow',
  protected_programs: Object.freeze([]),
  protected_folders: Object.freeze([]),
});

// What a refusal says, by code. The codes are part of the PC's wire (docs/relay-v1-spec.md).
export const REFUSALS = Object.freeze({
  rule_never: 'the team\'s rules never allow this action on this PC',
  business_hours: 'the team\'s rules allow this action only outside business hours',
  protected_program: 'the team\'s rules protect this program',
  protected_folder: 'the team\'s rules protect this folder',
  needs_full_control: 'this action needs a PC set to full control',
});

// A rules document that does not pass. The message says what to fix.
export class RulesError extends Error {}
const bad = (message) => new RulesError(message);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

// ---- time zones --------------------------------------------------------------------

let zoneSet = null;
// An IANA name Intl lists, case as listed, or UTC (Intl lists canonical names, and UTC is not one of them).
export function isTimeZone(value) {
  if (typeof value !== 'string' || !value) return false;
  if (value === 'UTC') return true;
  zoneSet ??= new Set(Intl.supportedValuesOf('timeZone'));
  return zoneSet.has(value);
}

// The zone a document uses: its own, else the deployment's (DEFAULT_TIME_ZONE), else UTC. A value that is
// not a zone counts as unset, so a mistyped DEFAULT_TIME_ZONE cannot stop a check-in.
export function resolveTimeZone(own, deploymentDefault = '') {
  if (isTimeZone(own)) return own;
  const fallback = typeof deploymentDefault === 'string' ? deploymentDefault.trim() : '';
  return isTimeZone(fallback) ? fallback : 'UTC';
}

const formats = new Map();
// The zone's offset from UTC at an instant, in milliseconds (whole seconds of the instant).
function offsetMs(zone, utcMs) {
  let f = formats.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    formats.set(zone, f);
  }
  const at = Math.floor(utcMs / 1000) * 1000;
  const p = {};
  for (const { type, value } of f.formatToParts(at)) p[type] = Number(value);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - at;
}

// The UTC instant at which the zone's wall clock reads `minutes` past midnight of the calendar date y-m-d.
// A time the clock never shows (a spring-forward gap) lands just after the gap. A time it shows twice (a
// fall-back hour) is the first of the two.
function localToUtc(zone, y, m, d, minutes) {
  const L = Date.UTC(y, m - 1, d, 0, minutes);
  const before = offsetMs(zone, L - DAY_MS);
  const after = offsetMs(zone, L + DAY_MS);
  if (before === after) return L - before;
  const a = L - before;
  const b = L - after;
  const okA = a + offsetMs(zone, a) === L;
  const okB = b + offsetMs(zone, b) === L;
  if (okA && okB) return Math.min(a, b);
  return okB ? b : a;
}

// The zone's calendar date at an instant, as UTC midnight of that date (so its day of week is getUTCDay).
function localDate(zone, utcMs) {
  const local = new Date(utcMs + offsetMs(zone, utcMs));
  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
}

// ---- parsing ------------------------------------------------------------------------

const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const minutesOf = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));

function parseHours(v) {
  if (v === null) return null;
  if (!isObject(v)) throw bad('hours must be null (no business hours) or an object of days');
  const out = {};
  for (const day of Object.keys(v)) if (!DAYS.includes(day)) throw bad(`hours has no day called ${day.slice(0, 20)}; use ${DAYS.join(', ')}`);
  for (const day of DAYS) {
    if (!Object.hasOwn(v, day)) continue;
    const span = v[day];
    if (!Array.isArray(span) || span.length !== 2 || span.some((t) => typeof t !== 'string')) throw bad(`hours.${day} must be ["HH:MM", "HH:MM"]`);
    const [from, to] = span;
    // The end may be 24:00, the end of the day.
    if (!TIME_RE.test(from) || !(TIME_RE.test(to) || to === '24:00')) throw bad(`hours.${day} times must be HH:MM, 00:00 to 23:59 (24:00 for the end of the day)`);
    if (minutesOf(from) >= minutesOf(to)) throw bad(`hours.${day} must end after it starts`);
    out[day] = [from, to];
  }
  if (!Object.keys(out).length) throw bad('hours must name at least one day, or be null');
  return out;
}

function parseList(v, field, { max, check }) {
  if (!Array.isArray(v)) throw bad(`${field} must be a list`);
  if (v.length > LIST_MAX) throw bad(`${field} holds at most ${LIST_MAX} entries`);
  const out = [];
  const seen = new Set();
  for (const item of v) {
    if (typeof item !== 'string') throw bad(`${field} entries must be text`);
    const text = item.trim();
    if (!text || text.length > max) throw bad(`${field} entries must be 1 to ${max} characters`);
    if (CONTROL_CHARS.test(text)) throw bad(`${field} entries must not contain control characters`);
    check(text);
    const key = text.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(text);
    }
  }
  return out;
}

const FOLDER_RE = /^[A-Za-z]:[\\/]/;
function checkFolder(text) {
  if (!FOLDER_RE.test(text)) throw bad('protected_folders entries must be absolute local paths such as C:\\Data');
  if (/[<>"|?*]/.test(text)) throw bad('protected_folders entries must not contain < > " | ? *');
  if (text.split(/[\\/]/).some((part) => part === '.' || part === '..')) throw bad('protected_folders entries must not contain . or .. parts');
}

// The problem with an effective document, or null: an hour rule needs business hours to be about.
export function hourRuleProblem(doc) {
  if (doc.hours) return null;
  const field = ACTIONS.find((a) => HOUR_VALUES.includes(doc[a]));
  return field ? `${field} is ${doc[field]}, which needs business hours; set hours first` : null;
}

// A rules document from a request body or the PC's device.json text. A team's document is whole (a missing
// field takes its default); with { override: true } only the fields sent are kept, since a customer
// overrides some. Throws RulesError, with the message to show, on anything else. Returns the normalised
// document in a fixed field order.
export function parseRules(input, { override = false } = {}) {
  if (!isObject(input)) throw bad('the rules must be an object');
  for (const key of Object.keys(input)) if (!FIELDS.includes(key)) throw bad(`unknown rules field: ${key.slice(0, 40)}`);
  const out = {};
  for (const field of FIELDS) {
    const sent = Object.hasOwn(input, field);
    if (!sent && override) continue;
    const v = sent ? input[field] : DEFAULT_RULES[field];
    if (field === 'time_zone') {
      if (v !== null && !isTimeZone(v)) throw bad('time_zone must be an IANA time zone name such as Asia/Jerusalem, or null for the deployment\'s');
      out.time_zone = v;
    } else if (field === 'hours') {
      out.hours = parseHours(v);
    } else if (ACTIONS.includes(field)) {
      if (!ACTION_VALUES.includes(v)) throw bad(`${field} must be ${ACTION_VALUES.join(', ')}`);
      out[field] = v;
    } else if (field === 'protected_programs') {
      out[field] = parseList(v, field, { max: PROGRAM_MAX, check: () => {} });
    } else {
      out[field] = parseList(v, field, { max: FOLDER_MAX, check: checkFolder });
    }
  }
  // A team's document stands alone, so its hour rules need its hours. An override is checked once merged.
  if (!override) {
    const problem = hourRuleProblem(out);
    if (problem) throw bad(problem);
  }
  return out;
}

// The stored text of a document, read back. A damaged row is the defaults (a team's) or nothing
// (an override), never a throw: writes are checked, so damage is rare, and a check-in must not fail on it.
export function parseStored(text, { override = false } = {}) {
  try {
    return parseRules(JSON.parse(text), { override });
  } catch (_) {
    return override ? {} : parseRules({});
  }
}

// ---- the effective rules ------------------------------------------------------------

// The rules in force for one PC: the team's document with each field the customer's override sets
// replacing it, the time zone resolved (its own, the deployment's, or UTC), and rev the revision to show.
// team and customer are parsed documents (or null). An hour rule left without hours (the team dropped
// them after the override was saved) counts as never, so a hole never loosens a rule.
export function effectiveRules(team, customer = null, { defaultTimeZone = '', rev = 0 } = {}) {
  const merged = { ...DEFAULT_RULES, ...(team ?? {}), ...(customer ?? {}) };
  const out = { rev, time_zone: resolveTimeZone(merged.time_zone, defaultTimeZone), hours: merged.hours ? { ...merged.hours } : null };
  for (const a of ACTIONS) out[a] = !merged.hours && HOUR_VALUES.includes(merged[a]) ? 'never' : merged[a];
  out.protected_programs = [...merged.protected_programs];
  out.protected_folders = [...merged.protected_folders];
  return out;
}

// The same from stored rows: the team's row and the customer's, each { doc, rev } or null. The rev shown
// is the two revisions added, so it moves whenever either row is saved.
export function effectiveFromRows(teamRow, customerRow, { defaultTimeZone = '' } = {}) {
  return effectiveRules(
    teamRow ? parseStored(teamRow.doc) : null,
    customerRow ? parseStored(customerRow.doc, { override: true }) : null,
    { defaultTimeZone, rev: (teamRow?.rev ?? 0) + (customerRow?.rev ?? 0) },
  );
}

const canonical = (v) => (Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
  : isObject(v) ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v));

// A short stable hash of an effective document's content (not its rev), time zone included. The PC
// compares it to learn that its rules differ from the relay's, which also catches a change of the
// deployment's DEFAULT_TIME_ZONE.
export async function rulesTag(effective) {
  const { rev: _rev, ...content } = effective;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(content)));
  return bytesToHex(digest).slice(0, 16);
}

// ---- business hours -----------------------------------------------------------------

// The business-hour spans for the next 8 days, as Unix seconds: { hours_utc: [[start, end], ...],
// hours_until }. hours_until is the end of that horizon. A span that began before now and is still
// running is listed whole. With no hours the list is empty, and every moment before hours_until is
// outside business hours. The caller treats every moment past hours_until as business hours.
export function hoursUtc(rules, nowMs) {
  const nowS = Math.floor(nowMs / 1000);
  const until = nowS + HOURS_HORIZON_S;
  if (!rules.hours) return { hours_utc: [], hours_until: until };
  const zone = resolveTimeZone(rules.time_zone);
  const first = localDate(zone, nowS * 1000);
  const spans = [];
  for (let k = -1; k <= 9; k++) {
    const day = new Date(first + k * DAY_MS);
    const span = rules.hours[DAYS[(day.getUTCDay() + 6) % 7]];
    if (!span) continue;
    const y = day.getUTCFullYear(), m = day.getUTCMonth() + 1, d = day.getUTCDate();
    const start = localToUtc(zone, y, m, d, minutesOf(span[0])) / 1000;
    const end = localToUtc(zone, y, m, d, minutesOf(span[1])) / 1000;
    if (end > nowS && start < until) spans.push([start, end]);
  }
  return { hours_utc: spans, hours_until: until };
}

// Whether a moment is inside business hours. Past the horizon every moment counts as business hours:
// the stricter side, so rules never loosen when the answer is old.
function inHours(nowS, { hours_utc: spans, hours_until: until }) {
  if (nowS >= until) return true;
  return spans.some(([start, end]) => nowS >= start && nowS < end);
}

// ---- names and paths ----------------------------------------------------------------

// A program name for comparison: trimmed, lower case, without a trailing .exe, so a protected
// "Outlook.exe" also covers "outlook".
const programKey = (name) => String(name).trim().toLowerCase().replace(/\.exe$/, '');

// A path as lower-case components: / the same as \, repeated and trailing separators dropped, . and ..
// resolved (never above the drive), the \\?\ prefix dropped, and the trailing dots and spaces Windows
// drops from a name dropped here too. Short names (PROGRA~1) and links stay as written.
function pathParts(path) {
  const parts = [];
  for (const raw of String(path).replace(/^\\\\\?\\/, '').split(/[\\/]+/)) {
    if (raw === '' || raw === '.') continue;
    if (raw === '..') {
      if (parts.length > 1) parts.pop();
      continue;
    }
    const name = raw.replace(/[. ]+$/, '').toLowerCase();
    if (name) parts.push(name);
  }
  return parts;
}

// Whether `path` is the folder or inside it: its whole components start with the folder's, so
// C:\Database is not inside C:\Data.
export function pathInside(folder, path) {
  const f = pathParts(folder);
  const p = pathParts(path);
  return f.length > 0 && p.length >= f.length && f.every((part, i) => part === p[i]);
}

// ---- the decision -------------------------------------------------------------------

const refuse = (code) => ({ refuse: code, text: REFUSALS[code] });
const NEEDS_FULL = Object.freeze(['restart', 'shutdown', 'install', 'uninstall']);

// Judge one action against effective rules. Returns { allow: true }, { approve: true } (a technician must
// approve it in the app) or { refuse: code, text }.
//   action  one of ACTIONS or FILE_ACTIONS
//   ctx     { nowMs, hours?: { hours_utc, hours_until } (worked out from the rules when left out),
//             control?: 'full' | 'limited', program?: a program name, path?: an absolute path }
// The order is fixed because the PC runs the same cases: the rule's own never, full control, protected
// programs and folders, and last the value (allow, approve, or an hour rule).
export function decide(rules, action, ctx = {}) {
  if (!ACTIONS.includes(action) && !FILE_ACTIONS.includes(action)) throw new TypeError(`not an action: ${String(action).slice(0, 40)}`);
  const guarded = ACTIONS.includes(action);
  // An unknown value counts as never.
  const value = guarded ? (ACTION_VALUES.includes(rules[action]) ? rules[action] : 'never') : 'allow';
  if (value === 'never') return refuse('rule_never');
  if (NEEDS_FULL.includes(action) && ctx.control === 'limited') return refuse('needs_full_control');
  if ((action === 'close_program' || action === 'uninstall') && typeof ctx.program === 'string') {
    const key = programKey(ctx.program);
    if ((rules.protected_programs ?? []).some((p) => programKey(p) === key)) return refuse('protected_program');
  }
  if ((action === 'put_file' || action === 'get_file' || action === 'install') && typeof ctx.path === 'string') {
    if ((rules.protected_folders ?? []).some((f) => pathInside(f, ctx.path))) return refuse('protected_folder');
  }
  if (value === 'allow') return { allow: true };
  if (value === 'approve') return { approve: true };
  const nowS = Math.floor((ctx.nowMs ?? Date.now()) / 1000);
  const inside = inHours(nowS, ctx.hours ?? hoursUtc(rules, nowS * 1000));
  if (value === 'approve_in_hours') return inside ? { approve: true } : { allow: true };
  return inside ? refuse('business_hours') : { allow: true };
}
