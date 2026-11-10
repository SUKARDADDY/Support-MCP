// Answers that come back after the account, tab, attempt or session they were asked for has
// changed are dropped or undone, never applied to what is on screen now.
import { act, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test } from 'vitest';
import { AppContext } from './context.jsx';
import { AddDevice } from './screens/AddDevice.jsx';
import { Notifications } from './screens/Notifications.jsx';
import { useSession } from './session.js';
import { ACCOUNT, FAST, ID, device, fakeCore, renderApp } from './test-utils.jsx';

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

const liveTask = (over = {}) => ({ id: TASK, state: 'running', title: 'Fix', session_id: SID, device_id: ID('a'), created_at: Date.now(), ended_at: null, phase: 'working', rev: 1, steps: [], notes: [], ...over });
const saveTab = (over = {}) => localStorage.setItem('support.tabs', JSON.stringify([{ key: SID, account: 'acc1', deviceId: ID('a'), deviceName: 'Front counter', sessionId: SID, taskId: null, ...over }]));
const tabsBar = () => screen.getAllByRole('tab');

describe('which tab is shown when a tab opens', () => {
  test('a click on another team\'s notification for a task opens its tab and shows it', async () => {
    const fake = fakeCore({ accounts: [ACCOUNT, SECOND] });
    fake.state.tasks = [liveTask()];
    fake.state.sessions[SID] = { state: 'attached', driver: 'tech@example.com', machine: 'FRONT', log: [] };
    renderApp(fake);
    await screen.findByRole('button', { name: /Front counter/ });
    await waitFor(() => expect(fake.core.on).toHaveBeenCalledWith('ui://open', expect.any(Function)));
    act(() => fake.emit('ui://open', { account: 'acc2', task_id: TASK, session_id: null, device_id: ID('a') }));
    expect(await screen.findByRole('tab', { name: /Front counter/, selected: true })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('support.tabs'))[0]).toMatchObject({ account: 'acc2', sessionId: SID });
  });

  test('a connection that finishes after a switch leaves the view on the new team\'s devices, and their list keeps being read', async () => {
    const user = userEvent.setup();
    const fake = fakeCore({ accounts: [ACCOUNT, SECOND] });
    const gate = deferred();
    fake.state.connect = () => gate.promise;
    fake.state.sessions['old-team-session'] = { state: 'attached', driver: 'tech@example.com', machine: 'FRONT', log: [] };
    renderApp(fake, { ...FAST, devicePollMs: 40 });
    await user.click(await screen.findByRole('button', { name: /Front counter/ }));
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    await switchTeam(user);
    gate.resolve({ session_id: 'old-team-session', state: 'attached', asks: false });
    await sleep(100);
    expect(screen.getByRole('tab', { name: 'Devices', selected: true })).toBeInTheDocument();
    const reads = () => toolCalls(fake, 'device_list').filter((c) => c[0] === 'acc2').length;
    const before = reads();
    await sleep(200);
    expect(reads()).toBeGreaterThan(before + 1);
  });
});

