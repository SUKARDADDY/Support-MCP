// Approvals: an action the team's rules send to a technician reaches the app as a notice, and as the status of the session it
// waits on. The dialog shows what is asked, for which PC, by whom and how long is left. Approve needs a fresh authenticator
// code, Deny none. Also the words for the codes the rules and the approvals refuse with.
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test } from 'vitest';
import { AID, GOOD_CODE, ID, SID as sid, fakeCore, relayFail, renderApp } from '../test-utils.jsx';

const SID = sid('n');
const ME = 'tech@example.com';
const BASE = ['devices.view', 'devices.manage', 'sessions.create', 'sessions.view', 'sessions.control', 'sessions.end'];
const APPROVER = [...BASE, 'sessions.unattended'];
afterEach(() => localStorage.clear());

const waitingApproval = (over = {}) => ({
  id: AID(), summary: 'Restart the PC in 30 seconds', actor: 'lead@example.com', via: null, action: 'restart',
  created_at: Date.now() - 1000, expires_at: Date.now() + 4 * 60 * 1000, device_id: ID('a'), device_name: 'Front counter', ...over,
});
const notice = (id = 1, over = {}) => ({ id, event: 'approval_requested', at: Date.now(), title: 'Approval needed', body: 'lead@example.com asks to: Restart the PC in 30 seconds on Front counter. Approve or deny it in the app.', device_id: ID('a'), task_id: null, session_id: SID, ...over });
const answersOf = (fake) => fake.state.answers ?? [];

async function start(fake) {
  renderApp(fake);
  await screen.findByRole('button', { name: /Front counter/ });
  await waitFor(() => expect(fake.core.on).toHaveBeenCalledWith('feed://items', expect.any(Function)));
  await waitFor(() => expect(fake.core.on).toHaveBeenCalledWith('ui://open', expect.any(Function)));
  return userEvent.setup();
}
const live = (fake, items = [notice()]) => act(() => fake.emit('feed://items', { account: 'acc1', live: true, items }));
const dialogOf = () => screen.findByRole('dialog', { name: 'An action needs your approval' });
const withApproval = (permissions = APPROVER, over = {}) => {
  const fake = fakeCore({ permissions });
  fake.state.approvals[SID] = waitingApproval(over);
  return fake;
};

