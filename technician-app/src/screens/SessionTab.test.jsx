import { act, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { useSession } from '../session.js';
import { FAST, ID, ToolFail, fakeCore, renderApp } from '../test-utils.jsx';

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
      if (lis.length < 4) throw new Error('not yet');
      return lis;
    });
    const heads = items.map((li) => li.querySelector('.tl-h span').textContent);
    // The "screen" log row falls inside the task's time and is left out: its steps stand for it.
    // The 'attached' row is from before the task began, so it is not this task's.
    expect(heads).toEqual(['screenshot', 'Agent note', 'click', 'Driver changed']);
    expect(items[2]).toHaveTextContent('Start the print queue');
    expect(items[2].className).toContain('fail');
    expect(items[1]).toHaveTextContent('Found 14 stuck print jobs.');
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

describe('Session tab: handing the session to the agent', () => {
  async function fillAndStart(user, text) {
    await user.click(await screen.findByRole('button', { name: 'Hand to the agent' }));
    const dialog = screen.getByRole('dialog', { hidden: true });
    await user.click(within(dialog).getByLabelText('What should the agent do?'));
    await user.paste(text);
    await user.click(within(dialog).getByRole('button', { name: 'Start the task' }));
  }

  test('stops its screenshots and waits for the one in flight before the task is started', async () => {
    const fake = fakeCore();
    const order = [];
    let finishShot = null;
    // The first screenshot hangs until the test lets it finish: the PC is busy with it.
    fake.state.screenshot = () => {
      order.push('shot-start');
      return new Promise((resolve) => { finishShot = () => { order.push('shot-end'); resolve({ data: {}, image: { mime: 'image/jpeg', data: 'QUJD' } }); }; });
    };
    const request = fake.core.request.getMockImplementation();
    fake.core.request.mockImplementation(async (account, method, path, body) => {
      if (method === 'POST' && path === '/api/agent/tasks') order.push('task-start');
      return request(account, method, path, body);
    });
    const { user } = await openTab(fake);
    await waitFor(() => expect(order).toEqual(['shot-start']));
    await fillAndStart(user, 'Fix the printer');
    // The task is not started while the screenshot is on its way.
    await sleep(120);
    expect(order).toEqual(['shot-start']);
    expect(fake.state.started).toBeUndefined();
    act(() => finishShot());
    await waitFor(() => expect(fake.state.started).toEqual({ instructions: 'Fix the printer', keep_working: false, session_id: SID }));
    expect(order).toEqual(['shot-start', 'shot-end', 'task-start']);
    // The tab has switched to the task and takes no screenshot of its own after that.
    await screen.findByText('Agent activity');
    await sleep(200);
    expect(order).toEqual(['shot-start', 'shot-end', 'task-start']);
  });

  test('starting from the device detail, with that PC\'s tab open, waits for the tab\'s screenshot too and follows the task in that tab', async () => {
    const fake = fakeCore();
    const order = [];
    let finishShot = null;
    fake.state.screenshot = () => {
      order.push('shot-start');
      return new Promise((resolve) => { finishShot = () => { order.push('shot-end'); resolve({ data: {}, image: { mime: 'image/jpeg', data: 'QUJD' } }); }; });
    };
    const request = fake.core.request.getMockImplementation();
    fake.core.request.mockImplementation(async (account, method, path, body) => {
      if (method === 'POST' && path === '/api/agent/tasks') order.push('task-start');
      return request(account, method, path, body);
    });
    const { user } = await openTab(fake);
    await waitFor(() => expect(order).toEqual(['shot-start']));
    // Leave the tab (its screenshot is still on its way) and hand the same PC over from its detail.
    await user.click(screen.getByRole('tab', { name: 'Devices' }));
    await user.click(await screen.findByRole('button', { name: /^Front counter/ }));
    const detail = screen.getByRole('region', { name: 'Device details' });
    await user.click(within(detail).getByRole('button', { name: 'Hand to the agent' }));
    const dialog = screen.getByRole('dialog', { hidden: true });
    await user.click(within(dialog).getByLabelText('What should the agent do?'));
    await user.paste('Fix the printer');
    await user.click(within(dialog).getByRole('button', { name: 'Start the task' }));
    await sleep(120);
    expect(order).toEqual(['shot-start']);
    expect(fake.state.started).toBeUndefined();
    act(() => finishShot());
    await waitFor(() => expect(fake.state.started).toEqual({ instructions: 'Fix the printer', keep_working: false, session_id: SID }));
    expect(order).toEqual(['shot-start', 'shot-end', 'task-start']);
    // The PC's session is open and driven by this person, so the task starts on it (a start by
    // device would make the relay connect again and be refused). The PC's open tab is shown and follows the task; no second tab is made, and no screenshot follows.
    expect(await screen.findByText('Agent activity')).toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(2);
    await sleep(200);
    expect(order).toEqual(['shot-start', 'shot-end', 'task-start']);
  });

  test('every task start goes through the app\'s one guarded function', () => {
    const dir = join(import.meta.dirname, '..');
    const files = readdirSync(dir, { recursive: true }).map(String).filter((f) => /\.jsx?$/.test(f) && !/\.test\./.test(f) && f !== 'test-utils.jsx');
    expect(files).toContain(join('screens', 'SessionTab.jsx'));
    const callers = files.filter((f) => /\bstartTask\(/.test(readFileSync(join(dir, f), 'utf8')) && f !== 'api.js');
    expect(callers).toEqual(['App.jsx']);
  });

  test('two starts hold the screenshots separately: one releasing does not free the other', async () => {
    const fake = fakeCore();
    fake.state.sessions[SID] = { state: 'attached', driver: 'tech@example.com', machine: 'FRONT', log: [] };
    const props = { core: fake.core, account: 'acc1', tab: { key: SID, sessionId: SID, taskId: null }, active: true, me: { identity: 'tech@example.com' }, canControl: true, tuning: FAST, visible: true, onSessionKnown: () => {} };
    const { result } = renderHook(() => useSession(props));
    await waitFor(() => expect(toolCalls(fake, 'screenshot').length).toBeGreaterThanOrEqual(2));
    await act(async () => { await result.current.holdScreenshots(); await result.current.holdScreenshots(); });
    await sleep(60);
    const held = toolCalls(fake, 'screenshot').length;
    act(() => result.current.releaseScreenshots()); // the first start failed
    await sleep(150);
    expect(toolCalls(fake, 'screenshot').length).toBe(held); // the second start still holds
    act(() => result.current.releaseScreenshots());
    await waitFor(() => expect(toolCalls(fake, 'screenshot').length).toBeGreaterThan(held));
    // A release with nothing held does not push the count below zero.
    act(() => result.current.releaseScreenshots());
    act(() => { result.current.holdScreenshots(); });
    const again = toolCalls(fake, 'screenshot').length;
    await sleep(120);
    expect(toolCalls(fake, 'screenshot').length).toBe(again);
  });

  test('a picture that fails to load when the tab comes back is fetched again at the next poll', async () => {
    const fake = fakeCore();
    fake.state.tasks = [{ id: TASK, state: 'running', title: 'Fix', session_id: SID, device_id: ID('a'), created_at: Date.now() - 1000, ended_at: null, phase: 'working', rev: 1, steps: [], notes: [] }];
    let mode = 'first';
    let failed = 0;
    fake.state.frame = () => {
      if (mode === 'fail') { failed += 1; throw Object.assign(new Error('the relay is busy'), { code: 'unavailable', status: 503 }); }
      return { rev: 1, at: Date.now(), mime: 'image/png', data: mode === 'first' ? 'QUJD' : 'REVG' };
    };
    const { user } = await openTab(fake);
    await waitFor(() => expect(screen.getByRole('img', { name: 'Screen of Front counter' }).getAttribute('src')).toBe('data:image/png;base64,QUJD'));
    // Away from the tab and back, while the frame cannot be read. Its rev has not moved.
    await user.click(screen.getByRole('tab', { name: 'Devices' }));
    mode = 'fail';
    await user.click(screen.getByRole('tab', { name: /Front counter/ }));
    await waitFor(() => expect(failed).toBeGreaterThanOrEqual(1));
    mode = 'good';
    await waitFor(() => expect(screen.getByRole('img', { name: 'Screen of Front counter' }).getAttribute('src')).toBe('data:image/png;base64,REVG'));
  });

  test('from the device detail, a session someone else drives is not used: the task starts by device', async () => {
    const fake = fakeCore();
    fake.state.sessions[SID] = { state: 'attached', driver: 'lead@example.com', machine: 'FRONT', log: [] };
    const { user } = await openTab(fake);
    await user.click(screen.getByRole('tab', { name: 'Devices' }));
    await user.click(await screen.findByRole('button', { name: /^Front counter/ }));
    const detail = screen.getByRole('region', { name: 'Device details' });
    await user.click(within(detail).getByRole('button', { name: 'Hand to the agent' }));
    const dialog = screen.getByRole('dialog', { hidden: true });
    await user.click(within(dialog).getByLabelText('What should the agent do?'));
    await user.paste('Fix the printer');
    await user.click(within(dialog).getByRole('button', { name: 'Start the task' }));
    await waitFor(() => expect(fake.state.started).toEqual({ instructions: 'Fix the printer', keep_working: false, device_id: ID('a') }));
  });

  test('a session the relay says is gone is retried by PC, with the screenshots still held in between', async () => {
    const fake = fakeCore();
    const posts = [];
    const request = fake.core.request.getMockImplementation();
    fake.core.request.mockImplementation(async (account, method, path, body) => {
      if (method === 'POST' && path === '/api/agent/tasks') {
        posts.push({ body, shots: toolCalls(fake, 'screenshot').length });
        if (body.session_id) throw Object.assign(new Error('that session is not live'), { code: 'session_ended', status: 409 });
      }
      return request(account, method, path, body);
    });
    const { user } = await openTab(fake);
    await waitFor(() => expect(toolCalls(fake, 'screenshot').length).toBeGreaterThanOrEqual(1));
    await user.click(screen.getByRole('tab', { name: 'Devices' }));
    await user.click(await screen.findByRole('button', { name: /^Front counter/ }));
    const detail = screen.getByRole('region', { name: 'Device details' });
    await user.click(within(detail).getByRole('button', { name: 'Hand to the agent' }));
    const dialog = screen.getByRole('dialog', { hidden: true });
    await user.click(within(dialog).getByLabelText('What should the agent do?'));
    await user.paste('Fix the printer');
    await user.click(within(dialog).getByRole('button', { name: 'Start the task' }));
    await waitFor(() => expect(fake.state.started).toEqual({ instructions: 'Fix the printer', keep_working: false, device_id: ID('a') }));
    expect(posts.map((p) => Object.keys(p.body).includes('session_id'))).toEqual([true, false]);
    expect(posts[1].shots).toBe(posts[0].shots);
    expect(await screen.findByText('Agent activity')).toBeInTheDocument();
  });

  test('a task the relay refuses to start lets the screenshots go on', async () => {
    const fake = fakeCore();
    fake.state.requestError = (method, p) => (method === 'POST' && p === '/api/agent/tasks' ? Object.assign(new Error('the built-in agent is off'), { code: 'caps_not_set', status: 409 }) : null);
    const { user } = await openTab(fake);
    await waitFor(() => expect(toolCalls(fake, 'screenshot').length).toBeGreaterThanOrEqual(1));
    await fillAndStart(user, 'Fix the printer');
    expect(await screen.findByText('the built-in agent is off')).toBeInTheDocument();
    const before = toolCalls(fake, 'screenshot').length;
    await waitFor(() => expect(toolCalls(fake, 'screenshot').length).toBeGreaterThan(before + 1));
  });

  const LONG = 'Check why the receipt printer at the front counter stopped printing after the update, then finish with a test page';

  test('the activity header shows the instructions whole when the app started the task, though the relay cut the title', async () => {
    const fake = fakeCore();
    fake.state.taskStatus = (t) => ({ ...t, title: t.title.slice(0, 100) });
    const { user } = await openTab(fake);
    await fillAndStart(user, LONG);
    expect(await screen.findByText(LONG)).toBeInTheDocument();
    expect(LONG.slice(0, 100)).not.toBe(LONG);
    expect(JSON.parse(localStorage.getItem('support.task_titles'))[ID('t')]).toBe(LONG);
  });

  test('a task the app did not start is cut at a whole word with an ellipsis', async () => {
    const fake = fakeCore();
    fake.state.tasks = [{ id: TASK, state: 'running', title: LONG.slice(0, 100), session_id: SID, device_id: ID('a'), created_at: Date.now() - 1000, ended_at: null, phase: 'working', rev: 1, steps: [], notes: [] }];
    await openTab(fake);
    expect(await screen.findByText('Check why the receipt printer at the front counter stopped printing after the update, then finish\u2026')).toBeInTheDocument();
    expect(screen.queryByText(/then finish wi$/)).not.toBeInTheDocument();
  });

  test('the notification list shows the whole instructions for a task the app started, and a word-cut title for others', async () => {
    const fake = fakeCore();
    fake.state.taskStatus = (t) => ({ ...t, title: t.title.slice(0, 100) });
    const { user } = await openTab(fake);
    await fillAndStart(user, LONG);
    await screen.findByText(LONG);
    const item = (id, task_id) => ({ id, event: 'task_finished', at: Date.now(), title: 'Task finished', body: LONG.slice(0, 100), device_id: ID('a'), task_id, session_id: null });
    act(() => fake.emit('feed://items', { account: 'acc1', live: true, items: [item(1, ID('t')), item(2, ID('z'))] }));
    await user.click(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('button', { name: /Notifications/ }));
    const list = await screen.findByRole('list', { name: 'Recent' });
    const [theirs, ours] = within(list).getAllByRole('listitem').sort((a, b) => a.textContent.length - b.textContent.length);
    expect(ours).toHaveTextContent(LONG);
    expect(theirs).toHaveTextContent('then finish\u2026');
    expect(theirs).not.toHaveTextContent(/finish wi\b/);
  });
});

describe('Session tab: the end of a task and the panel layout', () => {
  const ended = (over = {}) => ({ id: TASK, state: 'failed', end_reason: 'could not connect to the PC: live-tech@example.com is connected', title: 'Fix', session_id: SID, device_id: ID('a'), created_at: Date.now() - 60000, ended_at: Date.now() - 1000, phase: 'ended', rev: 1, steps: [], notes: [], summary: null, ...over });

  test('a task that ended failed or stopped says why, in the panel', async () => {
    const fake = fakeCore();
    fake.state.tasks = [ended()];
    fake.state.taskStatus = () => ended();
    localStorage.setItem('support.tabs', JSON.stringify([{ key: `task:${TASK}`, account: 'acc1', deviceId: ID('a'), deviceName: 'Front counter', sessionId: SID, taskId: TASK }]));
    fake.state.sessions[SID] = { state: 'attached', driver: 'tech@example.com', log: [] };
    renderApp(fake);
    await userEvent.setup().click(await screen.findByRole('tab', { name: /Front counter/ }));
    expect(await screen.findByText('The task is over: failed.')).toBeInTheDocument();
    expect(screen.getByText('Why: could not connect to the PC: live-tech@example.com is connected')).toBeInTheDocument();
  });

  test('a finished task shows no reason line', async () => {
    const fake = fakeCore();
    fake.state.tasks = [ended({ state: 'done', end_reason: 'finished', summary: 'Done.' })];
    fake.state.taskStatus = () => ended({ state: 'done', end_reason: 'finished', summary: 'Done.' });
    localStorage.setItem('support.tabs', JSON.stringify([{ key: `task:${TASK}`, account: 'acc1', deviceId: ID('a'), deviceName: 'Front counter', sessionId: SID, taskId: TASK }]));
    fake.state.sessions[SID] = { state: 'attached', driver: 'tech@example.com', log: [] };
    renderApp(fake);
    await userEvent.setup().click(await screen.findByRole('tab', { name: /Front counter/ }));
    expect(await screen.findByText('The task is over: finished.')).toBeInTheDocument();
    expect(screen.queryByText(/^Why:/)).not.toBeInTheDocument();
  });

  test('a long summary and the cost line are separate paragraphs in normal flow, and the stylesheet gives them no way to overlap', async () => {
    const fake = fakeCore();
    const summary = 'The printer queue was stuck on a job from Tuesday. I cleared it, restarted the spooler, printed a test page and checked that the receipt printer answers from the till. '.repeat(3);
    const t = () => ended({ state: 'done', end_reason: 'finished', summary, cost_usd: 0.023, caps: { task_cap_usd: 1 } });
    fake.state.tasks = [t()];
    fake.state.taskStatus = t;
    localStorage.setItem('support.tabs', JSON.stringify([{ key: `task:${TASK}`, account: 'acc1', deviceId: ID('a'), deviceName: 'Front counter', sessionId: SID, taskId: TASK }]));
    fake.state.sessions[SID] = { state: 'attached', driver: 'tech@example.com', log: [] };
    renderApp(fake);
    await userEvent.setup().click(await screen.findByRole('tab', { name: /Front counter/ }));
    const cost = await screen.findByText('The task cost $0.023 of the $1.00 task cap.');
    const sum = screen.getByText(/The printer queue was stuck/).closest('p');
    expect(sum).not.toBe(cost);
    expect(sum.contains(cost)).toBe(false);
    expect(cost.tagName).toBe('P');
    expect(sum.parentElement).toBe(cost.parentElement);
    expect(sum.compareDocumentPosition(cost) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Cause of the overlap: a negative top margin meant for the cost line under the title also applied
    // under the summary and pulled it up over the summary's last line. The rule is for that case only now.
    const css = readFileSync(join(import.meta.dirname, '..', 'styles', 'app.css'), 'utf8');
    const rule = (selector) => [...css.matchAll(new RegExp(`^${selector.replace(/[.+]/g, '\\$&')} \\{([^}]*)\\}`, 'gm'))].map((m) => m[1]).join(' ');
    expect(rule('.act .cost')).not.toMatch(/-\d+px/);
    expect(rule('.act .task + .cost')).toMatch(/margin-top: -10px/);
    for (const sel of ['.act .cost', '.act .task + .cost', '.act .tl-end', '.act .task', '.tl-d']) expect(rule(sel), sel).not.toMatch(/position:\s*(absolute|fixed)|(^|[\s;])(max-)?height:|overflow:\s*hidden/);
    expect(rule('.act .tl-end')).toMatch(/margin-top: 8px/);
  });

  test('while a task is shown, the log lists only what happened from its start on, not an earlier task\'s', async () => {
    const base = Date.now() - 100000;
    const fake = fakeCore();
    fake.state.sessions[SID] = { state: 'attached', driver: 'tech@example.com', log: [
      { ts: base + 1000, kind: 'run', detail: 'earlier task: dir C:\\' },
      { ts: base + 2000, kind: 'screen', detail: 'earlier task screenshot' },
      { ts: base + 60000, kind: 'run', detail: 'this task: net stop spooler' },
    ] };
    const live = () => ({ id: TASK, state: 'running', title: 'Fix', session_id: SID, device_id: ID('a'), created_at: base + 50000, ended_at: null, phase: 'working', rev: 1, steps: [{ n: 1, ts: base + 55000, verb: 'screenshot', detail: '', ok: true }], notes: [{ ts: base + 56000, text: 'Looking at the queue.' }] });
    fake.state.tasks = [live()];
    fake.state.taskStatus = live;
    fake.state.frame = () => ({ rev: 1, at: Date.now(), mime: 'image/png', data: 'QUJD' });
    await openTab(fake);
    expect(await screen.findByText('this task: net stop spooler')).toBeInTheDocument();
    expect(screen.getByText('Looking at the queue.')).toBeInTheDocument();
    expect(screen.queryByText(/earlier task/)).not.toBeInTheDocument();
  });
});

describe('Session tab: what the task costs', () => {
  const live = (over = {}) => ({ id: TASK, state: 'running', title: 'Receipt printer stopped printing', session_id: SID, device_id: ID('a'), created_at: Date.now() - 60000, ended_at: null, model: 'claude-sonnet', phase: 'working', rev: 1, steps: [], notes: [], cost_usd: 0.4231, reserved_usd: 0, ...over });

  test('the header shows the cost against the task cap while the task runs, and the summary shows it when the task is over', async () => {
    const fake = fakeCore();
    fake.state.tasks = [live()];
    let over = false;
    fake.state.taskCaps = { task_cap_usd: 2, month_cap_usd: 50, month_spent_usd: 3.1 };
    fake.state.taskStatus = () => (over ? live({ state: 'done', summary: 'The printer works.', ended_at: Date.now(), cost_usd: 0.9 }) : live());
    fake.state.frame = () => ({ rev: 1, at: Date.now(), mime: 'image/png', data: 'QUJD' });
    await openTab(fake);
    expect(await screen.findByText('Spent $0.423 of the $2.00 task cap.')).toBeInTheDocument();
    over = true;
    fake.state.tasks = [live({ state: 'done' })];
    expect(await screen.findByText(/The printer works\./)).toBeInTheDocument();
    expect(await screen.findByText('The task cost $0.90 of the $2.00 task cap.')).toBeInTheDocument();
    expect(screen.queryByText(/Spent \$/)).not.toBeInTheDocument();
  });

  test('a relay that sends no caps still shows what was spent', async () => {
    const fake = fakeCore();
    fake.state.tasks = [live({ cost_usd: 1.5 })];
    fake.state.taskStatus = () => live({ cost_usd: 1.5 });
    fake.state.frame = () => ({ rev: 1, at: Date.now(), mime: 'image/png', data: 'QUJD' });
    await openTab(fake);
    expect(await screen.findByText('Spent $1.50 so far.')).toBeInTheDocument();
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

const statusPolls = (fake) => fake.calls.filter((c) => c.kind === 'request' && /\/api\/agent\/tasks\/\w+\?wait_s=/.test(c.args[1])).length;
const liveTask = (over = {}) => ({ id: TASK, state: 'running', title: 'Receipt printer stopped printing', session_id: SID, device_id: ID('a'), created_at: Date.now() - 60000, ended_at: null, model: 'claude-sonnet', phase: 'working', rev: 1, steps: [], notes: [], ...over });

describe('Session tab: a task started from a PC', () => {
  test('opens a tab keyed to the task, follows it, and adopts the session when the relay has made one', async () => {
    const user = userEvent.setup();
    const fake = fakeCore();
    let connected = false;
    // A task started on a PC has no session at first: the relay connects, and the status says which.
    fake.state.taskStatus = (t) => ({ ...liveTask({ id: t.id, title: t.title }), session_id: connected ? SID : null });
    fake.state.frame = () => ({ rev: 1, at: Date.now(), mime: 'image/png', data: 'QUJD' });
    fake.state.sessions[SID] = { state: 'attached', driver: 'tech@example.com', log: [] };
    renderApp(fake);
    await user.click(await screen.findByRole('button', { name: /Front counter/ }));
    await user.click(await screen.findByRole('button', { name: 'Hand to the agent' }));
    const dialog = screen.getByRole('dialog', { hidden: true });
    await user.type(within(dialog).getByLabelText('What should the agent do?'), 'Fix the printer');
    await user.click(within(dialog).getByRole('button', { name: 'Start the task' }));
    await waitFor(() => expect(fake.state.started).toEqual({ instructions: 'Fix the printer', keep_working: false, device_id: ID('a') }));

    const tab = await screen.findByRole('tab', { name: /Front counter/ });
    expect(tab).toHaveAttribute('aria-selected', 'true');
    const taskId = fake.state.tasks[0].id;
    expect(JSON.parse(localStorage.getItem('support.tabs'))[0]).toMatchObject({ key: `task:${taskId}`, taskId, sessionId: null, deviceId: ID('a') });
    // It is followed from the first moment, with no session to look up.
    expect(await screen.findByText('Agent activity')).toBeInTheDocument();
    await waitFor(() => expect(statusPolls(fake)).toBeGreaterThanOrEqual(2));
    expect(screen.getByRole('img', { name: 'Screen of Front counter' }).getAttribute('src')).toBe('data:image/png;base64,QUJD');

    connected = true;
    await waitFor(() => expect(JSON.parse(localStorage.getItem('support.tabs'))[0].sessionId).toBe(SID));
    expect(JSON.parse(localStorage.getItem('support.tabs'))).toHaveLength(1);
  });
});

describe('Session tab: following every open task', () => {
  test('a task keeps being followed while another screen or tab is shown, and only the tab on screen takes pictures', async () => {
    const fake = fakeCore();
    fake.state.tasks = [liveTask()];
    fake.state.taskStatus = () => liveTask();
    fake.state.frame = () => ({ rev: 1, at: Date.now(), mime: 'image/png', data: 'QUJD' });
    const { user } = await openTab(fake);
    await screen.findByText('Agent activity');
    await user.click(screen.getByRole('tab', { name: 'Devices' }));
    await user.click(screen.getByRole('button', { name: /Settings/ }));
    expect(screen.getByText('Agent activity')).not.toBeVisible();
    const before = statusPolls(fake);
    await sleep(200);
    expect(statusPolls(fake)).toBeGreaterThanOrEqual(before + 3);
    // Back on the tab: it is there, with its picture.
    await user.click(screen.getByRole('tab', { name: /Front counter/ }));
    expect(await screen.findByRole('img', { name: 'Screen of Front counter' })).toBeInTheDocument();
  });

  test('a second tab is followed while the first one is shown', async () => {
    const fake = fakeCore();
    const SID2 = 'z'.repeat(64);
    const TASK2 = ID('u');
    localStorage.setItem('support.tabs', JSON.stringify([
      { key: SID, account: 'acc1', deviceId: ID('a'), deviceName: 'Front counter', sessionId: SID, taskId: null },
      { key: SID2, account: 'acc1', deviceId: ID('b'), deviceName: 'Back office', sessionId: SID2, taskId: TASK2 },
    ]));
    fake.state.sessions[SID] = { state: 'attached', driver: 'tech@example.com', log: [] };
    fake.state.sessions[SID2] = { state: 'attached', driver: 'tech@example.com', log: [] };
    fake.state.tasks = [liveTask({ id: TASK2, session_id: SID2, device_id: ID('b') })];
    fake.state.taskStatus = (t) => ({ ...t });
    renderApp(fake);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: /Front counter/ }));
    const before = statusPolls(fake);
    await waitFor(() => expect(statusPolls(fake)).toBeGreaterThanOrEqual(before + 3));
    expect(fake.calls.filter((c) => c.kind === 'request' && c.args[1].includes(`/api/agent/tasks/${TASK2}?wait_s=`)).length).toBeGreaterThanOrEqual(3);
  });

  test('a tab that is not shown takes no pictures', async () => {
    const { fake, user } = await openTab();
    await waitFor(() => expect(toolCalls(fake, 'screenshot').length).toBeGreaterThanOrEqual(2));
    await user.click(screen.getByRole('tab', { name: 'Devices' }));
    await sleep(60);
    const frozen = toolCalls(fake, 'screenshot').length;
    await sleep(150);
    expect(toolCalls(fake, 'screenshot').length).toBe(frozen);
  });

  test('a status that holds no task is a failed read: the loop waits and asks again, and nothing is left unhandled', async () => {
    const fake = fakeCore();
    fake.state.tasks = [liveTask()];
    let asked = 0;
    fake.state.taskStatus = () => (++asked <= 2 ? undefined : liveTask());
    fake.state.frame = () => ({ rev: 1, at: Date.now(), mime: 'image/png', data: 'QUJD' });
    await openTab(fake);
    expect(await screen.findByText('Agent activity')).toBeInTheDocument();
    expect(asked).toBeGreaterThanOrEqual(3);
  });

  test('a relay that answers with an error is waited out and asked again', async () => {
    const fake = fakeCore();
    fake.state.tasks = [liveTask()];
    let asked = 0;
    fake.state.taskStatus = () => { if (++asked <= 2) throw new ToolFail('The relay is busy. Try again in a moment.', 'unavailable'); return liveTask(); };
    await openTab(fake);
    expect(await screen.findByText('Agent activity')).toBeInTheDocument();
  });
});

describe('Session tab: what a screen reader hears', () => {
  test('a new note from the agent and the end of the task are announced; the steps are not', async () => {
    const fake = fakeCore();
    fake.state.tasks = [liveTask()];
    let task = liveTask({ notes: [{ ts: Date.now() - 5000, text: 'Old note from before.' }] });
    fake.state.taskStatus = () => task;
    fake.state.frame = () => ({ rev: 1, at: Date.now(), mime: 'image/png', data: 'QUJD' });
    const { container } = await openTab(fake);
    await screen.findByText('Old note from before.');
    const announce = () => container.querySelector('.announce').textContent;
    expect(announce()).toBe('');
    // The list is not a live region: ten steps would be ten announcements.
    expect(container.querySelector('ol.tl').hasAttribute('aria-live')).toBe(false);
    task = liveTask({ rev: 2, notes: task.notes, steps: [{ n: 1, ts: Date.now(), verb: 'screenshot', detail: '', ok: true }, { n: 2, ts: Date.now(), verb: 'click', detail: 'Start', ok: true }] });
    await screen.findByText('Start');
    await sleep(60);
    expect(announce()).toBe('');
    task = liveTask({ rev: 3, steps: task.steps, notes: [...task.notes, { ts: Date.now(), text: 'Found 14 stuck print jobs.' }] });
    await waitFor(() => expect(announce()).toBe('Found 14 stuck print jobs.'));
    task = liveTask({ state: 'done', rev: 4, ended_at: Date.now(), notes: task.notes, steps: task.steps });
    await waitFor(() => expect(announce()).toBe('The task is over: finished.'));
  });
});

describe('Tabs', () => {
  test('the tablist holds only tabs, each wired to its panel, and ending a session is a labelled button beside it', async () => {
    const { container, user } = await openTab();
    const list = screen.getByRole('tablist', { name: 'Open views' });
    expect([...list.children].map((c) => c.getAttribute('role'))).toEqual(['tab', 'tab']);
    for (const tab of within(list).getAllByRole('tab', { hidden: true })) {
      const panel = container.querySelector(`#${CSS.escape(tab.getAttribute('aria-controls'))}`);
      expect(panel).toHaveAttribute('role', 'tabpanel');
      expect(panel.getAttribute('aria-labelledby')).toBe(tab.id);
    }
    expect(screen.getByRole('tab', { name: /Front counter/ })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tab', { name: 'Devices' })).toHaveAttribute('tabindex', '-1');
    const close = screen.getByRole('button', { name: 'End session with Front counter' });
    expect(list.contains(close)).toBe(false);
    await user.click(close);
    await waitFor(() => expect(screen.queryByRole('tab', { name: /Front counter/ })).not.toBeInTheDocument());
  });

  test('the arrow keys, Home and End move between the tabs and open the one reached', async () => {
    const { user } = await openTab();
    screen.getByRole('tab', { name: /Front counter/ }).focus();
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('tab', { name: 'Devices' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Devices' })).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('tab', { name: /Front counter/ })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Home}');
    expect(screen.getByRole('tab', { name: 'Devices' })).toHaveFocus();
    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: /Front counter/ })).toHaveFocus();
  });
});
