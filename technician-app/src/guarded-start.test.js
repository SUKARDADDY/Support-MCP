import { describe, expect, test } from 'vitest';
import { guardedStart, guardsFor } from './guarded-start.js';

// A tab's guard that counts what is done to it.
function guard(over = {}) {
  const g = { holds: 0, releases: 0, followed: [], account: 'acc', deviceId: () => 'dev', sessionId: () => 'sid', liveSession: () => null, ...over };
  g.hold = over.hold ?? (async () => { g.holds += 1; });
  g.release = () => { g.releases += 1; };
  g.follow = over.follow ?? ((id) => { g.followed.push(id); g.releases += 1; });
  return g;
}
const refuse = (code) => Object.assign(new Error(code), { code });
const body = { instructions: 'Fix it', keep_working: false, device_id: 'dev' };

describe('guardedStart', () => {
  test('finds the open tabs of the same account on the PC or the session', () => {
    const mine = guard();
    const other = guard({ account: 'other' });
    const elsewhere = guard({ deviceId: () => 'x', sessionId: () => 'y' });
    expect(guardsFor([mine, other, elsewhere], 'acc', { device_id: 'dev' })).toEqual([mine]);
    expect(guardsFor([mine, other, elsewhere], 'acc', { session_id: 'sid' })).toEqual([mine]);
  });

  test('a start by PC goes to the live session, and a stale session is retried once by PC with the holds kept', async () => {
    const g = guard({ liveSession: () => 'sid' });
    const sent = [];
    const out = await guardedStart({ guards: [g], body, send: async (b) => { sent.push({ b, holds: g.holds, releases: g.releases }); if (b.session_id) throw refuse('session_ended'); return { task_id: 't1' }; } });
    expect(out).toEqual({ task_id: 't1' });
    expect(sent.map((s) => s.b)).toEqual([{ instructions: 'Fix it', keep_working: false, session_id: 'sid' }, body]);
    expect(sent.map((s) => [s.holds, s.releases])).toEqual([[1, 0], [1, 0]]); // held for both, released by neither
    expect(g.followed).toEqual(['t1']);
    expect(g.releases).toBe(1);
  });

  test('a session taken by someone else is retried by PC too, and other refusals are not retried', async () => {
    const g = guard({ liveSession: () => 'sid' });
    let calls = 0;
    await guardedStart({ guards: [g], body, send: async (b) => { calls += 1; if (b.session_id) throw refuse('driven'); return { task_id: 't2' }; } });
    expect(calls).toBe(2);

    const h = guard({ liveSession: () => 'sid' });
    calls = 0;
    await expect(guardedStart({ guards: [h], body, send: async () => { calls += 1; throw refuse('caps_not_set'); } })).rejects.toThrow('caps_not_set');
    expect(calls).toBe(1);
    expect(h.releases).toBe(1);
    // A start that was by PC to begin with is not retried, whatever the refusal.
    const k = guard();
    calls = 0;
    await expect(guardedStart({ guards: [k], body, send: async () => { calls += 1; throw refuse('session_ended'); } })).rejects.toThrow();
    expect(calls).toBe(1);
  });

  test('a retry that fails too releases every hold once', async () => {
    const g = guard({ liveSession: () => 'sid' });
    await expect(guardedStart({ guards: [g], body, send: async (b) => { throw refuse(b.session_id ? 'driven' : 'busy'); } })).rejects.toThrow('busy');
    expect(g.releases).toBe(1);
  });

  test('a follow that throws is not released twice, does not stop the other tabs, and does not undo the start', async () => {
    const bad = guard({ follow: () => { throw new Error('cannot follow'); } });
    const good = guard();
    const out = await guardedStart({ guards: [bad, good], body, send: async () => ({ task_id: 't3' }) });
    expect(out).toEqual({ task_id: 't3' });
    expect(bad.releases).toBe(0); // its follow owns the release; the failed start's release does not run for it
    expect(good.followed).toEqual(['t3']);
    expect(good.releases).toBe(1);
  });

  test('a hold that throws leaves nothing held: every guard is released once and the error comes out', async () => {
    const a = guard();
    const b = guard({ hold: async () => { throw new Error('hold failed'); } });
    let sent = false;
    await expect(guardedStart({ guards: [a, b], body, send: async () => { sent = true; return { task_id: 'x' }; } })).rejects.toThrow('hold failed');
    expect(sent).toBe(false);
    expect([a.releases, b.releases]).toEqual([1, 1]);
  });
});
