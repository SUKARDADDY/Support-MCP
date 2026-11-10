// Who is on a live session and who drives it, as the team's tools use it: invite, join, leave and
// remove (session_participants), offer, accept, decline, cancel and take over (session_handover),
// the people list, and the picture a watcher sees. The checks are here, the state is in the Session
// object (src/session.js) and, for a saved PC, in the PC's session pointer (src/devices.js).
//
// Errors are TeamError. Its `code` is the tool error code the technician app reads
// (not_driver, cannot_control, second_factor, needs_unattended, not_attached, no_offer, not_offered_to_you,
// not_invited, offer_pending, busy, already_claimed, not_found, bad_request); the frame route turns the same
// errors into HTTP statuses.
//
// Control moves in three steps, in this order, so the PC's record and the Session cannot disagree for good:
//   1. the Session marks the offer as being accepted (or reserves itself for a claim). Nothing else
//      can take the offer meanwhile, and the reservation lapses by itself after 30 seconds.
//   2. for a saved PC, one guarded change in the database moves the pointer's driver, and writes the
//      team log row (and, for a claim, claims the queue item in the same batch).
//   3. the Session sets its driver. This step can be repeated: it does nothing when the driver is
//      already the new one, and it stops with not_driver when the driver generation is no longer the one the
//      move began from. Every driver change (an accept, a claim, a take-over, also one by the person who already
//      drives) takes the next generation, in the PC's pointer ($.gen) and in the Session, so a take-over that landed
//      between steps 2 and 3 is the later decision and stands, even when it gave control back to the same person.
// A step 3 that fails is retried at once; if it keeps failing the call says so and the caller repeats
// it: step 2 sees that the pointer already names them, and only step 3 runs again. An accept finds the same
// state after the offer has lapsed, and finishes step 3 without an offer: the pointer is the proof.
import { TeamError, normalizeIdentity, teamFromEnv } from './workspace.js';
import { devicesFromEnv } from './devices.js';
import { deviceHooks } from './device-sessions.js';
import { notifyStore } from './notify.js';

const SID_RE = /^[0-9a-f]{64}$/;
const COMPLETE_TRIES = 3;
const LIVE = new Set(['pending', 'consumed', 'waiting', 'attached']);
const RELAY_STOPPED = 'this relay is stopped by its operator';
const STOPPED = 'this workspace is stopped; someone who can manage members must resume it';
// The HTTP status a code has where there is one (the picture route).
const STATUS = {
  not_driver: 403, cannot_control: 403, needs_unattended: 403, not_attached: 409, no_offer: 409, not_offered_to_you: 403,
  not_invited: 403, already_claimed: 409, offer_pending: 409, busy: 409, second_factor: 403, not_found: 404, mode: 409, bad_request: 400,
};

const bad = (message) => new TeamError(400, 'bad_request', message);
const unavailable = () => new TeamError(503, 'unavailable', 'could not reach that session; try again');

// A refusal from a Session ({ ok: false, code, error }) as the error to throw.
export function refused(r) {
  return new TeamError(STATUS[r.code] ?? 400, r.code ?? 'bad_request', String(r.error ?? 'refused'));
}

