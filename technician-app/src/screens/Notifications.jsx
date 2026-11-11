import { useState } from 'react';
import { tabKeyDown } from '../hooks.js';
import { useApp } from '../context.jsx';
import { formatAgo, taskBody } from '../format.js';
import { t } from '../i18n/index.js';
import { NotificationSettings } from './NotificationSettings.jsx';

// The things the relay tells you about: eight you can switch off, and an invite to a session, an offer of control or an action waiting for your approval, which always arrive. Titles and bodies repeat text from the PC (a PC's
// name, a task's note), so they are shown as text. A "waiting for approval" body comes from a
// join request that anyone can send before the PC is approved, so it is labelled as the PC's own words.
// What the button on a notification says, by what it opens.
function openLabel(n) {
  if (n.event === 'escalation_opened' || n.event === 'escalation_claimed') return 'notify.open_queue';
  if (n.event === 'approval_requested' && n.session_id) return 'notify.review_approval';
  if (n.event === 'session_invited' && n.session_id) return 'notify.join_session';
  if (n.event === 'control_offered' && n.session_id) return 'notify.open_session';
  if (n.task_id) return 'notify.open_task';
  if (n.device_id || n.session_id) return 'notify.open_pc';
  return null;
}

export function Notifications() {
  const { notifications, accounts, account, openTarget, now, titleOf } = useApp();
  const [tab, setTab] = useState('recent');
  const several = accounts.length > 1;
  const items = [...notifications].sort((a, b) => b.at - a.at || b.id - a.id);
  return (
    <div className="page">
      <div className="page-in">
        <h1 tabIndex={-1}>{t('notify.title')}</h1>
        <div className="subtabs" role="tablist" aria-label={t('notify.tabs')} onKeyDown={tabKeyDown}>
          <button type="button" role="tab" id="notify-tab-recent" aria-controls="notify-panel" aria-selected={tab === 'recent'} tabIndex={tab === 'recent' ? 0 : -1} onClick={() => setTab('recent')}>{t('notify.recent')}</button>
          <button type="button" role="tab" id="notify-tab-settings" aria-controls="notify-panel" aria-selected={tab === 'settings'} tabIndex={tab === 'settings' ? 0 : -1} onClick={() => setTab('settings')}>{t('notify.settings')}</button>
        </div>
        <div role="tabpanel" id="notify-panel" aria-labelledby={`notify-tab-${tab}`}>
        {tab === 'settings' ? <NotificationSettings key={account?.id} /> : items.length === 0 ? (
          <p className="hint">{t('notify.empty')}</p>
        ) : (
          <ul className="feed" aria-label={t('notify.recent')}>
            {items.map((n) => {
              const team = several ? accounts.find((a) => a.id === n.account) : null;
              return (
                <li key={`${n.account}:${n.id}`} data-event={n.event}>
                  <span className="f-title">{n.title}</span>
                  <span className="f-time">{formatAgo(n.at, now)}</span>
                  <span className="f-body">
                    {team ? `${team.team_name || team.team}: ` : ''}
                    {n.event === 'device_waiting' ? <span className="f-from">{t('notify.from_pc')} </span> : null}
                    {taskBody(n.event, n.body, titleOf(n.task_id))}
                  </span>
                  {openLabel(n) ? (
                    <button type="button" className="btn btn-sec btn-sm f-open" onClick={() => openTarget(n)}>{t(openLabel(n))}</button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        </div>
      </div>
    </div>
  );
}
