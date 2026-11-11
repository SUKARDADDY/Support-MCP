import { describe, expect, test, vi } from 'vitest';
import { answerApproval, codeProblem, codedText, fetchCustomerRules, fetchCustomers, fetchPlaces, fetchDevices, fetchRules, isLiveTask, listApprovals, listPairings, messageOf, refusalText, removeOverride, saveRules, taskOnSession } from './api.js';
import { hasKey } from './i18n/index.js';
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
    expect(places.get('s')).toEqual({ name: 'Bakery', customer: 'Hadar Ltd', customerId: 'k' });
  });

  test('the pairing list is the relay\'s list, and an answer without one is an error, not an empty list', async () => {
    expect(await listPairings({ request: async () => ({ pairings: [{ id: 'p1' }] }) }, 'acc')).toEqual([{ id: 'p1' }]);
    expect(await listPairings({ request: async () => ({ pairings: [] }) }, 'acc')).toEqual([]);
    for (const odd of [{}, null, { pairings: null }, { pairings: 'x' }]) await expect(listPairings({ request: async () => odd }, 'acc')).rejects.toThrow(/pairing list/);
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

  test('the rules are the team\'s document and each customer\'s override, with the deployment\'s zone', async () => {
    const request = vi.fn(async () => ({ rules: { rev: 2, doc: { restart: 'never' }, updated_at: 5, updated_by: 'boss@example.com' }, overrides: [{ customer_id: 'k', rev: 1, doc: { shutdown: 'allow' }, updated_at: 6, updated_by: 'boss@example.com' }], default_time_zone: 'Asia/Jerusalem' }));
    const out = await fetchRules({ request }, 'acc');
    expect(request).toHaveBeenCalledWith('acc', 'GET', '/api/rules');
    expect(out.team).toEqual({ rev: 2, doc: { restart: 'never' }, updatedAt: 5, updatedBy: 'boss@example.com' });
    expect(out.overrides.get('k')).toEqual({ rev: 1, doc: { shutdown: 'allow' }, updatedAt: 6, updatedBy: 'boss@example.com' });
    expect(out.defaultTimeZone).toBe('Asia/Jerusalem');
    // No overrides, and no zone sent: UTC. An answer with no rules is an error, not defaults.
    expect((await fetchRules({ request: async () => ({ rules: { rev: 0, doc: {} } }) }, 'acc')).defaultTimeZone).toBe('UTC');
    await expect(fetchRules({ request: async () => ({}) }, 'acc')).rejects.toThrow(/rules are missing/);
  });

  test('a customer\'s rules come with the rules in force, and every customer is read page by page', async () => {
    const request = vi.fn(async () => ({ customer_id: 'k', rev: 1, doc: { restart: 'never' }, effective: { restart: 'never', hours: null } }));
    const out = await fetchCustomerRules({ request }, 'acc', 'k');
    expect(request).toHaveBeenCalledWith('acc', 'GET', '/api/rules/k');
    expect(out.effective).toEqual({ restart: 'never', hours: null });
    await expect(fetchCustomerRules({ request: async () => ({ customer_id: 'k', rev: 0, doc: {} }) }, 'acc', 'k')).rejects.toThrow(/rules are missing/);
    const pages = [{ customers: [{ id: 'a', name: 'A' }], next: 'a' }, { customers: [{ id: 'b', name: 'B' }], next: null }];
    const list = vi.fn(async (_a, _m, path) => pages[path.includes('after=a') ? 1 : 0]);
    expect(await fetchCustomers({ request: list }, 'acc')).toEqual([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
  });

  test('a save sends the whole document, the revision and the code to the team\'s or the customer\'s route; a removal sends the revision and the code', async () => {
    const request = vi.fn(async (_a, method, path) => (method === 'DELETE' ? { removed: { customer_id: 'k' } } : path === '/api/rules' ? { rules: { rev: 3, doc: { restart: 'never' }, updated_at: 1, updated_by: 'x' } } : { override: { customer_id: 'k', rev: 1, doc: {}, updated_at: 1, updated_by: 'x' } }));
    const saved = await saveRules({ request }, 'acc', null, { restart: 'never' }, 2, '123456');
    expect(request).toHaveBeenLastCalledWith('acc', 'PATCH', '/api/rules', { doc: { restart: 'never' }, rev: 2, code: '123456' });
    expect(saved.rev).toBe(3);
    expect((await saveRules({ request }, 'acc', 'k', {}, 0, '123456')).rev).toBe(1);
    expect(request).toHaveBeenLastCalledWith('acc', 'PATCH', '/api/rules/k', { doc: {}, rev: 0, code: '123456' });
    await removeOverride({ request }, 'acc', 'k', 1, '654321');
    expect(request).toHaveBeenLastCalledWith('acc', 'DELETE', '/api/rules/k', { rev: 1, code: '654321' });
  });

  test('approvals: the list is one or none, Approve sends its code and Deny sends none', async () => {
    const sid = 's'.repeat(64);
    const aid = 'a'.repeat(32);
    expect(await listApprovals({ request: async () => ({ approvals: [{ id: aid }] }) }, 'acc', sid)).toEqual([{ id: aid }]);
    expect(await listApprovals({ request: async () => ({}) }, 'acc', sid)).toEqual([]);
    const request = vi.fn(async () => ({ id: aid, approved: true }));
    await answerApproval({ request }, 'acc', sid, aid, true, '123456');
    expect(request).toHaveBeenLastCalledWith('acc', 'POST', `/api/sessions/${sid}/approvals/${aid}`, { approve: true, code: '123456' });
    await answerApproval({ request }, 'acc', sid, aid, false, '123456');
    expect(request).toHaveBeenLastCalledWith('acc', 'POST', `/api/sessions/${sid}/approvals/${aid}`, { approve: false });
  });

  test('a refused code is told in our words: wrong or used, no authenticator, locked; anything else is not a code problem', () => {
    expect(codeProblem({ code: 'second_factor', message: 'that code is wrong or was already used; wait for the next one' })).toMatch(/wrong or was already used/);
    expect(codeProblem({ code: 'second_factor', message: 'set up an authenticator on your account first, then send a code from it' })).toMatch(/Set up an authenticator app/);
    expect(codeProblem({ code: 'locked', message: 'too many wrong codes' })).toMatch(/locked/);
    for (const other of [{ code: 'stale' }, { code: 'bad_request', message: 'send code: a fresh code' }, null, undefined]) expect(codeProblem(other)).toBeNull();
  });

  test('a coded sentence of a tool is told in our words for the code, and anything else stays as it is', () => {
    expect(codedText('rule_never: the team\'s rules never allow this action on this PC')).toBe('The team\'s rules never allow that action on this PC.');
    expect(codedText('approval_timeout: no technician answered within 5 minutes')).toMatch(/^Nobody approved the action within 5 minutes/);
    for (const plain of ['no code here', 'unknown_code: text', 'Rule_never: capital', 'rule_never:no space', '', null, undefined]) expect(codedText(plain)).toBe(plain);
  });

  test('every refusal code the rules and the approvals use has words, and the tool errors use them', () => {
    const codes = ['rule_never', 'business_hours', 'declined', 'approval_timeout', 'approval_unavailable', 'busy', 'rules_stale', 'protected_program', 'protected_folder', 'use_tool', 'needs_full_control', 'not_found', 'needs_update', 'not_saved_pc'];
    for (const code of codes) {
      expect(hasKey(`refuse.${code}`), code).toBe(true);
      expect(refusalText({ code, message: 'the relay\'s English' }, 'fallback'), code).not.toBe('the relay\'s English');
    }
  });
});
