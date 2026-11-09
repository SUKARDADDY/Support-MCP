import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { endSession, fetchDevices, fetchMe, fetchPlaces, listTasks, sessionStatus } from './api.js';
import { Icon } from './components/Icon.jsx';
import { useConnections } from './connections.js';
import { AppContext } from './context.jsx';
import { sortDevices } from './devices.js';
import { realCore } from './core.js';
import { useInterval, usePageVisible } from './hooks.js';
import { t } from './i18n/index.js';
import { AddDevice } from './screens/AddDevice.jsx';
import { Devices } from './screens/Devices.jsx';
import { Notifications } from './screens/Notifications.jsx';
import { OneOffLink } from './screens/OneOffLink.jsx';
import { SessionTab } from './screens/SessionTab.jsx';
import { Settings } from './screens/Settings.jsx';
import { SignIn } from './screens/SignIn.jsx';
import { applyTheme, loadTheme, saveTheme } from './theme.js';

const ACTIVE_KEY = 'support.active';
const TABS_KEY = 'support.tabs';

const read = (key, fallback) => {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v ?? fallback;
  } catch (_) {
    return fallback;
  }
};
const write = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (_) {
    // no storage: the choice lasts until the app closes
  }
};

// How often the app looks again. Tests pass shorter times through `tuning`.
export const TUNING = { connectPollMs: 2000, devicePollMs: 15000, watchMs: 3000, screenshotMs: 3000, taskCheckMs: 15000, statusMs: 5000, taskWaitS: 25, taskGapMs: 1000 };

const NO_TUNING = {};

