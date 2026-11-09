import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { ACCOUNT, ID, device, fakeCore, renderApp } from '../test-utils.jsx';

const nav = (name) => screen.getByRole('navigation', { name: 'Main' }).querySelector(`button`) && within(screen.getByRole('navigation', { name: 'Main' })).getByRole('button', { name: new RegExp(name) });

describe('Add a device', () => {
  test('makes a pairing code on request, shows it with its link, and notices the new PC', async () => {
    const user = userEvent.setup();
    const fake = fakeCore();
    renderApp(fake);
    await screen.findByRole('button', { name: /Front counter/ });
    await user.click(nav('Add a device'));
    expect(screen.queryByTestId('pairing-code')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Get a pairing code' }));
    expect(await screen.findByTestId('pairing-code')).toHaveTextContent('K7Q42-M9H3X');
    expect(screen.getByText(/Works once\. \d+:\d\d left\./)).toBeInTheDocument();
    expect(fake.calls.some((c) => c.kind === 'request' && c.args[0] === 'POST' && c.args[1] === '/api/pairing')).toBe(true);
    expect(await screen.findByText('Waiting for the PC to enter the code.')).toBeInTheDocument();
    // The owner enters the code: a PC the list did not have appears.
    fake.state.devices = [...fake.state.devices, device({ id: ID('n'), name: 'Bar till 2', access: 'ask' })];
    expect(await screen.findByText('Added Bar till 2. Access: asks first.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'View Bar till 2' }));
    expect(await screen.findByRole('heading', { name: 'Bar till 2' })).toBeInTheDocument();
  });

  test('once the PC shows up the countdown is replaced by a done state that names it', async () => {
    const user = userEvent.setup();
    const fake = fakeCore();
    renderApp(fake);
    await screen.findByRole('button', { name: /Front counter/ });
    await user.click(nav('Add a device'));
    await user.click(screen.getByRole('button', { name: 'Get a pairing code' }));
    expect(await screen.findByTestId('pairing-code')).toBeInTheDocument();
    expect(screen.getByText(/Works once\. \d+:\d\d left\./)).toBeInTheDocument();
    fake.state.pairingUsed = true;
    fake.state.devices = [...fake.state.devices, device({ id: ID('n'), name: 'Bar till 2', access: 'ask' })];
    expect(await screen.findByTestId('pairing-done')).toHaveTextContent('Code used by Bar till 2.');
    expect(screen.queryByText(/Works once/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('pairing-code')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy code' })).not.toBeInTheDocument();
  });

  test('a code that is no longer listed as live stops its countdown before the PC appears', async () => {
    const user = userEvent.setup();
    const fake = fakeCore();
    renderApp(fake);
    await screen.findByRole('button', { name: /Front counter/ });
    await user.click(nav('Add a device'));
    await user.click(screen.getByRole('button', { name: 'Get a pairing code' }));
    await screen.findByTestId('pairing-code');
    fake.state.pairingUsed = true;
    expect(await screen.findByTestId('pairing-done')).toHaveTextContent('The code was used.');
    expect(screen.queryByText(/Works once/)).not.toBeInTheDocument();
    expect(screen.getByText('Waiting for the PC to finish joining.')).toBeInTheDocument();
    // The PC arrives.
    fake.state.devices = [...fake.state.devices, device({ id: ID('n'), name: 'Bar till 2', access: 'ask' })];
    expect(await screen.findByText('Code used by Bar till 2.')).toBeInTheDocument();
  });

  test('an expired code is replaced by a button for a new one', async () => {
    const user = userEvent.setup();
    const fake = fakeCore();
    fake.state.pairing = { ...fake.state.pairing, expires_at: Date.now() + 1200 };
    renderApp(fake);
    await screen.findByRole('button', { name: /Front counter/ });
    await user.click(nav('Add a device'));
    await user.click(screen.getByRole('button', { name: 'Get a pairing code' }));
    await screen.findByTestId('pairing-code');
    expect(await screen.findByText('That code ran out.', {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Get a new code' })).toBeInTheDocument();
  });

  test('a role without devices.manage is told so', async () => {
    const user = userEvent.setup();
    renderApp(fakeCore({ permissions: ['devices.view'] }));
    await screen.findByRole('button', { name: /Front counter/ });
    await user.click(nav('Add a device'));
    expect(await screen.findByText(/Your role cannot add devices/)).toBeInTheDocument();
  });
});

describe('One-off link', () => {
  test('creates a link and copies it', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const fake = fakeCore();
    renderApp(fake);
    await screen.findByRole('button', { name: /Front counter/ });
    await user.click(nav('One-off link'));
    const dialog = screen.getByRole('dialog', { hidden: true });
    expect(within(dialog).getByText('Send a one-off link')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Create link' }));
    const input = await within(dialog).findByLabelText('One-off link');
    expect(input).toHaveValue('https://relay.example/j/abcdefghijklmnop?client=app');
    await user.click(within(dialog).getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('https://relay.example/j/abcdefghijklmnop?client=app');
    expect(await screen.findByText('Link copied. It works once, within 10 minutes.')).toBeInTheDocument();
    expect(fake.calls.some((c) => c.kind === 'tool' && c.args[0] === 'session_create')).toBe(true);
  });
});

describe('Notifications', () => {
  const item = (over) => ({ account: 'acc1', id: 1, event: 'device_waiting', at: Date.now() - 120000, title: 'Reception is waiting', body: 'Enter the six digits', device_id: ID('a'), task_id: null, session_id: null, ...over });

  test('shows the recent items, adds new ones from the feed, and opens the PC', async () => {
    const user = userEvent.setup();
    const fake = fakeCore({ recent: [item()] });
    renderApp(fake);
    await screen.findByRole('button', { name: /Front counter/ });
    await user.click(nav('Notifications'));
    const list = await screen.findByRole('list', { name: 'Recent' });
    expect(within(list).getByText('Reception is waiting')).toBeInTheDocument();
    expect(within(list).getByText('2 minutes ago')).toBeInTheDocument();
    act(() => fake.emit('feed://items', { account: 'acc1', live: true, items: [{ id: 2, event: 'task_finished', at: Date.now(), title: 'Task finished', body: 'Printer fixed', device_id: ID('b'), task_id: null, session_id: null }] }));
    expect(await within(list).findByText('Task finished')).toBeInTheDocument();
    await user.click(within(list).getAllByRole('button', { name: 'Open the PC' })[0]);
    expect(await screen.findByRole('heading', { name: 'Back office' })).toBeInTheDocument();
  });

  test('a live item counts as unread until the list is opened', async () => {
    const user = userEvent.setup();
    const fake = fakeCore();
    renderApp(fake);
    await screen.findByRole('button', { name: /Front counter/ });
    await waitFor(() => expect(fake.core.on).toHaveBeenCalled());
    act(() => fake.emit('feed://items', { account: 'acc1', live: true, items: [{ id: 7, event: 'device_waiting', at: Date.now(), title: 'x', body: 'y', device_id: ID('a'), task_id: null, session_id: null }] }));
    expect(await screen.findByLabelText('1 new')).toBeInTheDocument();
    await user.click(nav('Notifications'));
    expect(screen.queryByLabelText('1 new')).not.toBeInTheDocument();
  });

  test('an item the feed repeats is listed once and counted once', async () => {
    const user = userEvent.setup();
    const fake = fakeCore({ recent: [item({ id: 3 })] });
    renderApp(fake);
    await screen.findByRole('button', { name: /Front counter/ });
    await waitFor(() => expect(fake.core.on).toHaveBeenCalled());
    const again = { id: 7, event: 'task_finished', at: Date.now(), title: 'Task finished', body: 'Printer fixed', device_id: ID('a'), task_id: null, session_id: null };
    // An item the list already holds, then a new one sent twice in one batch and again later.
    act(() => fake.emit('feed://items', { account: 'acc1', live: true, items: [{ ...again, id: 3 }, again, again] }));
    act(() => fake.emit('feed://items', { account: 'acc1', live: true, items: [again] }));
    expect(await screen.findByLabelText('1 new')).toBeInTheDocument();
    await user.click(nav('Notifications'));
    const list = await screen.findByRole('list', { name: 'Recent' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
  });

  test('the body of a waiting-for-approval item is labelled as the PC\'s own text', async () => {
    const user = userEvent.setup();
    renderApp(fakeCore({ recent: [item(), item({ id: 2, event: 'task_finished', body: 'Printer fixed' })] }));
    await screen.findByRole('button', { name: /Front counter/ });
    await user.click(nav('Notifications'));
    const list = await screen.findByRole('list', { name: 'Recent' });
    const [waiting, finished] = within(list).getAllByRole('listitem');
    const wait = [waiting, finished].find((li) => li.dataset.event === 'device_waiting');
    const done = [waiting, finished].find((li) => li.dataset.event === 'task_finished');
    expect(wait).toHaveTextContent('Text from the PC: Enter the six digits');
    expect(done).not.toHaveTextContent('Text from the PC');
  });

  test('Recent and Settings are tabs with a panel, and the arrow keys move between them', async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole('button', { name: /Front counter/ });
    await user.click(nav('Notifications'));
    const recent = await screen.findByRole('tab', { name: 'Recent' });
    const panel = document.getElementById(recent.getAttribute('aria-controls'));
    expect(panel).toHaveAttribute('role', 'tabpanel');
    expect(panel).toHaveAttribute('aria-labelledby', recent.id);
    recent.focus();
    await user.keyboard('{ArrowRight}');
    const settings = screen.getByRole('tab', { name: 'Settings' });
    expect(settings).toHaveAttribute('aria-selected', 'true');
    expect(settings).toHaveFocus();
    expect(panel).toHaveAttribute('aria-labelledby', settings.id);
    expect(recent).toHaveAttribute('tabindex', '-1');
  });

  test('says what the list is for when it is empty', async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole('button', { name: /Front counter/ });
    await user.click(nav('Notifications'));
    expect(await screen.findByText(/Nothing yet/)).toBeInTheDocument();
  });

  test('a clicked Windows notification opens its PC', async () => {
    const fake = fakeCore();
    renderApp(fake);
    await screen.findByRole('button', { name: /Front counter/ });
    await waitFor(() => expect(fake.core.on).toHaveBeenCalledWith('ui://open', expect.any(Function)));
    act(() => fake.emit('ui://open', { account: 'acc1', device_id: ID('b'), task_id: null, session_id: null }));
    expect(await screen.findByRole('heading', { name: 'Back office' })).toBeInTheDocument();
  });
});

describe('Notification settings', () => {
  test('each event is a switch that saves at once, and PCs can be watched', async () => {
    const user = userEvent.setup();
    const fake = fakeCore();
    renderApp(fake);
    await screen.findByRole('button', { name: /Front counter/ });
    await user.click(nav('Notifications'));
    await user.click(screen.getByRole('tab', { name: 'Settings' }));
    const panel = await screen.findByText('What you hear about');
    expect(panel).toBeInTheDocument();
    for (const name of ['A task finished', 'A task needs you', 'A session was turned down', 'A PC you watch came online', 'A PC went missing', 'A PC is waiting for approval']) {
      expect(screen.getByRole('checkbox', { name: new RegExp(`^${name}`) })).toBeChecked();
    }
    await user.click(screen.getByRole('checkbox', { name: /^A task finished/ }));
    await waitFor(() => expect(fake.state.patches).toEqual([{ events: { task_finished: false } }]));
    expect(screen.getByRole('checkbox', { name: /^A task finished/ })).not.toBeChecked();

    await user.click(screen.getByRole('checkbox', { name: 'Back office' }));
    await waitFor(() => expect(fake.state.patches.at(-1)).toEqual({ watch: [ID('b')] }));
    expect(screen.queryByRole('checkbox', { name: 'Kitchen screen' })).toBeInTheDocument();
  });

  test('a save that fails puts the switch back and says so', async () => {
    const user = userEvent.setup();
    const fake = fakeCore();
    renderApp(fake);
    await screen.findByRole('button', { name: /Front counter/ });
    await user.click(nav('Notifications'));
    await user.click(screen.getByRole('tab', { name: 'Settings' }));
    await screen.findByText('What you hear about');
    fake.state.requestError = (method) => (method === 'PATCH' ? Object.assign(new Error('The relay is busy.'), { code: 'unavailable' }) : null);
    await user.click(screen.getByRole('checkbox', { name: /^A PC went missing/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The relay is busy.');
    expect(screen.getByRole('checkbox', { name: /^A PC went missing/ })).toBeChecked();
  });

  test('Windows notifications can be switched off for this PC', async () => {
    const user = userEvent.setup();
    const fake = fakeCore();
    renderApp(fake);
    await screen.findByRole('button', { name: /Front counter/ });
    await user.click(nav('Notifications'));
    await user.click(screen.getByRole('tab', { name: 'Settings' }));
    await user.click(await screen.findByRole('checkbox', { name: /^Show Windows notifications/ }));
    await waitFor(() => expect(fake.state.prefs).toEqual({ desktop_notifications: false }));
  });
});

describe('Settings', () => {
  beforeEach(() => document.documentElement.removeAttribute('data-mode'));

  test('lists the accounts, offers the other teams, and removes one', async () => {
    const user = userEvent.setup();
    const fake = fakeCore();
    renderApp(fake);
    await screen.findByRole('button', { name: /Front counter/ });
    await user.click(nav('Settings'));
    const accounts = await screen.findByRole('region', { name: 'Accounts' });
    expect(within(accounts).getByText('Default')).toBeInTheDocument();
    expect(within(accounts).getByText(/tech@example.com · https:\/\/relay.example/)).toBeInTheDocument();
    await user.click(await within(accounts).findByRole('button', { name: 'Sign in to Acme Support' }));
    expect(within(accounts).getByLabelText('Relay address')).toHaveValue('https://relay.example');
    expect(within(accounts).getByLabelText('Team')).toHaveValue('acme');
    await user.click(within(accounts).getByRole('button', { name: 'Sign in with your browser' }));
    await waitFor(() => expect(fake.core.signIn).toHaveBeenCalledWith('https://relay.example', 'acme'));
  });

  test('the theme is light, dark or the same as Windows, and is remembered', async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole('button', { name: /Front counter/ });
    await user.click(nav('Settings'));
    const group = await screen.findByRole('group', { name: 'Appearance' });
    await user.click(within(group).getByRole('button', { name: 'Dark' }));
    expect(document.documentElement.dataset.mode).toBe('dark');
    expect(localStorage.getItem('support.theme')).toBe('dark');
    await user.click(within(group).getByRole('button', { name: 'Light' }));
    expect(document.documentElement.dataset.mode).toBe('light');
    expect(within(group).getByRole('button', { name: 'Light' })).toHaveAttribute('aria-pressed', 'true');
  });

  test('start with Windows is off until chosen', async () => {
    const user = userEvent.setup();
    const fake = fakeCore();
    renderApp(fake);
    await screen.findByRole('button', { name: /Front counter/ });
    await user.click(nav('Settings'));
    const box = await screen.findByRole('checkbox', { name: /^Start Support when I sign in to Windows/ });
    expect(box).not.toBeChecked();
    await user.click(box);
    await waitFor(() => expect(fake.core.setAutostart).toHaveBeenCalledWith(true));
    expect(box).toBeChecked();
  });

  test('when the platform parts are missing the section says so', async () => {
    const user = userEvent.setup();
    const fake = fakeCore({ autostart: null, update: null });
    renderApp(fake);
    await screen.findByRole('button', { name: /Front counter/ });
    await user.click(nav('Settings'));
    expect(await screen.findByText('Starting with Windows is not available in this build.')).toBeInTheDocument();
    expect(screen.getByText('Version 0.7.0')).toBeInTheDocument();
  });

  test('updates say what was found and install at the next start', async () => {
    const user = userEvent.setup();
    const fake = fakeCore({ update: { current: '0.7.0', available: '0.8.0', state: 'ready', checked_at: Date.now(), message: null } });
    renderApp(fake);
    await screen.findByRole('button', { name: /Front counter/ });
    await user.click(nav('Settings'));
    expect(await screen.findByText('Version 0.8.0 is ready. It installs the next time the app starts.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Check for updates' }));
    expect(fake.core.checkForUpdate).toHaveBeenCalled();
  });

  test('a failed update check shows the core\'s message in en.json\'s words', async () => {
    const user = userEvent.setup();
    const fake = fakeCore({ update: { current: '0.7.0', available: null, state: 'error', checked_at: Date.now(), message: 'English text from the core', reason: 'update_signature' } });
    renderApp(fake);
    await screen.findByRole('button', { name: /Front counter/ });
    await user.click(nav('Settings'));
    expect(await screen.findByText(/Could not update: The update's signature did not check out, so it was ignored\./)).toBeInTheDocument();
    expect(screen.queryByText(/English text from the core/)).not.toBeInTheDocument();
  });

  test('signing out asks first, and Cancel signs nothing out', async () => {
    const user = userEvent.setup();
    const fake = fakeCore();
    renderApp(fake);
    await screen.findByRole('button', { name: /Front counter/ });
    await user.click(nav('Settings'));
    expect(screen.queryByRole('button', { name: /^Remove/ })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Sign out of Default on this PC' }));
    const dialog = screen.getByRole('dialog', { hidden: true });
    expect(within(dialog).getByRole('heading', { name: 'Sign out of Default?', hidden: true })).toBeInTheDocument();
    expect(within(dialog).getByText(/ends this PC's sign-in to the team on the relay/)).toBeInTheDocument();
    expect(fake.core.signOut).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel', hidden: true }));
    expect(screen.queryByRole('dialog', { hidden: true })).not.toBeInTheDocument();
    expect(fake.core.signOut).not.toHaveBeenCalled();
  });

  test('the hint under start with Windows says what it does, not what the default is', async () => {
    const user = userEvent.setup();
    renderApp(fakeCore({ autostart: true }));
    await screen.findByRole('button', { name: /Front counter/ });
    await user.click(nav('Settings'));
    const box = await screen.findByRole('checkbox', { name: /^Start Support when I sign in to Windows/ });
    await waitFor(() => expect(box).toBeChecked());
    expect(box.closest('label')).not.toHaveTextContent(/off by default/i);
    expect(box.closest('label')).toHaveTextContent('Support starts hidden in the tray when you sign in to Windows, so notifications reach you.');
  });

  test('the native window follows the theme: system at start, then each choice', async () => {
    const user = userEvent.setup();
    const fake = fakeCore();
    renderApp(fake);
    await screen.findByRole('button', { name: /Front counter/ });
    await waitFor(() => expect(fake.core.setWindowTheme).toHaveBeenCalledWith('system'));
    await user.click(nav('Settings'));
    const group = await screen.findByRole('group', { name: 'Appearance' });
    await user.click(within(group).getByRole('button', { name: 'Dark' }));
    await waitFor(() => expect(fake.core.setWindowTheme).toHaveBeenLastCalledWith('dark'));
    await user.click(within(group).getByRole('button', { name: 'Light' }));
    await waitFor(() => expect(fake.core.setWindowTheme).toHaveBeenLastCalledWith('light'));
  });

  test('a failure setting the native theme is not shown or thrown', async () => {
    const fake = fakeCore();
    fake.core.setWindowTheme.mockRejectedValue(new Error('not allowed'));
    renderApp(fake);
    expect(await screen.findByRole('button', { name: /Front counter/ })).toBeInTheDocument();
    await waitFor(() => expect(fake.core.setWindowTheme).toHaveBeenCalled());
  });

  test('signing out of the only account, once confirmed, returns to sign in', async () => {
    const user = userEvent.setup();
    const fake = fakeCore();
    renderApp(fake);
    await screen.findByRole('button', { name: /Front counter/ });
    await user.click(nav('Settings'));
    await user.click(await screen.findByRole('button', { name: 'Sign out of Default on this PC' }));
    await user.click(within(screen.getByRole('dialog', { hidden: true })).getByRole('button', { name: 'Sign out', hidden: true }));
    await waitFor(() => expect(fake.core.signOut).toHaveBeenCalledWith(ACCOUNT.id));
    fake.emit('account://changed', { account: ACCOUNT.id });
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });
});

describe('Sign in', () => {
  test('shows the default relay and team, and signs in through the browser', async () => {
    const user = userEvent.setup();
    const fake = fakeCore({ accounts: [] });
    renderApp(fake);
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByLabelText('Relay address')).toHaveValue('https://default.example');
    expect(screen.getByLabelText('Team')).toHaveValue('default');
    await user.click(screen.getByRole('button', { name: 'Sign in with your browser' }));
    await waitFor(() => expect(fake.core.signIn).toHaveBeenCalledWith('https://default.example', 'default'));
    expect(await screen.findByRole('button', { name: /Front counter/ })).toBeInTheDocument();
  });

  test('a failed sign-in shows the reason and the form stays', async () => {
    const user = userEvent.setup();
    const fake = fakeCore({ accounts: [] });
    fake.state.signInError = Object.assign(new Error('This relay has no team with that name, or sign-in is not set up on it.'), { code: 'invalid' });
    renderApp(fake);
    await user.click(await screen.findByRole('button', { name: 'Sign in with your browser' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This relay has no team with that name');
    expect(screen.getByRole('button', { name: 'Sign in with your browser' })).toBeEnabled();
  });

  test('a failure of the core\'s own is shown in en.json\'s words, not the core\'s English', async () => {
    const user = userEvent.setup();
    const fake = fakeCore({ accounts: [] });
    fake.state.signInError = Object.assign(new Error('English text from the core'), { code: 'invalid', reason: 'no_team' });
    renderApp(fake);
    await user.click(await screen.findByRole('button', { name: 'Sign in with your browser' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('This relay has no team with that name, or sign-in is not set up on it.');
    expect(alert).not.toHaveTextContent('English text from the core');
  });

  test('a follow-up that fails after a good sign-in raises nothing unhandled', async () => {
    const user = userEvent.setup();
    const fake = fakeCore({ accounts: [] });
    // The accounts cannot be read again right after the sign-in. (The test setup fails the test on an unhandled rejection.)
    fake.core.accounts.mockImplementationOnce(async () => []).mockImplementation(async () => { throw new Error('the core is busy'); });
    renderApp(fake);
    await user.click(await screen.findByRole('button', { name: 'Sign in with your browser' }));
    await waitFor(() => expect(fake.core.signIn).toHaveBeenCalled());
    await waitFor(() => expect(fake.core.accounts).toHaveBeenCalledTimes(2));
  });

  test('an account whose sign-in ended asks to sign in again, on the same relay', async () => {
    const fake = fakeCore({ accounts: [{ ...ACCOUNT, signed_in: false }] });
    renderApp(fake);
    expect(await screen.findByText('You were signed out. Sign in again to carry on.')).toBeInTheDocument();
    expect(screen.getByLabelText('Relay address')).toHaveValue('https://relay.example');
  });
});

describe('Text from customer PCs', () => {
  const attack = '<img src=x onerror="document.title=\'pwned\'"><script>document.title="pwned"</script>';

  test('names, sites and notifications are shown as text, never as markup', async () => {
    const user = userEvent.setup();
    const fake = fakeCore({
      devices: [device({ name: attack, site_id: ID('s'), os: attack })],
      sites: [{ id: ID('s'), customer_id: ID('k'), name: attack }],
      recent: [{ account: 'acc1', id: 1, event: 'task_finished', at: Date.now(), title: attack, body: attack, device_id: null, task_id: null, session_id: null }],
    });
    const { container } = renderApp(fake);
    expect((await screen.findAllByText(attack, { exact: false })).length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: new RegExp(attack.slice(0, 12).replace(/[<]/g, '\\<')) }));
    await user.click(nav('Notifications'));
    await screen.findAllByText(attack);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(document.title).not.toBe('pwned');
  });
});
