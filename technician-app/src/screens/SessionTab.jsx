import { useEffect, useRef, useState } from 'react';
import { connectDevice, messageOf } from '../api.js';
import { Icon } from '../components/Icon.jsx';
import { useApp } from '../context.jsx';
import { formatClock, formatDuration, formatUsd, taskTitle } from '../format.js';
import { t } from '../i18n/index.js';
import { dataUrl, useSession } from '../session.js';
import { AgentStartDialog } from './AgentStartDialog.jsx';

const KNOWN_KINDS = ['created', 'consumed', 'attached', 'hello', 'detached', 'declined', 'driver', 'ended', 'screen', 'run', 'put_file', 'get_file', 'control'];

// A session with a PC: its screen (the agent's last picture during a task, otherwise a fresh
// one every few seconds while you are the driver), what has happened, and the ways to end it
// or take it over. There are no click or type controls: this tab only watches. Everything
// from the PC (the picture, step details, notes, log text) is untrusted and shown as text.
export function SessionTab({ tab, active = true }) {
  const { core, tuning, me, can, endTab, closeTab, toast, updateTab, devices, visible, titleOf } = useApp();
  const [showActivity, setShowActivity] = useState(true);
  const [agentOpen, setAgentOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [opened] = useState(() => Date.now());
  const s = useSession({
    core, account: tab.account, tab, active, me, canControl: can('sessions.control'), tuning, visible,
    onSessionKnown: (sid) => updateTab(tab.key, { sessionId: sid }),
  });
  const device = devices.find((d) => d.id === tab.deviceId) ?? null;
  const name = tab.deviceName || device?.name || t('session.untitled');

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // What a screen reader hears from the task: a new note from the agent, or that the task is
  // over. Its steps are not read out one by one; the list below is there to be read on demand.
  const [announcement, setAnnouncement] = useState('');
  const seen = useRef({ notes: null, over: false });
  useEffect(() => {
    if (!s.task) return;
    const notes = s.task.notes ?? [];
    const over = !s.taskLive;
    if (seen.current.notes === null) {
      // The first look at a task is not news.
      seen.current = { notes: notes.length, over };
      return;
    }
    if (over && !seen.current.over) setAnnouncement(t('session.task_over', { state: t(`task.${s.task.state}`) }));
    else if (notes.length > seen.current.notes) setAnnouncement(String(notes[notes.length - 1].text ?? ''));
    seen.current = { notes: notes.length, over };
  }, [s.task, s.taskLive]);

  // What the task has cost so far, against the team's cap for one task.
  const cost = Number.isFinite(s.task?.cost_usd)
    ? { spent: formatUsd(s.task.cost_usd), cap: Number.isFinite(s.task.caps?.task_cap_usd) ? formatUsd(s.task.caps.task_cap_usd) : null }
    : null;

  const image = dataUrl(s.taskLive ? s.frame : s.shot ?? s.frame);
  const driver = s.status?.driver ?? null;

  let stateWord = t('session.state_waiting');
  if (s.ended) stateWord = t('session.state_ended');
  else if (s.attached) stateWord = t('session.state_connected');

  let caption;
  if (s.ended) caption = t('session.cap_ended');
  else if (s.taskLive) caption = s.task?.state === 'paused' ? t('session.cap_task_paused') : s.frameWaiting && !image ? t('session.cap_task_waiting') : t('session.cap_task');
  else if (!can('sessions.control')) caption = t('session.cap_no_permission');
  else if (!s.attached) caption = t('session.cap_not_attached');
  else if (s.stopped === 'driving') caption = t('session.cap_driving', { who: driver ?? '' });
  else if (s.stopped === 'busy') caption = t('session.cap_busy');
  else if (s.stopped === 'failed') caption = t('session.cap_failed');
  else if (!s.isDriver) caption = t('session.cap_not_driver', { who: driver ?? '' });
  else caption = t('session.cap_view_only');

  async function takeOver() {
    try {
      await connectDevice(core, tab.account, tab.deviceId, { takeOver: true });
      toast(t('session.took_over'));
      s.resumeShots();
      await s.refreshStatus();
    } catch (e) {
      toast(messageOf(e, t('session.take_over_failed')));
    }
  }

  async function run(action, doneKey) {
    try {
      await s.control(action);
      toast(t(doneKey));
    } catch (e) {
      toast(messageOf(e, t('session.control_failed')));
    }
  }

  const canTakeOver = can('sessions.unattended') && s.attached && !s.isDriver && !!driver && !!tab.deviceId;
  const canHandOver = can('sessions.control') && s.attached && s.isDriver && !s.taskLive;

  return (
    <div className="sess">
      <p className="sr announce" role="status" aria-live="polite">{announcement}</p>
      <div className="sess-bar">
        <div className="sess-id">
          <h2 className="sess-name" tabIndex={-1}>{name}</h2>
          <p className="sess-meta">
            <span className="state">{stateWord}</span>
            {!s.ended ? <><span aria-hidden="true">·</span><span>{formatDuration(now - opened)}</span></> : null}
            {s.status?.machine ? <><span aria-hidden="true">·</span><span>{s.status.machine}</span></> : null}
            {driver ? <><span aria-hidden="true">·</span><span>{s.isDriver ? t('session.you_drive') : t('session.driver_is', { who: driver })}</span></> : null}
          </p>
        </div>
        <div className="sess-tools">
          {s.taskLive ? (
            <>
              {s.task?.state === 'paused'
                ? <button type="button" className="btn btn-sec btn-sm" onClick={() => run('resume', 'session.resumed')} disabled={!can('sessions.control')}>{t('session.resume')}</button>
                : <button type="button" className="btn btn-sec btn-sm" onClick={() => run('pause', 'session.paused')} disabled={!can('sessions.control')}>{t('session.pause')}</button>}
              <button type="button" className="btn btn-sec btn-sm" onClick={() => run('stop', 'session.task_stopped')} disabled={!can('sessions.control')}>{t('session.stop_task')}</button>
            </>
          ) : null}
          {canHandOver ? <button type="button" className="btn btn-sec btn-sm" onClick={() => setAgentOpen(true)}>{t('agent.hand_over')}</button> : null}
          {canTakeOver ? <button type="button" className="btn btn-pri btn-sm" onClick={takeOver}>{t('connect.take_over')}</button> : null}
          <button type="button" className="btn btn-sec btn-sm" aria-pressed={showActivity} onClick={() => setShowActivity((v) => !v)}>{t('session.activity')}</button>
          {s.ended
            ? <button type="button" className="btn btn-sec btn-sm" onClick={() => closeTab(tab.key)}>{t('session.close_tab')}</button>
            : <button type="button" className="btn btn-end btn-sm" onClick={() => endTab(tab.key)}>{t('session.end')}</button>}
        </div>
      </div>
      <div className={`sess-main${showActivity ? '' : ' wide'}`}>
        <div className="viewport">
          {image ? (
            <div className="screen"><img src={image} alt={t('session.screen_alt', { name })} /></div>
          ) : (
            <div className="screen none" role="status">{s.ended ? t('session.no_picture_ended') : t('session.no_picture')}</div>
          )}
          <p className="vp-cap" role="status">{caption}</p>
          {s.stopped && !s.taskLive && !s.ended ? (
            <button type="button" className="btn btn-sec btn-sm" onClick={s.resumeShots}>{t('session.try_again')}</button>
          ) : null}
          {s.stopped && s.stoppedMessage ? <p className="vp-cap">{s.stoppedMessage}</p> : null}
        </div>
        {showActivity ? (
          <aside className="act" aria-label={t('session.activity_label')}>
            <h3>{s.task ? t('session.agent_activity') : t('session.activity')}</h3>
            {s.task ? <p className="task">{taskTitle(s.task.title, titleOf(s.task.id))}</p> : null}
            {s.taskLive && cost ? <p className="cost">{cost.cap === null ? t('session.cost_running_nocap', { spent: cost.spent }) : t('session.cost_running', { spent: cost.spent, cap: cost.cap })}</p> : null}
            {s.task?.notice ? <p className="paused">{s.task.notice}</p> : null}
            {s.task?.state === 'paused' ? <p className="paused">{t('session.task_paused_note')}</p> : null}
            {s.activity.length === 0 ? <p className="hint">{t('session.activity_empty')}</p> : (
              <ol className="tl">
                {s.activity.map((a) => (
                  <li key={a.id} className={a.source === 'step' ? (a.ok ? 'step' : 'step fail') : a.source}>
                    <span className="mk">{a.source === 'step' ? <Icon name={a.ok ? 'check' : 'x'} /> : null}</span>
                    <p className="tl-h">
                      <span>{a.source === 'step' ? a.verb : a.source === 'note' ? t('session.note') : KNOWN_KINDS.includes(a.kind) ? t(`activity.${a.kind}`) : a.kind}</span>
                      <span className="t">{formatClock(a.ts)}</span>
                    </p>
                    {a.detail ? <p className="tl-d">{a.detail}</p> : null}
                  </li>
                ))}
              </ol>
            )}
            {s.task && !s.taskLive && s.task.summary ? <p className="tl-end"><b>{t('session.summary')}</b> {s.task.summary}</p> : null}
            {s.task && !s.taskLive && cost ? <p className="tl-end cost">{cost.cap === null ? t('session.cost_final_nocap', { spent: cost.spent }) : t('session.cost_final', { spent: cost.spent, cap: cost.cap })}</p> : null}
            {s.task && !s.taskLive && s.task.state && s.task.state !== 'running' ? <p className="hint">{t('session.task_over', { state: t(`task.${s.task.state}`) })}</p> : null}
          </aside>
        ) : null}
      </div>
      {agentOpen ? <AgentStartDialog sessionId={s.sessionId} onClose={() => setAgentOpen(false)} beforeStart={s.holdScreenshots} onStartFailed={s.releaseScreenshots} onStarted={(started) => { s.watchTask(started.task_id); s.releaseScreenshots(); }} /> : null}
    </div>
  );
}
