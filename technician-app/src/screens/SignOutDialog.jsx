import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n/index.js';

// Asks before signing out of a team. Signing out ends this PC's sign-in on the relay and
// removes it here; the team's PCs and data are not touched.
export function SignOutDialog({ account, onConfirm, onClose }) {
  const ref = useRef(null);
  const [busy, setBusy] = useState(false);
  const name = account.team_name || account.team;

  useEffect(() => {
    const d = ref.current;
    if (!d) return undefined;
    if (typeof d.showModal === 'function') d.showModal();
    else d.setAttribute('open', '');
    return () => {
      if (d.open && typeof d.close === 'function') d.close();
    };
  }, []);

  async function confirm() {
    if (busy) return;
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      onClose();
    }
  }

  return (
    <dialog ref={ref} aria-labelledby="signout-h" onClose={onClose} onCancel={onClose}>
      <div className="dlg">
        <h2 id="signout-h">{t('settings.sign_out_title', { name })}</h2>
        <p>{t('settings.sign_out_text')}</p>
        <div className="acts">
          <button type="button" className="btn btn-sec" onClick={onClose} disabled={busy}>{t('common.cancel')}</button>
          <button type="button" className="btn btn-pri" onClick={confirm} disabled={busy}>{busy ? t('settings.signing_out') : t('settings.sign_out')}</button>
        </div>
      </div>
    </dialog>
  );
}
