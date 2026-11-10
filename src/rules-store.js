// A workspace's rules in the shared D1 database (migrations/0009_rules.sql): the team's document and each
// customer's overrides. Every query on the table is in this file and filters by workspace, except the two
// in src/devices.js that must stay with a PC's row: the check-in's join, and the delete that goes with a customer.
// A save goes through the team store's guarded change (mutate), so its log row commits with it and the
// actor's role is checked again at commit. The row's rev is checked at commit too, so two admins who
// read the same version cannot both save: the second gets 409 stale.
//
// A log detail holds the names of the fields a save changed and the customer's id, never a folder path
// or a program name.
//
// The PC's own copy of the rules comes with its check-in (src/devices.js); this store serves the team
// API (src/api.js) and the relay's own checks.
import { TeamError, normalizeIdentity } from './workspace.js';
import {
  DEFAULT_RULES, RulesError, effectiveFromRows, hourRuleProblem, parseRules, parseStored, resolveTimeZone,
} from './rules.js';

// The most overrides one listing returns. A team holds up to 10,000 customers, and few override anything.
const LIST_MAX = 1000;
// The most PCs one customer's change rings in one call to the Registry.
export const RING_CHUNK = 500;

const stale = () => new TeamError(409, 'stale', 'the rules changed since you read them; read them again');
const bad = (message) => new TeamError(400, 'bad_request', message);

