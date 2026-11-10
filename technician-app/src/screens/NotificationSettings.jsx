import { useEffect, useState } from 'react';
import { getNotifySettings, messageOf, patchNotifySettings } from '../api.js';
import { useApp } from '../context.jsx';
import { useLoad } from '../hooks.js';
import { t } from '../i18n/index.js';

export const EVENTS = ['task_finished', 'task_problem', 'session_declined', 'device_online', 'device_missing', 'device_waiting'];

// Which of the six events you hear about, which PCs you watch for "came online", and whether
// this PC shows Windows notifications at all.
export function NotificationSettings() {
  const { core, account, devices, toast } = useApp();
  const { data, error, loading, reload } = useLoad(() => getNotifySettings(core, account.id), [core, account.id]);
  const [settings, setSettings] = useState(null);
  const [prefs, setPrefs] = useState(null);
  const [failed, setFailed] = useState(null);
  const [filter, setFilter] = useState('');

  useEffect(() => { if (data) setSettings(data); }, [data]);
  useEffect(() => { core.prefs().then(setPrefs).catch(() => setPrefs({ desktop_notifications: true })); }, [core]);

  async function save(patch, next) {
    const before = settings;
    setSettings(next);
    setFailed(null);
    try {
      setSettings(await patchNotifySettings(core, account.id, patch));
    } catch (e) {
      setSettings(before);
      setFailed(messageOf(e, t('notify.save_failed')));
    }
  }

  async function setDesktop(on) {
    const next = { ...prefs, desktop_notifications: on };
    setPrefs(next);
    try {
      await core.setPrefs(next);
    } catch (e) {
      setPrefs({ ...prefs });
      toast(messageOf(e, t('notify.save_failed')));
    }
  }

  if (loading && !settings) return <p className="hint" role="status">{t('common.loading')}</p>;
  if (error && !settings) {
    return <div role="alert"><p className="err">{messageOf(error, t('notify.load_failed'))}</p><button type="button" className="btn btn-sec" onClick={reload}>{t('common.try_again')}</button></div>;
  }
  if (!settings) return null;
  const watched = new Set(settings.watch ?? []);
  const active = devices.filter((d) => d.status === 'active' && d.name.toLowerCase().includes(filter.trim().toLowerCase()));

  return (
    <div>
      <section className="panel">
        <h2>{t('notify.events_title')}</h2>
        <p className="hint">{t('notify.events_hint')}</p>
        {EVENTS.map((ev) => (
          <label key={ev} className="toggle">
            <input type="checkbox" checked={settings.events?.[ev] !== false} onChange={(e) => save({ events: { [ev]: e.target.checked } }, { ...settings, events: { ...settings.events, [ev]: e.target.checked } })} />
            <span><span className="t-name">{t(`event.${ev}.name`)}</span><span className="t-help">{t(`event.${ev}.help`)}</span></span>
          </label>
        ))}
        {failed ? <p className="err" role="alert">{failed}</p> : null}
      </section>
      <section className="panel">
        <h2>{t('notify.watch_title')}</h2>
        <p className="hint">{t('notify.watch_hint')}</p>
        {active.length === 0 && !filter ? <p className="hint">{t('notify.watch_none')}</p> : (
          <>
            <div className="form-row">
              <label htmlFor="watch-filter" className="sr">{t('notify.watch_filter')}</label>
              <input id="watch-filter" type="search" placeholder={t('notify.watch_filter')} value={filter} onChange={(e) => setFilter(e.target.value)} />
            </div>
            <div className="watch">
              {active.map((d) => (
                <label key={d.id} className="toggle">
                  <input
                    type="checkbox"
                    checked={watched.has(d.id)}
                    onChange={(e) => {
                      const list = e.target.checked ? [...watched, d.id] : [...watched].filter((x) => x !== d.id);
                      save({ watch: list }, { ...settings, watch: list });
                    }}
                  />
                  <span><span className="t-name">{d.name}</span></span>
                </label>
              ))}
            </div>
          </>
        )}
      </section>
      <section className="panel">
        <h2>{t('notify.desktop_title')}</h2>
        <label className="toggle">
          <input type="checkbox" checked={prefs?.desktop_notifications !== false} onChange={(e) => setDesktop(e.target.checked)} />
          <span><span className="t-name">{t('notify.desktop_name')}</span><span className="t-help">{t('notify.desktop_help')}</span></span>
        </label>
      </section>
    </div>
  );
}
