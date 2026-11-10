import { useEffect, useRef, useState } from 'react';
import { createOneOff, messageOf } from '../api.js';
import { Icon } from '../components/Icon.jsx';
import { useApp } from '../context.jsx';
import { t } from '../i18n/index.js';

// A link for a PC you will help once: the customer opens it, runs the app and clicks Allow.
// Nothing is saved to the device list.
export function OneOffLink({ onClose }) {
  const { core, account, copyText, can } = useApp();
  const ref = useRef(null);
  const [link, setLink] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const accountRef = useRef(account.id);
  accountRef.current = account.id;
  // A link belongs to the team that made it.
  useEffect(() => { setLink(null); setError(null); setBusy(false); }, [account.id]);

  useEffect(() => {
    const d = ref.current;
    if (!d) return undefined;
    if (typeof d.showModal === 'function') d.showModal();
    else d.setAttribute('open', '');
    return () => {
      if (d.open && typeof d.close === 'function') d.close();
    };
  }, []);

  async function make() {
    setBusy(true);
    setError(null);
    const owner = account.id;
    try {
      const out = await createOneOff(core, owner);
      // A link made for the team that was shown a moment ago is not this team's.
      if (accountRef.current === owner) setLink(out.download_url);
    } catch (e) {
      if (accountRef.current === owner) setError(messageOf(e, t('link.failed')));
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog ref={ref} aria-labelledby="link-h" onClose={onClose} onCancel={onClose}>
      <div className="dlg">
        {link ? (
          <>
            <h2 id="link-h">{t('link.ready_title')}</h2>
            <p>{t('link.ready_text')}</p>
            <div className="linkbox">
              <label className="sr" htmlFor="link-url">{t('link.field')}</label>
              <input id="link-url" readOnly value={link} onFocus={(e) => e.target.select()} />
              <button type="button" className="btn btn-pri btn-sm" onClick={() => copyText(link, t('link.copied'))}><Icon name="copy" />{t('common.copy')}</button>
            </div>
            <div className="acts"><button type="button" className="btn btn-sec" onClick={onClose}>{t('common.close')}</button></div>
          </>
        ) : (
          <>
            <h2 id="link-h">{t('link.title')}</h2>
            <p>{t('link.text')}</p>
            <p>{t('link.text2')}</p>
            {can('sessions.create') ? null : <p className="err">{t('link.no_permission')}</p>}
            {error ? <p className="err" role="alert">{error}</p> : null}
            <div className="acts">
              <button type="button" className="btn btn-sec" onClick={onClose}>{t('common.cancel')}</button>
              <button type="button" className="btn btn-pri" onClick={make} disabled={busy || !can('sessions.create')}><Icon name="link" />{t('link.create')}</button>
            </div>
          </>
        )}
      </div>
    </dialog>
  );
}
