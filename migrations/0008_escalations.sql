-- The escalation queue (0.8.1). One new table, additive: nothing existing changes.
--
-- An item is a session or a PC that a technician cannot finish, put in the team's queue with a
-- note; or a stuck built-in agent's summary, opened when its task finishes with "needs a person".
-- Whoever is free claims it, and a claim of a live session moves control to them under the same
-- rule as any handover (src/escalations.js, src/session-people.js). Every query is in
-- src/escalations.js and filters by workspace.
--
-- kind is 'technician' (opened by a person, with a note) or 'agent' (opened by a task, with its
-- summary). device_id is the saved PC, or NULL for a one-off link session. session_id is the
-- session the item carries: for a technician's item the session it was opened on; for an agent's
-- item the session the task left open (NULL when the task opened its own and ended it). task_id is
-- the agent task, and an agent task opens at most one item. opened_by is the person who opened it,
-- or the starter of the task. Claiming sets claimed_by and claimed_at in one guarded update that
-- holds only while the item is unclaimed and open, so two people cannot claim the same item.
-- Closing sets closed_by, closed_at and close_note. note, summary and close_note are text from
-- people and from an agent that read a customer's screen, so a reader shows them as text.
CREATE TABLE escalations (
  workspace TEXT NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('technician', 'agent')),
  device_id TEXT,
  session_id TEXT,
  task_id TEXT,
  summary TEXT,
  note TEXT,
  opened_by TEXT NOT NULL,
  opened_at INTEGER NOT NULL,
  claimed_by TEXT,
  claimed_at INTEGER,
  closed_by TEXT,
  closed_at INTEGER,
  close_note TEXT,
  PRIMARY KEY (workspace, id)
);

-- An agent task opens at most one item.
CREATE UNIQUE INDEX escalations_by_task ON escalations (workspace, task_id) WHERE task_id IS NOT NULL;
-- The open list: unclaimed items that are not closed, newest first.
CREATE INDEX escalations_by_state ON escalations (workspace, closed_at, claimed_by, opened_at);
-- "Mine": items a person opened, and items a person claimed.
CREATE INDEX escalations_by_opener ON escalations (workspace, opened_by, opened_at);
CREATE INDEX escalations_by_claimer ON escalations (workspace, claimed_by, opened_at);
