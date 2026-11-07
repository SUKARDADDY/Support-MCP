// A D1 stand-in on node:sqlite, with the migrations applied. It implements what
// src/workspace.js uses: prepare(sql).bind(...).run() / .all() / .first(col),
// and an atomic batch(). Every call yields first, as a network round trip does,
// so concurrent callers interleave between statements the way Workers do.
//
// openD1() gives a new database. handle(db) gives a second handle on the same
// one, like a second Worker instance. Every handle records the SQL and the
// bound values it ran in `seen`, and counts its failed batches in `failedBatches`.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

// Every .sql file in migrations/, in name order, as `wrangler d1 migrations apply` runs them.
const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const MIGRATIONS = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
  .map((f) => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'));
const tick = () => new Promise((r) => setImmediate(r));
const plain = (row) => (row ? { ...row } : row);

// D1 allows at most 100 bound parameters in one statement. node:sqlite allows 32766,
// so without this check a query that works here fails on the real database.
export const D1_MAX_PARAMS = 100;

function check(params) {
  if (params.length > D1_MAX_PARAMS) throw new Error(`D1_ERROR: too many SQL variables at offset 0: SQLITE_ERROR (${params.length} bound, the limit is ${D1_MAX_PARAMS})`);
  for (const p of params) {
    // D1 refuses undefined and booleans the same way.
    if (p === undefined || typeof p === 'boolean') throw new Error(`D1_TYPE_ERROR: Type '${typeof p}' not supported`);
  }
}

export function handle(sqlite, seen = []) {
  const exec = (sql, params, mode) => {
    check(params);
    seen.push({ sql, params });
    const st = sqlite.prepare(sql);
    if (mode === 'all') return { success: true, results: st.all(...params).map(plain), meta: {} };
    if (mode === 'first') return plain(st.get(...params)) ?? null;
    const r = st.run(...params);
    return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  };
  const statement = (sql, params = []) => ({
    sql, params,
    bind: (...p) => statement(sql, p),
    run: async () => { await tick(); return exec(sql, params, 'run'); },
    all: async () => { await tick(); return exec(sql, params, 'all'); },
    first: async (col) => {
      await tick();
      const row = exec(sql, params, 'first');
      return col === undefined ? row : row ? row[col] ?? null : null;
    },
  });
  const d1 = {
    seen,
    sqlite,
    failedBatches: 0,
    prepare: (sql) => statement(sql),
    // One transaction: every statement or none.
    async batch(statements) {
      await tick();
      sqlite.exec('BEGIN');
      try {
        const out = statements.map((s) => exec(s.sql, s.params, /^\s*(SELECT|WITH)\b/i.test(s.sql) ? 'all' : 'run'));
        sqlite.exec('COMMIT');
        return out;
      } catch (e) {
        sqlite.exec('ROLLBACK');
        d1.failedBatches++;
        throw e;
      }
    },
  };
  return d1;
}

export function openD1() {
  const sqlite = new DatabaseSync(':memory:');
  for (const sql of MIGRATIONS) sqlite.exec(sql);
  return handle(sqlite);
}
