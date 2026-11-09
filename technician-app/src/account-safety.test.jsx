// Answers that come back after the account, tab, attempt or session they were asked for has
// changed are dropped or undone, never applied to what is on screen now.
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test } from 'vitest';
import { ACCOUNT, ID, device, fakeCore, renderApp } from './test-utils.jsx';

const SECOND = { ...ACCOUNT, id: 'acc2', team: 'acme', team_name: 'Acme Support' };
const nav = (name) => within(screen.getByRole('navigation', { name: 'Main' })).getByRole('button', { name: new RegExp(name) });
const sleep = (ms) => act(() => new Promise((r) => setTimeout(r, ms)));
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
const toolCalls = (fake, name) => fake.core.tool.mock.calls.filter((c) => c[1] === name);
const SID = 's'.repeat(64);
const SID2 = 'u'.repeat(64);
const TASK = ID('t');

async function switchTeam(user) {
  await user.click(nav('Settings'));
  const accounts = await screen.findByRole('region', { name: 'Accounts' });
  await user.click(await within(accounts).findByRole('button', { name: 'Use this team' }));
  await screen.findByRole('heading', { name: /Devices/ });
}

describe('a connection that is cancelled', () => {
  test('Cancel before the relay answers: the session it makes afterwards is ended, with the account that asked', async () => {
    const user = userEvent.setup();
    const fake = fakeCore();
    const gate = deferred();
    fake.state.connect = () => gate.promise;
    renderApp(fake);
    await user.click(await screen.findByRole('button', { name: /Front counter/ }));
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(toolCalls(fake, 'session_end')).toHaveLength(0); // nothing to end yet
    gate.resolve({ session_id: 'made-after-cancel', state: 'attached', asks: false });
    await waitFor(() => expect(toolCalls(fake, 'session_end')).toHaveLength(1));
    expect(toolCalls(fake, 'session_end')[0].slice(0, 3)).toEqual(['acc1', 'session_end', { session_id: 'made-after-cancel' }]);
    // No tab was opened for it.
    await sleep(60);
    expect(screen.queryByRole('tab', { name: /Front counter/ })).not.toBeInTheDocument();
  });

  test('Cancel after the session id is known ends it once, and a new attempt waits for the cleanup', async () => {
    const user = userEvent.setup();
    const fake = fakeCore();
    fake.state.connect = () => ({ session_id: 'known-session', state: 'waiting', asks: true, rang: true });
    fake.state.sessionStatus = () => ({ state: 'waiting', driver: null, log: [] });
    renderApp(fake);
    await user.click(await screen.findByRole('button', { name: /Front counter/ }));
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel request' }));
    await waitFor(() => expect(toolCalls(fake, 'session_end')).toHaveLength(1));
    await sleep(60);
    expect(toolCalls(fake, 'session_end')).toHaveLength(1);
  });
});

