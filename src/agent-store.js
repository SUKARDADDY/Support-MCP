// The built-in agent's rows in the shared D1 database: a workspace's agent settings
// and its tasks. Every query the relay runs on them is in this file, and every
// query filters by workspace. Settings and task start and end go through the team
// store's guarded change (mutate), so their team log rows commit with them and the
// actor's role is checked again at commit.
//
// A key is sealed here and never opened here. Only an AgentTask object opens it.
// Nothing this file returns carries a key, sealed or not: the hint is the last four
// characters. A team log detail holds field names and ids, never a key or a price.
//
// A task that ends raises a notification for its starter (src/notify.js), written in
// the same batch as the end: "finished" when it is done, "needs attention" when it is
// stuck, failed or stopped by the relay itself (not when a person stopped it).
//
// A task that finishes with "needs a person" also opens an item in the escalation queue, in the same
// batch as its end (endTask with escalate: true), so a stuck agent's summary reaches the team. Only that
// explicit finish does: a task that ran out of time or calls, or gave up, opens nothing.
import { MIN_SECRET_LENGTH, seal } from './crypto.js';
import { TeamError, normalizeIdentity, teamFromEnv } from './workspace.js';
import { MAX_ADDED_MODELS, PROVIDERS, findSpec, monthBounds, usd } from './agent-models.js';
import { notifyStore } from './notify.js';
import { newId } from './devices.js';
import { insertItem, NOTE_MAX } from './escalations.js';

export const MODES = Object.freeze(['mcp', 'agent', 'both']);
const KEY_RE = /^[\x21-\x7e]{16,400}$/;
const CAP_MAX_USD = 100_000;
const SETTING_FIELDS = ['mode', 'default_model', 'starters_pick_model', 'task_cap_usd', 'month_cap_usd', 'openai_key', 'anthropic_key'];

export const BUSY = 'a task is already working on this PC or session';
const bad = (message) => new TeamError(400, 'bad_request', message);
const keyInfo = (provider) => `agent-key-${provider}`;
const microOf = (dollars) => Math.round(dollars * 1e6);

// The settings of a workspace with no row.
const DEFAULTS = Object.freeze({
  mode: 'both', default_model: null, models: [], models_raw: '[]', starters_pick_model: true,
  task_cap_microusd: null, month_cap_microusd: null, has_key: { openai: false, anthropic: false }, key_hint: { openai: null, anthropic: null },
  updated_at: null, updated_by: null,
});

function parseSettings(row) {
  if (!row) return { ...DEFAULTS, has_key: { ...DEFAULTS.has_key }, key_hint: { ...DEFAULTS.key_hint } };
  let models = [];
  try { models = JSON.parse(row.models); } catch (_) { /* a damaged list is an empty one */ }
  return {
    mode: row.mode,
    default_model: row.default_model,
    models: Array.isArray(models) ? models : [],
    models_raw: row.models,
    starters_pick_model: row.starters_pick_model !== 0,
    task_cap_microusd: row.task_cap_microusd,
    month_cap_microusd: row.month_cap_microusd,
    has_key: { openai: !!row.openai_key_enc, anthropic: !!row.anthropic_key_enc },
    key_hint: { openai: row.openai_key_hint, anthropic: row.anthropic_key_hint },
    updated_at: row.updated_at,
    updated_by: row.updated_by,
  };
}

// A task row as the API shows it.
export const taskOut = (r) => ({
  id: r.id, state: r.state, end_reason: r.end_reason, title: r.title, provider: r.provider, model: r.model,
  device_id: r.device_id, session_id: r.sid, started_by: r.started_by, keep_working: r.keep_working !== 0,
  cost_usd: usd(r.cost_microusd), reserved_usd: usd(r.reserved_microusd), tool_calls: r.steps,
  created_at: r.created_at, ended_at: r.ended_at, summary: r.summary,
});

