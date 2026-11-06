// An in-memory stand-in for a Workers KV namespace, with what
// @cloudflare/workers-oauth-provider and the relay use: get (as text or json),
// put with expirationTtl and metadata, delete, and list with prefix, limit and
// cursor. Expiry follows Date.now(), so a test that moves the clock moves it.
// Like the real thing it refuses a TTL under 60 seconds, and it counts reads
// and writes so a test can check the free-plan arithmetic.
export function openKV() {
  const rows = new Map(); // key -> { value, metadata, expiresAt }
  const kv = {
    reads: 0,
    writes: 0,
    deletes: 0,
    // Set to make every call fail, as KV does past its daily limit.
    failing: false,
    rows,
    _live(key) {
      const row = rows.get(key);
      if (!row) return null;
      if (row.expiresAt !== null && row.expiresAt <= Date.now()) {
        rows.delete(key);
        return null;
      }
      return row;
    },
    async get(key, opts) {
      if (kv.failing) throw new Error('KV GET failed: 429 Too Many Requests');
      kv.reads++;
      const row = kv._live(key);
      if (!row) return null;
      const type = typeof opts === 'string' ? opts : opts && opts.type ? opts.type : 'text';
      if (type === 'json') return JSON.parse(row.value);
      if (type === 'text') return row.value;
      throw new Error(`unsupported KV read type ${type}`);
    },
    async put(key, value, opts = {}) {
      if (kv.failing) throw new Error('KV PUT failed: 429 Too Many Requests');
      kv.writes++;
      if (typeof value !== 'string') throw new Error('this fake stores strings only');
      let expiresAt = null;
      if (opts.expirationTtl !== undefined) {
        if (!Number.isInteger(opts.expirationTtl) || opts.expirationTtl < 60) throw new Error('KV PUT failed: expirationTtl must be at least 60');
        expiresAt = Date.now() + opts.expirationTtl * 1000;
      }
      rows.set(key, { value, metadata: opts.metadata ?? null, expiresAt });
    },
    async delete(key) {
      if (kv.failing) throw new Error('KV DELETE failed: 429 Too Many Requests');
      kv.deletes++;
      rows.delete(key);
    },
    async list(opts = {}) {
      if (kv.failing) throw new Error('KV LIST failed: 429 Too Many Requests');
      kv.reads++;
      const prefix = opts.prefix ?? '';
      const limit = Math.min(opts.limit ?? 1000, 1000);
      const names = [...rows.keys()].filter((k) => k.startsWith(prefix) && kv._live(k)).sort();
      const start = opts.cursor ? names.findIndex((n) => n > opts.cursor) : 0;
      const slice = start === -1 ? [] : names.slice(start, start + limit);
      const more = start !== -1 && start + limit < names.length;
      return {
        keys: slice.map((name) => ({ name, metadata: rows.get(name).metadata ?? undefined })),
        list_complete: !more,
        cursor: more ? slice[slice.length - 1] : undefined,
      };
    },
  };
  return kv;
}
