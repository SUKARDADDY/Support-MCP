import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test } from 'vitest';
import { ID, ToolFail, device, fakeCore, renderApp } from '../test-utils.jsx';

const row = (name) => screen.getByRole('button', { name: new RegExp(name) });

describe('Devices', () => {
  test('lists the saved PCs with their status, access and site, and counts on the chips', async () => {
    renderApp();
    expect(await screen.findByRole('button', { name: /Front counter/ })).toBeInTheDocument();
    expect(row('Front counter')).toHaveTextContent('Online');
    expect(row('Front counter')).toHaveTextContent('Any time');
    expect(row('Back office')).toHaveTextContent("Hadar's Bakery");
    expect(row('Back office')).toHaveTextContent('Asks first');
    expect(row('Kitchen screen')).toHaveTextContent('Offline');
    expect(screen.getByRole('heading', { name: /Devices/ })).toHaveTextContent('2 of 3 online');
    const filters = screen.getByRole('group', { name: 'Filter devices' });
    expect(within(filters).getByRole('button', { name: /^All 3/ })).toBeInTheDocument();
    expect(within(filters).getByRole('button', { name: /^Online 2/ })).toBeInTheDocument();
    expect(within(filters).getByRole('button', { name: /^Offline 1/ })).toBeInTheDocument();
    expect(within(filters).getByRole('button', { name: /^Any time 2/ })).toBeInTheDocument();
    expect(within(filters).getByRole('button', { name: /^Asks first 1/ })).toBeInTheDocument();
    expect(within(filters).queryByRole('button', { name: /^Waiting/ })).not.toBeInTheDocument();
  });

  test('search and the chips narrow the list, and an empty result offers a way back', async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole('button', { name: /Front counter/ });
    await user.type(screen.getByRole('searchbox', { name: 'Search devices' }), 'bakery');
    expect(screen.queryByRole('button', { name: /Front counter/ })).not.toBeInTheDocument();
    expect(row('Back office')).toBeInTheDocument();
    await user.clear(screen.getByRole('searchbox'));
    await user.click(screen.getByRole('button', { name: /^Offline/ }));
    expect(screen.queryByRole('button', { name: /Back office/ })).not.toBeInTheDocument();
    expect(row('Kitchen screen')).toBeInTheDocument();
    await user.type(screen.getByRole('searchbox'), 'zzz');
    expect(screen.getByText(/No devices match/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show all devices' }));
    expect(row('Front counter')).toBeInTheDocument();
  });

  test('selecting a PC shows its detail and Connect, and an offline PC explains why it cannot', async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole('button', { name: /Back office/ }));
    const detail = screen.getByRole('region', { name: 'Device details' });
    expect(within(detail).getByRole('heading', { name: 'Back office' })).toBeInTheDocument();
    expect(within(detail).getByText('Someone at the PC clicks Allow before each connection. The owner chose this when they set up Support.')).toBeInTheDocument();
    expect(within(detail).getByRole('button', { name: 'Connect' })).toBeEnabled();
    expect(within(detail).getByText('Someone at Back office is asked to click Allow.')).toBeInTheDocument();
    expect(within(detail).getByText(ID('b'))).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Kitchen screen/ }));
    expect(within(detail).getByRole('button', { name: 'Connect' })).toBeDisabled();
    expect(within(detail).getByText('Kitchen screen is offline')).toBeInTheDocument();
  });

  test('with no saved PCs it says how to add one', async () => {
    renderApp(fakeCore({ devices: [] }));
    expect(await screen.findByText('No saved devices yet')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Add a device' }).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Send a one-off link' })).toBeInTheDocument();
  });

  test('when the relay cannot be reached the list says so and offers a retry', async () => {
    const fake = fakeCore();
    fake.core.tool.mockImplementation(async () => { throw Object.assign(new Error('Could not reach the relay.'), { code: 'unavailable' }); });
    renderApp(fake);
    expect(await screen.findByText('Could not load the devices')).toBeInTheDocument();
    expect(screen.getByText('Could not reach the relay.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  test('a PC that asked to join is listed first and is approved with the six digits', async () => {
    const user = userEvent.setup();
    const fake = fakeCore({ devices: [device({ id: ID('w'), name: 'Reception', status: 'pending', online: true, expires_at: Date.now() + 600000 }), device()] });
    renderApp(fake);
    const rows = await screen.findAllByRole('button', { name: /Reception|Front counter/ });
    expect(rows[0]).toHaveTextContent('Reception');
    expect(rows[0]).toHaveTextContent('Waiting for approval');
    expect(screen.getByRole('button', { name: /^Waiting 1/ })).toBeInTheDocument();
    await user.click(rows[0]);
    const detail = screen.getByRole('region', { name: 'Device details' });
    expect(within(detail).queryByRole('button', { name: 'Connect' })).not.toBeInTheDocument();
    const approve = within(detail).getByRole('button', { name: 'Approve' });
    expect(approve).toBeDisabled();
    await user.type(within(detail).getByLabelText('Six-digit number shown on the PC'), '12a345');
    expect(within(detail).getByLabelText('Six-digit number shown on the PC')).toHaveValue('12345');
    await user.type(within(detail).getByLabelText('Six-digit number shown on the PC'), '6');
    await user.click(approve);
    await waitFor(() => expect(fake.calls.some((c) => c.kind === 'request' && c.args[0] === 'PATCH' && c.args[2]?.approve?.confirm === '123456')).toBe(true));
    expect(await screen.findByText('Reception is approved and added to your devices.')).toBeInTheDocument();
  });

  test('a wrong approval number is explained in plain words', async () => {
    const user = userEvent.setup();
    const fake = fakeCore({ devices: [device({ id: ID('w'), name: 'Reception', status: 'pending', expires_at: Date.now() + 600000 })] });
    fake.state.approveError = Object.assign(new Error('that number does not match the one on the PC'), { code: 'confirm_wrong', status: 403 });
    renderApp(fake);
    await user.click(await screen.findByRole('button', { name: /Reception/ }));
    await user.type(screen.getByLabelText('Six-digit number shown on the PC'), '999999');
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That number does not match the one on the PC.');
  });

  test('a role without devices.manage sees no approve form', async () => {
    const user = userEvent.setup();
    const fake = fakeCore({ permissions: ['devices.view', 'sessions.view'], devices: [device({ id: ID('w'), name: 'Reception', status: 'pending', expires_at: Date.now() + 600000 })] });
    renderApp(fake);
    await user.click(await screen.findByRole('button', { name: /Reception/ }));
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.getByText(/Your role cannot approve PCs/)).toBeInTheDocument();
  });
});

