-- Workspaces other than "default". default always exists and is never a row.
-- A row is written in the same batch as the workspace's first admin and its
-- first two log rows, so a workspace never exists without an admin.
CREATE TABLE workspaces (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- "Which workspaces am I in" reads members by identity.
CREATE INDEX members_by_identity ON members (identity);
