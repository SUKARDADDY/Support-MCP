// The PC's wire: POST /device/pair, /device/hello, /device/update and
// /device/leave. A PC has no Cloudflare Access login, so this path is public
// and outside every Access application. It is held to the same hardening as
// /agent: https (loopback excepted), no Origin header, JSON only, a size cap,
// and a key only in the Authorization header, never the URL.
//
// Every request body carries "protocol": 1 and every answer, success or error,
// does too, so a later change can move to protocol 2 without breaking PCs
// already paired. A protocol outside the range this relay speaks is 426 with the
// range. The status and code of every refusal are pinned in
// docs/relay-v1-spec.md.
//
// A hello's answer, and a 426, may carry "update": the signed release this relay
// offers (src/release.js). The relay only passes the signature on; the PC checks
// it. Working out the offer reads nothing more from the database.
//
// A hello's answer may also carry "session": the one live session a technician
// started for this PC, which it should pick up. It comes from the row the check-in
// already loads, so it costs no query, and a waiting PC never gets it. It is left
// out while EMERGENCY_STOP is set.
//
// GET /device/ring is the doorbell: a WebSocket the PC keeps open so the relay
// can ring it when something changes (src/registry.js holds the sockets). It
// carries no data either way, so it needs no body and no protocol field in one.
import { readTextCapped } from './body.js';
import { TeamError } from './workspace.js';
import { devicesFromEnv, parseDeviceKey } from './devices.js';
import { registryName } from './registry.js';
import { offerAtCheckIn, offerOnRefusal, releaseFrom, updateField } from './release.js';

export const PROTOCOL = 1;
const SUPPORTED = Object.freeze({ min: 1, max: 1 });
const BODY_MAX = 8192;

const reply = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify({ protocol: PROTOCOL, ...obj }), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra } });
const fail = (status, code, message, extra = {}) => reply({ error: { code, message } }, status, extra);

// A key in the Authorization header, or 401 device_unknown for a missing,
// malformed or mismatched one: the same answer a wrong key gets.
function keyOf(request) {
  const m = /^Bearer (\S+)$/i.exec(request.headers.get('authorization') || '');
  const key = m ? parseDeviceKey(m[1]) : null;
  if (!key) throw new TeamError(401, 'device_unknown', 'this key is not valid');
  return key;
}

// What each address does, given the store, the body, the request and
// { env, appBundle }. Each returns [status, answer].
const ROUTES = Object.freeze({
  async pair(devs, body) {
    const hasCode = Object.hasOwn(body, 'code');
    const hasWorkspace = Object.hasOwn(body, 'workspace');
    if (hasCode === hasWorkspace) throw new TeamError(400, 'bad_request', 'send code (from a technician) or workspace (an install you started), not both');
    if (hasCode) {
      if (typeof body.code !== 'string') throw new TeamError(400, 'bad_request', 'code must be text');
      return [201, await devs.redeemCode(body)];
    }
    return [202, await devs.requestJoin(body)];
  },
  async hello(devs, body, request, { env, appBundle }) {
    const { device, app_version, session } = await devs.checkInFull(keyOf(request), body);
    const release = await releaseFrom(appBundle, env);
    const offered = release && await offerAtCheckIn(release, { ...device, app_version }, env?.UPDATE_ROLLOUT);
    // While the relay is stopped by its operator a PC is told of no session (it would only be ended on arrival).
    const stopped = String(env?.EMERGENCY_STOP ?? '') !== '';
    return [200, { device, ...(offered ? { update: updateField(release) } : {}), ...(session && !stopped ? { session } : {}) }];
  },
  async update(devs, body, request) {
    return [200, { device: await devs.updateOwn(keyOf(request), body) }];
  },
  async leave(devs, body, request) {
    return [200, await devs.leave(keyOf(request))];
  },
});

