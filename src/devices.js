// Customers, their sites, their saved PCs, the workspace's custom fields and the
// pairing codes that add a PC, in the shared D1 database. Every query the relay
// runs on these tables is in this file, and every query filters by workspace
// (pairing_codes: by hash first, then workspace). Every store method takes the
// workspace slug first, so one workspace never reads another's rows.
//
// None of this data is read when the relay decides who may do what. Custom
// field text is untrusted: it is shown to people and, later, to agents, and it
// never grants access.
//
// Every change goes through the team store's guarded change (mutate), so the log
// row commits with the change and the actor's permission is checked again at
// commit, as for member writes. The only unlogged writes are a PC's check-in
// details (at most every 5 minutes, or once a minute when one changed) and purging expired
// codes and waiting PCs. A log detail holds names and ids, never a code, a key
// or a field value.
//
// Watching a saved PC's session and moving its driver follow one rule (sessionRule, below), and the
// move itself is one guarded change (handOver) that changes the PC's pointer, any queue item
// claimed with it, and the team log together.
//
// Three of these changes also raise a notification for the people who should hear of
// it (src/notify.js): a PC asking to join, a PC leaving, and a saved-PC session that
// ended early. Their rows go into the same batch as the change, ahead of the
// statement that changes what the guard reads, so they exist exactly when it does.
//
// A device's key is smd1.<workspace>.<device id>.<secret>. Only the SHA-256 of
// the secret is stored. A pairing code and a waiting PC's six-digit number are
// stored as keyed hashes under AUTH_SECRET, and never appear in clear in a row
// or a log line.
import { MIN_SECRET_LENGTH, base32Encode, hmacHex, randomBytes, randomToken, sha256Hex, timingSafeEqual } from './crypto.js';
import { TeamError, normalizeIdentity, teamFromEnv } from './workspace.js';
import { UNATTENDED_PERMISSION } from './permissions.js';
import { compareVersions, validVersion } from './release.js';
import { deviceHooks } from './device-sessions.js';
import { notifyStore } from './notify.js';

export const ID_RE = /^[a-z2-7]{20}$/;
// smd1.<workspace>.<device id>.<secret>. A mismatch is 401 device_unknown.
const KEY_RE = /^smd1\.([a-z0-9-]{1,40})\.([a-z2-7]{20})\.([A-Za-z0-9_-]{43})$/;
// No 0, 1, I or O. 32 characters, so each one is 5 random bits.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 10;
const CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
export const CODE_TTL_MS = 10 * MINUTE_MS;
export const PENDING_TTL_MS = 24 * HOUR_MS;
// A PC's reported details are written at most this often, unless one changed.
export const CHECK_IN_REFRESH_MS = 5 * MINUTE_MS;
// Even a changed value is written at most this often, so a PC cannot flip its
// details to force a write on every check-in.
export const CHECK_IN_CHANGE_MS = MINUTE_MS;

// The first release that picks up a session from the check-in and the doorbell.
export const MIN_SESSION_VERSION = '0.6.0';
// A saved-PC session waits this long for the PC to pick it up and its person to
// answer (a 330-second check-in without the doorbell, plus 180), then lasts 24
// hours from the first hello. The pointer's expires_at is the latest the
// session can end, so it covers both.
export const SESSION_WAIT_MS = 510_000;
export const SESSION_LIFE_MS = 24 * HOUR_MS;

export const LIMITS = Object.freeze({
  customers: 10_000, sites: 10_000, devices: 2_000, fieldDefs: 30, liveCodes: 20, pending: 20, requestsPerHour: 20,
  value: 500, label: 60,
});

// The built-in fields of each record type. Custom fields are text only, up to
// LIMITS.value characters, and are kept apart in `fields`.
export const BUILTIN_FIELDS = Object.freeze({
  customer: Object.freeze({
    name: Object.freeze({ max: 100, required: true }),
    phone: Object.freeze({ max: 200 }),
    email: Object.freeze({ max: 200 }),
    notes: Object.freeze({ max: 2000, multiline: true }),
  }),
  site: Object.freeze({
    name: Object.freeze({ max: 100, required: true }),
    address: Object.freeze({ max: 300 }),
    notes: Object.freeze({ max: 2000, multiline: true }),
  }),
  // What the owner sets, what the team keeps (owner_contact) and what the PC
  // reports about itself. access and control are the two modes below.
  device: Object.freeze({
    name: Object.freeze({ max: 100, required: true }),
    owner_contact: Object.freeze({ max: 200 }),
    os: Object.freeze({ max: 100 }),
    machine: Object.freeze({ max: 100 }),
    app_version: Object.freeze({ max: 40 }),
  }),
});
export const ACCESS_MODES = Object.freeze(['ask', 'any']);
export const CONTROL_MODES = Object.freeze(['full', 'limited']);
export const FIELD_ENTITIES = Object.freeze(['customer', 'site', 'device']);

// Table, built-in text columns and cap for the two record types that share code.
const RECORDS = Object.freeze({
  customer: Object.freeze({ table: 'customers', plural: 'customers', cols: Object.keys(BUILTIN_FIELDS.customer), max: LIMITS.customers }),
  site: Object.freeze({ table: 'sites', plural: 'sites', cols: Object.keys(BUILTIN_FIELDS.site), max: LIMITS.sites }),
});
const TABLES = Object.freeze({ customer: 'customers', site: 'sites', device: 'devices' });

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const MULTILINE_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const ZERO_HASH = '0'.repeat(64);

const bad = (message) => new TeamError(400, 'bad_request', message);
const unknownDevice = () => new TeamError(401, 'device_unknown', 'this key is not valid');
const codeInvalid = () => new TeamError(404, 'code_invalid', 'this code is not valid');
// The owner's contact is the team's to keep: a PC that sends one is refused, so a
// PC administrator holding the key can't overwrite what the team set.
const noOwnerContact = (body) => {
  if (Object.hasOwn(body, 'owner_contact')) throw bad('owner_contact is kept by the team, not sent by the PC');
};

export const newId = () => base32Encode(randomBytes(13)).slice(0, 20).toLowerCase();

// The text a person types: uppercase, hyphens and spaces dropped.
export const normalizeCode = (v) => String(v ?? '').toUpperCase().replace(/[\s-]/g, '');
const showCode = (code) => `${code.slice(0, 5)}-${code.slice(5)}`;

// A code as an install link carries it (/install?code=): the 10 characters, with
// or without the hyphen, in any case. Returns the shown form, ABCDE-FGH23, or null.
export function linkCode(v) {
  if (typeof v !== 'string' || !/^[A-Za-z0-9]{5}-?[A-Za-z0-9]{5}$/.test(v)) return null;
  const code = v.toUpperCase().replace('-', '');
  return CODE_RE.test(code) ? showCode(code) : null;
}

function newCode() {
  const bytes = randomBytes(CODE_LENGTH);
  return Array.from(bytes, (b) => CODE_ALPHABET[b & 31]).join('');
}

// Six random digits for an owner-started install.
function newConfirm() {
  const n = new DataView(randomBytes(4).buffer).getUint32(0);
  return String(n % 1_000_000).padStart(6, '0');
}

// The key's parts, or null for anything that is not a well-formed key.
export function parseDeviceKey(key) {
  const m = typeof key === 'string' ? KEY_RE.exec(key) : null;
  return m ? { workspace: m[1], id: m[2], secret: m[3] } : null;
}

