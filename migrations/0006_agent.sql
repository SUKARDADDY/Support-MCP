-- The built-in agent (PR 7). Two tables. Every row belongs to one workspace, and
-- every key starts with it. All queries live in src/agent-store.js and filter by
-- workspace.

-- One row per workspace that has touched its agent settings. A workspace with no
-- row has mode "both", the default model, no added models, no keys and no caps,
-- so no task can start.
--
-- mode is who runs sessions: MCP clients only ('mcp'), the built-in agent only
-- ('agent') or both. The *_key_enc columns hold the team's provider keys sealed
-- with AES-GCM under AUTH_SECRET (the workspace is the associated data), and the
-- *_key_hint columns hold their last four characters. A key is opened only inside
-- an AgentTask object and never leaves it.
--
-- default_model is the model a task uses when its starter names none, or NULL for
-- the built-in choice. models is a JSON list of at most 10 models an admin added,
-- each with its provider, id, prices, output limit and the settings its check
-- found. starters_pick_model says whether whoever starts a task may name a model
-- (1) or every task uses the default (0). The caps are in millionths of a dollar;
-- NULL means not set, and no task starts until both are.
CREATE TABLE agent_settings (
  workspace TEXT PRIMARY KEY,
  mode TEXT NOT NULL DEFAULT 'both' CHECK (mode IN ('mcp', 'agent', 'both')),
  openai_key_enc TEXT,
  openai_key_hint TEXT,
  anthropic_key_enc TEXT,
  anthropic_key_hint TEXT,
  default_model TEXT,
  models TEXT NOT NULL DEFAULT '[]',
  starters_pick_model INTEGER NOT NULL DEFAULT 1,
  task_cap_microusd INTEGER,
  month_cap_microusd INTEGER,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);

-- One row per task. cost_microusd is what the provider charged so far.
-- reserved_microusd is the most the call in flight may cost: it is set before
-- every model call under a guarded update that checks both caps, and cleared
-- when the real cost is added, so tasks running at once cannot pass the month's
-- cap together. A reservation that was never cleared is charged in full. The
-- month's spend is the sum of cost and reservation over the rows that count
-- toward the month: tasks created in it, tasks still live, and tasks that ended
-- in it, so a task that crosses a month's end is never left out of both.
-- summary is the finish tool's text (at most 600 characters); the next task on
-- the same PC reads the latest three as untrusted text. Steps, notes and
-- the conversation live in the task's own object, redacted or in memory only.
CREATE TABLE agent_tasks (
  workspace TEXT NOT NULL,
  id TEXT NOT NULL,
  device_id TEXT,
  sid TEXT,
  opened_session INTEGER NOT NULL DEFAULT 0,
  started_by TEXT NOT NULL,
  started_by_user TEXT,
  title TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running', 'paused', 'done', 'stuck', 'stopped', 'failed')),
  keep_working INTEGER NOT NULL DEFAULT 0,
  cost_microusd INTEGER NOT NULL DEFAULT 0,
  reserved_microusd INTEGER NOT NULL DEFAULT 0,
  steps INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  ended_at INTEGER,
  end_reason TEXT,
  summary TEXT,
  PRIMARY KEY (workspace, id)
);
CREATE INDEX agent_tasks_by_created ON agent_tasks (workspace, created_at);
CREATE INDEX agent_tasks_by_device ON agent_tasks (workspace, device_id, ended_at);
CREATE INDEX agent_tasks_by_ended ON agent_tasks (workspace, ended_at);
