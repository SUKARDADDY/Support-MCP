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
//
// It also notes when a PC's doorbell went away (the `doorbells` table, written only
// when no other socket of that PC is still open). A PC that connects again after 10
// minutes or more raises "came online" for the people who watch it (src/notify.js).
// The Worker tells this object which workspace it serves when it hands over a doorbell.
import { teamFromEnv } from './workspace.js';
import { notifyStore } from './notify.js';

// The Registry object name for a workspace. A session with no workspace stored
// (made before workspaces) counts as default.
export const registryName = (workspace) => (workspace && workspace !== 'default' ? `registry:${workspace}` : 'registry');

const DEVICE_ID = /^[a-z2-7]{20}$/;
const WORKSPACE = /^[a-z0-9-]{1,40}$/;
const DOORBELL_TAG = 'dev:';
// A PC that was away at least this long raises "came online" when its doorbell returns.
export const ONLINE_AFTER_MS = 10 * 60 * 1000;
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
    this.sql.exec('CREATE TABLE IF NOT EXISTS doorbells(device_id TEXT PRIMARY KEY, gone_at INTEGER NOT NULL)');
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
  // closes the older one, so a PC that reconnects never has two. `workspace` is the
  // team this object serves, for the "came online" notification.
  async doorbell(request, url) {
    const id = url.searchParams.get('device') || '';
    if (!DEVICE_ID.test(id)) return new Response('bad device', { status: 400 });
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    const tag = DOORBELL_TAG + id;
    for (const old of this.ctx.getWebSockets(tag)) {
      try { old.close(1000, 'replaced'); } catch (_) { /* already closed */ }
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [tag]);
    // A doorbell is back: if the PC was away long enough, tell its watchers.
    const gone = this.sql.exec('SELECT gone_at FROM doorbells WHERE device_id = ?', id).toArray()[0];
    if (gone) {
      this.sql.exec('DELETE FROM doorbells WHERE device_id = ?', id);
      const workspace = url.searchParams.get('workspace') || '';
      if (WORKSPACE.test(workspace) && Date.now() - gone.gone_at >= ONLINE_AFTER_MS) await this.announceOnline(workspace, id, gone.gone_at);
    }
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // "Came online" for the PC's watchers. Best effort: a database that cannot be reached
  // must never stop the doorbell from connecting.
  async announceOnline(workspace, id, goneAt) {
    try {
      const name = await this.env.DB.prepare("SELECT name FROM devices WHERE workspace = ? AND id = ? AND status = 'active'").bind(workspace, id).first('name');
      if (name === null || name === undefined) return;
      const notify = notifyStore(this.env.DB, teamFromEnv(this.env));
      await notify.write(workspace, await notify.rows(workspace, 'device_online', { watching: id }, {
        device_id: id, title: 'A PC is online', body: name, dedupe: `online:${id}:${goneAt}`,
      }));
    } catch (_) { /* the watchers miss one notification */ }
  }

  // A doorbell closed. When no other socket of that PC is open, it is away from now.
  // A socket replaced by a newer one, and one closed because the PC was removed, do not count.
  noteGone(ws, reason) {
    if (reason === 'removed') return;
    let tags;
    try { tags = this.ctx.getTags(ws); } catch (_) { return; }
    for (const tag of tags) {
      if (!tag.startsWith(DOORBELL_TAG)) continue;
      const stillOpen = this.ctx.getWebSockets(tag).some((other) => other !== ws && (other.readyState === undefined || other.readyState === 1));
      if (!stillOpen) {
        this.sql.exec('INSERT INTO doorbells(device_id, gone_at) VALUES (?, ?) ON CONFLICT(device_id) DO UPDATE SET gone_at = excluded.gone_at', tag.slice(DOORBELL_TAG.length), Date.now());
      }
    }
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

  async webSocketClose(ws, code, reason) {
    this.noteGone(ws, reason);
    try { ws.close(1000, 'bye'); } catch (_) { /* already closed */ }
  }

  async webSocketError(ws) {
    this.noteGone(ws, '');
  }
}