describe('Connect', () => {
  test('a PC set to any time connects and opens its session tab', async () => {
    const user = userEvent.setup();
    const fake = fakeCore();
    renderApp(fake);
    await user.click(await screen.findByRole('button', { name: /Front counter/ }));
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    const tab = await screen.findByRole('tab', { name: /Front counter/ });
    expect(tab).toHaveAttribute('aria-selected', 'true');
    expect(fake.calls.find((c) => c.kind === 'tool' && c.args[0] === 'device_connect').args[1]).toEqual({ device_id: ID('a') });
  });

  test('when the person at the PC is asked, the screen says so, then opens the tab once they allow it', async () => {
    const user = userEvent.setup();
    const fake = fakeCore();
    const sid = 'e'.repeat(64);
    let polls = 0;
    fake.state.connect = () => ({ session_id: sid, state: 'waiting', asks: true, rang: true });
    fake.state.sessionStatus = () => ({ state: ++polls < 3 ? 'waiting' : 'attached', driver: 'tech@example.com', log: [] });
    renderApp(fake);
    await user.click(await screen.findByRole('button', { name: /Back office/ }));
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByText('Waiting for someone at Back office to click Allow')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Back office/ })).toHaveTextContent('Waiting for the owner');
    await screen.findByRole('tab', { name: /Back office/ });
  });

  test('a declined request says so and offers to ask again', async () => {
    const user = userEvent.setup();
    const fake = fakeCore();
    fake.state.connect = () => ({ session_id: 'd'.repeat(64), state: 'waiting', asks: true, rang: true });
    fake.state.sessionStatus = () => ({ state: 'ended', ended_reason: 'declined', log: [] });
    renderApp(fake);
    await user.click(await screen.findByRole('button', { name: /Back office/ }));
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByText('Back office declined the request')).toBeInTheDocument();
    expect(screen.getByText('Support did not connect, and nothing changed on that PC.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ask again' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument();
  });

  test('nobody signed in and a busy PC have their own words', async () => {
    const user = userEvent.setup();
    for (const [reason, text] of [['nobody', 'Nobody was signed in at Back office'], ['busy', 'Back office was busy with another request']]) {
      const fake = fakeCore();
      fake.state.connect = () => ({ session_id: 'd'.repeat(64), state: 'waiting', asks: false, rang: true });
      fake.state.sessionStatus = () => ({ state: 'ended', ended_reason: reason, log: [] });
      const { unmount } = renderApp(fake);
      await user.click(await screen.findByRole('button', { name: /Back office/ }));
      await user.click(screen.getByRole('button', { name: 'Connect' }));
      expect(await screen.findByText(text)).toBeInTheDocument();
      unmount();
    }
  });

  test('someone else is connected: the relay words show, and Take over appears only with sessions.unattended', async () => {
    const user = userEvent.setup();
    const busy = () => new ToolFail('lead@example.com is connected');
    let fake = fakeCore();
    fake.state.connect = busy;
    const first = renderApp(fake);
    await user.click(await screen.findByRole('button', { name: /Front counter/ }));
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByText('lead@example.com is connected')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Take over' })).not.toBeInTheDocument();
    first.unmount();

    fake = fakeCore({ permissions: ['devices.view', 'sessions.control', 'sessions.view', 'sessions.unattended'] });
    let n = 0;
    fake.state.connect = (args) => (args.take_over ? { session_id: 't'.repeat(64), state: 'attached', asks: false, rang: true } : (n++, busy()));
    renderApp(fake);
    await user.click(await screen.findByRole('button', { name: /Front counter/ }));
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    await user.click(await screen.findByRole('button', { name: 'Take over' }));
    await screen.findByRole('tab', { name: /Front counter/ });
    expect(fake.calls.filter((c) => c.kind === 'tool' && c.args[0] === 'device_connect').at(-1).args[1]).toEqual({ device_id: ID('a'), take_over: true });
    expect(n).toBe(1);
  });

  test('cancelling a request ends the session it made', async () => {
    const user = userEvent.setup();
    const fake = fakeCore();
    const sid = 'c'.repeat(64);
    fake.state.connect = () => ({ session_id: sid, state: 'waiting', asks: true, rang: true });
    fake.state.sessionStatus = () => ({ state: 'waiting', log: [] });
    renderApp(fake);
    await user.click(await screen.findByRole('button', { name: /Back office/ }));
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel request' }));
    await waitFor(() => expect(fake.state.ended).toEqual([sid]));
    expect(await screen.findByRole('button', { name: 'Connect' })).toBeEnabled();
  });

  test('a role that cannot start sessions cannot connect', async () => {
    const user = userEvent.setup();
    renderApp(fakeCore({ permissions: ['devices.view', 'sessions.view'] }));
    await user.click(await screen.findByRole('button', { name: /Front counter/ }));
    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled();
    expect(screen.getByText('Your role cannot start sessions on saved PCs.')).toBeInTheDocument();
  });
});
