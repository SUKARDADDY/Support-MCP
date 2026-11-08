// Registry Durable Object: one instance per workspace. Holds one row per
// session so session_list is a single read (Session DOs push snapshots on every
// state change). The default workspace keeps idFromName("registry"), so sessions
// made before workspaces existed stay in its list. Any other workspace uses
// idFromName("registry:<slug>").
//
// It also holds the doorbell of each saved PC in the workspace: one WebSocket
// per PC, accepted with the hibernation API under the tag dev:<device id>. The
// relay rings it with the text {"type":"ring"}, which carries nothing else, so
// a fake ring can only make a PC check in early. The PC sends protocol pings
// only; this object ignores any text it gets and closes a socket that sends a
// frame over 1 KB. An idle doorbell is a hibernated socket, which Cloudflare
// does not bill, and only a ring wakes the object.

// The Registry object name for a workspace. A session with no workspace stored
// (made before workspaces) counts as default.
export const registryName = (workspace) => (workspace && workspace !== 'default' ? `registry:${workspace}` : 'registry');

const DEVICE_ID = /^[a-z2-7]{20}$/;
const DOORBELL_TAG = 'dev:';
export const DOORBELL_FRAME_MAX = 1024; // bytes; a larger frame closes the doorbell
const RING = JSON.stringify({ type: 'ring' });

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
    if (url.pathname === '/doorbell') return this.doorbell(request, url);
    if (request.method === 'POST' && url.pathname === '/ring') return this.ring(await request.json().catch(() => ({})));
    if (url.pathname === '/online') return Response.json({ online: this.online() });
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

  // ---- the doorbell ----------------------------------------------------------
  // The Worker has already checked the PC's key. A new socket for the same PC
  // closes the older one, so a PC that reconnects never has two.
  doorbell(request, url) {
    const id = url.searchParams.get('device') || '';
    if (!DEVICE_ID.test(id)) return new Response('bad device', { status: 400 });
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    const tag = DOORBELL_TAG + id;
    for (const old of this.ctx.getWebSockets(tag)) {
      try { old.close(1000, 'replaced'); } catch (_) { /* already closed */ }
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [tag]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // The ids of the PCs whose doorbell is connected.
  online() {
    const ids = new Set();
    for (const ws of this.ctx.getWebSockets()) {
      for (const tag of this.ctx.getTags(ws)) if (tag.startsWith(DOORBELL_TAG)) ids.add(tag.slice(DOORBELL_TAG.length));
    }
    return [...ids].sort();
  }

  // Ring one PC ({device_id}) or every PC ({all: true}). close: true closes the
  // doorbell after the ring, for a PC that was just removed. Best effort.
  ring({ device_id: id, all, close }) {
    let rang = 0;
    const sockets = all === true ? this.ctx.getWebSockets() : DEVICE_ID.test(String(id)) ? this.ctx.getWebSockets(DOORBELL_TAG + id) : [];
    for (const ws of sockets) {
      try {
        ws.send(RING);
        rang++;
        if (close === true) ws.close(1000, 'removed');
      } catch (_) { /* a dead socket is simply not rung */ }
    }
    return Response.json({ rang: rang > 0 });
  }

  async webSocketMessage(ws, data) {
    // Nothing a PC sends is read. A frame over the limit is a protocol error.
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data).length : data.byteLength;
    if (bytes > DOORBELL_FRAME_MAX) {
      try { ws.close(1009, 'frame too large'); } catch (_) { /* already closed */ }
    }
  }

  async webSocketClose(ws) {
    try { ws.close(1000, 'bye'); } catch (_) { /* already closed */ }
  }

  async webSocketError() {}
}
