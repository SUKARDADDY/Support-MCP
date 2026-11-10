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
//   * Handing the session to the agent from this tab stops that loop and waits for a
//     screenshot in flight to settle before the task is started (holdScreenshots), because
//     the PC takes one command at a time and the agent's first step would fail with "agent
//     busy". The loop stays off for as long as a task is followed.
//   * Every 15 seconds it looks for a running task on the session, and switches to its picture.
//   * The session's own status (state, driver, log) is read every few seconds.
//
// The tab stays mounted (hidden) when another tab or screen is shown, so a task's status
// keeps being held open for as long as the task runs: the relay stops a task that nobody
// has watched for two minutes unless it was started with "keep working". Only the
// screenshot loop, the picture fetch and the session status poll wait for the tab to be on
// screen. No loop here ends in an unhandled rejection: a failed call is caught, waited out
// and tried again.
//
// No click or type request exists here or in the core's tool list.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { controlTask, isLiveTask, listTasks, screenshot, sessionStatus, taskFrame, taskOnSession, taskStatus } from './api.js';
import { useInterval } from './hooks.js';

const IMAGE_MIME = new Set(['image/jpeg', 'image/png']);
const FAILS_BEFORE_STOP = 3;
const MAX_RETRY_MS = 30000;

export const dataUrl = (img) => (img && IMAGE_MIME.has(img.mime) && /^[A-Za-z0-9+/=]+$/.test(img.data ?? '') ? `data:${img.mime};base64,${img.data}` : null);
const same = (a, b) => !!a && !!b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

// Why the screenshot loop stopped, from the relay's words, or null for a failure that passes.
export function stopReason(message) {
  const m = String(message ?? '');
  if (/is driving/i.test(m)) return 'driving';
  if (/agent busy/i.test(m)) return 'busy';
  return null;
}

