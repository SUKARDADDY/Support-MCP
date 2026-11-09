import { describe, expect, test } from 'vitest';
import { errorInfo } from './core.js';
import en from './i18n/en.json';

describe('errorInfo', () => {
  test('keeps what the core sent', () => {
    expect(errorInfo({ code: 'unavailable', message: 'busy', status: null, reason: 'relay_busy' })).toEqual({ code: 'unavailable', message: 'busy', status: null, reason: 'relay_busy' });
  });

  test('a failure that is not the core\'s says so in en.json\'s words', () => {
    for (const odd of [undefined, null, 42, {}]) expect(errorInfo(odd).message).toBe(en['error.generic']);
    expect(errorInfo('plain text').message).toBe('plain text');
    expect(errorInfo(undefined).code).toBe('internal');
  });
});
