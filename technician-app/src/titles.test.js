import { beforeEach, describe, expect, test } from 'vitest';
import { firstLine, loadTitles, withTitle } from './titles.js';

describe('titles of the tasks this app started', () => {
  beforeEach(() => localStorage.clear());

  test('keeps the first line, saves it, and loads it again', () => {
    expect(firstLine('  Fix the printer\nthen reboot ')).toBe('Fix the printer');
    const map = withTitle({}, 'abc', 'Fix the printer\nthen reboot');
    expect(map).toEqual({ abc: 'Fix the printer' });
    expect(loadTitles()).toEqual({ abc: 'Fix the printer' });
  });

  test('keeps the last 50 and ignores empty input', () => {
    let map = {};
    for (let i = 0; i < 60; i += 1) map = withTitle(map, `task${i}`, `Job ${i}`);
    expect(Object.keys(map)).toHaveLength(50);
    expect(map.task0).toBeUndefined();
    expect(map.task59).toBe('Job 59');
    expect(withTitle(map, '', 'x')).toBe(map);
    expect(withTitle(map, 'y', '  ')).toBe(map);
  });

  test('damaged storage loads as nothing', () => {
    localStorage.setItem('support.task_titles', '[1,2');
    expect(loadTitles()).toEqual({});
    localStorage.setItem('support.task_titles', '[1]');
    expect(loadTitles()).toEqual({});
  });
});