export function sessionPeople(env, { devTtlMs = 0 } = {}) {
  const team = teamFromEnv(env);
  const devs = devicesFromEnv(env, team, { devTtlMs });
  const hooks = deviceHooks(env, { devTtlMs });
  const notify = notifyStore(env.DB, team);

  function sessionId(v) {
    if (typeof v !== 'string' || !SID_RE.test(v)) throw bad('session_id must be the 64 hex characters from session_create or session_list');
    return v;
  }

  // The session as /watch says it, when it is live in this workspace. A session of another workspace, a
  // missing one and an ended one are all "no such live session".
  async function live(slug, sid) {
    let watch;
    try {
      watch = await hooks.watch(slug, sid);
    } catch (_) {
      throw unavailable();
    }
    if (!LIVE.has(watch.state)) throw new TeamError(404, 'not_found', 'no such live session');
    return watch;
  }

  // The people of a session with the names the team knows them by.
  async function named(slug, participants) {
    if (!participants?.length) return participants ?? [];
    let names = new Map();
    try {
      names = new Map((await team.listMembers(slug)).map((m) => [m.identity, m.name ?? null]));
    } catch (_) { /* a name is a nicety */ }
    return participants.map((p) => ({ ...p, name: names.get(p.identity) ?? null }));
  }

  const driverIs = (watch, person) => !!watch.driver && normalizeIdentity(watch.driver) === person;
  const notDriver = (watch) => new TeamError(403, 'not_driver', watch.driver ? `${watch.driver} is driving this session` : 'this session has no driver');
  const where = (watch) => (watch.device_id ? `the session on ${watch.device_name ?? 'a saved PC'}` : 'a one-off support session');

  // ---- people_list ---------------------------------------------------------------------------
  async function peopleList(slug) {
    const roles = new Map((await team.listRoles(slug)).map((r) => [r.id, r.permissions]));
    const members = await team.listMembers(slug);
    return {
      people: members.filter((m) => m.kind === 'person').map((m) => ({
        identity: m.identity, name: m.name ?? null,
        can_control: m.role_id === 'admin' || (roles.get(m.role_id) ?? []).includes('sessions.control'),
      })),
    };
  }

  // ---- session_participants ----------------------------------------------------------------------
  async function participants(slug, actor, args, caps = {}) {
    const me = normalizeIdentity(actor);
    const sid = sessionId(args.session_id);
    const action = args.action;
    if (!['invite', 'join', 'leave', 'remove'].includes(action)) throw bad('action must be invite, join, leave or remove');
    let target = null;
    if (action === 'invite' || action === 'remove') {
      if (typeof args.identity !== 'string' || !args.identity.trim()) throw bad('identity is required: the person\'s email from people_list');
      target = normalizeIdentity(args.identity);
    }
    const watch = await live(slug, sid);
    if (action === 'invite') {
      if (!driverIs(watch, me)) throw notDriver(watch);
      await devs.mayInvite(slug, target, sid, watch);
    } else if (action === 'remove') {
      if (!driverIs(watch, me)) throw notDriver(watch);
    } else if (action === 'join') {
      await devs.sessionRule(slug, me, sid, watch, caps);
    }
    const r = await hooks.people(slug, sid, { action, actor: me, ...(target ? { identity: target } : {}) });
    if (!r) throw unavailable();
    if (!r.ok) throw refused(r);
    if (action === 'invite') {
      // Written whether or not the invite is new: the same invite has the same key and adds nothing twice.
      const who = (await named(slug, [{ identity: me }]))[0].name ?? me;
      await notify.write(slug, await notify.direct(slug, 'session_invited', target, {
        device_id: watch.device_id, session_id: sid, title: 'Invited to a session', body: `${who} invited you to watch ${where(watch)}`,
        dedupe: `invited:${sid}:${target}:${r.since}`,
      }));
    }
    return { participants: await named(slug, r.participants) };
  }

  // ---- session_handover ----------------------------------------------------------------------------
  // Step 3, repeated on a transient failure.
  // `gens` is { fromGen, gen }: the generation the move began from (the Session applies it only then) and the one it gives.
  async function complete(slug, sid, me, from, kind, gens) {
    for (let i = 0; i < COMPLETE_TRIES; i++) {
      const r = await hooks.handover(slug, sid, { op: 'complete', actor: me, from, kind, from_gen: gens.fromGen, gen: gens.gen });
      if (r?.ok) return r;
      if (r) throw refused(r);
    }
    throw new TeamError(503, 'busy', 'control moved on the PC, but the session has not followed yet; repeat the same call');
  }

  async function out(slug, r) {
    return { driver: r.driver, participants: await named(slug, r.participants), offer: r.offer ?? null };
  }

  // Only step 3 of a move whose step 2 is done: the saved PC's pointer already names `me`, and the Session still has
  // someone else. The pointer is the proof (the full guard wrote it), so no offer or mark is needed. The pointer gets
  // its next generation if it has none above the Session's (a move made before generations), and the Session adopts it.
  // For a one-off session there is no pointer: the caller shows the reservation the earlier try made (`watch.accepting`).
  async function finishMove(slug, me, sid, watch, kind, caps) {
    const fromGen = watch.gen ?? 0;
    let gen = fromGen + 1;
    if (watch.device_id) {
      const moved = await devs.handOver(slug, me, { sid, deviceId: watch.device_id, from: watch.driver, fromGen, kind, settleOnly: true }, caps);
      gen = moved?.gen ?? gen;
    }
    return complete(slug, sid, me, watch.driver, kind, { fromGen, gen });
  }

  // Steps 1 to 3 for an accept, a claim or a take-over. For a claim, `claim` is { expectDriver, extra, recorded } and the
  // queue's pieces (extra) ride in the same guarded change; recorded says an earlier try already wrote them.
  async function moveControl(slug, me, sid, watch, kind, caps, claim = null) {
    let from = null;
    let fromGen = watch.gen ?? 0;
    if (kind !== 'take_over') {
      const mark = await hooks.handover(slug, sid, {
        op: 'accepting', actor: me, ...(claim ? { claim: { expect_driver: claim.expectDriver } } : {}),
      });
      if (!mark) throw unavailable();
      if (!mark.ok) throw refused(mark);
      from = mark.from;
      fromGen = mark.gen ?? 0;
    } else {
      from = watch.driver;
    }
    let changed = false;
    let moved = null;
    try {
      // A claim that an earlier try already recorded (a one-off session has no pointer to show it) skips the record.
      if (!claim?.recorded) moved = await devs.handOver(slug, me, { sid, deviceId: watch.device_id, from, fromGen, kind, extra: claim?.extra ?? null }, caps);
      changed = true;
    } finally {
      // Nothing changed in the database: let the session go again at once, not after its 30 seconds.
      if (!changed && kind !== 'take_over') await hooks.handover(slug, sid, { op: 'release', actor: me });
    }
    // A saved PC's pointer took the next generation; a one-off session's is taken by the Session itself.
    return complete(slug, sid, me, from, kind, { fromGen, gen: moved?.gen ?? fromGen + 1 });
  }

  async function handover(slug, actor, args, caps = {}) {
    const me = normalizeIdentity(actor);
    const sid = sessionId(args.session_id);
    const action = args.action;
    if (!['offer', 'accept', 'decline', 'cancel', 'take_over'].includes(action)) throw bad('action must be offer, accept, decline, cancel or take_over');
    if (action === 'offer' && (typeof args.identity !== 'string' || !args.identity.trim())) throw bad('identity is required: the watcher to offer control to');
    const watch = await live(slug, sid);

    if (action === 'offer') {
      if (!driverIs(watch, me)) throw notDriver(watch);
      const to = normalizeIdentity(args.identity);
      const r = await hooks.handover(slug, sid, { op: 'offer', actor: me, to });
      if (!r) throw unavailable();
      if (!r.ok) throw refused(r);
      const who = (await named(slug, [{ identity: me }]))[0].name ?? me;
      await notify.write(slug, await notify.direct(slug, 'control_offered', to, {
        device_id: watch.device_id, session_id: sid, title: 'Control offered', body: `${who} offered you control of ${where(watch)}`,
        dedupe: `offered:${sid}:${to}:${r.offer_at}`,
      }));
      return out(slug, r);
    }
    if (action === 'cancel' || action === 'decline') {
      const r = await hooks.handover(slug, sid, { op: action, actor: me });
      if (!r) throw unavailable();
      if (!r.ok) throw refused(r);
      return out(slug, r);
    }
    if (action === 'accept') {
      if (driverIs(watch, me)) return out(slug, { driver: watch.driver, participants: watch.participants, offer: watch.offer });
      const { pointer } = await devs.sessionRule(slug, me, sid, watch, caps, { driving: true });
      // A saved PC's pointer already names the caller while the Session still has someone else: an earlier accept
      // moved the pointer and its session step failed, and the offer has lapsed since. The pointer moved under the
      // full guard, so that is the proof; only the session step is left.
      if (pointer && watch.driver && pointer.by === me && (pointer.gen ?? 0) >= (watch.gen ?? 0)) {
        return out(slug, await finishMove(slug, me, sid, watch, 'accept', caps));
      }
      return out(slug, await moveControl(slug, me, sid, watch, 'accept', caps));
    }
    // take_over: a one-off session only. A saved PC's is device_connect with take_over.
    if (watch.device_id) throw bad('take_over here is for one-off link sessions; for a saved PC use device_connect with take_over: true');
    if (!watch.driver) throw notDriver(watch);
    if (driverIs(watch, me)) return out(slug, { driver: watch.driver, participants: watch.participants, offer: watch.offer });
    await devs.sessionRule(slug, me, sid, watch, caps, { driving: true });
    return out(slug, await moveControl(slug, me, sid, watch, 'take_over', caps));
  }

  // ---- the picture a watcher sees -------------------------------------------------------------------
  // { rev, at, mime, data } of the last full screenshot. For the driver and for a person who joined, under the
  // rule apart from the attached requirement. Held in the Session's memory only; 404 no_frame when there is none.
  async function frame(slug, actor, sidArg, caps = {}) {
    if (String(env.EMERGENCY_STOP ?? '') !== '') throw new TeamError(503, 'relay_stopped', RELAY_STOPPED);
    if ((await team.stopState(slug)).stopped) throw new TeamError(409, 'stopped', STOPPED);
    const me = normalizeIdentity(actor);
    const sid = sessionId(sidArg);
    const watch = await live(slug, sid);
    await devs.sessionRule(slug, me, sid, watch, caps);
    const r = await hooks.frame(slug, sid, me);
    if (!r) throw unavailable();
    if (r.status === 200) return r.body;
    throw new TeamError(r.status, r.body?.code ?? 'not_found', String(r.body?.error ?? 'no picture'));
  }

  return { participants, handover, frame, peopleList, named, moveControl, finishMove, live, sessionId };
}
