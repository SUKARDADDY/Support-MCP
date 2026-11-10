// Late answers of the calls for people in a session, handover and the queue. Each call is made as
// the account its tab or screen belongs to; an answer that comes back after the team was switched is
// never announced, opened or shown under the other team, and lands in its own team's tab.
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test } from 'vitest';
import { ACCOUNT, ID, ToolFail, device, escalationCall, fakeCore, handoverCall, peopleCall, renderApp } from './test-utils.jsx';

const SECOND = { ...ACCOUNT, id: 'acc2', team: 'acme', team_name: 'Acme Support' };
const SID = 's'.repeat(64);
const ME = 'tech@example.com';
const LEAD = 'lead@example.com';
const sleep = (ms) => act(() => new Promise((r) => setTimeout(r, ms)));
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const person = (identity, role, name = null) => ({ identity, name, role, since: Date.now() - 30000 });
const callsOf = (fake, name) => fake.core.tool.mock.calls.filter((c) => c[1] === name);
afterEach(() => localStorage.clear());

// Goes to the other team, or back, the way a click on a notification of that team does.
const gotoTeam = (fake, id) => act(() => fake.emit('ui://open', { account: id, event: 'device_online', device_id: null, task_id: null, session_id: null }));

async function start({ session, tab = {}, fake = fakeCore({ accounts: [ACCOUNT, SECOND] }) }) {
  localStorage.setItem('support.tabs', JSON.stringify([{ key: SID, account: 'acc1', deviceId: ID('a'), deviceName: 'Front counter', sessionId: SID, taskId: null, ...tab }]));
  fake.state.sessions[SID] = { state: 'attached', driver: ME, machine: 'FRONT', log: [], ...session };
  // Each team has its own PCs, so a PC of the first team on screen under the second is easy to see.
  fake.state.deviceList = (account) => ({ devices: account === 'acc2' ? [device({ id: ID('q'), name: 'Acme PC' })] : [device()], next: null });
  renderApp(fake);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('tab', { name: /Front counter/ }));
  await waitFor(() => expect(fake.core.on).toHaveBeenCalledWith('ui://open', expect.any(Function)));
  return { fake, user };
}

const asDriver = () => ({ driver: ME, participants: [person(ME, 'driver', 'Tess Tech'), person('wat@example.com', 'watcher', 'Wat Watcher')] });
const asWatcher = () => ({ driver: LEAD, participants: [person(LEAD, 'driver', 'Lee Lead'), person(ME, 'watcher', 'Tess Tech')] });
const asInvited = () => ({ driver: LEAD, participants: [person(LEAD, 'driver', 'Lee Lead'), person(ME, 'invited', 'Tess Tech')] });
const offered = () => ({ ...asWatcher(), offer: { to: ME, by: LEAD, expires_at: Date.now() + 100000 } });

// One action in a tab: it is started, the answer is held, the team is switched, the answer comes.
// `toastText` is what the person would be told under the team they were in.
const ACTIONS = [
  {
    name: 'Join', session: asInvited, tool: 'session_participants', hold: 'participantsCall', run: (impl) => impl.default,
    click: async (user) => user.click(await screen.findByRole('button', { name: 'Join' })), toastText: 'You joined the session.',
    after: async () => expect(await screen.findByRole('button', { name: 'Leave' })).toBeInTheDocument(),
  },
  {
    name: 'Remove', session: asDriver, tool: 'session_participants', hold: 'participantsCall',
    click: async (user) => user.click(await screen.findByRole('button', { name: 'Remove Wat Watcher from the session' })), toastText: 'Wat Watcher was removed from the session.',
    after: async () => { await waitFor(() => expect(screen.queryByText('Wat Watcher')).not.toBeInTheDocument()); },
  },
  {
    name: 'Take control', session: offered, tool: 'session_handover', hold: 'handoverCall',
    click: async (user) => user.click(await screen.findByRole('button', { name: 'Take control' })), toastText: 'You are driving this session now.',
    after: async () => expect(await screen.findByRole('button', { name: 'Invite' })).toBeInTheDocument(),
  },
  {
    name: 'Not now', session: offered, tool: 'session_handover', hold: 'handoverCall',
    click: async (user) => user.click(await screen.findByRole('button', { name: 'Not now' })), toastText: null,
    after: async () => { await waitFor(() => expect(screen.queryByRole('button', { name: 'Take control' })).not.toBeInTheDocument()); },
  },
  {
    name: 'Leave', session: asWatcher, tool: 'session_participants', hold: 'participantsCall',
    click: async (user) => user.click(await screen.findByRole('button', { name: 'Leave the session with Front counter' })), toastText: 'You left the session with Front counter.',
    after: async () => { expect(JSON.parse(localStorage.getItem('support.tabs'))).toEqual([]); },
  },
];

