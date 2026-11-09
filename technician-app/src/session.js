// What a session tab does, as one hook. The tab is view only:
//
//   * While a built-in agent task works on the session, the tab shows the picture the task
//     last took (GET .../frame). The task's status is held open on the relay (wait_s, up to 25
//     seconds) and returns when something changes; whenever its `rev` has moved, the tab
//     fetches the picture again. The app never takes its own screenshot during a task: the PC
//     handles one command at a time and the agent's next one would fail with "agent busy".
//   * Otherwise, when you are the driver, the tab is on screen and the window is visible, it
//     takes a screenshot every few seconds. It stops at once when the relay answers "is
//     driving" (someone else took over) or "agent busy", and starts again only on request.
//   * Every 15 seconds it looks for a running task on the session, and switches to its picture.
//   * The session's own status (state, driver, log) is read every few seconds.
//
// No click or type request exists here or in the core's tool list.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { controlTask, isLiveTask, listTasks, screenshot, sessionStatus, taskFrame, taskOnSession, taskStatus } from './api.js';
import { useInterval } from './hooks.js';

const IMAGE_MIME = new Set(['image/jpeg', 'image/png']);
const FAILS_BEFORE_STOP = 3;

export const dataUrl = (img) => (img && IMAGE_MIME.has(img.mime) && /^[A-Za-z0-9+/=]+$/.test(img.data ?? '') ? `data:${img.mime};base64,${img.data}` : null);
const same = (a, b) => !!a && !!b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

// Why the screenshot loop stopped, from the relay's words, or null for a failure that passes.
export function stopReason(message) {
  const m = String(message ?? '');
  if (/is driving/i.test(m)) return 'driving';
  if (/agent busy/i.test(m)) return 'busy';
  return null;
}

// The steps, notes and log rows of a session in time order. While a task covers a stretch of
// time its steps stand for the screenshots in the log, so those rows are left out.
export function mergeActivity({ log = [], task = null }) {
  const from = task?.created_at ?? null;
  const to = task ? (task.ended_at ?? Infinity) : null;
  const items = [];
  for (const r of log) {
    if (r.kind === 'screen' && from !== null && r.ts >= from && r.ts <= to) continue;
    items.push({ id: `log:${r.ts}:${r.kind}:${items.length}`, ts: r.ts, source: 'log', kind: r.kind, detail: String(r.detail ?? '') });
  }
  for (const s of task?.steps ?? []) items.push({ id: `step:${s.n}`, ts: s.ts, source: 'step', verb: s.verb, detail: String(s.detail ?? ''), ok: s.ok !== false });
  (task?.notes ?? []).forEach((n, i) => items.push({ id: `note:${n.ts}:${i}`, ts: n.ts, source: 'note', detail: String(n.text ?? '') }));
  return items.sort((a, b) => a.ts - b.ts).slice(-120);
}

