-- Team data: members, roles, recent callers and the chained team log.
-- Every row belongs to one workspace, and every key starts with it.
-- All queries live in src/workspace.js and filter by workspace; the guarded
-- changes in src/devices.js also write to audit through src/workspace.js.

-- People (by email) and service tokens (by client id), each with one role.
CREATE TABLE members (
  workspace TEXT NOT NULL,
  identity TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('person', 'service')),
  name TEXT,
  role_id TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  added_by TEXT NOT NULL,
  PRIMARY KEY (workspace, identity)
);

-- Edited built-in roles and custom roles. A built-in role with no row here
-- uses its defaults from src/permissions.js. A deleted role keeps its row
-- with deleted = 1, so a deleted built-in role stays deleted.
CREATE TABLE roles (
  workspace TEXT NOT NULL,
  role_id TEXT NOT NULL,
  name TEXT NOT NULL,
  permissions TEXT NOT NULL,
  builtin INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace, role_id)
);

-- Who called while the workspace had no members, so an admin can add them.
CREATE TABLE callers (
  workspace TEXT NOT NULL,
  identity TEXT NOT NULL,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (workspace, identity)
);

-- The team log. hash = SHA-256 of prev_hash, seq, ts, actor, kind and detail.
-- The primary key makes two writers that read the same head collide, so one
-- of them retries instead of forking the chain.
CREATE TABLE audit (
  workspace TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  actor TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  PRIMARY KEY (workspace, seq)
);
