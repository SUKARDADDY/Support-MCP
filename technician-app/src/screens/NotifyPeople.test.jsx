// Invites, offers of control and queue notices: what clicking them opens, and the settings.
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test } from 'vitest';
import { ID, fakeCore, renderApp } from '../test-utils.jsx';

const SID = 'n'.repeat(64);
const ME = 'tech@example.com';
const LEAD = 'lead@example.com';
const toolCalls = (fake, name) => fake.calls.filter((c) => c.kind === 'tool' && c.args[0] === name);
const person = (identity, role, name = null) => ({ identity, name, role, since: Date.now() - 30000 });
afterEach(() => localStorage.clear());

const note = (over) => ({ account: 'acc1', event: 'session_invited', device_id: ID('a'), task_id: null, session_id: SID, ...over });
const invitedSession = (extra = {}) => ({ state: 'attached', driver: LEAD, machine: 'FRONT', log: [], participants: [person(LEAD, 'driver', 'Lee Lead'), person(ME, 'invited', 'Tess Tech')], ...extra });

async function start(fake) {
  renderApp(fake);
  await screen.findByRole('button', { name: /Front counter/ });
  await waitFor(() => expect(fake.core.on).toHaveBeenCalledWith('ui://open', expect.any(Function)));
}

describe('clicking an invite', () => {
  test('opens the session and joins it, even with no tab yet', async () => {
    const fake = fakeCore();
    fake.state.sessions[SID] = invitedSession();
    await start(fake);
    act(() => fake.emit('ui://open', note()));
    const tab = await screen.findByRole('tab', { name: /Front counter/, selected: true });
    expect(tab).toBeInTheDocument();
    await waitFor(() => expect(toolCalls(fake, 'session_participants')).toHaveLength(1));
    expect(toolCalls(fake, 'session_participants')[0].args[1]).toEqual({ session_id: SID, action: 'join' });
    expect(await screen.findByRole('button', { name: 'Leave' })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('support.tabs'))[0]).toMatchObject({ key: SID, account: 'acc1', deviceId: ID('a'), guest: true, joinOnOpen: false });
  });

  test('a one-off session\'s invite has no PC and opens a tab all the same', async () => {
    const fake = fakeCore();
    fake.state.sessions[SID] = invitedSession();
    await start(fake);
    act(() => fake.emit('ui://open', note({ device_id: null })));
    expect(await screen.findByRole('tab', { name: /One-off PC/, selected: true })).toBeInTheDocument();
    await waitFor(() => expect(toolCalls(fake, 'session_participants')).toHaveLength(1));
    expect(JSON.parse(localStorage.getItem('support.tabs'))[0].deviceId).toBeNull();
  });

  test('with a tab already open, it shows the tab and joins', async () => {
    const fake = fakeCore();
    fake.state.sessions[SID] = invitedSession();
    localStorage.setItem('support.tabs', JSON.stringify([{ key: SID, account: 'acc1', deviceId: ID('a'), deviceName: 'Front counter', sessionId: SID, taskId: null }]));
    await start(fake);
    expect(screen.getByRole('tab', { name: 'Devices', selected: true })).toBeInTheDocument();
    act(() => fake.emit('ui://open', note()));
    expect(await screen.findByRole('tab', { name: /Front counter/, selected: true })).toBeInTheDocument();
    await waitFor(() => expect(toolCalls(fake, 'session_participants')).toHaveLength(1));
    expect(screen.getAllByRole('tab')).toHaveLength(2);
  });

  test('an invite for an ended session opens a tab that says so and calls nothing to join', async () => {
    const fake = fakeCore();
    fake.state.sessions[SID] = { state: 'ended', ended_reason: 'owner', log: [] };
    await start(fake);
    act(() => fake.emit('ui://open', note()));
    expect(await screen.findByText('The session ended.')).toBeInTheDocument();
    expect(toolCalls(fake, 'session_participants')).toHaveLength(0);
  });
});

describe('clicking an offer of control', () => {
  test('opens the session with the offer on top, and takes nothing for you', async () => {
    const fake = fakeCore();
    fake.state.sessions[SID] = invitedSession({ participants: [person(LEAD, 'driver', 'Lee Lead'), person(ME, 'watcher', 'Tess Tech')], offer: { to: ME, by: LEAD, expires_at: Date.now() + 90000 } });
    await start(fake);
    act(() => fake.emit('ui://open', note({ event: 'control_offered' })));
    expect(await screen.findByRole('tab', { name: /Front counter/, selected: true })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Take control' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Not now' })).toBeInTheDocument();
    expect(toolCalls(fake, 'session_handover')).toHaveLength(0);
    expect(toolCalls(fake, 'session_participants')).toHaveLength(0);
    // Closing that tab leaves the session and never ends it: it is the other person's session.
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Leave the session with Front counter' }));
    await waitFor(() => expect(toolCalls(fake, 'session_participants')).toHaveLength(1));
    expect(toolCalls(fake, 'session_end')).toHaveLength(0);
  });
});

