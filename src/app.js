// support-mcp relay router: Access JWT gate + MCP JSON-RPC handler + the team
// API (/api/v1/...) + the public customer paths (/healthz, /j/<code>, /agent,
// /ws). Kept free of the .ps1 import and the DO classes so node --test can drive
// it route-level; index.js wires it to the real agent template.
import { verifyAccessJwt, jwksKeyResolver, localBypassAllowed, callerIdentity } from './jwt.js';
import { handleRpc, parseToolOptions } from './mcp.js';
import { VERSION } from './version.js';
import { permissionForTool } from './permissions.js';
import { DEFAULT_WORKSPACE, teamFromEnv } from './workspace.js';
import { registryName } from './registry.js';
import { handleApi } from './api.js';
import { handleAuth } from './auth.js';
import {
  AS_METADATA_PATH, PROTECTED_RESOURCE_PREFIX, REGISTER_PATH, TOKEN_PATH, assertPersonActive, assertSecondFactor, bearerToken,
  challengeHeader, createOAuth,
} from './oauth.js';
import {
  buildAppDownload,
  buildBootstrap,
  clientMode,
  normalizeWindowsMode,
  INVALID_LINK_SCRIPT,
  METHOD_NOT_ALLOWED_SCRIPT,
  NOT_POWERSHELL_SCRIPT,
  USE_HTTPS_SCRIPT,
  USE_HTTPS_TEXT,
} from './template.js';

const CODE_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'; // RFC4648 base32, lowercased
function newCode() {
  const u = new Uint8Array(16);
  crypto.getRandomValues(u);
  let s = '';
  for (let i = 0; i < 16; i++) s += CODE_ALPHABET[u[i] & 31];
  return s; // 16 chars * 5 bits = 80 bits
}

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...extra } });
}
const noStore = { 'cache-control': 'no-store' };
const psText = (body, status, extra = {}) =>
  new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', ...noStore, ...extra } });

const APP_PAGE_CSS = `*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px 16px;background:#EEF1F5;color:#141A24;font:15px/1.5 "Segoe UI Variable Text","Segoe UI",system-ui,-apple-system,Roboto,Arial,sans-serif}
main{width:100%;max-width:440px;background:#fff;border:1px solid #E4E7EC;border-radius:8px;box-shadow:0 10px 28px rgba(16,24,40,.18),0 2px 6px rgba(16,24,40,.08);overflow:hidden}
.edge{height:3px;background:#1F9D55}.off .edge{background:#E4E7EC}
.top{display:flex;align-items:center;gap:8px;height:36px;padding:0 14px;color:#5B6472;font-size:12px;font-weight:600}
.body{padding:6px 24px 24px}
.hero{display:flex;gap:14px;align-items:center;margin:0 0 20px}
.tile{flex:none;width:48px;height:48px;border-radius:10px;display:grid;place-items:center;background:rgba(31,157,85,.16);color:#1F9D55}.off .tile{background:#F5F6F8;color:#5B6472}
h1{margin:0;font:600 22px/1.2 "Segoe UI Variable Display","Segoe UI",system-ui,-apple-system,Roboto,Arial,sans-serif;letter-spacing:-.01em}
h2{margin:0 0 6px;font:600 17px/1.3 "Segoe UI Variable Display","Segoe UI",system-ui,-apple-system,Roboto,Arial,sans-serif}
p{margin:0 0 8px}.he{direction:rtl;text-align:right}.sub{color:#5B6472;font-size:13.5px}
button{display:block;width:100%;min-height:52px;margin:4px 0 22px;padding:0 16px;border:0;border-radius:8px;background:#2563EB;color:#fff;font:600 17px "Segoe UI Variable Text","Segoe UI",system-ui,-apple-system,Roboto,Arial,sans-serif;cursor:pointer}
button .he{display:block;margin:0;font-size:14px;font-weight:400;text-align:center;color:#fff}
button:hover{background:#1D4FC4}
button:focus{outline:3px solid #9DB9F5;outline-offset:3px}
button:focus:not(:focus-visible){outline:none}
ol{list-style:none;counter-reset:step;margin:0 0 4px;padding:0;border-top:1px solid #E4E7EC}
li{counter-increment:step;position:relative;padding:14px 0 14px 38px;border-bottom:1px solid #E4E7EC}
li:before{content:counter(step);position:absolute;left:0;top:14px;width:26px;height:26px;border-radius:50%;background:#F5F6F8;color:#141A24;font-size:13px;font-weight:600;display:grid;place-items:center}
li span{display:block}li .he{margin-top:2px;color:#5B6472;font-size:13.5px}
bdi{white-space:nowrap}
.note{margin:16px 0 0;color:#5B6472;font-size:13px}
@media(max-width:480px){body{padding:12px 10px;align-items:flex-start}.body{padding:4px 18px 20px}}`;

