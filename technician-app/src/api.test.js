import { describe, expect, test, vi } from 'vitest';
import { fetchDevices, fetchPlaces, isLiveTask, messageOf, taskOnSession } from './api.js';
import { device } from './test-utils.jsx';

describe('api', () => {
  test('the device list follows next and marks who is online', async () => {
    const pages = [{ devices: [device({ id: 'a'.repeat(20) })], next: 'a'.repeat(20) }, { devices: [device({ id: 'b'.repeat(20), name: 'Back', online: false, access: 'ask', status: 'pending' })], next: null }];
    const tool = vi.fn(async (_a, _n, args) => ({ data: args.after ? pages[1] : pages[0] }));
    const out = await fetchDevices({ tool }, 'acc');
    expect(out.map((d) => [d.name, d.online, d.status, d.access])).toEqual([['Front counter', true, 'active', 'any'], ['Back', false, 'pending', 'ask']]);
    expect(tool).toHaveBeenCalledTimes(2);
    expect(tool.mock.calls[1][2]).toEqual({ after: 'a'.repeat(20) });
  });

  test('sites carry their customer name', async () => {
    const request = vi.fn(async (_a, _m, path) => (path.startsWith('/api/sites') ? { sites: [{ id: 's', customer_id: 'k', name: 'Bakery' }], next: null } : { customers: [{ id: 'k', name: 'Hadar Ltd' }], next: null }));
    const places = await fetchPlaces({ request }, 'acc');
    expect(places.get('s')).toEqual({ name: 'Bakery', customer: 'Hadar Ltd' });
  });

  test('a task is live while it runs or waits to be resumed', () => {
    expect(isLiveTask({ state: 'running' })).toBe(true);
    expect(isLiveTask({ state: 'paused' })).toBe(true);
    expect(isLiveTask({ state: 'done' })).toBeFalsy();
    const tasks = [{ id: '1', session_id: 's1', state: 'done' }, { id: '2', session_id: 's1', state: 'running' }, { id: '3', session_id: 's2', state: 'running' }];
    expect(taskOnSession(tasks, 's1').id).toBe('2');
    expect(taskOnSession(tasks, 's9')).toBeNull();
  });

  test('an error shows the relay words, or a fallback', () => {
    expect(messageOf({ message: 'nope' }, 'x')).toBe('nope');
    expect(messageOf(null, 'fallback')).toBe('fallback');
    expect(messageOf({ message: '' }, 'fallback')).toBe('fallback');
    // A message of the core's own is shown in en.json's words, by its reason; the relay's words as they are.
    expect(messageOf({ code: 'unavailable', reason: 'relay_busy', message: 'The relay is busy (English from the core).' }, 'x')).toBe('The relay is busy. Try again in a moment.');
    expect(messageOf({ code: 'invalid', reason: 'no_such_reason_yet', message: 'kept as it is' }, 'x')).toBe('kept as it is');
    expect(messageOf({ code: 'confirm_wrong', reason: null, message: 'That number is wrong' }, 'x')).toBe('That number is wrong');
  });
});