// deps: the team store (src/workspace.js), whose guarded change this builds on.
// opts.defaultTimeZone is DEFAULT_TIME_ZONE.
export function rulesStore(db, team, { defaultTimeZone = '' } = {}) {
  const { mutate, actorContext, actorHas, actorUnchanged, and } = team;
  const q = (sql, ...params) => db.prepare(sql).bind(...params);
  const zone = resolveTimeZone(null, defaultTimeZone);

  const readRow = (slug, customerId) => q('SELECT customer_id, doc, rev, updated_at, updated_by FROM rules WHERE workspace = ? AND customer_id = ?', slug, customerId).first();
  const customerExists = async (slug, id) => !!(await q('SELECT 1 AS ok FROM customers WHERE workspace = ? AND id = ?', slug, id).first('ok'));
  const revIs = (slug, customerId, rev) => ['(SELECT COALESCE((SELECT rev FROM rules WHERE workspace = ? AND customer_id = ?), 0)) = ?', [slug, customerId, rev]];

  // A row as the API shows it. No row is revision 0 with the defaults (or nothing, for an override).
  const view = (row, override) => ({
    rev: row?.rev ?? 0,
    doc: row ? parseStored(row.doc, { override }) : override ? {} : parseRules({}),
    updated_at: row?.updated_at ?? null,
    updated_by: row?.updated_by ?? null,
  });

  // The team's rules and every customer's override. default_time_zone is the zone a null time_zone resolves to.
  async function listAll(slug) {
    const rows = (await q("SELECT customer_id, doc, rev, updated_at, updated_by FROM rules WHERE workspace = ? AND customer_id <> '' ORDER BY customer_id LIMIT ?", slug, LIST_MAX).all()).results;
    return {
      rules: view(await readRow(slug, ''), false),
      overrides: rows.map((r) => ({ customer_id: r.customer_id, ...view(r, true) })),
      default_time_zone: zone,
    };
  }

  // One customer's override and the rules in force for that customer. 404 for a customer that does not exist.
  async function readCustomer(slug, customerId) {
    if (!(await customerExists(slug, customerId))) throw new TeamError(404, 'not_found', 'no such customer');
    const [teamRow, row] = await Promise.all([readRow(slug, ''), readRow(slug, customerId)]);
    return { customer_id: customerId, ...view(row, true), effective: effectiveFromRows(teamRow, row, { defaultTimeZone }) };
  }

  // Read the state a save is judged against, and refuse what cannot be saved: a document that does not
  // pass, a stale rev, a customer that does not exist. Both the route (before it spends the person's
  // code) and the guarded change (on each attempt) call it. Returns what the change needs.
  async function check(slug, customerId, input, rev) {
    const override = customerId !== '';
    let doc;
    try {
      doc = parseRules(input, { override });
    } catch (e) {
      if (e instanceof RulesError) throw bad(e.message);
      throw e;
    }
    if (override && !(await customerExists(slug, customerId))) throw new TeamError(404, 'not_found', 'no such customer');
    const [teamRow, row] = await Promise.all([readRow(slug, ''), override ? readRow(slug, customerId) : null]);
    const cur = override ? row : teamRow;
    if ((cur?.rev ?? 0) !== rev) throw stale();
    // An override is judged merged over the team's rules: an hour rule needs hours from one of them.
    if (override) {
      const problem = hourRuleProblem({ ...DEFAULT_RULES, ...(teamRow ? parseStored(teamRow.doc) : {}), ...doc });
      if (problem) throw bad(problem);
    }
    return { doc, cur, teamRev: teamRow?.rev ?? 0 };
  }

  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const changedFields = (before, after) => [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((k) => !same(before[k], after[k]))
    .sort((a, b) => Object.keys(DEFAULT_RULES).indexOf(a) - Object.keys(DEFAULT_RULES).indexOf(b));
  const scopeOf = (customerId) => (customerId ? `customer ${customerId}` : 'team');

  // Save the team's document (customerId '') or a customer's override. input is the whole document, rev the
  // revision the caller read (0 when there was no row). Needs rules.manage. A document equal to the stored
  // one changes nothing. Returns the saved row as view() shows it, and `changed`: whether anything was written.
  async function save(slug, actorIdentity, customerId, input, rev) {
    const actor = normalizeIdentity(actorIdentity);
    const override = customerId !== '';
    return mutate(slug, actor, async () => {
      const ctx = await actorContext(slug, actor, 'rules.manage');
      const { doc, cur, teamRev } = await check(slug, customerId, input, rev);
      const before = cur ? parseStored(cur.doc, { override }) : override ? {} : parseRules({});
      const fields = changedFields(before, doc);
      if (!fields.length) return { noop: true, result: { ...view(cur, override), changed: false } };
      const now = Date.now();
      const text = JSON.stringify(doc);
      return {
        entries: [{ kind: 'rules_changed', detail: `${scopeOf(customerId)}: ${fields.join(', ')}` }],
        guard: and(
          actorHas(slug, actor, 'rules.manage'),
          actorUnchanged(slug, ctx),
          revIs(slug, customerId, rev),
          // An override was judged against the team's rules as read: they are still those.
          ...(override ? [revIs(slug, '', teamRev), ['EXISTS (SELECT 1 FROM customers WHERE workspace = ? AND id = ?)', [slug, customerId]]] : []),
        ),
        change: ([cond, params]) => [q(
          `INSERT INTO rules(workspace, customer_id, doc, rev, updated_at, updated_by) SELECT ?, ?, ?, ?, ?, ? WHERE ${cond}
           ON CONFLICT(workspace, customer_id) DO UPDATE SET doc = excluded.doc, rev = excluded.rev, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
          slug, customerId, text, rev + 1, now, actor, ...params,
        )],
        result: { rev: rev + 1, doc, updated_at: now, updated_by: actor, changed: true },
      };
    });
  }

  // Remove a customer's override, so the customer has the team's rules again. rev, when given, is the
  // revision the caller read. Needs rules.manage. Returns { changed: false } when there was none.
  async function removeOverride(slug, actorIdentity, customerId, rev = null) {
    const actor = normalizeIdentity(actorIdentity);
    return mutate(slug, actor, async () => {
      const ctx = await actorContext(slug, actor, 'rules.manage');
      if (!(await customerExists(slug, customerId))) throw new TeamError(404, 'not_found', 'no such customer');
      const cur = await readRow(slug, customerId);
      if (rev !== null && (cur?.rev ?? 0) !== rev) throw stale();
      if (!cur) return { noop: true, result: { changed: false } };
      const fields = Object.keys(parseStored(cur.doc, { override: true }));
      return {
        entries: [{ kind: 'rules_changed', detail: `${scopeOf(customerId)}: override removed${fields.length ? ` (${fields.join(', ')})` : ''}` }],
        guard: and(actorHas(slug, actor, 'rules.manage'), actorUnchanged(slug, ctx), revIs(slug, customerId, cur.rev)),
        change: ([cond, params]) => [q('DELETE FROM rules WHERE workspace = ? AND customer_id = ? AND ' + cond, slug, customerId, ...params)],
        result: { changed: true },
      };
    });
  }

  // The ids of the active PCs a customer's rules reach, for ringing them after a change.
  async function customerDevices(slug, customerId) {
    const { results } = await q(
      `SELECT d.id FROM devices d JOIN sites s ON s.workspace = d.workspace AND s.id = d.site_id
       WHERE d.workspace = ? AND s.customer_id = ? AND d.status = 'active' ORDER BY d.id`, slug, customerId).all();
    return results.map((r) => r.id);
  }

  return { listAll, readCustomer, check, save, removeOverride, customerDevices };
}

export const rulesFromEnv = (env, team) => rulesStore(env.DB, team, { defaultTimeZone: env.DEFAULT_TIME_ZONE });
