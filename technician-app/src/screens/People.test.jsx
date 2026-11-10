// The people in a session: the roster, Invite, Hand over, Remove, the offer banner, Leave for
// watchers, the watcher's picture, Escalate, and a one-off link's tab.
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test } from 'vitest';
import { FAST, ID, ToolFail, fakeCore, renderApp } from '../test-utils.jsx';

const SID = 's'.repeat(64);
const ME = 'tech@example.com';
const LEAD = 'lead@example.com';
const sleep = (ms) => act(() => new Promise((r) => setTimeout(r, ms)));
const toolCalls = (fake, name) => fake.calls.filter((c) => c.kind === 'tool' && c.args[0] === name);
const requests = (fake, path) => fake.calls.filter((c) => c.kind === 'request' && c.args[1] === path);
afterEach(() => localStorage.clear());

const person = (identity, role, name = null) => ({ identity, name, role, since: Date.now() - 30000 });
const OTHER_TAB = { key: SID, account: 'acc1', deviceId: ID('a'), deviceName: 'Front counter', sessionId: SID, taskId: null };

// A session tab from the last run. `session` is what the relay says about it.
async function open(session = {}, { fake = fakeCore(), tab = {}, permissions, tuning } = {}) {
  localStorage.setItem('support.tabs', JSON.stringify([{ ...OTHER_TAB, ...tab }]));
  if (permissions) fake.state.permissions = permissions;
  fake.state.sessions[SID] = { state: 'attached', driver: ME, machine: 'FRONT', log: [], ...session };
  const view = renderApp(fake, tuning);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('tab', { name: new RegExp(tab.deviceName ?? 'Front counter') }));
  return { ...view, user, fake };
}
const asDriver = (extra = {}) => ({ driver: ME, participants: [person(ME, 'driver', 'Tess Tech'), person('wat@example.com', 'watcher', 'Wat Watcher'), person('inv@example.com', 'invited')], ...extra });
const asWatcher = (extra = {}) => ({ driver: LEAD, participants: [person(LEAD, 'driver', 'Lee Lead'), person(ME, 'watcher', 'Tess Tech')], ...extra });

describe('the roster', () => {
  test('lists the driver, the watchers and the invited, with what each is, and marks you', async () => {
    await open(asDriver());
    const roster = await screen.findByRole('region', { name: 'People in this session' });
    expect(within(roster).getByText('Tess Tech (you)')).toBeInTheDocument();
    expect(within(roster).getByText('Wat Watcher')).toBeInTheDocument();
    expect(within(roster).getByText('inv@example.com')).toBeInTheDocument();
    expect(within(roster).getByText('Driving')).toBeInTheDocument();
    expect(within(roster).getByText('Watching')).toBeInTheDocument();
    expect(within(roster).getByText('Invited, not joined yet')).toBeInTheDocument();
  });

  test('names from the team are shown as text, never as markup', async () => {
    await open({ driver: ME, participants: [person(ME, 'driver', '<img src=x onerror=alert(1)>')] });
    const roster = await screen.findByRole('region', { name: 'People in this session' });
    expect(roster.querySelector('img')).toBeNull();
    expect(within(roster).getByText(/<img src=x/)).toBeInTheDocument();
  });
});