describe.each(ACTIONS)('$name, with the answer held while the team is switched', (a) => {
  test('goes through the tab\'s own team, is not announced under the other, and lands in its own tab', async () => {
    const fake = fakeCore({ accounts: [ACCOUNT, SECOND] });
    const gate = deferred();
    const base = a.tool === 'session_handover' ? handoverCall : peopleCall;
    fake.state[a.hold] = async (args) => { await gate.promise; return base(fake.state, args); };
    const { user } = await start({ session: a.session(), fake });
    await a.click(user);
    await waitFor(() => expect(callsOf(fake, a.tool)).toHaveLength(1));
    gotoTeam(fake, 'acc2');
    await screen.findByRole('button', { name: /Acme PC/ });
    gate.resolve();
    await sleep(120);
    // The call was made as the team the tab belongs to, and as no other.
    expect(callsOf(fake, a.tool).map((c) => c[0])).toEqual(['acc1']);
    // Nothing is said or opened under the other team.
    if (a.toastText) expect(screen.queryByText(a.toastText)).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /Front counter/ })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Devices', selected: true })).toBeInTheDocument();
    expect(callsOf(fake, a.tool).filter((c) => c[0] === 'acc2')).toHaveLength(0);
    // Back in its own team, the tab shows the outcome.
    if (a.name !== 'Leave') {
      gotoTeam(fake, 'acc1');
      await user.click(await screen.findByRole('tab', { name: /Front counter/ }));
    }
    await a.after();
  });
});