// One text value. spec is an entry of BUILTIN_FIELDS. Returns the trimmed text.
function textValue(v, field, spec) {
  if (typeof v !== 'string') throw bad(`${field} must be text`);
  const t = v.trim();
  if (t.length > spec.max) throw bad(`${field} must be at most ${spec.max} characters`);
  if ((spec.multiline ? MULTILINE_CHARS : CONTROL_CHARS).test(t)) throw bad(`${field} must not contain control characters`);
  if (spec.required && !t) throw bad(`${field} is required`);
  return t;
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function oneOf(v, list, field) {
  if (!list.includes(v)) throw bad(`${field} must be ${list.join(' or ')}`);
  return v;
}

function validId(v, field) {
  if (typeof v !== 'string' || !ID_RE.test(v)) throw bad(`${field} must be an id from this team`);
  return v;
}

// A device for the team API. The key hash and the confirm hash never leave the
// store; a waiting PC shows when its request ends, not its six digits.
const deviceOut = (r) => ({
  id: r.id, site_id: r.site_id, status: r.status, name: r.name, access: r.access, control: r.control,
  owner_contact: r.owner_contact, os: r.os, machine: r.machine, app_version: r.app_version, protocol: r.protocol,
  paired_at: r.paired_at, paired_by: r.paired_by, approved_by: r.approved_by, last_seen: r.last_seen,
  ...(r.status === 'pending' ? { expires_at: r.expires_at } : {}),
  fields: JSON.parse(r.fields),
});
// A device for the PC itself.
const pcOut = (r) => ({ id: r.id, workspace: r.workspace, status: r.status, name: r.name, access: r.access, control: r.control, site_id: r.site_id });
// The live session pointer on a device row, or null when there is none, it is
// not valid JSON of the expected shape, or its end has passed.
export function livePointer(row, now = Date.now()) {
  if (!row || typeof row.session !== 'string') return null;
  let p;
  try { p = JSON.parse(row.session); } catch (_) { return null; }
  if (!p || typeof p !== 'object' || typeof p.id !== 'string' || typeof p.by !== 'string' || !Number.isFinite(p.expires_at) || p.expires_at <= now) return null;
  return p;
}
// The ways a saved-PC session ends from the PC's side, and how a notification puts each.
const EARLY_ENDS = Object.freeze({
  declined: 'the person at the PC declined',
  nobody: 'nobody was signed in at the PC',
  busy: 'the PC was busy',
  owner: 'the PC\'s owner ended the session',
});
const STOPPED_MESSAGE = 'this workspace is stopped; someone who can manage members must resume it';
// A customer or site, without its workspace column.
const recordOut = ({ workspace, ...r }) => ({ ...r, fields: JSON.parse(r.fields) });

// deps: the team store (src/workspace.js), whose guarded change this builds on.
// opts.authSecret is AUTH_SECRET: without one of MIN_SECRET_LENGTH characters
// the pairing routes answer 503 unavailable.
// opts.hooks reaches the Durable Objects (src/device-sessions.js): ringing a PC's
// doorbell, making, ending and taking over a session. Without it the store
// changes the database and touches nothing else.
export function deviceStore(db, team, { authSecret = '', hooks = null } = {}) {
  const { mutate, actorContext, actorHas, actorUnchanged, and, lit } = team;
  const q = (sql, ...params) => db.prepare(sql).bind(...params);
  const notify = notifyStore(db, team);
  const secretOk = typeof authSecret === 'string' && authSecret.length >= MIN_SECRET_LENGTH;
  const needSecret = () => {
    if (!secretOk) throw new TeamError(503, 'unavailable', `pairing is not configured: the server operator must set AUTH_SECRET (at least ${MIN_SECRET_LENGTH} characters)`);
  };

  // ---- SQL fragments, each a [sql, params] pair ------------------------------
  const count = (table, slug, where = '', ...params) => q(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace = ?${where}`, slug, ...params).first('n');
  const countBelow = (table, slug, max, where = '', ...params) => [`(SELECT COUNT(*) FROM ${table} WHERE workspace = ?${where}) < ?`, [slug, ...params, max]];
  const rowExists = (table, slug, id) => [`EXISTS (SELECT 1 FROM ${table} WHERE workspace = ? AND id = ?)`, [slug, id]];
  const liveCodes = ' AND used_at IS NULL AND expires_at > ?';
  // Every custom field id in `ids` still has a definition for this record type.
  // The ids go in as one JSON array, so the statement binds three values however
  // many fields a request sets (D1 allows 100 bound values per statement).
  const fieldsDefined = (slug, entity, ids) => (ids.length
    ? ['NOT EXISTS (SELECT 1 FROM json_each(?) j WHERE NOT EXISTS (SELECT 1 FROM field_defs f WHERE f.workspace = ? AND f.entity = ? AND f.id = j.value))', [JSON.stringify(ids), slug, entity]]
    : lit(true));
  // The workspace is not stopped: its newest workspace_stopped row is not newer
  // than its newest workspace_resumed row, by seq (the rule of stopState).
  const notStopped = (slug) => [
    "COALESCE((SELECT MAX(seq) FROM audit WHERE workspace = ? AND kind = 'workspace_stopped'), 0) <= COALESCE((SELECT MAX(seq) FROM audit WHERE workspace = ? AND kind = 'workspace_resumed'), 0)",
    [slug, slug],
  ];
  // Whether the actor holds a permission now, read with the same SQL the guards use.
  const holds = async (slug, actor, permission) => {
    const [sql, params] = actorHas(slug, actor, permission);
    return !!(await q(`SELECT 1 AS ok WHERE ${sql}`, ...params).first('ok'));
  };

  // Waiting PCs past their 24 hours and codes past their 10 minutes are purged
  // as they are met. Unlogged, and filtered by workspace like every query here.
  const purgePending = (slug) => q("DELETE FROM devices WHERE workspace = ? AND status = 'pending' AND expires_at <= ?", slug, Date.now()).run();
  const purgeCodes = (slug) => q('DELETE FROM pairing_codes WHERE workspace = ? AND expires_at <= ?', slug, Date.now()).run();

  // ---- custom fields on a record -----------------------------------------------
  // The custom field values from a request body: { "<field id>": "text" }, ids
  // from this workspace's definitions for the record type. With allowNull (a
  // PATCH) a null value deletes the field. Returns { set, remove }.
  async function readFields(slug, entity, input, allowNull) {
    if (!isObject(input)) throw bad('fields must be an object of field id to text');
    const { results } = await q('SELECT id FROM field_defs WHERE workspace = ? AND entity = ?', slug, entity).all();
    const known = new Set(results.map((r) => r.id));
    const set = {};
    const remove = [];
    for (const [id, value] of Object.entries(input)) {
      if (!known.has(id)) throw bad(`unknown field: ${id.slice(0, 40)}`);
      if (value === null && allowNull) remove.push(id);
      else set[id] = textValue(value, `field ${id}`, { max: LIMITS.value, multiline: true });
    }
    return { set, remove };
  }

  // What a PATCH of custom fields changes on a record that holds `have`: only the
  // values that differ. patch is the JSON for json_patch (null deletes a field),
  // and merged is the record's fields afterwards.
  function mergeFields(have, { set, remove }) {
    const setIds = Object.keys(set).filter((f) => have[f] !== set[f]);
    const removeIds = remove.filter((f) => Object.hasOwn(have, f));
    const patch = { ...Object.fromEntries(setIds.map((f) => [f, set[f]])), ...Object.fromEntries(removeIds.map((f) => [f, null])) };
    const merged = { ...Object.fromEntries(Object.entries(have).filter(([f]) => !removeIds.includes(f))), ...Object.fromEntries(setIds.map((f) => [f, set[f]])) };
    return { setIds, ids: [...setIds, ...removeIds], patch: JSON.stringify(patch), merged };
  }

  // ---- customers and sites -----------------------------------------------------
  // The two record types share their code: a table, built-in text columns,
  // custom fields, and a cap. A site belongs to a customer.
  async function listRecords(entity, slug, { after = '', limit = 100, filter = null } = {}) {
    const { table, plural } = RECORDS[entity];
    const parent = filter && entity === 'site' ? ' AND customer_id = ?' : '';
    const { results } = await q(`SELECT * FROM ${table} WHERE workspace = ? AND id > ?${parent} ORDER BY id LIMIT ?`,
      slug, after, ...(parent ? [filter] : []), limit + 1).all();
    const page = results.slice(0, limit);
    return { [plural]: page.map(recordOut), next: results.length > limit ? page.at(-1).id : null };
  }

  async function getRecord(entity, slug, id) {
    const row = await q(`SELECT * FROM ${RECORDS[entity].table} WHERE workspace = ? AND id = ?`, slug, id).first();
    if (!row) throw new TeamError(404, 'not_found', `no such ${entity}`);
    return recordOut(row);
  }

  async function addRecord(entity, slug, actorIdentity, body) {
    const { table, cols, max } = RECORDS[entity];
    const actor = normalizeIdentity(actorIdentity);
    const values = {};
    for (const col of cols) values[col] = textValue(Object.hasOwn(body, col) ? body[col] : '', col, BUILTIN_FIELDS[entity][col]);
    const customerId = entity === 'site' ? validId(body.customer_id, 'customer_id') : null;
    return mutate(slug, actor, async () => {
      const ctx = await actorContext(slug, actor, 'devices.manage');
      if (customerId && !(await count('customers', slug, ' AND id = ?', customerId))) throw new TeamError(400, 'unknown_customer', 'no such customer');
      if ((await count(table, slug)) >= max) throw new TeamError(409, `${entity}_limit`, `a team holds at most ${max} ${RECORDS[entity].plural}`);
      const { set } = Object.hasOwn(body, 'fields') ? await readFields(slug, entity, body.fields, false) : { set: {} };
      const id = newId();
      const now = Date.now();
      const names = [...(customerId ? ['customer_id'] : []), ...cols];
      const vals = [...(customerId ? [customerId] : []), ...cols.map((c) => values[c])];
      return {
        entries: [{ kind: `${entity}_added`, detail: `${id} ${JSON.stringify(values.name)}` }],
        guard: and(
          actorHas(slug, actor, 'devices.manage'),
          actorUnchanged(slug, ctx),
          countBelow(table, slug, max),
          customerId ? rowExists('customers', slug, customerId) : lit(true),
          fieldsDefined(slug, entity, Object.keys(set)),
        ),
        change: ([cond, params]) => [q(
          `INSERT INTO ${table}(workspace, id, ${names.join(', ')}, fields, created_at, created_by, updated_at) SELECT ?, ?, ${names.map(() => '?').join(', ')}, ?, ?, ?, ? WHERE ${cond}`,
          slug, id, ...vals, JSON.stringify(set), now, actor, now, ...params,
        )],
        result: { id, ...(customerId ? { customer_id: customerId } : {}), ...values, fields: set, created_at: now, created_by: actor, updated_at: now },
      };
    });
  }

  async function updateRecord(entity, slug, actorIdentity, id, body) {
    const { table, cols } = RECORDS[entity];
    const actor = normalizeIdentity(actorIdentity);
    const sent = cols.filter((c) => Object.hasOwn(body, c));
    const hasFields = Object.hasOwn(body, 'fields');
    if (!sent.length && !hasFields) throw bad(`send ${[...cols, 'fields'].join(', ')}`);
    const values = Object.fromEntries(sent.map((c) => [c, textValue(body[c], c, BUILTIN_FIELDS[entity][c])]));
    return mutate(slug, actor, async () => {
      const ctx = await actorContext(slug, actor, 'devices.manage');
      const cur = await q(`SELECT * FROM ${table} WHERE workspace = ? AND id = ?`, slug, id).first();
      if (!cur) throw new TeamError(404, 'not_found', `no such ${entity}`);
      const merge = mergeFields(JSON.parse(cur.fields), hasFields ? await readFields(slug, entity, body.fields, true) : { set: {}, remove: [] });
      // Only what differs from the stored record is a change.
      const columns = sent.filter((c) => values[c] !== cur[c]);
      if (!columns.length && !merge.ids.length) return { noop: true, result: recordOut(cur) };
      const now = Date.now();
      return {
        entries: [{ kind: `${entity}_changed`, detail: `${id} ${[...columns, ...merge.ids.map((f) => `field ${f}`)].join(', ')}` }],
        guard: and(actorHas(slug, actor, 'devices.manage'), actorUnchanged(slug, ctx), rowExists(table, slug, id), fieldsDefined(slug, entity, merge.setIds)),
        // json_patch merges the field values in the database, so two edits of
        // different fields at once both stay. A null in the patch deletes a field.
        change: ([cond, params]) => [q(
          `UPDATE ${table} SET ${[...columns.map((c) => `${c} = ?`), 'fields = json_patch(fields, ?)', 'updated_at = ?'].join(', ')} WHERE workspace = ? AND id = ? AND ${cond}`,
          ...columns.map((c) => values[c]), merge.patch, now, slug, id, ...params,
        )],
        result: recordOut({ ...cur, ...Object.fromEntries(columns.map((c) => [c, values[c]])), fields: JSON.stringify(merge.merged), updated_at: now }),
      };
    });
  }

  async function removeRecord(entity, slug, actorIdentity, id) {
    const { table } = RECORDS[entity];
    const actor = normalizeIdentity(actorIdentity);
    return mutate(slug, actor, async () => {
      const ctx = await actorContext(slug, actor, 'devices.manage');
      const cur = await q(`SELECT * FROM ${table} WHERE workspace = ? AND id = ?`, slug, id).first();
      if (!cur) throw new TeamError(404, 'not_found', `no such ${entity}`);
      // A customer with sites, or a site with PCs or live codes, is not removed.
      const now = Date.now();
      const busy = entity === 'customer'
        ? await count('sites', slug, ' AND customer_id = ?', id)
        : (await count('devices', slug, ' AND site_id = ?', id)) + (await count('pairing_codes', slug, ` AND site_id = ?${liveCodes}`, id, now));
      if (busy) throw new TeamError(409, 'in_use', entity === 'customer' ? 'this customer still has sites; remove them first' : 'this site still has PCs or live pairing codes');
      return {
        entries: [{ kind: `${entity}_removed`, detail: `${id} ${JSON.stringify(cur.name)}` }],
        guard: and(
          actorHas(slug, actor, 'devices.manage'),
          actorUnchanged(slug, ctx),
          rowExists(table, slug, id),
          entity === 'customer'
            ? ['NOT EXISTS (SELECT 1 FROM sites WHERE workspace = ? AND customer_id = ?)', [slug, id]]
            : and(
              ['NOT EXISTS (SELECT 1 FROM devices WHERE workspace = ? AND site_id = ?)', [slug, id]],
              [`NOT EXISTS (SELECT 1 FROM pairing_codes WHERE workspace = ? AND site_id = ?${liveCodes})`, [slug, id, now]],
            ),
        ),
        change: ([cond, params]) => [q(`DELETE FROM ${table} WHERE workspace = ? AND id = ? AND ${cond}`, slug, id, ...params)],
        result: { id },
      };
    });
  }

  // ---- custom field definitions --------------------------------------------------
  async function listFields(slug) {
    const { results } = await q('SELECT id, entity, label, position, created_at FROM field_defs WHERE workspace = ? ORDER BY entity, position, id', slug).all();
    return results;
  }

  async function addField(slug, actorIdentity, body) {
    const actor = normalizeIdentity(actorIdentity);
    const entity = oneOf(body.entity, FIELD_ENTITIES, 'entity');
    const label = textValue(body.label, 'label', { max: LIMITS.label, required: true });
    return mutate(slug, actor, async () => {
      const ctx = await actorContext(slug, actor, 'fields.manage');
      if ((await count('field_defs', slug, ' AND entity = ?', entity)) >= LIMITS.fieldDefs) {
        throw new TeamError(409, 'field_limit', `a record type holds at most ${LIMITS.fieldDefs} custom fields`);
      }
      const id = newId();
      const now = Date.now();
      const position = (await q('SELECT COALESCE(MAX(position) + 1, 0) AS next FROM field_defs WHERE workspace = ? AND entity = ?', slug, entity).first('next'));
      return {
        entries: [{ kind: 'field_added', detail: `${entity} ${id} ${JSON.stringify(label)}` }],
        guard: and(actorHas(slug, actor, 'fields.manage'), actorUnchanged(slug, ctx), countBelow('field_defs', slug, LIMITS.fieldDefs, ' AND entity = ?', entity)),
        change: ([cond, params]) => [q(
          `INSERT INTO field_defs(workspace, id, entity, label, position, created_at) SELECT ?, ?, ?, ?, ?, ? WHERE ${cond}`,
          slug, id, entity, label, position, now, ...params,
        )],
        result: { id, entity, label, position, created_at: now },
      };
    });
  }

  async function updateField(slug, actorIdentity, id, body) {
    const actor = normalizeIdentity(actorIdentity);
    const hasLabel = Object.hasOwn(body, 'label');
    const hasPosition = Object.hasOwn(body, 'position');
    if (!hasLabel && !hasPosition) throw bad('send label or position');
    const label = hasLabel ? textValue(body.label, 'label', { max: LIMITS.label, required: true }) : undefined;
    if (hasPosition && !(Number.isInteger(body.position) && body.position >= 0 && body.position <= 1000)) throw bad('position must be a whole number from 0 to 1000');
    return mutate(slug, actor, async () => {
      const ctx = await actorContext(slug, actor, 'fields.manage');
      const cur = await q('SELECT id, entity, label, position, created_at FROM field_defs WHERE workspace = ? AND id = ?', slug, id).first();
      if (!cur) throw new TeamError(404, 'not_found', 'no such field');
      const next = { ...cur, ...(hasLabel ? { label } : {}), ...(hasPosition ? { position: body.position } : {}) };
      if (next.label === cur.label && next.position === cur.position) return { noop: true, result: cur };
      return {
        entries: [{ kind: 'field_changed', detail: `${cur.entity} ${id} ${JSON.stringify(next.label)} at ${next.position}` }],
        guard: and(actorHas(slug, actor, 'fields.manage'), actorUnchanged(slug, ctx), rowExists('field_defs', slug, id)),
        // Only the values sent are written, so a concurrent change to the other one stays.
        change: ([cond, params]) => [q(`UPDATE field_defs SET ${[...(hasLabel ? ['label = ?'] : []), ...(hasPosition ? ['position = ?'] : [])].join(', ')} WHERE workspace = ? AND id = ? AND ${cond}`,
          ...(hasLabel ? [label] : []), ...(hasPosition ? [body.position] : []), slug, id, ...params)],
        result: next,
      };
    });
  }

  async function removeField(slug, actorIdentity, id) {
    const actor = normalizeIdentity(actorIdentity);
    return mutate(slug, actor, async () => {
      const ctx = await actorContext(slug, actor, 'fields.manage');
      const cur = await q('SELECT id, entity, label FROM field_defs WHERE workspace = ? AND id = ?', slug, id).first();
      if (!cur) throw new TeamError(404, 'not_found', 'no such field');
      const path = `$."${id}"`;
      return {
        entries: [{ kind: 'field_removed', detail: `${cur.entity} ${id} ${JSON.stringify(cur.label)}` }],
        guard: and(actorHas(slug, actor, 'fields.manage'), actorUnchanged(slug, ctx), rowExists('field_defs', slug, id)),
        // The values go first, while the definition still stands for both guards.
        change: ([cond, params]) => [
          q(`UPDATE ${TABLES[cur.entity]} SET fields = json_remove(fields, ?) WHERE workspace = ? AND json_type(fields, ?) IS NOT NULL AND ${cond}`, path, slug, path, ...params),
          q(`DELETE FROM field_defs WHERE workspace = ? AND id = ? AND ${cond}`, slug, id, ...params),
        ],
        result: { id },
      };
    });
  }

  // ---- devices, as the team sees them -----------------------------------------
  async function listDevices(slug, { after = '', limit = 100, site = null, status = null } = {}) {
    await purgePending(slug);
    const where = `${site ? ' AND site_id = ?' : ''}${status ? ' AND status = ?' : ''}`;
    const { results } = await q(`SELECT * FROM devices WHERE workspace = ? AND id > ?${where} ORDER BY id LIMIT ?`,
      slug, after, ...(site ? [site] : []), ...(status ? [status] : []), limit + 1).all();
    const page = results.slice(0, limit);
    return { devices: page.map(deviceOut), next: results.length > limit ? page.at(-1).id : null };
  }

  // The live session pointer on a PC ({ id, by, ... }), or null.
  async function liveSession(slug, id) {
    return livePointer(await q('SELECT session FROM devices WHERE workspace = ? AND id = ?', slug, id).first());
  }

  async function getDevice(slug, id) {
    await purgePending(slug);
    const row = await q('SELECT * FROM devices WHERE workspace = ? AND id = ?', slug, id).first();
    if (!row) throw new TeamError(404, 'not_found', 'no such device');
    return deviceOut(row);
  }

  // A technician's change to a saved PC: its site, its custom fields, its access
  // mode, its owner's contact (the owner's control level and name stay the
  // owner's), or approval of a waiting PC with the six-digit number its owner
  // reads out. Approval is its own request: it is not mixed with other changes.
  async function updateDevice(slug, actorIdentity, id, body) {
    const actor = normalizeIdentity(actorIdentity);
    const hasSite = Object.hasOwn(body, 'site_id');
    const hasFields = Object.hasOwn(body, 'fields');
    const hasAccess = Object.hasOwn(body, 'access');
    const hasContact = Object.hasOwn(body, 'owner_contact');
    const hasApprove = Object.hasOwn(body, 'approve');
    // The name and the control level are the owner's, set from the PC, so a technician sending them is refused, not ignored.
    for (const owned of ['name', 'control', 'os', 'machine', 'app_version']) {
      if (Object.hasOwn(body, owned)) throw bad(`${owned} is set from the PC, not by the team`);
    }
    if (!hasSite && !hasFields && !hasAccess && !hasContact && !hasApprove) throw bad('send site_id, fields, access, owner_contact or approve');
    if (hasApprove && (hasSite || hasFields || hasAccess || hasContact)) throw bad('approve cannot be combined with other changes');
    const siteId = hasSite && body.site_id !== null ? validId(body.site_id, 'site_id') : null;
    const access = hasAccess ? oneOf(body.access, ACCESS_MODES, 'access') : undefined;
    // An empty contact clears it.
    const contact = hasContact ? textValue(body.owner_contact, 'owner_contact', BUILTIN_FIELDS.device.owner_contact) : undefined;
    let confirm;
    if (hasApprove) {
      confirm = isObject(body.approve) ? body.approve.confirm : undefined;
      if (typeof confirm !== 'string' || !/^\d{6}$/.test(confirm)) throw bad('approve.confirm must be the six-digit number shown on the PC');
      needSecret();
    }
    // Switching a PC to "any time" lets technicians in without asking the person
    // at it, so it needs sessions.unattended as well as devices.manage. Sending
    // "any" for a PC that is already "any" changes nothing and needs only devices.manage.
    let ring = false;
    const out = await mutate(slug, actor, async () => {
      ring = false;
      const ctx = await actorContext(slug, actor, 'devices.manage');
      await purgePending(slug);
      const cur = await q('SELECT * FROM devices WHERE workspace = ? AND id = ?', slug, id).first();
      if (!cur) throw new TeamError(404, 'not_found', 'no such device');
      if (hasAccess && access === 'any' && cur.access !== 'any' && !ctx.permissions.includes(UNATTENDED_PERMISSION)) {
        throw new TeamError(403, 'permission_denied', `your role does not allow ${UNATTENDED_PERMISSION} (switching a PC to any time)`);
      }
      const now = Date.now();
      const base = and(actorHas(slug, actor, 'devices.manage'), actorUnchanged(slug, ctx), rowExists('devices', slug, id));
      if (hasApprove) {
        if (cur.status !== 'pending') throw new TeamError(409, 'not_pending', 'this PC is not waiting for approval');
        const given = await hmacHex(authSecret, 'device-confirm', `${id}:${confirm}`);
        if (!timingSafeEqual(given, cur.confirm_hash)) throw new TeamError(403, 'confirm_wrong', 'that number does not match the one on the PC');
        ring = true;
        return {
          entries: [{ kind: 'device_approved', detail: `${id} ${JSON.stringify(cur.name)}` }],
          guard: and(base, ["EXISTS (SELECT 1 FROM devices WHERE workspace = ? AND id = ? AND status = 'pending' AND confirm_hash = ? AND expires_at > ?)", [slug, id, cur.confirm_hash, now]]),
          change: ([cond, params]) => [q(
            `UPDATE devices SET status = 'active', confirm_hash = NULL, expires_at = NULL, approved_by = ? WHERE workspace = ? AND id = ? AND ${cond}`,
            actor, slug, id, ...params,
          )],
          result: deviceOut({ ...cur, status: 'active', confirm_hash: null, expires_at: null, approved_by: actor }),
        };
      }
      if (hasAccess && cur.status !== 'active') throw new TeamError(409, 'pending', 'approve this PC before changing its access');
      if (siteId && !(await count('sites', slug, ' AND id = ?', siteId))) throw new TeamError(400, 'unknown_site', 'no such site');
      const merge = mergeFields(JSON.parse(cur.fields), hasFields ? await readFields(slug, 'device', body.fields, true) : { set: {}, remove: [] });
      const changed = [];
      const sets = [];
      const values = [];
      const siteChanges = hasSite && siteId !== cur.site_id;
      if (siteChanges) { changed.push(`site ${cur.site_id ?? 'none'} to ${siteId ?? 'none'}`); sets.push('site_id = ?'); values.push(siteId); }
      const accessChanges = hasAccess && access !== cur.access;
      if (accessChanges) { changed.push(`access ${cur.access} to ${access}`); sets.push('access = ?'); values.push(access); }
      // owner_contact is personal data, so the log names it without its value.
      const contactChanges = hasContact && contact !== cur.owner_contact;
      if (contactChanges) { changed.push('owner_contact'); sets.push('owner_contact = ?'); values.push(contact); }
      if (merge.ids.length) { changed.push(...merge.ids.map((f) => `field ${f}`)); sets.push('fields = json_patch(fields, ?)'); values.push(merge.patch); }
      if (!changed.length) return { noop: true, result: deviceOut(cur) };
      // A changed access mode is something the PC acts on, so it is rung.
      ring = accessChanges;
      return {
        entries: [{ kind: 'device_changed', detail: `${id} ${changed.join(', ')}` }],
        guard: and(
          base,
          // The permission is held at commit too, not only when it was read.
          accessChanges && access === 'any' ? actorHas(slug, actor, UNATTENDED_PERMISSION) : lit(true),
          siteId ? rowExists('sites', slug, siteId) : lit(true),
          // The site a technician replaces is the one the plan read.
          siteChanges ? ['EXISTS (SELECT 1 FROM devices WHERE workspace = ? AND id = ? AND site_id IS ?)', [slug, id, cur.site_id]] : lit(true),
          fieldsDefined(slug, 'device', merge.setIds),
          // The mode a technician replaces is the one the plan read, on a PC still approved.
          accessChanges ? ["EXISTS (SELECT 1 FROM devices WHERE workspace = ? AND id = ? AND status = 'active' AND access = ?)", [slug, id, cur.access]] : lit(true),
        ),
        change: ([cond, params]) => [q(`UPDATE devices SET ${sets.join(', ')} WHERE workspace = ? AND id = ? AND ${cond}`, ...values, slug, id, ...params)],
        result: deviceOut({
          ...cur, site_id: hasSite ? siteId : cur.site_id, access: accessChanges ? access : cur.access,
          owner_contact: contactChanges ? contact : cur.owner_contact, fields: JSON.stringify(merge.merged),
        }),
      };
    });
    if (ring) await hooks?.ring(slug, id);
    return out;
  }

  // A technician removes a saved PC, waiting or not. Its key ends with its row.
  async function removeDevice(slug, actorIdentity, id) {
    const actor = normalizeIdentity(actorIdentity);
    const ended = new Set();
    const out = await mutate(slug, actor, async () => {
      const ctx = await actorContext(slug, actor, 'devices.manage');
      const cur = await q('SELECT id, name, session FROM devices WHERE workspace = ? AND id = ?', slug, id).first();
      if (!cur) throw new TeamError(404, 'not_found', 'no such device');
      // The PC's live session ends first, with reason "removed": nothing would
      // tell it once the row is gone. Done once per session, even if the change
      // is retried; a session that started between attempts is ended too.
      const live = livePointer(cur);
      if (live && !ended.has(live.id)) {
        ended.add(live.id);
        await hooks?.endSession(slug, live.id, 'removed', actor);
      }
      return {
        entries: [{ kind: 'device_removed', detail: `${id} ${JSON.stringify(cur.name)}` }],
        guard: and(actorHas(slug, actor, 'devices.manage'), actorUnchanged(slug, ctx), rowExists('devices', slug, id)),
        change: ([cond, params]) => [q(`DELETE FROM devices WHERE workspace = ? AND id = ? AND ${cond}`, slug, id, ...params)],
        result: { id },
      };
    });
    // Rung after the row is gone, so the PC's check-in finds it removed. Its doorbell then closes.
    await hooks?.ring(slug, id, { close: true });
    return out;
  }

  // ---- pairing codes (the team side) ---------------------------------------------
  // The code is drawn inside plan(), so a hash that already exists retries with a
  // fresh code. It is returned here and nowhere else.
  async function createPairingCode(slug, actorIdentity, body) {
    const actor = normalizeIdentity(actorIdentity);
    const siteId = Object.hasOwn(body, 'site_id') && body.site_id !== null ? validId(body.site_id, 'site_id') : null;
    needSecret();
    await purgeCodes(slug);
    return mutate(slug, actor, async () => {
      const ctx = await actorContext(slug, actor, 'devices.manage');
      const now = Date.now();
      if ((await count('pairing_codes', slug, liveCodes, now)) >= LIMITS.liveCodes) {
        throw new TeamError(409, 'code_limit', `a team holds at most ${LIMITS.liveCodes} live pairing codes`);
      }
      if (siteId && !(await count('sites', slug, ' AND id = ?', siteId))) throw new TeamError(400, 'unknown_site', 'no such site');
      const code = newCode();
      const hash = await hmacHex(authSecret, 'pairing-code', code);
      const id = newId();
      const expires = now + CODE_TTL_MS;
      return {
        entries: [{ kind: 'pairing_code_created', detail: siteId ? `${id} for site ${siteId}` : id }],
        guard: and(
          actorHas(slug, actor, 'devices.manage'),
          actorUnchanged(slug, ctx),
          countBelow('pairing_codes', slug, LIMITS.liveCodes, liveCodes, now),
          siteId ? rowExists('sites', slug, siteId) : lit(true),
          ['NOT EXISTS (SELECT 1 FROM pairing_codes WHERE hash = ?)', [hash]],
        ),
        change: ([cond, params]) => [q(
          `INSERT INTO pairing_codes(hash, workspace, id, site_id, created_by, created_at, expires_at, used_at) SELECT ?, ?, ?, ?, ?, ?, ?, NULL WHERE ${cond}`,
          hash, slug, id, siteId, actor, now, expires, ...params,
        )],
        result: { id, code: showCode(code), expires_at: expires, site_id: siteId },
      };
    });
  }

  // The live codes, without the codes: only the hash is stored.
  async function listPairingCodes(slug) {
    await purgeCodes(slug);
    const { results } = await q(`SELECT id, site_id, created_by, created_at, expires_at FROM pairing_codes WHERE workspace = ?${liveCodes} ORDER BY created_at, id`, slug, Date.now()).all();
    return results;
  }

  async function revokePairingCode(slug, actorIdentity, id) {
    const actor = normalizeIdentity(actorIdentity);
    return mutate(slug, actor, async () => {
      const ctx = await actorContext(slug, actor, 'devices.manage');
      const now = Date.now();
      const cur = await q(`SELECT id FROM pairing_codes WHERE workspace = ? AND id = ?${liveCodes}`, slug, id, now).first();
      if (!cur) throw new TeamError(404, 'not_found', 'no such live pairing code');
      return {
        entries: [{ kind: 'pairing_code_revoked', detail: id }],
        guard: and(actorHas(slug, actor, 'devices.manage'), actorUnchanged(slug, ctx),
          [`EXISTS (SELECT 1 FROM pairing_codes WHERE workspace = ? AND id = ?${liveCodes})`, [slug, id, now]]),
        change: ([cond, params]) => [q(`DELETE FROM pairing_codes WHERE workspace = ? AND id = ? AND ${cond}`, slug, id, ...params)],
        result: { id },
      };
    });
  }

  // ---- the PC's side ------------------------------------------------------------
  // The named fields of a /device body: text from BUILTIN_FIELDS.device, and the
  // two modes. Anything not named is ignored, except owner_contact (noOwnerContact).
  function readPcFields(body, names) {
    const out = {};
    for (const field of names) {
      if (!Object.hasOwn(body, field)) continue;
      if (field === 'access') out.access = oneOf(body.access, ACCESS_MODES, 'access');
      else if (field === 'control') out.control = oneOf(body.control, CONTROL_MODES, 'control');
      else out[field] = textValue(body[field], field, { ...BUILTIN_FIELDS.device[field], required: false });
    }
    return out;
  }
  const PAIR_FIELDS = ['name', 'access', 'control', 'os', 'machine', 'app_version'];

  // The new device row for a pair or a request. Safe defaults: asks first, limited.
  function newDevice(slug, id, fields, extra) {
    const now = Date.now();
    return {
      workspace: slug, id, site_id: null, status: 'active',
      name: fields.name || fields.machine || 'PC', access: fields.access ?? 'ask', control: fields.control ?? 'limited',
      owner_contact: '', os: fields.os ?? '', machine: fields.machine ?? '', app_version: fields.app_version ?? '',
      protocol: 1, key_hash: '', confirm_hash: null, expires_at: null, paired_at: now, paired_by: '', approved_by: null,
      last_seen: now, fields: '{}', ...extra,
    };
  }

  // The INSERT for a new device. site_id is kept only if the site still exists.
  const insertDevice = (d, siteId, [cond, params]) => q(
    `INSERT INTO devices(workspace, id, site_id, status, name, access, control, owner_contact, os, machine, app_version, protocol,
      key_hash, confirm_hash, expires_at, paired_at, paired_by, approved_by, last_seen, fields)
      SELECT ?, ?, (SELECT id FROM sites WHERE workspace = ? AND id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${cond}`,
    d.workspace, d.id, d.workspace, siteId, d.status, d.name, d.access, d.control, d.owner_contact, d.os, d.machine, d.app_version, d.protocol,
    d.key_hash, d.confirm_hash, d.expires_at, d.paired_at, d.paired_by, d.approved_by, d.last_seen, d.fields, ...params,
  );

  // A technician's code, typed by the owner. Reads the code row by its hash (to
  // learn the workspace), then one guarded batch in this order: the log row, the
  // device, and last the code marked used. The same rule guards all three, so
  // they commit together or not at all, and a failed attempt leaves nothing.
  async function redeemCode(body) {
    needSecret();
    noOwnerContact(body);
    const code = normalizeCode(body.code);
    const fields = readPcFields(body, PAIR_FIELDS);
    if (!CODE_RE.test(code)) throw codeInvalid();
    const hash = await hmacHex(authSecret, 'pairing-code', code);
    const found = await q('SELECT workspace, created_by FROM pairing_codes WHERE hash = ?', hash).first();
    if (!found) throw codeInvalid();
    const slug = found.workspace;
    const id = newId();
    const secret = randomToken(32);
    const keyHash = await sha256Hex(secret);
    return mutate(slug, `${found.created_by} via code`, async () => {
      const now = Date.now();
      const row = await q('SELECT site_id, created_by, used_at, expires_at FROM pairing_codes WHERE hash = ? AND workspace = ?', hash, slug).first();
      if (!row || row.used_at !== null || row.expires_at <= now) throw codeInvalid();
      // A code carries the authority of the person who made it, for as long as they hold it.
      if (!(await holds(slug, row.created_by, 'devices.manage'))) throw codeInvalid();
      if ((await count('devices', slug)) >= LIMITS.devices) throw new TeamError(409, 'device_limit', `a team holds at most ${LIMITS.devices} PCs`);
      const device = newDevice(slug, id, fields, { key_hash: keyHash, paired_by: row.created_by });
      return {
        entries: [{ kind: 'device_paired', detail: `${id} ${JSON.stringify(device.name)}` }],
        guard: and(
          ['EXISTS (SELECT 1 FROM pairing_codes WHERE hash = ? AND workspace = ? AND used_at IS NULL AND expires_at > ?)', [hash, slug, now]],
          actorHas(slug, row.created_by, 'devices.manage'),
          countBelow('devices', slug, LIMITS.devices),
        ),
        change: (cond) => [
          insertDevice(device, row.site_id, cond),
          // The device row proves the guard held, so the code is consumed on its word.
          q('UPDATE pairing_codes SET used_at = ? WHERE hash = ? AND used_at IS NULL AND EXISTS (SELECT 1 FROM devices WHERE workspace = ? AND id = ? AND key_hash = ?)',
            now, hash, slug, id, keyHash),
        ],
        result: { status: 'active', workspace: slug, device_id: id, key: `smd1.${slug}.${id}.${secret}` },
      };
    });
  }

  // An install the owner starts: the PC joins as 'pending', with a six-digit number
  // the owner reads to a technician. At most 20 requests an hour and 20 waiting at
  // once per workspace, so strangers can't fill a team's list.
  async function requestJoin(body) {
    needSecret();
    noOwnerContact(body);
    const slug = body.workspace;
    const fields = readPcFields(body, PAIR_FIELDS);
    if (typeof slug !== 'string' || !(await team.workspaceExists(slug))) throw new TeamError(404, 'not_found', 'no such workspace');
    const id = newId();
    const secret = randomToken(32);
    const keyHash = await sha256Hex(secret);
    const confirm = newConfirm();
    const confirmHash = await hmacHex(authSecret, 'device-confirm', `${id}:${confirm}`);
    return mutate(slug, `pc ${id}`, async () => {
      const now = Date.now();
      const since = now - HOUR_MS;
      // A waiting PC past its 24 hours no longer counts. It is deleted only when
      // this request goes through, so a refused request writes nothing.
      const stillWaiting = " AND status = 'pending' AND expires_at > ?";
      const notExpired = " AND NOT (status = 'pending' AND expires_at <= ?)";
      // The hourly rule reads at most LIMITS.requestsPerHour rows of the log (the
      // audit_by_kind index). The plan's answer is advisory; the guard decides.
      const recentRequests = [
        "(SELECT COUNT(*) FROM (SELECT 1 FROM audit WHERE workspace = ? AND kind = 'device_requested' AND ts > ? AND actor <> ? LIMIT ?)) < ?",
        [slug, since, `pc ${id}`, LIMITS.requestsPerHour, LIMITS.requestsPerHour],
      ];
      // This request's own log row is left out, so the rule reads the same before and after it.
      if (!(await q(`SELECT 1 AS ok WHERE ${recentRequests[0]}`, ...recentRequests[1]).first('ok'))) throw new TeamError(409, 'request_limit', 'too many requests to join this team; try again later');
      if ((await count('devices', slug, stillWaiting, now)) >= LIMITS.pending) throw new TeamError(409, 'pending_limit', 'too many PCs are waiting for approval; try again later');
      if ((await count('devices', slug, notExpired, now)) >= LIMITS.devices) throw new TeamError(409, 'device_limit', `a team holds at most ${LIMITS.devices} PCs`);
      const expires = now + PENDING_TTL_MS;
      const device = newDevice(slug, id, fields, { status: 'pending', key_hash: keyHash, confirm_hash: confirmHash, expires_at: expires, paired_by: `pc ${id}` });
      // Everyone who can approve it hears that it is waiting.
      const heard = await notify.rows(slug, 'device_waiting', { holding: 'devices.manage' }, {
        device_id: id, title: 'A PC is waiting for approval', body: device.name, dedupe: `waiting:${id}`,
      });
      return {
        entries: [{ kind: 'device_requested', detail: `${id} ${JSON.stringify(device.name)}` }],
        guard: and(
          countBelow('devices', slug, LIMITS.pending, stillWaiting, now),
          countBelow('devices', slug, LIMITS.devices, notExpired, now),
          recentRequests,
        ),
        // The notifications come before the new device: its row counts toward the limits in the guard.
        change: ([cond, params]) => [
          q(`DELETE FROM devices WHERE workspace = ? AND status = 'pending' AND expires_at <= ? AND ${cond}`, slug, now, ...params),
          ...notify.statements(slug, heard, [cond, params]),
          insertDevice(device, null, [cond, params]),
        ],
        result: { status: 'pending', workspace: slug, device_id: id, key: `smd1.${slug}.${id}.${secret}`, confirm, expires_at: expires },
      };
    });
  }

  // The device a key opens, or null. A wrong secret, an unknown id, a removed
  // device and a waiting PC past its 24 hours are all the same null. The secret
  // is hashed and compared in constant time even when the id is unknown.
  async function authenticate(key) {
    const row = await q('SELECT * FROM devices WHERE workspace = ? AND id = ?', key.workspace, key.id).first();
    const given = await sha256Hex(key.secret);
    const match = timingSafeEqual(row ? row.key_hash : ZERO_HASH, given);
    if (!row || !match) return null;
    if (row.status === 'pending' && row.expires_at <= Date.now()) {
      await purgePending(key.workspace);
      return null;
    }
    return row;
  }

  // A PC checks in. What it reports is written at most every 5 minutes, or every
  // minute when a value changed. Unlogged, like the callers table. Returns the
  // device for the PC and, for the relay's own use (the update offer), the
  // version it runs: the one this request reports, else the stored one.
  async function checkInFull(key, body) {
    const dev = await authenticate(key);
    if (!dev) throw unknownDevice();
    const report = {};
    for (const field of ['os', 'machine', 'app_version']) {
      if (Object.hasOwn(body, field)) report[field] = textValue(body[field], field, BUILTIN_FIELDS.device[field]);
    }
    const now = Date.now();
    const next = { os: dev.os, machine: dev.machine, app_version: dev.app_version, ...report };
    const changed = ['os', 'machine', 'app_version'].some((f) => next[f] !== dev[f]) || dev.protocol !== 1;
    // last_seen is the time of the last write, so it also holds concurrent check-ins to the same limit.
    const minAge = changed ? CHECK_IN_CHANGE_MS : CHECK_IN_REFRESH_MS;
    if (now - dev.last_seen >= minAge) {
      await q('UPDATE devices SET os = ?, machine = ?, app_version = ?, protocol = 1, last_seen = ? WHERE workspace = ? AND id = ? AND key_hash = ? AND last_seen <= ?',
        next.os, next.machine, next.app_version, now, key.workspace, key.id, dev.key_hash, now - minAge).run();
    }
    // The session the PC should pick up, from the row already loaded: no further query.
    const live = dev.status === 'active' ? livePointer(dev, now) : null;
    const session = live ? { id: live.id, by: live.by, team: live.team, ask: live.ask, expires_at: live.expires_at } : null;
    return { device: pcOut(dev), app_version: next.app_version, session };
  }
  const checkIn = async (key, body) => (await checkInFull(key, body)).device;

  // The owner's changes from the PC itself: name, access, control. Logged as
  // device_changed by "pc <id>". A waiting PC may not (403 pending).
  async function updateOwn(key, body) {
    // A wrong key is 401 whatever the body says.
    if (!(await authenticate(key))) throw unknownDevice();
    noOwnerContact(body);
    const patch = readPcFields(body, ['name', 'access', 'control']);
    if (!Object.keys(patch).length) throw bad('send name, access or control');
    if (patch.name === '') throw bad('name is required');
    return mutate(key.workspace, `pc ${key.id}`, async () => {
      const dev = await authenticate(key);
      if (!dev) throw unknownDevice();
      if (dev.status !== 'active') throw new TeamError(403, 'pending', 'a technician has not approved this PC yet');
      const changed = Object.keys(patch).filter((f) => patch[f] !== dev[f]);
      if (!changed.length) return { noop: true, result: pcOut(dev) };
      const modes = changed.filter((f) => f === 'access' || f === 'control');
      const detail = changed.map((f) => (f === 'name' ? `name ${JSON.stringify(patch.name)}` : `${f} ${dev[f]} to ${patch[f]}`));
      return {
        entries: [{ kind: 'device_changed', detail: `${key.id} ${detail.join(', ')}` }],
        // Each mode this change replaces is the one the plan read.
        guard: and(
          ["EXISTS (SELECT 1 FROM devices WHERE workspace = ? AND id = ? AND key_hash = ? AND status = 'active')", [key.workspace, key.id, dev.key_hash]],
          ...modes.map((f) => [`EXISTS (SELECT 1 FROM devices WHERE workspace = ? AND id = ? AND ${f} = ?)`, [key.workspace, key.id, dev[f]]]),
        ),
        change: ([cond, params]) => [q(
          `UPDATE devices SET ${changed.map((f) => `${f} = ?`).join(', ')} WHERE workspace = ? AND id = ? AND ${cond}`,
          ...changed.map((f) => patch[f]), key.workspace, key.id, ...params,
        )],
        result: pcOut({ ...dev, ...patch }),
      };
    });
  }

  // The PC removes itself, waiting or active. Its key ends at once.
  async function leave(key) {
    const ended = new Set();
    return mutate(key.workspace, `pc ${key.id}`, async () => {
      const dev = await authenticate(key);
      if (!dev) throw unknownDevice();
      const live = livePointer(dev);
      if (live && !ended.has(live.id)) {
        ended.add(live.id);
        await hooks?.endSession(key.workspace, live.id, 'removed', `pc ${key.id}`);
      }
      // A PC that watchers follow, or that the team manages, is missing for good. A waiting PC is not.
      const heard = dev.status === 'active' ? await notify.rows(key.workspace, 'device_missing', { watching: key.id, holding: 'devices.manage' }, {
        device_id: key.id, title: 'A PC left the team', body: dev.name, dedupe: `left:${key.id}`,
      }) : [];
      return {
        entries: [{ kind: 'device_left', detail: `${key.id} ${JSON.stringify(dev.name)}` }],
        guard: ['EXISTS (SELECT 1 FROM devices WHERE workspace = ? AND id = ? AND key_hash = ?)', [key.workspace, key.id, dev.key_hash]],
        // The notifications come first: the delete removes the row the guard reads.
        change: (cond) => [
          ...notify.statements(key.workspace, heard, cond),
          q(`DELETE FROM devices WHERE workspace = ? AND id = ? AND key_hash = ? AND ${cond[0]}`, key.workspace, key.id, dev.key_hash, ...cond[1]),
        ],
        result: { removed: true },
      };
    });
  }

  // ---- saved-PC sessions ---------------------------------------------------------
  // Connect to a saved PC. args: { device_id, ask, take_over } (checked by the
  // caller for type). caps.factor(permission) throws when the caller's sign-in
  // lacks the second factor that permission needs.
  //
  // A new session: the Session object is made first, then one guarded change
  // claims devices.session and writes the device_session_started row together.
  // The change holds only while the workspace is not stopped, the PC is active,
  // free, and the caller still holds sessions.control and, when the session will
  // not ask, sessions.unattended. Free means no pointer, a pointer past its end,
  // or the pointer the plan found stranded: one whose Session has ended or does
  // not exist (a stop can end a Session before its pointer was written). A retry
  // keeps the Session object it made only while that Session is still waiting;
  // an ended one is thrown away and a fresh one made. Whoever loses the race is
  // told who is connected, and the unused Session object is thrown away.
  //
  // A take-over moves the driver of a live session to the caller. It always
  // needs sessions.unattended, and it is a log row, not an end.
  async function connect(slug, actorIdentity, args, caps = {}) {
    if (!hooks) throw new TeamError(503, 'unavailable', 'sessions are not configured');
    const actor = normalizeIdentity(actorIdentity);
    const id = validId(args.device_id, 'device_id');
    const forceAsk = args.ask === true;
    const takeOver = args.take_over === true;
    let made = null;
    let result;
    try {
      result = await mutate(slug, actor, async () => {
        const ctx = await actorContext(slug, actor, 'sessions.control');
        const cur = await q('SELECT * FROM devices WHERE workspace = ? AND id = ?', slug, id).first();
        if (!cur || (cur.status === 'pending' && cur.expires_at <= Date.now())) throw new TeamError(404, 'not_found', 'no such PC in this team');
        if (cur.status !== 'active') throw new TeamError(409, 'pending', 'this PC is waiting for approval; approve it first');
        // Read again on every attempt, so a stop that lands between attempts is seen.
        if ((await team.stopState(slug)).stopped) throw new TeamError(409, 'stopped', STOPPED_MESSAGE);
        if (!validVersion(cur.app_version) || compareVersions(cur.app_version, MIN_SESSION_VERSION) < 0) {
          throw new TeamError(409, 'needs_update', `this PC updates itself to ${MIN_SESSION_VERSION} first`);
        }
        const now = Date.now();
        let live = livePointer(cur, now);
        // A pointer is only as live as its Session. One whose Session has ended or
        // does not exist is stranded, and the claim below takes it over, guarded on
        // its id. A Session that cannot be reached counts as live.
        let stranded = null;
        if (live) {
          const state = await hooks.sessionState(slug, live.id);
          if (state !== null && state !== 'waiting' && state !== 'attached') { stranded = live; live = null; }
        }
        const base = and(actorHas(slug, actor, 'sessions.control'), actorUnchanged(slug, ctx), notStopped(slug), rowExists('devices', slug, id));
        const unattended = () => holds(slug, actor, UNATTENDED_PERMISSION);
        if (takeOver) {
          if (!(await unattended())) {
            throw new TeamError(403, 'permission_denied', `taking over needs ${UNATTENDED_PERMISSION}. Ask the driver to end the session, then connect again so the person at the PC is asked.`);
          }
          await caps.factor?.(UNATTENDED_PERMISSION);
        }
        if (live && !takeOver) throw new TeamError(409, 'connected', `${live.by} is connected`);
        if (live) {
          return {
            entries: [{ kind: 'device_session_taken_over', detail: `${id} ${JSON.stringify(cur.name)} from ${live.by}` }],
            guard: and(
              base,
              actorHas(slug, actor, UNATTENDED_PERMISSION),
              ["EXISTS (SELECT 1 FROM devices WHERE workspace = ? AND id = ? AND status = 'active' AND json_extract(session, '$.id') = ? AND json_extract(session, '$.expires_at') > ?)", [slug, id, live.id, now]],
            ),
            change: ([cond, params]) => [q(
              `UPDATE devices SET session = json_set(session, '$.by', ?) WHERE workspace = ? AND id = ? AND ${cond}`,
              actor, slug, id, ...params,
            )],
            result: { takeover: true, session_id: live.id, ask: live.ask },
          };
        }
        // The session asks unless the PC is set to any time, the caller did not
        // ask for a prompt, and they may connect without asking. Missing the
        // permission (or its second factor) is not a refusal: the person is asked.
        let ask = true;
        if (!forceAsk && cur.access === 'any' && (await unattended())) {
          try { await caps.factor?.(UNATTENDED_PERMISSION); ask = false; } catch (_) { ask = true; }
        }
        // A Session kept from an earlier attempt must still be waiting: a stop or a
        // technician may have ended it since.
        if (made && (await hooks.sessionState(slug, made.sid)) !== 'waiting') {
          await hooks.discardSession(slug, made.sid);
          made = null;
        }
        made ??= await hooks.createSession({ slug, actor, device: cur, openedByTask: caps.openedByTask });
        const pointer = {
          id: made.sid, by: actor, ask, expires_at: now + SESSION_WAIT_MS + SESSION_LIFE_MS, code: made.code, team: await team.workspaceName(slug),
        };
        return {
          entries: [{ kind: 'device_session_started', detail: `${id} ${JSON.stringify(cur.name)} ${made.sid.slice(0, 8)} ${ask ? 'asks' : 'does not ask'}` }],
          guard: and(
            base,
            ask ? lit(true) : and(actorHas(slug, actor, UNATTENDED_PERMISSION), ["EXISTS (SELECT 1 FROM devices WHERE workspace = ? AND id = ? AND access = 'any')", [slug, id]]),
            stranded
              ? ["EXISTS (SELECT 1 FROM devices WHERE workspace = ? AND id = ? AND status = 'active' AND json_extract(session, '$.id') = ?)", [slug, id, stranded.id]]
              : ["EXISTS (SELECT 1 FROM devices WHERE workspace = ? AND id = ? AND status = 'active' AND (session IS NULL OR json_extract(session, '$.expires_at') < ?))", [slug, id, now]],
          ),
          change: ([cond, params]) => [q('UPDATE devices SET session = ? WHERE workspace = ? AND id = ? AND ' + cond, JSON.stringify(pointer), slug, id, ...params)],
          result: { takeover: false, session_id: made.sid, ask },
        };
      });
    } catch (e) {
      if (made) await hooks.discardSession(slug, made.sid);
      throw e;
    }
    // A retried change can end up as a take-over, leaving the session made earlier unused.
    if (made && result.session_id !== made.sid) await hooks.discardSession(slug, made.sid);
    let state = 'waiting';
    if (result.takeover) {
      const t = await hooks.takeOver(slug, result.session_id, actor);
      if (!t || t.ok !== true) throw new TeamError(409, 'ended', 'that session has just ended; connect again');
      state = t.state === 'attached' ? 'attached' : 'waiting';
    }
    const rang = await hooks.ring(slug, id);
    return { session_id: result.session_id, state, asks: result.ask, rang };
  }

  // The Session object calls this when a saved-PC session ends. It writes
  // device_session_ended and clears the PC's pointer, guarded on the session id
  // so it never clears a newer session. One change, so a retry after a failure
  // either does both or neither. actor is who ended it, or "relay". driver is who
  // drove the session: when the PC's person said no, or ended it early, they hear of
  // it, unless a task holds the session (then the task raises its own event). A task
  // holds it when the session carries the task's id (openedByTask, which stays true
  // before the task has recorded the sid and after it has ended), or when a running task
  // is attached to it by sid.
  async function sessionEnded(slug, { deviceId, sid, name, reason, actor, driver = null, openedByTask = null }) {
    return mutate(slug, actor, async () => {
      const text = Object.hasOwn(EARLY_ENDS, reason) ? EARLY_ENDS[reason] : null;
      const held = text && driver && !openedByTask ? await q('SELECT 1 AS held FROM agent_tasks WHERE workspace = ? AND sid = ? AND ended_at IS NULL LIMIT 1', slug, sid).first('held') : null;
      const heard = text && driver && !openedByTask && !held ? await notify.rows(slug, 'session_declined', { to: [driver] }, {
        device_id: deviceId, session_id: sid, title: 'Session ended early', body: `${name}: ${text}`, dedupe: `declined:${sid}`,
      }) : [];
      return {
        entries: [{ kind: 'device_session_ended', detail: `${deviceId} ${JSON.stringify(name)} ${sid.slice(0, 8)} ${reason}` }],
        guard: lit(true),
        change: (cond) => [
          ...notify.statements(slug, heard, cond),
          q(`UPDATE devices SET session = NULL WHERE workspace = ? AND id = ? AND json_extract(session, '$.id') = ? AND ${cond[0]}`, slug, deviceId, sid, ...cond[1]),
        ],
        result: { ended: true },
      };
    });
  }

  // The session's first hello fixes its end at 24 hours from then. The pointer
  // held the latest it could be; this tightens it. Unlogged, guarded on the id.
  async function pinSessionEnd(slug, deviceId, sid, expiresAt) {
    await q("UPDATE devices SET session = json_set(session, '$.expires_at', ?) WHERE workspace = ? AND id = ? AND json_extract(session, '$.id') = ?",
      expiresAt, slug, deviceId, sid).run();
  }

  // ---- watching a session, and moving who drives it ---------------------------------------
  // The one rule for watching a session and for becoming its driver (used for a join, the picture, an
  // accept and a claim). `watch` is what the Session's /watch said. The person must
  //   - be a member who holds sessions.control, with the second factor that brings (caps.factor);
  //   - be on a live session of this team: a saved PC's, or a one-off session that has a driver;
  //   - on a saved PC whose pointer says ask:false (the owner was never asked), also hold
  //     sessions.unattended with its second factor;
  //   - to become the driver (driving), find the session attached: only then has the PC let the session in.
  // An invited person's second factor is checked here, when they act, because it belongs to their own
  // sign-in; at invite time only their role is checked (mayInvite).
  // A missing second factor is its own refusal, `second_factor` (as the API says it), not a missing role.
  const factorFor = async (caps, permission) => {
    try {
      await caps.factor?.(permission);
    } catch (e) {
      throw new TeamError(403, 'second_factor', e.message);
    }
  };
  const UNASKED = 'This PC was connected without asking its owner. Only people allowed to connect without asking can join.';
  const LIVE_STATES = ['pending', 'consumed', 'waiting', 'attached'];

  async function sessionRule(slug, personIdentity, sid, watch, caps = {}, { driving = false } = {}) {
    const person = normalizeIdentity(personIdentity);
    if (!LIVE_STATES.includes(watch.state)) throw new TeamError(404, 'not_found', 'no such live session');
    if (!(await holds(slug, person, 'sessions.control'))) throw new TeamError(403, 'cannot_control', 'your role does not allow sessions.control');
    await factorFor(caps, 'sessions.control');
    let pointer = null;
    if (watch.device_id) {
      pointer = await liveSession(slug, watch.device_id);
      if (!pointer || pointer.id !== sid) throw new TeamError(404, 'not_found', 'no such live session');
      if (pointer.ask === false) {
        if (!(await holds(slug, person, UNATTENDED_PERMISSION))) throw new TeamError(403, 'needs_unattended', UNASKED);
        await factorFor(caps, UNATTENDED_PERMISSION);
      }
    } else if (!watch.driver) {
      throw new TeamError(403, 'not_driver', 'this session has no driver, so there is nothing to join');
    }
    if (driving && watch.state !== 'attached') throw new TeamError(409, 'not_attached', 'control moves only once the PC has let the session in');
    return { pointer };
  }

  // The invite checks the target's role only: a person who holds sessions.control (and sessions.unattended
  // on a saved PC that was never asked). Their second factor is checked when they join.
  async function mayInvite(slug, targetIdentity, sid, watch) {
    const target = normalizeIdentity(targetIdentity);
    if (!LIVE_STATES.includes(watch.state)) throw new TeamError(404, 'not_found', 'no such live session');
    // A person is whom the team stored as a person, as people_list says it: the name's shape (an email) is not the test,
    // since a member such as the local dev identity has none.
    const member = await team.getMember(slug, target);
    if (member?.kind !== 'person' || !(await holds(slug, target, 'sessions.control'))) {
      throw new TeamError(403, 'cannot_control', `${target} is not a member who can control sessions`);
    }
    if (watch.device_id) {
      const pointer = await liveSession(slug, watch.device_id);
      if (!pointer || pointer.id !== sid) throw new TeamError(404, 'not_found', 'no such live session');
      if (pointer.ask === false && !(await holds(slug, target, UNATTENDED_PERMISSION))) {
        throw new TeamError(403, 'needs_unattended', `${target} cannot join: this PC was connected without asking its owner, and they may not connect without asking`);
      }
    }
  }

  // Move the driver of a live session to the caller. One guarded change: the caller still holds
  // sessions.control (and sessions.unattended when the rule asks for it), the workspace is not stopped,
  // and on a saved PC the pointer is the session's and still names `from` as its driver, so the claim
  // of a take-over that landed first fails and the caller is told who drives now (not_driver). Any
  // queue item the move is part of goes in the same batch (extra: { check(), entries, guard, statements(proof) };
  // check runs on every attempt and throws a refusal when the item is no longer free), so the item is
  // claimed exactly when control moves.
  //
  // kind: accept (an offer), claim (a queue item) or take_over (an admin, on a one-off session). A
  // saved PC's take-over is device_connect. Returns { moved }; moved is false when the PC's record
  // already names the caller, which is what a retry after a failed session step finds.
  async function handOver(slug, actorIdentity, { sid, deviceId = null, from = null, kind, extra = null }, caps = {}) {
    if (!['accept', 'claim', 'take_over'].includes(kind) || (kind === 'take_over' && deviceId)) throw new TypeError('bad handover kind');
    const actor = normalizeIdentity(actorIdentity);
    const was = normalizeIdentity(from);
    return mutate(slug, actor, async () => {
      const ctx = await actorContext(slug, actor, 'sessions.control');
      if ((await team.stopState(slug)).stopped) throw new TeamError(409, 'stopped', STOPPED_MESSAGE);
      await extra?.check?.();
      let pointer = null;
      let name = '';
      if (deviceId) {
        const cur = await q('SELECT * FROM devices WHERE workspace = ? AND id = ?', slug, deviceId).first();
        pointer = cur && cur.status === 'active' ? livePointer(cur) : null;
        if (!pointer || pointer.id !== sid) throw new TeamError(404, 'not_found', 'that session is no longer live on the PC');
        if (pointer.by === actor) return { noop: true, result: { moved: false } };
        if (pointer.by !== was) throw new TeamError(403, 'not_driver', `${pointer.by} is driving this session`);
        name = cur.name;
        if (pointer.ask === false) {
          if (!(await holds(slug, actor, UNATTENDED_PERMISSION))) throw new TeamError(403, 'needs_unattended', UNASKED);
          await factorFor(caps, UNATTENDED_PERMISSION);
        }
      }
      if (kind === 'take_over') {
        if (!(await holds(slug, actor, UNATTENDED_PERMISSION))) throw new TeamError(403, 'needs_unattended', `taking over needs ${UNATTENDED_PERMISSION}. Ask the driver to offer control instead.`);
        await factorFor(caps, UNATTENDED_PERMISSION);
      }
      const detail = deviceId ? `${deviceId} ${JSON.stringify(name)} from ${pointer.by} to ${actor}` : `${sid.slice(0, 8)}${was ? ` from ${was}` : ''} to ${actor}`;
      const proof = deviceId
        ? ["EXISTS (SELECT 1 FROM devices WHERE workspace = ? AND id = ? AND json_extract(session, '$.id') = ? AND json_extract(session, '$.by') = ?)", [slug, deviceId, sid, actor]]
        : null;
      return {
        entries: [...(extra?.entries ?? []), { kind: deviceId ? 'device_session_handed_over' : kind === 'take_over' ? 'session_taken_over' : 'session_handed_over', detail }],
        guard: and(
          actorHas(slug, actor, 'sessions.control'),
          actorUnchanged(slug, ctx),
          notStopped(slug),
          deviceId
            ? ["EXISTS (SELECT 1 FROM devices WHERE workspace = ? AND id = ? AND status = 'active' AND json_extract(session, '$.id') = ? AND json_extract(session, '$.by') = ? AND json_extract(session, '$.expires_at') > ? AND json_extract(session, '$.ask') IS ?)",
              [slug, deviceId, sid, pointer.by, Date.now(), pointer.ask === false ? 0 : pointer.ask === true ? 1 : null]]
            : lit(true),
          pointer?.ask === false || kind === 'take_over' ? actorHas(slug, actor, UNATTENDED_PERMISSION) : lit(true),
          extra?.guard ?? lit(true),
        ),
        // The PC's pointer moves first. What reads the guard comes after it only on the proof that it moved:
        // the guard itself no longer holds once the pointer names the caller.
        change: (cond) => [
          ...(deviceId ? [q(`UPDATE devices SET session = json_set(session, '$.by', ?) WHERE workspace = ? AND id = ? AND ${cond[0]}`, actor, slug, deviceId, ...cond[1])] : []),
          ...(extra ? extra.statements(proof ?? cond) : []),
        ],
        result: { moved: true },
      };
    });
  }

  return {
    sessionRule, mayInvite, handOver,
    connect, sessionEnded, pinSessionEnd,
    listRecords, getRecord, addRecord, updateRecord, removeRecord,
    listFields, addField, updateField, removeField,
    listDevices, getDevice, liveSession, updateDevice, removeDevice,
    createPairingCode, listPairingCodes, revokePairingCode,
    redeemCode, requestJoin, authenticate, checkIn, checkInFull, updateOwn, leave,
  };
}

// The device store for this deployment, from the Worker env.
// opts.devTtlMs is the dev session-length override of the MCP address that called.
export const devicesFromEnv = (env, team = teamFromEnv(env), { devTtlMs = 0 } = {}) =>
  deviceStore(env.DB, team, { authSecret: env.AUTH_SECRET, hooks: deviceHooks(env, { devTtlMs }) });