describe('the driver: Invite, Hand over, Remove, Escalate', () => {
  test('Invite lists the people who can control sessions and are not in it yet, and invites one', async () => {
    const { user, fake } = await open(asDriver());
    await user.click(await screen.findByRole('button', { name: 'Invite' }));
    const dialog = await screen.findByRole('dialog', { name: 'Invite a colleague' });
    // Tess is you, Wat and Inv are in it, the viewer cannot control sessions: only Lee is left.
    expect(await within(dialog).findByLabelText(/Lee Lead/)).toBeInTheDocument();
    expect(within(dialog).queryByLabelText(/viewer@example.com/)).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText(/Tess Tech/)).not.toBeInTheDocument();
    expect(within(dialog).getAllByRole('radio')).toHaveLength(1);
    expect(within(dialog).getByRole('button', { name: 'Invite' })).toBeDisabled();
    await user.click(within(dialog).getByLabelText(/Lee Lead/));
    await user.click(within(dialog).getByRole('button', { name: 'Invite' }));
    await waitFor(() => expect(toolCalls(fake, 'session_participants')).toHaveLength(1));
    expect(toolCalls(fake, 'session_participants')[0].args).toEqual(['session_participants', { session_id: SID, action: 'invite', identity: LEAD }]);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Invite a colleague' })).not.toBeInTheDocument());
    expect(within(screen.getByRole('region', { name: 'People in this session' })).getByText('Lee Lead')).toBeInTheDocument();
    expect(await screen.findByText('Invited Lee Lead.')).toBeInTheDocument();
  });

  test('a refused invite says why in the app\'s words and keeps the dialog open', async () => {
    const fake = fakeCore();
    fake.state.participantsCall = () => { throw new ToolFail('needs_unattended: lead@example.com may not connect without asking', 'needs_unattended'); };
    const { user } = await open(asDriver(), { fake });
    await user.click(await screen.findByRole('button', { name: 'Invite' }));
    const dialog = await screen.findByRole('dialog', { name: 'Invite a colleague' });
    await user.click(await within(dialog).findByLabelText(/Lee Lead/));
    await user.click(within(dialog).getByRole('button', { name: 'Invite' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('This PC was connected without asking its owner. Only people allowed to connect without asking can join.');
  });

  test.each([
    ['not_driver', 'Only the person driving the session can do that.'],
    ['not_attached', 'The PC has not let the session in yet. Try again when the session shows Connected.'],
    ['mode', 'This team uses the built-in agent only, so this is not available here.'],
    ['cannot_control', 'Only people whose role can control sessions can do that.'],
    ['second_factor', 'Sign in again with your authenticator code to do this.'],
    ['offer_pending', 'An offer of control to someone else is still open. Cancel it first, or wait until it runs out.'],
    ['busy', 'Something else is in progress on this session, such as control being handed over or another action waiting for approval. Try again in a moment.'],
  ])('a %s refusal reads as the app\'s sentence', async (code, text) => {
    const fake = fakeCore();
    fake.state.participantsCall = () => { throw new ToolFail(`${code}: the relay's own words`, code); };
    const { user } = await open(asDriver(), { fake });
    await user.click(await screen.findByRole('button', { name: 'Remove Wat Watcher from the session' }));
    expect(await screen.findByText(text)).toBeInTheDocument();
  });

  test('a refusal that says the session is gone refreshes the status at once, and the tab shows it ended', async () => {
    const fake = fakeCore();
    fake.state.participantsCall = () => { fake.state.sessions[SID].state = 'ended'; throw new ToolFail('not_found: no such live session', 'not_found'); };
    const { user } = await open(asDriver(), { fake, tuning: { ...FAST, statusMs: 60000 } });
    await user.click(await screen.findByRole('button', { name: 'Remove Wat Watcher from the session' }));
    expect(await screen.findByText('Ended')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'End session' })).not.toBeInTheDocument();
  });

  test('an error with no code (a lost second factor) shows the relay\'s own text', async () => {
    const fake = fakeCore();
    fake.state.participantsCall = () => { throw new ToolFail('a second factor is required'); };
    const { user } = await open(asDriver(), { fake });
    await user.click(await screen.findByRole('button', { name: 'Remove Wat Watcher from the session' }));
    expect(await screen.findByText('a second factor is required')).toBeInTheDocument();
  });

  test('Remove takes one person off the session', async () => {
    const { user, fake } = await open(asDriver());
    await user.click(await screen.findByRole('button', { name: 'Remove Wat Watcher from the session' }));
    await waitFor(() => expect(toolCalls(fake, 'session_participants')[0]?.args[1]).toEqual({ session_id: SID, action: 'remove', identity: 'wat@example.com' }));
    await waitFor(() => expect(screen.queryByText('Wat Watcher')).not.toBeInTheDocument());
    // The driver has no Remove for themselves.
    expect(screen.queryByRole('button', { name: /Remove Tess/ })).not.toBeInTheDocument();
  });

  test('Hand over lists only the people watching, and the offer shows with Cancel', async () => {
    const { user, fake } = await open(asDriver());
    await user.click(await screen.findByRole('button', { name: 'Hand over' }));
    const dialog = await screen.findByRole('dialog', { name: 'Hand over control' });
    expect(within(dialog).getAllByRole('radio')).toHaveLength(1);
    await user.click(within(dialog).getByLabelText(/Wat Watcher/));
    await user.click(within(dialog).getByRole('button', { name: 'Offer control' }));
    await waitFor(() => expect(toolCalls(fake, 'session_handover')[0]?.args[1]).toEqual({ session_id: SID, action: 'offer', identity: 'wat@example.com' }));
    expect(await screen.findByText(/You offered control to Wat Watcher\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hand over' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Cancel the offer' }));
    await waitFor(() => expect(toolCalls(fake, 'session_handover')[1]?.args[1]).toEqual({ session_id: SID, action: 'cancel' }));
    await waitFor(() => expect(screen.queryByText(/You offered control/)).not.toBeInTheDocument());
  });

  test('Hand over with nobody watching says to invite someone first', async () => {
    const { user } = await open({ driver: ME, participants: [person(ME, 'driver', 'Tess Tech'), person('inv@example.com', 'invited')] });
    await user.click(await screen.findByRole('button', { name: 'Hand over' }));
    const dialog = await screen.findByRole('dialog', { name: 'Hand over control' });
    expect(within(dialog).getByText('Nobody is watching yet. Invite a colleague first.')).toBeInTheDocument();
    expect(within(dialog).queryAllByRole('radio')).toHaveLength(0);
  });

  test('Escalate sends the note to the queue', async () => {
    const { user, fake } = await open(asDriver());
    await user.click(await screen.findByRole('button', { name: 'Escalate' }));
    const dialog = await screen.findByRole('dialog', { name: 'Send to the queue' });
    await user.click(within(dialog).getByLabelText('Note for the next person'));
    await user.paste('Printer still fails after the driver reinstall');
    await user.click(within(dialog).getByRole('button', { name: 'Send to the queue' }));
    await waitFor(() => expect(toolCalls(fake, 'escalation').filter((c) => c.args[1].action === 'open')).toHaveLength(1));
    expect(toolCalls(fake, 'escalation').find((c) => c.args[1].action === 'open').args[1]).toEqual({ action: 'open', session_id: SID, note: 'Printer still fails after the driver reinstall' });
    expect(await screen.findByText('Sent to the queue.')).toBeInTheDocument();
  });

  test('a watcher and an invitee have none of these buttons', async () => {
    await open(asWatcher());
    await screen.findByText('Lee Lead');
    for (const name of ['Invite', 'Hand over', 'Escalate']) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Remove/ })).not.toBeInTheDocument();
  });
});

