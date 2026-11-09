import { useCallback, useEffect, useRef, useState } from 'react';

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
