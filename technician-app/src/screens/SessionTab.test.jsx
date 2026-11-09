import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test } from 'vitest';
import { ID, ToolFail, fakeCore, renderApp } from '../test-utils.jsx';

const SID = 's'.repeat(64);
const TASK = ID('t');

// A session tab from the last run, so a test starts with one open.
async function openTab(fake = fakeCore(), { permissions, tuning } = {}) {
  localStorage.setItem('support.tabs', JSON.stringify([{ key: SID, account: 'acc1', deviceId: ID('a'), deviceName: 'Front counter', sessionId: SID, taskId: null }]));
  if (permissions) fake.state.permissions = permissions;
  fake.state.sessions[SID] = { state: 'attached', driver: 'tech@example.com', machine: 'FRONT', log: [], ...(fake.state.sessions[SID] ?? {}) };
  const view = renderApp(fake, tuning);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('tab', { name: /Front counter/ }));
  return { ...view, user, fake };
}

const toolCalls = (fake, name) => fake.calls.filter((c) => c.kind === 'tool' && c.args[0] === name);
const sleep = (ms) => act(() => new Promise((r) => setTimeout(r, ms)));

function setVisibility(state) {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  act(() => { document.dispatchEvent(new Event('visibilitychange')); });
}
afterEach(() => setVisibility('visible'));

describe('Session tab: watching the screen yourself', () => {
  test('shows its name, who drives, and a fresh picture every few seconds', async () => {
    const { fake } = await openTab();
    expect(await screen.findByRole('heading', { name: 'Front counter' })).toBeInTheDocument();
    expect(await screen.findByText('You are driving')).toBeInTheDocument();
    const img = await screen.findByRole('img', { name: 'Screen of Front counter' });
    expect(img.getAttribute('src')).toBe('data:image/jpeg;base64,QUJD');
    await waitFor(() => expect(toolCalls(fake, 'screenshot').length).toBeGreaterThanOrEqual(3));
    expect(toolCalls(fake, 'screenshot')[0].args[1]).toEqual({ session_id: SID });
    expect(screen.getByText(/This tab only watches: you cannot click or type here yet\./)).toBeInTheDocument();
  });

  test('has no click or type controls, and calls no tool that could send input', async () => {
    const { fake } = await openTab();
    await screen.findByRole('img', { name: 'Screen of Front counter' });
    await sleep(80);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    for (const b of screen.getAllByRole('button')) expect(b.textContent).not.toMatch(/click|type|keyboard|mouse|press|run command/i);
    const names = new Set(fake.calls.filter((c) => c.kind === 'tool').map((c) => c.args[0]));
    for (const n of names) expect(['device_list', 'session_status', 'screenshot', 'agent_status', 'session_end', 'device_connect']).toContain(n);
  });

  test('stops taking pictures while the tab is hidden, and starts again when it is shown', async () => {
    const { fake } = await openTab();
    await waitFor(() => expect(toolCalls(fake, 'screenshot').length).toBeGreaterThanOrEqual(2));
    setVisibility('hidden');
    await sleep(60);
    const frozen = toolCalls(fake, 'screenshot').length;
    await sleep(120);
    expect(toolCalls(fake, 'screenshot').length).toBe(frozen);
    setVisibility('visible');
    await waitFor(() => expect(toolCalls(fake, 'screenshot').length).toBeGreaterThan(frozen));
  });

  test('stops taking pictures while the shell has hidden the window to the tray or minimised it', async () => {
    const { fake } = await openTab();
    await waitFor(() => expect(toolCalls(fake, 'screenshot').length).toBeGreaterThanOrEqual(2));
    act(() => fake.emit('ui://visibility', { visible: false }));
    await sleep(60);
    const frozen = toolCalls(fake, 'screenshot').length;
    await sleep(120);
    expect(toolCalls(fake, 'screenshot').length).toBe(frozen);
    act(() => fake.emit('ui://visibility', { visible: true }));
    await waitFor(() => expect(toolCalls(fake, 'screenshot').length).toBeGreaterThan(frozen));
  });

  test('stops at once when someone else is driving, and says so', async () => {
    const fake = fakeCore();
    let n = 0;
    fake.state.screenshot = () => { if (++n >= 2) throw new ToolFail('lead@example.com is driving this session; use device_connect with take_over'); return { data: {}, image: { mime: 'image/png', data: 'QUJD' } }; };
    await openTab(fake);
    expect(await screen.findByText(/is driving this PC now, so this tab stopped taking pictures/)).toBeInTheDocument();
    const calls = toolCalls(fake, 'screenshot').length;
    await sleep(120);
    expect(toolCalls(fake, 'screenshot').length).toBe(calls);
    expect(screen.getByRole('button', { name: 'Try the screen again' })).toBeInTheDocument();
  });

  test('stops at once on "agent busy", and Try again starts the pictures again', async () => {
    const user = userEvent.setup();
    const fake = fakeCore();
    let busy = true;
    fake.state.screenshot = () => { if (busy) throw new ToolFail('agent busy; wait for the current operation'); return { data: {}, image: { mime: 'image/png', data: 'QUJD' } }; };
    await openTab(fake);
    expect(await screen.findByText(/The PC is busy with the agent/)).toBeInTheDocument();
    const calls = toolCalls(fake, 'screenshot').length;
    expect(calls).toBe(1);
    busy = false;
    await user.click(screen.getByRole('button', { name: 'Try the screen again' }));
    expect(await screen.findByRole('img', { name: 'Screen of Front counter' })).toBeInTheDocument();
  });

  test('a passing failure is retried, and three in a row stop the loop', async () => {
    const fake = fakeCore();
    fake.state.screenshot = () => { throw new ToolFail('customer is using the PC; try again in a few seconds'); };
    await openTab(fake);
    expect(await screen.findByText(/Taking pictures failed several times in a row/)).toBeInTheDocument();
    expect(toolCalls(fake, 'screenshot').length).toBe(3);
  });

  test('a role without sessions.control takes no pictures', async () => {
    const { fake } = await openTab(fakeCore(), { permissions: ['devices.view', 'sessions.view'] });
    expect(await screen.findByText('Your role cannot watch screens.')).toBeInTheDocument();
    await sleep(80);
    expect(toolCalls(fake, 'screenshot').length).toBe(0);
  });
});

