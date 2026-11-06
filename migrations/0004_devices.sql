-- Customers, their sites and their saved PCs, the workspace's custom field
-- definitions, and the pairing codes that add a PC. Every row belongs to one
-- workspace, and every key starts with it. All queries live in
-- src/devices.js and filter by workspace (pairing_codes: by hash, then workspace).
-- None of this data is read when the relay decides who may do what.

-- Contact details are personal data, so they are read only with devices.view.
-- fields holds the custom field values as JSON text: {"<field id>": "text"}.
CREATE TABLE customers (
  workspace TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  fields TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace, id)
);

CREATE TABLE sites (
  workspace TEXT NOT NULL,
  id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  name TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  fields TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace, id)
);
CREATE INDEX sites_by_customer ON sites (workspace, customer_id);

-- A saved PC. 'pending' is an owner-started install waiting for a technician:
-- confirm_hash is the keyed hash of its six-digit number and expires_at ends
-- the wait. key_hash is the SHA-256 of the key's secret; the key itself is
-- shown once, to the PC. A removed device is deleted, key hash and all.
CREATE TABLE devices (
  workspace TEXT NOT NULL,
  id TEXT NOT NULL,
  site_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active')),
  name TEXT NOT NULL,
  access TEXT NOT NULL CHECK (access IN ('ask', 'any')),
  control TEXT NOT NULL CHECK (control IN ('full', 'limited')),
  owner_contact TEXT NOT NULL DEFAULT '',
  os TEXT NOT NULL DEFAULT '',
  machine TEXT NOT NULL DEFAULT '',
  app_version TEXT NOT NULL DEFAULT '',
  protocol INTEGER NOT NULL DEFAULT 1,
  key_hash TEXT NOT NULL,
  confirm_hash TEXT,
  expires_at INTEGER,
  paired_at INTEGER NOT NULL,
  paired_by TEXT NOT NULL,
  approved_by TEXT,
  last_seen INTEGER NOT NULL,
  fields TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (workspace, id)
);
CREATE INDEX devices_by_site ON devices (workspace, site_id);

-- Custom fields an admin defines for customers, sites or devices (text only).
CREATE TABLE field_defs (
  workspace TEXT NOT NULL,
  id TEXT NOT NULL,
  entity TEXT NOT NULL CHECK (entity IN ('customer', 'site', 'device')),
  label TEXT NOT NULL,
  position INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (workspace, id)
);

-- A technician's pairing code, by the keyed hash of the code the owner types.
-- The lookup starts from the hash alone, so it spans every workspace; the row
-- then names the workspace. A code works once (used_at) and until expires_at.
CREATE TABLE pairing_codes (
  hash TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  id TEXT NOT NULL,
  site_id TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX pairing_by_workspace ON pairing_codes (workspace, created_at);