describe('clicking a queue notice', () => {
  test.each(['escalation_opened', 'escalation_claimed'])('%s opens the Queue', async (event) => {
    const fake = fakeCore();
    fake.state.queue = [{ id: ID('e'), kind: 'technician', device_id: ID('a'), device_name: 'Front counter', session_id: null, task_id: null, summary: null, note: 'Printer jams', opened_by: LEAD, opened_at: Date.now(), claimed_by: null, claimed_at: null, closed_by: null, closed_at: null, close_note: null }];
    await start(fake);
    act(() => fake.emit('ui://open', note({ event, session_id: null })));
    expect(await screen.findByRole('heading', { name: 'Queue' })).toBeInTheDocument();
    expect(await screen.findByText('Printer jams')).toBeInTheDocument();
  });

  test('a queue notice from the other team switches to it and opens its Queue', async () => {
    const SECOND = { id: 'acc2', relay: 'https://relay.example', team: 'acme', team_name: 'Acme Support', email: ME, signed_in: true };
    const fake = fakeCore({ accounts: [{ id: 'acc1', relay: 'https://relay.example', team: 'default', team_name: 'Default', email: ME, signed_in: true }, SECOND] });
    await start(fake);
    act(() => fake.emit('ui://open', note({ account: 'acc2', event: 'escalation_opened', session_id: null })));
    expect(await screen.findByRole('heading', { name: 'Queue' })).toBeInTheDocument();
    await waitFor(() => expect(fake.core.tool.mock.calls.some((m) => m[0] === 'acc2' && m[1] === 'escalation' && m[2].action === 'list')).toBe(true));
  });
});

describe('the notification list', () => {
  const feedItem = (id, event, over = {}) => ({ account: 'acc1', live: true, items: [{ id, event, at: Date.now(), title: `Title ${id}`, body: `Body ${id}`, device_id: ID('a'), task_id: null, session_id: null, ...over }] });

  test('each kind of item has the button that fits it', async () => {
    const user = userEvent.setup();
    const fake = fakeCore();
    fake.state.sessions[SID] = invitedSession();
    await start(fake);
    act(() => {
      fake.emit('feed://items', feedItem(1, 'session_invited', { session_id: SID }));
      fake.emit('feed://items', feedItem(2, 'control_offered', { session_id: SID }));
      fake.emit('feed://items', feedItem(3, 'escalation_opened'));
      fake.emit('feed://items', feedItem(4, 'device_online'));
    });
    await user.click(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('button', { name: /Notifications/ }));
    const list = await screen.findByRole('list', { name: 'Recent' });
    const buttonOf = (title) => within(within(list).getByText(title).closest('li')).getByRole('button').textContent;
    expect(buttonOf('Title 1')).toBe('Join the session');
    expect(buttonOf('Title 2')).toBe('Open the session');
    expect(buttonOf('Title 3')).toBe('Open the queue');
    expect(buttonOf('Title 4')).toBe('Open the PC');
    await user.click(within(within(list).getByText('Title 3').closest('li')).getByRole('button'));
    expect(await screen.findByRole('heading', { name: 'Queue' })).toBeInTheDocument();
  });

  test('a Windows notification click carries the event, and one without it still opens the PC', async () => {
    const fake = fakeCore();
    await start(fake);
    act(() => fake.emit('ui://open', { account: 'acc1', device_id: ID('b'), task_id: null, session_id: null }));
    expect(await screen.findByRole('heading', { name: 'Back office', level: 2 })).toBeInTheDocument();
  });
});

describe('notification settings', () => {
  test('the two queue events can be switched, and invites, offers and approvals have no switch', async () => {
    const user = userEvent.setup();
    const fake = fakeCore();
    renderApp(fake);
    await screen.findByRole('button', { name: /Front counter/ });
    await user.click(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('button', { name: /Notifications/ }));
    await user.click(screen.getByRole('tab', { name: 'Settings' }));
    const sent = await screen.findByRole('checkbox', { name: /Something was sent to the queue/ });
    expect(sent).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Your queue item was claimed/ })).toBeChecked();
    expect(screen.getByText('Invites to a session, offers of control and actions waiting for your approval always reach you. They have no switch.')).toBeInTheDocument();
    // An action waiting for your approval is listed as always on: checked, and no way to switch it off.
    const approval = screen.getByRole('checkbox', { name: /An action waits for your approval/ });
    expect(approval).toBeChecked();
    expect(approval).toBeDisabled();
    expect(screen.queryByRole('checkbox', { name: /invite/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /offer/i })).not.toBeInTheDocument();
    await user.click(sent);
    await waitFor(() => expect(fake.state.patches).toEqual([{ events: { escalation_opened: false } }]));
  });
});