export function useSession({ core, account, tab, active, me, canControl, tuning, visible, onSessionKnown }) {
  const [sessionId, setSessionId] = useState(tab.sessionId);
  const [status, setStatus] = useState(null);
  const [statusError, setStatusError] = useState(null);
  const [taskId, setTaskId] = useState(tab.taskId);
  const [task, setTask] = useState(null);
  const [frame, setFrame] = useState(null);
  const [frameWaiting, setFrameWaiting] = useState(false);
  const [shot, setShot] = useState(null);
  const [stopped, setStopped] = useState(null); // null, 'driving', 'busy' or 'failed'
  const [stoppedMessage, setStoppedMessage] = useState(null);
  const alive = useRef(true);
  const fails = useRef(0);
  const lastRev = useRef(null);
  useEffect(() => () => { alive.current = false; }, []);

  const ended = status?.state === 'ended' || status?.state === 'unknown';
  const attached = status?.state === 'attached';
  const isDriver = same(status?.driver, me.identity);
  const taskLive = !!taskId && !!task && isLiveTask(task);
  const onScreen = active && visible;

  // ---- the session's own status ---------------------------------------------------
  useInterval(async () => {
    if (!sessionId) return;
    try {
      const st = await sessionStatus(core, account, sessionId, 60);
      if (alive.current) { setStatus(st); setStatusError(null); }
    } catch (e) {
      if (alive.current) setStatusError(e);
    }
  }, tuning.statusMs, !!sessionId && !ended && onScreen);

  // ---- finding the task that works on this session ----------------------------------
  const lookForTask = useCallback(async () => {
    try {
      const found = taskOnSession(await listTasks(core, account), sessionId);
      if (alive.current && found) setTaskId((cur) => cur ?? found.id);
    } catch (_) {
      // try again at the next check
    }
  }, [core, account, sessionId]);
  useInterval(lookForTask, tuning.taskCheckMs, !!sessionId && !taskLive && !ended && onScreen);

  // ---- following the task: a held-open status, and its picture when rev moves ---------
  const fetchFrame = useCallback(async (id) => {
    try {
      const f = await taskFrame(core, account, id);
      if (alive.current) { setFrame(f); setFrameWaiting(false); }
    } catch (e) {
      // A task that has not taken a picture yet (or whose object was evicted) has none: wait for the next.
      if (alive.current && e?.code === 'no_frame') setFrameWaiting(true);
    }
  }, [core, account]);
  const visibleRef = useRef(onScreen);
  visibleRef.current = onScreen;

  useEffect(() => {
    if (!taskId) return undefined;
    let stopped_ = false;
    lastRev.current = null;
    (async () => {
      while (!stopped_) {
        const began = Date.now();
        let t;
        try {
          t = await taskStatus(core, account, taskId, tuning.taskWaitS);
        } catch (e) {
          if (stopped_) return;
          if (e?.code === 'signed_out' || e?.status === 404) { setTaskId(null); return; }
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
        if (stopped_ || !alive.current) return;
        setTask(t);
        if (t.session_id && !sessionId) { setSessionId(t.session_id); onSessionKnown?.(t.session_id); }
        if (!isLiveTask(t)) {
          // The task is over. The last picture stays until a screenshot replaces it.
          if (lastRev.current !== null && visibleRef.current) await fetchFrame(taskId);
          setTaskId(null);
          return;
        }
        if (t.rev !== lastRev.current) {
          lastRev.current = t.rev;
          if (visibleRef.current) await fetchFrame(taskId);
          else lastRev.current = null; // fetch it when the tab comes back
        }
        // The relay holds the call until something changes. One that comes back at once
        // (nothing new, or a relay that does not hold) must not turn this into a spin.
        const spent = Date.now() - began;
        if (spent < tuning.taskGapMs) await new Promise((r) => setTimeout(r, tuning.taskGapMs - spent));
      }
    })();
    return () => { stopped_ = true; };
  }, [core, account, taskId, tuning.taskWaitS, tuning.taskGapMs, fetchFrame]); // eslint-disable-line react-hooks/exhaustive-deps

  // Back on screen with a task running: take its latest picture now.
  useEffect(() => {
    if (onScreen && taskLive) fetchFrame(taskId);
  }, [onScreen]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- taking a picture every few seconds, when nobody else is -------------------------
  const watching = attached && isDriver && !taskLive && !stopped && canControl && onScreen;
  useInterval(async () => {
    try {
      const out = await screenshot(core, account, sessionId);
      fails.current = 0;
      if (alive.current && out.image) setShot({ mime: out.image.mime, data: out.image.data, at: Date.now() });
    } catch (e) {
      const why = stopReason(e?.message);
      if (!alive.current) return;
      if (why) { setStopped(why); setStoppedMessage(e.message); return; }
      // "customer is using the PC" and other passing failures: try again next time, a few times.
      fails.current += 1;
      if (fails.current >= FAILS_BEFORE_STOP) { setStopped('failed'); setStoppedMessage(e?.message ?? null); }
    }
  }, tuning.screenshotMs, watching);

  const resumeShots = useCallback(() => { fails.current = 0; setStopped(null); setStoppedMessage(null); }, []);

  // A new task makes a stopped loop worth trying again once it is over.
  useEffect(() => { if (taskLive) resumeShots(); }, [taskLive, resumeShots]);

  // ---- agent controls --------------------------------------------------------------
  const control = useCallback(async (action) => {
    if (taskId) await controlTask(core, account, taskId, action);
  }, [core, account, taskId]);

  const refreshStatus = useCallback(async () => {
    if (!sessionId) return;
    try { setStatus(await sessionStatus(core, account, sessionId, 60)); } catch (_) { /* the next poll tries again */ }
  }, [core, account, sessionId]);

  const watchTask = useCallback((id) => { setTask(null); setFrame(null); setTaskId(id); }, []);

  const activity = useMemo(() => mergeActivity({ log: status?.log ?? [], task }), [status, task]);

  return {
    sessionId, status, statusError, ended, attached, isDriver, task, taskLive, frame, frameWaiting, shot,
    stopped, stoppedMessage, resumeShots, activity, control, refreshStatus, watchTask, lookForTask,
  };
}
