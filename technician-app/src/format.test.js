import { describe, expect, test } from 'vitest';
import { cleanCode, cutAtWord, formatAgo, formatDuration, formatUsd, taskBody, taskTitle } from './format.js';

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

  test('dollars', () => {
    expect(formatUsd(0.42)).toBe('$0.42');
    expect(formatUsd(2)).toBe('$2.00');
    expect(formatUsd(0.003)).toBe('$0.003');
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(undefined)).toBe('');
  });

  describe('task titles the relay cut at 100 characters', () => {
    const cut = 'Check why the receipt printer at the front counter stopped printing after the update, then finish wi';
    const whole = 'Check why the receipt printer at the front counter stopped printing after the update, then finish with a test page';

    test('a cut title ends at a whole word with an ellipsis', () => {
      expect(cut).toHaveLength(100);
      expect(cutAtWord(cut)).toBe('Check why the receipt printer at the front counter stopped printing after the update, then finish\u2026');
      expect(cutAtWord('x'.repeat(100))).toBe(`${'x'.repeat(100)}\u2026`);
      expect(cutAtWord('one two, three: ')).toBe('one two, three\u2026');
    });

    test('the full first line wins when the app has it, and a short title is left alone', () => {
      expect(taskTitle(cut, whole)).toBe(whole);
      expect(taskTitle(cut)).toBe('Check why the receipt printer at the front counter stopped printing after the update, then finish\u2026');
      expect(taskTitle('Fix the printer')).toBe('Fix the printer');
      expect(taskTitle('Fix the printer', 'Fix the printer')).toBe('Fix the printer');
      // Instructions for another task never replace a title they do not begin.
      expect(taskTitle(cut, 'Something else entirely, and a long one at that, longer than the title it is offered for here')).toBe(cutAtWord(cut));
    });

    test('a notification body is the title alone, or the title and why', () => {
      expect(taskBody('task_finished', cut, whole)).toBe(whole);
      expect(taskBody('task_finished', cut)).toBe(cutAtWord(cut));
      expect(taskBody('task_problem', `${cut}: the agent got stuck`, whole)).toBe(`${whole}: the agent got stuck`);
      expect(taskBody('task_problem', `${cut}: the agent got stuck`)).toBe(`${cutAtWord(cut)}: the agent got stuck`);
      expect(taskBody('task_problem', 'Fix the printer: stuck')).toBe('Fix the printer: stuck');
      expect(taskBody('device_waiting', cut)).toBe(cut);
      expect(taskBody('task_finished', undefined)).toBe('');
    });
  });
});
