// What a team on "built-in agent only" can call of the four new tools, and what the built-in agent itself is given:
// the agent never gets them, and the mode gate is handed the call's arguments so a list, a close and a ticket claim
// pass while everything else is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentWorld, BOSS, TECH, VIEW } from './agent-world.js';
import { appWorld, skip } from './app-world.js';
import { TECH2, addTech2, attached } from './people-world.js';
import { agentModeAllows } from '../src/app.js';
import { AGENT_TOOL_NAMES, agentTools } from '../src/agent-tools.js';
import { listTools } from '../src/mcp.js';

const it = (name, fn) => test(name, { skip }, fn);
const NEW = ['people_list', 'session_participants', 'session_handover', 'escalation'];
const MODE_TEXT = /this team uses the built-in agent/;

test('the built-in agent\'s tools are the old ones and the six rule-governed ones: the four team tools are not among them', () => {
  assert.deepEqual([...AGENT_TOOL_NAMES].sort(), [
    'click', 'close_program', 'drag', 'finish', 'get_file', 'install_program', 'list_programs', 'move_mouse', 'note', 'press_key', 'put_file', 'restart_pc', 'run', 'screenshot', 'scroll',
    'session_status', 'shutdown_pc', 'type_text', 'ui_act', 'ui_tree', 'uninstall_program', 'wait', 'zoom',
  ]);
  for (const name of NEW) {
    assert.equal(AGENT_TOOL_NAMES.has(name), false, name);
    assert.equal(agentTools().some((t) => t.name === name), false, name);
  }
  // No description the agent is shown points at them either.
  for (const t of agentTools()) assert.doesNotMatch(`${t.description} ${JSON.stringify(t.schema)}`, /people_list|session_participants|session_handover|escalation/, t.name);
  // They are listed to every MCP connection, though: 27 old tools, the four, and the six the team's rules govern.
  assert.equal(listTools().length, 37);
});

test('the mode gate lets a team on the built-in agent only read the queue, close an item and claim a ticket, and nothing else of the four', () => {
  for (const name of NEW) assert.equal(agentModeAllows(name, {}), false, `${name} with no action`);
  for (const action of ['invite', 'join', 'leave', 'remove']) assert.equal(agentModeAllows('session_participants', { action }), false, action);
  for (const action of ['offer', 'accept', 'decline', 'cancel', 'take_over']) assert.equal(agentModeAllows('session_handover', { action }), false, action);
  assert.equal(agentModeAllows('escalation', { action: 'open' }), false);
  for (const action of ['list', 'close', 'claim']) assert.equal(agentModeAllows('escalation', { action }), true, action);
  assert.equal(agentModeAllows('escalation', {}), false);
  assert.equal(agentModeAllows('escalation', undefined), false);
  assert.equal(agentModeAllows('escalation', { action: 'LIST' }), false);
  // A call the gate does not know about is not allowed either, and the old allowances stand.
  assert.equal(agentModeAllows('run', {}), false);
  for (const name of ['agent_start', 'agent_status', 'agent_control', 'device_list', 'session_list', 'session_status']) assert.equal(agentModeAllows(name, {}), true, name);
});

test('in a team on the built-in agent only, the new tools are refused, except escalation list, close and a ticket claim', async (t) => {
  const w = await agentWorld(t);
  await addTech2(w);
  const { sid, pc } = await attached(w, TECH);
  const queued = await w.tool(TECH, 'escalation', { action: 'open', session_id: sid, note: 'help' }); // before the switch
  const ticketPc = await w.addPc({ name: 'Other' });
  const ticket = await w.tool(TECH, 'escalation', { action: 'open', device_id: ticketPc.id });
  assert.equal(queued.error, undefined);
  await w.api(BOSS, 'PATCH', '/agent', { mode: 'agent' });
  const refused = [
    ['people_list', {}],
    ['session_participants', { session_id: sid, action: 'invite', identity: TECH2 }],
    ['session_participants', { session_id: sid, action: 'leave' }],
    ['session_handover', { session_id: sid, action: 'offer', identity: TECH2 }],
    ['session_handover', { session_id: sid, action: 'accept' }],
    ['escalation', { action: 'open', device_id: pc.id }],
    ['escalation', {}],
  ];
  for (const [name, args] of refused) {
    const r = await w.tool(TECH, name, args);
    assert.match(r.error, new RegExp(`^mode: ${MODE_TEXT.source}`), `${name} ${JSON.stringify(args)}`);
  }
  assert.equal(w.sql('SELECT COUNT(*) AS n FROM escalations')[0].n, 2, 'nothing was opened');
  // The same team still lists, closes and claims a ticket.
  const listed = await w.tool(TECH2, 'escalation', { action: 'list' });
  assert.equal(listed.escalations.length, 2);
  const claimed = await w.tool(TECH2, 'escalation', { action: 'claim', id: ticket.escalation.id });
  assert.equal(claimed.escalation.claimed_by, TECH2);
  assert.equal(claimed.device_id, ticketPc.id);
  // A live claim is refused with mode, and nothing moves.
  const live = await w.tool(TECH2, 'escalation', { action: 'claim', id: queued.escalation.id });
  assert.match(live.error, new RegExp(`^mode: ${MODE_TEXT.source}`));
  assert.equal(w.pointer(pc.id).by, TECH);
  assert.equal(w.sql('SELECT claimed_by FROM escalations WHERE id = ?', queued.escalation.id)[0].claimed_by, null);
  assert.equal((await w.tool(TECH2, 'escalation', { action: 'close', id: ticket.escalation.id, note: 'done' })).escalation.close_note, 'done');
  // Back to both: everything works again.
  await w.api(BOSS, 'PATCH', '/agent', { mode: 'both' });
  assert.equal((await w.tool(TECH, 'session_participants', { session_id: sid, action: 'invite', identity: TECH2 })).participants.length, 2);
  // A Viewer is refused by role first, whatever the mode.
  assert.match((await w.tool(VIEW, 'escalation', { action: 'list' })).error, /your role does not allow sessions\.control/);
});

it('the app\'s address applies the same gate', async (t) => {
  const w = await appWorld(t);
  await addTech2(w);
  const { sid } = await attached(w, TECH);
  await w.api(BOSS, 'PATCH', '/agent', { mode: 'agent' });
  const app = await w.connect(TECH, { app: true, factor: true });
  assert.match((await w.appTool(app.access, 'session_participants', { session_id: sid, action: 'invite', identity: TECH2 })).error, /^mode: this team uses the built-in agent/);
  assert.deepEqual((await w.appTool(app.access, 'escalation', { action: 'list' })).escalations, []);
});

test('the gate runs for the new tools on every call: a mode that cannot be read refuses them with a code', async (t) => {
  const w = await agentWorld(t);
  const real = w.db.prepare;
  w.db.prepare = (sql) => {
    if (/FROM agent_settings/.test(sql)) throw new Error('the database is down');
    return real(sql);
  };
  const r = await w.tool(TECH, 'people_list');
  assert.match(r.error, /^unavailable: could not check whether this team uses the built-in agent/);
  assert.match((await w.tool(TECH, 'escalation', { action: 'open', device_id: 'a'.repeat(20) })).error, /^unavailable: could not check/);
  // Reading the queue does not need the mode.
  assert.deepEqual((await w.tool(TECH, 'escalation', { action: 'list' })).escalations, []);
});