export function App({ core = realCore, tuning: tuningIn = NO_TUNING }) {
  const tuning = useMemo(() => ({ ...TUNING, ...tuningIn }), [tuningIn]);
  const [appInfo, setAppInfo] = useState(null);
  const [accounts, setAccounts] = useState(null);
  const [activeId, setActiveId] = useState(() => read(ACTIVE_KEY, null));
  const [me, setMe] = useState({ identity: '', permissions: [] });
  const [theme, setThemeState] = useState(loadTheme);
  const [view, setView] = useState('devices');
  const [selectedId, setSelectedId] = useState(null);
  const [tabs, setTabs] = useState(() => read(TABS_KEY, []));
  const [notifications, setNotifications] = useState([]);
  const [unread, setUnread] = useState(0);
  const [linkOpen, setLinkOpen] = useState(false);
  const [toastText, setToastText] = useState(null);
  const [relayDown, setRelayDown] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const toastTimer = useRef(null);
  const visible = usePageVisible();

  useEffect(() => applyTheme(theme), [theme]);
  const setTheme = (next) => { saveTheme(next); setThemeState(next); };
  useInterval(() => setNow(Date.now()), 30000, true, { immediate: false });

  const toast = useCallback((text) => {
    clearTimeout(toastTimer.current);
    setToastText(text);
    if (text) toastTimer.current = setTimeout(() => setToastText(null), 4200);
  }, []);

  const copyText = useCallback(async (text, message) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(message);
    } catch (_) {
      toast(t('common.copy_failed'));
    }
  }, [toast]);

  // ---- accounts ----------------------------------------------------------------
  const loadAccounts = useCallback(async () => {
    const list = await core.accounts();
    setAccounts(list);
    return list;
  }, [core]);

  useEffect(() => { core.appInfo().then(setAppInfo).catch(() => {}); loadAccounts().catch(() => setAccounts([])); }, [core, loadAccounts]);

  const signedIn = (accounts ?? []).filter((a) => a.signed_in);
  const account = signedIn.find((a) => a.id === activeId) ?? signedIn[0] ?? null;
  const accountId = account?.id ?? null;
  const setActive = useCallback((id) => { setActiveId(id); write(ACTIVE_KEY, id); setSelectedId(null); }, []);

  useEffect(() => {
    if (!accountId) { setMe({ identity: '', permissions: [] }); return undefined; }
    let live = true;
    fetchMe(core, accountId).then((m) => live && setMe(m)).catch(() => live && setMe({ identity: '', permissions: [] }));
    return () => { live = false; };
  }, [core, accountId]);
  const can = useCallback((permission) => me.permissions.includes(permission), [me]);

  // ---- devices -----------------------------------------------------------------
  const [deviceData, setDeviceData] = useState({ devices: [], places: new Map(), loading: true, error: null });
  const loadSeq = useRef(0);
  const reloadDevices = useCallback(async () => {
    if (!accountId) return;
    const mine = ++loadSeq.current;
    try {
      const [devices, places] = await Promise.all([fetchDevices(core, accountId), fetchPlaces(core, accountId).catch(() => new Map())]);
      if (mine === loadSeq.current) setDeviceData({ devices: sortDevices(devices), places, loading: false, error: null });
    } catch (error) {
      if (mine === loadSeq.current) setDeviceData((d) => ({ ...d, loading: false, error }));
    }
  }, [core, accountId]);
  useEffect(() => { setDeviceData({ devices: [], places: new Map(), loading: true, error: null }); }, [accountId]);
  useInterval(reloadDevices, tuning.devicePollMs, !!accountId && visible && (view === 'devices' || view === 'add'));
  useEffect(() => { if (accountId && !(view === 'devices' || view === 'add')) reloadDevices(); }, [accountId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- session tabs ------------------------------------------------------------
  const persist = useCallback((next) => { write(TABS_KEY, next); return next; }, []);
  const showTab = useCallback((key) => setView(`tab:${key}`), []);
  const openSessionTab = useCallback(({ device, sessionId = null, taskId = null, deviceId = null, deviceName = null, accountOf = null }) => {
    const key = sessionId ?? `task:${taskId}`;
    setTabs((cur) => {
      if (cur.some((x) => x.key === key)) return cur;
      return persist([...cur, { key, account: accountOf ?? accountId, deviceId: device?.id ?? deviceId, deviceName: device?.name ?? deviceName ?? '', sessionId, taskId }]);
    });
    setView(`tab:${key}`);
  }, [accountId, persist]);
  const closeTab = useCallback((key) => {
    setTabs((cur) => persist(cur.filter((x) => x.key !== key)));
    setView((v) => (v === `tab:${key}` ? 'devices' : v));
  }, [persist]);
  const endTab = useCallback(async (key) => {
    const tab = tabs.find((x) => x.key === key);
    if (tab?.sessionId) {
      try {
        await endSession(core, tab.account, tab.sessionId);
        toast(t('session.ended_toast', { name: tab.deviceName }));
      } catch (e) {
        toast(e?.message || t('session.end_failed'));
      }
    }
    closeTab(key);
  }, [tabs, core, toast, closeTab]);
  const updateTab = useCallback((key, patch) => setTabs((cur) => persist(cur.map((x) => (x.key === key ? { ...x, ...patch } : x)))), [persist]);
  const sessionTabFor = useCallback((deviceId) => tabs.find((x) => x.deviceId === deviceId && x.account === accountId) ?? null, [tabs, accountId]);

  // Tabs from the last run: keep only the sessions that are still open.
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || !accounts) return;
    restored.current = true;
    (async () => {
      const keep = [];
      for (const tab of tabs) {
        if (!tab.sessionId || !accounts.some((a) => a.id === tab.account && a.signed_in)) continue;
        try {
          const st = await sessionStatus(core, tab.account, tab.sessionId, 0);
          if (st.state === 'waiting' || st.state === 'attached') keep.push(tab);
        } catch (e) {
          if (e?.code === 'unavailable') keep.push(tab);
        }
      }
      setTabs(persist(keep));
    })();
  }, [accounts]); // eslint-disable-line react-hooks/exhaustive-deps

  const { conns, connect, cancel: cancelConnect, dismiss: dismissConnect } = useConnections({
    core,
    account: accountId,
    onLive: ({ device, sessionId }) => openSessionTab({ device, sessionId }),
    pollMs: tuning.connectPollMs,
  });

  // ---- notifications -------------------------------------------------------------
  useEffect(() => {
    let live = true;
    core.recentNotifications().then((list) => live && setNotifications(list)).catch(() => {});
    const offs = [];
    const sub = (event, handler) => core.on(event, handler).then((off) => (live ? offs.push(off) : off())).catch(() => {});
    sub('feed://items', ({ account: acc, items, live: isLive }) => {
      setNotifications((cur) => {
        const known = new Set(cur.map((n) => `${n.account}:${n.id}`));
        const fresh = items.filter((i) => !known.has(`${acc}:${i.id}`)).map((i) => ({ ...i, account: acc }));
        return [...cur, ...fresh].slice(-100);
      });
      if (isLive) setUnread((n) => n + items.length);
    });
    sub('feed://status', ({ online }) => setRelayDown(!online));
    sub('account://changed', () => { loadAccounts().catch(() => {}); });
    sub('ui://open', (target) => openTargetRef.current?.(target));
    return () => { live = false; offs.forEach((off) => off()); };
  }, [core, loadAccounts]);

  const openTarget = useCallback(async (n) => {
    const acc = n.account ?? accountId;
    if (acc && acc !== accountId) setActive(acc);
    if (n.session_id) {
      const existing = tabs.find((x) => x.sessionId === n.session_id);
      if (existing) { showTab(existing.key); return; }
    }
    if (n.task_id) {
      try {
        const task = (await listTasks(core, acc)).find((x) => x.id === n.task_id);
        if (task) {
          const device = deviceData.devices.find((d) => d.id === task.device_id);
          if (task.session_id && (task.state === 'running' || task.state === 'paused')) {
            openSessionTab({ device, deviceId: task.device_id, deviceName: device?.name, sessionId: task.session_id, taskId: task.id, accountOf: acc });
            return;
          }
          if (task.device_id) { setSelectedId(task.device_id); setView('devices'); return; }
        }
      } catch (_) {
        // fall through to the PC
      }
    }
    if (n.device_id) { setSelectedId(n.device_id); setView('devices'); }
  }, [accountId, tabs, core, deviceData.devices, openSessionTab, setActive, showTab]);
  const openTargetRef = useRef(null);
  openTargetRef.current = openTarget;

  const go = useCallback((next) => {
    setView(next);
    if (next === 'notifications') setUnread(0);
  }, []);
  const select = useCallback((id) => { setSelectedId(id); }, []);

  const ctx = useMemo(() => ({
    core, appInfo, accounts: accounts ?? [], account, setActive, reloadAccounts: loadAccounts, can, me,
    devices: deviceData.devices, places: deviceData.places, devicesState: deviceData, reloadDevices,
    selectedId, select, conns, connect, cancelConnect, dismissConnect,
    sessionTabFor, showTab, endTab, closeTab, updateTab, openSessionTab, go, openLink: () => setLinkOpen(true),
    toast, copyText, notifications, openTarget, now, theme, setTheme, reloadTasks: () => {}, tuning,
  }), [core, appInfo, accounts, account, setActive, loadAccounts, can, me, deviceData, reloadDevices, selectedId, select, conns, connect, cancelConnect, dismissConnect, sessionTabFor, showTab, endTab, closeTab, updateTab, openSessionTab, go, toast, copyText, notifications, openTarget, now, theme, tuning]); // eslint-disable-line react-hooks/exhaustive-deps

  if (accounts === null) return <div className="app" role="status"><p className="hint">{t('common.loading')}</p></div>;

  if (!account) {
    return (
      <AppContext.Provider value={ctx}>
        <div className="app"><SignIn accounts={accounts} /></div>
      </AppContext.Provider>
    );
  }

  const tabKey = view.startsWith('tab:') ? view.slice(4) : null;
  const activeTab = tabKey ? tabs.find((x) => x.key === tabKey) : null;
  const screen = activeTab ? 'session' : view.startsWith('tab:') ? 'devices' : view;

  return (
    <AppContext.Provider value={ctx}>
      <div className="app">
        <div className="tabbar">
          <span className="app-ico" aria-hidden="true"><Icon name="app" /></span>
          <div className="tabs" role="tablist" aria-label={t('tabs.label')}>
            <div className="tab" data-on={screen !== 'session'}>
              <button type="button" role="tab" aria-selected={screen !== 'session'} className="tab-b" onClick={() => go('devices')}>{t('nav.devices')}</button>
            </div>
            {tabs.filter((x) => x.account === accountId).map((x) => (
              <div className="tab" key={x.key} data-on={activeTab?.key === x.key}>
                <button type="button" role="tab" aria-selected={activeTab?.key === x.key} className="tab-b" onClick={() => showTab(x.key)}>
                  <span className="dot" aria-hidden="true" />{x.deviceName || t('session.untitled')}<span className="sr"> {t('session.connected_sr')}</span>
                </button>
                <button type="button" className="tab-x" onClick={() => endTab(x.key)} aria-label={t('session.end_with', { name: x.deviceName })} title={t('session.end')}><Icon name="x" /></button>
              </div>
            ))}
          </div>
        </div>
        {relayDown ? <div className="banner" role="status">{t('app.relay_down')}</div> : null}
        <div className="body">
          <nav className="rail" aria-label={t('nav.label')}>
            <button type="button" aria-current={screen === 'devices' ? 'page' : undefined} onClick={() => go('devices')}><Icon name="monitor" />{t('nav.devices')}</button>
            <button type="button" aria-current={screen === 'add' ? 'page' : undefined} onClick={() => go('add')}><Icon name="plus" />{t('nav.add')}</button>
            <button type="button" onClick={() => setLinkOpen(true)}><Icon name="link" />{t('nav.link')}</button>
            <span className="grow" />
            <button type="button" aria-current={screen === 'notifications' ? 'page' : undefined} onClick={() => go('notifications')}>
              <Icon name="bell" />{t('nav.notifications')}
              {unread ? <span className="count" aria-label={t('nav.unread', { count: unread })}>{unread}</span> : null}
            </button>
            <button type="button" aria-current={screen === 'settings' ? 'page' : undefined} onClick={() => go('settings')}><Icon name="gear" />{t('nav.settings')}</button>
          </nav>
          <main className="view">
            {screen === 'devices' ? <Devices /> : null}
            {screen === 'add' ? <AddDevice /> : null}
            {screen === 'notifications' ? <Notifications /> : null}
            {screen === 'settings' ? <Settings /> : null}
            {screen === 'session' && activeTab ? <SessionTab key={activeTab.key} tab={activeTab} active /> : null}
          </main>
        </div>
        {linkOpen ? <OneOffLink onClose={() => setLinkOpen(false)} /> : null}
        <div className={`toast${toastText ? ' show' : ''}`} role="status" aria-live="polite">{toastText}</div>
      </div>
    </AppContext.Provider>
  );
}