describe('two tabs for one session', () => {
  test('a stale session retried by PC with a slow answer: the tab that joined the start is the one shown, and no second tab is opened', async () => {
    const user = userEvent.setup();
    const fake = fakeCore();
    const slow = deferred();
    let s1Over = false;
    fake.state.sessions[SID2] = { state: 'attached', driver: 'tech@example.com', machine: 'FRONT', log: [] };
    fake.state.sessionStatus = (args) => (args.session_id === SID && s1Over ? { state: 'ended', ended_reason: 'owner', log: [] } : { state: 'attached', driver: 'tech@example.com', log: [], ...(fake.state.sessions[args.session_id] ?? {}) });
    fake.state.taskStatus = (t) => ({ ...t, session_id: SID2 });
    const request = fake.core.request.getMockImplementation();
    fake.core.request.mockImplementation(async (account, method, path, body) => {
      if (method === 'POST' && path === '/api/agent/tasks') {
        if (body.session_id) { s1Over = true; throw Object.assign(new Error('that session is not live'), { code: 'session_ended', status: 409 }); }
        await slow.promise; // the by-PC start is slow, long enough for the tab to hear its session ended
      }
      return request(account, method, path, body);
    });
    saveTab();
    renderApp(fake);
    await user.click(await screen.findByRole('tab', { name: /Front counter/ }));
    await user.click(screen.getByRole('tab', { name: 'Devices' }));
    await user.click(await screen.findByRole('button', { name: /^Front counter/ }));
    await user.click(within(screen.getByRole('region', { name: 'Device details' })).getByRole('button', { name: 'Hand to the agent' }));
    const dialog = screen.getByRole('dialog', { hidden: true });
    await user.click(within(dialog).getByLabelText('What should the agent do?'));
    await user.paste('Fix the printer');
    await user.click(within(dialog).getByRole('button', { name: 'Start the task' }));
    await waitFor(() => expect(s1Over).toBe(true));
    await sleep(150); // the tab's own status poll marks S1 ended
    expect(!!screen.queryByText('The session ended.')).toBe(true);
    slow.resolve();
    await waitFor(() => expect(fake.state.started).toBeDefined());
    await waitFor(() => expect(screen.getByRole('tab', { name: /Front counter/, selected: true })).toBeInTheDocument());
    await sleep(100);
    expect(tabsBar()).toHaveLength(2);
    expect(JSON.parse(localStorage.getItem('support.tabs'))).toHaveLength(1);
  });
});

describe('cancelling a connection', () => {
  async function startAndCancel(user, fake) {
    await user.click(await screen.findByRole('button', { name: /Front counter/ }));
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
  }

  test('a new attempt waits until the session end of the cancelled one is done', async () => {
    const user = userEvent.setup();
    const fake = fakeCore();
    const end = deferred();
    const endedWhenAsked = [];
    fake.state.endGate = end.promise;
    fake.state.connect = () => { endedWhenAsked.push([...(fake.state.ended ?? [])]); return { session_id: 'known-session', state: 'waiting', asks: true, rang: true }; };
    fake.state.sessionStatus = () => ({ state: 'waiting', driver: null, log: [] });
    renderApp(fake);
    await user.click(await screen.findByRole('button', { name: /Front counter/ }));
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel request' }));
    await waitFor(() => expect(toolCalls(fake, 'session_end')).toHaveLength(1));
    await user.click(await screen.findByRole('button', { name: 'Connect' }));
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    await sleep(100);
    expect(toolCalls(fake, 'device_connect')).toHaveLength(1); // still waiting for the session end
    end.resolve();
    await waitFor(() => expect(toolCalls(fake, 'device_connect')).toHaveLength(2));
    expect(endedWhenAsked).toEqual([[], ['known-session']]);
    await sleep(100);
    expect(toolCalls(fake, 'device_connect')).toHaveLength(2); // two clicks, one attempt
  });

  test('a session end that fails is tried once more, then the person is told which PC may still ask its user', async () => {
    const user = userEvent.setup();
    const fake = fakeCore();
    const gate = deferred();
    fake.state.connect = () => gate.promise;
    fake.state.endError = Object.assign(new Error('the relay is busy'), { code: 'unavailable' });
    fake.state.sessionStatus = () => ({ state: 'waiting', driver: null, log: [] });
    renderApp(fake);
    await startAndCancel(user, fake);
    gate.resolve({ session_id: 'made-after-cancel', state: 'waiting', asks: true });
    expect(await screen.findByText('Could not cancel the request to Front counter. The person at the PC may still be asked to click Allow.')).toBeInTheDocument();
    expect(toolCalls(fake, 'session_end')).toHaveLength(2);
  });

  test('a session end that fails for a session that has ended already is not reported', async () => {
    const user = userEvent.setup();
    const fake = fakeCore();
    const gate = deferred();
    fake.state.connect = () => gate.promise;
    fake.state.endError = Object.assign(new Error('no such session'), { code: 'not_found' });
    fake.state.sessionStatus = () => ({ state: 'ended', ended_reason: 'owner', log: [] });
    renderApp(fake);
    await startAndCancel(user, fake);
    gate.resolve({ session_id: 'made-after-cancel', state: 'waiting', asks: true });
    await waitFor(() => expect(toolCalls(fake, 'session_end')).toHaveLength(2));
    await sleep(100);
    expect(screen.queryByText(/Could not cancel the request/)).not.toBeInTheDocument();
  });
});

