import { useEffect, useState } from 'react';
import { listTeams, messageOf, reasonText } from '../api.js';
import { useApp } from '../context.jsx';
import { formatAgo } from '../format.js';
import { useLoad } from '../hooks.js';
import { t } from '../i18n/index.js';
import { THEMES } from '../theme.js';
import { SignInForm } from './SignIn.jsx';
import { SignOutDialog } from './SignOutDialog.jsx';

// Accounts, how the app looks, whether it starts with Windows, and updates.
export function Settings() {
  const { core, accounts, account, theme, setTheme, appInfo, toast, setActive, reloadAccounts } = useApp();
  const [adding, setAdding] = useState(null); // null, or { relay, team } for the sign-in form
  const [leaving, setLeaving] = useState(null); // the account the person is asked to sign out of
  const [autostart, setAutostart] = useState(undefined); // undefined: loading, null: not available
  const [update, setUpdate] = useState(undefined);
  const teams = useLoad(() => (account ? listTeams(core, account.id) : []), [core, account?.id]);
  const others = (teams.data ?? []).filter((x) => !accounts.some((a) => a.relay === account?.relay && a.team === x.slug && a.signed_in));

  useEffect(() => { core.autostart().then(setAutostart).catch(() => setAutostart(null)); }, [core]);
  useEffect(() => { core.updateStatus().then(setUpdate).catch(() => setUpdate(null)); }, [core]);

  // Signs out of an account once the person has confirmed: the core asks the relay to revoke
  // the sign-in, then removes the account and its tokens from this PC.
  async function signOut(a) {
    try {
      await core.signOut(a.id);
      await reloadAccounts();
    } catch (e) {
      toast(messageOf(e, t('settings.sign_out_failed')));
    }
  }

  async function changeAutostart(on) {
    const before = autostart;
    setAutostart(on);
    try {
      await core.setAutostart(on);
    } catch (e) {
      setAutostart(before);
      toast(messageOf(e, t('settings.autostart_failed')));
    }
  }

  async function checkNow() {
    setUpdate((u) => ({ ...(u ?? {}), state: 'checking' }));
    try {
      setUpdate(await core.checkForUpdate());
    } catch (e) {
      toast(messageOf(e, t('settings.update_failed')));
      setUpdate(await core.updateStatus().catch(() => null));
    }
  }

  return (
    <div className="page">
      <div className="page-in">
        <h1 tabIndex={-1}>{t('settings.title')}</h1>

        <section className="panel" aria-labelledby="set-accounts">
          <h2 id="set-accounts">{t('settings.accounts')}</h2>
          <p className="hint">{t('settings.accounts_hint')}</p>
          {accounts.map((a) => (
            <div className="account" key={a.id}>
              <div className="who">
                <b>{a.team_name || a.team}</b>
                <span>{a.email ? `${a.email} · ` : ''}{a.relay}{a.signed_in ? '' : ` · ${t('settings.signed_out')}`}</span>
              </div>
              {!a.signed_in ? <button type="button" className="btn btn-pri btn-sm" onClick={() => setAdding({ relay: a.relay, team: a.team })}>{t('settings.sign_in_again')}</button> : a.id !== account?.id ? <button type="button" className="btn btn-sec btn-sm" onClick={() => setActive(a.id)}>{t('settings.use_team')}</button> : null}
              <button type="button" className="btn btn-sec btn-sm" onClick={() => setLeaving(a)} aria-label={t('settings.sign_out_label', { name: a.team_name || a.team })}>{t('settings.sign_out')}</button>
            </div>
          ))}
          {others.length ? (
            <>
              <p className="hint">{t('settings.other_teams')}</p>
              {others.map((x) => (
                <div className="account" key={x.slug}>
                  <div className="who"><b>{x.name || x.slug}</b></div>
                  <button type="button" className="btn btn-sec btn-sm" onClick={() => setAdding({ relay: account.relay, team: x.slug })}>{t('settings.sign_in_team', { name: x.name || x.slug })}</button>
                </div>
              ))}
            </>
          ) : null}
          {adding ? (
            <div className="mt-8">
              <SignInForm relay={adding.relay} team={adding.team} lockRelay={false} onDone={async (a) => { await reloadAccounts(); setAdding(null); setActive(a.id); teams.reload(); }} onCancel={() => setAdding(null)} />
            </div>
          ) : (
            <div className="connect-row mt-8"><button type="button" className="btn btn-sec" onClick={() => setAdding({ relay: '', team: 'default' })}>{t('settings.add_account')}</button></div>
          )}
        </section>

        {leaving ? <SignOutDialog account={leaving} onConfirm={() => signOut(leaving)} onClose={() => setLeaving(null)} /> : null}

        <section className="panel" aria-labelledby="set-look">
          <h2 id="set-look">{t('settings.appearance')}</h2>
          <div className="seg" role="group" aria-label={t('settings.appearance')}>
            {THEMES.map((th) => <button key={th} type="button" aria-pressed={theme === th} onClick={() => setTheme(th)}>{t(`theme.${th}`)}</button>)}
          </div>
        </section>

        <section className="panel" aria-labelledby="set-start">
          <h2 id="set-start">{t('settings.start_title')}</h2>
          {autostart === null ? <p className="hint">{t('settings.autostart_unavailable')}</p> : (
            <label className="toggle">
              <input type="checkbox" checked={autostart === true} disabled={autostart === undefined} onChange={(e) => changeAutostart(e.target.checked)} />
              <span><span className="t-name">{t('settings.autostart_name')}</span><span className="t-help">{t('settings.autostart_help')}</span></span>
            </label>
          )}
        </section>

        <section className="panel" aria-labelledby="set-updates">
          <h2 id="set-updates">{t('settings.updates')}</h2>
          <p className="hint">{t('settings.version', { version: update?.current ?? appInfo?.version ?? '' })}</p>
          {update ? <p role="status">{updateText(update)}</p> : null}
          {update !== null ? <div className="connect-row mt-8"><button type="button" className="btn btn-sec btn-sm" onClick={checkNow} disabled={update?.state === 'checking' || update?.state === 'downloading'}>{t('settings.check_updates')}</button></div> : null}
          <p className="fine mt-8">{t('settings.updates_fine')}</p>
        </section>
      </div>
    </div>
  );
}

function updateText(u) {
  switch (u.state) {
    case 'checking': return t('settings.update_checking');
    case 'downloading': return t('settings.update_downloading', { version: u.available ?? '' });
    case 'ready': return t('settings.update_ready', { version: u.available ?? '' });
    case 'error': { const why = reasonText(u.reason, u.message); return why ? t('settings.update_error', { message: why }) : t('settings.update_failed'); }
    default: return u.checked_at ? t('settings.update_current', { when: formatAgo(u.checked_at) }) : t('settings.update_unchecked');
  }
}