describe('Session tab: someone else drives', () => {
  const other = { state: 'attached', driver: 'lead@example.com', log: [] };

  test('takes no pictures, and offers Take over only to holders of sessions.unattended', async () => {
    const fake = fakeCore();
    fake.state.sessions[SID] = other;
    await openTab(fake);
    expect(await screen.findByText(/lead@example.com is driving this PC, so this tab does not take pictures/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Take over' })).not.toBeInTheDocument();
    await sleep(80);
    expect(toolCalls(fake, 'screenshot').length).toBe(0);
  });

  test('Take over asks the relay to take over, then the status shows you driving', async () => {
    const fake = fakeCore();
    fake.state.sessions[SID] = other;
    fake.state.connect = () => { fake.state.sessions[SID] = { state: 'attached', driver: 'tech@example.com', log: [] }; return { session_id: SID, state: 'attached', asks: false, rang: true }; };
    const { user } = await openTab(fake, { permissions: ['devices.view', 'sessions.view', 'sessions.control', 'sessions.unattended'] });
    await user.click(await screen.findByRole('button', { name: 'Take over' }));
    await waitFor(() => expect(toolCalls(fake, 'device_connect')[0].args[1]).toEqual({ device_id: ID('a'), take_over: true }));
    expect(await screen.findByText('You are driving')).toBeInTheDocument();
    await waitFor(() => expect(toolCalls(fake, 'screenshot').length).toBeGreaterThan(0));
    expect(screen.queryByRole('button', { name: 'Take over' })).not.toBeInTheDocument();
  });
});

describe('Session tab: an agent task is working', () => {
  const live = (over = {}) => ({ id: TASK, state: 'running', title: 'Receipt printer stopped printing', session_id: SID, device_id: ID('a'), created_at: Date.now() - 60000, ended_at: null, model: 'claude-sonnet', phase: 'working', rev: 1, steps: [], notes: [], ...over });

  test('finds the task, shows its picture, and refetches it only when rev moves', async () => {
    const fake = fakeCore();
    fake.state.tasks = [live()];
    let rev = 1;
    fake.state.taskStatus = () => live({ rev });
    fake.state.frame = () => ({ rev, at: Date.now(), mime: 'image/png', data: rev === 1 ? 'QUJD' : 'REVG' });
    const { fake: f } = await openTab(fake);
    // Within a task check or two the tab has switched to the task's picture.
    await waitFor(() => expect(screen.getByRole('img', { name: 'Screen of Front counter' }).getAttribute('src')).toBe('data:image/png;base64,QUJD'));
    expect(await screen.findByText(/The agent is working\. This is the last picture it took/)).toBeInTheDocument();
    expect(await screen.findByText('Agent activity')).toBeInTheDocument();
    expect(screen.getByText('Receipt printer stopped printing')).toBeInTheDocument();
    const frameCalls = () => f.calls.filter((c) => c.kind === 'request' && /\/frame$/.test(c.args[1])).length;
    const before = frameCalls();
    await sleep(100);
    expect(frameCalls()).toBe(before);
    rev = 2;
    await waitFor(() => expect(screen.getByRole('img', { name: 'Screen of Front counter' }).getAttribute('src')).toBe('data:image/png;base64,REVG'));
    // The status is held open for the longest wait the relay allows.
    const polls = f.calls.filter((c) => c.kind === 'request' && /\/api\/agent\/tasks\/\w+\?wait_s=/.test(c.args[1]));
    expect(polls[0].args[1]).toContain('wait_s=25'.replace('25', String(25)));
  });

  test('takes no screenshot of its own while a task works', async () => {
    const fake = fakeCore();
    fake.state.tasks = [live()];
    fake.state.taskStatus = () => live();
    fake.state.frame = () => ({ rev: 1, at: Date.now(), mime: 'image/png', data: 'QUJD' });
    // The first screenshots may happen before the check finds the task; after it, none.
    await openTab(fake);
    await screen.findByText('Agent activity');
    const after = toolCalls(fake, 'screenshot').length;
    await sleep(150);
    expect(toolCalls(fake, 'screenshot').length).toBe(after);
  });

  test('says the picture is on its way while the task has none yet', async () => {
    const fake = fakeCore();
    fake.state.tasks = [live()];
    fake.state.taskStatus = () => live();
    await openTab(fake);
    expect(await screen.findByText(/The agent has not taken a picture yet/)).toBeInTheDocument();
  });

  test('the activity merges the task steps and notes with the session log, in time order', async () => {
    const base = Date.now() - 50000;
    const fake = fakeCore();
    fake.state.sessions[SID] = { state: 'attached', driver: 'tech@example.com', log: [
      { ts: base, kind: 'attached', detail: 'http1 elevated=true' },
      { ts: base + 5000, kind: 'screen', detail: 'screenshot 1280x800 (x4)' },
      { ts: base + 9000, kind: 'driver', detail: 'lead@example.com to tech@example.com' },
    ] };
    fake.state.tasks = [live({ created_at: base + 1000 })];
    fake.state.taskStatus = () => live({
      created_at: base + 1000,
      steps: [{ n: 1, ts: base + 2000, verb: 'screenshot', detail: '', ok: true }, { n: 2, ts: base + 4000, verb: 'click', detail: 'Start the print queue', ok: false }],
      notes: [{ ts: base + 3000, text: 'Found 14 stuck print jobs.' }],
    });
    fake.state.frame = () => ({ rev: 1, at: Date.now(), mime: 'image/png', data: 'QUJD' });
    await openTab(fake);
    const items = await waitFor(() => {
      const ol = document.querySelector('ol.tl');
      const lis = ol ? [...ol.querySelectorAll('li')] : [];
      if (lis.length < 5) throw new Error('not yet');
      return lis;
    });
    const heads = items.map((li) => li.querySelector('.tl-h span').textContent);
    // The "screen" log row falls inside the task's time and is left out: its steps stand for it.
    expect(heads).toEqual(['PC connected', 'screenshot', 'Agent note', 'click', 'Driver changed']);
    expect(items[3]).toHaveTextContent('Start the print queue');
    expect(items[3].className).toContain('fail');
    expect(items[2]).toHaveTextContent('Found 14 stuck print jobs.');
  });

  test('text the agent or the PC wrote is shown as text', async () => {
    const attack = '<img src=x onerror="document.title=\'pwned\'"> and <b>bold</b>';
    const fake = fakeCore();
    fake.state.sessions[SID] = { state: 'attached', driver: 'tech@example.com', log: [{ ts: Date.now() - 1000, kind: 'run', detail: attack }] };
    fake.state.tasks = [live()];
    fake.state.taskStatus = () => live({ title: attack, notes: [{ ts: Date.now(), text: attack }], steps: [{ n: 1, ts: Date.now(), verb: 'type', detail: attack, ok: true }], notice: attack });
    const { container } = await openTab(fake);
    await waitFor(() => expect(screen.getAllByText(attack).length).toBeGreaterThanOrEqual(3));
    expect(container.querySelector('aside img')).toBeNull();
    expect(container.querySelector('aside b')).toBeNull();
    expect(document.title).not.toBe('pwned');
  });

  test('pause, resume and stop go to the relay', async () => {
    const fake = fakeCore();
    fake.state.tasks = [live()];
    fake.state.taskStatus = () => live();
    fake.state.frame = () => ({ rev: 1, at: Date.now(), mime: 'image/png', data: 'QUJD' });
    const { user } = await openTab(fake);
    await user.click(await screen.findByRole('button', { name: 'Pause the task' }));
    await user.click(screen.getByRole('button', { name: 'Stop the task' }));
    await waitFor(() => expect(fake.state.controlled).toEqual(['pause', 'stop']));
  });

  test('when the task ends the tab goes back to taking its own pictures', async () => {
    const fake = fakeCore();
    fake.state.tasks = [live()];
    let over = false;
    fake.state.taskStatus = () => (over ? live({ state: 'done', summary: 'The printer works.', ended_at: Date.now() }) : live());
    fake.state.frame = () => ({ rev: 1, at: Date.now(), mime: 'image/png', data: 'QUJD' });
    await openTab(fake);
    await screen.findByText('Agent activity');
    const before = toolCalls(fake, 'screenshot').length;
    over = true;
    fake.state.tasks = [live({ state: 'done' })];
    expect(await screen.findByText(/The printer works\./)).toBeInTheDocument();
    await waitFor(() => expect(toolCalls(fake, 'screenshot').length).toBeGreaterThan(before));
  });

  test('Hand to the agent starts a task on this session', async () => {
    const fake = fakeCore();
    const { user } = await openTab(fake);
    await user.click(await screen.findByRole('button', { name: 'Hand to the agent' }));
    const dialog = screen.getByRole('dialog', { hidden: true });
    await user.type(within(dialog).getByLabelText('What should the agent do?'), 'Fix the printer');
    await user.click(within(dialog).getByRole('checkbox', { name: /Keep working if I leave/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Start the task' }));
    await waitFor(() => expect(fake.state.started).toEqual({ instructions: 'Fix the printer', keep_working: true, session_id: SID }));
  });
});

describe('Session tab: ending', () => {
  test('End session ends it on the relay and closes the tab', async () => {
    const { fake, user } = await openTab();
    await user.click(await screen.findByRole('button', { name: 'End session' }));
    await waitFor(() => expect(fake.state.ended).toEqual([SID]));
    await waitFor(() => expect(screen.queryByRole('tab', { name: /Front counter/ })).not.toBeInTheDocument());
    expect(screen.getByRole('heading', { name: /Devices/ })).toBeInTheDocument();
  });

  test('a session the PC ended shows it, stops everything and offers to close the tab', async () => {
    const fake = fakeCore();
    const { user } = await openTab(fake);
    await screen.findByRole('img', { name: 'Screen of Front counter' });
    fake.state.sessions[SID] = { state: 'ended', ended_reason: 'owner', driver: 'tech@example.com', log: [] };
    expect(await screen.findByText('The session ended.')).toBeInTheDocument();
    const calls = toolCalls(fake, 'screenshot').length;
    await sleep(100);
    expect(toolCalls(fake, 'screenshot').length).toBe(calls);
    expect(screen.queryByRole('button', { name: 'End session' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close tab' }));
    expect(screen.queryByRole('tab', { name: /Front counter/ })).not.toBeInTheDocument();
  });

  test('tabs of sessions that ended while the app was closed are not brought back', async () => {
    const fake = fakeCore();
    localStorage.setItem('support.tabs', JSON.stringify([{ key: SID, account: 'acc1', deviceId: ID('a'), deviceName: 'Front counter', sessionId: SID, taskId: null }]));
    fake.state.sessions[SID] = { state: 'ended', ended_reason: 'owner', log: [] };
    renderApp(fake);
    await screen.findByRole('button', { name: /Front counter/ });
    await waitFor(() => expect(JSON.parse(localStorage.getItem('support.tabs'))).toEqual([]));
    expect(screen.queryByRole('tab', { name: /Front counter/ })).not.toBeInTheDocument();
  });
});
