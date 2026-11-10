import { t, tn } from './i18n/index.js';

const pad = (n) => String(n).padStart(2, '0');

// 0:07, 12:34, 1:02:03
export function formatDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

// "Mon 2 Nov, 10:14" in the person's own language and time zone.
export function formatDateTime(ms, locale) {
  if (!Number.isFinite(ms)) return '';
  return new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
}

export function formatDate(ms, locale) {
  if (!Number.isFinite(ms)) return '';
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(ms));
}

export function formatClock(ms, locale) {
  if (!Number.isFinite(ms)) return '';
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(ms));
}

// "just now", "5 minutes ago", "3 hours ago", or the date for anything older than 2 days.
export function formatAgo(ms, now = Date.now(), locale) {
  if (!Number.isFinite(ms)) return '';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return t('time.just_now');
  const m = Math.round(s / 60);
  if (m < 60) return tn('time.minutes_ago', m);
  const h = Math.round(m / 60);
  if (h < 48) return tn('time.hours_ago', h);
  return formatDate(ms, locale);
}

// Dollars for a task's cost: $0.42, $2.00, and three places for a few cents so $0.003 is not $0.00.
export function formatUsd(amount, locale) {
  if (!Number.isFinite(amount)) return '';
  const places = amount > 0 && amount < 1 ? 3 : 2;
  return new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: places }).format(amount);
}

// The relay keeps the first 100 characters of a task's instructions as its title and cuts
// there, mid-word. These show a title or a task notification whole where the app has the
// instructions (it started the task: `full` is their first line), and otherwise stop at the
// last whole word with an ellipsis. Rust does the same for the Windows toast (feed.rs).
const TITLE_CUT = 100;

export function cutAtWord(text) {
  const s = String(text ?? '');
  const space = s.search(/\s\S*$/);
  const head = space > 0 ? s.slice(0, space) : s;
  return `${head.replace(/[\s,;:-]+$/, '')}\u2026`;
}

export function taskTitle(title, full = null) {
  const s = String(title ?? '');
  if (full && full.length > s.length && full.startsWith(s)) return full;
  return s.length === TITLE_CUT ? cutAtWord(s) : s;
}

// The body of a task notification: the title alone ("Task finished"), or the title, ": " and why.
export function taskBody(event, body, full = null) {
  const s = String(body ?? '');
  if (event === 'task_finished') return taskTitle(s, full);
  if (event === 'task_problem' && s.length > TITLE_CUT + 1 && s.slice(TITLE_CUT, TITLE_CUT + 2) === ': ') return taskTitle(s.slice(0, TITLE_CUT), full) + s.slice(TITLE_CUT);
  return s;
}

// The ten-character pairing code, as the relay shows it (ABCDE-FGH23), for a field that
// takes it with or without the hyphen.
export const cleanCode = (v) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// How long ago a moment was, short: "12 s", "3 min", "2 h". For the age of a picture.
export function formatAge(ms, now = Date.now()) {
  if (!Number.isFinite(ms)) return '';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 90) return t('time.age_s', { count: s });
  const m = Math.round(s / 60);
  if (m < 90) return t('time.age_min', { count: m });
  return t('time.age_h', { count: Math.round(m / 60) });
}
