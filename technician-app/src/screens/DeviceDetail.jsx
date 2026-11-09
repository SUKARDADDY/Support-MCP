import { useState } from 'react';
import { approveDevice, messageOf } from '../api.js';
import { Icon, Thread } from '../components/Icon.jsx';
import { useApp } from '../context.jsx';
import { declinedKey } from '../connections.js';
import { deviceStatus, placeLabel } from '../devices.js';
import { formatAgo, formatDate, formatDateTime } from '../format.js';
import { t } from '../i18n/index.js';
import { AgentStartDialog } from './AgentStartDialog.jsx';

// One saved PC: who it belongs to, how it can be reached, and the way in. Names, sites and
// the owner's text come from people and from the PC, so they are shown as text only.
export function DeviceDetail({ device }) {
  const app = useApp();
  const { places, conns, can, openSessionTab, sessionTabFor, showTab } = app;
  const conn = conns[device.id] ?? null;
  const st = deviceStatus(device, conn);
  const place = placeLabel(device, places);
  const [agentOpen, setAgentOpen] = useState(false);
  const busyElsewhere = Object.values(conns).some((c) => c.deviceId !== device.id && (c.phase === 'connecting' || c.phase === 'awaiting'));

  return (
    <div className="d-in">
      <h2 className="dname" tabIndex={-1}>{device.name}</h2>
      <p className="dsub">
        {place ? <>{place}<span className="sep" aria-hidden="true">|</span></> : null}
        <Thread kind={st.mark} /><b>{t(`status.${st.word}`)}</b>
        <span className="sep" aria-hidden="true">|</span>
        {device.online && device.os ? device.os : device.lastSeen ? t('device.last_seen', { when: formatAgo(device.lastSeen) }) : t('device.never_seen')}
      </p>

      {device.status === 'pending' ? <Approve device={device} /> : (
        <>
          <section className="access" aria-label={t('access.section')}>
            <Icon name={device.access === 'any' ? 'key' : 'bell'} />
            <h3>{t(`access.${device.access}.title`)}</h3>
            <p>{t(`access.${device.access}.tech`)}</p>
          </section>
          <ConnectArea device={device} conn={conn} busyElsewhere={busyElsewhere} />
          {can('sessions.control') && device.online && !conn ? (
            <div className="connect-row">
              <button type="button" className="btn btn-sec" onClick={() => setAgentOpen(true)}>{t('agent.hand_over')}</button>
              <p className="hint">{t('agent.hand_over_hint')}</p>
            </div>
          ) : null}
        </>
      )}

      <dl className="facts">
        {device.pairedAt ? <><dt>{t('facts.paired')}</dt><dd>{formatDate(device.pairedAt)}</dd></> : null}
        {device.online || device.lastSeen ? <><dt>{t('facts.last_seen')}</dt><dd>{device.online ? t('facts.online_now') : formatDateTime(device.lastSeen)}</dd></> : null}
        {device.os ? <><dt>{t('facts.windows')}</dt><dd>{device.os}</dd></> : null}
        {device.control ? <><dt>{t('facts.control')}</dt><dd>{t(`control.${device.control}`)}</dd></> : null}
        {device.appVersion ? <><dt>{t('facts.app_version')}</dt><dd>{device.appVersion}</dd></> : null}
        <dt>{t('facts.device_id')}</dt><dd className="mono">{device.id}</dd>
      </dl>
      <p className="fine">{t('device.owner_changes')}</p>
      {agentOpen ? <AgentStartDialog device={device} onClose={() => setAgentOpen(false)} onStarted={(started) => { const open = sessionTabFor(device.id); if (open) showTab(open.key); else openSessionTab({ device, taskId: started.task_id }); }} /> : null}
    </div>
  );
}

