import { describe, expect, test } from 'vitest';
import { cleanCode, formatAgo, formatDuration } from './format.js';

describe('format', () => {
  test('durations', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(7000)).toBe('0:07');
    expect(formatDuration(754000)).toBe('12:34');
    expect(formatDuration(3723000)).toBe('1:02:03');
    expect(formatDuration(-5)).toBe('0:00');
  });

  test('how long ago', () => {
    const now = Date.parse('2026-11-09T12:00:00Z');
    expect(formatAgo(now - 10_000, now)).toBe('just now');
    expect(formatAgo(now - 60_000, now)).toBe('1 minute ago');
    expect(formatAgo(now - 5 * 60_000, now)).toBe('5 minutes ago');
    expect(formatAgo(now - 3 * 3600_000, now)).toBe('3 hours ago');
    expect(formatAgo(now - 5 * 86400_000, now, 'en-GB')).toBe('4 Nov 2026');
    expect(formatAgo(undefined, now)).toBe('');
  });

  test('a pairing code with or without its hyphen', () => {
    expect(cleanCode('k7q42-m9h3x')).toBe('K7Q42M9H3X');
  });
});