// The doorbell. Same refusals as the other /device addresses, then the Worker
// checks the key and hands the upgrade to the workspace's Registry object, which
// holds the socket. Active and waiting PCs may connect. The key is stripped from
// what the Registry sees, and the workspace is added (the Registry names no team itself).
async function handleRing(request, env, url) {
  if (request.method !== 'GET') return fail(405, 'method_not_allowed', 'use GET', { allow: 'GET' });
  if (request.headers.has('origin')) return fail(403, 'forbidden', 'cross-site requests are refused');
  if (url.searchParams.has('key') || url.searchParams.has('code')) return fail(400, 'bad_request', 'send the key in the Authorization header, not the URL');
  const protocol = url.searchParams.get('protocol');
  if (protocol === null || !/^\d{1,6}$/.test(protocol)) return fail(400, 'bad_request', 'protocol must be a whole number');
  if (Number(protocol) < SUPPORTED.min || Number(protocol) > SUPPORTED.max) {
    return fail(426, 'protocol_unsupported', `this relay speaks protocol ${SUPPORTED.min} to ${SUPPORTED.max}`, {});
  }
  try {
    const key = keyOf(request);
    if ((request.headers.get('upgrade') || '').toLowerCase() !== 'websocket') return fail(400, 'bad_request', 'this address is a WebSocket: send an Upgrade: websocket request');
    const row = await devicesFromEnv(env).authenticate(key);
    if (!row) throw new TeamError(401, 'device_unknown', 'this key is not valid');
    if (!env.REGISTRY) return fail(503, 'unavailable', 'the doorbell is not configured', { 'retry-after': '60' });
    const forward = new Request(`https://do/doorbell?device=${row.id}&workspace=${row.workspace}`, request);
    forward.headers.delete('authorization');
    return await env.REGISTRY.get(env.REGISTRY.idFromName(registryName(row.workspace))).fetch(forward);
  } catch (e) {
    if (e instanceof TeamError) return fail(e.status, e.code, e.message, e.status === 503 ? { 'retry-after': '1' } : {});
    return fail(500, 'internal', 'internal error');
  }
}

// deps: { isLoopback(hostname) -> bool, isJsonContentType(request) -> bool } from app.js, and appBundle, the
// app this relay serves (null when it serves none, and then it offers no update).
export async function handleDevice(request, env, url, { isLoopback, isJsonContentType, appBundle = null }) {
  if (url.protocol !== 'https:' && !isLoopback(url.hostname)) return fail(403, 'https_required', 'use https');
  const name = url.pathname.slice('/device/'.length);
  if (name === 'ring') return handleRing(request, env, url);
  if (!Object.hasOwn(ROUTES, name)) return fail(404, 'not_found', 'not found');
  if (request.method !== 'POST') return fail(405, 'method_not_allowed', 'use POST', { allow: 'POST' });
  // The PC is not a browser, so any Origin header means a cross-site request.
  if (request.headers.has('origin')) return fail(403, 'forbidden', 'cross-site requests are refused');
  // A key or a code in the URL would land in access logs: refuse it outright.
  if (url.searchParams.has('key') || url.searchParams.has('code')) return fail(400, 'bad_request', 'send the key in the Authorization header and the code in the body, not the URL');
  if (!isJsonContentType(request)) return fail(415, 'unsupported_media_type', 'send content-type: application/json');
  const text = await readTextCapped(request, BODY_MAX);
  if (text === null) return fail(413, 'payload_too_large', `the request body is limited to ${BODY_MAX} bytes`);
  let body;
  try { body = JSON.parse(text); } catch (_) { return fail(400, 'bad_request', 'the body must be JSON'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'bad_request', 'the body must be a JSON object');
  if (!Number.isInteger(body.protocol)) return fail(400, 'bad_request', 'protocol must be a whole number');
  if (body.protocol < SUPPORTED.min || body.protocol > SUPPORTED.max) {
    // A PC cut off by protocol can do nothing else, so it gets the release whenever there is one and the rollout
    // is not paused, without a group check or a key.
    const release = await releaseFrom(appBundle, env);
    const update = offerOnRefusal(release, env?.UPDATE_ROLLOUT) ? { update: updateField(release) } : {};
    return reply({ error: { code: 'protocol_unsupported', message: `this relay speaks protocol ${SUPPORTED.min} to ${SUPPORTED.max}` }, supported: SUPPORTED, ...update }, 426);
  }
  try {
    const [status, answer] = await ROUTES[name](devicesFromEnv(env), body, request, { env, appBundle });
    return reply(answer, status);
  } catch (e) {
    if (e instanceof TeamError) return fail(e.status, e.code, e.message, e.status === 503 ? { 'retry-after': '1' } : {});
    return fail(500, 'internal', 'internal error');
  }
}
