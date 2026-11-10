import { useState } from 'react';
import { refusalText } from '../api.js';
import { useDialog } from '../hooks.js';
import { t } from '../i18n/index.js';

export const NOTE_MAX = 600;

// Sends the session to the team's queue with a note, for whoever is free to pick it up. The driver
// stays in the session until someone claims it.
export function EscalateDialog({ onSend, onClose }) {
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
      setError(refusalText(err, t('escalate.failed')));
      setBusy(false);
    }
  }

  return (
    <dialog ref={ref} aria-labelledby="escalate-h" onClose={onClose} onCancel={onClose}>
      <form className="dlg" onSubmit={submit}>
        <h2 id="escalate-h">{t('escalate.title')}</h2>
        <p>{t('escalate.text')}</p>
        <div className="form-row">
          <label htmlFor="escalate-note">{t('escalate.note')}</label>
          <textarea id="escalate-note" rows={5} maxLength={NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('escalate.placeholder')} />
          <span className="help">{t('escalate.count', { count: note.length, max: NOTE_MAX })}</span>
        </div>
        {error ? <p className="err" role="alert">{error}</p> : null}
        <div className="acts">
          <button type="button" className="btn btn-sec" onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" className="btn btn-pri" disabled={busy}>{t('escalate.send')}</button>
        </div>
      </form>
    </dialog>
  );
}
