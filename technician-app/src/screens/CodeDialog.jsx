import { useState } from 'react';
import { codeProblem, messageOf } from '../api.js';
import { useDialog } from '../hooks.js';
import { t } from '../i18n/index.js';

// Asks for a fresh code from the person's authenticator app before a change that needs one (saving rules, removing an
// override). `onConfirm(code)` makes the call: it returns when the change is done (the dialog closes) and throws the
// relay's refusal otherwise, which is told here in plain words and leaves the dialog open for another code.
export function CodeDialog({ title, text, confirmLabel, onConfirm, onClose }) {
  const ref = useDialog();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const ok = /^\d{6}$/.test(code);

  async function submit(e) {
    e.preventDefault();
    if (!ok || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(code);
      onClose();
    } catch (err) {
      setError(codeProblem(err) ?? messageOf(err, t('code.failed')));
      setCode('');
      setBusy(false);
    }
  }

  return (
    <dialog ref={ref} aria-labelledby="code-h" onClose={onClose} onCancel={onClose}>
      <form className="dlg" onSubmit={submit}>
        <h2 id="code-h">{title}</h2>
        <p>{text}</p>
        <div className="form-row">
          <label htmlFor="code-in">{t('code.label')}</label>
          <input id="code-in" className="code-in" inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="000000" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
          <span className="help">{t('code.help')}</span>
        </div>
        {error ? <p className="err" role="alert">{error}</p> : null}
        <div className="acts">
          <button type="button" className="btn btn-sec" onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" className="btn btn-pri" disabled={!ok || busy}>{confirmLabel}</button>
        </div>
      </form>
    </dialog>
  );
}