function ConnectArea({ device, conn, busyElsewhere }) {
  const { connect, cancelConnect, dismissConnect, sessionTabFor, showTab, can } = useApp();
  const openTab = sessionTabFor(device.id);
  const mayConnect = can('sessions.control');
  const takeOverOk = can('sessions.unattended');

  if (conn?.phase === 'connecting') {
    return <div className="connect-row"><button type="button" className="btn btn-connect" disabled><span className="spinner" aria-hidden="true" />{t('connect.connecting')}</button><button type="button" className="btn btn-sec btn-sm" onClick={() => cancelConnect(device.id)}>{t('connect.cancel')}</button></div>;
  }
  if (conn?.phase === 'awaiting') {
    return (
      <div className="wait" role="status">
        <h3>{t('connect.awaiting_title', { name: device.name })}</h3>
        <p>{t('connect.awaiting_text')}</p>
        <button type="button" className="btn btn-sec btn-sm" onClick={() => cancelConnect(device.id)}>{t('connect.cancel_request')}</button>
      </div>
    );
  }
  if (conn?.phase === 'declined') {
    return (
      <div className="note bad" role="status">
        <h3>{t(declinedKey(conn.reason), { name: device.name })}</h3>
        <p>{t('connect.nothing_changed')}</p>
        <div className="acts">
          <button type="button" className="btn btn-pri btn-sm" onClick={() => connect(device)}>{t('connect.ask_again')}</button>
          <button type="button" className="btn btn-sec btn-sm" onClick={() => dismissConnect(device.id)}>{t('common.close')}</button>
        </div>
      </div>
    );
  }
  if (conn?.phase === 'error') {
    const someoneElse = /is connected$/.test(conn.message ?? '');
    return (
      <div className="note bad" role="alert">
        <h3>{someoneElse ? t('connect.in_use') : t('connect.failed')}</h3>
        <p>{conn.message || t('connect.failed_generic')}</p>
        <div className="acts">
          {someoneElse && takeOverOk ? <button type="button" className="btn btn-pri btn-sm" onClick={() => connect(device, { takeOver: true })}>{t('connect.take_over')}</button> : null}
          <button type="button" className="btn btn-sec btn-sm" onClick={() => dismissConnect(device.id)}>{t('common.close')}</button>
        </div>
      </div>
    );
  }
  if (busyElsewhere) {
    return <><div className="connect-row"><button type="button" className="btn btn-connect" disabled>{t('connect.button')}</button></div><p className="hint">{t('connect.busy_elsewhere')}</p></>;
  }
  if (!device.online) {
    return (
      <>
        <div className="connect-row"><button type="button" className="btn btn-connect" disabled aria-describedby="off-why">{t('connect.button')}</button></div>
        <div className="note off" id="off-why">
          <h3>{t('connect.offline_title', { name: device.name })}</h3>
          <p>{device.lastSeen ? t('connect.offline_seen', { when: formatDateTime(device.lastSeen) }) : t('connect.offline_text')}</p>
        </div>
      </>
    );
  }
  if (!mayConnect) {
    return <><div className="connect-row"><button type="button" className="btn btn-connect" disabled>{t('connect.button')}</button></div><p className="hint">{t('connect.no_permission')}</p></>;
  }
  return (
    <div className="connect-row">
      <button type="button" className="btn btn-connect" onClick={() => connect(device)}>{t('connect.button')}</button>
      <p className="hint">{device.access === 'any' ? t('connect.hint_any') : t('connect.hint_ask', { name: device.name })}</p>
      {openTab ? <button type="button" className="btn btn-sec btn-sm" onClick={() => showTab(openTab.key)}>{t('connect.open_session')}</button> : null}
    </div>
  );
}

// A PC that asked to join and shows six digits to its owner. Whoever reads them out proves
// the person at the PC wants it added.
function Approve({ device }) {
  const { core, account, reloadDevices, toast, can } = useApp();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const ok = /^\d{6}$/.test(value);

  async function submit(e) {
    e.preventDefault();
    if (!ok || busy) return;
    setBusy(true);
    setError(null);
    try {
      await approveDevice(core, account.id, device.id, value);
      toast(t('approve.done', { name: device.name }));
      await reloadDevices();
    } catch (err) {
      setError(err?.code === 'confirm_wrong' ? t('approve.wrong') : err?.code === 'not_pending' ? t('approve.not_pending') : messageOf(err, t('approve.failed')));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="approve">
      <h3>{t('approve.title', { name: device.name })}</h3>
      <p>{t('approve.text')}{device.expiresAt ? ` ${t('approve.expires', { when: formatDateTime(device.expiresAt) })}` : ''}</p>
      <p className="fine">{t('approve.name_from_pc')}</p>
      {can('devices.manage') ? (
        <form onSubmit={submit}>
          <label className="sr" htmlFor="approve-code">{t('approve.label')}</label>
          <input id="approve-code" inputMode="numeric" autoComplete="off" maxLength={6} placeholder="000000" value={value} onChange={(e) => setValue(e.target.value.replace(/\D/g, ''))} />
          <button type="submit" className="btn btn-pri" disabled={!ok || busy}>{t('approve.button')}</button>
        </form>
      ) : <p>{t('approve.no_permission')}</p>}
      {error ? <p className="err" role="alert">{error}</p> : null}
    </div>
  );
}
