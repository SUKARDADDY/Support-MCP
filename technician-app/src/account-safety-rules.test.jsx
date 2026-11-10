// Late answers of the rules and approvals calls. Each is made as the team it belongs to; an answer that comes back after
// the team was switched is never announced, shown or opened under the other team, and a notice for another team waits
// until that team is shown.
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test } from 'vitest';
import { ACCOUNT, AID, GOOD_CODE, ID, SID as sid, device, fakeCore, renderApp } from './test-utils.jsx';
import { DEFAULT_DOC } from './rules.js';

const SECOND = { ...ACCOUNT, id: 'acc2', team: 'acme', team_name: 'Acme Support' };
const SID = sid('n');
const MANAGER = ['devices.view', 'devices.manage', 'sessions.create', 'sessions.view', 'sessions.control', 'sessions.end', 'sessions.unattended', 'rules.manage'];
const sleep = (ms) => act(() => new Promise((r) => setTimeout(r, ms)));
const deferred = () => {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
};
const requestsAs = (fake, method, pattern) => fake.core.request.mock.calls.filter((c) => c[1] === method && pattern.test(c[2])).map((c) => c[0]);
afterEach(() => localStorage.clear());

// Goes to the other team, or back, the way a click on a notification of that team does.
const gotoTeam = (fake, id) => act(() => fake.emit('ui://open', { account: id, event: 'device_online', device_id: null, task_id: null, session_id: null }));

// Each team has its own PCs and its own rules, so another team's on screen is easy to see.
function twoTeams() {
  const fake = fakeCore({ accounts: [ACCOUNT, SECOND], permissions: MANAGER });
  fake.state.deviceList = (account) => ({ devices: account === 'acc2' ? [device({ id: ID('q'), name: 'Acme PC' })] : [device()], next: null });
  const rulesOf = { acc1: { team: { rev: 1, doc: { ...DEFAULT_DOC, restart: 'never' }, updated_at: 1, updated_by: 'boss@example.com' }, overrides: {}, defaultTimeZone: 'UTC' }, acc2: { team: { rev: 7, doc: { ...DEFAULT_DOC, restart: 'allow' }, updated_at: 1, updated_by: 'boss@example.com' }, overrides: {}, defaultTimeZone: 'UTC' } };
  fake.state.rulesFor = (account) => rulesOf[account];
  return { fake, rulesOf };
}
async function start(fake) {
  renderApp(fake);
  const user = userEvent.setup();
  await screen.findByRole('button', { name: /Front counter/ });
  await waitFor(() => expect(fake.core.on).toHaveBeenCalledWith('ui://open', expect.any(Function)));
  await waitFor(() => expect(fake.core.on).toHaveBeenCalledWith('feed://items', expect.any(Function)));
  return user;
}
const openRules = async (user) => {
  await user.click(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('button', { name: 'Rules' }));
  await screen.findByRole('combobox', { name: 'Restart the PC' });
};

describe('the Rules screen and the team changing under it', () => {
  test('a save whose answer comes after a switch is made as its own team, is not announced under the other, and starts no read for it', async () => {
    const { fake, rulesOf } = twoTeams();
    const gate = deferred();
    fake.state.saveGate = gate.promise;
    const user = await start(fake);
    await openRules(user);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Close a program' }), 'never');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save the rules' });
    await user.type(within(dialog).getByLabelText('Code from your authenticator app'), GOOD_CODE);
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(requestsAs(fake, 'PATCH', /^\/api\/rules$/)).toEqual(['acc1']));
    gotoTeam(fake, 'acc2');
    await screen.findByRole('button', { name: /Acme PC/ });
    const readsBefore = requestsAs(fake, 'GET', /^\/api\/rules$/).length;
    gate.resolve();
    await sleep(120);
    expect(screen.queryByText('Rules saved.')).not.toBeInTheDocument();
    expect(requestsAs(fake, 'PATCH', /^\/api\/rules$/)).toEqual(['acc1']);
    expect(requestsAs(fake, 'GET', /^\/api\/rules$/)).toHaveLength(readsBefore);
    // The save did land in its own team, and the other team's rules were not touched.
    expect(rulesOf.acc1.team.doc.close_program).toBe('never');
    expect(rulesOf.acc2.team.doc.close_program).toBe('allow');
    // The other team's Rules screen shows its own rules.
    await openRules(user);
    expect(screen.getByRole('combobox', { name: 'Restart the PC' })).toHaveValue('allow');
    expect(screen.getByRole('combobox', { name: 'Close a program' })).toHaveValue('allow');
  });

  test('rules read for the old team that arrive after a switch do not replace the new team\'s', async () => {
    const { fake } = twoTeams();
    const gate = deferred();
    // Only the first team's read is held.
    const real = fake.core.request.getMockImplementation();
    fake.core.request.mockImplementation(async (account, method, path, body) => {
      if (account === 'acc1' && method === 'GET' && path === '/api/rules') await gate.promise;
      return real(account, method, path, body);
    });
    const user = await start(fake);
    await user.click(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('button', { name: 'Rules' }));
    await screen.findByRole('heading', { name: 'Rules' });
    gotoTeam(fake, 'acc2');
    await screen.findByRole('button', { name: /Acme PC/ });
    await openRules(user);
    expect(screen.getByRole('combobox', { name: 'Restart the PC' })).toHaveValue('allow');
    gate.resolve();
    await sleep(120);
    expect(screen.getByRole('combobox', { name: 'Restart the PC' })).toHaveValue('allow');
  });

  test('Rules on a PC: a read that comes after a switch does not show under the other team\'s PC', async () => {
    const { fake } = twoTeams();
    const gate = deferred();
    const real = fake.core.request.getMockImplementation();
    fake.core.request.mockImplementation(async (account, method, path, body) => {
      if (account === 'acc1' && method === 'GET' && path === '/api/rules') await gate.promise;
      return real(account, method, path, body);
    });
    const user = await start(fake);
    await user.click(await screen.findByRole('button', { name: /Front counter/ }));
    await screen.findByRole('region', { name: 'Rules on this PC' });
    gotoTeam(fake, 'acc2');
    await user.click(await screen.findByRole('button', { name: /Acme PC/ }));
    const section = await screen.findByRole('region', { name: 'Rules on this PC' });
    await waitFor(() => expect(within(section).getByText('Restart the PC').nextSibling).toHaveTextContent('Allowed'));
    gate.resolve();
    await sleep(120);
    expect(within(screen.getByRole('region', { name: 'Rules on this PC' })).getByText('Restart the PC').nextSibling).toHaveTextContent('Allowed');
    expect(requestsAs(fake, 'GET', /^\/api\/rules$/).sort()).toEqual(['acc1', 'acc2']);
  });
});

