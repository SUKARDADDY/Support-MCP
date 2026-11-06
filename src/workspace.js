// Team data in the shared D1 database: members, roles, recent callers and the
// chained team log. Every query the relay runs on team data is in this file,
// except the customers, sites, devices, custom fields and pairing codes, which
// are in src/devices.js and use this store's guarded change (mutate) so their
// log rows commit with them.
// Every store method takes the workspace slug first, and every query filters by
// it, so one workspace never reads another's rows.
//
// "default" always exists and is never a row in `workspaces`. It is the only
// workspace with an open mode (no members yet: any caller admitted holds the
// sessions.* permissions, and the first admin adds themselves). Any other
// workspace is created with its first admin in one batch, and if it ever has
// no members it is closed: nobody holds any permission.
//
// A change is: read the log head, check the rules, compute the next log row,
// then one DB.batch([log insert, change]). The log insert carries the rule
// check in its WHERE clause, and the change runs only if that log row went in,
// so the check, the change and its log row commit together or not at all. Two
// writers that read the same head collide on PRIMARY KEY(workspace, seq), the
// loser's batch rolls back, and it retries from a fresh read.
import {
  ADMIN_ROLE, BUILTIN_ROLES, OPEN_PERMISSIONS, PERMISSIONS, ROLE_ID_RE, isBuiltinRole, isPermission, normalizePermissions,
} from './permissions.js';

export const DEFAULT_WORKSPACE = 'default';
export const GENESIS_HASH = '0'.repeat(64);
const SLUG_RE = /^[a-z0-9-]{1,40}$/;
// The most workspaces (besides default) one server holds. OAuth lists every
// workspace address pairwise, so the count is capped at creation.
export const MAX_WORKSPACES = 500;
const DEFAULT_NAME = 'Default';
const MAX_RETRIES = 5;
const RECENT_CALLERS = 50;
// An open-mode caller's last_seen is written at most this often.
const CALLER_REFRESH_MS = 60_000;
const IDENTITY_MAX = 200;
const NAME_MAX = 100;
const BAD_CHARS = /[\s\u0000-\u001f\u007f]/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

// A refusal the team API turns into {error:{code,message}} with this status.
export class TeamError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Identities are compared trimmed and lowercased everywhere.
export const normalizeIdentity = (v) => String(v ?? '').trim().toLowerCase();
// A person signs in with an email. A service token's identity is its client id.
export const identityKind = (identity) => (identity.includes('@') ? 'person' : 'service');

export function parseDeploymentAdmins(value) {
  return new Set(String(value ?? '').split(',').map(normalizeIdentity).filter(Boolean));
}

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// hash = hex SHA-256 of prev_hash \n seq \n ts \n actor \n kind \n detail.
export function chainHash({ prev_hash, seq, ts, actor, kind, detail }) {
  return sha256Hex([prev_hash, seq, ts, actor, kind, detail].join('\n'));
}

// D1 reports a constraint failure in the error text, which carries SQLite's own
// message, for example "D1_ERROR: UNIQUE constraint failed: audit.workspace,
// audit.seq: SQLITE_CONSTRAINT". The wording can change, so mutate() also checks
// whether the log head moved. Only the log's key can collide: every other write
// is guarded.
const errorText = (e) => `${e && e.message} ${e && e.cause && e.cause.message}`;
const looksLikeLogConflict = (e) => {
  const text = errorText(e);
  return /UNIQUE/i.test(text) || (/SQLITE_CONSTRAINT/.test(text) && /audit/i.test(text));
};

const backoff = (attempt) => new Promise((r) => setTimeout(r, Math.random() * 20 * 2 ** attempt));

function checkSlug(slug) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) throw new TypeError('workspace slug required');
}

function validIdentity(v) {
  const id = normalizeIdentity(v);
  if (!id || id.length > IDENTITY_MAX || BAD_CHARS.test(id)) {
    throw new TeamError(400, 'bad_request', `identity must be an email or a service token client id, at most ${IDENTITY_MAX} characters, no spaces`);
  }
  return id;
}

function validName(v, field = 'name') {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || v.trim().length > NAME_MAX || CONTROL_CHARS.test(v)) {
    throw new TeamError(400, 'bad_request', `${field} must be text of at most ${NAME_MAX} characters`);
  }
  return v.trim() || null;
}

function validRoleId(v) {
  if (typeof v !== 'string' || !ROLE_ID_RE.test(v)) {
    throw new TeamError(400, 'bad_request', 'role id must be 1 to 40 characters of a-z, 0-9 and -');
  }
  return v;
}

function validPermissions(v) {
  try {
    return normalizePermissions(v);
  } catch (e) {
    throw new TeamError(400, 'bad_request', e.message);
  }
}

