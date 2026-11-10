// Helpers for the invite, handover and queue tests: one Session object's routes, a one-off link
// session made with or without a driver and joined by a stand-in for the downloaded app, a saved PC
// with an attached session, and a second technician.
import assert from 'node:assert/strict';
import { BOSS, TECH } from './agent-world.js';

export const TECH2 = 'tech2@example.com'; // a technician: sessions.control, no sessions.unattended

// A route of one Session object, as the relay calls it.
export async function call(w, sid, path, body, { method = 'POST' } = {}) {
  const r = await w.env.SESSION.get(w.env.SESSION.idFromString(sid)).fetch(`https://do${path}`, method === 'POST' ? { method, body: JSON.stringify({ workspace: 'default', ...body }) } : { method });
  return r.json();
}

// A saved PC (set to "any time") with an attached session driven by `who`. A person without
// sessions.unattended is asked at the PC (the pointer says ask:true); one with it is not (ask:false).
export async function attached(w, who = TECH, { name = 'Till' } = {}) {
  const pc = await w.addPc({ access: 'any', name });
  const { sid, welcome } = await w.attach(pc, who);
  return { pc, sid, generation: welcome.body.generation };
}

// A link session as a caller that names a driver makes it, and as one that names none does (open mode, or a session
// made before this rule: its storage has no driver key at all).
export async function oneOff(w, { driver } = {}) {
  const code = `code${Math.random().toString(36).slice(2, 14)}`.padEnd(16, 'a').slice(0, 16);
  const id = w.env.SESSION.idFromName(code);
  const sid = id.toString();
  const r = await w.env.SESSION.get(id).fetch('https://do/create', {
    method: 'POST', body: JSON.stringify({ code, sid, label: 'link', windows_mode: 'app', actor: driver ?? BOSS, workspace: 'default', ...(driver ? { driver } : {}) }),
  });
  assert.equal((await r.json()).ok, true);
  return sid;
}

// The downloaded app's side: consume the link, then say hello with the key.
export async function appHello(w, sid) {
  const consumed = await (await w.env.SESSION.get(w.env.SESSION.idFromString(sid)).fetch('https://do/consume', { method: 'POST', body: JSON.stringify({ windows_mode: 'app' }) })).json();
  const key = consumed.key;
  const hello = await w.agent(sid, null, { type: 'hello', machine: 'M2', user: 'sam', control: 'full', caps: ['screen', 'lanes'], version: '0.6.0' }, { 'x-attach-key': key });
  return { key, hello };
}

// A second technician in the default team.
export async function addTech2(w) {
  if (await w.team.getMember('default', TECH2)) return TECH2;
  await w.team.addMember('default', BOSS, { identity: TECH2, role_id: 'technician' });
  return TECH2;
}

// A one-off link session driven by `driver` with the downloaded app attached.
export async function attachedLink(w, driver = TECH) {
  const sid = await oneOff(w, { driver });
  const { key, hello } = await appHello(w, sid);
  assert.equal(hello.status, 200, JSON.stringify(hello.body));
  return { sid, key, generation: hello.body.generation };
}
