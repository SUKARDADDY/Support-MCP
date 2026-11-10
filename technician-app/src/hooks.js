import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchMe } from './api.js';

// Is the page on screen? False when the tab is hidden, the window is minimised or it was
// sent to the tray.
export function usePageVisible() {
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  useEffect(() => {
    const on = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return visible;
}

// Runs `fn` now and then every `ms` while `enabled`, never two at once. A slow call just
// delays the next one. Errors go to onError; the loop carries on.
export function useInterval(fn, ms, enabled = true, { immediate = true } = {}) {
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => {
    if (!enabled) return undefined;
    let stopped = false;
    let timer = null;
    const tick = async () => {
      try {
        await latest.current();
      } catch (_) {
        // the caller's fn handles its own errors; the loop must not stop
      }
      if (!stopped) timer = setTimeout(tick, ms);
    };
    if (immediate) tick();
    else timer = setTimeout(tick, ms);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [ms, enabled, immediate]);
}

// Loads something once (and again on reload()). Returns { data, error, loading, reload }.
export function useLoad(load, deps) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const seq = useRef(0);
  const run = useCallback(() => {
    const mine = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    Promise.resolve()
      .then(load)
      .then((data) => mine === seq.current && setState({ data, error: null, loading: false }))
      .catch((error) => mine === seq.current && setState((s) => ({ data: s.data, error, loading: false })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    run();
    return () => {
      seq.current += 1;
    };
  }, [run]);
  return { ...state, reload: run };
}

// Arrow keys, Home and End move between the tabs of a tablist and open the one reached. Put it
// on the element with role="tablist"; the tabs keep tabIndex 0 only for the selected one.
export function tabKeyDown(e) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
  const tabs = [...e.currentTarget.querySelectorAll('[role="tab"]')];
  const from = tabs.indexOf(e.target.closest('[role="tab"]'));
  if (from < 0) return;
  let to = from;
  if (e.key === 'Home') to = 0;
  else if (e.key === 'End') to = tabs.length - 1;
  else to = (from + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  e.preventDefault();
  tabs[to].focus();
  tabs[to].click();
}

// A modal <dialog>: opened when it mounts, closed when it unmounts. Put the returned ref on the dialog.
export function useDialog() {
  const ref = useRef(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return undefined;
    if (typeof d.showModal === 'function') d.showModal();
    else d.setAttribute('open', '');
    return () => {
      if (d.open && typeof d.close === 'function') d.close();
    };
  }, []);
  return ref;
}

const NO_ONE = { identity: '', permissions: [] };

// Who a tab's account is: the shown account's `me` when the tab is of the shown account, else the tab's own
// account's, read once. Until it is known the person is no one, so no role follows from the wrong account's identity.
export function useAccountMe(core, accountId, shownId, shownMe) {
  const [own, setOwn] = useState(null);
  const isShown = accountId === shownId;
  useEffect(() => {
    if (isShown || !accountId) return undefined;
    let live = true;
    fetchMe(core, accountId).then((m) => live && setOwn({ accountId, me: m })).catch(() => {});
    return () => { live = false; };
  }, [core, accountId, isShown]);
  if (isShown) return shownMe;
  return own?.accountId === accountId ? own.me : NO_ONE;
}
