import { useRef, useState } from 'react';
import { createPairing, fetchDevices, listPairings, messageOf } from '../api.js';
import { Icon } from '../components/Icon.jsx';
import { useApp } from '../context.jsx';
import { formatDuration } from '../format.js';
import { useInterval } from '../hooks.js';
import { t } from '../i18n/index.js';

// Pairing a PC: make a code, the owner enters it on the PC, and the PC appears in the list.
// The code is shown once and works once, within ten minutes.
export function AddDevice() {
  const { core, account, can, toast, reloadDevices, select, go, copyText, tuning } = useApp();
  const [pairing, setPairing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [added, setAdded] = useState(null);
  const [used, setUsed] = useState(false); // the code is no longer live, but its PC has not shown up yet
  const [now, setNow] = useState(() => Date.now());
  const baseline = useRef(new Set());
  const expired = pairing ? now >= pairing.expires_at && !used : false;
  const live = !!pairing && !added && !used && !expired;
  const waiting = !!pairing && !added && !expired;

  useInterval(() => setNow(Date.now()), 1000, live);

  // Watch the team's PCs for one that was not there when the code was made. When none has
  // appeared, ask whether the code is still live: a code that is gone before it ran out was
  // used (or revoked), so the countdown stops.
  useInterval(async () => {
    const list = await fetchDevices(core, account.id);
    const fresh = list.find((d) => !baseline.current.has(d.id));
    if (fresh) {
      setAdded(fresh);
      reloadDevices();
      return;
    }
    try {
      const codes = await listPairings(core, account.id);
      // Not in the list while it still has time left (a margin for the two clocks): it was used.
      if (!codes.some((c) => c.id === pairing.id) && Date.now() < pairing.expires_at - 3000) setUsed(true);
    } catch (_) {
      // the next look tries again
    }
  }, tuning.watchMs, waiting, { immediate: false });

  async function makeCode() {
    setBusy(true);
    setError(null);
    setAdded(null);
    setUsed(false);
    try {
      const before = await fetchDevices(core, account.id);
      baseline.current = new Set(before.map((d) => d.id));
      const made = await createPairing(core, account.id);
      setPairing(made);
      setNow(Date.now());
    } catch (e) {
      setError(messageOf(e, t('add.code_failed')));
    } finally {
      setBusy(false);
    }
  }

  if (!can('devices.manage')) {
    return <div className="page"><div className="page-in"><h1>{t('add.title')}</h1><p className="hint">{t('add.no_permission')}</p></div></div>;
  }

  return (
    <div className="page">
      <div className="page-in">
        <h1 tabIndex={-1}>{t('add.title')}</h1>
        <p className="hint">{t('add.intro')}</p>
        <ol className="steps">
          <li>{t('add.step1')}</li>
          <li>
            {t('add.step2')}
            {added ? (
              <p className="hint" data-testid="pairing-done">{t('add.code_used_by', { name: added.name })}</p>
            ) : used ? (
              <p className="hint" data-testid="pairing-done">{t('add.code_used')}</p>
            ) : pairing && !expired ? (
              <div>
                <span className="pair" data-testid="pairing-code">{pairing.code}</span>
                <div className="hint">{t('add.code_works_once', { left: formatDuration(Math.max(0, pairing.expires_at - now)) })}</div>
                <div className="connect-row mt-8">
                  <button type="button" className="btn btn-sec btn-sm" onClick={() => copyText(pairing.code, t('add.copied_code'))}><Icon name="copy" />{t('add.copy_code')}</button>
                  {pairing.link ? <button type="button" className="btn btn-sec btn-sm" onClick={() => copyText(pairing.link, t('add.copied_link'))}><Icon name="link" />{t('add.copy_link')}</button> : null}
                </div>
              </div>
            ) : (
              <div>
                {expired ? <p className="hint">{t('add.expired')}</p> : null}
                <button type="button" className="btn btn-pri" onClick={makeCode} disabled={busy}>{expired ? t('add.new_code') : t('add.get_code')}</button>
              </div>
            )}
          </li>
          <li>{t('add.step3')}</li>
        </ol>
        {error ? <p className="err" role="alert">{error}</p> : null}
        {added ? (
          <>
            <div className="status ok" role="status"><Icon name="checkc" /><span>{added.status === 'pending' ? t('add.waiting_approval', { name: added.name }) : t('add.added', { name: added.name, access: t(`access.${added.access}.title`).toLowerCase() })}</span></div>
            <button type="button" className="btn btn-pri" onClick={() => { select(added.id); go('devices'); toast(null); }}>{t('add.view', { name: added.name })}</button>
          </>
        ) : waiting ? (
          <div className="status" role="status"><span className="spinner" aria-hidden="true" /><span>{used ? t('add.waiting_join') : t('add.waiting')}</span></div>
        ) : null}
      </div>
    </div>
  );
}
