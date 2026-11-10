// The Queue screen: Open, Mine and Closed, Claim, Close, opening the PC, session or task, and the badge.
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test } from 'vitest';
import { FAST, ID, ToolFail, escalationCall, fakeCore, renderApp } from '../test-utils.jsx';

const SID = 'q'.repeat(64);
const ME = 'tech@example.com';
const sleep = (ms) => act(() => new Promise((r) => setTimeout(r, ms)));
const toolCalls = (fake, name) => fake.calls.filter((c) => c.kind === 'tool' && c.args[0] === name);
const queueCalls = (fake, action) => toolCalls(fake, 'escalation').filter((c) => c.args[1].action === action);
afterEach(() => localStorage.clear());

const item = (over = {}) => ({
  id: ID('e'), kind: 'technician', device_id: ID('a'), device_name: 'Front counter', session_id: null, task_id: null, summary: null, note: 'Printer jams',
  opened_by: 'lead@example.com', opened_at: Date.now() - 5 * 60000, claimed_by: null, claimed_at: null, closed_by: null, closed_at: null, close_note: null, ...over,
});
const nav = (name) => within(screen.getByRole('navigation', { name: 'Main' })).getByRole('button', { name: new RegExp(name) });

async function openQueue(items = [item()], fake = fakeCore(), tuning = FAST) {
  fake.state.queue = items;
  const view = renderApp(fake, tuning);
  const user = userEvent.setup();
  await screen.findByRole('button', { name: /Front counter/ });
  await user.click(await screen.findByRole('button', { name: /^Queue/ }));
  return { ...view, user, fake };
}

