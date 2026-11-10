// Helpers for the tests of the tools the team's rules govern and of approvals: save rules, attach a saved
// PC whose app answers the new frames, and ask the Session things the way the relay does.
import assert from 'node:assert/strict';
import { BOSS, TECH, until } from './agent-world.js';
import { rulesFromEnv } from '../src/rules-store.js';
import { accountStore } from '../src/accounts.js';
import { SECRET } from './device-sessions-world.js';
import { totp } from '../src/totp.js';

export const KEY = new Uint8Array(20).fill(7);
// 2027-01-15 08:00 UTC is a Friday; the world's clock starts there.
export const HOURS = { mon: ['07:00', '18:00'], tue: ['07:00', '18:00'], wed: ['07:00', '18:00'], thu: ['07:00', '18:00'], fri: ['07:00', '18:00'] };

// A member with an authenticator, as the sign-in pages would leave it.
export async function enrol(w, email, key = KEY) {
  const accounts = accountStore(w.db, { secret: SECRET });
  const { user } = await accounts.userForEmail(email, async () => true);
  await accounts.saveFactor(user.id, key, 1, { replace: false });
  return user.id;
}

// The code the authenticator shows now. A code works once, so each use moves the clock on to the next step.
export async function fresh(w, key = KEY) {
  w.advance(30_000);
  return totp(key, w.now());
}

// Save the team's rules (customer '') or a customer's override, as BOSS, whatever the current revision is.
export async function setRules(w, doc, customer = '') {
  const store = rulesFromEnv(w.env, w.team);
  const cur = customer ? (await store.readCustomer('default', customer)).rev : (await store.listAll('default')).rules.rev;
  return store.save('default', BOSS, customer, doc, cur);
}

const PROGRAMS = {
  installed: [
    { id: 'acrobat', name: 'Adobe Acrobat Reader DC', version: '24.002', publisher: 'Adobe' },
    { id: 'qb2024', name: 'QuickBooks Desktop 2024', version: '34.0', publisher: 'Intuit Inc.' },
  ],
  running: [
    { name: 'OUTLOOK.EXE', pid: 4120, session: 1 },
    { name: 'QBW.EXE', pid: 7000, session: 1 },
  ],
};
// What the PC answers to the new frames. Anything else gets the pump's default answer.
export const answerFrame = (frame) => {
  if (frame.type === 'power') return { at: Math.floor(1_800_000_000 + (frame.delay_s ?? 30)) };
  if (frame.type === 'programs') {
    return { list: PROGRAMS, install: { exit_code: 0 }, uninstall: { exit_code: 3010 }, close: { closed: 1 } }[frame.action] ?? null;
  }
  return null;
};

// A saved PC with an attached session driven by `who`, and a stand-in for the app that answers the frames.
// Returns { pc, sid, generation, frames, session }. The pump stops with the test.
export async function savedPc(w, t, { who = TECH, control = 'full', version = '1.0.0', name = 'Till', handler = answerFrame } = {}) {
  const pc = await w.addPc({ access: 'any', name, control: control === 'full' ? 'full' : 'limited' });
  const { sid, welcome } = await w.attach(pc, who, { control, version });
  assert.equal(welcome.status, 200, JSON.stringify(welcome.body));
  const p = w.pump({ sid, key: pc.key, generation: welcome.body.generation, handler });
  t.after(() => p.stop());
  return { pc, sid, generation: welcome.body.generation, frames: p.frames, session: () => w.sessionFor(sid).session };
}

// A tool call that has not been answered yet, and the approval it is waiting for.
export async function asking(w, session, who, tool, args) {
  const call = w.tool(who, tool, args);
  await until(() => session().approval !== null && session().approval !== undefined);
  return { call, approval: session().approval.rec };
}
