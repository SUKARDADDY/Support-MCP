// The Rules screen: who sees it and who edits, the team's rules and a customer's own over them, the fresh authenticator
// code every save and every removal of an override needs, and what the person is told when the relay refuses.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test } from 'vitest';
import { GOOD_CODE, ID, device, fakeCore, relayFail, renderApp } from '../test-utils.jsx';

afterEach(() => localStorage.clear());

const MANAGER = ['devices.view', 'devices.manage', 'sessions.create', 'sessions.view', 'sessions.control', 'sessions.end', 'rules.manage'];
const READER = ['devices.view', 'sessions.view'];
const CUSTOMER = ID('k');
const HOURS = { mon: ['08:00', '18:00'], tue: ['08:00', '18:00'], wed: ['08:00', '18:00'], thu: ['08:00', '18:00'], fri: ['08:00', '13:00'] };
const savesOf = (fake) => fake.state.saves ?? [];
const requestsOf = (fake, method, pattern) => fake.calls.filter((c) => c.kind === 'request' && c.args[0] === method && pattern.test(c.args[1]));

async function openRules(fake) {
  renderApp(fake);
  const user = userEvent.setup();
  await screen.findByRole('button', { name: /Front counter/ });
  await user.click(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('button', { name: 'Rules' }));
  await screen.findByRole('combobox', { name: 'Restart the PC' });
  return user;
}
const group = (name) => screen.getByRole('group', { name });
const fakeWith = (permissions, extra = {}) => fakeCore({ permissions, ...extra });

// Types a code into the dialog that asks for one, and presses its button.
async function enterCode(user, title, code, button) {
  const dialog = await screen.findByRole('dialog', { name: title });
  await user.type(within(dialog).getByLabelText('Code from your authenticator app'), code);
  await user.click(within(dialog).getByRole('button', { name: button }));
  return dialog;
}

