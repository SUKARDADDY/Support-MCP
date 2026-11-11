// How the relay reaches the Durable Objects on behalf of a saved PC: ringing a
// doorbell, asking who is online, making a Session object for a PC, ending or
// taking over a session, and ending every live session when a workspace stops. The same
// hooks reach a session's people and its handover steps (src/session-people.js), for saved
// PCs and one-off link sessions alike.
// src/devices.js calls these through the hooks object it is built with, so the
// device store never touches a Durable Object itself and its tests can leave
// them out.
//
// Everything here is best effort except createSession: a doorbell that is not
// connected, a Registry that is busy or a Session that is already gone must
// never fail the team change that called it. The PC's check-in is the fallback.
import { RING_LIST_MAX, registryName } from './registry.js';

const CODE_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'; // RFC4648 base32, lowercased

// A random 16-character code (80 bits), the same shape as a support link's. For a
// saved PC it only names the Session object and its row in the session list:
// /consume and /j/ refuse it.
export function newCode() {
  const u = new Uint8Array(16);
  crypto.getRandomValues(u);
  let s = '';
  for (let i = 0; i < 16; i++) s += CODE_ALPHABET[u[i] & 31];
  return s;
}

// A session ending by the team's hand carries one of these reasons. Anything
// else a caller names is dropped by the Session object.
export const OPERATOR_END_REASONS = Object.freeze(['stopped', 'removed', 'replaced']);

// The most live sessions one stop ends directly. A Worker call may make 50
// subrequests on the free plan; any session past this ends by its own check of
// the stop. A saved-PC (app) session makes that check on its next request, within
// about 25 seconds. A PowerShell session makes it on its next message, on its next
// attach, or when its alarm fires, which is every 30 seconds while attached.
export const STOP_FANOUT_MAX = 40;

const WATCH_STATES = new Set(['pending', 'consumed', 'waiting', 'attached', 'ended', 'unknown']);

// What a Session's internal /watch says: { state, driver, device_id, actors, ... }. Throws unless
// the Session gave a well-formed answer. An error status or a body without a state is not "no
// such session": a Session that is gone or was never made answers state "unknown".
export async function sessionWatch(env, slug, sid) {
  const r = await env.SESSION.get(env.SESSION.idFromString(sid)).fetch(`https://do/watch?workspace=${encodeURIComponent(slug)}`);
  if (!r.ok) throw new Error(`the session answered ${r.status}`);
  const watch = await r.json();
  if (!watch || typeof watch !== 'object' || !WATCH_STATES.has(watch.state)) throw new Error('the session gave no usable answer');
  return watch;
}

// One POST to a Session. The answer is its JSON when the Session answered normally (a refusal is
// { ok: false, code } with status 200); null for an error status or a Session that did not answer.
async function sessionCall(stub, path, body) {
  try {
    const r = await stub.fetch(`https://do${path}`, { method: 'POST', body: JSON.stringify(body) });
    if (!r.ok) return null;
    const out = await r.json();
    return out && typeof out === 'object' ? out : null;
  } catch (_) {
    return null;
  }
}