// The store for one D1 database. opts.deploymentAdmins is DEPLOYMENT_ADMINS:
// when set, only those identities may add the default workspace's first member.
// Only those identities may create a workspace, and with none named nobody may.
export function teamStore(db, { deploymentAdmins = '' } = {}) {
  if (!db || typeof db.prepare !== 'function') throw new TeamError(503, 'no_database', 'the team database (DB) is not configured');
  const admins = parseDeploymentAdmins(deploymentAdmins);
  const q = (sql, ...params) => db.prepare(sql).bind(...params);

  // ---- SQL fragments, each a [sql, params] pair ------------------------------
  const noMembers = (slug) => ['NOT EXISTS (SELECT 1 FROM members WHERE workspace = ?)', [slug]];

  // The actor is a member whose current role holds `permission`.
  function actorHas(slug, actor, permission) {
    const builtins = Object.keys(BUILTIN_ROLES).filter((id) => id !== ADMIN_ROLE && BUILTIN_ROLES[id].permissions.includes(permission));
    const builtinSql = builtins.length ? ` OR (r.role_id IS NULL AND m.role_id IN (${builtins.map(() => '?').join(', ')}))` : '';
    return [
      `EXISTS (SELECT 1 FROM members m LEFT JOIN roles r ON r.workspace = m.workspace AND r.role_id = m.role_id
        WHERE m.workspace = ? AND m.identity = ? AND (m.role_id = ?
          OR (r.role_id IS NOT NULL AND r.deleted = 0 AND EXISTS (SELECT 1 FROM json_each(r.permissions) WHERE json_each.value = ?))${builtinSql}))`,
      [slug, actor, ADMIN_ROLE, permission, ...builtins],
    ];
  }

  // The actor is still in the role, with the permissions, that the plan read.
  // Together with the plan's check, this makes "the actor holds only what they
  // hand out" hold at commit time, not only at read time.
  function actorUnchanged(slug, ctx) {
    return and(
      ['EXISTS (SELECT 1 FROM members WHERE workspace = ? AND identity = ? AND role_id = ?)', [slug, ctx.identity, ctx.role_id]],
      roleIsAsRead(slug, ctx.role_id, ctx.permissions),
    );
  }

  // The role still has the permissions the plan read. admin is fixed.
  function roleIsAsRead(slug, roleId, perms) {
    if (roleId === ADMIN_ROLE) return ['1', []];
    const stored = ['EXISTS (SELECT 1 FROM roles WHERE workspace = ? AND role_id = ? AND deleted = 0 AND permissions = ?)', [slug, roleId, JSON.stringify(perms)]];
    if (!isBuiltinRole(roleId)) return stored;
    return or(['NOT EXISTS (SELECT 1 FROM roles WHERE workspace = ? AND role_id = ?)', [slug, roleId]], stored);
  }

  // The member's role, as the plan read it: with these permissions, or (perms
  // null) still gone.
  function memberRoleAsRead(slug, roleId, perms) {
    if (perms) return roleIsAsRead(slug, roleId, perms);
    if (isBuiltinRole(roleId)) return ['EXISTS (SELECT 1 FROM roles WHERE workspace = ? AND role_id = ? AND deleted = 1)', [slug, roleId]];
    return ['NOT EXISTS (SELECT 1 FROM roles WHERE workspace = ? AND role_id = ? AND deleted = 0)', [slug, roleId]];
  }

  function roleExists(slug, roleId) {
    if (roleId === ADMIN_ROLE) return ['1', []];
    if (isBuiltinRole(roleId)) return ['NOT EXISTS (SELECT 1 FROM roles WHERE workspace = ? AND role_id = ? AND deleted = 1)', [slug, roleId]];
    return ['EXISTS (SELECT 1 FROM roles WHERE workspace = ? AND role_id = ? AND deleted = 0)', [slug, roleId]];
  }

  const not = ([sql, p]) => [`NOT (${sql})`, p];
  const lit = (bool) => [bool ? '1' : '0', []];
  function join(op, parts) {
    return [parts.map(([sql]) => `(${sql})`).join(` ${op} `), parts.flatMap(([, p]) => p)];
  }
  const and = (...parts) => join('AND', parts);
  const or = (...parts) => join('OR', parts);
  const logRowIs = (slug, row) => ['EXISTS (SELECT 1 FROM audit WHERE workspace = ? AND seq = ? AND hash = ?)', [slug, row.seq, row.hash]];

  // ---- reads -----------------------------------------------------------------
  async function head(slug) {
    const row = await q('SELECT seq, hash FROM audit WHERE workspace = ? ORDER BY seq DESC LIMIT 1', slug).first();
    return row ? { seq: row.seq, hash: row.hash } : { seq: 0, hash: GENESIS_HASH };
  }

  // Has the log head moved since `seen`? A head that can't be read counts as
  // not moved, so the batch's own error is the one that surfaces.
  async function headMoved(slug, seen, original) {
    try {
      const now = await head(slug);
      return now.seq !== seen.seq || now.hash !== seen.hash;
    } catch (_) {
      throw original;
    }
  }

  async function memberCount(slug) {
    return (await q('SELECT COUNT(*) AS n FROM members WHERE workspace = ?', slug).first('n')) || 0;
  }

  async function adminCount(slug) {
    return (await q('SELECT COUNT(*) AS n FROM members WHERE workspace = ? AND role_id = ?', slug, ADMIN_ROLE).first('n')) || 0;
  }

  async function getMember(slug, identity) {
    checkSlug(slug);
    const row = await q('SELECT identity, kind, name, role_id, added_at, added_by FROM members WHERE workspace = ? AND identity = ?',
      slug, normalizeIdentity(identity)).first();
    return row ? { ...row } : null;
  }

  async function listMembers(slug) {
    checkSlug(slug);
    const { results } = await q('SELECT identity, kind, name, role_id, added_at, added_by FROM members WHERE workspace = ? ORDER BY added_at, identity', slug).all();
    return results.map((r) => ({ ...r }));
  }

  // Built-in roles with this workspace's edits, then its custom roles.
  async function listRoles(slug) {
    checkSlug(slug);
    const { results } = await q('SELECT role_id, name, permissions, deleted FROM roles WHERE workspace = ? ORDER BY role_id', slug).all();
    const stored = new Map(results.map((r) => [r.role_id, r]));
    const out = [];
    for (const [id, def] of Object.entries(BUILTIN_ROLES)) {
      const row = id === ADMIN_ROLE ? null : stored.get(id);
      if (row?.deleted) continue;
      out.push({
        id, name: row ? row.name : def.name, permissions: row ? JSON.parse(row.permissions) : [...def.permissions],
        builtin: true, editable: id !== ADMIN_ROLE,
      });
    }
    for (const row of results) {
      if (isBuiltinRole(row.role_id) || row.deleted) continue;
      out.push({ id: row.role_id, name: row.name, permissions: JSON.parse(row.permissions), builtin: false, editable: true });
    }
    return out;
  }

  async function getRole(slug, roleId) {
    return (await listRoles(slug)).find((r) => r.id === roleId) || null;
  }

  async function permissionsOf(slug, roleId) {
    if (roleId === ADMIN_ROLE) return [...PERMISSIONS];
    return (await getRole(slug, roleId))?.permissions ?? [];
  }

  // Recorded only while the workspace has no members. A new caller is inserted;
  // a known one is touched only when its last_seen is over a minute old, so a
  // busy MCP client does not write on every tool call.
  async function recordCaller(slug, identity) {
    await q(`INSERT INTO callers(workspace, identity, last_seen) SELECT ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM members WHERE workspace = ?)
      ON CONFLICT(workspace, identity) DO UPDATE SET last_seen = excluded.last_seen
        WHERE callers.last_seen < excluded.last_seen - ?`, slug, identity, Date.now(), slug, CALLER_REFRESH_MS).run();
  }

  async function recentCallers(slug) {
    checkSlug(slug);
    const { results } = await q('SELECT identity, last_seen FROM callers WHERE workspace = ? ORDER BY last_seen DESC, identity LIMIT ?', slug, RECENT_CALLERS).all();
    return results.map((r) => ({ ...r, kind: identityKind(r.identity) }));
  }

  // Is `identity` allowed `permission` in this workspace? Given only the
  // permission key, never a tool's arguments. While default is open, a
  // caller holds the sessions.* permissions and nothing that changes the team
  // (reason 'open').
  //
  // `membersOnly` is for a caller that must never use open mode (an OAuth
  // token): while default has no members it answers not_member, and it does not
  // record the caller.
  async function authorize(slug, identity, permission, { membersOnly = false } = {}) {
    checkSlug(slug);
    if (!isPermission(permission)) throw new TypeError('authorize takes a permission key');
    const id = normalizeIdentity(identity);
    const row = await q(`SELECT (SELECT role_id FROM members WHERE workspace = ? AND identity = ?) AS role_id,
      EXISTS (SELECT 1 FROM members WHERE workspace = ?) AS any_member`, slug, id, slug).first();
    if (!row.any_member) {
      // Only default is ever open. Any other workspace with no members is closed.
      if (slug !== DEFAULT_WORKSPACE || membersOnly) return { ok: false, open: false, role_id: null, reason: 'not_member' };
      if (!OPEN_PERMISSIONS.includes(permission)) return { ok: false, open: true, role_id: null, reason: 'open' };
      await recordCaller(slug, id);
      return { ok: true, open: true, role_id: null };
    }
    if (row.role_id === null || row.role_id === undefined) return { ok: false, open: false, role_id: null, reason: 'not_member' };
    const ok = (await permissionsOf(slug, row.role_id)).includes(permission);
    return ok ? { ok, open: false, role_id: row.role_id } : { ok, open: false, role_id: row.role_id, reason: 'permission' };
  }

  // The caller's place in the workspace: open (default with no members yet, the
  // sessions.* permissions only), or a member's role and permissions, or not a
  // member (role_id null, no permissions). A created workspace is never open.
  async function whoami(slug, identity) {
    checkSlug(slug);
    const id = normalizeIdentity(identity);
    if ((await memberCount(slug)) === 0) {
      if (slug !== DEFAULT_WORKSPACE) return { identity: id, open: false, member: false, role_id: null, permissions: [] };
      await recordCaller(slug, id);
      return { identity: id, open: true, member: false, role_id: null, permissions: [...OPEN_PERMISSIONS] };
    }
    const m = await getMember(slug, id);
    if (!m) return { identity: id, open: false, member: false, role_id: null, permissions: [] };
    return { identity: id, open: false, member: true, role_id: m.role_id, permissions: await permissionsOf(slug, m.role_id) };
  }

  // ---- workspaces ------------------------------------------------------------
  // default always exists. Any other slug exists once it has been created.
  async function workspaceExists(slug) {
    if (slug === DEFAULT_WORKSPACE) return true;
    if (typeof slug !== 'string' || !SLUG_RE.test(slug)) return false;
    return (await q('SELECT 1 AS found FROM workspaces WHERE slug = ?', slug).first('found')) === 1;
  }

  // Every created workspace's slug (never default, which is not a row). The
  // OAuth server builds its list of MCP addresses from this, and the library
  // checks that list pairwise, so creation stops at MAX_WORKSPACES and this
  // list is never cut short.
  async function workspaceSlugs() {
    const { results } = await q('SELECT slug FROM workspaces ORDER BY slug LIMIT ?', MAX_WORKSPACES).all();
    return results.map((r) => r.slug);
  }

  // The workspaces this identity is a member of, by slug, and default first
  // when it is open (role_id null, as in whoami) or the caller is a member of it.
  async function listWorkspaces(identity) {
    const id = normalizeIdentity(identity);
    const { results } = await q(`SELECT w.slug, w.name, m.role_id FROM members m JOIN workspaces w ON w.slug = m.workspace
      WHERE m.identity = ? ORDER BY w.slug`, id).all();
    const out = results.map((r) => ({ slug: r.slug, name: r.name, role_id: r.role_id }));
    const d = await q(`SELECT (SELECT role_id FROM members WHERE workspace = ? AND identity = ?) AS role_id,
      EXISTS (SELECT 1 FROM members WHERE workspace = ?) AS any_member`, DEFAULT_WORKSPACE, id, DEFAULT_WORKSPACE).first();
    if (!d.any_member) out.unshift({ slug: DEFAULT_WORKSPACE, name: DEFAULT_NAME, role_id: null });
    else if (d.role_id !== null && d.role_id !== undefined) out.unshift({ slug: DEFAULT_WORKSPACE, name: DEFAULT_NAME, role_id: d.role_id });
    return out;
  }

  // ---- sign-in -----------------------------------------------------------------
  // Who may sign in as themselves in a browser: a deployment admin, or a person
  // who is a member of any workspace. Read live on every check, so removing the
  // last membership ends a sign-in on its next request. Open mode does not
  // count: nobody is invited to a workspace that has no members.
  const isDeploymentAdmin = (identity) => admins.has(normalizeIdentity(identity));

  async function isInvited(identity) {
    const id = normalizeIdentity(identity);
    if (!id) return false;
    if (admins.has(id)) return true;
    return (await q("SELECT 1 AS found FROM members WHERE identity = ? AND kind = 'person' LIMIT 1", id).first('found')) === 1;
  }

  // The workspaces this person is really a member of (never the open default),
  // each with the role's name and current permissions.
  async function memberships(identity) {
    const id = normalizeIdentity(identity);
    const { results } = await q(`SELECT m.workspace AS slug, w.name AS name, m.role_id AS role_id
      FROM members m LEFT JOIN workspaces w ON w.slug = m.workspace WHERE m.identity = ? ORDER BY m.workspace`, id).all();
    const out = [];
    for (const r of results) {
      const role = await getRole(r.slug, r.role_id);
      out.push({
        slug: r.slug,
        name: r.slug === DEFAULT_WORKSPACE ? DEFAULT_NAME : r.name,
        role_id: r.role_id,
        role_name: role ? role.name : null,
        permissions: role ? role.permissions : [],
      });
    }
    return out;
  }

  // ---- the log ---------------------------------------------------------------
  // A page read checks only the rows it returns: each row's hash, each prev_hash
  // link, the first row against the row just before it (or the genesis hash when
  // it is row 1), and the last row against the row just after it. It reads at
  // most limit + 2 rows (that row before, the page, that row after), plus the
  // head. Only the newest row of the log has no row after it, so a reseal of
  // that row alone passes a page check; the head catches it. `full` returns the
  // page rows only and runs verifyAudit over the whole chain instead.
  async function readAudit(slug, { after = 0, limit = 100, full = false } = {}) {
    checkSlug(slug);
    const cols = 'seq, ts, actor, kind, detail, prev_hash, hash';
    if (full) {
      const { results } = await q(`SELECT ${cols} FROM audit WHERE workspace = ? AND seq > ? ORDER BY seq LIMIT ?`, slug, after, limit).all();
      const v = await verifyAudit(slug);
      return { rows: results.map((r) => ({ ...r })), head: v.head, verified: v.ok, verified_scope: 'full' };
    }
    // From the row numbered `after` (the anchor, when it exists) to one past the page.
    const { results } = await q(`SELECT ${cols} FROM audit WHERE workspace = ? AND seq >= ? ORDER BY seq LIMIT ?`,
      slug, after, limit + (after > 0 ? 2 : 1)).all();
    const past = results.filter((r) => r.seq > after);
    const rows = past.slice(0, limit).map((r) => ({ ...r }));
    const anchor = rows.length ? results.find((r) => r.seq === rows[0].seq - 1) : undefined;
    return { rows, head: await head(slug), verified: await verifyPage(rows, anchor, past[limit]), verified_scope: 'page' };
  }

  // Numbers run on with no gap, each row seals the one before it, each hash
  // matches its row, and the row after the page (when there is one) seals the
  // last row. An empty page has nothing to fail.
  async function verifyPage(rows, anchor, next) {
    if (!rows.length) return true;
    let prev;
    if (rows[0].seq === 1) prev = GENESIS_HASH;
    else if (anchor) prev = anchor.hash;
    else return false;
    let seq = rows[0].seq - 1;
    for (const r of rows) {
      if (r.seq !== seq + 1 || r.prev_hash !== prev || (await chainHash(r)) !== r.hash) return false;
      seq = r.seq;
      prev = r.hash;
    }
    return !next || (next.seq === seq + 1 && next.prev_hash === prev);
  }

  // Recompute the whole chain: numbers 1, 2, 3 ... with no gap, each row sealing
  // the one before it, each hash matching its row.
  async function verifyAudit(slug) {
    checkSlug(slug);
    const { results } = await q('SELECT seq, ts, actor, kind, detail, prev_hash, hash FROM audit WHERE workspace = ? ORDER BY seq', slug).all();
    let prev = GENESIS_HASH;
    let bad = null;
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.seq !== i + 1 || r.prev_hash !== prev || (await chainHash(r)) !== r.hash) { bad = r.seq; break; }
      prev = r.hash;
    }
    const last = results.at(-1);
    return { ok: bad === null, bad_seq: bad, head: last ? { seq: last.seq, hash: last.hash } : { seq: 0, hash: GENESIS_HASH } };
  }

  // One change. plan() reads the state and throws a TeamError when a rule
  // fails. Otherwise it returns { entries: [{kind, detail}], guard, change, result },
  // or { noop: true, result } when nothing would change. guard is the same rules
  // as SQL, on the first log insert. change([cond, params]) returns the
  // statements that make the change, each limited by cond: the guard, and the
  // first log row having gone in.
  async function mutate(slug, actor, plan) {
    checkSlug(slug);
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt) await backoff(attempt);
      const h = await head(slug);
      const p = await plan();
      if (p.noop) return p.result;
      const rows = [];
      let prev = h;
      for (const { kind, detail } of p.entries) {
        const row = { seq: prev.seq + 1, ts: Date.now(), actor, kind, detail, prev_hash: prev.hash };
        row.hash = await chainHash(row);
        rows.push(row);
        prev = row;
      }
      const insert = (row, [cond, params]) => q(
        `INSERT INTO audit(workspace, seq, ts, actor, kind, detail, prev_hash, hash) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${cond}`,
        slug, row.seq, row.ts, row.actor, row.kind, row.detail, row.prev_hash, row.hash, ...params,
      );
      const gate = logRowIs(slug, rows[0]);
      const statements = [insert(rows[0], p.guard), ...rows.slice(1).map((r) => insert(r, gate)), ...p.change(and(p.guard, gate))];
      let results;
      try {
        results = await db.batch(statements);
      } catch (e) {
        // Lost the log number to another writer: start again from a fresh read.
        // That is a UNIQUE failure on audit, or any failure after which the log
        // head is not the one this attempt read. Anything else is a real error.
        if (looksLikeLogConflict(e) || (await headMoved(slug, h, e))) continue;
        throw e;
      }
      // The guard held: the log row and the change went in together.
      if (results[0].meta.changes === 1) return p.result;
      // The state changed between the read and the batch. Read again.
    }
    throw new TeamError(503, 'busy', 'the team is being changed by someone else; try again');
  }

  // The actor's role, read for a team change. Throws unless the actor is a
  // member whose role holds `permission`. While default is open nothing
  // that changes the team is allowed except adding the first member, which
  // does not come through here. A created workspace with no members is closed.
  async function actorContext(slug, actor, permission) {
    if ((await memberCount(slug)) === 0) {
      if (slug !== DEFAULT_WORKSPACE) throw new TeamError(403, 'not_member', 'you are not a member of this team');
      throw new TeamError(409, 'first_member', 'add yourself as the first admin before changing the team');
    }
    const m = await getMember(slug, actor);
    if (!m) throw new TeamError(403, 'not_member', 'you are not a member of this team');
    const permissions = await permissionsOf(slug, m.role_id);
    if (!permissions.includes(permission)) throw new TeamError(403, 'permission_denied', `your role does not allow ${permission}`);
    return { identity: actor, role_id: m.role_id, permissions, admin: m.role_id === ADMIN_ROLE };
  }

  // The escalation rules. Only an admin deals in the admin role. Anyone else
  // hands out only permissions they hold themselves.
  const forbidden = (message) => new TeamError(403, 'forbidden', message);
  const roleMissing = () => new TeamError(409, 'role_missing', 'that member has a role that no longer exists; give them a role first');
  function requireAdmin(ctx, message) {
    if (!ctx.admin) throw forbidden(message);
  }
  function requireWithin(ctx, perms, message) {
    if (ctx.admin) return;
    const lacking = perms.filter((p) => !ctx.permissions.includes(p));
    if (lacking.length) throw forbidden(`${message}: you do not hold ${lacking.join(', ')}`);
  }

  // A non-admin acts on a member only if that member's role holds nothing the
  // actor lacks. The admin role holds every permission, so it is an admin-only
  // target even for a custom role that holds them all.
  function requireMemberWithin(ctx, member, perms, verb) {
    if (ctx.admin) return;
    if (member.role_id === ADMIN_ROLE || perms.some((p) => !ctx.permissions.includes(p))) {
      throw forbidden(`you can only ${verb} members whose role is within your own permissions`);
    }
  }

  // ---- members ---------------------------------------------------------------
  // Team-change rules, enforced here in the plan and again in each guard's SQL:
  //  - Only an admin adds a member as admin, moves anyone to or from admin, or
  //    removes an admin.
  //  - Anyone else gives only roles whose permissions they hold themselves, and
  //    can't create or edit a role to hold more than they do.
  //  - Anyone else changes (any field), demotes or removes only members whose
  //    role holds no permission they lack. That covers every admin.
  //  - Anyone else edits (any field) or deletes only a role whose current
  //    permissions they hold.
  //  - A member whose role is gone can be given a role that exists, or removed
  //    by an admin; any other change is 409 role_missing.
  //  - Nobody changes their own role or edits or deletes the role they hold. An
  //    admin may demote themselves, but only while another admin remains.
  async function addMember(slug, actorIdentity, body) {
    checkSlug(slug);
    const actor = normalizeIdentity(actorIdentity);
    const identity = validIdentity(body?.identity);
    const name = validName(body?.name);
    const roleId = validRoleId(body?.role_id);
    return mutate(slug, actor, async () => {
      const count = await memberCount(slug);
      // Only default is ever open. A created workspace starts with its admin,
      // so one with no members is closed and nobody can add to it.
      if (count === 0 && slug !== DEFAULT_WORKSPACE) throw new TeamError(403, 'not_member', 'you are not a member of this team');
      // The first member turns roles on: it must be the caller, as admin, and
      // a deployment admin when DEPLOYMENT_ADMINS is set.
      const firstOk = count === 0 && identity === actor && roleId === ADMIN_ROLE && (admins.size === 0 || admins.has(actor));
      let ctx = null;
      if (count === 0) {
        if (identity !== actor || roleId !== ADMIN_ROLE) {
          throw new TeamError(409, 'first_member', 'the first member must be you, as admin');
        }
        if (!firstOk) throw new TeamError(409, 'first_member', 'only an identity in DEPLOYMENT_ADMINS can add the first member');
      } else {
        ctx = await actorContext(slug, actor, 'members.manage');
      }
      if (await getMember(slug, identity)) throw new TeamError(409, 'member_exists', `${identity} is already a member`);
      const role = await getRole(slug, roleId);
      if (!role) throw new TeamError(400, 'unknown_role', `no role ${roleId}`);
      if (ctx) {
        if (roleId === ADMIN_ROLE) requireAdmin(ctx, 'only an admin can add a member as admin');
        else requireWithin(ctx, role.permissions, `you can only give a role whose permissions you hold (${roleId})`);
      }
      const member = { identity, kind: identityKind(identity), name, role_id: roleId, added_at: Date.now(), added_by: actor };
      const byMember = ctx && and(
        actorHas(slug, actor, 'members.manage'),
        actorUnchanged(slug, ctx),
        ctx.admin ? lit(true) : roleIsAsRead(slug, roleId, role.permissions),
      );
      return {
        entries: [
          { kind: 'member_added', detail: `${identity} as ${roleId}` },
          ...(count === 0 ? [{ kind: 'roles_turned_on', detail: `first admin ${identity}` }] : []),
        ],
        guard: and(
          or(and(noMembers(slug), lit(firstOk)), byMember || lit(false)),
          ['NOT EXISTS (SELECT 1 FROM members WHERE workspace = ? AND identity = ?)', [slug, identity]],
          roleExists(slug, roleId),
        ),
        change: ([cond, params]) => [q(
          `INSERT INTO members(workspace, identity, kind, name, role_id, added_at, added_by) SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${cond}`,
          slug, member.identity, member.kind, member.name, member.role_id, member.added_at, member.added_by, ...params,
        )],
        result: member,
      };
    });
  }

  // Keeps at least one admin: demoting or removing an admin needs another one.
  const anotherAdmin = (slug, identity) => [
    '(SELECT COUNT(*) FROM members WHERE workspace = ? AND role_id = ? AND identity <> ?) >= 1', [slug, ADMIN_ROLE, identity],
  ];

  async function updateMember(slug, actorIdentity, memberIdentity, body) {
    checkSlug(slug);
    const actor = normalizeIdentity(actorIdentity);
    const identity = normalizeIdentity(memberIdentity);
    const hasName = body && Object.hasOwn(body, 'name');
    const hasRole = body && Object.hasOwn(body, 'role_id');
    if (!hasName && !hasRole) throw new TeamError(400, 'bad_request', 'send name or role_id');
    const name = hasName ? validName(body.name) : undefined;
    const roleId = hasRole ? validRoleId(body.role_id) : undefined;
    return mutate(slug, actor, async () => {
      const ctx = await actorContext(slug, actor, 'members.manage');
      const m = await getMember(slug, identity);
      if (!m) throw new TeamError(404, 'not_found', `${identity} is not a member`);
      const next = { ...m, ...(hasName ? { name } : {}), ...(hasRole ? { role_id: roleId } : {}) };
      if (next.name === m.name && next.role_id === m.role_id) return { noop: true, result: m };
      const roleChanges = next.role_id !== m.role_id;
      const current = await getRole(slug, m.role_id);
      // A member whose role is gone can only be given a role that exists.
      if (!current && !roleChanges) throw roleMissing();
      const nextRole = await getRole(slug, next.role_id);
      if (!nextRole) throw new TeamError(400, 'unknown_role', `no role ${next.role_id}`);
      const demotes = m.role_id === ADMIN_ROLE && roleChanges;
      if (roleChanges) {
        if (identity === actor && !ctx.admin) throw forbidden('you cannot change your own role');
        if (m.role_id === ADMIN_ROLE) requireAdmin(ctx, 'only an admin can change the role of an admin');
        else if (next.role_id === ADMIN_ROLE) requireAdmin(ctx, 'only an admin can give the admin role');
        else requireWithin(ctx, nextRole.permissions, `you can only give a role whose permissions you hold (${next.role_id})`);
      }
      const targetPerms = current ? current.permissions : [];
      requireMemberWithin(ctx, m, targetPerms, 'change');
      if (demotes && (await adminCount(slug)) <= 1) throw new TeamError(409, 'last_admin', 'the team needs at least one admin');
      const changes = [];
      if (roleChanges) changes.push(`role ${m.role_id} to ${next.role_id}`);
      if (next.name !== m.name) changes.push(`name ${JSON.stringify(next.name)}`);
      return {
        entries: [{ kind: 'member_changed', detail: `${identity} ${changes.join(', ')}` }],
        guard: and(
          actorHas(slug, actor, 'members.manage'),
          ['EXISTS (SELECT 1 FROM members WHERE workspace = ? AND identity = ? AND role_id = ? AND name IS ?)', [slug, identity, m.role_id, m.name]],
          roleExists(slug, next.role_id),
          actorUnchanged(slug, ctx),
          // The member keeps the role, with the permissions, that the plan read.
          ctx.admin ? lit(true) : memberRoleAsRead(slug, m.role_id, current && targetPerms),
          roleChanges && !ctx.admin ? roleIsAsRead(slug, next.role_id, nextRole.permissions) : lit(true),
          demotes ? anotherAdmin(slug, identity) : lit(true),
        ),
        change: ([cond, params]) => [q(
          `UPDATE members SET name = ?, role_id = ? WHERE workspace = ? AND identity = ? AND ${cond}`,
          next.name, next.role_id, slug, identity, ...params,
        )],
        result: next,
      };
    });
  }

  async function removeMember(slug, actorIdentity, memberIdentity) {
    checkSlug(slug);
    const actor = normalizeIdentity(actorIdentity);
    const identity = normalizeIdentity(memberIdentity);
    return mutate(slug, actor, async () => {
      const ctx = await actorContext(slug, actor, 'members.manage');
      const m = await getMember(slug, identity);
      if (!m) throw new TeamError(404, 'not_found', `${identity} is not a member`);
      const admin = m.role_id === ADMIN_ROLE;
      if (admin) requireAdmin(ctx, 'only an admin can remove an admin');
      const current = await getRole(slug, m.role_id);
      // An admin can still remove a member whose role is gone; anyone else gives one a role first.
      if (!current && !ctx.admin) throw roleMissing();
      const targetPerms = current ? current.permissions : [];
      requireMemberWithin(ctx, m, targetPerms, 'remove');
      if (admin && (await adminCount(slug)) <= 1) throw new TeamError(409, 'last_admin', 'the team needs at least one admin');
      return {
        entries: [{ kind: 'member_removed', detail: identity }],
        guard: and(
          actorHas(slug, actor, 'members.manage'),
          ['EXISTS (SELECT 1 FROM members WHERE workspace = ? AND identity = ? AND role_id = ?)', [slug, identity, m.role_id]],
          actorUnchanged(slug, ctx),
          ctx.admin ? lit(true) : roleIsAsRead(slug, m.role_id, targetPerms),
          admin ? anotherAdmin(slug, identity) : lit(true),
        ),
        change: ([cond, params]) => [q(`DELETE FROM members WHERE workspace = ? AND identity = ? AND ${cond}`, slug, identity, ...params)],
        result: { identity },
      };
    });
  }

  // ---- workspaces: create ----------------------------------------------------
  // Only an identity in DEPLOYMENT_ADMINS may create a workspace, and with none
  // named nobody may. One batch writes the workspace row, the caller as its
  // admin, and the first two rows of its log: workspace_created, member_added.
  // Creating default is refused as "already exists": it always does.
  async function createWorkspace(actorIdentity, body) {
    const actor = normalizeIdentity(actorIdentity);
    if (admins.size === 0) {
      throw new TeamError(409, 'no_deployment_admins', 'name who may create workspaces in DEPLOYMENT_ADMINS first');
    }
    if (!admins.has(actor)) throw forbidden('only an identity in DEPLOYMENT_ADMINS can create a workspace');
    const slug = body?.slug;
    if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
      throw new TeamError(400, 'bad_request', 'slug must be 1 to 40 characters of a-z, 0-9 and -');
    }
    const name = validName(body?.name);
    if (!name) throw new TeamError(400, 'bad_request', 'name is required');
    return mutate(slug, actor, async () => {
      // The members check is read time only. That is safe because nothing else
      // writes members for a slug that was never created, and the log's unique
      // key serialises two creations. Don't rely on the guard for it.
      if ((await workspaceExists(slug)) || (await memberCount(slug)) > 0) {
        throw new TeamError(409, 'workspace_exists', `workspace ${slug} already exists`);
      }
      if ((await q('SELECT COUNT(*) AS n FROM workspaces').first('n')) >= MAX_WORKSPACES) {
        throw new TeamError(409, 'workspace_limit', `this server holds at most ${MAX_WORKSPACES} workspaces besides default`);
      }
      const now = Date.now();
      const member = { identity: actor, kind: identityKind(actor), name: null, role_id: ADMIN_ROLE, added_at: now, added_by: actor };
      return {
        entries: [
          { kind: 'workspace_created', detail: `named ${JSON.stringify(name)}` },
          { kind: 'member_added', detail: `${actor} as ${ADMIN_ROLE}` },
        ],
        // The slug is the table's primary key, so two creations of one slug can't
        // both land. The member goes in first: the guard reads only `workspaces`,
        // which the member insert leaves alone, and the row insert comes last.
        guard: ['NOT EXISTS (SELECT 1 FROM workspaces WHERE slug = ?) AND (SELECT COUNT(*) FROM workspaces) < ?', [slug, MAX_WORKSPACES]],
        change: ([cond, params]) => [
          q(`INSERT INTO members(workspace, identity, kind, name, role_id, added_at, added_by) SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${cond}`,
            slug, member.identity, member.kind, member.name, member.role_id, member.added_at, member.added_by, ...params),
          q(`INSERT INTO workspaces(slug, name, created_by, created_at) SELECT ?, ?, ?, ? WHERE ${cond}`, slug, name, actor, now, ...params),
        ],
        result: { slug, name, role_id: ADMIN_ROLE, created_by: actor, created_at: now },
      };
    });
  }

  // ---- roles -----------------------------------------------------------------
  // Writes the role's row: an edit, a new role, or (deleted = 1) a removal.
  const upsertRole = (slug, role, deleted) => ([cond, params]) => [q(
    `INSERT INTO roles(workspace, role_id, name, permissions, builtin, deleted) SELECT ?, ?, ?, ?, ?, ? WHERE ${cond}
     ON CONFLICT(workspace, role_id) DO UPDATE SET name = excluded.name, permissions = excluded.permissions, deleted = excluded.deleted`,
    slug, role.id, role.name, JSON.stringify(role.permissions), isBuiltinRole(role.id) ? 1 : 0, deleted ? 1 : 0, ...params,
  )];
  const permsText = (perms) => (perms.length ? perms.join(',') : '(none)');

  async function addRole(slug, actorIdentity, body) {
    checkSlug(slug);
    const actor = normalizeIdentity(actorIdentity);
    const id = validRoleId(body?.id);
    const name = validName(body?.name) || id;
    const permissions = validPermissions(body?.permissions);
    if (id === ADMIN_ROLE) throw new TeamError(409, 'role_fixed', 'the admin role is fixed');
    return mutate(slug, actor, async () => {
      const ctx = await actorContext(slug, actor, 'roles.manage');
      if (await getRole(slug, id)) throw new TeamError(409, 'role_exists', `role ${id} already exists`);
      requireWithin(ctx, permissions, 'you can only create a role with permissions you hold');
      const role = { id, name, permissions, builtin: isBuiltinRole(id), editable: true };
      return {
        entries: [{ kind: 'role_added', detail: `${id} ${permsText(permissions)}` }],
        guard: and(actorHas(slug, actor, 'roles.manage'), actorUnchanged(slug, ctx), not(roleExists(slug, id))),
        change: upsertRole(slug, role, false),
        result: role,
      };
    });
  }

  async function updateRole(slug, actorIdentity, roleId, body) {
    checkSlug(slug);
    const actor = normalizeIdentity(actorIdentity);
    if (roleId === ADMIN_ROLE) throw new TeamError(409, 'role_fixed', 'the admin role is fixed');
    const hasName = body && Object.hasOwn(body, 'name');
    const hasPerms = body && Object.hasOwn(body, 'permissions');
    if (!hasName && !hasPerms) throw new TeamError(400, 'bad_request', 'send name or permissions');
    const name = hasName ? validName(body.name) : undefined;
    const permissions = hasPerms ? validPermissions(body.permissions) : undefined;
    return mutate(slug, actor, async () => {
      const ctx = await actorContext(slug, actor, 'roles.manage');
      const cur = await getRole(slug, roleId);
      if (!cur) throw new TeamError(404, 'not_found', `no role ${roleId}`);
      // The actor's own role differs from this one, and the guard keeps it so.
      if (ctx.role_id === roleId) throw forbidden('you cannot edit the role you hold');
      // The role as it is now must be within the actor's permissions: narrowing a
      // stronger role would lower every member who holds it.
      requireWithin(ctx, cur.permissions, 'you can only change a role whose permissions you hold');
      const role = { ...cur, ...(hasName ? { name: name || cur.name } : {}), ...(hasPerms ? { permissions } : {}) };
      requireWithin(ctx, role.permissions, 'you can only leave a role with permissions you hold');
      return {
        entries: [{ kind: 'role_changed', detail: `${roleId} ${permsText(role.permissions)}` }],
        guard: and(
          actorHas(slug, actor, 'roles.manage'),
          actorUnchanged(slug, ctx),
          roleExists(slug, roleId),
          // The role is as the plan read it: a rename keeps the stored permissions,
          // and anyone but an admin may touch only a role within their own.
          ctx.admin && hasPerms ? lit(true) : roleIsAsRead(slug, roleId, cur.permissions),
        ),
        change: upsertRole(slug, role, false),
        result: role,
      };
    });
  }

  async function removeRole(slug, actorIdentity, roleId) {
    checkSlug(slug);
    const actor = normalizeIdentity(actorIdentity);
    if (roleId === ADMIN_ROLE) throw new TeamError(409, 'role_fixed', 'the admin role is fixed');
    return mutate(slug, actor, async () => {
      const ctx = await actorContext(slug, actor, 'roles.manage');
      const cur = await getRole(slug, roleId);
      if (!cur) throw new TeamError(404, 'not_found', `no role ${roleId}`);
      if (ctx.role_id === roleId) throw forbidden('you cannot delete the role you hold');
      requireWithin(ctx, cur.permissions, 'you can only delete a role whose permissions you hold');
      const inUse = await q('SELECT COUNT(*) AS n FROM members WHERE workspace = ? AND role_id = ?', slug, roleId).first('n');
      if (inUse) throw new TeamError(409, 'role_in_use', `${inUse} member(s) hold role ${roleId}`);
      return {
        entries: [{ kind: 'role_removed', detail: roleId }],
        guard: and(
          actorHas(slug, actor, 'roles.manage'),
          actorUnchanged(slug, ctx),
          roleExists(slug, roleId),
          ctx.admin ? lit(true) : roleIsAsRead(slug, roleId, cur.permissions),
          ['NOT EXISTS (SELECT 1 FROM members WHERE workspace = ? AND role_id = ?)', [slug, roleId]],
        ),
        change: upsertRole(slug, { ...cur, permissions: [] }, true),
        result: { id: roleId },
      };
    });
  }

  return {
    authorize, whoami, recentCallers,
    workspaceExists, workspaceSlugs, listWorkspaces, createWorkspace,
    isInvited, isDeploymentAdmin, memberships,
    listMembers, getMember, addMember, updateMember, removeMember,
    listRoles, addRole, updateRole, removeRole,
    readAudit, verifyAudit,
    // The guarded change and its pieces, for src/devices.js to build on. They are
    // returned, not copied, so a device write re-checks the actor at commit with
    // exactly the rules a member write uses.
    mutate, actorContext, actorHas, actorUnchanged, and, or, not, lit,
  };
}

// The store for this deployment, from the Worker env.
export const teamFromEnv = (env) => teamStore(env.DB, { deploymentAdmins: env.DEPLOYMENT_ADMINS });
