import { useEffect, useRef, useState } from 'react';
import { answerApproval, codeProblem, listApprovals, messageOf } from '../api.js';
import { useApp } from '../context.jsx';
import { formatDuration } from '../format.js';
import { useDialog } from '../hooks.js';
import { t } from '../i18n/index.js';

// An action the team's rules send to a technician: what is asked (the relay's summary, built from the action itself), the PC,
// who asks (a person, or the agent that person started) and the time left. Approve needs a fresh code from the approver's
// authenticator; Deny needs none. The wait ends at the time shown, and an answer that comes too late is told as it is.
// The approval is read from the relay when the dialog opens: the notification only says that one waits on a session.
// `account` is the team the approval belongs to; every call is made as it, and nothing is announced if another team is shown by then.
export function ApprovalDialog({ account, sessionId, deviceName = '', onSeen, onAnswered, onClose }) {
  const { core, isShown, devices } = useApp();
  const ref = useDialog();
  const [state, setState] = useState({ phase: 'loading' }); // loading | ready | none | blocked | failed | done
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(null); // 'approve' or 'deny' while its call is on its way
  const [error, setError] = useState(null);
  const [now, setNow] = useState(() => Date.now());
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const load = () => {
    setState({ phase: 'loading' });
    listApprovals(core, account, sessionId).then((list) => {
      if (!alive.current) return;
      const a = list[0] ?? null;
      if (a) onSeen?.(a.id);
      setState(a ? { phase: 'ready', approval: a } : { phase: 'none' });
    }).catch((e) => {
      if (!alive.current) return;
      setState({ phase: e?.code === 'permission_denied' || e?.code === 'forbidden' || e?.status === 403 ? 'blocked' : 'failed', error: e });
    });
  };
  useEffect(load, [core, account, sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  const a = state.approval;
  const left = a ? a.expires_at - now : 0;
  const lapsed = !!a && left <= 0;
  const ok = /^\d{6}$/.test(code);

  async function answer(approve) {
    if (!a || busy || (approve && !ok)) return;
    setBusy(approve ? 'approve' : 'deny');
    setError(null);
    try {
      await answerApproval(core, account, sessionId, a.id, approve, code);
      if (alive.current) setState({ phase: 'done', approval: a, approved: approve });
      onAnswered?.({ approval: a, approved: approve, shown: isShown(account) });
    } catch (e) {
      if (!alive.current) return;
      if (e?.code === 'not_found') setState({ phase: 'none' });
      else if (e?.code === 'permission_denied' || e?.code === 'forbidden') setState({ phase: 'blocked' });
      else { setError(codeProblem(e) ?? messageOf(e, t('approval.failed'))); setCode(''); }
    } finally {
      if (alive.current) setBusy(null);
    }
  }

  const pc = a?.device_name || deviceName || devices.find((d) => d.id === a?.device_id)?.name || '';
  const asker = a ? (a.via === 'agent' ? t('approval.by_agent', { who: a.actor }) : a.actor) : '';

  return (
    <dialog ref={ref} aria-labelledby="approval-h" onClose={onClose} onCancel={onClose}>
      <div className="dlg approval">
        <h2 id="approval-h">{t('approval.title')}</h2>
        {state.phase === 'loading' ? <p role="status">{t('common.loading')}</p> : null}
        {state.phase === 'none' ? <p role="status">{t('approval.none')}</p> : null}
        {state.phase === 'blocked' ? <p role="status">{t('approval.blocked')}</p> : null}
        {state.phase === 'failed' ? <p className="err" role="alert">{messageOf(state.error, t('approval.load_failed'))}</p> : null}
        {state.phase === 'ready' || state.phase === 'done' ? (
          <>
            <p className="approval-ask">{a.summary}</p>
            <dl className="facts approval-facts">
              <dt>{t('approval.pc')}</dt><dd>{pc || t('session.one_off_name')}</dd>
              <dt>{t('approval.asked_by')}</dt><dd>{asker}</dd>
              {state.phase === 'ready' ? <><dt>{t('approval.time_left')}</dt><dd>{lapsed ? t('approval.timed_out') : formatDuration(left)}</dd></> : null}
            </dl>
            <p className="fine">{t('approval.untrusted')}</p>
          </>
        ) : null}
        {state.phase === 'done' ? <p role="status">{state.approved ? t('approval.approved', { pc }) : t('approval.denied')}</p> : null}
        {state.phase === 'ready' ? (
          <>
            {lapsed ? <p role="status">{t('approval.lapsed')}</p> : (
              <div className="form-row">
                <label htmlFor="approval-code">{t('code.label')}</label>
                <input id="approval-code" className="code-in" inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="000000" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
                <span className="help">{t('approval.code_help')}</span>
              </div>
            )}
            {error ? <p className="err" role="alert">{error}</p> : null}
          </>
        ) : null}
        <div className="acts">
          {state.phase === 'ready' && !lapsed ? (
            <>
              <button type="button" className="btn btn-sec" disabled={!!busy} onClick={onClose}>{t('approval.later')}</button>
              <button type="button" className="btn btn-end" disabled={!!busy} onClick={() => answer(false)}>{t('approval.deny')}</button>
              <button type="button" className="btn btn-pri" disabled={!ok || !!busy} onClick={() => answer(true)}>{t('approval.approve')}</button>
            </>
          ) : state.phase === 'failed' ? (
            <>
              <button type="button" className="btn btn-sec" onClick={onClose}>{t('common.close')}</button>
              <button type="button" className="btn btn-pri" onClick={load}>{t('common.try_again')}</button>
            </>
          ) : <button type="button" className="btn btn-sec" onClick={onClose}>{t('common.close')}</button>}
        </div>
      </div>
    </dialog>
  );
}
