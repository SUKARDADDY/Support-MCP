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

// The ten-character pairing code, as the relay shows it (ABCDE-FGH23), for a field that
// takes it with or without the hyphen.
export const cleanCode = (v) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
