import { useState } from 'react';
import { messageOf } from '../api.js';
import { useApp } from '../context.jsx';
import { t } from '../i18n/index.js';

// Signing in: the relay's address and the team, then the browser. The default relay and the
// team "default" are filled in, so most people only press the button.
export function SignInForm({ relay = '', team = 'default', lockRelay = false, onDone, onCancel }) {
  const { core, appInfo } = useApp();
  const [relayText, setRelay] = useState(relay || appInfo?.default_relay || '');
  const [teamText, setTeam] = useState(team);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setError(null);
    setWaiting(true);
    try {
      const account = await core.signIn(relayText, teamText);
      // The caller's follow-up (reading the accounts again) may fail; the sign-in itself worked.
      Promise.resolve(onDone?.(account)).catch(() => {});
    } catch (err) {
      setError(messageOf(err, t('signin.failed')));
    } finally {
      setWaiting(false);
    }
  }

  async function cancel() {
    try {
      await core.signInCancel();
    } catch (_) {
      // nothing was open
    }
    onCancel?.();
  }

  return (
    <form onSubmit={submit}>
      <div className="form-row">
        <label htmlFor="signin-relay">{t('signin.relay')}</label>
        <input id="signin-relay" type="text" inputMode="url" autoComplete="off" spellCheck={false} placeholder="support.example.com" value={relayText} onChange={(e) => setRelay(e.target.value)} readOnly={lockRelay} disabled={waiting} />
        <span className="help">{t('signin.relay_help')}</span>
      </div>
      <div className="form-row">
        <label htmlFor="signin-team">{t('signin.team')}</label>
        <input id="signin-team" type="text" autoComplete="off" spellCheck={false} value={teamText} onChange={(e) => setTeam(e.target.value)} disabled={waiting} />
        <span className="help">{t('signin.team_help')}</span>
      </div>
      {error ? <p className="err" role="alert">{error}</p> : null}
      {waiting ? (
        <div className="status" role="status"><span className="spinner" aria-hidden="true" /><span>{t('signin.waiting')}</span></div>
      ) : null}
      <div className="connect-row">
        <button type="submit" className="btn btn-pri" disabled={waiting || !relayText.trim() || !teamText.trim()}>{t('signin.button')}</button>
        {waiting ? <button type="button" className="btn btn-sec" onClick={cancel}>{t('common.cancel')}</button> : onCancel ? <button type="button" className="btn btn-sec" onClick={onCancel}>{t('common.cancel')}</button> : null}
      </div>
    </form>
  );
}

// The first screen when no one is signed in.
export function SignIn({ accounts = [] }) {
  const { go, setActive, reloadAccounts } = useApp();
  const signedOut = accounts.find((a) => !a.signed_in);
  return (
    <div className="signin">
      <h1>{t('signin.title')}</h1>
      <p className="hint">{signedOut ? t('signin.signed_out_text') : t('signin.intro')}</p>
      <SignInForm relay={signedOut?.relay ?? ''} team={signedOut?.team ?? 'default'} onDone={async (account) => { await reloadAccounts(); setActive(account.id); go('devices'); }} />
      <p className="fine">{t('signin.fine')}</p>
    </div>
  );
}
