import { useEffect, useState } from 'react';
import { listPeople, refusalText } from '../api.js';
import { useApp } from '../context.jsx';
import { useDialog } from '../hooks.js';
import { t } from '../i18n/index.js';
import { same } from '../session.js';

// Invites a colleague to watch a session. The people come from people_list, under the account the
// session belongs to (a session tab may belong to a team that is not the one on screen). Only people
// whose role can control sessions are offered, and nobody who is already in the session. Names are
// the team's, shown as text.
export function InviteDialog({ account, participants, onInvite, onClose }) {
  const { core, me } = useApp();
  const ref = useDialog();
  const [people, setPeople] = useState(null);
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let live = true;
    listPeople(core, account)
      .then((list) => live && setPeople(list))
      .catch((e) => live && setError(refusalText(e, t('invite.load_failed'))));
    return () => { live = false; };
  }, [core, account]);

  const here = new Set(participants.map((p) => p.identity.toLowerCase()));
  const choices = (people ?? []).filter((p) => p.can_control && !same(p.identity, me.identity) && !here.has(String(p.identity).toLowerCase()));

  async function submit(e) {
    e.preventDefault();
    if (!pick || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onInvite(pick, choices.find((c) => c.identity === pick));
      onClose();
    } catch (err) {
      setError(refusalText(err, t('invite.failed')));
      setBusy(false);
    }
  }

  return (
    <dialog ref={ref} aria-labelledby="invite-h" onClose={onClose} onCancel={onClose}>
      <form className="dlg" onSubmit={submit}>
        <h2 id="invite-h">{t('invite.title')}</h2>
        <p>{t('invite.text')}</p>
        {people === null && !error ? <p className="hint" role="status">{t('common.loading')}</p> : null}
        {people !== null && choices.length === 0 ? <p className="hint">{t('invite.none')}</p> : null}
        {choices.length ? (
          <fieldset className="pick">
            <legend className="sr">{t('invite.title')}</legend>
            {choices.map((p) => (
              <label key={p.identity} className="toggle">
                <input type="radio" name="invitee" value={p.identity} checked={pick === p.identity} onChange={() => setPick(p.identity)} />
                <span><span className="t-name">{p.name || p.identity}</span>{p.name ? <span className="t-help">{p.identity}</span> : null}</span>
              </label>
            ))}
          </fieldset>
        ) : null}
        {error ? <p className="err" role="alert">{error}</p> : null}
        <div className="acts">
          <button type="button" className="btn btn-sec" onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" className="btn btn-pri" disabled={!pick || busy}>{t('invite.send')}</button>
        </div>
      </form>
    </dialog>
  );
}