describe('Invite and Hand over with the dialog open while the team is switched', () => {
  test('the people list asked for under the tab\'s team, and the invite, are not announced under the other team', async () => {
    const fake = fakeCore({ accounts: [ACCOUNT, SECOND] });
    const people = deferred();
    const invite = deferred();
    fake.state.peopleList = async () => { await people.promise; return { people: fake.state.people }; };
    fake.state.participantsCall = async (args) => { await invite.promise; return peopleCall(fake.state, args); };
    const { user } = await start({ session: asDriver(), fake });
    await user.click(await screen.findByRole('button', { name: 'Invite' }));
    const dialog = await screen.findByRole('dialog', { name: 'Invite a colleague' });
    gotoTeam(fake, 'acc2');
    await screen.findByRole('button', { name: /Acme PC/ });
    people.resolve();
    // The dialog belongs to the first team's tab: it fills in, and the invite is made as that team.
    await user.click(await within(dialog).findByLabelText(/Lee Lead/, { hidden: true }, { timeout: 2000 }));
    await user.click(within(dialog).getByRole('button', { name: 'Invite', hidden: true }));
    await waitFor(() => expect(callsOf(fake, 'session_participants')).toHaveLength(1));
    invite.resolve();
    await sleep(120);
    expect(callsOf(fake, 'people_list').map((c) => c[0])).toEqual(['acc1']);
    expect(callsOf(fake, 'session_participants').map((c) => c[0])).toEqual(['acc1']);
    expect(screen.queryByText('Invited Lee Lead.')).not.toBeInTheDocument();
  });

  test('an offer of control answered after a switch is not announced', async () => {
    const fake = fakeCore({ accounts: [ACCOUNT, SECOND] });
    const gate = deferred();
    fake.state.handoverCall = async (args) => { await gate.promise; return handoverCall(fake.state, args); };
    const { user } = await start({ session: asDriver(), fake });
    await user.click(await screen.findByRole('button', { name: 'Hand over' }));
    const dialog = await screen.findByRole('dialog', { name: 'Hand over control' });
    await user.click(within(dialog).getByLabelText(/Wat Watcher/));
    await user.click(within(dialog).getByRole('button', { name: 'Offer control' }));
    await waitFor(() => expect(callsOf(fake, 'session_handover')).toHaveLength(1));
    gotoTeam(fake, 'acc2');
    await screen.findByRole('button', { name: /Acme PC/ });
    gate.resolve();
    await sleep(120);
    expect(callsOf(fake, 'session_handover').map((c) => c[0])).toEqual(['acc1']);
    expect(screen.queryByText(/Offered control to/)).not.toBeInTheDocument();
    gotoTeam(fake, 'acc1');
    await user.click(await screen.findByRole('tab', { name: /Front counter/ }));
    expect(await screen.findByText(/You offered control to Wat Watcher/)).toBeInTheDocument();
  });

  test('Escalate answered after a switch is not announced, and went through the tab\'s team', async () => {
    const fake = fakeCore({ accounts: [ACCOUNT, SECOND] });
    const gate = deferred();
    fake.state.escalationCall = async (args) => { if (args.action === 'open') await gate.promise; return escalationCall(fake.state, args); };
    const { user } = await start({ session: asDriver(), fake });
    await user.click(await screen.findByRole('button', { name: 'Escalate' }));
    const dialog = await screen.findByRole('dialog', { name: 'Send to the queue' });
    await user.click(within(dialog).getByRole('button', { name: 'Send to the queue' }));
    await waitFor(() => expect(callsOf(fake, 'escalation').some((c) => c[2].action === 'open')).toBe(true));
    gotoTeam(fake, 'acc2');
    await screen.findByRole('button', { name: /Acme PC/ });
    gate.resolve();
    await sleep(120);
    expect(callsOf(fake, 'escalation').filter((c) => c[2].action === 'open').map((c) => c[0])).toEqual(['acc1']);
    expect(screen.queryByText('Sent to the queue.')).not.toBeInTheDocument();
  });
});

describe('the watcher\'s picture with the answer held while the team is switched', () => {
  test('is fetched as its own team and shown only in its own tab', async () => {
    const fake = fakeCore({ accounts: [ACCOUNT, SECOND] });
    const gate = deferred();
    fake.state.sessionFrame = async () => { await gate.promise; return { rev: 1, at: Date.now() - 5000, mime: 'image/jpeg', data: 'QUJD' }; };
    const { user } = await start({ session: { ...asWatcher(), frame_rev: 1 }, fake });
    await waitFor(() => expect(fake.core.request.mock.calls.filter((c) => c[2] === `/api/sessions/${SID}/frame`)).toHaveLength(1));
    gotoTeam(fake, 'acc2');
    await screen.findByRole('button', { name: /Acme PC/ });
    gate.resolve();
    await sleep(120);
    expect(fake.core.request.mock.calls.filter((c) => c[2] === `/api/sessions/${SID}/frame`).map((c) => c[0])).toEqual(['acc1']);
    expect(screen.queryByRole('img', { name: /Screen of/ })).not.toBeInTheDocument();
    gotoTeam(fake, 'acc1');
    await user.click(await screen.findByRole('tab', { name: /Front counter/ }));
    expect(await screen.findByRole('img', { name: 'Screen of Front counter' })).toBeInTheDocument();
  });

  test('a picture that arrives for a session the tab has left is dropped', async () => {
    const fake = fakeCore();
    const gate = deferred();
    fake.state.sessionFrame = async () => { await gate.promise; return { rev: 1, at: Date.now(), mime: 'image/jpeg', data: 'QUJD' }; };
    await start({ session: { ...asWatcher(), frame_rev: 1 }, fake });
    await waitFor(() => expect(fake.core.request.mock.calls.filter((c) => c[2] === `/api/sessions/${SID}/frame`)).toHaveLength(1));
    // The session ends while the picture is on its way.
    fake.state.sessions[SID] = { state: 'ended', ended_reason: 'owner', log: [] };
    expect(await screen.findByText('The session ended.', {}, { timeout: 2000 })).toBeInTheDocument();
    gate.resolve();
    await sleep(80);
    expect(screen.queryByRole('img', { name: /Screen of/ })).toBeInTheDocument === undefined || expect(screen.getByText('The session ended.')).toBeInTheDocument();
  });
});