describe('approvals and the team changing under them', () => {
  const waiting = (over = {}) => ({ id: AID(), summary: 'Restart the PC in 30 seconds', actor: 'lead@example.com', via: null, action: 'restart', created_at: Date.now() - 1000, expires_at: Date.now() + 240000, device_id: ID('a'), device_name: 'Front counter', ...over });
  const notice = (over = {}) => ({ id: 1, event: 'approval_requested', at: Date.now(), title: 'Approval needed', body: 'lead@example.com asks to: Restart the PC in 30 seconds on Front counter. Approve or deny it in the app.', device_id: ID('a'), task_id: null, session_id: SID, ...over });

  test('an answer that comes after a switch was made as its own team, is not announced under the other, and no dialog is left', async () => {
    const { fake } = twoTeams();
    fake.state.approvals[SID] = waiting();
    const gate = deferred();
    fake.state.answerGate = gate.promise;
    const user = await start(fake);
    act(() => fake.emit('feed://items', { account: 'acc1', live: true, items: [notice()] }));
    const dialog = await screen.findByRole('dialog', { name: 'An action needs your approval' });
    await within(dialog).findByText('Restart the PC in 30 seconds');
    await user.click(within(dialog).getByRole('button', { name: 'Deny' }));
    await waitFor(() => expect(requestsAs(fake, 'POST', /\/approvals\//)).toEqual(['acc1']));
    gotoTeam(fake, 'acc2');
    await screen.findByRole('button', { name: /Acme PC/ });
    gate.resolve();
    await sleep(120);
    expect(screen.queryByText('Denied.')).not.toBeInTheDocument();
    expect(screen.queryByText('Denied. The action will not run.')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(requestsAs(fake, 'POST', /\/approvals\//)).toEqual(['acc1']);
    expect(fake.state.answers).toEqual([{ account: 'acc1', sid: SID, id: AID(), approve: false }]);
    // Back in its own team there is nothing left to review.
    gotoTeam(fake, 'acc1');
    await screen.findByRole('button', { name: /Front counter/ });
    await sleep(60);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('a request read for the old team that arrives after a switch opens nothing under the new one', async () => {
    const { fake } = twoTeams();
    fake.state.approvals[SID] = waiting();
    const gate = deferred();
    fake.state.approvalsGate = gate.promise;
    await start(fake);
    act(() => fake.emit('feed://items', { account: 'acc1', live: true, items: [notice()] }));
    await screen.findByRole('dialog', { name: 'An action needs your approval' });
    await waitFor(() => expect(requestsAs(fake, 'GET', /\/approvals$/)).toEqual(['acc1']));
    gotoTeam(fake, 'acc2');
    await screen.findByRole('button', { name: /Acme PC/ });
    gate.resolve();
    await sleep(120);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(requestsAs(fake, 'GET', /\/approvals$/)).toEqual(['acc1']);
  });

  test('a notice for the other team waits until that team is shown, then asks as that team', async () => {
    const { fake } = twoTeams();
    fake.state.approvals[SID] = waiting();
    await start(fake);
    gotoTeam(fake, 'acc2');
    await screen.findByRole('button', { name: /Acme PC/ });
    act(() => fake.emit('feed://items', { account: 'acc1', live: true, items: [notice()] }));
    await sleep(80);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(requestsAs(fake, 'GET', /\/approvals$/)).toEqual([]);
    gotoTeam(fake, 'acc1');
    const dialog = await screen.findByRole('dialog', { name: 'An action needs your approval' });
    expect(await within(dialog).findByText('Restart the PC in 30 seconds')).toBeInTheDocument();
    expect(requestsAs(fake, 'GET', /\/approvals$/)).toEqual(['acc1']);
  });
});
