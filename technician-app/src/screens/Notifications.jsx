import { useState } from 'react';
import { useApp } from '../context.jsx';
import { formatAgo } from '../format.js';
import { t } from '../i18n/index.js';
import { NotificationSettings } from './NotificationSettings.jsx';

// The six things the relay tells you about. Titles and bodies repeat text from the PC (a PC's
// name, a task's note), so they are shown as text.
export function Notifications() {
  const { notifications, accounts, openTarget, now } = useApp();
  const [tab, setTab] = useState('recent');
  const several = accounts.length > 1;
  const items = [...notifications].sort((a, b) => b.at - a.at || b.id - a.id);
  return (
    <div className="page">
      <div className="page-in">
        <h1 tabIndex={-1}>{t('notify.title')}</h1>
        <div className="subtabs" role="tablist" aria-label={t('notify.tabs')}>
          <button type="button" role="tab" aria-selected={tab === 'recent'} onClick={() => setTab('recent')}>{t('notify.recent')}</button>
          <button type="button" role="tab" aria-selected={tab === 'settings'} onClick={() => setTab('settings')}>{t('notify.settings')}</button>
        </div>
        {tab === 'settings' ? <NotificationSettings /> : items.length === 0 ? (
          <p className="hint">{t('notify.empty')}</p>
        ) : (
          <ul className="feed" aria-label={t('notify.recent')}>
            {items.map((n) => {
              const team = several ? accounts.find((a) => a.id === n.account) : null;
              return (
                <li key={`${n.account}:${n.id}`} data-event={n.event}>
                  <span className="f-title">{n.title}</span>
                  <span className="f-time">{formatAgo(n.at, now)}</span>
                  <span className="f-body">{team ? `${team.team_name || team.team}: ` : ''}{n.body}</span>
                  {n.device_id || n.task_id || n.session_id ? (
                    <button type="button" className="btn btn-sec btn-sm f-open" onClick={() => openTarget(n)}>{n.task_id ? t('notify.open_task') : t('notify.open_pc')}</button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