// The steps, notes and log rows of a session in time order. While a task is shown, only the log
// rows from its start on are listed (an earlier task's commands and screens are not this one's),
// and while it covers a stretch of time its steps stand for the screenshots in the log.
export function mergeActivity({ log = [], task = null }) {
  const from = task?.created_at ?? null;
  const to = task ? (task.ended_at ?? Infinity) : null;
  const items = [];
  for (const r of log) {
    if (from !== null && r.ts < from) continue;
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
  const [held, setHeld] = useState(false); // a task is being started: no screenshot may begin
  const holds = useRef(0); // how many task starts hold the screenshots; each releases its own
  const inFlight = useRef(null); // the screenshot request on its way, if any
  const alive = useRef(true);
  const fails = useRef(0);
  const lastRev = useRef(null);
  useEffect(() => () => { alive.current = false; }, []);
  // What the tab is on now. An answer that comes back for another session or task (the tab adopted
  // a new session, or a task ended) is dropped, never applied to the new one.
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;
  const taskRef = useRef(taskId);
  taskRef.current = taskId;

  const ended = status?.state === 'ended' || status?.state === 'unknown';
  const attached = status?.state === 'attached';
  const isDriver = same(status?.driver, me.identity);
  const taskLive = !!taskId && !!task && isLiveTask(task);
  const onScreen = active && visible;

  // ---- the session's own status ---------------------------------------------------
  useInterval(async () => {
    if (!sessionId) return;
    const mine = sessionId;
    try {
      const st = await sessionStatus(core, account, mine, 60);
      if (alive.current && sessionRef.current === mine) { setStatus(st); setStatusError(null); }
    } catch (e) {
      if (alive.current && sessionRef.current === mine) setStatusError(e);
    }
  }, tuning.statusMs, !!sessionId && !ended && visible);

  // ---- finding the task that works on this session ----------------------------------
  const lookForTask = useCallback(async () => {
    const mine = sessionId;
    try {
      const found = taskOnSession(await listTasks(core, account), mine);
      if (alive.current && found && sessionRef.current === mine) setTaskId((cur) => cur ?? found.id);
    } catch (_) {
      // try again at the next check
    }
  }, [core, account, sessionId]);
  useInterval(lookForTask, tuning.taskCheckMs, !!sessionId && !taskLive && !ended && visible);

  // ---- following the task: a held-open status, and its picture when rev moves ---------
  const fetchFrame = useCallback(async (id) => {
    try {
      const f = await taskFrame(core, account, id);
      if (alive.current && taskRef.current === id) { setFrame(f); setFrameWaiting(false); }
      return true;
    } catch (e) {
      // A task that has not taken a picture yet (or whose object was evicted) has none: wait for the next.
      if (alive.current && taskRef.current === id && e?.code === 'no_frame') setFrameWaiting(true);
      return false;
    }
  }, [core, account]);
  const visibleRef = useRef(onScreen);
  visibleRef.current = onScreen;

  useEffect(() => {
    if (!taskId) return undefined;
    let stopped_ = false;
    lastRev.current = null;
    const pause = (ms) => new Promise((r) => setTimeout(r, ms));
    (async () => {
      let failures = 0;
      while (!stopped_) {
        const began = Date.now();
        try {
          const t = await taskStatus(core, account, taskId, tuning.taskWaitS);
          // A relay that answers with no task is a failed read, not a task to follow.
          if (!t || typeof t !== 'object' || typeof t.state !== 'string') throw new Error('the status holds no task');
          if (stopped_ || !alive.current) return;
          failures = 0;
          setTask(t);
          // A task that is working runs on a session this tab is not on (a task started on a PC makes its own
          // session, and the tab's old one may have ended): the tab adopts it, and App saves it with the tab.
          // A task that is over has nothing to adopt.
          if (t.session_id && t.session_id !== sessionRef.current && isLiveTask(t)) {
            sessionRef.current = t.session_id;
            setSessionId(t.session_id);
            setStatus(null);
            setStatusError(null);
            onSessionKnown?.(t.session_id);
          }
          if (!isLiveTask(t)) {
            // The task is over. The last picture stays until a screenshot replaces it.
            if (lastRev.current !== null && visibleRef.current) await fetchFrame(taskId);
            setTaskId(null);
            return;
          }
          if (t.rev !== lastRev.current) {
            lastRev.current = t.rev;
            // A fetch that fails (or finds no picture yet) is tried again at the next poll.
            if (visibleRef.current) { if (!(await fetchFrame(taskId))) lastRev.current = null; }
            else lastRev.current = null; // fetch it when the tab comes back
          }
          // The relay holds the call until something changes. One that comes back at once
          // (nothing new, or a relay that does not hold) must not turn this into a spin.
          const spent = Date.now() - began;
          if (spent < tuning.taskGapMs) await pause(tuning.taskGapMs - spent);
        } catch (e) {
          if (stopped_) return;
          if (e?.code === 'signed_out' || e?.status === 404) { setTaskId(null); return; }
          // Back off, longer after each failure in a row, and ask again.
          failures += 1;
          await pause(Math.min(tuning.taskRetryMs * 2 ** Math.min(failures - 1, 4), MAX_RETRY_MS));
        }
      }
    })().catch(() => { /* nothing escapes the loop */ });
    return () => { stopped_ = true; };
  }, [core, account, taskId, tuning.taskWaitS, tuning.taskGapMs, tuning.taskRetryMs, fetchFrame]); // eslint-disable-line react-hooks/exhaustive-deps

  // Back on screen with a task running: take its latest picture now. The status loop then
  // has nothing newer to fetch, so it does not fetch the same picture again.
  useEffect(() => {
    if (onScreen && taskLive) {
      lastRev.current = task.rev;
      // A fetch that fails must not stay marked as done: the next status poll tries again.
      fetchFrame(taskId).then((ok) => { if (!ok && lastRev.current === task.rev) lastRev.current = null; });
    }
  }, [onScreen]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- taking a picture every few seconds, when nobody else is -------------------------
  // Not while a task is followed (taskId), even before its first status has come back.
  const watching = attached && isDriver && !taskId && !taskLive && !stopped && canControl && onScreen && !held;
  useInterval(async () => {
    if (holds.current > 0) return;
    const mine = sessionId;
    try {
      const call = screenshot(core, account, mine);
      inFlight.current = call;
      const out = await call;
      fails.current = 0;
      if (alive.current && sessionRef.current === mine && out.image) setShot({ mime: out.image.mime, data: out.image.data, at: Date.now() });
    } catch (e) {
      const why = stopReason(e?.message);
      if (!alive.current || sessionRef.current !== mine) return;
      if (why) { setStopped(why); setStoppedMessage(e.message); return; }
      // "customer is using the PC" and other passing failures: try again next time, a few times.
      fails.current += 1;
      if (fails.current >= FAILS_BEFORE_STOP) { setStopped('failed'); setStoppedMessage(e?.message ?? null); }
    } finally {
      inFlight.current = null;
    }
  }, tuning.screenshotMs, watching);

  // Before a task is started on this session: stop the loop and let a request in flight finish
  // (whatever it answers), so the PC is free for the agent's first step.
  // Each start holds once and releases once, so one start failing does not free another's hold.
  const holdScreenshots = useCallback(async () => {
    holds.current += 1;
    setHeld(true);
    const pending = inFlight.current;
    if (pending) await pending.catch(() => {});
  }, []);
  const releaseScreenshots = useCallback(() => {
    holds.current = Math.max(0, holds.current - 1);
    setHeld(holds.current > 0);
  }, []);

  const resumeShots = useCallback(() => { fails.current = 0; setStopped(null); setStoppedMessage(null); }, []);

  // A new task makes a stopped loop worth trying again once it is over.
  useEffect(() => { if (taskLive) resumeShots(); }, [taskLive, resumeShots]);

  // ---- agent controls --------------------------------------------------------------
  const control = useCallback(async (action) => {
    if (taskId) await controlTask(core, account, taskId, action);
  }, [core, account, taskId]);

  const refreshStatus = useCallback(async () => {
    if (!sessionId) return;
    try {
      const st = await sessionStatus(core, account, sessionId, 60);
      if (alive.current && sessionRef.current === sessionId) setStatus(st);
    } catch (_) { /* the next poll tries again */ }
  }, [core, account, sessionId]);

  const watchTask = useCallback((id) => { setTask(null); setFrame(null); setTaskId(id); }, []);

  const activity = useMemo(() => mergeActivity({ log: status?.log ?? [], task }), [status, task]);

  return {
    sessionId, taskId, status, statusError, ended, attached, isDriver, task, taskLive, frame, frameWaiting, shot,
    stopped, stoppedMessage, resumeShots, activity, control, refreshStatus, watchTask, lookForTask, holdScreenshots, releaseScreenshots,
  };
}
