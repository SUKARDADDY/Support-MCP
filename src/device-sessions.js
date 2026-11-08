// How the relay reaches the Durable Objects on behalf of a saved PC: ringing a
// doorbell, asking who is online, making a Session object for a PC, ending or
// taking over a session, and ending every live session when a workspace stops.
// src/devices.js calls these through the hooks object it is built with, so the
// device store never touches a Durable Object itself and its tests can leave
// them out.
//
// Everything here is best effort except createSession: a doorbell that is not
// connected, a Registry that is busy or a Session that is already gone must
// never fail the team change that called it. The PC's check-in is the fallback.
import { registryName } from './registry.js';

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
        return new Set(Array.isArray(online) ? online : []);
      } catch (_) {
        return null;
      }
    },

    // A new Session object for a saved PC, waiting for the PC to pick it up.
    // Throws when it cannot be made: nothing was claimed yet.
    async createSession({ slug, actor, device }) {
      const code = newCode();
      const id = env.SESSION.idFromName(code);
      const sid = id.toString();
      const r = await post(env.SESSION.get(id), '/create', {
        code, sid, label: `PC ${device.name} (${device.id})`, windows_mode: 'app', ttl_ms: devTtlMs, actor, workspace: slug,
        device_id: device.id, device_name: device.name, driver: actor,
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
        return typeof state === 'string' ? state : null;
      } catch (_) {
        return null;
      }
    },

    // End a session by the team's hand. Best effort.
    async endSession(slug, sid, reason, actor) {
      try {
        await post(session(sid), '/end', { actor, workspace: slug, reason });
      } catch (_) { /* the Session object clears its own pointer when it ends */ }
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
    async takeOver(slug, sid, actor) {
      try {
        return await (await post(session(sid), '/takeover', { actor, workspace: slug })).json();
      } catch (_) {
        return { ok: false };
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
            await post(session(s.sid), '/end', { actor, workspace: slug, reason: 'stopped' });
            ended++;
          } catch (_) { /* its own check ends it */ }
        }
      } catch (_) { /* best effort */ }
      await this.ringAll(slug);
      return ended;
    },
  };
}