describe('who sees the rules and who edits them', () => {
  test('the rail item is there for people who see PCs, and not for anyone else', async () => {
    const seen = fakeWith(READER);
    renderApp(seen);
    await screen.findByRole('button', { name: /Front counter/ });
    expect(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('button', { name: 'Rules' })).toBeInTheDocument();
  });

  test('without devices.view there is no Rules item', async () => {
    renderApp(fakeWith(['sessions.view']));
    await screen.findByRole('navigation', { name: 'Main' });
    expect(within(screen.getByRole('navigation', { name: 'Main' })).queryByRole('button', { name: 'Rules' })).not.toBeInTheDocument();
  });

  test('a reader sees the saved rules and cannot change them: every field is off and there is no Save', async () => {
    const fake = fakeWith(READER);
    fake.state.rules.team = { rev: 3, doc: { ...fake.state.rules.team.doc, restart: 'never', hours: HOURS, protected_programs: ['Outlook.exe'] }, updated_at: Date.parse('2026-11-09T10:00:00Z'), updated_by: 'boss@example.com' };
    await openRules(fake);
    expect(screen.getByText('Only people whose role can manage rules change them. You can read them here.')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Restart the PC' })).toHaveValue('never');
    expect(screen.getByRole('combobox', { name: 'Restart the PC' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Monday closed' })).toBeDisabled();
    expect(screen.getByText('Outlook.exe')).toBeInTheDocument();
    expect(screen.getByText(/Last saved by boss@example.com/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  test('an editor sees the defaults of a team with no saved rules', async () => {
    const fake = fakeWith(MANAGER);
    await openRules(fake);
    expect(screen.getByRole('combobox', { name: 'Restart the PC' })).toHaveValue('approve');
    expect(screen.getByRole('combobox', { name: 'Close a program' })).toHaveValue('allow');
    expect(screen.getByLabelText('Time zone')).toHaveValue('');
    expect(screen.getByLabelText('Time zone')).toHaveAttribute('placeholder', "Deployment's time zone (UTC)");
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  test('the deployment\'s time zone is shown in the field and its help', async () => {
    const fake = fakeWith(MANAGER);
    fake.state.rules.defaultTimeZone = 'Asia/Jerusalem';
    await openRules(fake);
    expect(screen.getByLabelText('Time zone')).toHaveAttribute('placeholder', "Deployment's time zone (Asia/Jerusalem)");
    expect(screen.getByText(/Leave it empty to use the deployment's, Asia\/Jerusalem\./)).toBeInTheDocument();
  });
});

describe('editing the team\'s rules', () => {
  test('the two hour values are off while no hours are set, and on once a day is open', async () => {
    const fake = fakeWith(MANAGER);
    const user = await openRules(fake);
    const restart = screen.getByRole('combobox', { name: 'Restart the PC' });
    expect(within(restart).getByRole('option', { name: 'Needs approval during business hours' })).toBeDisabled();
    expect(within(restart).getByRole('option', { name: 'Only outside business hours' })).toBeDisabled();
    expect(within(restart).getByRole('option', { name: 'Never' })).toBeEnabled();
    await user.click(screen.getByRole('checkbox', { name: 'Monday closed' }));
    expect(screen.getByLabelText('Monday from')).toHaveValue('08:00');
    expect(screen.getByLabelText('Monday until')).toHaveValue('18:00');
    expect(within(restart).getByRole('option', { name: 'Needs approval during business hours' })).toBeEnabled();
    // Closing the only open day takes the hours away again.
    await user.click(screen.getByRole('checkbox', { name: 'Monday closed' }));
    expect(within(restart).getByRole('option', { name: 'Needs approval during business hours' })).toBeDisabled();
  });

  test('a save asks for a code, tells a wrong one in plain words, and sends the whole document with the revision it read', async () => {
    const fake = fakeWith(MANAGER);
    fake.state.rules.team = { rev: 2, doc: { ...fake.state.rules.team.doc, shutdown: 'never' }, updated_at: 1, updated_by: 'boss@example.com' };
    const user = await openRules(fake);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Restart the PC' }), 'never');
    await user.click(screen.getByRole('checkbox', { name: 'Monday closed' }));
    await user.clear(screen.getByLabelText('Monday until'));
    await user.type(screen.getByLabelText('Monday until'), '17:30');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Install a program' }), 'approve_in_hours');
    await user.type(screen.getByLabelText('Add a protected program'), 'Outlook.exe');
    await user.click(within(group('Protected programs')).getByRole('button', { name: 'Add' }));
    await user.type(screen.getByLabelText('Add a protected folder'), 'C:\\Customer Data{Enter}');
    await user.type(screen.getByLabelText('Time zone'), 'Asia/Jerusalem');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    // Wrong first.
    const dialog = await enterCode(user, 'Save the rules', '000000', 'Save');
    expect(await within(dialog).findByText('That code is wrong or was already used. Wait for the next one from your authenticator app and try again.')).toBeInTheDocument();
    expect(savesOf(fake)).toEqual([]);
    expect(screen.getByRole('dialog', { name: 'Save the rules' })).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Code from your authenticator app'), GOOD_CODE);
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await screen.findByText('Rules saved.');
    expect(savesOf(fake)).toEqual([{
      method: 'PATCH',
      customerId: null,
      rev: 2,
      code: GOOD_CODE,
      doc: {
        time_zone: 'Asia/Jerusalem', hours: { mon: ['08:00', '17:30'] }, restart: 'never', shutdown: 'never', install: 'approve_in_hours', uninstall: 'approve', close_program: 'allow',
        protected_programs: ['Outlook.exe'], protected_folders: ['C:\\Customer Data'],
      },
    }]);
    // The screen reads the saved rules back: nothing left to save.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled());
    expect(screen.getByRole('combobox', { name: 'Restart the PC' })).toHaveValue('never');
    // The wrong code reached the relay too (it alone can tell), and the right one followed.
    expect(requestsOf(fake, 'PATCH', /^\/api\/rules$/).map((c) => c.args[2].code)).toEqual(['000000', GOOD_CODE]);
  });

  test('Discard puts back what was read, and Cancel on the dialog saves nothing', async () => {
    const fake = fakeWith(MANAGER);
    const user = await openRules(fake);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Close a program' }), 'never');
    await user.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(screen.getByRole('combobox', { name: 'Close a program' })).toHaveValue('allow');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Close a program' }), 'approve');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save the rules' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(savesOf(fake)).toEqual([]);
    expect(screen.getByRole('combobox', { name: 'Close a program' })).toHaveValue('approve');
  });

  test('an hour value with no hours is caught before a code is asked for', async () => {
    const fake = fakeWith(MANAGER);
    const user = await openRules(fake);
    await user.click(screen.getByRole('checkbox', { name: 'Monday closed' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Restart the PC' }), 'outside_hours');
    await user.click(screen.getByRole('checkbox', { name: 'Monday closed' }));
    expect(screen.getByText('Set business hours first, or pick another value.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Restart the PC depends on business hours. Set business hours first, or pick another value.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('times that are not times, hours that end before they start, a time zone that does not exist and a folder that is not a path are each told, with no dialog', async () => {
    const fake = fakeWith(MANAGER);
    const user = await openRules(fake);
    await user.click(screen.getByRole('checkbox', { name: 'Monday closed' }));
    await user.clear(screen.getByLabelText('Monday from'));
    await user.type(screen.getByLabelText('Monday from'), '9am');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Monday: write the times as hours and minutes, such as 08:00 and 18:00.')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Monday from'));
    await user.type(screen.getByLabelText('Monday from'), '19:00');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Monday must end after it starts.')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Monday from'));
    await user.type(screen.getByLabelText('Monday from'), '08:00');
    await user.type(screen.getByLabelText('Time zone'), 'Mars/Base');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/Mars\/Base is not a time zone/)).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Time zone'));
    await user.type(screen.getByLabelText('Add a protected folder'), 'Customer Data{Enter}');
    expect(await screen.findByText('Customer Data is not a full path. Write it like C:\\Customer Data.')).toBeInTheDocument();
    // A whole drive is refused too: it would stop every file and installer on the PC.
    await user.clear(screen.getByLabelText('Add a protected folder'));
    await user.type(screen.getByLabelText('Add a protected folder'), 'C:\\{Enter}');
    expect(await screen.findByText('C:\\ is a whole drive. Protect a folder on it, like C:\\Customer Data.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(savesOf(fake)).toEqual([]);
  });

  test('the time zone field offers the platform\'s zones to search', async () => {
    const fake = fakeWith(MANAGER);
    await openRules(fake);
    const list = document.getElementById(screen.getByLabelText('Time zone').getAttribute('list'));
    const zones = [...list.querySelectorAll('option')].map((o) => o.getAttribute('value'));
    expect(zones).toContain('Asia/Jerusalem');
    expect(zones).toContain('UTC');
  });

  test('a list takes one entry at a time, drops a repeat, and an entry can be removed', async () => {
    const fake = fakeWith(MANAGER);
    fake.state.rules.team = { rev: 1, doc: { ...fake.state.rules.team.doc, protected_programs: ['Sage.exe'] }, updated_at: 1, updated_by: 'boss@example.com' };
    const user = await openRules(fake);
    await user.type(screen.getByLabelText('Add a protected program'), 'sage.EXE{Enter}');
    expect(await screen.findByText('That is in the list already.')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Add a protected program'));
    await user.type(screen.getByLabelText('Add a protected program'), 'Outlook.exe{Enter}');
    expect(screen.getByText('Outlook.exe')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove Sage.exe' }));
    expect(screen.queryByText('Sage.exe')).not.toBeInTheDocument();
  });
});

describe('what the person is told when the relay refuses', () => {
  async function tryToSave(fake, user) {
    await user.selectOptions(screen.getByRole('combobox', { name: 'Restart the PC' }), 'never');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    return enterCode(user, 'Save the rules', GOOD_CODE, 'Save');
  }

  test('stale: the rules are read again, the edits are dropped, and it says someone else changed them', async () => {
    const fake = fakeWith(MANAGER);
    const user = await openRules(fake);
    // Someone else saves first.
    fake.state.rules.team = { rev: 4, doc: { ...fake.state.rules.team.doc, shutdown: 'never' }, updated_at: 1, updated_by: 'boss@example.com' };
    await tryToSave(fake, user);
    expect(await screen.findByText(/Someone else changed these rules after you opened them/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Shut down the PC' })).toHaveValue('never'));
    expect(screen.getByRole('combobox', { name: 'Restart the PC' })).toHaveValue('approve');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(savesOf(fake)).toEqual([]);
  });

  test.each([
    ['second_factor', 'that code is wrong or was already used', 'That code is wrong or was already used. Wait for the next one from your authenticator app and try again.'],
    ['second_factor', 'set up an authenticator on your account first, then send a code from it', 'Set up an authenticator app on your account first, then try again.'],
    ['locked', 'too many wrong codes; the authenticator is locked for a while', 'Too many wrong codes. Your authenticator is locked for a while.'],
  ])('%s: %s', async (code, message, told) => {
    const fake = fakeWith(MANAGER);
    fake.state.rulesError = (method) => (method === 'PATCH' ? relayFail(code === 'locked' ? 429 : 403, code, message) : null);
    const user = await openRules(fake);
    const dialog = await tryToSave(fake, user);
    expect(await within(dialog).findByText(told)).toBeInTheDocument();
    // The code field is empty again for the next try, and the dialog stays.
    expect(within(dialog).getByLabelText('Code from your authenticator app')).toHaveValue('');
  });

  test('a document the relay refuses is told in the relay\'s own plain words, and the dialog stays', async () => {
    const fake = fakeWith(MANAGER);
    fake.state.rulesError = (method) => (method === 'PATCH' ? relayFail(400, 'bad_request', 'protected_folders entries must not contain < > " | ? *') : null);
    const user = await openRules(fake);
    const dialog = await tryToSave(fake, user);
    expect(await within(dialog).findByText('protected_folders entries must not contain < > " | ? *')).toBeInTheDocument();
  });

  test('a role that lost rules.manage meanwhile gets the relay\'s refusal', async () => {
    const fake = fakeWith(MANAGER);
    fake.state.rulesError = (method) => (method === 'PATCH' ? relayFail(403, 'permission_denied', 'your role does not allow that') : null);
    const user = await openRules(fake);
    const dialog = await tryToSave(fake, user);
    expect(await within(dialog).findByText('your role does not allow that')).toBeInTheDocument();
  });

  test('rules that cannot be read say so, and Try again reads them', async () => {
    const fake = fakeWith(MANAGER);
    let fail = true;
    fake.state.rulesError = (method) => (fail && method === 'GET' ? relayFail(500, 'internal', 'the relay failed') : null);
    renderApp(fake);
    const user = userEvent.setup();
    await screen.findByRole('button', { name: /Front counter/ });
    await user.click(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('button', { name: 'Rules' }));
    expect(await screen.findByText('the relay failed')).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('combobox', { name: 'Restart the PC' })).toBeInTheDocument();
  });
});

describe('a customer\'s own rules', () => {
  async function openCustomer(fake) {
    const user = await openRules(fake);
    await user.selectOptions(screen.getByLabelText('Rules for'), CUSTOMER);
    await screen.findByText(/Each field is the team's unless you change it for Hadar Bakery Ltd/);
    return user;
  }
  const teamRules = () => ({ rev: 2, doc: { time_zone: null, hours: HOURS, restart: 'approve_in_hours', shutdown: 'never', install: 'approve', uninstall: 'approve', close_program: 'allow', protected_programs: ['Outlook.exe'], protected_folders: [] }, updated_at: 1, updated_by: 'boss@example.com' });

  test('every field says Same as team and shows the team\'s value, with the value in force below', async () => {
    const fake = fakeWith(MANAGER);
    fake.state.rules.team = teamRules();
    await openCustomer(fake);
    for (const name of ['Time zone', 'Business hours', 'Restart the PC', 'Shut down the PC', 'Install a program', 'Uninstall a program', 'Close a program', 'Protected programs', 'Protected folders']) {
      expect(within(group(name)).getByRole('checkbox', { name: 'Same as team' })).toBeChecked();
    }
    expect(within(group('Restart the PC')).getByText("The team's value: Needs approval during business hours")).toBeInTheDocument();
    expect(within(group('Business hours')).getByText(/Monday to Thursday 08:00 to 18:00, Friday 08:00 to 13:00/)).toBeInTheDocument();
    expect(within(group('Protected programs')).getByText("The team's value: Outlook.exe")).toBeInTheDocument();
    expect(within(group('Protected folders')).getByText("The team's value: None")).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Restart the PC' })).not.toBeInTheDocument();
    const force = screen.getByRole('region', { name: 'Rules in force for Hadar Bakery Ltd' });
    expect(within(force).getByText('Shut down the PC').nextSibling).toHaveTextContent('Never');
    expect(screen.queryByRole('button', { name: "Remove this customer's rules" })).not.toBeInTheDocument();
  });

  test('changing one field saves only that field, for that customer, and the value in force follows', async () => {
    const fake = fakeWith(MANAGER);
    fake.state.rules.team = teamRules();
    const user = await openCustomer(fake);
    await user.click(within(group('Shut down the PC')).getByRole('checkbox', { name: 'Same as team' }));
    // The field starts from the team's value.
    const select = within(group('Shut down the PC')).getByRole('combobox', { name: 'Shut down the PC' });
    expect(select).toHaveValue('never');
    await user.selectOptions(select, 'approve');
    const force = screen.getByRole('region', { name: 'Rules in force for Hadar Bakery Ltd' });
    expect(within(force).getByText('Shut down the PC').nextSibling).toHaveTextContent('Needs approval');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await enterCode(user, 'Save the rules', GOOD_CODE, 'Save');
    await screen.findByText('Rules saved.');
    expect(savesOf(fake)).toEqual([{ method: 'PATCH', customerId: CUSTOMER, rev: 0, code: GOOD_CODE, doc: { shutdown: 'approve' } }]);
    expect(requestsOf(fake, 'PATCH', new RegExp(`^/api/rules/${CUSTOMER}$`))).toHaveLength(1);
    // The picker now says the customer has its own rules, and Remove is offered.
    await waitFor(() => expect(within(screen.getByLabelText('Rules for')).getByRole('option', { name: 'Hadar Bakery Ltd (has its own rules)' })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: "Remove this customer's rules" })).toBeInTheDocument();
  });

  test('turning Same as team back on leaves the field out of the document', async () => {
    const fake = fakeWith(MANAGER);
    fake.state.rules.team = teamRules();
    fake.state.rules.overrides[CUSTOMER] = { rev: 1, doc: { restart: 'never', protected_programs: ['Sage.exe'] }, updated_at: 1, updated_by: 'boss@example.com' };
    const user = await openCustomer(fake);
    expect(within(group('Restart the PC')).getByRole('combobox', { name: 'Restart the PC' })).toHaveValue('never');
    expect(within(group('Restart the PC')).getByRole('checkbox', { name: 'Same as team' })).not.toBeChecked();
    expect(within(group('Install a program')).getByRole('checkbox', { name: 'Same as team' })).toBeChecked();
    await user.click(within(group('Restart the PC')).getByRole('checkbox', { name: 'Same as team' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await enterCode(user, 'Save the rules', GOOD_CODE, 'Save');
    await screen.findByText('Rules saved.');
    expect(savesOf(fake)[0]).toMatchObject({ customerId: CUSTOMER, rev: 1, doc: { protected_programs: ['Sage.exe'] } });
    expect(savesOf(fake)[0].doc).not.toHaveProperty('restart');
  });

  test('an hour value for a customer needs hours from the customer or the team', async () => {
    const fake = fakeWith(MANAGER);
    const user = await openCustomer(fake);
    await user.click(within(group('Restart the PC')).getByRole('checkbox', { name: 'Same as team' }));
    const select = within(group('Restart the PC')).getByRole('combobox', { name: 'Restart the PC' });
    expect(within(select).getByRole('option', { name: 'Only outside business hours' })).toBeDisabled();
    // The customer sets hours of its own.
    await user.click(within(group('Business hours')).getByRole('checkbox', { name: 'Same as team' }));
    await user.click(within(group('Business hours')).getByRole('checkbox', { name: 'Monday closed' }));
    expect(within(select).getByRole('option', { name: 'Only outside business hours' })).toBeEnabled();
  });

  test('Remove asks for a code and deletes the override with the revision it read', async () => {
    const fake = fakeWith(MANAGER);
    fake.state.rules.overrides[CUSTOMER] = { rev: 3, doc: { restart: 'never' }, updated_at: 1, updated_by: 'boss@example.com' };
    const user = await openCustomer(fake);
    await user.click(screen.getByRole('button', { name: "Remove this customer's rules" }));
    const dialog = await enterCode(user, 'Remove the rules of Hadar Bakery Ltd', '000000', "Remove this customer's rules");
    expect(await within(dialog).findByText(/That code is wrong/)).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Code from your authenticator app'), GOOD_CODE);
    await user.click(within(dialog).getByRole('button', { name: "Remove this customer's rules" }));
    await screen.findByText("Hadar Bakery Ltd follows the team's rules again.");
    expect(savesOf(fake)).toEqual([{ method: 'DELETE', customerId: CUSTOMER, rev: 3, code: GOOD_CODE }]);
    await waitFor(() => expect(screen.queryByRole('button', { name: "Remove this customer's rules" })).not.toBeInTheDocument());
    expect(within(group('Restart the PC')).getByRole('checkbox', { name: 'Same as team' })).toBeChecked();
  });

  test('a customer that is gone says so and the rules are read again', async () => {
    const fake = fakeWith(MANAGER);
    const user = await openCustomer(fake);
    await user.click(within(group('Restart the PC')).getByRole('checkbox', { name: 'Same as team' }));
    await user.selectOptions(within(group('Restart the PC')).getByRole('combobox', { name: 'Restart the PC' }), 'never');
    fake.state.rulesError = (method) => (method === 'PATCH' ? relayFail(404, 'not_found', 'no such customer') : null);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await enterCode(user, 'Save the rules', GOOD_CODE, 'Save');
    expect(await screen.findByText('That customer no longer exists. The rules are loaded again.')).toBeInTheDocument();
  });

  test('the picker is held while there are unsaved edits', async () => {
    const fake = fakeWith(MANAGER);
    const user = await openRules(fake);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Close a program' }), 'never');
    expect(screen.getByLabelText('Rules for')).toBeDisabled();
    expect(screen.getByText('Save or discard your changes to pick something else.')).toBeInTheDocument();
  });

  test('a reader picks a customer and reads, with no way to change', async () => {
    const fake = fakeWith(READER);
    fake.state.rules.overrides[CUSTOMER] = { rev: 1, doc: { restart: 'never' }, updated_at: 1, updated_by: 'boss@example.com' };
    await openRules(fake);
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText('Rules for'), CUSTOMER);
    await screen.findByText(/Each field is the team's unless you change it/);
    expect(within(group('Restart the PC')).getByRole('combobox', { name: 'Restart the PC' })).toBeDisabled();
    expect(within(group('Restart the PC')).getByRole('checkbox', { name: 'Same as team' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: "Remove this customer's rules" })).not.toBeInTheDocument();
  });
});

describe('Rules on this PC', () => {
  const open = async (fake, name) => {
    renderApp(fake);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: new RegExp(name) }));
    return screen.findByRole('region', { name: 'Rules on this PC' });
  };

  test('a PC with no customer shows the team\'s rules, read only', async () => {
    const fake = fakeWith(READER);
    fake.state.rules.team = { rev: 1, doc: { ...fake.state.rules.team.doc, restart: 'never', hours: HOURS, protected_folders: ['C:\\Customer Data'] }, updated_at: 1, updated_by: 'boss@example.com' };
    fake.state.rules.defaultTimeZone = 'Asia/Jerusalem';
    const section = await open(fake, 'Front counter');
    await within(section).findByText('Never');
    expect(within(section).getByText('Restart the PC').nextSibling).toHaveTextContent('Never');
    expect(within(section).getByText('Close a program').nextSibling).toHaveTextContent('Allowed');
    expect(within(section).getByText(/Monday to Thursday 08:00 to 18:00, Friday 08:00 to 13:00 \(Asia\/Jerusalem\)/)).toBeInTheDocument();
    expect(within(section).getByText('C:\\Customer Data')).toBeInTheDocument();
    expect(within(section).getByText(/The team's rules\./)).toBeInTheDocument();
    expect(within(section).queryByRole('combobox')).not.toBeInTheDocument();
    expect(requestsOf(fake, 'GET', /^\/api\/rules$/)).toHaveLength(1);
  });

  test('a PC under a customer shows the rules in force from the relay: the team\'s with the customer\'s own over them', async () => {
    const fake = fakeWith(READER);
    fake.state.rules.overrides[CUSTOMER] = { rev: 1, doc: { restart: 'never', protected_programs: ['Sage.exe'] }, updated_at: 1, updated_by: 'boss@example.com' };
    const section = await open(fake, 'Back office');
    await within(section).findByText('Sage.exe');
    expect(within(section).getByText('Restart the PC').nextSibling).toHaveTextContent('Never');
    expect(within(section).getByText('Shut down the PC').nextSibling).toHaveTextContent('Needs approval');
    expect(within(section).getByText(/with the changes made for Hadar Bakery Ltd/)).toBeInTheDocument();
    expect(requestsOf(fake, 'GET', new RegExp(`^/api/rules/${CUSTOMER}$`))).toHaveLength(1);
  });

  test('a PC under a customer with no rules of its own says the team\'s rules apply and names no customer', async () => {
    const fake = fakeWith(READER);
    const section = await open(fake, 'Back office');
    await within(section).findByText('Restart the PC');
    expect(within(section).getByText(/The team's rules\. Only people who manage rules change them\./)).toBeInTheDocument();
    expect(within(section).queryByText(/Hadar Bakery Ltd/)).not.toBeInTheDocument();
    expect(within(section).queryByText(/changes made for/)).not.toBeInTheDocument();
  });

  test('its link opens the Rules screen', async () => {
    const fake = fakeWith(READER);
    const section = await open(fake, 'Front counter');
    const user = userEvent.setup();
    await user.click(await within(section).findByRole('button', { name: 'Open the rules' }));
    expect(await screen.findByRole('heading', { name: 'Rules' })).toBeInTheDocument();
  });

  test('rules that cannot be read say so on the PC and leave the rest of it alone', async () => {
    const fake = fakeWith(READER);
    fake.state.rulesError = () => relayFail(500, 'internal', 'down');
    const section = await open(fake, 'Front counter');
    expect(await within(section).findByText(/Could not load the rules for this PC\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument();
  });

  test('a PC waiting for approval has none', async () => {
    const fake = fakeWith(READER);
    fake.state.devices = [device({ id: ID('w'), name: 'Waiting PC', status: 'pending', online: false })];
    renderApp(fake);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Waiting PC/ }));
    await screen.findByRole('heading', { name: 'Waiting PC' });
    expect(screen.queryByRole('region', { name: 'Rules on this PC' })).not.toBeInTheDocument();
  });
});