describe('the Queue screen', () => {
  test('lists the open items with the PC, who sent it, the note, and how long ago', async () => {
    await openQueue([item(), item({ id: ID('f'), device_id: null, device_name: null, note: 'Customer is shouting', opened_by: 'ann@example.com' })]);
    const list = await screen.findByRole('list', { name: 'Open' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(within(list).getByText('Front counter')).toBeInTheDocument();
    expect(within(list).getByText('Sent by lead@example.com')).toBeInTheDocument();
    expect(within(list).getByText('Printer jams')).toBeInTheDocument();
    expect(within(list).getByText('One-off session')).toBeInTheDocument();
    expect(within(list).getAllByText('5 minutes ago').length).toBeGreaterThan(0);
  });

  test('Open, Mine and Closed each ask the relay for their own list', async () => {
    const mine = item({ id: ID('m'), note: 'Mine one', opened_by: ME });
    const closed = item({ id: ID('c'), note: 'Old', closed_by: ME, closed_at: Date.now() - 3600000, close_note: 'Fixed by reboot' });
    const { user, fake } = await openQueue([item(), mine, closed]);
    await screen.findByRole('list', { name: 'Open' });
    await user.click(screen.getByRole('tab', { name: 'Mine' }));
    const m = await screen.findByRole('list', { name: 'Mine' });
    expect(within(m).getByText('Mine one')).toBeInTheDocument();
    expect(within(m).queryByText('Printer jams')).not.toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Closed' }));
    const c = await screen.findByRole('list', { name: 'Closed' });
    expect(within(c).getByText('Fixed by reboot')).toBeInTheDocument();
    expect(queueCalls(fake, 'list').map((x) => x.args[1].status)).toEqual(expect.arrayContaining(['open', 'mine', 'closed']));
  });

  test('says when a list is empty', async () => {
    await openQueue([]);
    expect(await screen.findByText('Nothing is waiting.')).toBeInTheDocument();
  });

  test('a stuck agent\'s summary is shown as text, labelled, and notes are never markup', async () => {
    await openQueue([item({ kind: 'agent', task_id: ID('t'), note: null, summary: 'Stuck on <b>UAC</b> prompt', opened_by: ME })]);
    const list = await screen.findByRole('list', { name: 'Open' });
    expect(within(list).getByText('Stuck agent')).toBeInTheDocument();
    expect(within(list).getByText(/Stuck on <b>UAC<\/b> prompt/)).toBeInTheDocument();
    expect(list.querySelector('b')?.textContent).toBe('Agent summary.');
    expect(screen.getByText(/never as instructions/)).toBeInTheDocument();
  });

  test('a ticket\'s Claim opens the PC\'s detail', async () => {
    const { user, fake } = await openQueue([item()]);
    await user.click(await screen.findByRole('button', { name: 'Claim' }));
    await waitFor(() => expect(queueCalls(fake, 'claim')[0]?.args[1]).toEqual({ action: 'claim', id: ID('e') }));
    expect(await screen.findByRole('heading', { name: 'Front counter', level: 2 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument();
  });

  test('a ticket for a one-off session says there is no PC to open', async () => {
    const { user } = await openQueue([item({ device_id: null, device_name: null })]);
    await user.click(await screen.findByRole('button', { name: 'Claim' }));
    expect(await screen.findByText(/It was a one-off session that is over, so there is no PC to open/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Queue' })).toBeInTheDocument();
  });

  test('a live claim opens the session in a tab, and you are its driver', async () => {
    const fake = fakeCore();
    fake.state.claimLive = true;
    fake.state.sessions[SID] = { state: 'attached', driver: ME, machine: 'FRONT', log: [] };
    const { user } = await openQueue([item({ session_id: SID })], fake);
    await user.click(await screen.findByRole('button', { name: 'Claim' }));
    const tab = await screen.findByRole('tab', { name: /Front counter/, selected: true });
    expect(tab).toBeInTheDocument();
    expect(await screen.findByText('You are driving')).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('support.tabs'))).toEqual([expect.objectContaining({ key: SID, account: 'acc1', deviceId: ID('a'), sessionId: SID })]);
  });

  test('a live claim of a one-off session opens a tab without a PC id', async () => {
    const fake = fakeCore();
    fake.state.claimLive = true;
    fake.state.sessions[SID] = { state: 'attached', driver: ME, log: [] };
    const { user } = await openQueue([item({ session_id: SID, device_id: null, device_name: null })], fake);
    await user.click(await screen.findByRole('button', { name: 'Claim' }));
    expect(await screen.findByRole('tab', { name: /One-off PC/, selected: true })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('support.tabs'))[0].deviceId).toBeNull();
  });

  test('a claim someone else won first says so', async () => {
    const fake = fakeCore();
    fake.state.escalationCall = (args) => {
      if (args.action === 'claim') throw new ToolFail('lead@example.com has already claimed that item', 'already_claimed');
      return { escalations: [item()] };
    };
    const { user } = await openQueue([], fake);
    await user.click(await screen.findByRole('button', { name: 'Claim' }));
    expect(await screen.findByText('Someone else claimed that item first.')).toBeInTheDocument();
  });

  test('a live claim in an agent-mode team says why it was refused', async () => {
    const fake = fakeCore();
    fake.state.escalationCall = (args) => {
      if (args.action === 'claim') throw new ToolFail('mode: this team uses the built-in agent', 'mode');
      return { escalations: [item()] };
    };
    const { user } = await openQueue([], fake);
    await user.click(await screen.findByRole('button', { name: 'Claim' }));
    expect(await screen.findByText('This team uses the built-in agent only, so this is not available here.')).toBeInTheDocument();
  });

  test('Close asks for a note and records it, for the opener, the claimer or an admin only', async () => {
    const own = item({ id: ID('m'), note: 'Mine one', opened_by: ME });
    const { user, fake } = await openQueue([item(), own]);
    const list = await screen.findByRole('list', { name: 'Open' });
    // The lead's item cannot be closed by a technician who did not open or claim it.
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((r) => within(r).queryByRole('button', { name: 'Close' }) !== null)).toEqual([false, true]);
    await user.click(within(rows[1]).getByRole('button', { name: 'Close' }));
    const dialog = await screen.findByRole('dialog', { name: 'Close this queue item' });
    await user.click(within(dialog).getByLabelText('Closing note'));
    await user.paste('Sorted over the phone');
    await user.click(within(dialog).getByRole('button', { name: 'Close the item' }));
    await waitFor(() => expect(queueCalls(fake, 'close')[0]?.args[1]).toEqual({ action: 'close', id: ID('m'), note: 'Sorted over the phone' }));
    await waitFor(() => expect(screen.queryByText('Mine one')).not.toBeInTheDocument());
  });

  test('an admin can close any item', async () => {
    const fake = fakeCore();
    fake.state.permissions = [...fake.state.permissions, 'members.manage'];
    await openQueue([item()], fake);
    expect(await screen.findByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  test('open the PC, the task, and the session when it has a tab', async () => {
    const task = { id: ID('t'), state: 'finished', title: 'Fix', session_id: null, device_id: ID('a'), created_at: Date.now(), ended_at: Date.now(), phase: 'done', rev: 1, steps: [], notes: [] };
    const fake = fakeCore();
    fake.state.tasks = [task];
    localStorage.setItem('support.tabs', JSON.stringify([{ key: SID, account: 'acc1', deviceId: ID('a'), deviceName: 'Front counter', sessionId: SID, taskId: null }]));
    fake.state.sessions[SID] = { state: 'attached', driver: ME, log: [] };
    const { user } = await openQueue([item({ session_id: SID, task_id: ID('t'), kind: 'agent', summary: 'Stuck' })], fake);
    await screen.findByRole('list', { name: 'Open' });
    await user.click(screen.getByRole('button', { name: 'Open the session' }));
    expect(await screen.findByRole('tab', { name: /Front counter/, selected: true })).toBeInTheDocument();
    await user.click(nav('Queue'));
    await user.click(await screen.findByRole('button', { name: 'Open the task' }));
    expect(await screen.findByRole('heading', { name: 'Front counter', level: 2 })).toBeInTheDocument();
    await user.click(nav('Queue'));
    await user.click(await screen.findByRole('button', { name: 'Open the PC' }));
    expect(await screen.findByRole('heading', { name: 'Front counter', level: 2 })).toBeInTheDocument();
  });

  test('a role that cannot control sessions has no Queue item in the rail', async () => {
    const fake = fakeCore();
    fake.state.permissions = ['devices.view', 'sessions.view'];
    renderApp(fake);
    await screen.findByRole('button', { name: /Front counter/ });
    await sleep(60);
    expect(screen.queryByRole('button', { name: /^Queue/ })).not.toBeInTheDocument();
    expect(toolCalls(fake, 'escalation')).toHaveLength(0);
  });
});

describe('the Queue badge', () => {
  test('counts the open items, is read at the start and when the screen is shown, and not by a timer', async () => {
    const fake = fakeCore();
    fake.state.queue = [item(), item({ id: ID('f') }), item({ id: ID('g'), claimed_by: ME })];
    renderApp(fake);
    const badge = await screen.findByLabelText('2 open');
    expect(badge).toHaveTextContent('2');
    const reads = () => queueCalls(fake, 'list').length;
    const before = reads();
    await sleep(300);
    expect(reads()).toBe(before);
  });

  test('is read again when the relay says the queue changed, and a notification of another kind does not read it', async () => {
    const fake = fakeCore();
    fake.state.queue = [item()];
    renderApp(fake);
    await screen.findByLabelText('1 open');
    await waitFor(() => expect(fake.core.on).toHaveBeenCalledWith('feed://items', expect.any(Function)));
    const before = queueCalls(fake, 'list').length;
    fake.state.queue.push(item({ id: ID('f') }));
    const note = (id, event) => ({ account: 'acc1', live: true, items: [{ id, event, at: Date.now(), title: 'x', body: 'y', device_id: ID('a'), task_id: null, session_id: null }] });
    act(() => fake.emit('feed://items', note(1, 'device_online')));
    await sleep(60);
    expect(queueCalls(fake, 'list').length).toBe(before);
    act(() => fake.emit('feed://items', note(2, 'escalation_opened')));
    expect(await screen.findByLabelText('2 open')).toBeInTheDocument();
    // The backlog read at the start of the feed is not news.
    const after = queueCalls(fake, 'list').length;
    act(() => fake.emit('feed://items', { ...note(3, 'escalation_opened'), live: false }));
    await sleep(60);
    expect(queueCalls(fake, 'list').length).toBe(after);
  });

  test('shows nothing when the queue is empty and drops after a claim', async () => {
    const { user, fake } = await openQueue([item()]);
    await screen.findByLabelText('1 open');
    await user.click(await screen.findByRole('button', { name: 'Claim' }));
    await waitFor(() => expect(screen.queryByLabelText('1 open')).not.toBeInTheDocument());
    expect(fake.state.queue[0].claimed_by).toBe(ME);
  });
});

describe('the Queue screen reads again when someone else changes an item', () => {
  const mine = () => item({ claimed_by: ME, claimed_at: Date.now() - 60000 });
  const closeElsewhere = (fake) => { Object.assign(fake.state.queue[0], { closed_by: 'lead@example.com', closed_at: Date.now() }); };
  const openMine = async (tuning) => {
    const { user, fake } = await openQueue([mine()], fakeCore(), tuning);
    await user.click(await screen.findByRole('tab', { name: 'Mine' }));
    expect(await screen.findByText('Printer jams')).toBeInTheDocument();
    return { user, fake };
  };
  const SLOW = { ...FAST, queueMs: 600000 };
  const setVisibility = (state) => {
    Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
  };
  afterEach(() => setVisibility('visible'));

  test('on a timer while the screen is on show: an item another person closed leaves Mine', async () => {
    const { fake } = await openMine({ ...FAST, queueMs: 60 });
    closeElsewhere(fake);
    await waitFor(() => expect(screen.queryByText('Printer jams')).not.toBeInTheDocument());
  });

  test('not while the window is hidden, and at once when it is shown again', async () => {
    const { fake } = await openMine({ ...FAST, queueMs: 60 });
    setVisibility('hidden');
    await sleep(100);
    const frozen = queueCalls(fake, 'list').length;
    closeElsewhere(fake);
    await sleep(250);
    expect(queueCalls(fake, 'list').length).toBe(frozen);
    expect(screen.getByText('Printer jams')).toBeInTheDocument();
    setVisibility('visible');
    await waitFor(() => expect(screen.queryByText('Printer jams')).not.toBeInTheDocument());
  });

  test('when the window gets focus', async () => {
    const { fake } = await openMine(SLOW);
    closeElsewhere(fake);
    act(() => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(screen.queryByText('Printer jams')).not.toBeInTheDocument());
  });

  test('when a queue notice arrives', async () => {
    const { fake } = await openMine(SLOW);
    await waitFor(() => expect(fake.core.on).toHaveBeenCalledWith('feed://items', expect.any(Function)));
    closeElsewhere(fake);
    act(() => fake.emit('feed://items', { account: 'acc1', live: true, items: [{ id: 9, event: 'escalation_claimed', at: Date.now(), title: 'x', body: 'y', device_id: ID('a'), task_id: null, session_id: null }] }));
    await waitFor(() => expect(screen.queryByText('Printer jams')).not.toBeInTheDocument());
  });

  test('on the Open tab the badge takes its count from the list that is read, with no second request', async () => {
    const { fake } = await openQueue([item()], fakeCore(), SLOW);
    await screen.findByLabelText('1 open');
    await sleep(40);
    const before = queueCalls(fake, 'list').length;
    fake.state.queue.push(item({ id: ID('f') }));
    act(() => { window.dispatchEvent(new Event('focus')); });
    expect(await screen.findByLabelText('2 open')).toBeInTheDocument();
    await sleep(60);
    expect(queueCalls(fake, 'list').length - before).toBe(1);
  });

  test('with a slow timer and no event, nothing is read again', async () => {
    const { fake } = await openMine(SLOW);
    const before = queueCalls(fake, 'list').length;
    closeElsewhere(fake);
    await sleep(200);
    expect(queueCalls(fake, 'list').length).toBe(before);
    expect(screen.getByText('Printer jams')).toBeInTheDocument();
  });
});

describe('a live claim whose session step did not finish', () => {
  const LEAD = 'lead@example.com';
  // The claim committed on the relay (the item is the person's, the PC's record names them) but the session has not followed: busy.
  const halfDone = () => {
    const fake = fakeCore();
    fake.state.claimLive = true;
    fake.state.sessions[SID] = { state: 'attached', driver: LEAD, machine: 'FRONT', log: [] };
    let first = true;
    fake.state.escalationCall = (args) => {
      const out = escalationCall(fake.state, args);
      if (args.action === 'claim' && first) {
        first = false;
        throw new ToolFail('busy: control moved on the PC, but the session has not followed yet; repeat the same call', 'busy');
      }
      if (args.action === 'claim') fake.state.sessions[SID].driver = ME; // the repeated claim finishes the session step
      return out;
    };
    return fake;
  };

  test('right after the busy answer, the action to finish is offered, and pressing it completes the claim', async () => {
    const fake = halfDone();
    const { user } = await openQueue([item({ session_id: SID, opened_by: LEAD })], fake);
    await user.click(await screen.findByRole('button', { name: 'Claim' }));
    expect(await screen.findByText('Control is being handed over right now. Try again in a moment.')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Finish taking control' }));
    expect(await screen.findByRole('tab', { name: /Front counter/, selected: true })).toBeInTheDocument();
    expect(queueCalls(fake, 'claim')).toHaveLength(2);
    expect(await screen.findByText('You are driving')).toBeInTheDocument();
  });

  test('on Mine, only an item the relay marks finish_pending has the action; a claimed item with a live session but no mark does not', async () => {
    const fake = halfDone();
    const claimed = (over) => item({ opened_by: LEAD, claimed_by: ME, claimed_at: Date.now() - 1000, ...over });
    // Both sessions are live and driven by the sender; only the first is the half-finished state the relay marks.
    fake.state.sessions['z'.repeat(64)] = { state: 'attached', driver: LEAD, log: [] };
    const half = claimed({ session_id: SID, note: 'Half done', finish_pending: true });
    const handedBack = claimed({ id: ID('f'), session_id: 'z'.repeat(64), note: 'Handed back' });
    const { user } = await openQueue([half, handedBack], fake);
    await user.click(await screen.findByRole('tab', { name: 'Mine' }));
    const li = (await screen.findByText('Half done')).closest('li');
    expect(within(li).getByRole('button', { name: 'Finish taking control' })).toBeInTheDocument();
    expect(within((await screen.findByText('Handed back')).closest('li')).queryByRole('button', { name: 'Finish taking control' })).not.toBeInTheDocument();
    expect(within(li).queryByRole('button', { name: 'Claim' })).not.toBeInTheDocument();
    await user.click(within(li).getByRole('button', { name: 'Finish taking control' }));
    await waitFor(() => expect(queueCalls(fake, 'claim')[0]?.args[1]).toEqual({ action: 'claim', id: ID('e') }));
  });
});
