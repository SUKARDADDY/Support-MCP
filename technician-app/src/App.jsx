import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { endSession, fetchDevices, fetchMe, fetchPlaces, isLiveTask, listTasks, messageOf, sessionStatus, startTask } from './api.js';
import { Icon } from './components/Icon.jsx';
import { useConnections } from './connections.js';
import { AppContext } from './context.jsx';
import { sortDevices } from './devices.js';
import { realCore } from './core.js';
import { tabKeyDown, useInterval, usePageVisible } from './hooks.js';
import { t } from './i18n/index.js';
import { AddDevice } from './screens/AddDevice.jsx';
import { Devices } from './screens/Devices.jsx';
import { Notifications } from './screens/Notifications.jsx';
import { OneOffLink } from './screens/OneOffLink.jsx';
import { SessionTab } from './screens/SessionTab.jsx';
import { Settings } from './screens/Settings.jsx';
import { SignIn } from './screens/SignIn.jsx';
import { applyTheme, loadTheme, saveTheme } from './theme.js';
import { loadTitles, withTitle } from './titles.js';
import { guardedStart, guardsFor } from './guarded-start.js';

const ACTIVE_KEY = 'support.active';
const PLACES_EVERY_MS = 5 * 60 * 1000;
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
export const TUNING = { connectPollMs: 2000, devicePollMs: 15000, watchMs: 3000, screenshotMs: 3000, taskCheckMs: 15000, statusMs: 10000, taskWaitS: 25, taskGapMs: 1000, taskRetryMs: 2000 };

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
  const knownNotes = useRef(new Set()); // "<account>:<id>" of every item the list has seen
  const [unread, setUnread] = useState(0);
  const [linkOpen, setLinkOpen] = useState(false);
  const [titles, setTitles] = useState(loadTitles); // task id -> first line of the instructions this app sent
  const [toastText, setToastText] = useState(null);
  const [relayDown, setRelayDown] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const toastTimer = useRef(null);
  // On screen: the page is not hidden, and the shell has not hidden the window to the tray or minimised it.
  const [windowVisible, setWindowVisible] = useState(true);
  const visible = usePageVisible() && windowVisible;

  useEffect(() => applyTheme(theme), [theme]);
  // The native title bar and border follow the same choice (light, dark or the system's).
  useEffect(() => { Promise.resolve(core.setWindowTheme?.(theme)).catch(() => {}); }, [core, theme]);
  const setTheme = (next) => { saveTheme(next); setThemeState(next); };
  useInterval(() => setNow(Date.now()), 30000, true, { immediate: false });

  const toast = useCallback((text) => {
    clearTimeout(toastTimer.current);
    setToastText(text);
    if (text) toastTimer.current = setTimeout(() => setToastText(null), 4200);
  }, []);

  const rememberTask = useCallback((taskId, instructions) => setTitles((cur) => withTitle(cur, taskId, instructions)), []);
  const titleOf = useCallback((taskId) => (taskId ? titles[taskId] ?? null : null), [titles]);

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
  const setActive = useCallback((id) => { setActiveId(id); write(ACTIVE_KEY, id); setSelectedId(null); setView('devices'); }, []);

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
  const placesAt = useRef(0);
  const reloadDevices = useCallback(async () => {
    if (!accountId) return;
    const mine = ++loadSeq.current;
    // Sites and customers change rarely: they are read again every few minutes, not at every look at the list.
    const stalePlaces = Date.now() - placesAt.current > PLACES_EVERY_MS;
    try {
      const [devices, places] = await Promise.all([fetchDevices(core, accountId), stalePlaces ? fetchPlaces(core, accountId).catch(() => null) : null]);
      // A newer read, or a change of account, has made this one stale: its answer belongs to nobody now.
      if (mine !== loadSeq.current) return;
      if (places) placesAt.current = Date.now();
      setDeviceData((d) => ({ devices: sortDevices(devices), places: places ?? d.places, loading: false, error: null }));
    } catch (error) {
      if (mine === loadSeq.current) setDeviceData((d) => ({ ...d, loading: false, error }));
    }
  }, [core, accountId]);
  // A change of account drops the old list and every read still on its way for the old account
  // (devices, sites and customers are read together under one sequence number), then reads the new one.
  const lastAccount = useRef(null);
  useEffect(() => {
    loadSeq.current += 1;
    placesAt.current = 0;
    setDeviceData({ devices: [], places: new Map(), loading: true, error: null });
    const switched = lastAccount.current !== null && lastAccount.current !== accountId;
    lastAccount.current = accountId;
    // A window that is hidden reads nothing: the list is read when it is shown again.
    if (accountId && ((switched && visible) || !(view === 'devices' || view === 'add'))) reloadDevices();
  }, [accountId]); // eslint-disable-line react-hooks/exhaustive-deps
  // After the effect above, so the read it starts is not the one it has just made stale.
  useInterval(reloadDevices, tuning.devicePollMs, !!accountId && visible && (view === 'devices' || view === 'add'));

  // ---- session tabs ------------------------------------------------------------
  const persist = useCallback((next) => { write(TABS_KEY, next); return next; }, []);
  const showTab = useCallback((key) => setView(`tab:${key}`), []);
  const accountRef = useRef(null); // the account on screen now, for callbacks made under an earlier one
  accountRef.current = accountId;
  // `show` says whether to go to the tab. The caller knows: a connection that finished after a switch
  // of team must not take the view, and a click on another team's notification must (this function's
  // own idea of the shown account is the one it was made with, which may be the old one).
  const openSessionTab = useCallback(({ device, sessionId = null, taskId = null, deviceId = null, deviceName = null, accountOf = null, show = true }) => {
    const key = sessionId ?? `task:${taskId}`;
    setTabs((cur) => {
      if (cur.some((x) => x.key === key)) return cur;
      return persist([...cur, { key, account: accountOf ?? accountId, deviceId: device?.id ?? deviceId, deviceName: device?.name ?? deviceName ?? '', sessionId, taskId }]);
    });
    // A tab that is not shown is added under its own account and appears when that account is used.
    if (show) setView(`tab:${key}`);
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
        toast(messageOf(e, t('session.end_failed')));
      }
    }
    closeTab(key);
  }, [tabs, core, toast, closeTab]);
  const updateTab = useCallback((key, patch) => setTabs((cur) => persist(cur.map((x) => (x.key === key ? { ...x, ...patch } : x)))), [persist]);
  // Every task start goes through here. The PC takes one command at a time, so the open session
  // tab(s) on the same PC or session stop their screenshots and wait for one in flight first;
  // otherwise the agent's first step meets "agent busy". A tab registers itself in `tabGuards`.
  const tabGuards = useRef(new Map()); // tab key -> { account, deviceId(), sessionId(), liveSession(), hold(), release(), follow(taskId) }
  const registerTab = useCallback((key, guard) => {
    tabGuards.current.set(key, guard);
    return () => { if (tabGuards.current.get(key) === guard) tabGuards.current.delete(key); };
  }, []);
  // `forAccount` is the account the caller belongs to: a tab's dialog passes its tab's account, so
  // a session is never driven through another account's sign-in. The default is the shown account.
  const startAgentTask = useCallback((body, forAccount = accountId) => guardedStart({
    guards: guardsFor(tabGuards.current.values(), forAccount, body),
    body,
    send: (b) => startTask(core, forAccount, b),
  }), [core, accountId]);
  // Which tabs have a session that ended. The tabs report it (state, so the screens that ask for the
  // tab on a PC draw again when it changes).
  const [endedTabs, setEndedTabs] = useState({});
  const markEnded = useCallback((key, ended) => setEndedTabs((cur) => (!!cur[key] === ended ? cur : { ...cur, [key]: ended })), []);
  // The tab on a PC whose session is still open. One whose session ended is not it: a new session is a new tab.
  const sessionTabFor = useCallback((deviceId) => tabs.find((x) => x.deviceId === deviceId && x.account === accountId && !endedTabs[x.key]) ?? null, [tabs, accountId, endedTabs]);

  // Tabs from the last run: keep only the sessions that are still open.
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || !accounts) return;
    restored.current = true;
    (async () => {
      const keep = [];
      for (const tab of tabs) {
        if (!accounts.some((a) => a.id === tab.account && a.signed_in)) continue;
        try {
          if (tab.sessionId) {
            const st = await sessionStatus(core, tab.account, tab.sessionId, 0);
            if (st.state === 'waiting' || st.state === 'attached') keep.push(tab);
          } else if (tab.taskId) {
            // A task started on a PC has no session yet: keep its tab while the task works.
            const task = (await listTasks(core, tab.account)).find((x) => x.id === tab.taskId);
            if (isLiveTask(task)) keep.push(tab);
          }
        } catch (e) {
          if (e?.code === 'unavailable') keep.push(tab);
        }
      }
      setTabs(persist(keep));
    })().catch(() => {});
  }, [accounts]); // eslint-disable-line react-hooks/exhaustive-deps

  const { conns, connect, cancel: cancelConnect, dismiss: dismissConnect } = useConnections({
    core,
    account: accountId,
    onLive: ({ device, sessionId, account: accountOf }) => openSessionTab({ device, sessionId, accountOf, show: accountOf === accountRef.current }),
    onEndFailed: (device) => toast(t('connect.cleanup_failed', { name: device.name })),
    pollMs: tuning.connectPollMs,
  });

  // ---- notifications -------------------------------------------------------------
  useEffect(() => {
    let live = true;
    core.recentNotifications().then((list) => {
      if (!live) return;
      list.forEach((n) => knownNotes.current.add(`${n.account}:${n.id}`));
      setNotifications((cur) => {
        // Items the feed delivered while the list was loading stay.
        const have = new Set(list.map((n) => `${n.account}:${n.id}`));
        return [...list, ...cur.filter((n) => !have.has(`${n.account}:${n.id}`))].slice(-100);
      });
    }).catch(() => {});
    const offs = [];
    const sub = (event, handler) => core.on(event, handler).then((off) => (live ? offs.push(off) : off())).catch(() => {});
    sub('feed://items', ({ account: acc, items, live: isLive }) => {
      // Only items the list has not seen are added, and only those count as unread: the
      // feed can repeat an item after a reconnect.
      const fresh = [];
      for (const i of items) {
        const key = `${acc}:${i.id}`;
        if (knownNotes.current.has(key)) continue;
        knownNotes.current.add(key);
        fresh.push({ ...i, account: acc });
      }
      if (!fresh.length) return;
      setNotifications((cur) => [...cur, ...fresh].slice(-100));
      if (isLive) setUnread((n) => n + fresh.length);
    });
    sub('feed://status', ({ online }) => setRelayDown(!online));
    sub('ui://visibility', ({ visible: v }) => setWindowVisible(v !== false));
    sub('account://changed', () => { loadAccounts().catch(() => {}); });
    sub('ui://open', (target) => openTargetRef.current?.(target));
    return () => { live = false; offs.forEach((off) => off()); };
  }, [core, loadAccounts]);

  const openTarget = useCallback(async (n) => {
    const acc = n.account ?? accountId;
    if (acc && acc !== accountId) setActive(acc);
    if (n.session_id) {
      const existing = tabs.find((x) => x.account === acc && x.sessionId === n.session_id);
      if (existing) { showTab(existing.key); return; }
    }
    if (n.task_id) {
      // A tab already following the task, even if the task moved to another session since its tab was opened.
      const following = tabs.find((x) => x.account === acc && (x.taskId === n.task_id || x.key === `task:${n.task_id}`));
      if (following) { showTab(following.key); return; }
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
    toast, copyText, notifications, openTarget, now, theme, setTheme, tuning, visible, rememberTask, titleOf, registerTab, startAgentTask, markEnded,
  }), [core, appInfo, accounts, account, setActive, loadAccounts, can, me, deviceData, reloadDevices, selectedId, select, conns, connect, cancelConnect, dismissConnect, sessionTabFor, showTab, endTab, closeTab, updateTab, openSessionTab, go, toast, copyText, notifications, openTarget, now, theme, tuning, visible, rememberTask, titleOf, registerTab, startAgentTask, markEnded]); // eslint-disable-line react-hooks/exhaustive-deps

  if (accounts === null) return <div className="app" role="status"><p className="hint">{t('common.loading')}</p></div>;

  if (!account) {
    return (
      <AppContext.Provider value={ctx}>
        <div className="app"><SignIn accounts={accounts} /></div>
      </AppContext.Provider>
    );
  }

  const tabKey = view.startsWith('tab:') ? view.slice(4) : null;
  const activeTab = tabKey ? tabs.find((x) => x.key === tabKey && x.account === accountId) ?? null : null;
  const screen = activeTab ? 'session' : view.startsWith('tab:') ? 'devices' : view;
  const mine = tabs.filter((x) => x.account === accountId);

  return (
    <AppContext.Provider value={ctx}>
      <div className="app">
        <div className="tabbar">
          <span className="app-ico" aria-hidden="true"><Icon name="app" /></span>
          <div className="tabs">
            <div className="tablist" role="tablist" aria-label={t('tabs.label')} onKeyDown={tabKeyDown}>
              <button type="button" role="tab" id="tab-devices" aria-controls="panel-devices" aria-selected={screen !== 'session'} tabIndex={screen !== 'session' ? 0 : -1} className="tab-b" data-on={screen !== 'session'} style={{ order: 0 }} onClick={() => go('devices')}>{t('nav.devices')}</button>
              {mine.map((x, i) => (
                <button key={x.key} type="button" role="tab" id={`tab-${x.key}`} aria-controls={`panel-${x.key}`} aria-selected={activeTab?.key === x.key} tabIndex={activeTab?.key === x.key ? 0 : -1} className="tab-b has-x" data-on={activeTab?.key === x.key} style={{ order: 2 * (i + 1) }} onClick={() => showTab(x.key)}>
                  <span className="dot" aria-hidden="true" />{x.deviceName || t('session.untitled')}<span className="sr"> {t('session.connected_sr')}</span>
                </button>
              ))}
            </div>
            {mine.length ? (
              <div className="tab-closers" role="group" aria-label={t('tabs.close_label')}>
                {mine.map((x, i) => (
                  <button key={x.key} type="button" className="tab-x" data-on={activeTab?.key === x.key} style={{ order: 2 * (i + 1) + 1 }} onClick={() => endTab(x.key)} aria-label={t('session.end_with', { name: x.deviceName || t('session.untitled') })} title={t('session.end')}><Icon name="x" /></button>
                ))}
              </div>
            ) : null}
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
            <div className="panel-fill" role="tabpanel" id="panel-devices" aria-labelledby="tab-devices" hidden={screen === 'session'}>
              {screen === 'devices' ? <Devices /> : null}
              {screen === 'add' ? <AddDevice /> : null}
              {screen === 'notifications' ? <Notifications /> : null}
              {screen === 'settings' ? <Settings /> : null}
            </div>
            {/* Every open tab stays mounted, so its task keeps being followed while another
                screen or tab is shown. Only the tab on screen takes pictures. */}
            {tabs.map((x) => (
              <div key={x.key} className="panel-fill" role="tabpanel" id={`panel-${x.key}`} aria-labelledby={`tab-${x.key}`} hidden={activeTab?.key !== x.key}>
                <SessionTab tab={x} active={activeTab?.key === x.key} />
              </div>
            ))}
          </main>
        </div>
        {linkOpen ? <OneOffLink onClose={() => setLinkOpen(false)} /> : null}
        <div className={`toast${toastText ? ' show' : ''}`} role="status" aria-live="polite">{toastText}</div>
      </div>
    </AppContext.Provider>
  );
}