describe('a connection that finishes after the team was switched', () => {
  test('its tab is not shown or driven under the other team, and belongs to its own team when that is used again', async () => {
    const user = userEvent.setup();
    const fake = fakeCore({ accounts: [ACCOUNT, SECOND] });
    const gate = deferred();
    fake.state.connect = () => gate.promise;
    fake.state.sessions['old-team-session'] = { state: 'attached', driver: 'tech@example.com', machine: 'FRONT', log: [] };
    renderApp(fake);
    await user.click(await screen.findByRole('button', { name: /Front counter/ }));
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    await switchTeam(user);
    gate.resolve({ session_id: 'old-team-session', state: 'attached', asks: false });
    await sleep(120);
    // Under the other team: no tab, no session on screen, nothing sent through its sign-in.
    expect(screen.queryByRole('tab', { name: /Front counter/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Hand to the agent', hidden: false })).not.toBeInTheDocument();
    expect(document.getElementById('panel-old-team-session')).toHaveAttribute('hidden'); // mounted for its own team, never shown
    expect(JSON.parse(localStorage.getItem('support.tabs')).map((t) => [t.account, t.sessionId])).toEqual([['acc1', 'old-team-session']]);
    expect(fake.core.tool.mock.calls.filter((c) => c[0] === 'acc2' && c[2]?.session_id === 'old-team-session')).toHaveLength(0);

    // Back on its own team the tab is there, and handing the session over goes through that team.
    await switchTeam(user);
    await user.click(await screen.findByRole('tab', { name: /Front counter/ }));
    await user.click(await screen.findByRole('button', { name: 'Hand to the agent' }));
    const dialog = screen.getByRole('dialog', { hidden: true });
    await user.click(within(dialog).getByLabelText('What should the agent do?'));
    await user.paste('Fix the printer');
    await user.click(within(dialog).getByRole('button', { name: 'Start the task' }));
    await waitFor(() => expect(fake.state.started).toEqual({ instructions: 'Fix the printer', keep_working: false, session_id: 'old-team-session' }));
    const starts = fake.core.request.mock.calls.filter((c) => c[1] === 'POST' && c[2] === '/api/agent/tasks');
    expect(starts.map((c) => c[0])).toEqual(['acc1']);
  });
});

describe('the device list after a change of team', () => {
  const setup = () => {
    const fake = fakeCore({ accounts: [ACCOUNT, SECOND] });
    const slow = deferred();
    let first = true;
    fake.state.deviceList = async (account) => {
      if (account === 'acc1' && first) { first = false; return slow.promise; }
      return { devices: account === 'acc2' ? [device({ id: ID('q'), name: 'Acme PC' })] : [device({ id: ID('r'), name: 'Default PC' })], next: null };
    };
    return { fake, slow };
  };

  test('a list that was still on its way for the old team does not replace the new team\'s, even when the window was hidden at the switch', async () => {
    const { fake, slow } = setup();
    renderApp(fake);
    await waitFor(() => expect(fake.core.tool.mock.calls.some((c) => c[1] === 'device_list')).toBe(true));
    // The window goes to the tray, and a click on a notification of the other team switches to it.
    act(() => fake.emit('ui://visibility', { visible: false }));
    await waitFor(() => expect(fake.core.on).toHaveBeenCalledWith('ui://open', expect.any(Function)));
    act(() => fake.emit('ui://open', { account: 'acc2', device_id: null, task_id: null, session_id: null }));
    await waitFor(() => expect(fake.core.request.mock.calls.some((c) => c[0] === 'acc2')).toBe(true));
    slow.resolve({ devices: [device({ id: ID('z'), name: 'Old team PC' })], next: null });
    await sleep(80);
    // Nothing of the old team is shown for the new one, whether or not the window is visible.
    expect(screen.queryByRole('button', { name: /Old team PC/ })).not.toBeInTheDocument();
    act(() => fake.emit('ui://visibility', { visible: true }));
    expect(await screen.findByRole('button', { name: /Acme PC/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Old team PC/ })).not.toBeInTheDocument();
  });

  test('switching with the window shown reads the new team\'s list at once', async () => {
    const user = userEvent.setup();
    const { fake, slow } = setup();
    renderApp(fake);
    await waitFor(() => expect(fake.core.tool.mock.calls.some((c) => c[1] === 'device_list')).toBe(true));
    await user.click(nav('Settings'));
    const accounts = await screen.findByRole('region', { name: 'Accounts' });
    await user.click(await within(accounts).findByRole('button', { name: 'Use this team' }));
    expect(await screen.findByRole('button', { name: /Acme PC/ })).toBeInTheDocument();
    slow.resolve({ devices: [device({ id: ID('z'), name: 'Old team PC' })], next: null });
    await sleep(80);
    expect(screen.queryByRole('button', { name: /Old team PC/ })).not.toBeInTheDocument();
  });
});

describe('a link made for the team that was shown a moment ago', () => {
  test('is not shown for the team that is shown now', async () => {
    const user = userEvent.setup();
    const fake = fakeCore({ accounts: [ACCOUNT, SECOND] });
    const gate = deferred();
    fake.state.oneOffGate = gate.promise;
    renderApp(fake);
    await screen.findByRole('button', { name: /Front counter/ });
    await user.click(nav('One-off link'));
    const dialog = screen.getByRole('dialog', { hidden: true });
    await user.click(within(dialog).getByRole('button', { name: 'Create link', hidden: true }));
    await waitFor(() => expect(toolCalls(fake, 'session_create')).toHaveLength(1));
    act(() => fake.emit('ui://open', { account: 'acc2', device_id: ID('a'), task_id: null, session_id: null }));
    await waitFor(() => expect(fake.core.request.mock.calls.some((c) => c[0] === 'acc2')).toBe(true));
    gate.resolve();
    await sleep(80);
    expect(within(dialog).queryByLabelText('One-off link')).not.toBeInTheDocument();
  });
});

describe('a PC whose session ended', () => {
  const taskOn = (session) => ({ id: TASK, state: 'running', title: 'Fix', session_id: session, device_id: ID('a'), created_at: Date.now(), ended_at: null, phase: 'working', rev: 1, steps: [], notes: [] });

  async function openLiveTab(fake) {
    localStorage.setItem('support.tabs', JSON.stringify([{ key: SID, account: 'acc1', deviceId: ID('a'), deviceName: 'Front counter', sessionId: SID, taskId: null }]));
    const view = renderApp(fake);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: /Front counter/ }));
    return { ...view, user };
  }
  async function handOverFromDetail(user, text) {
    await user.click(screen.getByRole('tab', { name: 'Devices' }));
    await user.click(await screen.findByRole('button', { name: /^Front counter/ }));
    const detail = screen.getByRole('region', { name: 'Device details' });
    await user.click(within(detail).getByRole('button', { name: 'Hand to the agent' }));
    const dialog = screen.getByRole('dialog', { hidden: true });
    await user.click(within(dialog).getByLabelText('What should the agent do?'));
    await user.paste(text);
    await user.click(within(dialog).getByRole('button', { name: 'Start the task' }));
  }

  test('a task started on the PC from its detail gets its own tab, and the ended tab stays as it was', async () => {
    const fake = fakeCore();
    let ended = false;
    fake.state.sessionStatus = (args) => (args.session_id === SID && ended ? { state: 'ended', ended_reason: 'owner', log: [] } : { state: 'attached', driver: 'tech@example.com', log: [] });
    const { user } = await openLiveTab(fake);
    ended = true;
    expect(await screen.findByText('The session ended.')).toBeInTheDocument();
    await handOverFromDetail(user, 'Fix the printer');
    await waitFor(() => expect(fake.state.started).toEqual({ instructions: 'Fix the printer', keep_working: false, device_id: ID('a') }));
    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(3));
    const saved = JSON.parse(localStorage.getItem('support.tabs'));
    expect(saved.find((t) => t.key === SID)).toMatchObject({ sessionId: SID, taskId: null });
    expect(saved.find((t) => t.key === `task:${TASK}`)).toMatchObject({ account: 'acc1', deviceId: ID('a'), taskId: TASK });
  });

  test('a stale session retried by PC: the tab adopts the task\'s new session and saves the task', async () => {
    const fake = fakeCore();
    let s1Over = false;
    fake.state.sessions[SID2] = { state: 'attached', driver: 'tech@example.com', machine: 'FRONT', log: [] };
    fake.state.sessionStatus = (args) => (args.session_id === SID && s1Over ? { state: 'ended', ended_reason: 'owner', log: [] } : { state: 'attached', driver: 'tech@example.com', log: [], ...(fake.state.sessions[args.session_id] ?? {}) });
    fake.state.taskStatus = (t) => ({ ...t, session_id: SID2 });
    const request = fake.core.request.getMockImplementation();
    fake.core.request.mockImplementation(async (account, method, path, body) => {
      if (method === 'POST' && path === '/api/agent/tasks' && body.session_id) {
        s1Over = true; // the session ended a moment ago; the tab has not heard yet
        throw Object.assign(new Error('that session is not live'), { code: 'session_ended', status: 409 });
      }
      return request(account, method, path, body);
    });
    const { user } = await openLiveTab(fake);
    await handOverFromDetail(user, 'Fix the printer');
    await waitFor(() => expect(fake.state.started).toEqual({ instructions: 'Fix the printer', keep_working: false, device_id: ID('a') }));
    // The tab was live when the start began, so it follows the task, and adopts the session the task runs on.
    await waitFor(() => expect(JSON.parse(localStorage.getItem('support.tabs')).find((t) => t.key === SID)).toMatchObject({ sessionId: SID2, taskId: TASK }));
    await sleep(150);
    expect(screen.getAllByRole('tab')).toHaveLength(2);
    await user.click(screen.getByRole('tab', { name: /Front counter/ }));
    expect(screen.queryByText('The session ended.')).not.toBeInTheDocument();
    expect(await screen.findByText('Agent activity')).toBeInTheDocument();
  });
});