describe('a task start from a tab, with another team shown', () => {
  test('goes through the tab\'s own team even if the team on screen changed while the dialog was open', async () => {
    const user = userEvent.setup();
    const fake = fakeCore({ accounts: [ACCOUNT, SECOND] });
    fake.state.sessions[SID] = { state: 'attached', driver: 'tech@example.com', machine: 'FRONT', log: [] };
    saveTab();
    renderApp(fake);
    await user.click(await screen.findByRole('tab', { name: /Front counter/ }));
    await user.click(await screen.findByRole('button', { name: 'Hand to the agent' }));
    const dialog = screen.getByRole('dialog', { hidden: true });
    await user.click(within(dialog).getByLabelText('What should the agent do?'));
    await user.paste('Fix the printer');
    await waitFor(() => expect(fake.core.on).toHaveBeenCalledWith('ui://open', expect.any(Function)));
    act(() => fake.emit('ui://open', { account: 'acc2', device_id: null, task_id: null, session_id: null }));
    await waitFor(() => expect(fake.core.request.mock.calls.some((c) => c[0] === 'acc2')).toBe(true));
    await user.click(within(dialog).getByRole('button', { name: 'Start the task', hidden: true }));
    await waitFor(() => expect(fake.state.started).toEqual({ instructions: 'Fix the printer', keep_working: false, session_id: SID }));
    const starts = fake.core.request.mock.calls.filter((c) => c[1] === 'POST' && c[2] === '/api/agent/tasks');
    expect(starts.map((c) => c[0])).toEqual(['acc1']);
  });
});

describe('a tab that has moved on', () => {
  const props = (fake, over = {}) => ({ core: fake.core, account: 'acc1', tab: { key: SID, sessionId: SID, taskId: null }, active: true, me: { identity: 'tech@example.com' }, canControl: true, tuning: FAST, visible: true, onSessionKnown: () => {}, ...over });

  test('a session status that comes back after the tab adopted another session is dropped', async () => {
    const fake = fakeCore();
    const old = deferred();
    fake.state.tasks = [liveTask()];
    fake.state.taskStatus = (t) => ({ ...t, session_id: SID2 });
    fake.state.sessionStatus = (args) => (args.session_id === SID ? old.promise : { state: 'attached', driver: 'tech@example.com', log: [] });
    const seen = [];
    const { result } = renderHook(() => { const r = useSession(props(fake, { tab: { key: SID, sessionId: SID, taskId: TASK } })); seen.push(r.status?.state ?? null); return r; });
    await waitFor(() => expect(result.current.sessionId).toBe(SID2));
    await act(async () => { old.resolve({ state: 'ended', ended_reason: 'owner', log: [] }); });
    await sleep(150);
    expect(result.current.ended).toBe(false);
    expect(result.current.status?.state).toBe('attached');
    expect(seen).not.toContain('ended'); // the old session's answer was never applied, not even for a moment
  });

  test('a task that is over does not move the tab to its session', async () => {
    const fake = fakeCore();
    fake.state.tasks = [liveTask({ state: 'done', ended_at: Date.now() })];
    fake.state.taskStatus = (t) => ({ ...t, session_id: SID2 });
    const { result } = renderHook(() => useSession(props(fake, { tab: { key: SID, sessionId: SID, taskId: TASK } })));
    await waitFor(() => expect(result.current.task?.state).toBe('done'));
    await sleep(60);
    expect(result.current.sessionId).toBe(SID);
  });
});

