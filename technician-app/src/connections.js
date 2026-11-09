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

export function useConnections({ core, account, onLive, pollMs = POLL_MS }) {
  const [conns, setConns] = useState({});
  const active = useRef(new Map()); // deviceId -> { cancelled }
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

  const connect = useCallback(async (device, { takeOver = false } = {}) => {
    if (active.current.has(device.id)) return;
    const mine = { cancelled: false };
    active.current.set(device.id, mine);
    set(device.id, { phase: 'connecting', sessionId: null, message: null, asks: false, startedAt: Date.now() });
    try {
      const made = await connectDevice(core, account, device.id, { takeOver });
      if (mine.cancelled) return;
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
      onLive?.({ device, sessionId: made.session_id });
      // The tab takes over from here; the attempt is done.
      set(device.id, null);
    } catch (e) {
      if (!mine.cancelled) set(device.id, { phase: 'error', message: messageOf(e, null), code: e?.code ?? null });
    } finally {
      active.current.delete(device.id);
    }
  }, [core, account, onLive, pollMs, set]);

  // Stops waiting. If the relay already made a session, ends it.
  const cancel = useCallback(async (deviceId) => {
    const mine = active.current.get(deviceId);
    const sessionId = conns[deviceId]?.sessionId;
    if (mine) mine.cancelled = true;
    active.current.delete(deviceId);
    set(deviceId, null);
    if (sessionId) {
      try {
        await endSession(core, account, sessionId);
      } catch (_) {
        // it may have ended already
      }
    }
  }, [conns, core, account, set]);

  const dismiss = useCallback((deviceId) => set(deviceId, null), [set]);

  return { conns, connect, cancel, dismiss };
}