const HEADSET_SVG = '<svg width="26" height="26" viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 11V9.5a6.5 6.5 0 0 1 13 0V11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><rect x="2.5" y="10.5" width="3.5" height="5" rx="1.4" fill="currentColor"/><rect x="14" y="10.5" width="3.5" height="5" rx="1.4" fill="currentColor"/><path d="M15.8 15.5c0 1.4-1.4 2.2-3.8 2.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
const SCREEN_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M5.5 14h5M8 11.5V14" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';

function appPage(url, state = 'pending', sid = '', expiredStatus = 410) {
  const ready = state === 'pending';
  const downloaded = state === 'consumed' || state === 'attached';
  const filename = /^[0-9a-f]{64}$/.test(sid) ? `remote-support-${sid.slice(0, 8)}.exe` : 'the support app';
  const step = (en, he) => `<li><span>${en}</span><span class="he" lang="he" dir="rtl">${he}</span></li>`;
  const content = ready
    ? `<p class="sub">Download the support app on the computer that needs help.</p>
       <p class="sub he" lang="he" dir="rtl">הורידו את אפליקציית התמיכה במחשב שזקוק לעזרה.</p>
       <form method="post" action="${url.pathname}?client=app"><button type="submit">Download the support app<span class="he" lang="he" dir="rtl">הורדת אפליקציית התמיכה</span></button></form>
       <ol>${step('Download the support app.', 'הורידו את אפליקציית התמיכה.')}${step('If Microsoft Edge says the file <strong>&ldquo;isn&rsquo;t commonly downloaded&rdquo;</strong>, point at the download, click the three dots (<strong>...</strong>), then click <strong>Keep</strong>. In the box that opens, click <strong>Show more</strong>, then <strong>Keep anyway</strong>.', 'אם Microsoft Edge מציג שהקובץ <bdi dir="ltr"><strong>&ldquo;isn&rsquo;t commonly downloaded&rdquo;</strong></bdi>, העבירו את העכבר מעל ההורדה, לחצו על שלוש הנקודות (<bdi dir="ltr"><strong>...</strong></bdi>) ואז על <bdi dir="ltr"><strong>Keep</strong></bdi>. בחלון שנפתח לחצו על <bdi dir="ltr"><strong>Show more</strong></bdi> ואז על <bdi dir="ltr"><strong>Keep anyway</strong></bdi>.')}${step('Open the downloaded file. If Windows says &ldquo;Windows protected your PC&rdquo;, click <strong>More info</strong>, then <strong>Run anyway</strong>.', 'פתחו את הקובץ שהורד. אם Windows מציג <bdi dir="ltr">&ldquo;Windows protected your PC&rdquo;</bdi>, לחצו על <bdi dir="ltr"><strong>More info</strong></bdi> ואז על <bdi dir="ltr"><strong>Run anyway</strong></bdi>.')}${step('The app asks &ldquo;Give support full control of this PC?&rdquo; Click <strong>Allow</strong>, then <strong>Yes</strong> when Windows asks for permission.', 'האפליקציה שואלת <bdi dir="ltr">&ldquo;Give support full control of this PC?&rdquo;</bdi> לחצו על <bdi dir="ltr"><strong>Allow</strong></bdi>, ואז על <bdi dir="ltr"><strong>Yes</strong></bdi> כש-Windows מבקש אישור.')}</ol>
       <p class="note">A small window stays in the corner of your screen while support is connected. Close it or click End session to stop access.</p>
       <p class="note he" lang="he" dir="rtl">חלון קטן נשאר בפינת המסך בזמן שהתמיכה מחוברת. סגירתו או לחיצה על End session מפסיקה את הגישה.</p>
       <p class="note">If your antivirus removes the file, tell support.</p>
       <p class="note he" lang="he" dir="rtl">אם האנטי-וירוס מוחק את הקובץ, ספרו לתמיכה.</p>`
    : downloaded
      ? `<h2>Check your downloads</h2><p>A download was already requested for this session. Open <strong>${filename}</strong> from your browser's Downloads list.</p>
         <p>If the file did not download, ask support for a new link.</p><p class="he" lang="he" dir="rtl">ההורדה כבר התבקשה. פתחו את הקובץ ברשימת ההורדות בדפדפן. אם לא התקבל קובץ, בקשו קישור חדש.</p>`
      : '<h2>This support link has expired</h2><p>Ask support for a new link, then open it on the computer that needs help.</p><p class="he" lang="he" dir="rtl">בקשו קישור חדש ופתחו אותו במחשב שזקוק לתמיכה.</p>';
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Remote support</title>
    <style>${APP_PAGE_CSS}</style></head>
    <body><main${ready ? '' : ' class="off"'}><div class="edge"></div><div class="top">${SCREEN_SVG}<span>Remote support</span></div>
    <div class="body"><div class="hero"><div class="tile">${HEADSET_SVG}</div><h1>Support session</h1></div>${content}</div></main></body></html>`, {
    status: ready ? 200 : downloaded ? 409 : expiredStatus,
    headers: { ...noStore, 'content-type': 'text/html; charset=utf-8', 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" },
  });
}

// ---- MCP backend: each tool talks to the DOs -------------------------------
// Every operator call names its workspace, which comes from the address the
// request arrived on (/mcp is default, /w/<slug>/mcp is that workspace). The
// Session answers a call from another workspace as it answers for a session
// that does not exist.
function makeBackend(env, origin, devTtlMs, actor, workspace) {
  const sessionStub = (sid) => {
    if (sid === undefined || sid === null || sid === '') throw new Error('session_id is required; call session_list to find it');
    if (!/^[0-9a-f]{64}$/.test(String(sid))) throw new Error('session_id must be the 64 hex characters from session_create or session_list');
    return env.SESSION.get(env.SESSION.idFromString(sid));
  };
  async function cmd(sid, body) {
    const r = await sessionStub(sid).fetch('https://do/command', {
      method: 'POST',
      body: JSON.stringify({ ...body, actor, workspace }),
    });
    return r.json();
  }
  return {
    async session_create(args) {
      const windowsMode = normalizeWindowsMode(args.windows_mode ?? 'app');
      const code = newCode();
      const id = env.SESSION.idFromName(code);
      const sid = id.toString();
      const r = await env.SESSION.get(id).fetch('https://do/create', {
        method: 'POST',
        body: JSON.stringify({ code, sid, label: args.label ?? null, windows_mode: windowsMode, ttl_ms: devTtlMs, actor, workspace }),
      });
      const out = await r.json();
      if (!out.ok) throw new Error(out.error || 'session_create failed');
      const link = `${origin}/j/${code}`;
      return windowsMode === 'app'
        ? {
            session_id: sid,
            windows_mode: windowsMode,
            download_url: `${link}?client=app`,
            one_liner: `Start-Process '${link}?client=app'`,
            code_expires_at: out.code_expires_at,
          }
        : {
            session_id: sid,
            windows_mode: windowsMode,
            one_liner: `irm ${link} | iex`,
            code_expires_at: out.code_expires_at,
          };
    },
    async session_list() {
      const r = await env.REGISTRY.get(env.REGISTRY.idFromName(registryName(workspace))).fetch('https://do/list');
      const { sessions } = await r.json();
      return { sessions };
    },
    async session_status(args) {
      const tail = args.log_tail == null ? 20 : args.log_tail;
      const r = await sessionStub(args.session_id).fetch(`https://do/status?log_tail=${encodeURIComponent(tail)}&workspace=${workspace}`);
      return r.json();
    },
    async run(args) {
      const r = await cmd(args.session_id, { op: 'run', command: args.command, timeout_s: args.timeout_s, as: args.as });
      if (r.ok === false) throw new Error(r.error || 'run failed');
      return {
        exit_code: typeof r.exit_code === 'number' ? r.exit_code : null,
        stdout: r.stdout,
        stderr: r.stderr,
        timed_out: !!r.timed_out,
      };
    },
    async put_file(args) {
      const r = await cmd(args.session_id, { op: 'put_file', path: args.path, data_b64: args.data_b64, append: args.append });
      if (r.ok === false) throw new Error(r.error || 'put_file failed');
      return { bytes: r.bytes };
    },
    async get_file(args) {
      const r = await cmd(args.session_id, { op: 'get_file', path: args.path, offset: args.offset, length: args.length });
      if (r.ok === false) throw new Error(r.error || 'get_file failed');
      return { data_b64: r.data_b64, size: r.size, eof: r.eof };
    },
    // args.action is already normalized by mcp.js; the Session checks it again.
    async screen(args) {
      const r = await cmd(args.session_id, { op: 'screen', action: args.action });
      if (r.ok === false) throw new Error(r.error || 'screen action failed');
      const { ok, ...out } = r;
      return out;
    },
    async request_full_control(args) {
      const r = await cmd(args.session_id, { op: 'control', action: 'request_full_control' });
      if (r.ok === false) throw new Error(r.error || 'request_full_control failed');
      const { ok, ...out } = r;
      return out;
    },
    async session_end(args) {
      const r = await sessionStub(args.session_id).fetch('https://do/end', {
        method: 'POST',
        body: JSON.stringify({ actor, workspace }),
      });
      return r.json();
    },
  };
}

