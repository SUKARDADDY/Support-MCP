// Connecting to a saved PC. device_connect starts a session in state "waiting"; the PC
// notices within seconds (or up to five minutes if its doorbell is down), asks its owner if
// it must, and the session becomes "attached". This hook runs one attempt per PC, polls the
// session until it is attached or ended, and reports each phase:
//   connecting  asked the relay, or waiting for the PC to answer when no one is asked
//   awaiting    someone at the PC has to click Allow
//   live        attached: the session tab can open
//   declined    ended before it attached (declined, nobody signed in, busy, owner ended)
//   error       the relay refused (the message says why)
import { useCallback, useEffect, useRef, useState } from 'react';
import { connectDevice, endSession, messageOf, sessionStatus } from './api.js';

export const POLL_MS = 2000;

// Why a session ended before it attached, as a key in en.json.
export function declinedKey(reason) {
  switch (reason) {
    case 'declined': return 'connect.declined';
    case 'nobody': return 'connect.nobody';
    case 'busy': return 'connect.busy';
    case 'owner': return 'connect.owner_ended';
    default: return 'connect.ended_early';
  }
}

export function useConnections({ core, account, onLive, onEndFailed, pollMs = POLL_MS }) {
  const [conns, setConns] = useState({});
  // deviceId -> one attempt: { device, cancelled, account, sessionId, ending, done }. `account` is the
  // account that made it: everything the attempt does, ending its session included, goes through
  // that account whatever the app shows now. An attempt stays here until its cleanup is finished.
  const active = useRef(new Map());
  const alive = useRef(true);
  useEffect(() => () => {
    alive.current = false;
    for (const a of active.current.values()) a.cancelled = true;
  }, []);

  const set = useCallback((deviceId, value) => {
    if (!alive.current) return;
    setConns((c) => {
      const next = { ...c };
      if (value === null) delete next[deviceId];
      else next[deviceId] = { ...(c[deviceId] ?? {}), ...value, deviceId };
      return next;
    });
  }, []);

  // Ends the attempt's session once, with the account that made it, and returns the one promise for
  // it, so anyone who needs the cleanup done can wait for it. A failure is tried once more; if the
  // session is still there after that, the person is told by name, because the PC may still ask its
  // user to click Allow.
  const endAttempt = useCallback((attempt) => {
    if (!attempt.sessionId) return Promise.resolve();
    attempt.ending ??= (async () => {
      for (let tries = 0; tries < 2; tries += 1) {
        try {
          await endSession(core, attempt.account, attempt.sessionId);
          return;
        } catch (_) {
          // try once more
        }
      }
      try {
        const st = await sessionStatus(core, attempt.account, attempt.sessionId, 0);
        if (st.state === 'ended' || st.state === 'unknown') return; // it had ended already
      } catch (_) {
        // not known to be gone
      }
      onEndFailed?.(attempt.device);
    })();
    return attempt.ending;
  }, [core, onEndFailed]);

  const connect = useCallback(async (device, { takeOver = false } = {}) => {
    const prior = active.current.get(device.id);
    if (prior) {
      if (!prior.cancelled) return;
      await prior.done; // a cancelled attempt that is still cleaning up finishes first, session end included
      if (active.current.has(device.id)) return; // another click got there first
    }
    let finish;
    const mine = { device, cancelled: false, account, sessionId: null, ending: null, done: new Promise((r) => { finish = r; }) };
    active.current.set(device.id, mine);
    set(device.id, { phase: 'connecting', sessionId: null, message: null, asks: false, startedAt: Date.now() });
    try {
      const made = await connectDevice(core, account, device.id, { takeOver });
      mine.sessionId = made.session_id;
      if (mine.cancelled) {
        // Cancelled before the relay answered: the session it made is not shown anywhere, so end it.
        await endAttempt(mine);
        return;
      }
      let state = made.state;
      set(device.id, { sessionId: made.session_id, asks: made.asks === true, phase: made.asks && state !== 'attached' ? 'awaiting' : 'connecting' });
      let startup = null;
      while (state !== 'attached') {
        await new Promise((r) => setTimeout(r, pollMs));
        if (mine.cancelled) return;
        const st = await sessionStatus(core, account, made.session_id, 0);
        if (mine.cancelled) return;
        state = st.state;
        startup = st.startup_expires_at ?? null;
        if (state === 'ended' || state === 'unknown') {
          set(device.id, { phase: 'declined', reason: st.ended_reason ?? null, message: null });
          return;
        }
        if (state === 'waiting' && startup && Date.now() > startup + 5000) {
          set(device.id, { phase: 'declined', reason: 'nobody', message: null });
          return;
        }
      }
      set(device.id, { phase: 'live' });
      onLive?.({ device, sessionId: made.session_id, account });
      // The tab takes over from here; the attempt is done.
      set(device.id, null);
    } catch (e) {
      if (!mine.cancelled) set(device.id, { phase: 'error', message: messageOf(e, null), code: e?.code ?? null });
    } finally {
      await mine.ending; // still owned while a session end started by Cancel is on its way
      active.current.delete(device.id);
      finish();
    }
  }, [core, account, onLive, pollMs, set, endAttempt]);

  // Stops waiting. If the relay already made a session, ends it; if it has not answered yet, the
  // attempt ends the session when it does.
  const cancel = useCallback(async (deviceId) => {
    const mine = active.current.get(deviceId);
    if (mine) mine.cancelled = true;
    set(deviceId, null);
    if (mine) await endAttempt(mine);
  }, [set, endAttempt]);

  const dismiss = useCallback((deviceId) => set(deviceId, null), [set]);

  return { conns, connect, cancel, dismiss };
}
