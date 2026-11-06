// Registry Durable Object: one instance per workspace. Holds one row per
// session so session_list is a single read (Session DOs push snapshots on every
// state change). The default workspace keeps idFromName("registry"), so sessions
// made before workspaces existed stay in its list. Any other workspace uses
// idFromName("registry:<slug>").

// The Registry object name for a workspace. A session with no workspace stored
// (made before workspaces) counts as default.
export const registryName = (workspace) => (workspace && workspace !== 'default' ? `registry:${workspace}` : 'registry');

export class Registry {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS sessions(
         code TEXT PRIMARY KEY,
         sid TEXT,
         label TEXT,
         state TEXT,
         machine TEXT,
         user TEXT,
         expires_at INTEGER,
         created_at INTEGER,
         updated_at INTEGER
       )`,
    );
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/update') {
      const b = await request.json();
      this.sql.exec(
        `INSERT INTO sessions(code,sid,label,state,machine,user,expires_at,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?)
         ON CONFLICT(code) DO UPDATE SET
           sid=excluded.sid, label=excluded.label, state=excluded.state,
           machine=excluded.machine, user=excluded.user,
           expires_at=excluded.expires_at, updated_at=excluded.updated_at`,
        b.code, b.sid ?? null, b.label ?? null, b.state ?? null,
        b.machine ?? null, b.user ?? null, b.expires_at ?? null,
        b.created_at ?? null, Date.now(),
      );
      return Response.json({ ok: true });
    }
    if (url.pathname === '/list') {
      const rows = this.sql
        .exec(
          `SELECT code,sid,label,state,machine,user,expires_at,created_at
           FROM sessions ORDER BY created_at DESC`,
        )
        .toArray();
      return Response.json({ sessions: rows });
    }
    return new Response('not found', { status: 404 });
  }
}