// The role check in front of every tool. A tool call runs exactly one backend
// method, and each method first checks that the caller's role holds the
// permission the called tool needs. It is given only that permission key, never
// the tool's arguments, and a refused call never reaches a Session.
//
// A caller that came in with an OAuth token (`oauthCaller`) is checked further,
// on every call: the person must still exist, be enabled and be invited; open
// mode never admits them; and a permission that needs a second factor needs the
// authenticator their grant was made with. Removal takes effect on the next call.
function authorizedBackend(backend, env, actor, toolName, workspace, oauthCaller = null) {
  const check = async () => {
    const permission = permissionForTool(toolName);
    if (!permission) throw new Error(`unknown tool: ${toolName}`);
    const team = teamFromEnv(env);
    // A workspace that was never created answers every tool call the same way,
    // whoever asks. tools/list never gets here.
    if (!(await team.workspaceExists(workspace))) throw new Error('workspace not found');
    if (oauthCaller) await assertPersonActive(env, team, oauthCaller);
    // An OAuth caller is a member or nothing: authorize does not apply open
    // mode to them, and does not record them as a recent caller of default.
    const a = await team.authorize(workspace, actor, permission, { membersOnly: oauthCaller !== null });
    if (!a.ok) throw new Error(a.reason === 'not_member' ? 'you are not a member of this team' : `your role does not allow ${permission}`);
    if (oauthCaller) await assertSecondFactor(env, oauthCaller, permission);
  };
  return Object.fromEntries(Object.entries(backend).map(([name, fn]) => [name, async (args) => {
    await check();
    return fn(args);
  }]));
}