describe('an offer of control', () => {
  const offered = () => asWatcher({ offer: { to: ME, by: LEAD, expires_at: Date.now() + 90000 } });

  test('shows Take control and Not now to the person it was made to', async () => {
    const { user, fake } = await open(offered());
    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent('Lee Lead offered you control of this session.');
    await user.click(within(banner).getByRole('button', { name: 'Take control' }));
    await waitFor(() => expect(toolCalls(fake, 'session_handover')[0]?.args[1]).toEqual({ session_id: SID, action: 'accept' }));
    expect(await screen.findByText('You are driving this session now.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Take control' })).not.toBeInTheDocument());
    // The new driver can invite and hand over, and the old driver now watches.
    expect(await screen.findByRole('button', { name: 'Invite' })).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'People in this session' })).getByText('Watching')).toBeInTheDocument();
  });

  test('Not now declines it', async () => {
    const { user, fake } = await open(offered());
    await user.click(await screen.findByRole('button', { name: 'Not now' }));
    await waitFor(() => expect(toolCalls(fake, 'session_handover')[0]?.args[1]).toEqual({ session_id: SID, action: 'decline' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Take control' })).not.toBeInTheDocument());
  });

  test('a refused accept shows the needs_unattended sentence', async () => {
    const fake = fakeCore();
    fake.state.handoverCall = () => { throw new ToolFail('needs_unattended: you may not connect without asking', 'needs_unattended'); };
    const { user } = await open(offered(), { fake });
    await user.click(await screen.findByRole('button', { name: 'Take control' }));
    expect(await screen.findByText('This PC was connected without asking its owner. Only people allowed to connect without asking can join.')).toBeInTheDocument();
  });

  test('an offer that has run out is not shown, and one for someone else is not shown to you', async () => {
    await open(asWatcher({ offer: { to: ME, by: LEAD, expires_at: Date.now() - 1000 } }));
    await screen.findByText('Lee Lead');
    expect(screen.queryByRole('button', { name: 'Take control' })).not.toBeInTheDocument();
    expect(screen.queryByText(/offered you control/)).not.toBeInTheDocument();
  });

  test('a second pending offer answers already_claimed in the app\'s words', async () => {
    const fake = fakeCore();
    fake.state.handoverCall = () => { throw new ToolFail('already_claimed: another offer is pending', 'already_claimed'); };
    const { user } = await open(offered(), { fake });
    await user.click(await screen.findByRole('button', { name: 'Take control' }));
    expect(await screen.findByText('Someone else claimed that item first.')).toBeInTheDocument();
  });
});

describe('a watcher', () => {
  const frameAt = (rev, at = Date.now() - 12000) => ({ rev, at, mime: 'image/jpeg', data: 'QUJD' });

  test('sees Leave instead of End session, and closing the tab leaves without ending the session', async () => {
    const { user, fake } = await open(asWatcher());
    expect(await screen.findByRole('button', { name: 'Leave' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'End session' })).not.toBeInTheDocument();
    const close = screen.getByRole('button', { name: 'Leave the session with Front counter' });
    await user.click(close);
    await waitFor(() => expect(toolCalls(fake, 'session_participants')[0]?.args[1]).toEqual({ session_id: SID, action: 'leave' }));
    await waitFor(() => expect(screen.queryByRole('tab', { name: /Front counter/ })).not.toBeInTheDocument());
    expect(toolCalls(fake, 'session_end')).toHaveLength(0);
    expect(JSON.parse(localStorage.getItem('support.tabs'))).toEqual([]);
  });

  test('the Leave button leaves and never ends', async () => {
    const { user, fake } = await open(asWatcher());
    await user.click(await screen.findByRole('button', { name: 'Leave' }));
    await waitFor(() => expect(toolCalls(fake, 'session_participants')).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole('tab', { name: /Front counter/ })).not.toBeInTheDocument());
    expect(toolCalls(fake, 'session_end')).toHaveLength(0);
  });

  test('a leave the relay refuses keeps the tab and says why', async () => {
    const fake = fakeCore();
    fake.state.participantsCall = () => { throw new ToolFail('this workspace is stopped', 'stopped'); };
    const { user } = await open(asWatcher(), { fake });
    await user.click(await screen.findByRole('button', { name: 'Leave' }));
    expect(await screen.findByText('this workspace is stopped')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Front counter/ })).toBeInTheDocument();
  });

  test('shows the last picture with its age, fetched only when frame_rev changes', async () => {
    const fake = fakeCore();
    fake.state.sessionFrame = () => frameAt(1);
    const { fake: f } = await open(asWatcher({ frame_rev: 1, frame_at: Date.now() - 12000 }), { fake });
    const img = await screen.findByRole('img', { name: 'Screen of Front counter' });
    expect(img.getAttribute('src')).toBe('data:image/jpeg;base64,QUJD');
    expect(await screen.findByText(/^Picture from 1[2-5] s ago$/)).toBeInTheDocument();
    expect(requests(f, `/api/sessions/${SID}/frame`)).toHaveLength(1);
    // Several status reads later with the same frame_rev: still one fetch, and no screenshot of its own.
    await sleep(200);
    expect(requests(f, `/api/sessions/${SID}/frame`)).toHaveLength(1);
    expect(toolCalls(f, 'screenshot')).toHaveLength(0);
    // The driver took another picture.
    fake.state.sessionFrame = () => frameAt(2, Date.now() - 3000);
    fake.state.sessions[SID].frame_rev = 2;
    await waitFor(() => expect(requests(f, `/api/sessions/${SID}/frame`)).toHaveLength(2));
    expect(await screen.findByText(/^Picture from [3-6] s ago$/)).toBeInTheDocument();
  });

  test('a session with no picture yet says so and asks again later', async () => {
    const fake = fakeCore();
    let ready = false;
    fake.state.sessionFrame = () => { if (!ready) throw Object.assign(new Error('no picture'), { code: 'no_frame', status: 404 }); return frameAt(1); };
    const { fake: f } = await open(asWatcher({ frame_rev: 1 }), { fake });
    expect(await screen.findByText(/No picture yet/)).toBeInTheDocument();
    await waitFor(() => expect(requests(f, `/api/sessions/${SID}/frame`).length).toBeGreaterThanOrEqual(2));
    ready = true;
    expect(await screen.findByRole('img', { name: 'Screen of Front counter' })).toBeInTheDocument();
  });

  test('a refusal of the picture is told in the app\'s words', async () => {
    const fake = fakeCore();
    fake.state.sessionFrame = () => { throw Object.assign(new Error('forbidden'), { code: 'needs_unattended', status: 403 }); };
    await open(asWatcher({ frame_rev: 1 }), { fake });
    expect(await screen.findByText(/This PC was connected without asking its owner/)).toBeInTheDocument();
  });

  test('does not follow the driver\'s agent task', async () => {
    const fake = fakeCore();
    fake.state.tasks = [{ id: ID('t'), state: 'running', title: 'Fix', session_id: SID, device_id: ID('a'), created_at: Date.now(), ended_at: null, phase: 'working', rev: 1, steps: [], notes: [] }];
    const { fake: f } = await open(asWatcher(), { fake });
    await screen.findByText('Lee Lead');
    await sleep(150);
    expect(requests(f, `/api/agent/tasks/${ID('t')}/frame`)).toHaveLength(0);
    expect(f.calls.filter((c) => c.kind === 'request' && String(c.args[1]).startsWith('/api/agent/tasks/')).length).toBe(0);
  });
});