describe('the notice and the dialog', () => {
  test('a live notice opens the dialog with what is asked, the PC, who asks and the time left', async () => {
    const fake = withApproval();
    await start(fake);
    live(fake);
    const dialog = await dialogOf();
    expect(await within(dialog).findByText('Restart the PC in 30 seconds')).toBeInTheDocument();
    expect(within(dialog).getByText('Front counter')).toBeInTheDocument();
    expect(within(dialog).getByText('lead@example.com')).toBeInTheDocument();
    expect(within(dialog).getByText('Time left').nextSibling).toHaveTextContent(/^[34]:\d\d$/);
    // The approval was read from the relay for that session, as the account the notice came from.
    expect(fake.calls.filter((c) => c.kind === 'request' && c.args[1] === `/api/sessions/${SID}/approvals`)).toHaveLength(1);
    expect(within(dialog).getByRole('button', { name: 'Approve' })).toBeDisabled();
  });

  test('an approval asked for by an agent says whose agent', async () => {
    const fake = withApproval(APPROVER, { via: 'agent', actor: 'lead@example.com' });
    await start(fake);
    live(fake);
    expect(await within(await dialogOf()).findByText("lead@example.com's agent")).toBeInTheDocument();
  });

  test('text in the request is shown as text, never as markup', async () => {
    const fake = withApproval(APPROVER, { summary: 'Install C:\\Temp\\<img src=x onerror=alert(1)>.msi' });
    await start(fake);
    live(fake);
    const dialog = await dialogOf();
    expect(await within(dialog).findByText('Install C:\\Temp\\<img src=x onerror=alert(1)>.msi')).toBeInTheDocument();
    expect(dialog.querySelector('img')).toBeNull();
  });

  test('Approve needs six digits and sends the code with the answer; the result is told and nothing else is asked', async () => {
    const fake = withApproval();
    const user = await start(fake);
    live(fake);
    const dialog = await dialogOf();
    await within(dialog).findByText('Restart the PC in 30 seconds');
    await user.type(within(dialog).getByLabelText('Code from your authenticator app'), '12345');
    expect(within(dialog).getByRole('button', { name: 'Approve' })).toBeDisabled();
    await user.type(within(dialog).getByLabelText('Code from your authenticator app'), '6');
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
    expect(await within(dialog).findByText('Approved. The action is on its way to the PC.')).toBeInTheDocument();
    expect(answersOf(fake)).toEqual([{ account: 'acc1', sid: SID, id: AID(), approve: true, code: GOOD_CODE }]);
    expect(within(dialog).queryByLabelText('Code from your authenticator app')).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  test('Deny needs no code and sends none', async () => {
    const fake = withApproval();
    const user = await start(fake);
    live(fake);
    const dialog = await dialogOf();
    await within(dialog).findByText('Restart the PC in 30 seconds');
    await user.click(within(dialog).getByRole('button', { name: 'Deny' }));
    expect(await within(dialog).findByText('Denied. The action will not run.')).toBeInTheDocument();
    expect(answersOf(fake)).toEqual([{ account: 'acc1', sid: SID, id: AID(), approve: false }]);
    expect(answersOf(fake)[0]).not.toHaveProperty('code');
  });

  test('a wrong code is told and the request stays open for another try', async () => {
    const fake = withApproval();
    const user = await start(fake);
    live(fake);
    const dialog = await dialogOf();
    await within(dialog).findByText('Restart the PC in 30 seconds');
    await user.type(within(dialog).getByLabelText('Code from your authenticator app'), '000000');
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
    expect(await within(dialog).findByText(/That code is wrong or was already used/)).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Code from your authenticator app')).toHaveValue('');
    expect(answersOf(fake)).toEqual([]);
    await user.type(within(dialog).getByLabelText('Code from your authenticator app'), GOOD_CODE);
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
    expect(await within(dialog).findByText('Approved. The action is on its way to the PC.')).toBeInTheDocument();
  });

  test('a request that was answered or timed out before the dialog opened says so', async () => {
    const gone = fakeCore({ permissions: APPROVER });
    await start(gone);
    live(gone);
    expect(await within(await dialogOf()).findByText('Nothing is waiting any more. It was answered, cancelled or timed out.')).toBeInTheDocument();
  });

  test('an answer that comes too late is told the same way', async () => {
    const late = withApproval();
    const user = await start(late);
    live(late);
    const dialog = await dialogOf();
    await within(dialog).findByText('Restart the PC in 30 seconds');
    delete late.state.approvals[SID];
    await user.click(within(dialog).getByRole('button', { name: 'Deny' }));
    expect(await within(dialog).findByText('Nothing is waiting any more. It was answered, cancelled or timed out.')).toBeInTheDocument();
  });

  test('time running out shows Timed out and takes the buttons away', async () => {
    const fake = withApproval(APPROVER, { expires_at: Date.now() + 1200 });
    await start(fake);
    live(fake);
    const dialog = await dialogOf();
    await within(dialog).findByText('Restart the PC in 30 seconds');
    expect(await within(dialog).findByText('Timed out', {}, { timeout: 4000 })).toBeInTheDocument();
    expect(within(dialog).getByText('Nobody answered in time, so the action was refused. Nothing ran.')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Deny' })).not.toBeInTheDocument();
  });

  test('Decide later closes it without answering', async () => {
    const fake = withApproval();
    const user = await start(fake);
    live(fake);
    const dialog = await dialogOf();
    await within(dialog).findByText('Restart the PC in 30 seconds');
    await user.click(within(dialog).getByRole('button', { name: 'Decide later' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(answersOf(fake)).toEqual([]);
  });

  test('a request that cannot be read says so and Try again reads it', async () => {
    const fake = withApproval();
    let fail = true;
    fake.state.approvalsError = (method) => (fail && method === 'GET' ? relayFail(503, 'unavailable', 'could not reach that session; try again') : null);
    const user = await start(fake);
    live(fake);
    const dialog = await dialogOf();
    expect(await within(dialog).findByText('could not reach that session; try again')).toBeInTheDocument();
    fail = false;
    await user.click(within(dialog).getByRole('button', { name: 'Try again' }));
    expect(await within(dialog).findByText('Restart the PC in 30 seconds')).toBeInTheDocument();
  });
});

describe('when the dialog opens by itself, and when it does not', () => {
  test('the first items the app reads are old news: no dialog', async () => {
    const fake = withApproval();
    await start(fake);
    act(() => fake.emit('feed://items', { account: 'acc1', live: false, items: [notice()] }));
    await screen.findByRole('button', { name: /Front counter/ });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(fake.calls.filter((c) => c.kind === 'request' && /approvals/.test(c.args[1]))).toHaveLength(0);
  });

  test('a role that may not approve is not interrupted, and Review explains it', async () => {
    const fake = withApproval(BASE);
    fake.state.approvalsError = (method) => (method === 'GET' ? relayFail(403, 'permission_denied', 'your role does not allow that') : null);
    const user = await start(fake);
    live(fake);
    await screen.findByRole('button', { name: /Front counter/ });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(fake.calls.filter((c) => c.kind === 'request' && /approvals/.test(c.args[1]))).toHaveLength(0);
    await user.click(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('button', { name: /Notifications/ }));
    await user.click(await screen.findByRole('button', { name: 'Review the request' }));
    expect(await within(await dialogOf()).findByText(/Your role cannot approve actions/)).toBeInTheDocument();
  });

  test('the notification list holds the notice, with Review the request, and its title and text are plain text', async () => {
    const fake = withApproval();
    const user = await start(fake);
    live(fake, [notice(1, { title: 'Approval needed <b>now</b>' })]);
    await within(await dialogOf()).findByText('Restart the PC in 30 seconds');
    await user.click(within(await dialogOf()).getByRole('button', { name: 'Decide later' }));
    await user.click(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('button', { name: /Notifications/ }));
    const list = await screen.findByRole('list', { name: 'Recent' });
    expect(within(list).getByText('Approval needed <b>now</b>')).toBeInTheDocument();
    expect(within(list).getByText(/lead@example.com asks to: Restart the PC in 30 seconds/)).toBeInTheDocument();
    await user.click(within(list).getByRole('button', { name: 'Review the request' }));
    expect(await within(await dialogOf()).findByText('Restart the PC in 30 seconds')).toBeInTheDocument();
  });

  test('a click on the Windows notification opens the review, in the team it came from', async () => {
    const fake = withApproval();
    await start(fake);
    act(() => fake.emit('ui://open', { account: 'acc1', event: 'approval_requested', device_id: ID('a'), task_id: null, session_id: SID }));
    expect(await within(await dialogOf()).findByText('Restart the PC in 30 seconds')).toBeInTheDocument();
  });

  test('two notices for one session open one dialog', async () => {
    const fake = withApproval();
    await start(fake);
    live(fake, [notice(1), notice(2)]);
    await dialogOf();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });
});

describe('a session tab that sees an approval in its status', () => {
  async function openTab(fake) {
    localStorage.setItem('support.tabs', JSON.stringify([{ key: SID, account: 'acc1', deviceId: ID('a'), deviceName: 'Front counter', sessionId: SID, taskId: null }]));
    fake.state.approvals[SID] ??= waitingApproval();
    fake.state.sessions[SID] = { state: 'attached', driver: ME, machine: 'FRONT', log: [], approval: fake.state.approvals[SID] };
    renderApp(fake);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: /Front counter/ }));
    return user;
  }

  test('opens the dialog once, says so in the tab while it waits, and Review brings it back after Decide later', async () => {
    const fake = fakeCore({ permissions: APPROVER });
    const user = await openTab(fake);
    const dialog = await dialogOf();
    expect(await within(dialog).findByText('Restart the PC in 30 seconds')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Decide later' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // The status is read again while the approval still waits: it does not open again by itself.
    await new Promise((r) => setTimeout(r, 150));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText('An action waits for your approval: Restart the PC in 30 seconds')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Review' }));
    expect(await within(await dialogOf()).findByText('Restart the PC in 30 seconds')).toBeInTheDocument();
  });

  test('someone who may not approve is told it waits, with no dialog and no Review', async () => {
    const fake = fakeCore({ permissions: BASE });
    await openTab(fake);
    expect(await screen.findByText('An action waits for someone who may approve it: Restart the PC in 30 seconds')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Review' })).not.toBeInTheDocument();
  });
});

describe('the words for what the rules and the approvals refuse', () => {
  const TASK = ID('t');
  const ended = (over = {}) => ({ id: TASK, state: 'failed', end_reason: 'approval_timeout: no technician answered within 5 minutes', title: 'Restart it', session_id: SID, device_id: ID('a'), created_at: Date.now() - 60000, ended_at: Date.now() - 1000, phase: 'ended', rev: 1, steps: [], notes: [], summary: null, ...over });

  test('a task that ended with a code gives our sentence for it, and a failed step does the same', async () => {
    const fake = fakeCore();
    const task = () => ended({ steps: [{ n: 1, ts: Date.now() - 5000, verb: 'restart_pc', detail: 'rule_never: the team\'s rules never allow this action on this PC', ok: false }, { n: 2, ts: Date.now() - 4000, verb: 'close_program', detail: 'protected_program: the team\'s rules protect this program', ok: false }] });
    fake.state.tasks = [task()];
    fake.state.taskStatus = task;
    localStorage.setItem('support.tabs', JSON.stringify([{ key: `task:${TASK}`, account: 'acc1', deviceId: ID('a'), deviceName: 'Front counter', sessionId: SID, taskId: TASK }]));
    fake.state.sessions[SID] = { state: 'attached', driver: ME, log: [] };
    renderApp(fake);
    await userEvent.setup().click(await screen.findByRole('tab', { name: /Front counter/ }));
    expect(await screen.findByText('Why: Nobody approved the action within 5 minutes, so it did not run.')).toBeInTheDocument();
    expect(screen.getByText('The team\'s rules never allow that action on this PC.')).toBeInTheDocument();
    expect(screen.getByText('The team\'s rules protect that program.')).toBeInTheDocument();
  });

  test('text with no code in front, or a code we have no words for, stays as the relay wrote it', async () => {
    const fake = fakeCore();
    const task = () => ended({ end_reason: 'could not connect to the PC: someone is connected', steps: [{ n: 1, ts: Date.now() - 5000, verb: 'run', detail: 'weird_code: something else', ok: false }] });
    fake.state.tasks = [task()];
    fake.state.taskStatus = task;
    localStorage.setItem('support.tabs', JSON.stringify([{ key: `task:${TASK}`, account: 'acc1', deviceId: ID('a'), deviceName: 'Front counter', sessionId: SID, taskId: TASK }]));
    fake.state.sessions[SID] = { state: 'attached', driver: ME, log: [] };
    renderApp(fake);
    await userEvent.setup().click(await screen.findByRole('tab', { name: /Front counter/ }));
    expect(await screen.findByText('Why: could not connect to the PC: someone is connected')).toBeInTheDocument();
    expect(screen.getByText('weird_code: something else')).toBeInTheDocument();
  });

  test('the session log names approvals and rules rows by our words', async () => {
    const fake = fakeCore();
    localStorage.setItem('support.tabs', JSON.stringify([{ key: SID, account: 'acc1', deviceId: ID('a'), deviceName: 'Front counter', sessionId: SID, taskId: null }]));
    fake.state.sessions[SID] = { state: 'attached', driver: ME, log: [{ ts: Date.now() - 3000, kind: 'approval', detail: 'requested: Restart the PC in 30 seconds' }, { ts: Date.now() - 2000, kind: 'rules', detail: 'refused restart: rule_never' }] };
    renderApp(fake);
    await userEvent.setup().click(await screen.findByRole('tab', { name: /Front counter/ }));
    expect(await screen.findByText('Approval', { selector: '.tl-h span' })).toBeInTheDocument();
    expect(screen.getByText('Rules', { selector: '.tl-h span' })).toBeInTheDocument();
  });
});
