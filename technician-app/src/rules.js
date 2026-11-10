// The team's rules as the Rules screen and a PC's detail work with them. The relay owns the document and
// checks every save (src/rules.js of the relay); these helpers only shape what a person edits and shows, and
// catch the mistakes a form can catch before a code is asked for.
//
// A document: { time_zone: name | null, hours: null | { mon: ['08:00', '18:00'], ... }, restart, shutdown, install,
// uninstall, close_program: an action value, protected_programs: [name], protected_folders: [path] }. A customer's
// override has the same fields, each optional: a field it sets replaces the team's, a list replaces and never merges.
import { t } from './i18n/index.js';

export const ACTIONS = ['restart', 'shutdown', 'install', 'uninstall', 'close_program'];
export const VALUES = ['allow', 'approve', 'approve_in_hours', 'outside_hours', 'never'];
export const HOUR_VALUES = ['approve_in_hours', 'outside_hours'];
export const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
export const LIST_MAX = 50;
export const PROGRAM_MAX = 100;
export const FOLDER_MAX = 260;
// A whole drive (C:\, c:/) is not a folder to protect: it would refuse every file and installer of the PC. The relay refuses it too.
export const isDriveRoot = (path) => /^[A-Za-z]:[\\/]*$/.test(String(path).trim());
export const FIELDS = ['time_zone', 'hours', ...ACTIONS, 'protected_programs', 'protected_folders'];

// What a team with no saved rules has (the relay uses the same).
export const DEFAULT_DOC = Object.freeze({
  time_zone: null,
  hours: null,
  restart: 'approve',
  shutdown: 'approve',
  install: 'approve',
  uninstall: 'approve',
  close_program: 'allow',
  protected_programs: [],
  protected_folders: [],
});

// The team's document filled out with its defaults.
export const teamDoc = (doc) => ({ ...DEFAULT_DOC, ...(doc ?? {}), protected_programs: [...(doc?.protected_programs ?? [])], protected_folders: [...(doc?.protected_folders ?? [])] });

// The rules in force for a customer: the team's with each field the override sets replacing it. An hour rule left
// without hours counts as never, as the relay reads it. `defaultTimeZone` is the deployment's.
export function effective(team, override, defaultTimeZone = 'UTC') {
  const merged = { ...teamDoc(team), ...(override ?? {}) };
  const out = { time_zone: merged.time_zone || defaultTimeZone || 'UTC', hours: merged.hours ? { ...merged.hours } : null };
  for (const a of ACTIONS) out[a] = !merged.hours && HOUR_VALUES.includes(merged[a]) ? 'never' : merged[a];
  out.protected_programs = [...merged.protected_programs];
  out.protected_folders = [...merged.protected_folders];
  return out;
}

// Every time zone the platform knows, plus UTC, sorted.
let zones = null;
export function timeZones() {
  if (zones) return zones;
  let list = [];
  try {
    list = Intl.supportedValuesOf('timeZone');
  } catch (_) {
    list = [];
  }
  zones = [...new Set([...list, 'UTC'])].sort();
  return zones;
}

// Business hours in day order, so the order days were opened in does not make two equal hours differ.
const dayOrder = (hours) => (hours ? DAYS.map((d) => hours[d] ?? null) : null);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The fields in which an edited document differs from the one that was read.
export const changedFields = (before, after) => FIELDS.filter((f) => {
  if (Object.hasOwn(before ?? {}, f) !== Object.hasOwn(after ?? {}, f)) return true;
  return f === 'hours' ? !same(dayOrder(before?.[f]), dayOrder(after?.[f])) : !same(before?.[f], after?.[f]);
});

const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const minutes = (v) => Number(v.slice(0, 2)) * 60 + Number(v.slice(3));

// The first thing wrong with a document that is about to be saved, as { key, vars } for t(), or null. `merged` is the
// document in force (the team's, or the team's with the override), which is what an hour value needs hours from.
export function problemWith(doc, merged) {
  if (doc.time_zone && !timeZones().includes(doc.time_zone)) return { key: 'rules.err_zone', vars: { zone: doc.time_zone } };
  if (doc.hours) {
    for (const day of DAYS) {
      const span = doc.hours[day];
      if (!span) continue;
      const [from, to] = span;
      if (!TIME_RE.test(from ?? '') || !(TIME_RE.test(to ?? '') || to === '24:00')) return { key: 'rules.err_time', vars: { day: t(`day.${day}`) } };
      if (minutes(from) >= minutes(to)) return { key: 'rules.err_order', vars: { day: t(`day.${day}`) } };
    }
    if (!Object.keys(doc.hours).length) return { key: 'rules.err_no_days', vars: {} };
  }
  if (!merged.hours) {
    const field = ACTIONS.find((a) => HOUR_VALUES.includes(merged[a]));
    if (field) return { key: 'rules.err_hours_needed', vars: { action: t(`rules.action_${field}`) } };
  }
  for (const f of ['protected_programs', 'protected_folders']) {
    const list = doc[f];
    if (!list) continue;
    if (list.length > LIST_MAX) return { key: 'rules.err_list_long', vars: { max: LIST_MAX } };
  }
  for (const folder of doc.protected_folders ?? []) {
    if (!/^[A-Za-z]:[\\/]/.test(folder)) return { key: 'rules.err_folder', vars: { path: folder } };
    if (isDriveRoot(folder)) return { key: 'rules.err_folder_root', vars: { path: folder } };
  }
  return null;
}

// Business hours in a line: "Monday to Friday 08:00 to 18:00, Saturday 08:00 to 13:00". Days with the same times are grouped when they
// follow each other, and the week is a circle: Sunday sits next to Monday and to Saturday, so a Sunday-to-Thursday week reads as one run.
export function hoursSummary(hours) {
  if (!hours) return t('rules.no_hours');
  const n = DAYS.length;
  const label = (i) => (hours[DAYS[i]] ? `${hours[DAYS[i]][0]} ${t('rules.to')} ${hours[DAYS[i]][1]}` : null);
  const open = DAYS.map((_, i) => label(i));
  if (open.every((l) => l === null)) return '';
  // Start where a run begins: a day whose times differ from the day before it. With the same times all week there is no such day.
  let start = open.findIndex((l, i) => l !== null && l !== open[(i + n - 1) % n]);
  if (start < 0) start = 0;
  const runs = [];
  for (let k = 0; k < n; k++) {
    const i = (start + k) % n;
    if (open[i] === null) continue;
    const last = runs[runs.length - 1];
    if (last && last.label === open[i] && last.end === (i + n - 1) % n) { last.end = i; last.to = DAYS[i]; } else runs.push({ from: DAYS[i], to: DAYS[i], end: i, label: open[i] });
  }
  // At most one run crosses the Sunday to Monday line. It reads first (Sunday to Thursday), the others from Monday on.
  const wraps = (r) => DAYS.indexOf(r.to) < DAYS.indexOf(r.from);
  runs.sort((a, b) => (wraps(b) ? 1 : 0) - (wraps(a) ? 1 : 0) || DAYS.indexOf(a.from) - DAYS.indexOf(b.from));
  return runs.map((r) => `${r.from === r.to ? t(`day.${r.from}`) : t('rules.days_range', { from: t(`day.${r.from}`), to: t(`day.${r.to}`) })} ${r.label}`).join(', ');
}