describe('a session you were invited to', () => {
  const invited = (extra = {}) => ({ driver: LEAD, participants: [person(LEAD, 'driver', 'Lee Lead'), person(ME, 'invited', 'Tess Tech')], ...extra });

  test('shows Join, which joins you as a watcher', async () => {
    const { user, fake } = await open(invited());
    expect(await screen.findByText(/Lee Lead invited you to watch this session/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Join' }));
    await waitFor(() => expect(toolCalls(fake, 'session_participants')[0]?.args[1]).toEqual({ session_id: SID, action: 'join' }));
    expect(await screen.findByText('You joined the session.')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Leave' })).toBeInTheDocument();
  });

  test('closing the tab before joining just closes it, and never ends the session', async () => {
    const { user, fake } = await open(invited(), { tab: { guest: true } });
    await screen.findByRole('button', { name: 'Join' });
    await user.click(screen.getByRole('button', { name: 'Close the tab for Front counter' }));
    await waitFor(() => expect(screen.queryByRole('tab', { name: /Front counter/ })).not.toBeInTheDocument());
    expect(toolCalls(fake, 'session_end')).toHaveLength(0);
    expect(toolCalls(fake, 'session_participants')).toHaveLength(0);
  });

  test('a tab saved for an invite with joinOnOpen joins on its own', async () => {
    const { fake } = await open(invited(), { tab: { guest: true, joinOnOpen: true } });
    await waitFor(() => expect(toolCalls(fake, 'session_participants')).toHaveLength(1));
    expect(toolCalls(fake, 'session_participants')[0].args[1].action).toBe('join');
    await sleep(100);
    expect(toolCalls(fake, 'session_participants')).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem('support.tabs'))[0].joinOnOpen).toBe(false);
  });

  test('a guest tab that is not the driver\'s closes without ending the session', async () => {
    const { user, fake } = await open({ driver: LEAD, participants: [person(LEAD, 'driver', 'Lee Lead')] }, { tab: { guest: true } });
    await screen.findByText('Lee Lead');
    await user.click(screen.getByRole('button', { name: 'Close tab' }));
    await waitFor(() => expect(screen.queryByRole('tab', { name: /Front counter/ })).not.toBeInTheDocument());
    expect(toolCalls(fake, 'session_end')).toHaveLength(0);
  });
});

describe('the driver\'s tab still ends the session', () => {
  test('End session and the tab close end it for everyone', async () => {
    const { user, fake } = await open(asDriver());
    await screen.findByRole('region', { name: 'People in this session' });
    expect(screen.queryByRole('button', { name: 'Leave' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'End session with Front counter' }));
    await waitFor(() => expect(toolCalls(fake, 'session_end')).toHaveLength(1));
  });
});

describe('a tab ends the session only when the relay says its person drives it now', () => {
  const noEnd = (fake) => expect(toolCalls(fake, 'session_end')).toHaveLength(0);
  const closeTabBar = async (user) => user.click(await screen.findByRole('button', { name: /^(End session with|Close the tab for) Front counter$/ }));

  test('after handing over and being removed, the old driver\'s tab only closes (A)', async () => {
    const { user, fake } = await open({ driver: LEAD, participants: [person(LEAD, 'driver', 'Lee Lead')] });
    await screen.findByText('Lee Lead');
    expect(screen.queryByRole('button', { name: 'End session' })).not.toBeInTheDocument();
    await closeTabBar(user);
    await waitFor(() => expect(screen.queryByRole('tab', { name: /Front counter/ })).not.toBeInTheDocument());
    noEnd(fake);
  });

  test('a restored tab whose status has not been read yet asks the relay, finds another driver, and only closes (B)', async () => {
    const fake = fakeCore();
    fake.state.sessionStatus = (args) => (args.log_tail === 60 ? new Promise(() => {}) : { state: 'attached', driver: LEAD, log: [] });
    const { user } = await open({}, { fake });
    await closeTabBar(user);
    await waitFor(() => expect(screen.queryByRole('tab', { name: /Front counter/ })).not.toBeInTheDocument());
    noEnd(fake);
  });

  test('a tab whose status cannot be read only closes', async () => {
    const fake = fakeCore();
    fake.state.sessionStatus = () => { throw new ToolFail('could not reach that session', 'unavailable'); };
    const { user } = await open({}, { fake });
    await closeTabBar(user);
    await waitFor(() => expect(screen.queryByRole('tab', { name: /Front counter/ })).not.toBeInTheDocument());
    noEnd(fake);
  });

  test('right after the offer is accepted, before the tab has polled, the old driver\'s End session only closes (C)', async () => {
    const fake = fakeCore();
    // The tab's own poll (a 60-line log) still says the person drives; the fresh read the click makes says who does now.
    fake.state.sessionStatus = (args) => (args.log_tail === 60 ? { state: 'attached', driver: ME, ...asDriver(), log: [] } : { state: 'attached', driver: LEAD, log: [] });
    const { user } = await open({}, { fake });
    await screen.findByRole('region', { name: 'People in this session' });
    await user.click(screen.getByRole('button', { name: 'End session' }));
    await waitFor(() => expect(screen.queryByRole('tab', { name: /Front counter/ })).not.toBeInTheDocument());
    noEnd(fake);
  });

  test('the driver ends it, and so does the host of a one-off session that has no driver; a guest does not', async () => {
    const mine = await open(asDriver());
    await screen.findByRole('region', { name: 'People in this session' });
    await mine.user.click(screen.getByRole('button', { name: 'End session' }));
    await waitFor(() => expect(toolCalls(mine.fake, 'session_end')).toHaveLength(1));
    mine.unmount();
    localStorage.clear();
    const legacy = await open({ driver: null }, { tab: { deviceId: null, deviceName: 'One-off PC' } });
    await legacy.user.click(await screen.findByRole('button', { name: 'End session' }));
    await waitFor(() => expect(toolCalls(legacy.fake, 'session_end')).toHaveLength(1));
    legacy.unmount();
    localStorage.clear();
    const guest = await open({ driver: null }, { tab: { deviceId: null, deviceName: 'One-off PC', guest: true } });
    await guest.user.click(await screen.findByRole('button', { name: 'Close tab' }));
    await waitFor(() => expect(screen.queryByRole('tab', { name: /One-off PC/ })).not.toBeInTheDocument());
    noEnd(guest.fake);
  });
});

describe('a session with no PC (a one-off link)', () => {
  const oneOff = { key: SID, account: 'acc1', deviceId: null, deviceName: 'One-off PC', sessionId: SID, taskId: null };

  test('a tab without a deviceId takes pictures, shows the roster and invites', async () => {
    localStorage.setItem('support.tabs', JSON.stringify([oneOff]));
    const fake = fakeCore();
    fake.state.sessions[SID] = { state: 'attached', driver: ME, machine: 'PRINT-PC', log: [], participants: [person(ME, 'driver', 'Tess Tech')] };
    renderApp(fake);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: /One-off PC/ }));
    expect(await screen.findByRole('img', { name: 'Screen of One-off PC' })).toBeInTheDocument();
    expect(screen.getByText('You are driving')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Invite' }));
    await user.click(await screen.findByLabelText(/Lee Lead/));
    await user.click(within(screen.getByRole('dialog', { name: 'Invite a colleague' })).getByRole('button', { name: 'Invite' }));
    await waitFor(() => expect(toolCalls(fake, 'session_participants')).toHaveLength(1));
    // No PC id, so none is sent anywhere.
    expect(JSON.stringify(fake.calls)).not.toContain('"device_id":null');
  });

  test.each(['pending', 'consumed', 'waiting', 'attached'])('a link tab whose session is %s is still there after a restart', async (state) => {
    localStorage.setItem('support.tabs', JSON.stringify([oneOff]));
    const fake = fakeCore();
    fake.state.sessions[SID] = { state, driver: ME, log: [], participants: [person(ME, 'driver', 'Tess Tech')] };
    renderApp(fake);
    expect(await screen.findByRole('tab', { name: /One-off PC/ })).toBeInTheDocument();
    await sleep(100);
    expect(screen.getByRole('tab', { name: /One-off PC/ })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('support.tabs'))).toHaveLength(1);
  });

  test('a link tab whose session ended is dropped on a restart', async () => {
    localStorage.setItem('support.tabs', JSON.stringify([oneOff]));
    const fake = fakeCore();
    fake.state.sessions[SID] = { state: 'ended', driver: ME, log: [] };
    renderApp(fake);
    await waitFor(() => expect(JSON.parse(localStorage.getItem('support.tabs'))).toEqual([]));
  });

  test('making a link opens a tab that waits for the person, then works like a saved PC\'s tab', async () => {
    const fake = fakeCore();
    fake.state.sessions['o'.repeat(64)] = { state: 'waiting', driver: ME, log: [] };
    const { user } = renderAppWithUser(fake);
    await screen.findByRole('button', { name: /Front counter/ });
    await user.click(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('button', { name: 'One-off link' }));
    const dialog = screen.getByRole('dialog', { hidden: true });
    await user.click(within(dialog).getByRole('button', { name: 'Create link', hidden: true }));
    expect(await within(dialog).findByLabelText('One-off link', { selector: 'input' })).toBeInTheDocument();
    const tab = await screen.findByRole('tab', { name: /One-off PC/ });
    expect(JSON.parse(localStorage.getItem('support.tabs'))).toEqual([expect.objectContaining({ key: 'o'.repeat(64), account: 'acc1', deviceId: null, sessionId: 'o'.repeat(64) })]);
    // The dialog's button brings the tab up; it waits for the PC.
    await user.click(within(dialog).getByRole('button', { name: 'Open the session tab' }));
    expect(tab).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByText('Waiting for the PC')).toBeInTheDocument();
    expect(toolCalls(fake, 'screenshot')).toHaveLength(0);
    // The customer runs the link: the session attaches and the tab shows the screen, you drive.
    fake.state.sessions['o'.repeat(64)] = { state: 'attached', driver: ME, machine: 'CUSTOMER-PC', log: [] };
    expect(await screen.findByRole('img', { name: 'Screen of One-off PC' })).toBeInTheDocument();
    expect(screen.getByText('You are driving')).toBeInTheDocument();
    expect(screen.getByText('CUSTOMER-PC')).toBeInTheDocument();
  });

  test('an admin takes a one-off session over through session_handover', async () => {
    localStorage.setItem('support.tabs', JSON.stringify([oneOff]));
    const fake = fakeCore();
    fake.state.permissions = [...fake.state.permissions, 'sessions.unattended'];
    fake.state.sessions[SID] = { state: 'attached', driver: LEAD, log: [], participants: [person(LEAD, 'driver', 'Lee Lead'), person(ME, 'watcher', 'Tess Tech')] };
    renderApp(fake);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: /One-off PC/ }));
    await user.click(await screen.findByRole('button', { name: 'Take over' }));
    await waitFor(() => expect(toolCalls(fake, 'session_handover')[0]?.args[1]).toEqual({ session_id: SID, action: 'take_over' }));
    expect(toolCalls(fake, 'device_connect')).toHaveLength(0);
  });
});

function renderAppWithUser(fake) {
  const view = renderApp(fake);
  return { ...view, user: userEvent.setup() };
}