describe('Add a device, and the team changes under it', () => {
  test('a code made for the old team is not shown for the new one', async () => {
    const user = userEvent.setup();
    const fake = fakeCore();
    const gate = deferred();
    fake.state.pairingGate = gate.promise;
    const ctx = (id) => ({ core: fake.core, account: { id }, can: () => true, toast() {}, reloadDevices() {}, select() {}, go() {}, copyText() {}, tuning: FAST });
    const view = render(<AppContext.Provider value={ctx('acc1')}><AddDevice /></AppContext.Provider>);
    await user.click(screen.getByRole('button', { name: 'Get a pairing code' }));
    await waitFor(() => expect(fake.core.request.mock.calls.some((c) => c[1] === 'POST' && c[2] === '/api/pairing')).toBe(true));
    view.rerender(<AppContext.Provider value={ctx('acc2')}><AddDevice /></AppContext.Provider>);
    await act(async () => { gate.resolve(); });
    await sleep(80);
    expect(screen.queryByTestId('pairing-code')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Get a pairing code' })).toBeEnabled();
  });
});

describe('a link, and the team changes under it', () => {
  test('the link of the old team is cleared when the team on screen changes', async () => {
    const user = userEvent.setup();
    const fake = fakeCore({ accounts: [ACCOUNT, SECOND] });
    renderApp(fake);
    await screen.findByRole('button', { name: /Front counter/ });
    await user.click(nav('One-off link'));
    const dialog = screen.getByRole('dialog', { hidden: true });
    await user.click(within(dialog).getByRole('button', { name: 'Create link', hidden: true }));
    expect(await within(dialog).findByLabelText('One-off link')).toBeInTheDocument();
    act(() => fake.emit('ui://open', { account: 'acc2', device_id: ID('a'), task_id: null, session_id: null }));
    await waitFor(() => expect(within(dialog).queryByLabelText('One-off link')).not.toBeInTheDocument());
  });
});

describe('tabs and notifications', () => {
  test('a notification for a task finds the tab that follows it, though the task moved to another session', async () => {
    const fake = fakeCore();
    fake.state.sessions[SID2] = { state: 'attached', driver: 'tech@example.com', machine: 'FRONT', log: [] };
    fake.state.tasks = [liveTask({ session_id: SID2 })];
    fake.state.taskStatus = (t) => ({ ...t, session_id: SID2 });
    saveTab({ key: `task:${TASK}`, sessionId: SID2, taskId: TASK });
    renderApp(fake);
    await screen.findByRole('tab', { name: /Front counter/ });
    await waitFor(() => expect(fake.core.on).toHaveBeenCalledWith('ui://open', expect.any(Function)));
    act(() => fake.emit('ui://open', { account: 'acc1', task_id: TASK, session_id: null, device_id: ID('a') }));
    await waitFor(() => expect(screen.getByRole('tab', { name: /Front counter/, selected: true })).toBeInTheDocument());
    await sleep(80);
    expect(tabsBar()).toHaveLength(2);
  });

  test('the Open session button on a PC\'s detail goes away when that tab\'s session ends', async () => {
    const user = userEvent.setup();
    const fake = fakeCore();
    let over = false;
    fake.state.sessionStatus = () => (over ? { state: 'ended', ended_reason: 'owner', log: [] } : { state: 'attached', driver: 'tech@example.com', log: [] });
    saveTab();
    renderApp(fake);
    await screen.findByRole('tab', { name: /Front counter/ });
    await user.click(await screen.findByRole('button', { name: /^Front counter/ }));
    expect(await screen.findByRole('button', { name: 'Open session' })).toBeInTheDocument();
    over = true;
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Open session' })).not.toBeInTheDocument());
  });
});

describe('a tab whose session has ended', () => {
  test('the header no longer says who is driving, and the picture caption says it ended once', async () => {
    const fake = fakeCore();
    let over = false;
    fake.state.sessionStatus = () => (over ? { state: 'ended', ended_reason: 'owner', driver: 'tech@example.com', machine: 'IEWIN7', log: [] } : { state: 'attached', driver: 'tech@example.com', machine: 'IEWIN7', log: [] });
    // The PC went away: pictures fail with the relay's words until the session is seen to have ended.
    fake.state.screenshot = () => { throw Object.assign(new Error('session ended'), { code: 'tool' }); };
    saveTab();
    renderApp(fake);
    await userEvent.setup().click(await screen.findByRole('tab', { name: /Front counter/ }));
    expect(await screen.findByText('You are driving')).toBeInTheDocument();
    // The picture failed with "session ended" while the status still says attached: the loop stops, in the app's words, not the tool's.
    expect(await screen.findByText(/Taking pictures failed several times in a row/)).toBeInTheDocument();
    expect(screen.queryByText('session ended')).not.toBeInTheDocument();
    over = true;
    expect(await screen.findByText('The session ended.')).toBeInTheDocument();
    expect(screen.queryByText('You are driving')).not.toBeInTheDocument();
    expect(screen.queryByText('session ended')).not.toBeInTheDocument();
    expect(screen.getByText('Ended')).toBeInTheDocument();
    expect(screen.getByText('IEWIN7')).toBeInTheDocument();
  });
});

describe('calls a screen made under the old team', () => {
  const acmeList = () => ({ devices: [device({ id: ID('q'), name: 'Acme PC' })], next: null });
  const readsOf = (fake, acc) => toolCalls(fake, 'device_list').filter((c) => c[0] === acc).length;

  test('approving a PC and switching teams before it finishes does not put the old team\'s PCs in the new team\'s list', async () => {
    const user = userEvent.setup();
    const gate = deferred();
    const pending = device({ id: ID('w'), name: 'OLD TEAM SECRET PC', status: 'pending', online: true, expires_at: Date.now() + 600000 });
    const fake = fakeCore({ accounts: [ACCOUNT, SECOND], devices: [pending] });
    fake.state.approveGate = gate.promise;
    fake.state.deviceList = async (account) => (account === 'acc2' ? acmeList() : { devices: structuredClone(fake.state.devices), next: null });
    renderApp(fake);
    await user.click(await screen.findByRole('button', { name: /OLD TEAM SECRET PC/ }));
    const detail = screen.getByRole('region', { name: 'Device details' });
    await user.type(within(detail).getByLabelText('Six-digit number shown on the PC'), '123456');
    await user.click(within(detail).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(fake.core.request.mock.calls.some((c) => c[1] === 'PATCH')).toBe(true));
    await switchTeam(user);
    expect(await screen.findByRole('button', { name: /Acme PC/ })).toBeInTheDocument();
    const before = readsOf(fake, 'acc1');
    await act(async () => { gate.resolve(); });
    await sleep(120);
    expect(screen.queryByRole('button', { name: /OLD TEAM SECRET PC/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Acme PC/ })).toBeInTheDocument();
    expect(readsOf(fake, 'acc1')).toBe(before); // the old team's list is not even asked for
  });

  test('a task that is looked up for a notification after the team was switched again does not take the view', async () => {
    const user = userEvent.setup();
    const gate = deferred();
    const fake = fakeCore({ accounts: [ACCOUNT, SECOND] });
    fake.state.tasks = [liveTask()];
    fake.state.sessions[SID] = { state: 'attached', driver: 'tech@example.com', machine: 'FRONT', log: [] };
    fake.state.tasksGate = gate.promise;
    renderApp(fake, { ...FAST, devicePollMs: 40 });
    await screen.findByRole('button', { name: /Front counter/ });
    await waitFor(() => expect(fake.core.on).toHaveBeenCalledWith('ui://open', expect.any(Function)));
    act(() => fake.emit('ui://open', { account: 'acc2', task_id: TASK, session_id: null, device_id: ID('a') }));
    await waitFor(() => expect(fake.core.request.mock.calls.some((c) => c[0] === 'acc2' && c[2] === '/api/agent/tasks')).toBe(true));
    await switchTeam(user); // back to the first team while the lookup is still on its way
    await act(async () => { gate.resolve(); });
    await sleep(100);
    expect(screen.getByRole('tab', { name: 'Devices', selected: true })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /Front counter/ })).not.toBeInTheDocument();
    const before = readsOf(fake, 'acc1');
    await sleep(200);
    expect(readsOf(fake, 'acc1')).toBeGreaterThan(before + 1); // the view is the device list, so it keeps being read
    expect(JSON.parse(localStorage.getItem('support.tabs')).map((t) => t.account)).toEqual(['acc2']);
  });

  test('a task started from a PC\'s detail that finishes after a switch of team opens its tab under its own team and leaves the view alone', async () => {
    const user = userEvent.setup();
    const gate = deferred();
    const fake = fakeCore({ accounts: [ACCOUNT, SECOND] });
    const request = fake.core.request.getMockImplementation();
    fake.core.request.mockImplementation(async (account, method, path, body) => {
      if (method === 'POST' && path === '/api/agent/tasks') await gate.promise;
      return request(account, method, path, body);
    });
    renderApp(fake, { ...FAST, devicePollMs: 40 });
    await user.click(await screen.findByRole('button', { name: /^Front counter/ }));
    await user.click(within(screen.getByRole('region', { name: 'Device details' })).getByRole('button', { name: 'Hand to the agent' }));
    const dialog = screen.getByRole('dialog', { hidden: true });
    await user.click(within(dialog).getByLabelText('What should the agent do?'));
    await user.paste('Fix the printer');
    await user.click(within(dialog).getByRole('button', { name: 'Start the task' }));
    await waitFor(() => expect(fake.core.request.mock.calls.some((c) => c[1] === 'POST' && c[2] === '/api/agent/tasks')).toBe(true));
    await switchTeam(user);
    await act(async () => { gate.resolve(); });
    await sleep(100);
    expect(screen.getByRole('tab', { name: 'Devices', selected: true })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /Front counter/ })).not.toBeInTheDocument();
    const before = readsOf(fake, 'acc2');
    await sleep(200);
    expect(readsOf(fake, 'acc2')).toBeGreaterThan(before + 1);
    expect(JSON.parse(localStorage.getItem('support.tabs')).map((t) => [t.account, t.key])).toEqual([['acc1', `task:${TASK}`]]);
  });
});

