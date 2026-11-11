-- A team's rules for what anyone may do to a saved PC (1.0.0). One new table, additive: nothing
-- existing changes. Every row belongs to one workspace, and every query is in src/rules-store.js
-- and filters by workspace.
--
-- customer_id is '' for the team's own rules and a customer's id for that customer's overrides.
-- doc is a checked JSON document (src/rules.js): the whole document for the team, only the fields
-- the customer overrides for a customer. A workspace with no team row has the default rules, and a
-- customer with no row has the team's. rev counts the row's saves from 1, so a save can say which
-- version it read. updated_by is the person who saved it. A customer's row is deleted with the customer.
--
-- A save needs a fresh authenticator code. The code is checked against, and used once through,
-- user_factors.last_step (0003), so this table holds no code record. A folder path or a program
-- name is in doc only: the team log names the fields a save changed, never their values.
CREATE TABLE rules (
  workspace TEXT NOT NULL,
  customer_id TEXT NOT NULL DEFAULT '',
  doc TEXT NOT NULL,
  rev INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  PRIMARY KEY (workspace, customer_id)
);