// ---- Access gate -----------------------------------------------------------
// Returns the caller identity string when allowed, or null. `mcp` is true on
// the MCP addresses, which may sit under a second Access application
// (ACCESS_MCP_AUD, see cf/access-setup.sh): a JWT for either application is
// good there. The team API accepts ACCESS_AUD only.
async function accessCaller(request, env, url, { mcp = false } = {}) {
  if (localBypassAllowed(env, url.hostname)) return 'local-dev';
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return null;
  const mcpAud = typeof env.ACCESS_MCP_AUD === 'string' ? env.ACCESS_MCP_AUD.trim() : '';
  try {
    const payload = await verifyAccessJwt(token, {
      aud: mcp && mcpAud ? [env.ACCESS_AUD, mcpAud] : env.ACCESS_AUD,
      iss: `https://${env.ACCESS_TEAM_DOMAIN}`,
      keyResolver: jwksKeyResolver(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`),
      subtle: crypto.subtle,
    });
    return callerIdentity(payload);
  } catch (_) {
    return null;
  }
}

function isJsonContentType(request) {
  const ct = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  return ct === 'application/json';
}

// ---- routes ----------------------------------------------------------------
const WORKSPACE_MCP = /^\/w\/([a-z0-9-]{1,40})\/mcp$/;
const isLoopback = (hostname) => hostname === 'localhost' || hostname === '127.0.0.1';

// `irm` sends WindowsPowerShell/5.1.x (Windows PowerShell) or PowerShell/7.x.
// Chat link previews (Slack, Teams, WhatsApp, Telegram) fetch with a plain GET
// and their own User-Agent. This keeps them from burning the one-time code. It
// is not a security check: anyone can send this header, and the code is already
// the secret.
const isPowerShellClient = (request) => (request.headers.get('user-agent') || '').includes('PowerShell/');

async function handleJ(request, env, url, origin, agentText, appBundle) {
  // `?client=app` (or its alias `legacy`) is the downloaded Windows app. Any
  // other `client` value is not a link this relay hands out.
  const hasClient = url.searchParams.has('client');
  const app = clientMode(url.searchParams.get('client')) === 'app';
  // The PowerShell script is fetched and consumed by a single GET. The app link
  // shows a page on GET and is consumed only by the same-origin form POST.
  if (request.method !== 'GET' && !(app && request.method === 'POST')) {
    return psText(request.method === 'HEAD' ? null : METHOD_NOT_ALLOWED_SCRIPT, 405, { allow: app ? 'GET, POST' : 'GET' });
  }
  // The script and the app both carry the attach key and run the whole session
  // over `origin`, so refuse plain http before the code is used.
  if (url.protocol !== 'https:' && !isLoopback(url.hostname)) {
    return app ? psText(USE_HTTPS_TEXT, 403) : psText(USE_HTTPS_SCRIPT, 200);
  }
  let code;
  try {
    code = decodeURIComponent(url.pathname.slice(3));
  } catch (_) {
    return app ? appPage(url, 'ended', '', 404) : psText(INVALID_LINK_SCRIPT, 404);
  }
  if (hasClient && !app) return psText(INVALID_LINK_SCRIPT, 404);
  if (!/^[a-z2-7]{16}$/.test(code) || (app && !appBundle)) {
    return app ? appPage(url, 'ended', '', 404) : psText(INVALID_LINK_SCRIPT, 404);
  }
  if (app) {
    const id = env.SESSION.idFromName(code);
    const stub = env.SESSION.get(id);
    const page = async () => {
      const status = await (await stub.fetch('https://do/status?log_tail=0')).json();
      return appPage(url, status.windows_mode === 'app' ? status.state : 'ended', id.toString());
    };
    // A button click on our own page is same-origin. Browsers send Origin on it,
    // and it must match exactly. A few older ones (IE11 on Windows 7) omit Origin
    // on a same-origin form POST. Without Origin, accept only a Referer from our
    // own /j/ page, which the page's Referrer-Policy: same-origin keeps on the
    // click. Anything else gets 403 and the code stays unused.
    const fromOurPage = () => {
      const originHeader = request.headers.get('origin');
      if (originHeader !== null) return originHeader === origin;
      return (request.headers.get('referer') || '').startsWith(`${origin}/j/`);
    };
    if (request.method === 'POST' && !fromOurPage()) {
      return new Response('Open the support page and click the download button.', { status: 403, headers: noStore });
    }
    if (request.method === 'GET') return page();
    const r = await stub.fetch('https://do/consume', { method: 'POST', body: JSON.stringify({ windows_mode: 'app' }) });
    const out = await r.json();
    if (!out.ok) return page();
    let body;
    try {
      // startup_ms is what is left of the first-connect window now. The app counts
      // it on its own clock, so a PC clock that is wrong cannot end it early.
      body = buildAppDownload(appBundle, {
        sid: id.toString(), key: out.key, origin,
        startup_expires_at: out.startup_expires_at,
        startup_ms: Math.min(7200000, Math.max(1, out.startup_expires_at - Date.now())),
      });
    } catch (_) {
      return appPage(url, 'ended', '', 404);
    }
    return new Response(body, {
      headers: {
        ...noStore,
        'content-type': 'application/octet-stream',
        'x-content-type-options': 'nosniff',
        'content-disposition': `attachment; filename="remote-support-${id.toString().slice(0, 8)}.exe"`,
      },
    });
  }
  // A GET that is not from PowerShell (a link preview) must not consume the code.
  if (!isPowerShellClient(request)) return psText(NOT_POWERSHELL_SCRIPT, 200);
  const id = env.SESSION.idFromName(code);
  const r = await env.SESSION.get(id).fetch('https://do/consume', { method: 'POST', body: JSON.stringify({ windows_mode: 'powershell' }) });
  const out = await r.json();
  if (!out.ok) return psText(INVALID_LINK_SCRIPT, 404);
  let script;
  try {
    script = buildBootstrap(agentText, { sid: id.toString(), key: out.key, origin });
  } catch (_) {
    return psText(INVALID_LINK_SCRIPT, 404);
  }
  return psText(script, 200);
}

const AGENT_BODY_MAX = 750000;

// The downloaded app's transport: authenticated HTTPS long polling.
async function handleAgent(request, env, url) {
  if (url.protocol !== 'https:' && !isLoopback(url.hostname)) return json({ error: 'https required' }, 403);
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405, { allow: 'POST' });
  // The attach key travels only in the X-Attach-Key header, never the URL, and
  // the app is not a browser, so any Origin header means a cross-site request.
  if (request.headers.has('origin') || url.searchParams.has('key')) return json({ error: 'forbidden' }, 403);
  if (!isJsonContentType(request)) return json({ error: 'unsupported media type' }, 415);
  const sid = url.searchParams.get('sid') || '';
  if (!/^[0-9a-f]{64}$/.test(sid)) return json({ error: 'unauthorized' }, 401);
  // Limit input before forwarding to the DO. The largest allowed result is one
  // base64 file chunk plus its envelope.
  // Refuse on the declared length before reading anything. A body with no
  // Content-Length is checked again after it is read.
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > AGENT_BODY_MAX) return json({ error: 'request too large' }, 413);
  const body = await request.text();
  if (body.length > AGENT_BODY_MAX) return json({ error: 'request too large' }, 413);
  let id;
  try { id = env.SESSION.idFromString(sid); } catch (_) { return json({ error: 'unauthorized' }, 401); }
  const r = await env.SESSION.get(id).fetch(new Request('https://do/agent', {
    method: 'POST',
    headers: { 'X-Attach-Key': request.headers.get('X-Attach-Key') || '', 'content-type': 'application/json' },
    body,
  }));
  return new Response(r.body, { status: r.status, headers: { 'content-type': 'application/json', ...noStore } });
}

function handleWs(request, env, url) {
  // Never carry the attach key over cleartext http (loopback dev excepted).
  if (url.protocol !== 'https:' && !isLoopback(url.hostname)) return new Response('https required', { status: 403 });
  // The attach key travels ONLY in the X-Attach-Key header; a key in the query
  // string (which lands in access logs) is refused outright.
  if (url.searchParams.has('key')) return new Response('unauthorized', { status: 401 });
  const sid = url.searchParams.get('sid') || '';
  if (!/^[0-9a-f]{64}$/.test(sid)) return new Response('unauthorized', { status: 401 });
  let id;
  try {
    id = env.SESSION.idFromString(sid);
  } catch (_) {
    return new Response('unauthorized', { status: 401 });
  }
  return env.SESSION.get(id).fetch(new Request(`https://do/ws?sid=${sid}`, request));
}

// A missing or failed credential on an MCP address is 401, with a challenge that
// points an MCP client at this address's protected resource document, so it can
// find the authorization server and sign in. `invalid` is a token that was sent
// and failed (expired, revoked, for another address, malformed).
function unauthorized(issuer, workspace, invalid) {
  return json({ error: invalid ? 'invalid_token' : 'unauthorized' }, 401, {
    'www-authenticate': challengeHeader(issuer, workspace, { invalid }),
    'cache-control': 'no-store',
  });
}

async function handleMcp(request, env, url, origin, devTtlMs, workspace = DEFAULT_WORKSPACE, oauth = null) {
  // CSRF: the Access app also admits a browser identity (cookie). MCP clients
  // never send Origin; browsers always do on cross-origin POST. Refuse it, and
  // require a JSON content type (a form post cannot set one without CORS).
  if (request.headers.has('origin')) return json({ error: 'forbidden' }, 403);
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405, { allow: 'POST' });
  if (!isJsonContentType(request)) return json({ error: 'unsupported media type' }, 415);
  // Who is calling. An OAuth bearer token, when OAuth is set up and one is
  // sent, is checked for exactly this address and nothing else is tried: a
  // failure is a 401, not a fall back to the Access path. Without a bearer, an
  // Access login, a service token or the local bypass works as it always has.
  const oauthOn = oauth ? oauth.available(env, url) : null;
  const bearer = oauthOn ? bearerToken(request) : null;
  let actor;
  let oauthCaller = null;
  if (bearer !== null) {
    const checked = await oauth.checkBearer(env, oauthOn.origin, workspace, bearer);
    if (checked.unavailable) return json({ error: 'temporarily_unavailable' }, 503, { 'retry-after': '60', 'cache-control': 'no-store' });
    if (!checked.ok) return unauthorized(oauthOn.origin, workspace, true);
    oauthCaller = checked;
    actor = checked.email;
  } else {
    actor = await accessCaller(request, env, url, { mcp: true });
    if (!actor) return unauthorized(oauthOn && oauthOn.origin, workspace, false);
  }
  // ?ui=0|1 picks this connection's tools. The old ?shape parameter is a 400.
  let options;
  try {
    options = parseToolOptions(url.searchParams);
  } catch (e) {
    return json({ error: e.message }, 400);
  }
  let msg;
  try {
    msg = await request.json();
  } catch (_) {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }, 200);
  }
  // Roles are checked on tools/call only. tools/list, initialize and ping never
  // touch the team database.
  const toolName = msg && msg.method === 'tools/call' && msg.params ? msg.params.name : undefined;
  const backend = authorizedBackend(makeBackend(env, origin, devTtlMs, actor, workspace), env, actor, toolName, workspace, oauthCaller);
  const { status, body } = await handleRpc(msg, backend, options);
  if (body === null) return new Response(null, { status });
  return json(body, status);
}

// An OAuth route that cannot reach the database or KV answers 503, not a crash.
async function oauthRoute(serve) {
  try {
    return await serve();
  } catch (_) {
    // Nothing is logged: an error here may carry a token or an address.
    return json({ error: 'temporarily_unavailable' }, 503, { 'cache-control': 'no-store', 'retry-after': '30' });
  }
}

// options: oauth is the OAuth library's classes ({ OAuthAuthorizationServer,
// AuthorizationError, CimdFetchError }), passed in by src/index.js so this file
// never imports a module Node cannot load. Without it OAuth is off and the MCP
// addresses admit only Access logins, service tokens and the local bypass.
// For tests: fetch replaces the network for the sign-in providers and the mail
// provider; mailer replaces the one chosen by MAIL_PROVIDER (null = none);
// oauthTuning sets how long OAuth keeps its list of workspace addresses.
export function createHandler(agentText, appBundle = null, options = {}) {
  const oauth = options.oauth ? createOAuth(options.oauth, options.oauthTuning) : null;
  return {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      const p = url.pathname;
      // The agent derives its ws:// or wss:// URL from this origin, so any real
      // host is pinned to https. Only loopback dev keeps whatever it arrived on.
      const origin = isLoopback(url.hostname) ? `${url.protocol}//${url.host}` : `https://${url.host}`;
      const devTtlMs =
        localBypassAllowed(env, url.hostname) && env.SESSION_TTL_MS ? Number(env.SESSION_TTL_MS) : 0;

      if (p === '/healthz') return json({ ok: true, service: 'support-mcp', stage: 'relay-v1', version: VERSION });
      if (p.startsWith('/j/')) return handleJ(request, env, url, origin, agentText, appBundle);
      if (p === '/agent') return handleAgent(request, env, url);
      if (p === '/ws') return handleWs(request, env, url);
      if (p === '/mcp') return handleMcp(request, env, url, origin, devTtlMs, DEFAULT_WORKSPACE, oauth);
      // /w/<slug>/mcp is the same endpoint for another workspace. A slug that is
      // not well formed is an unknown route; a well-formed one that was never
      // created is answered per tool call, so tools/list stays static.
      // default has one address, /mcp, so /w/default/mcp is unknown too.
      const wm = WORKSPACE_MCP.exec(p);
      if (wm && wm[1] !== DEFAULT_WORKSPACE) return handleMcp(request, env, url, origin, devTtlMs, wm[1], oauth);
      // OAuth: the authorization server's own addresses and the protected
      // resource documents. They answer 404 when OAuth is not set up.
      if (p === AS_METADATA_PATH || p === TOKEN_PATH || p === REGISTER_PATH) {
        if (!oauth) return new Response('not found', { status: 404 });
        return oauthRoute(() => oauth.serveServer(request, env, ctx, url));
      }
      if (p === PROTECTED_RESOURCE_PREFIX || p.startsWith(`${PROTECTED_RESOURCE_PREFIX}/`)) {
        if (!oauth) return new Response('not found', { status: 404 });
        return oauthRoute(() => oauth.serveResourceMetadata(request, env, url));
      }
      // Sign-in and the account page are for browsers, so they have their own
      // origin and form-token checks (src/auth.js). /mcp and /api stay as above.
      if (p === '/auth' || p.startsWith('/auth/') || p === '/account' || p.startsWith('/account/') || p === '/oauth/authorize') {
        return handleAuth(request, env, url, {
          fetchFn: options.fetch,
          mailer: options.mailer,
          oauth,
          waitUntil: ctx && typeof ctx.waitUntil === 'function' ? (promise) => ctx.waitUntil(promise) : undefined,
        });
      }
      if (p === '/api' || p.startsWith('/api/')) return handleApi(request, env, url, { accessCaller, isJsonContentType });
      return new Response('not found', { status: 404 });
    },
  };
}