// deps: the team store (src/workspace.js), whose guarded change this builds on.
// opts.authSecret is AUTH_SECRET: saving a key needs MIN_SECRET_LENGTH characters.
export function agentStore(db, team, { authSecret = '' } = {}) {
  const { mutate, actorContext, actorHas, actorUnchanged, and } = team;
  const q = (sql, ...params) => db.prepare(sql).bind(...params);
  const notify = notifyStore(db, team);
  const notStopped = (slug) => [
    "COALESCE((SELECT MAX(seq) FROM audit WHERE workspace = ? AND kind = 'workspace_stopped'), 0) <= COALESCE((SELECT MAX(seq) FROM audit WHERE workspace = ? AND kind = 'workspace_resumed'), 0)",
    [slug, slug],
  ];
  // No task is working on this PC or in this session.
  const noLiveTaskOn = (slug, deviceId, sid) => [
    `NOT EXISTS (SELECT 1 FROM agent_tasks WHERE workspace = ? AND ended_at IS NULL
       AND ((? IS NOT NULL AND device_id = ?) OR (? IS NOT NULL AND sid = ?)))`,
    [slug, deviceId, deviceId, sid, sid],
  ];
  // The rows that count toward the month holding `now`: tasks that began in it, tasks still
  // live, and tasks that ended in it. A task that crosses a month's end counts toward both
  // months it touches, so its new spend is never counted against neither (a task that spans
  // two months may be counted twice, which can only make a cap stricter).
  const monthRows = (start, end) => [
    '(created_at >= ? AND created_at < ?) OR ended_at IS NULL OR (ended_at >= ? AND ended_at < ?)',
    [start, end, start, end],
  ];
  const taskLive = (slug, id) => ['EXISTS (SELECT 1 FROM agent_tasks WHERE workspace = ? AND id = ? AND ended_at IS NULL)', [slug, id]];

  // ---- settings ----------------------------------------------------------------
  async function readSettings(slug) {
    return parseSettings(await q('SELECT * FROM agent_settings WHERE workspace = ?', slug).first());
  }

  // Who runs sessions here. A missing row, or a database without the table yet (the
  // migration has not run), is "both". Any other database error throws, so the /mcp gate
  // refuses rather than let a team on "built-in agent only" through.
  async function mode(slug) {
    try {
      return (await q('SELECT mode FROM agent_settings WHERE workspace = ?', slug).first('mode')) ?? 'both';
    } catch (e) {
      if (/no such table/i.test(String(e?.message ?? e))) return 'both';
      throw e;
    }
  }

  // The sealed key of one provider, or null. Only an AgentTask object opens it.
  async function sealedKey(slug, provider) {
    if (!PROVIDERS.includes(provider)) throw new TypeError('unknown provider');
    return (await q(`SELECT ${provider}_key_enc AS enc FROM agent_settings WHERE workspace = ?`, slug).first('enc')) ?? null;
  }

  // What the team API shows. A key is never in it.
  function settingsOut(s) {
    return {
      mode: s.mode,
      default_model: s.default_model,
      starters_pick_model: s.starters_pick_model,
      task_cap_usd: usd(s.task_cap_microusd),
      month_cap_usd: usd(s.month_cap_microusd),
      keys: {
        openai: { set: s.has_key.openai, hint: s.key_hint.openai },
        anthropic: { set: s.has_key.anthropic, hint: s.key_hint.anthropic },
      },
      models: s.models.map((m) => ({ ...m })),
      updated_at: s.updated_at,
      updated_by: s.updated_by,
    };
  }

  // Change settings. body holds any of SETTING_FIELDS. Only the columns sent are
  // written, so two admins changing different fields at once both stay. Needs
  // members.manage. Returns the settings as the API shows them.
  async function patchSettings(slug, actorIdentity, body) {
    const actor = normalizeIdentity(actorIdentity);
    const sent = SETTING_FIELDS.filter((f) => Object.hasOwn(body, f));
    for (const k of Object.keys(body)) if (!SETTING_FIELDS.includes(k)) throw bad(`unknown setting: ${k.slice(0, 40)}`);
    if (!sent.length) throw bad(`send ${SETTING_FIELDS.join(', ')}`);
    const cols = {};
    if (sent.includes('mode')) {
      if (!MODES.includes(body.mode)) throw bad('mode must be mcp, agent or both');
      cols.mode = body.mode;
    }
    if (sent.includes('starters_pick_model')) {
      if (typeof body.starters_pick_model !== 'boolean') throw bad('starters_pick_model must be true or false');
      cols.starters_pick_model = body.starters_pick_model ? 1 : 0;
    }
    for (const [field, col] of [['task_cap_usd', 'task_cap_microusd'], ['month_cap_usd', 'month_cap_microusd']]) {
      if (!sent.includes(field)) continue;
      const v = body[field];
      if (v === null) cols[col] = null;
      else if (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= CAP_MAX_USD && microOf(v) >= 1) cols[col] = microOf(v);
      else throw bad(`${field} must be a number of dollars above 0 and at most ${CAP_MAX_USD}, or null to clear it`);
    }
    if (sent.includes('default_model') && body.default_model !== null && (typeof body.default_model !== 'string' || !body.default_model)) {
      throw bad('default_model must be a model id, or null for the built-in choice');
    }
    const keyFields = PROVIDERS.filter((p) => sent.includes(`${p}_key`));
    for (const p of keyFields) {
      const v = body[`${p}_key`];
      if (v !== null && (typeof v !== 'string' || !KEY_RE.test(v))) throw bad(`${p}_key must be the key as text, or null to remove it`);
    }
    if (keyFields.some((p) => body[`${p}_key`] !== null) && !(typeof authSecret === 'string' && authSecret.length >= MIN_SECRET_LENGTH)) {
      throw new TeamError(503, 'unavailable', `keys cannot be saved: the server operator must set AUTH_SECRET (at least ${MIN_SECRET_LENGTH} characters)`);
    }
    return mutate(slug, actor, async () => {
      const ctx = await actorContext(slug, actor, 'members.manage');
      const cur = await readSettings(slug);
      const set = { ...cols };
      const has = { ...cur.has_key };
      for (const p of keyFields) {
        const v = body[`${p}_key`];
        set[`${p}_key_enc`] = v === null ? null : await seal(authSecret, keyInfo(p), v, slug);
        set[`${p}_key_hint`] = v === null ? null : v.slice(-4);
        has[p] = v !== null;
      }
      let listGuard = null;
      if (sent.includes('default_model')) {
        set.default_model = body.default_model;
        if (body.default_model !== null) {
          // An explicit default must be a model the team could use: in the table or added, with its key saved.
          const spec = findSpec(cur, body.default_model);
          if (!spec) throw new TeamError(400, 'unknown_model', 'that model is not in the table and was not added; add it first');
          if (!has[spec.provider]) throw new TeamError(409, 'no_key', `save the team's ${spec.provider === 'openai' ? 'OpenAI' : 'Claude'} key first`);
          listGuard = ['(SELECT COALESCE((SELECT models FROM agent_settings WHERE workspace = ?), \'[]\')) = ?', [slug, cur.models_raw]];
        }
      }
      // Only what differs from the stored settings is a change (a key always is).
      const same = (col, v) => v === ({ mode: cur.mode, default_model: cur.default_model, starters_pick_model: cur.starters_pick_model ? 1 : 0,
        task_cap_microusd: cur.task_cap_microusd, month_cap_microusd: cur.month_cap_microusd })[col];
      for (const col of Object.keys(set)) if (!col.includes('_key_') && same(col, set[col]) && cur.updated_at !== null) delete set[col];
      const fields = [
        ...Object.keys(set).filter((c) => !c.includes('_key_')).map((c) => ({ task_cap_microusd: 'task_cap_usd', month_cap_microusd: 'month_cap_usd' })[c] ?? c),
        ...keyFields.map((p) => `${p}_key`),
      ];
      if (!fields.length) return { noop: true, result: settingsOut(cur) };
      const now = Date.now();
      const names = Object.keys(set);
      return {
        entries: [{ kind: 'agent_settings_changed', detail: fields.join(', ') }],
        guard: and(actorHas(slug, actor, 'members.manage'), actorUnchanged(slug, ctx), ...(listGuard ? [listGuard] : [])),
        change: ([cond, params]) => [q(
          `INSERT INTO agent_settings(workspace, ${names.join(', ')}, updated_at, updated_by) SELECT ?, ${names.map(() => '?').join(', ')}, ?, ? WHERE ${cond}
           ON CONFLICT(workspace) DO UPDATE SET ${names.map((c) => `${c} = excluded.${c}`).join(', ')}, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
          slug, ...names.map((c) => set[c]), now, actor, ...params,
        )],
        result: null,
      };
    }).then(async (out) => out ?? settingsOut(await readSettings(slug)));
  }

  // Replace the added-models list. `before` is the stored list text the caller read
  // (settings.models_raw) before any paid check: a list that has changed since is a
  // 409, so a clash never repeats a provider call. `next` is the new list.
  // `detail` is the team log text. clearDefault: also clear default_model.
  async function writeModels(slug, actorIdentity, { before, next, detail, clearDefault = null }) {
    const actor = normalizeIdentity(actorIdentity);
    if (next.length > MAX_ADDED_MODELS) throw new TeamError(409, 'model_limit', `a team adds at most ${MAX_ADDED_MODELS} models`);
    return mutate(slug, actor, async () => {
      const ctx = await actorContext(slug, actor, 'members.manage');
      const cur = await readSettings(slug);
      if (cur.models_raw !== before) throw new TeamError(409, 'try_again', 'the model list changed while this was checked; try again');
      const now = Date.now();
      const text = JSON.stringify(next);
      const clears = clearDefault !== null && cur.default_model === clearDefault;
      return {
        entries: [{ kind: 'agent_settings_changed', detail }],
        guard: and(actorHas(slug, actor, 'members.manage'), actorUnchanged(slug, ctx),
          ['(SELECT COALESCE((SELECT models FROM agent_settings WHERE workspace = ?), \'[]\')) = ?', [slug, before]]),
        change: ([cond, params]) => [q(
          `INSERT INTO agent_settings(workspace, models, ${clears ? 'default_model, ' : ''}updated_at, updated_by) SELECT ?, ?, ${clears ? 'NULL, ' : ''}?, ? WHERE ${cond}
           ON CONFLICT(workspace) DO UPDATE SET models = excluded.models, ${clears ? 'default_model = NULL, ' : ''}updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
          slug, text, now, actor, ...params,
        )],
        result: { models: next },
      };
    });
  }

  // ---- tasks -------------------------------------------------------------------
  async function getTask(slug, id) {
    return (await q('SELECT * FROM agent_tasks WHERE workspace = ? AND id = ?', slug, id).first()) ?? null;
  }

  async function listTasks(slug, { limit = 50 } = {}) {
    const { results } = await q('SELECT * FROM agent_tasks WHERE workspace = ? ORDER BY created_at DESC, id DESC LIMIT ?', slug, limit).all();
    return results;
  }

  // A task still working on this PC or in this session, or null. One task at a time.
  async function liveTaskOn(slug, { deviceId = null, sid = null }) {
    return (await q(
      `SELECT id FROM agent_tasks WHERE workspace = ? AND ended_at IS NULL
         AND ((? IS NOT NULL AND device_id = ?) OR (? IS NOT NULL AND sid = ?)) LIMIT 1`,
      slug, deviceId, deviceId, sid, sid).first('id')) ?? null;
  }

  // The newest summaries of tasks that ended on this PC.
  async function lastSummaries(slug, deviceId, limit = 3) {
    if (!deviceId) return [];
    const { results } = await q(
      `SELECT started_by, state, end_reason, ended_at, summary FROM agent_tasks
       WHERE workspace = ? AND device_id = ? AND ended_at IS NOT NULL AND summary IS NOT NULL ORDER BY ended_at DESC LIMIT ?`,
      slug, deviceId, limit).all();
    return results;
  }

  // The month's spend (UTC): the cost and the reservation in flight of every task that
  // counts toward the calendar month (see monthRows).
  async function monthSpend(slug, now = Date.now()) {
    const [rows, params] = monthRows(...monthBounds(now));
    return (await q(
      `SELECT COALESCE(SUM(cost_microusd + reserved_microusd), 0) AS spent FROM agent_tasks WHERE workspace = ? AND (${rows})`,
      slug, ...params).first('spent')) ?? 0;
  }

  // Start a task: its row and the agent_task_started log row commit together, and
  // only while the starter still holds sessions.control and the workspace is not
  // stopped. t is the row's fields.
  async function createTask(slug, actorIdentity, t) {
    const actor = normalizeIdentity(actorIdentity);
    return mutate(slug, actor, async () => {
      const ctx = await actorContext(slug, actor, 'sessions.control');
      // Read again on every attempt: a task that began since the last one makes this a refusal.
      if (await liveTaskOn(slug, { deviceId: t.device_id ?? null, sid: t.sid ?? null })) throw new TeamError(409, 'busy', BUSY);
      const now = Date.now();
      return {
        entries: [{ kind: 'agent_task_started', detail: `${t.id} ${t.provider}/${t.model}${t.device_id ? ` pc ${t.device_id}` : ''}` }],
        guard: and(actorHas(slug, actor, 'sessions.control'), actorUnchanged(slug, ctx), notStopped(slug), noLiveTaskOn(slug, t.device_id ?? null, t.sid ?? null)),
        change: ([cond, params]) => [q(
          `INSERT INTO agent_tasks(workspace, id, device_id, sid, opened_session, started_by, started_by_user, title, provider, model, state, keep_working, created_at)
           SELECT ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 'running', ?, ? WHERE ${cond}`,
          slug, t.id, t.device_id ?? null, t.sid ?? null, actor, t.started_by_user ?? null, t.title, t.provider, t.model, t.keep_working ? 1 : 0, now, ...params,
        )],
        result: { id: t.id, created_at: now },
      };
    });
  }

  // End a task, once. state is done, stuck, stopped or failed. actor is a person
  // or "relay". A task that has already ended is left as it is. escalate: the task
  // needs a person, so its summary goes into the queue as an item in the same batch: opened
  // by the starter, with the PC, and with the session only when the task leaves it open.
  async function endTask(slug, id, { state, reason, summary = null, actor = 'relay', steps = null, escalate = false }) {
    return mutate(slug, actor, async () => {
      const cur = await getTask(slug, id);
      if (!cur || cur.ended_at !== null) return { noop: true, result: { ended: false } };
      const now = Date.now();
      const item = escalate && (summary ?? cur.summary) ? {
        id: newId(), kind: 'agent', device_id: cur.device_id, session_id: cur.opened_session ? null : cur.sid, task_id: id,
        summary: String(summary ?? cur.summary).slice(0, NOTE_MAX), note: null, opened_by: normalizeIdentity(cur.started_by), opened_at: now,
      } : null;
      const queued = item ? await notify.rows(slug, 'escalation_opened', { holding: 'sessions.control', except: [cur.started_by] }, {
        device_id: item.device_id, task_id: id, session_id: item.session_id, title: 'A stuck agent needs a person', body: cur.title,
        dedupe: `escalation:${item.id}:opened`,
      }) : [];
      // A person who stops their own task knows. Everything else the starter should hear about.
      const finished = state === 'done';
      const problem = state === 'stuck' || state === 'failed' || (state === 'stopped' && actor === 'relay');
      const heard = finished || problem ? await notify.rows(slug, finished ? 'task_finished' : 'task_problem', { to: [cur.started_by] }, {
        device_id: cur.device_id, task_id: id, session_id: cur.sid,
        title: finished ? 'Task finished' : 'Task needs attention', body: finished ? cur.title : `${cur.title}: ${reason}`, dedupe: `task:${id}:ended`,
      }) : [];
      return {
        entries: [
          { kind: 'agent_task_ended', detail: `${id} ${state} ${reason}` },
          ...(item ? [{ kind: 'escalation_opened', detail: `${item.id} agent task ${id}${item.device_id ? ` pc ${item.device_id}` : ''}` }] : []),
        ],
        guard: taskLive(slug, id),
        // The notifications and the queue item come first: the update ends the task the guard asks to be live.
        change: (cond) => [
          ...notify.statements(slug, heard, cond),
          ...notify.statements(slug, queued, cond),
          ...(item ? [insertItem(db, slug, item, cond)] : []),
          q(
            `UPDATE agent_tasks SET state = ?, ended_at = ?, end_reason = ?, summary = COALESCE(?, summary), steps = COALESCE(?, steps)
             WHERE workspace = ? AND id = ? AND ended_at IS NULL AND ${cond[0]}`,
            state, now, reason, summary, steps, slug, id, ...cond[1],
          ),
        ],
        result: { ended: true },
      };
    });
  }

  // running -> paused or paused -> running. false when the task was not in `from`.
  async function setState(slug, id, from, to) {
    const r = await q('UPDATE agent_tasks SET state = ? WHERE workspace = ? AND id = ? AND ended_at IS NULL AND state = ?', to, slug, id, from).run();
    return r.meta.changes === 1;
  }

  async function setSession(slug, id, sid, opened) {
    await q('UPDATE agent_tasks SET sid = ?, opened_session = ? WHERE workspace = ? AND id = ?', sid, opened ? 1 : 0, slug, id).run();
  }

  // Reserve the worst case of the next call: one guarded update that holds only if
  // the task's cost plus this reservation fits the task cap and the month's spend
  // plus it fits the month cap. Statements run one at a time in the database, so
  // tasks running at once cannot pass a cap together. false when it does not fit
  // or the task has ended or already holds a reservation.
  async function reserve(slug, id, amount, { taskCap, monthCap, now = Date.now() }) {
    const [rows, params] = monthRows(...monthBounds(now));
    const r = await q(
      `UPDATE agent_tasks SET reserved_microusd = ?
       WHERE workspace = ? AND id = ? AND ended_at IS NULL AND reserved_microusd = 0 AND cost_microusd + ? <= ?
         AND (SELECT COALESCE(SUM(cost_microusd + reserved_microusd), 0) FROM agent_tasks WHERE workspace = ? AND (${rows})) + ? <= ?`,
      amount, slug, id, amount, taskCap, slug, ...params, amount, monthCap).run();
    return r.meta.changes === 1;
  }

  // The call finished: add its real cost and clear the reservation. Only while a
  // reservation is held, so a reservation already charged in full is not charged twice.
  async function settle(slug, id, cost, steps) {
    const r = await q(
      'UPDATE agent_tasks SET cost_microusd = cost_microusd + ?, reserved_microusd = 0, steps = ? WHERE workspace = ? AND id = ? AND reserved_microusd > 0',
      cost, steps, slug, id).run();
    return r.meta.changes === 1;
  }

  // The call failed before it cost anything: clear the reservation.
  async function release(slug, id) {
    await q('UPDATE agent_tasks SET reserved_microusd = 0 WHERE workspace = ? AND id = ?', slug, id).run();
  }

  // A reservation nobody settled (the object died mid-call) is charged in full.
  // Returns what it charged.
  async function chargeUnsettled(slug, id) {
    const held = await q('SELECT reserved_microusd AS held FROM agent_tasks WHERE workspace = ? AND id = ?', slug, id).first('held');
    if (!held) return 0;
    const r = await q(
      'UPDATE agent_tasks SET cost_microusd = cost_microusd + reserved_microusd, reserved_microusd = 0 WHERE workspace = ? AND id = ? AND reserved_microusd > 0',
      slug, id).run();
    return r.meta.changes === 1 ? held : 0;
  }

  async function setSteps(slug, id, steps) {
    await q('UPDATE agent_tasks SET steps = ? WHERE workspace = ? AND id = ?', steps, slug, id).run();
  }

  return {
    readSettings, settingsOut, mode, sealedKey, patchSettings, writeModels,
    getTask, listTasks, liveTaskOn, lastSummaries, monthSpend, createTask, endTask, setState, setSession,
    reserve, settle, release, chargeUnsettled, setSteps,
  };
}

export const agentStoreFromEnv = (env, team = teamFromEnv(env)) => agentStore(env.DB, team, { authSecret: env.AUTH_SECRET });