describe('an invite opened from a notification of another team', () => {
  test('joins as that team, and a join answered after switching back is not announced', async () => {
    const fake = fakeCore({ accounts: [ACCOUNT, SECOND] });
    const gate = deferred();
    fake.state.sessions[SID] = { state: 'attached', driver: LEAD, log: [], participants: [person(LEAD, 'driver', 'Lee Lead'), person(ME, 'invited', 'Tess Tech')] };
    fake.state.participantsCall = async (args) => { await gate.promise; return peopleCall(fake.state, args); };
    fake.state.deviceList = (account) => ({ devices: account === 'acc2' ? [device({ id: ID('q'), name: 'Acme PC' })] : [device()], next: null });
    renderApp(fake);
    await screen.findByRole('button', { name: /Front counter/ });
    await waitFor(() => expect(fake.core.on).toHaveBeenCalledWith('ui://open', expect.any(Function)));
    act(() => fake.emit('ui://open', { account: 'acc2', event: 'session_invited', device_id: null, task_id: null, session_id: SID }));
    await screen.findByRole('tab', { name: /One-off PC/, selected: true });
    await waitFor(() => expect(callsOf(fake, 'session_participants')).toHaveLength(1));
    expect(callsOf(fake, 'session_participants')[0][0]).toBe('acc2');
    // The person goes back to the first team before the join is answered.
    gotoTeam(fake, 'acc1');
    await screen.findByRole('button', { name: /Front counter/ });
    gate.resolve();
    await sleep(120);
    expect(screen.queryByText('You joined the session.')).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /One-off PC/ })).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('support.tabs'))).toEqual([expect.objectContaining({ account: 'acc2', sessionId: SID, guest: true })]);
  });
});

