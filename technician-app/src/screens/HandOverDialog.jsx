import { useState } from 'react';
import { refusalText } from '../api.js';
import { useDialog } from '../hooks.js';
import { t } from '../i18n/index.js';

// Offers control of the session to someone who is watching it. The offer lasts two minutes and the
// colleague has to accept. Names are the team's, shown as text.
export function HandOverDialog({ watchers, taskLive, onOffer, onClose }) {
  const ref = useDialog();
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    if (!pick || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onOffer(pick, watchers.find((w) => w.identity === pick));
      onClose();
    } catch (err) {
      setError(refusalText(err, t('handover.failed')));
      setBusy(false);
    }
  }

  return (
    <dialog ref={ref} aria-labelledby="handover-h" onClose={onClose} onCancel={onClose}>
      <form className="dlg" onSubmit={submit}>
        <h2 id="handover-h">{t('handover.title')}</h2>
        <p>{t('handover.text')}</p>
        {taskLive ? <p className="hint">{t('handover.task_stops')}</p> : null}
        {watchers.length === 0 ? <p className="hint">{t('handover.none')}</p> : (
          <fieldset className="pick">
            <legend className="sr">{t('handover.title')}</legend>
            {watchers.map((p) => (
              <label key={p.identity} className="toggle">
                <input type="radio" name="new-driver" value={p.identity} checked={pick === p.identity} onChange={() => setPick(p.identity)} />
                <span><span className="t-name">{p.name || p.identity}</span>{p.name ? <span className="t-help">{p.identity}</span> : null}</span>
              </label>
            ))}
          </fieldset>
        )}
        {error ? <p className="err" role="alert">{error}</p> : null}
        <div className="acts">
          <button type="button" className="btn btn-sec" onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" className="btn btn-pri" disabled={!pick || busy}>{t('handover.offer')}</button>
        </div>
      </form>
    </dialog>
  );
}
