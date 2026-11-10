// A tab that adopts another session while a call for its old one is on the way: the old session's
// people answer and its picture are never applied to the new one.
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { useSession } from './session.js';
import { FAST, ID, ToolFail, fakeCore } from './test-utils.jsx';

const SID = 's'.repeat(64);
const SID2 = 'u'.repeat(64);
const TASK = ID('t');
const ME = 'tech@example.com';
const LEAD = 'lead@example.com';
const sleep = (ms) => act(() => new Promise((r) => setTimeout(r, ms)));
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const person = (identity, role) => ({ identity, name: null, role, since: Date.now() - 30000 });
const liveTask = () => ({ id: TASK, state: 'running', title: 'Fix', session_id: SID, device_id: ID('a'), created_at: Date.now(), ended_at: null, phase: 'working', rev: 1, steps: [], notes: [] });

// A fake relay on which the task the tab follows moves from SID to SID2 when `move()` is called.
function movingWorld(sessions) {
  const fake = fakeCore();
  let moved = false;
  fake.state.tasks = [liveTask()];
  fake.state.taskStatus = (t) => ({ ...t, session_id: moved ? SID2 : SID });
  fake.state.sessionStatus = (args) => ({ state: 'attached', log: [], ...sessions[args.session_id] });
  const props = (over = {}) => ({ core: fake.core, account: 'acc1', tab: { key: SID, sessionId: SID, taskId: TASK }, active: true, me: { identity: ME }, canControl: true, tuning: FAST, visible: true, onSessionKnown: () => {}, ...over });
  return { fake, props, move: () => { moved = true; } };
}

describe('a people answer for the session the tab has left', () => {
  const sessions = {
    [SID]: { driver: ME, participants: [person(ME, 'driver')] },
    [SID2]: { driver: LEAD, participants: [person(LEAD, 'driver'), person(ME, 'watcher')] },
  };

  test('is not applied to the session the tab is on now', async () => {
    const { fake, props, move } = movingWorld(sessions);
    const gate = deferred();
    fake.state.participantsCall = async () => { await gate.promise; return { participants: [person(ME, 'driver'), person('old@example.com', 'invited')] }; };
    fake.state.handoverCall = async () => { await gate.promise; return { driver: 'old@example.com', participants: [person('old@example.com', 'driver')], offer: { to: 'old@example.com', by: ME, expires_at: Date.now() + 60000 } }; };
    const { result } = renderHook(() => useSession(props()));
    await waitFor(() => expect(result.current.participants.map((p) => p.identity)).toEqual([ME]));
    let invite;
    let offer;
    act(() => { invite = result.current.people.invite('old@example.com'); offer = result.current.people.offer('old@example.com'); });
    await waitFor(() => expect(fake.core.tool.mock.calls.filter((c) => c[1] === 'session_participants' || c[1] === 'session_handover')).toHaveLength(2));
    move();
    await waitFor(() => expect(result.current.sessionId).toBe(SID2));
    await waitFor(() => expect(result.current.status?.driver).toBe(LEAD));
    await act(async () => { gate.resolve(); await Promise.all([invite, offer]); });
    await sleep(10);
    expect(result.current.status.driver).toBe(LEAD);
    expect(result.current.participants.map((p) => p.identity)).toEqual([LEAD, ME]);
    expect(result.current.offer).toBeNull();
  });
});

describe('a watcher\'s picture for the session the tab has left', () => {
  const watching = (frame_rev) => ({ driver: LEAD, participants: [person(LEAD, 'driver'), person(ME, 'watcher')], frame_rev });
  const sessions = { [SID]: watching(1), [SID2]: watching(1) };
  const frame = { rev: 1, at: Date.now(), mime: 'image/jpeg', data: 'QUJD' };
  // A slow status poll, so the new session's problem is not read again and cleared while the old answer is awaited.
  const SLOW = { ...FAST, statusMs: 600 };

  test('a failure of the old one does not become the new session\'s problem', async () => {
    const { fake, props, move } = movingWorld(sessions);
    const old = deferred();
    fake.state.sessionFrame = (sid) => (sid === SID ? old.promise : frame);
    const { result } = renderHook(() => useSession(props({ tuning: SLOW })));
    await waitFor(() => expect(fake.core.request.mock.calls.some((c) => c[2] === `/api/sessions/${SID}/frame`)).toBe(true));
    move();
    await waitFor(() => expect(result.current.watcherFrame?.sid).toBe(SID2));
    await act(async () => { old.reject(new ToolFail('the relay is down', 'unavailable')); });
    await sleep(40);
    expect(result.current.frameProblem).toBeNull();
    expect(result.current.watcherFrame?.sid).toBe(SID2);
  });

  test('a success of the old one does not clear the new session\'s problem', async () => {
    const { fake, props, move } = movingWorld(sessions);
    const old = deferred();
    fake.state.sessionFrame = (sid) => { if (sid === SID) return old.promise; throw Object.assign(new Error('forbidden'), { code: 'needs_unattended', status: 403 }); };
    const { result } = renderHook(() => useSession(props({ tuning: SLOW })));
    await waitFor(() => expect(fake.core.request.mock.calls.some((c) => c[2] === `/api/sessions/${SID}/frame`)).toBe(true));
    move();
    await waitFor(() => expect(result.current.frameProblem).not.toBeNull());
    await act(async () => { old.resolve(frame); });
    await sleep(40);
    expect(result.current.frameProblem).not.toBeNull();
  });
});
