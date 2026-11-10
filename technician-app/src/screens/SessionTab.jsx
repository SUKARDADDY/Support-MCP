import { useEffect, useRef, useState } from 'react';
import { connectDevice, messageOf, refusalText } from '../api.js';
import { Icon } from '../components/Icon.jsx';
import { useApp } from '../context.jsx';
import { useAccountMe } from '../hooks.js';
import { formatAge, formatClock, formatDuration, formatUsd, taskTitle } from '../format.js';
import { t } from '../i18n/index.js';
import { dataUrl, same, useSession } from '../session.js';
import { AgentStartDialog } from './AgentStartDialog.jsx';
import { EscalateDialog } from './EscalateDialog.jsx';
import { HandOverDialog } from './HandOverDialog.jsx';
import { InviteDialog } from './InviteDialog.jsx';

const KNOWN_KINDS = ['created', 'consumed', 'attached', 'hello', 'detached', 'declined', 'driver', 'ended', 'screen', 'run', 'put_file', 'get_file', 'control'];

// A session with a PC, or a one-off link's: its screen (the agent's last picture during a task,
// otherwise a fresh one every few seconds while you are the driver, and for a watcher the last
// picture the driver or the agent took, with its age), the people in it, what has happened, and
// the ways to invite, hand over, escalate, leave, end or take over. There are no click or type
// controls. Everything from the PC (the picture, step details, notes, log text) and the people's
// names are untrusted and shown as text.
export function SessionTab({ tab, active = true }) {
  const { core, tuning, me: shownMe, account: shown, endTab, closeTab, leaveTab, toast, isShown, updateTab, devices, visible, titleOf, registerTab, markEnded, markStance } = useApp();
  // This tab's person is the one of its own account, which is not the shown account's when the tab is hidden.
  const me = useAccountMe(core, tab.account, shown?.id, shownMe);
  const can = (permission) => me.permissions.includes(permission);
  const [showActivity, setShowActivity] = useState(true);
  const [agentOpen, setAgentOpen] = useState(false);
  const [dialog, setDialog] = useState(null); // 'invite', 'handover' or 'escalate'
  const [peopleError, setPeopleError] = useState(null);
  const [busyPeople, setBusyPeople] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [opened] = useState(() => Date.now());
  const s = useSession({
    core, account: tab.account, tab, active, me, canControl: can('sessions.control'), tuning, visible,
    onSessionKnown: (sid) => updateTab(tab.key, { sessionId: sid }),
  });
  // Lets App quiet this tab before any task starts on its PC or session, and hand it the task.
  const latest = useRef(null);
  latest.current = { tab, s };
  useEffect(() => registerTab(tab.key, {
    key: tab.key,
    account: tab.account,
    deviceId: () => latest.current.tab.deviceId ?? null,
    sessionId: () => latest.current.s.sessionId ?? null,
    ended: () => latest.current.s.ended,
    // The session, when it is connected and the person drives it: a task can start on it.
    liveSession: () => { const { s: cur } = latest.current; return cur.attached && cur.isDriver && !cur.ended ? cur.sessionId ?? null : null; },
    hold: () => latest.current.s.holdScreenshots(),
    release: () => latest.current.s.releaseScreenshots(),
    follow: (taskId) => { try { latest.current.s.watchTask(taskId); } finally { latest.current.s.releaseScreenshots(); } },
  }), [registerTab, tab.key, tab.account]);

  // Tells App whether this tab's session has ended, so a screen that looks for the tab on a PC redraws.
  useEffect(() => { markEnded(tab.key, s.ended); }, [tab.key, s.ended, markEnded]);
  // ... and what closing it does: end a session you drive, leave one you watch, otherwise just close.
  const stance = s.role === 'watcher' ? 'leave' : s.mayEnd ? 'end' : 'close';
  useEffect(() => { markStance(tab.key, stance); }, [tab.key, stance, markStance]);

  // The task this tab follows is saved with the tab, so a restart follows it again (the relay stops
  // a task nobody watches for two minutes), and cleared when the task is over.
  useEffect(() => {
    if ((s.taskId ?? null) !== (tab.taskId ?? null)) updateTab(tab.key, { taskId: s.taskId ?? null });
  }, [s.taskId, tab.taskId, tab.key, updateTab]);

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

  const image = dataUrl(s.taskLive ? s.frame : s.isWatcher ? s.watcherFrame : s.shot ?? s.frame ?? s.watcherFrame);
  const driver = s.status?.driver ?? null;
  const nameOf = (identity) => { const p = s.participants.find((x) => same(x.identity, identity)); return p?.name || p?.identity || identity; };

  let stateWord = t('session.state_waiting');
  if (s.ended) stateWord = t('session.state_ended');
  else if (s.attached) stateWord = t('session.state_connected');

  let caption;
  if (s.ended) caption = t('session.cap_ended');
  else if (s.taskLive) caption = s.task?.state === 'paused' ? t('session.cap_task_paused') : s.frameWaiting && !image ? t('session.cap_task_waiting') : t('session.cap_task');
  else if (!can('sessions.control')) caption = t('session.cap_no_permission');
  else if (s.role === 'invited') caption = t('session.cap_invited', { who: driver ? nameOf(driver) : '' });
  else if (s.isWatcher) caption = s.frameProblem ? refusalText(s.frameProblem, t('session.cap_watch_failed')) : t('session.cap_watching', { who: driver ? nameOf(driver) : '' });
  else if (!s.attached) caption = t('session.cap_not_attached');
  else if (s.stopped === 'driving') caption = t('session.cap_driving', { who: driver ?? '' });
  else if (s.stopped === 'busy') caption = t('session.cap_busy');
  else if (s.stopped === 'failed' || s.stopped === 'ended') caption = t('session.cap_failed');
  else if (!s.isDriver) caption = t('session.cap_not_driver', { who: driver ?? '' });
  else caption = t('session.cap_view_only');

  async function takeOver() {
    try {
      // A saved PC is taken over by connecting again; a one-off link's session has no PC to connect to.
      if (tab.deviceId) await connectDevice(core, tab.account, tab.deviceId, { takeOver: true });
      else await s.people.takeOver();
      say(t('session.took_over'));
      s.resumeShots();
      await s.refreshStatus();
    } catch (e) {
      say(refusalText(e, t('session.take_over_failed')));
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

  const canTakeOver = can('sessions.unattended') && s.attached && !s.isDriver && !!driver && s.role !== 'invited';
  const canHandOver = can('sessions.control') && s.attached && s.isDriver && !s.taskLive;
  const driving = s.role === 'driver' && !s.ended;
  const watchers = s.participants.filter((p) => p.role === 'watcher');
  const offerToMe = s.offer && same(s.offer.to, me.identity) && s.offer.expires_at > now ? s.offer : null;
  const offerByMe = s.offer && same(s.offer.by, me.identity) && s.offer.expires_at > now ? s.offer : null;
  // Only a tab whose person drives the session, as the relay last said, ends it (see mayEnd in session.js); a tab
  // for a session you were invited to, were removed from or have not heard of yet closes without ending it. A watcher leaves.
  const closeOnly = s.ended || (s.role !== 'watcher' && !s.mayEnd);

  // A message about a person-to-person action goes to the screen only while the tab's team is the one shown:
  // an answer that comes back after a switch of team is not announced under the other team.
  const say = (text) => { if (isShown(tab.account)) toast(text); };

  // One person-to-person action: its refusal is told in our words for the code, and the tab stays as it is.
  async function people(call, doneKey, vars) {
    if (busyPeople) return;
    setBusyPeople(true);
    setPeopleError(null);
    try {
      await call();
      if (doneKey) say(t(doneKey, vars));
      s.resumeShots();
      s.refreshStatus();
    } catch (e) {
      setPeopleError(refusalText(e, t('people.failed')));
    } finally {
      setBusyPeople(false);
    }
  }

  // An invite opened from a notification joins on its own as soon as the status says you were invited.
  const joining = useRef(false);
  const join = () => people(() => s.people.join(), 'people.joined');
  useEffect(() => {
    if (!tab.joinOnOpen) return;
    if (s.role === 'invited') {
      if (joining.current) return;
      joining.current = true;
      Promise.resolve(join()).finally(() => { joining.current = false; updateTab(tab.key, { joinOnOpen: false }); });
    } else if (s.status && (s.role || s.ended)) {
      updateTab(tab.key, { joinOnOpen: false });
    }
  }, [tab.joinOnOpen, s.role, s.status, s.ended]); // eslint-disable-line react-hooks/exhaustive-deps

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
            {driver && !s.ended ? <><span aria-hidden="true">·</span><span>{s.isDriver ? t('session.you_drive') : t('session.driver_is', { who: driver })}</span></> : null}
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
          {driving && can('sessions.control') && s.attached ? (
            <>
              <button type="button" className="btn btn-sec btn-sm" onClick={() => setDialog('invite')}>{t('people.invite')}</button>
              <button type="button" className="btn btn-sec btn-sm" onClick={() => setDialog('handover')} disabled={!!s.offer}>{t('people.hand_over')}</button>
              <button type="button" className="btn btn-sec btn-sm" onClick={() => setDialog('escalate')}>{t('people.escalate')}</button>
            </>
          ) : null}
          {s.role === 'invited' ? <button type="button" className="btn btn-pri btn-sm" onClick={join} disabled={busyPeople}>{t('people.join')}</button> : null}
          {canTakeOver ? <button type="button" className="btn btn-pri btn-sm" onClick={takeOver}>{t('connect.take_over')}</button> : null}
          <button type="button" className="btn btn-sec btn-sm" aria-pressed={showActivity} onClick={() => setShowActivity((v) => !v)}>{t('session.activity')}</button>
          {closeOnly
            ? <button type="button" className="btn btn-sec btn-sm" onClick={() => closeTab(tab.key)}>{t('session.close_tab')}</button>
            : s.role === 'watcher'
              ? <button type="button" className="btn btn-end btn-sm" onClick={() => leaveTab(tab.key)}>{t('people.leave')}</button>
              : <button type="button" className="btn btn-end btn-sm" onClick={() => endTab(tab.key)}>{t('session.end')}</button>}
        </div>
      </div>
      {offerToMe ? (
        <div className="offer" role="alert">
          <p>{t('people.offer_to_you', { who: nameOf(offerToMe.by) })}</p>
          <div className="acts">
            <button type="button" className="btn btn-pri btn-sm" disabled={busyPeople} onClick={() => people(() => s.people.accept(), 'people.took_control')}>{t('people.take_control')}</button>
            <button type="button" className="btn btn-sec btn-sm" disabled={busyPeople} onClick={() => people(() => s.people.decline())}>{t('people.not_now')}</button>
          </div>
        </div>
      ) : null}
      {offerByMe ? (
        <div className="offer" role="status">
          <p>{t('people.offer_by_you', { who: nameOf(offerByMe.to), until: formatClock(offerByMe.expires_at) })}</p>
          <div className="acts"><button type="button" className="btn btn-sec btn-sm" disabled={busyPeople} onClick={() => people(() => s.people.cancelOffer())}>{t('people.cancel_offer')}</button></div>
        </div>
      ) : null}
      {peopleError ? <p className="err people-err" role="alert">{peopleError}</p> : null}
      {s.participants.length && !s.ended ? (
        <section className="roster" aria-label={t('people.label')}>
          <h3>{t('people.label')}</h3>
          <ul>
            {s.participants.map((p) => (
              <li key={p.identity} data-role={p.role}>
                <span className="who">{p.name || p.identity}{same(p.identity, me.identity) ? ` (${t('people.you')})` : ''}</span>
                <span className="role">{t(`people.role_${p.role}`)}</span>
                {driving && p.role !== 'driver' ? (
                  <button type="button" className="btn btn-sec btn-xs" disabled={busyPeople} aria-label={t('people.remove_with', { name: p.name || p.identity })} onClick={() => people(() => s.people.remove(p.identity), 'people.removed', { name: p.name || p.identity })}>{t('people.remove')}</button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <div className={`sess-main${showActivity ? '' : ' wide'}`}>
        <div className="viewport">
          {image ? (
            <div className="screen"><img src={image} alt={t('session.screen_alt', { name })} /></div>
          ) : (
            <div className="screen none" role="status">{s.ended ? t('session.no_picture_ended') : t('session.no_picture')}</div>
          )}
          <p className="vp-cap" role="status">{caption}</p>
          {s.isWatcher && s.watcherFrame && !s.taskLive ? <p className="vp-cap" role="status">{t('session.picture_age', { age: formatAge(s.watcherFrame.at, now) })}</p> : null}
          {s.stopped && !s.taskLive && !s.ended && s.isDriver ? (
            <button type="button" className="btn btn-sec btn-sm" onClick={s.resumeShots}>{t('session.try_again')}</button>
          ) : null}
          {s.stopped === 'failed' && s.stoppedMessage && !s.ended ? <p className="vp-cap">{s.stoppedMessage}</p> : null}
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
            {s.task && !s.taskLive && s.task.state && s.task.state !== 'done' && s.task.end_reason ? <p className="hint">{t('session.task_end_reason', { reason: s.task.end_reason })}</p> : null}
          </aside>
        ) : null}
      </div>
      {dialog === 'invite' ? (
        <InviteDialog
          account={tab.account}
          participants={s.participants}
          onInvite={async (identity, person) => { await s.people.invite(identity); say(t('people.invited', { name: person?.name || identity })); }}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === 'handover' ? (
        <HandOverDialog
          watchers={watchers}
          taskLive={s.taskLive}
          onOffer={async (identity, person) => { await s.people.offer(identity); say(t('people.offered', { name: person?.name || identity })); }}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === 'escalate' ? (
        <EscalateDialog onSend={async (note) => { await s.people.escalate(note); say(t('people.escalated')); }} onClose={() => setDialog(null)} />
      ) : null}
      {agentOpen ? <AgentStartDialog sessionId={s.sessionId} accountId={tab.account} onClose={() => setAgentOpen(false)} /> : null}
    </div>
  );
}