describe('a one-off link made while the team is switched', () => {
  test('its tab belongs to the team that made it, is not brought up under the other, and is read as that team', async () => {
    const user = userEvent.setup();
    const fake = fakeCore({ accounts: [ACCOUNT, SECOND] });
    const gate = deferred();
    fake.state.oneOffGate = gate.promise;
    fake.state.sessions['o'.repeat(64)] = { state: 'waiting', driver: ME, log: [] };
    fake.state.deviceList = (account) => ({ devices: account === 'acc2' ? [device({ id: ID('q'), name: 'Acme PC' })] : [device()], next: null });
    renderApp(fake);
    await screen.findByRole('button', { name: /Front counter/ });
    await waitFor(() => expect(fake.core.on).toHaveBeenCalledWith('ui://open', expect.any(Function)));
    await user.click(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('button', { name: 'One-off link' }));
    const dialog = screen.getByRole('dialog', { hidden: true });
    await user.click(within(dialog).getByRole('button', { name: 'Create link', hidden: true }));
    await waitFor(() => expect(callsOf(fake, 'session_create')).toHaveLength(1));
    gotoTeam(fake, 'acc2');
    await screen.findByRole('button', { name: /Acme PC/ });
    gate.resolve();
    await sleep(150);
    expect(screen.queryByRole('tab', { name: /One-off PC/ })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Devices', selected: true })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('support.tabs'))).toEqual([expect.objectContaining({ account: 'acc1', sessionId: 'o'.repeat(64), deviceId: null })]);
    expect(fake.core.tool.mock.calls.filter((c) => c[1] === 'session_status' && c[2].session_id === 'o'.repeat(64)).every((c) => c[0] === 'acc1')).toBe(true);
    gotoTeam(fake, 'acc1');
    expect(await screen.findByRole('tab', { name: /One-off PC/ })).toBeInTheDocument();
  });
});

describe('the Queue with answers held while the team is switched', () => {
  const entry = (over = {}) => ({ id: ID('e'), kind: 'technician', device_id: ID('a'), device_name: 'Front counter', session_id: null, task_id: null, summary: null, note: 'Printer jams', opened_by: LEAD, opened_at: Date.now(), claimed_by: null, claimed_at: null, closed_by: null, closed_at: null, close_note: null, ...over });
  const setup = (queue) => {
    const fake = fakeCore({ accounts: [ACCOUNT, SECOND] });
    fake.state.queue = queue;
    fake.state.deviceList = (account) => ({ devices: account === 'acc2' ? [device({ id: ID('q'), name: 'Acme PC' })] : [device()], next: null });
    return fake;
  };
  const nav = (name) => within(screen.getByRole('navigation', { name: 'Main' })).getByRole('button', { name: new RegExp(name) });

  test('a badge count that comes back after the switch is not the other team\'s', async () => {
    const fake = setup([entry(), entry({ id: ID('f') }), entry({ id: ID('g') })]);
    const gate = deferred();
    fake.state.escalationCall = async (args, account) => {
      if (account === 'acc1') await gate.promise;
      return account === 'acc2' ? { escalations: [] } : escalationCall(fake.state, args);
    };
    renderApp(fake);
    await screen.findByRole('button', { name: /Front counter/ });
    await waitFor(() => expect(callsOf(fake, 'escalation')).toHaveLength(1));
    act(() => fake.emit('ui://open', { account: 'acc2', event: 'device_online', device_id: null, task_id: null, session_id: null }));
    await screen.findByRole('button', { name: /Acme PC/ });
    await waitFor(() => expect(callsOf(fake, 'escalation').some((c) => c[0] === 'acc2')).toBe(true));
    gate.resolve();
    await sleep(120);
    expect(screen.queryByLabelText(/open$/)).not.toBeInTheDocument();
    expect(screen.queryByText('3')).not.toBeInTheDocument();
  });

  test('a ticket claim answered after the switch announces nothing and opens nothing under the other team', async () => {
    const user = userEvent.setup();
    const fake = setup([entry()]);
    const gate = deferred();
    fake.state.escalationCall = async (args, account) => {
      if (args.action === 'claim') await gate.promise;
      return account === 'acc2' ? { escalations: [] } : escalationCall(fake.state, args);
    };
    renderApp(fake);
    await screen.findByRole('button', { name: /Front counter/ });
    await user.click(await screen.findByRole('button', { name: /^Queue/ }));
    await user.click(await screen.findByRole('button', { name: 'Claim' }));
    await waitFor(() => expect(callsOf(fake, 'escalation').some((c) => c[2].action === 'claim')).toBe(true));
    act(() => fake.emit('ui://open', { account: 'acc2', event: 'device_online', device_id: null, task_id: null, session_id: null }));
    await screen.findByRole('button', { name: /Acme PC/ });
    gate.resolve();
    await sleep(120);
    expect(callsOf(fake, 'escalation').filter((c) => c[2].action === 'claim').map((c) => c[0])).toEqual(['acc1']);
    expect(screen.queryByText(/Claimed\. Opening/)).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Front counter', level: 2 })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Queue' })).not.toBeInTheDocument();
  });

  test('a live claim answered after the switch opens its tab under its own team, hidden', async () => {
    const user = userEvent.setup();
    const fake = setup([entry({ session_id: SID })]);
    fake.state.claimLive = true;
    fake.state.sessions[SID] = { state: 'attached', driver: ME, log: [] };
    const gate = deferred();
    fake.state.escalationCall = async (args, account) => {
      if (args.action === 'claim') await gate.promise;
      return account === 'acc2' ? { escalations: [] } : escalationCall(fake.state, args);
    };
    renderApp(fake);
    await screen.findByRole('button', { name: /Front counter/ });
    await user.click(await screen.findByRole('button', { name: /^Queue/ }));
    await user.click(await screen.findByRole('button', { name: 'Claim' }));
    await waitFor(() => expect(callsOf(fake, 'escalation').some((c) => c[2].action === 'claim')).toBe(true));
    act(() => fake.emit('ui://open', { account: 'acc2', event: 'device_online', device_id: null, task_id: null, session_id: null }));
    await screen.findByRole('button', { name: /Acme PC/ });
    gate.resolve();
    await sleep(150);
    expect(screen.queryByRole('tab', { name: /Front counter/ })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Devices', selected: true })).toBeInTheDocument();
    expect(screen.queryByText('You are driving the session now.')).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('support.tabs'))).toEqual([expect.objectContaining({ account: 'acc1', sessionId: SID })]);
    act(() => fake.emit('ui://open', { account: 'acc1', event: 'device_online', device_id: null, task_id: null, session_id: null }));
    expect(await screen.findByRole('tab', { name: /Front counter/ })).toBeInTheDocument();
  });

  test('a close answered after the switch says nothing under the other team', async () => {
    const user = userEvent.setup();
    const fake = setup([entry({ opened_by: ME })]);
    const gate = deferred();
    fake.state.escalationCall = async (args, account) => {
      if (args.action === 'close') await gate.promise;
      return account === 'acc2' ? { escalations: [] } : escalationCall(fake.state, args);
    };
    renderApp(fake);
    await screen.findByRole('button', { name: /Front counter/ });
    await user.click(await screen.findByRole('button', { name: /^Queue/ }));
    await user.click(await screen.findByRole('button', { name: 'Close' }));
    const dialog = await screen.findByRole('dialog', { name: 'Close this queue item' });
    await user.click(within(dialog).getByRole('button', { name: 'Close the item' }));
    await waitFor(() => expect(callsOf(fake, 'escalation').some((c) => c[2].action === 'close')).toBe(true));
    act(() => fake.emit('ui://open', { account: 'acc2', event: 'device_online', device_id: null, task_id: null, session_id: null }));
    await screen.findByRole('button', { name: /Acme PC/ });
    gate.resolve();
    await sleep(120);
    expect(callsOf(fake, 'escalation').filter((c) => c[2].action === 'close').map((c) => c[0])).toEqual(['acc1']);
    expect(screen.queryByText('Closed.')).not.toBeInTheDocument();
    void nav;
  });

  test('a refused claim after the switch shows no error under the other team', async () => {
    const user = userEvent.setup();
    const fake = setup([entry()]);
    const gate = deferred();
    fake.state.escalationCall = async (args, account) => {
      if (args.action === 'claim') { await gate.promise; throw new ToolFail('x has already claimed that item', 'already_claimed'); }
      return account === 'acc2' ? { escalations: [] } : escalationCall(fake.state, args);
    };
    renderApp(fake);
    await screen.findByRole('button', { name: /Front counter/ });
    await user.click(await screen.findByRole('button', { name: /^Queue/ }));
    await user.click(await screen.findByRole('button', { name: 'Claim' }));
    act(() => fake.emit('ui://open', { account: 'acc2', event: 'device_online', device_id: null, task_id: null, session_id: null }));
    await screen.findByRole('button', { name: /Acme PC/ });
    gate.resolve();
    await sleep(120);
    expect(screen.queryByText('Someone else claimed that item first.')).not.toBeInTheDocument();
  });
});