describe('tabs from the last run, while the app asks which are still open', () => {
  test('a tab opened meanwhile is kept', async () => {
    const user = userEvent.setup();
    const gate = deferred();
    const fake = fakeCore();
    fake.state.sessions[SID2] = { state: 'attached', driver: 'tech@example.com', machine: 'BACK', log: [] };
    fake.state.connect = () => ({ session_id: SID2, state: 'attached', asks: false });
    fake.state.sessionStatus = (args) => (args.session_id === SID ? gate.promise : { state: 'attached', driver: 'tech@example.com', log: [] });
    saveTab();
    renderApp(fake);
    await user.click(await screen.findByRole('button', { name: /Back office/ }));
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(JSON.parse(localStorage.getItem('support.tabs')).map((t) => t.key)).toContain(SID2));
    await act(async () => { gate.resolve({ state: 'attached', driver: 'tech@example.com', log: [] }); });
    await sleep(100);
    expect(JSON.parse(localStorage.getItem('support.tabs')).map((t) => t.key).sort()).toEqual([SID, SID2].sort());
  });
});

describe('notification settings, and the team changes under them', () => {
  test('the old team\'s switches are not shown while the new team\'s are read', async () => {
    const gate = deferred();
    const fake = fakeCore();
    fake.state.notifySettingsFor = async (account) => {
      if (account === 'acc2') await gate.promise;
      return { events: { task_finished: account === 'acc1', task_problem: true, session_declined: true, device_online: true, device_missing: true, device_waiting: true }, watch: [] };
    };
    const ctx = (id) => ({ core: fake.core, account: { id }, accounts: [{ id: 'acc1' }, { id: 'acc2' }], notifications: [], openTarget() {}, now: Date.now(), titleOf: () => null, devices: [], toast() {} });
    const view = render(<AppContext.Provider value={ctx('acc1')}><Notifications /></AppContext.Provider>);
    await userEvent.setup().click(screen.getByRole('tab', { name: 'Settings' }));
    expect(await screen.findByRole('checkbox', { name: /Task finished/i })).toBeChecked();
    view.rerender(<AppContext.Provider value={ctx('acc2')}><Notifications /></AppContext.Provider>);
    await sleep(40);
    expect(screen.queryByRole('checkbox', { name: /Task finished/i })).not.toBeInTheDocument(); // not the old team's switch
    await act(async () => { gate.resolve(); });
    expect(await screen.findByRole('checkbox', { name: /Task finished/i })).not.toBeChecked();
  });
});
