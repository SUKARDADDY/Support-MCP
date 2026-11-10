import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import en from './en.json';
import { hasKey, t, tn } from './index.js';

const SRC = join(import.meta.dirname, '..');
function sources(dir = SRC) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === 'fonts' || name === 'styles' ? [] : sources(full);
    return /\.(jsx?|js)$/.test(name) && !/\.test\./.test(name) && name !== 'test-utils.jsx' ? [full] : [];
  });
}

describe('strings', () => {
  test('every key a screen asks for is in en.json', () => {
    const missing = [];
    for (const file of sources()) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/\bt[n]?\(\s*'([a-z0-9_.]+)'/g)) {
        const key = m[1];
        const plural = text.slice(m.index, m.index + 3).startsWith('tn(');
        const present = plural ? hasKey(`${key}_one`) && hasKey(`${key}_other`) : hasKey(key);
        if (!present) missing.push(`${file.replace(SRC, '')}: ${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test('the keys built from a word are all there', () => {
    const families = {
      status: ['online', 'offline', 'connecting', 'asking', 'connected', 'waiting'],
      filter: ['all', 'online', 'offline', 'waiting', 'any', 'ask'],
      theme: ['light', 'dark', 'system'],
      control: ['full', 'limited'],
    };
    for (const [family, words] of Object.entries(families)) for (const w of words) expect(hasKey(`${family}.${w}`), `${family}.${w}`).toBe(true);
    for (const a of ['any', 'ask']) for (const part of ['label', 'title', 'tech']) expect(hasKey(`access.${a}.${part}`)).toBe(true);
    for (const e of ['task_finished', 'task_problem', 'session_declined', 'device_online', 'device_missing', 'device_waiting', 'escalation_opened', 'escalation_claimed']) {
      expect(hasKey(`event.${e}.name`)).toBe(true);
      expect(hasKey(`event.${e}.help`)).toBe(true);
    }
    for (const k of ['declined', 'nobody', 'busy', 'owner_ended', 'ended_early']) expect(hasKey(`connect.${k}`)).toBe(true);
  });

  test('plain prose: no em dashes, no uppercase-only labels, no raw HTML', () => {
    for (const [key, text] of Object.entries(en)) {
      expect(text, key).not.toMatch(/—|–/);
      expect(text, key).not.toMatch(/<[a-z/]/i);
      if (text.length > 3) expect(text, key).not.toBe(text.toUpperCase());
    }
  });

  test('t fills {name} and shows the key for a gap', () => {
    expect(t('connect.hint_ask', { name: 'Back office' })).toBe('Someone at Back office is asked to click Allow.');
    expect(t('no.such.key')).toBe('no.such.key');
    expect(t('connect.hint_ask')).toContain('{name}');
    expect(tn('time.minutes_ago', 1)).toBe('1 minute ago');
    expect(tn('time.minutes_ago', 5)).toBe('5 minutes ago');
  });
});
