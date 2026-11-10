import { useCallback, useEffect, useRef, useState } from 'react';
import { claimEscalation, closeEscalation, listQueue, refusalText } from '../api.js';
import { useApp } from '../context.jsx';
import { formatAgo } from '../format.js';
import { tabKeyDown, useDialog, useInterval, useLoad } from '../hooks.js';
import { t } from '../i18n/index.js';
import { same } from '../session.js';
import { NOTE_MAX } from './EscalateDialog.jsx';

const STATUSES = ['open', 'mine', 'closed'];

// The team's escalation queue: sessions and PCs a technician could not finish, and stuck agent
// tasks that need a person. Open (nobody has claimed it), Mine (opened or claimed by you, not
// closed) and Closed. A live item's claim makes you the driver and opens its session; a ticket's
// claim opens the PC. Notes, summaries and PC names were written by people and by an agent that
// read a customer's PC, so they are shown as text and labelled as such.
export function Queue() {
  const { core, account, me, can, now, toast, openTarget, openSessionTab, tabForSession, showTab, refreshQueue, queueTick, tuning, visible, isShown } = useApp();
  const [status, setStatus] = useState('open');
  const [busy, setBusy] = useState(null); // the id of the item a claim is on its way for
  const [error, setError] = useState(null);
  const [closing, setClosing] = useState(null);
  const { data, error: loadError, loading, reload } = useLoad(async () => ({ status, items: await listQueue(core, account.id, status) }), [core, account.id, status]);
  const shown = data && data.status === status ? data.items : null;

  // The list is read when the screen is shown and after a change, and again when the window is shown or focused again,
  // when a queue notice arrives, and every 30 seconds while the screen is on show: another person may have claimed or
  // closed an item meanwhile. A hidden window reads nothing.
  useEffect(() => { refreshQueue(); }, [account.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const again = useCallback(() => { reload(); refreshQueue(); }, [reload, refreshQueue]);
  const againRef = useRef(again);
  againRef.current = again;
  useInterval(() => againRef.current(), tuning.queueMs, visible, { immediate: false });
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (visible) againRef.current();
  }, [visible, queueTick]);
  useEffect(() => {
    const onFocus = () => { if (visible) againRef.current(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [visible]);

  async function claim(item) {
    const owner = account.id;
    setBusy(item.id);
    setError(null);
    try {
      const out = await claimEscalation(core, owner, item.id);
      // The claim stands whichever team is shown now; what it opens depends on that.
      if (out.session_id) {
        openSessionTab({ deviceId: out.device_id ?? null, deviceName: out.device_name ?? (out.device_id ? '' : t('session.one_off_name')), sessionId: out.session_id, accountOf: owner });
        if (isShown(owner)) toast(t('queue.claimed_live'));
      } else if (isShown(owner)) {
        if (out.device_id) {
          toast(t('queue.claimed_ticket', { name: out.device_name || t('queue.a_pc') }));
          openTarget({ account: owner, device_id: out.device_id });
        } else {
          toast(t('queue.claimed_one_off'));
        }
      }
    } catch (e) {
      if (isShown(owner)) setError(refusalText(e, t('queue.claim_failed')));
    } finally {
      setBusy(null);
      refreshQueue(owner);
      if (isShown(owner)) reload();
    }
  }

  async function close(item, note) {
    const owner = account.id;
    await closeEscalation(core, owner, item.id, note);
    refreshQueue(owner);
    if (isShown(owner)) {
      toast(t('queue.closed_toast'));
      reload();
    }
  }

  const mayClose = (e) => !e.closed_at && (same(e.claimed_by, me.identity) || same(e.opened_by, me.identity) || can('members.manage'));

  return (
    <div className="page">
      <div className="page-in">
        <h1 tabIndex={-1}>{t('queue.title')}</h1>
        <p className="hint">{t('queue.hint')}</p>
        <div className="subtabs" role="tablist" aria-label={t('queue.tabs')} onKeyDown={tabKeyDown}>
          {STATUSES.map((s) => (
            <button key={s} type="button" role="tab" id={`queue-tab-${s}`} aria-controls="queue-panel" aria-selected={status === s} tabIndex={status === s ? 0 : -1} onClick={() => { setStatus(s); setError(null); }}>{t(`queue.status_${s}`)}</button>
          ))}
        </div>
        <div role="tabpanel" id="queue-panel" aria-labelledby={`queue-tab-${status}`}>
          {error ? <p className="err" role="alert">{error}</p> : null}
          {shown === null && loadError ? (
            <div role="alert"><p className="err">{refusalText(loadError, t('queue.load_failed'))}</p><button type="button" className="btn btn-sec" onClick={reload}>{t('common.try_again')}</button></div>
          ) : shown === null ? (
            <p className="hint" role="status">{loading ? t('common.loading') : null}</p>
          ) : shown.length === 0 ? (
            <p className="hint">{t(`queue.empty_${status}`)}</p>
          ) : (
            <>
              <p className="fine">{t('queue.untrusted')}</p>
              <ul className="queue" aria-label={t(`queue.status_${status}`)}>
                {shown.map((e) => {
                  const sessionTab = e.session_id ? tabForSession(e.session_id) : null;
                  return (
                    <li key={e.id} data-kind={e.kind}>
                      <div className="q-head">
                        <span className="q-title">{e.device_name || (e.device_id ? t('queue.a_pc') : t('queue.one_off'))}</span>
                        <span className="q-kind">{t(e.kind === 'agent' ? 'queue.kind_agent' : 'queue.kind_technician')}</span>
                        <span className="q-time">{formatAgo(e.opened_at, now)}</span>
                      </div>
                      <p className="q-from">{e.kind === 'agent' ? t('queue.started_by', { who: e.opened_by }) : t('queue.opened_by', { who: e.opened_by })}</p>
                      {e.summary ? <p className="q-text"><b>{t('queue.summary')}</b> {e.summary}</p> : null}
                      {e.note ? <p className="q-text"><b>{t('queue.note')}</b> {e.note}</p> : null}
                      {e.claimed_by ? <p className="q-from">{t('queue.claimed_by', { who: e.claimed_by })}</p> : null}
                      {e.closed_at ? <p className="q-from">{t('queue.closed_by', { who: e.closed_by ?? '', when: formatAgo(e.closed_at, now) })}</p> : null}
                      {e.close_note ? <p className="q-text"><b>{t('queue.close_note')}</b> {e.close_note}</p> : null}
                      <div className="q-acts">
                        {!e.claimed_by && !e.closed_at && can('sessions.control') ? (
                          <button type="button" className="btn btn-pri btn-sm" disabled={busy === e.id} onClick={() => claim(e)}>{t('queue.claim')}</button>
                        ) : null}
                        {mayClose(e) ? <button type="button" className="btn btn-sec btn-sm" onClick={() => setClosing(e)}>{t('queue.close')}</button> : null}
                        {e.device_id ? <button type="button" className="btn btn-sec btn-sm" onClick={() => openTarget({ account: account.id, device_id: e.device_id })}>{t('queue.open_pc')}</button> : null}
                        {sessionTab ? <button type="button" className="btn btn-sec btn-sm" onClick={() => showTab(sessionTab.key)}>{t('queue.open_session')}</button> : null}
                        {e.task_id ? <button type="button" className="btn btn-sec btn-sm" onClick={() => openTarget({ account: account.id, task_id: e.task_id, device_id: e.device_id })}>{t('queue.open_task')}</button> : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      </div>
      {closing ? <CloseDialog onClose={() => setClosing(null)} onSend={(note) => close(closing, note)} /> : null}
    </div>
  );
}

function CloseDialog({ onSend, onClose }) {
  const ref = useDialog();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSend(note.trim());
      onClose();
    } catch (err) {
      setError(refusalText(err, t('queue.close_failed')));
      setBusy(false);
    }
  }

  return (
    <dialog ref={ref} aria-labelledby="close-item-h" onClose={onClose} onCancel={onClose}>
      <form className="dlg" onSubmit={submit}>
        <h2 id="close-item-h">{t('queue.close_title')}</h2>
        <p>{t('queue.close_text')}</p>
        <div className="form-row">
          <label htmlFor="close-note">{t('queue.close_note_label')}</label>
          <textarea id="close-note" rows={4} maxLength={NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        {error ? <p className="err" role="alert">{error}</p> : null}
        <div className="acts">
          <button type="button" className="btn btn-sec" onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" className="btn btn-pri" disabled={busy}>{t('queue.close_send')}</button>
        </div>
      </form>
    </dialog>
  );
}
