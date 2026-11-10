import { beforeEach, describe, expect, test } from 'vitest';
import { applyTheme, loadTheme, resolveMode, saveTheme } from './theme.js';

describe('theme', () => {
  beforeEach(() => localStorage.clear());

  test('light, dark and system resolve to a mode', () => {
    expect(resolveMode('light', true)).toBe('light');
    expect(resolveMode('dark', false)).toBe('dark');
    expect(resolveMode('system', true)).toBe('dark');
    expect(resolveMode('system', false)).toBe('light');
  });

  test('the choice is saved, and a bad value falls back to system', () => {
    expect(loadTheme()).toBe('system');
    saveTheme('dark');
    expect(loadTheme()).toBe('dark');
    localStorage.setItem('support.theme', 'neon');
    expect(loadTheme()).toBe('system');
  });

  test('system follows the operating system as it changes', () => {
    const listeners = new Set();
    const media = { matches: false, addEventListener: (_e, f) => listeners.add(f), removeEventListener: (_e, f) => listeners.delete(f) };
    const root = { dataset: {} };
    const stop = applyTheme('system', root, media);
    expect(root.dataset.mode).toBe('light');
    media.matches = true;
    listeners.forEach((f) => f());
    expect(root.dataset.mode).toBe('dark');
    stop();
    expect(listeners.size).toBe(0);
    applyTheme('light', root, media);
    expect(root.dataset.mode).toBe('light');
  });
});