// env: the Worker env. devTtlMs: the dev session-length override (0 in production).
export function deviceHooks(env, { devTtlMs = 0 } = {}) {
  const registry = (slug) => {
    if (!env.REGISTRY) throw new Error('the session list is not configured');
    return env.REGISTRY.get(env.REGISTRY.idFromName(registryName(slug)));
  };
  const session = (sid) => env.SESSION.get(env.SESSION.idFromString(sid));
  const post = (stub, path, body) => stub.fetch(`https://do${path}`, { method: 'POST', body: JSON.stringify(body) });

  return {
    // Ring one PC's doorbell. true when a doorbell was connected to ring.
    async ring(slug, deviceId, { close = false } = {}) {
      try {
        const r = await post(registry(slug), '/ring', { device_id: deviceId, close });
        return (await r.json()).rang === true;
      } catch (_) {
        return false;
      }
    },

    // Ring a list of PCs (a customer's rules changed, an update is due), RING_LIST_MAX to a call. Only a
    // connected doorbell rings, and with `max` no more than that many PCs are rung, taken in the order given.
    // Returns how many doorbells were rung; best effort, so a Registry that cannot be reached is 0.
    async ringMany(slug, deviceIds, { max = null } = {}) {
      let rang = 0;
      for (let i = 0; i < deviceIds.length; i += RING_LIST_MAX) {
        if (max !== null && rang >= max) break;
        try {
          const r = await post(registry(slug), '/ring', { device_ids: deviceIds.slice(i, i + RING_LIST_MAX), ...(max !== null ? { max: max - rang } : {}) });
          const { count } = await r.json();
          if (Number.isInteger(count)) rang += count;
        } catch (_) { /* the PC's own check-in is the fallback */ }
      }
      return rang;
    },

    // Ring every doorbell in the workspace (a stop).
    async ringAll(slug) {
      try {
        await post(registry(slug), '/ring', { all: true });
      } catch (_) { /* best effort */ }
    },

    // The set of device ids whose doorbell is connected, or null when the
    // session list cannot be read (then nothing is reported online).
    async online(slug) {
      try {
        const r = await registry(slug).fetch('https://do/online');
        const { online } = await r.json();
        // An error answer is not "nobody is online".
        return r.ok && Array.isArray(online) ? new Set(online) : null;
      } catch (_) {
        return null;
      }
    },

    // A new Session object for a saved PC, waiting for the PC to pick it up.
    // Throws when it cannot be made: nothing was claimed yet.
    // openedByTask: the built-in agent task that asked, written on the Session.
    async createSession({ slug, actor, device, openedByTask = null }) {
      const code = newCode();
      const id = env.SESSION.idFromName(code);
      const sid = id.toString();
      const r = await post(env.SESSION.get(id), '/create', {
        code, sid, label: `PC ${device.name} (${device.id})`, windows_mode: 'app', ttl_ms: devTtlMs, actor, workspace: slug,
        device_id: device.id, device_name: device.name, driver: actor, ...(openedByTask ? { opened_by_task: openedByTask } : {}),
      });
      const out = await r.json();
      if (!out.ok) throw new Error(out.error || 'could not make the session');
      return { sid, code, waiting_until: out.waiting_until ?? null };
    },

    // The state a Session object reports ("waiting", "attached", "ended", or
    // "unknown" for one that was never made here), or null when it cannot be
    // reached. A caller treats null as live, so a hiccup never frees a PC.
    async sessionState(slug, sid) {
      try {
        const r = await session(sid).fetch(`https://do/status?workspace=${encodeURIComponent(slug)}&log_tail=0`);
        const { state } = await r.json();
        return r.ok && typeof state === 'string' ? state : null;
      } catch (_) {
        return null;
      }
    },

    // End a session by the team's hand. Best effort. expectDriver: end it only while that
    // person still drives it (the built-in agent's own session). Returns true when the
    // session was ended or already over, false when another driver holds it, null when
    // the Session could not be reached or did not say.
    async endSession(slug, sid, reason, actor, { expectDriver = null } = {}) {
      try {
        const r = await post(session(sid), '/end', { actor, workspace: slug, reason, ...(expectDriver ? { expect_driver: expectDriver } : {}) });
        const { ended } = await r.json();
        if (r.ok && typeof ended === 'boolean') return ended;
      } catch (_) { /* the Session object clears its own pointer when it ends */ }
      return null;
    },

    // Throw away a session that was made but never claimed (a lost race, a
    // refusal at commit). It ends quietly: nothing was announced, so no log row.
    async discardSession(slug, sid) {
      try {
        await post(session(sid), '/end', { workspace: slug, reason: 'replaced', discard: true });
      } catch (_) { /* it times out on its own */ }
    },

    // Make `actor` the driver of a live session. Returns the Session's answer
    // ({ok, state}) or { ok: false } when it cannot be reached.
    async takeOver(slug, sid, actor, gen = null) {
      try {
        return await (await post(session(sid), '/takeover', { actor, workspace: slug, ...(Number.isInteger(gen) ? { gen } : {}) })).json();
      } catch (_) {
        return { ok: false };
      }
    },

    // What the Session says of itself to the team: its state, driver, people and last handover. Throws
    // when it cannot be reached or gives no usable answer.
    watch: (slug, sid) => sessionWatch(env, slug, sid),

    // A call to a Session's /people or /handover: its JSON answer ({ ok, ... } or { ok: false, code,
    // error }), or null when the Session could not be reached (a transient failure the caller may retry).
    async people(slug, sid, body) {
      return sessionCall(session(sid), '/people', { ...body, workspace: slug });
    },
    async handover(slug, sid, body) {
      return sessionCall(session(sid), '/handover', { ...body, workspace: slug });
    },

    // A call to a Session's /approvals: list, answer or cancel the waiting approval. Its JSON answer, or null when
    // the Session could not be reached.
    async approvals(slug, sid, body) {
      return sessionCall(session(sid), '/approvals', { ...body, workspace: slug });
    },

    // The Session's last full screenshot for `actor`: { status, body }, or null when it cannot be reached.
    async frame(slug, sid, actor) {
      try {
        const r = await session(sid).fetch(`https://do/frame?workspace=${encodeURIComponent(slug)}&actor=${encodeURIComponent(actor)}`);
        return { status: r.status, body: await r.json() };
      } catch (_) {
        return null;
      }
    },

    // Every live session in the workspace's list ends with reason "stopped", and
    // every doorbell rings. Returns how many sessions it ended.
    async stopAll(slug, actor) {
      let ended = 0;
      try {
        const { sessions } = await (await registry(slug).fetch('https://do/list')).json();
        const live = (Array.isArray(sessions) ? sessions : []).filter((s) => s && s.state !== 'ended' && /^[0-9a-f]{64}$/.test(String(s.sid)));
        for (const s of live.slice(0, STOP_FANOUT_MAX)) {
          try {
            const r = await post(session(s.sid), '/end', { actor, workspace: slug, reason: 'stopped' });
            if (r.ok && (await r.json()).ended === true) ended++;
          } catch (_) { /* its own check ends it */ }
        }
      } catch (_) { /* best effort */ }
      await this.ringAll(slug);
      return ended;
    },
  };
}
