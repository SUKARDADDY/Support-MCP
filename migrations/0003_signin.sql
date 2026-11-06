-- Technician sign-in: people, their linked Google and Microsoft identities,
-- browser sign-ins, emailed links and authenticator secrets. All queries live
-- in src/accounts.js. Who may sign in is not stored here: it is read live from
-- members (src/workspace.js) and DEPLOYMENT_ADMINS on every request.

-- One row per person, keyed by the verified address they first signed in with
-- (lowercased). disabled_at is set by hand to lock a person out.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  disabled_at INTEGER
);

-- A Google or Microsoft account linked to a person, by the provider's own id
-- (Google sub, Microsoft tid:oid), never by email. A link is never moved.
CREATE TABLE user_identities (
  provider TEXT NOT NULL CHECK (provider IN ('google', 'microsoft')),
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL,
  email_at_link TEXT NOT NULL,
  linked_at INTEGER NOT NULL,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX user_identities_by_user ON user_identities (user_id);

-- Browser sign-ins. id_hash = SHA-256 of the random value in the cookie.
-- factor_at is when this sign-in passed its authenticator code.
CREATE TABLE login_sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  factor_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX login_sessions_by_user ON login_sessions (user_id);

-- Emailed sign-in links. hash = SHA-256 of the link's token. binding_hash =
-- SHA-256 of a value held in the cookie of the browser that asked for it.
-- The index serves the limit of 5 links per address per hour.
CREATE TABLE email_links (
  hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  binding_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX email_links_by_email ON email_links (email, created_at);

-- One authenticator per person. secret_enc is AES-GCM sealed under a key
-- derived from AUTH_SECRET. last_step is the newest 30 second step already
-- used. recovery_hashes is a JSON list of keyed hashes, one per unused code.
-- failed counts wrong tries since the last right code and is never reset by a
-- lock; every fifth one sets locked_until in the same statement (15 minutes,
-- doubling each time, up to 24 hours). Only locked_until blocks a try.
CREATE TABLE user_factors (
  user_id TEXT PRIMARY KEY,
  secret_enc TEXT NOT NULL,
  last_step INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  recovery_hashes TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
