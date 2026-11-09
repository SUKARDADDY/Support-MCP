# relay v1: build spec

The wire contract and acceptance criteria the relay was built against: relay
Worker + Durable Objects, two Windows clients (a downloaded .NET app and a
PowerShell agent), three-layer teardown, MCP endpoint.
Code signing is out of scope. `irm | iex` content carries no Mark of the Web,
so SmartScreen does not apply to the PowerShell agent. The downloaded app is an
unsigned executable, so Windows SmartScreen shows "Windows protected your PC"
until the deployer signs it.

## Windows modes

A session is created in one of two modes, fixed for its life. `session_status`
reports the canonical name as `windows_mode`.

| `windows_mode` | Customer does | Clients | Transport |
|---|---|---|---|
| `app` (default) | opens a link, clicks a button, runs the downloaded `remote-support-<sid8>.exe`, clicks Allow and then Yes in the UAC prompt (or Allow for limited support) | Windows 7 to 11 with .NET Framework 4.5.2 or later (Windows 10 and 11 include it; 8.1 needs the 4.5.2 update; 7 needs it installed). The app requests TLS 1.2 itself; Windows 7 needs no registry change | HTTPS polling on `POST /agent` |
| `powershell` | pastes `irm <link> \| iex` | Windows 8 and later, Windows PowerShell 5.1 | WebSocket on `/ws` |

`legacy` is accepted as an alias for `app` and `standard` for `powershell`, in
`session_create` and in the `?client=` query on a `/j` link (`app` and
`legacy` only; the PowerShell link has no `client` parameter). Any other value
is rejected, and the relay only ever stores and reports the canonical name.
A code minted for one mode cannot be used up by the other client, and a session
refuses the other mode's transport (`/ws` for an `app` session, `/agent` for a
`powershell` session) with 401.

## Design choices

- **Pairing code is 16 chars of base32 (80 bits), not 6 digits.** The customer
  pastes the one-liner, never types the code, so length costs nothing and it
  removes brute force. Still single use, 10 min TTL.
- **The MCP server is the Worker itself** (`POST /mcp`, streamable-HTTP JSON
  responses). No local wrapper process. Claude Code connects with the Access
  service-token headers. `/mcp` serves the `default` workspace, and
  `/w/<slug>/mcp` serves any other, through the same handler.

## Components

| Path | What |
|---|---|
| `src/index.js` | Worker entry: imports `agent.ps1` and `app-bundle.json`, wires `src/app.js`, exports the DO classes |
| `src/app.js` | router, Access gate, MCP JSON-RPC handler, download page (pure: no `.ps1` import, DO classes or OAuth library, so `node --test` can drive routes) |
| `src/oauth.js` | OAuth for MCP clients: builds the library's authorization server from the workspace list, serves the protected resource documents, checks a bearer token for one MCP address, revokes a person's grants (never imports the library; `src/index.js` passes it in) |
| `src/session.js` | `Session` Durable Object (SQLite-backed), one per session |
| `src/screen.js` | the screen vocabulary: lanes, the normalized actions, their audit text, and the strict check of every app result field (pure, shared by `mcp.js` and `session.js`) |
| `src/registry.js` | `Registry` Durable Object, one instance per workspace: `idFromName("registry")` for `default` and `idFromName("registry:<slug>")` for any other. Lists that workspace's sessions |
| `src/permissions.js` | the permission keys, the built-in roles, and the permission each MCP tool needs (pure data) |
| `src/workspace.js` | team data in D1: members, roles, recent callers, the chained team log and `authorize`. All team SQL is here, and every query filters by workspace |
| `src/api.js` | the team API under `/api/v1/w/<slug>/`, plus `POST` and `GET /api/v1/w` |
| `src/agent.js`, `src/agent-api.js`, `src/agent-store.js`, `src/agent-models.js` | the built-in agent: its service (settings, models, tasks), its team API routes, its D1 queries, and its model table and cost arithmetic. See [The built-in agent](#the-built-in-agent) |
| `src/agent-task.js`, `src/agent-providers.js`, `src/agent-check.js`, `src/agent-tools.js` | the `AgentTask` Durable Object (one per task, and one per model check), the OpenAI and Claude adapters, the two-turn model check, and the tool list the model sees |
| `migrations/0006_agent.sql` | the D1 tables `agent_settings` and `agent_tasks` |
| `migrations/0001_team.sql`, `migrations/0002_workspaces.sql` | the D1 tables `members`, `roles`, `callers` and `audit`, each keyed by workspace first; then `workspaces` (one row per workspace other than `default`) and the index `members_by_identity`. `wrangler d1 migrations apply` runs them in name order, and so does `test/d1-fake.js` |
| `src/agent.ps1` | PowerShell agent template (imported as text, placeholders substituted) |
| `src/agent-app.cs`, `src/agent-app.manifest` | the Windows app: .NET Framework 4 source (WPF window) and an `asInvoker` manifest |
| `src/app-bundle.json` | the compiled x86 app plus the SHA-256 of its source and manifest, built by `scripts/build-app.ps1` and checked by tests |
| `scripts/prepare-app-restart.ps1` | optional one-time reconnect after an authorized restart |
| `test/` | `npm test` (`node --test` with the `cloudflare:workers` stub in `test/stubs/`) unit tests for pure logic (JWT checks, MCP dispatch, template fill, screen validation) and for the Durable Object (lanes, screen and control frames, audit rules) |

`wrangler.toml`: add DO bindings `SESSION` → `Session`, `REGISTRY` → `Registry`,
`AGENT_TASK` → `AgentTask`,
`[[migrations]] tag="v1" new_sqlite_classes=["Session","Registry"]` and
`tag="v2" new_sqlite_classes=["AgentTask"]` (free plan
needs SQLite-backed DOs), `[[rules]] type="Text" globs=["**/*.ps1"]`, and
`[vars] ACCESS_TEAM_DOMAIN="<team>.cloudflareaccess.com"`,
`ACCESS_AUD="<Access app AUD tag>"`, `ACCESS_MCP_AUD=""` (the optional second Access app that covers the MCP addresses when OAuth is on), `DEPLOYMENT_ADMINS=""` (comma-separated
identities allowed to add `default`'s first member and to create workspaces;
empty lets any caller add `default`'s first member and lets nobody create a
workspace), and
`[[d1_databases]] binding="DB" database_name="support-mcp" database_id="<id>"
migrations_dir="migrations"`. There is no Durable Object migration for teams. Keep the custom-domain route. Free plan: 10 ms CPU per request, so no heavy
work in the request path; use the WebSocket Hibernation API
(`ctx.acceptWebSocket`) and a DO alarm for expiry.

## HTTP surface

| Route | Auth | Behaviour |
|---|---|---|
| `GET /healthz` | public | `{"ok":true,"service":"support-mcp","stage":"relay-v1","version":"<release>"}` (`stage` names this API generation, `version` the release, see [Versions](development.md#versions-and-releases)) |
| `GET /j/<code>` | public | **GET only, https only.** The code is consumed only for a request whose `User-Agent` contains `PowerShell/` (`irm` sends `WindowsPowerShell/5.1.x` or `PowerShell/7.x`). Code valid+unused → 200 `text/plain` agent script with placeholders filled, code consumed; else 404 `text/plain` `Write-Host 'This support link is invalid or expired.'` (runnable, harmless). Any other `User-Agent` (a chat link preview, a browser) → 200 `text/plain`, `Cache-Control: no-store`, a one-line `Write-Host` telling the reader to paste the command into PowerShell, and the Durable Object is **not** touched. Over plain `http:` on any host except `localhost` / `127.0.0.1` → 200 `text/plain` `Write-Host` line asking for the https link, code **not** consumed. Any other method → 405 `text/plain` (harmless one-liner, `Allow: GET`) and the code is **not** consumed. Malformed percent-encoding → the same harmless 404 script, never 500. The `User-Agent` test keeps previews from burning the code. It is not a security control, since any client can send the header. |
| `GET /j/<code>?client=app` | public | The downloaded app. `legacy` is an alias for `app`; any other `client` value → 404. **https only**: over plain `http:` on any host except `localhost` / `127.0.0.1` → 403 `text/plain`, code **not** consumed. `GET` serves the download page (200 `text/html`, `Cache-Control: no-store`, `Referrer-Policy: same-origin`, a CSP with `default-src 'none'` and `form-action 'self'`) and **never consumes the code**, however often the page is opened or refreshed. Only a `POST` from the page's button consumes it. If the request has an `Origin` header it must equal the relay's own origin exactly. If it has none (IE11 on Windows 7 can omit it on a same-origin form POST), its `Referer` must start with `<origin>/j/`, which the page's `Referrer-Policy: same-origin` keeps on the click. A foreign `Origin`, a foreign or missing `Referer` without an `Origin`, or neither header → 403, code unused. A first valid `POST` returns 200 `application/octet-stream` with `Content-Disposition: attachment; filename="remote-support-<sid8>.exe"`: the compiled app followed by the session configuration (below). The code is single use: a repeat after the download shows "Check your downloads" (409), an expired or ended one shows "This support link has expired" (410). A code made for a `powershell` session shows the expired page and stays unused. `HEAD` and every other method → 405 (`Allow: GET, POST`). |
| `POST /agent?sid=<sid>` + `Authorization: Bearer smd1...` | device key | The same transport for a saved PC's session ([below](#saved-pc-sessions)). The Worker checks the key against the database on every request and lets the PC into one session only: the one its record points at (`session.id` equal to `sid`), else 401. It sends no `X-Attach-Key`, and none is forwarded. Any `Authorization` header selects this path. Everything else in the next row applies. |
| `POST /agent?sid=<sid>` + `X-Attach-Key: <key>` | attach key | The app's transport, JSON in and out; below. 403 over plain `http:` on any host except `localhost` / `127.0.0.1`, 403 on any `Origin` header or a `key` query param, 405 on other methods, 415 on a non-JSON body, 413 over 750,000 characters (checked against `Content-Length` before the body is read, and again after it is read when there is no `Content-Length`), 401 on a bad sid, bad key, a `powershell` session or a session that is still `pending`, 409 on a stale generation, 410 when the session has ended. |
| `GET /install[?code=<code>\|?workspace=<slug>]`, `POST /install[...]` | public | The setup download for a saved PC ([below](#the-install-page-install)). `GET` shows the page and never downloads. `POST` from the page returns `support-setup.exe` with a device footer. A saved PC downloads its updates here too, with the same `POST`. Not under any Access app |
| `GET /ws?sid=<sid>` + `X-Attach-Key: <key>` | attach key | WebSocket upgrade for the agent; 403 over plain `http:` on any host except `localhost` / `127.0.0.1`; 401 on bad/missing key, on a `key` query param, on a bad sid, or on an `app` session; 410 if session ended/expired |
| `POST /mcp` | Access JWT or OAuth token | MCP JSON-RPC 2.0 for the `default` workspace. `tools/call` checks the caller's role first (below) |
| `POST /w/<slug>/mcp` | Access JWT or OAuth token | the same endpoint for workspace `<slug>` (`[a-z0-9-]{1,40}`). Any other shape of path is 404 |
| `GET /.well-known/oauth-authorization-server`, `POST /oauth/token`, `POST /oauth/register` | none | the OAuth authorization server (the library's `OAuthAuthorizationServer`); 404 without the `OAUTH_KV` binding |
| `GET /.well-known/oauth-protected-resource[/mcp\|/w/<slug>/mcp]` | none | RFC 9728 documents; 404 for a workspace that does not exist |
| `GET`, `POST /oauth/authorize` | browser sign-in | the consent page; see [OAuth](#oauth-for-mcp-clients) |
| `/api/v1/w/<slug>/...` | Access JWT | the team API (below) |
| `POST /device/pair`, `/device/hello`, `/device/update`, `/device/leave` | none (pair) or a device key in `Authorization: Bearer` | the PC wire for saved PCs ([below](#the-pc-wire-device)). Public: not under any Access app. 403 over plain `http:` except loopback, 405 other methods, 403 on any `Origin` header, 400 on `?key=` or `?code=`, 415 non-JSON, 413 over 8 KB |
| `GET /device/ring?protocol=1` | a device key in `Authorization: Bearer` | the doorbell, a WebSocket upgrade ([below](#the-doorbell)). Public, with the refusals of the PC wire |
| `GET`, `POST`, `DELETE /api/v1/w/<slug>/stop` | Access JWT | read, set and clear a workspace's stop ([below](#stop-and-resume)) |
| `POST /api/v1/w`, `GET /api/v1/w` | Access JWT | create a workspace, list yours (below) |
| `GET /auth/signin`, `GET /auth/google`, `GET /auth/microsoft`, `GET /auth/<provider>/callback`, `POST /auth/email`, `GET` and `POST /auth/email/confirm`, `GET` and `POST /auth/factor`, `POST /auth/signout`, `GET /account`, `POST /account/signout-everywhere` | none, then a browser sign-in | people sign in; see [Sign-in](#sign-in-auth-and-account) |
| anything else | — | 404 |

`<sid>` = the Session DO's hex id (`idFromName(code)`); the code is the DO name.
`<key>` = 32 random bytes hex, minted when `/j/<code>` is consumed; the DO stores
only its SHA-256. **The attach key travels only in the `X-Attach-Key` request
header** (never the query string, which lands in access logs); a request that
puts `key` in the query is rejected 401. The script embeds `sid`, `key`,
`origin`: `https://<host>` for every host except `localhost` / `127.0.0.1`,
where it is the scheme+host of the request so local dev works over http (the
agent derives its `ws://` or `wss://` URL from it, so a real host never runs
over cleartext); `expires_at` is NOT known yet (set on attach) and the agent
persists it to `config.json` on welcome. The served script is wrapped in `& { … }` so nothing leaks into the
customer's console.

The downloaded app embeds the same `sid`, `key` and `origin`, plus
`startup_expires_at` and `startup_ms`, as a JSON footer on its own executable: the configuration
bytes, their length as a little-endian `uint32`, then the magic string
`SUPPORTMCPCFG1`. Every value is validated before it is written (hex, hex, an
`http(s)` origin, a positive integer; `startup_ms` is an integer from 1 to 7,200,000). The attach key is in the file the
customer downloads and never in a URL or a command line. The app itself
refuses any origin that is not `https`, except loopback for local testing.

`startup_ms` is the first-connect budget left when the file was downloaded. The
app counts it on its own clock from the moment it starts, so a PC whose clock is
wrong cannot make it stop at once. `startup_expires_at` is the same deadline in
the relay's Unix milliseconds. The app reads it only when `startup_ms` is
missing. The relay enforces the 2 h limit itself, whatever the app does. The
24-hour limit reaches the app as `expires_at` and `server_time` in the `welcome`
reply. The app uses their difference, counted on its own clock, and shows "Ends
by itself" as the PC's own clock plus that remaining time.

## Access check (`/mcp` and `/w/<slug>/mcp`)

Both addresses run one handler, in this order, so the checks below are the same on both. Each accepts **POST only** (else 405, `Allow: POST`). Because the Access app
also admits a browser (cookie) identity, guard against CSRF first, before the
credential check:

- any request carrying an `Origin` header → 403 (MCP clients never send Origin;
  browsers always do on a cross-origin POST). Applies even under the local bypass.
- a non-`application/json` `Content-Type` → 415.

Then the credential. If OAuth is on (the library is loaded, `OAUTH_KV` is bound
and the issuer address is known) and the request has an `Authorization: Bearer`
header, that token is checked (below) and nothing else is tried. Otherwise
require header `Cf-Access-Jwt-Assertion`. Verify RS256 against
`https://<ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs`, `aud` contains `ACCESS_AUD`
(or `ACCESS_MCP_AUD` when that var is set and non-empty; MCP addresses only, never
the team API), `exp` in the future, `nbf` (if present) not in the future beyond 60 s of skew,
`iss` = `https://<ACCESS_TEAM_DOMAIN>`. Failure, or no credential at all → 401
JSON `{"error":"unauthorized"}` with `WWW-Authenticate: Bearer
resource_metadata="<origin>/.well-known/oauth-protected-resource<path>"` (`<path>`
is `/mcp` or `/w/<slug>/mcp`; plain `Bearer` when OAuth is off).
The signing keys are cached in module scope for 1 h, one entry per key address
(`src/jwt.js`, shared with Google and Microsoft sign-in), and fetched lazily (only once
a well-formed token names a `kid`); an unknown `kid` forces one refetch that
**bypasses the edge cache** (`cache:'no-store'`) and is rate-limited to at most
one per 60 s per address. Local bypass: only when `env.DEV_SKIP_ACCESS === "1"` (set from
`.dev.vars`, never committed) **and** the request URL hostname is `localhost` or
`127.0.0.1`. The deployed hostname can never satisfy it.

A bearer token is checked with the library's `validateToken` for exactly this
address, which reads one KV key. Expired, revoked, malformed, unknown, or issued
for another address → 401 with `error="invalid_token"` added to the header. A KV
failure → 503 with `Retry-After`. A token whose grant has no `email`, `user_id`
and matching `workspace` is also a 401. `tools/list`, `initialize` and `ping`
need a credential like any call, and with a token read KV once and nothing else.
The caller is the grant's person (`props.email`) and each `tools/call` also
checks, live, that the person exists and is not disabled, is still invited, is
a member of the workspace (open mode never admits an OAuth caller), and, for a
permission that needs a second factor, that the grant's authenticator is still the
person's. The team API (`/api/`) does not accept bearer tokens.

The caller identity — `email` (user), else `common_name` (service token), else
`sub`, or `local-dev` under the bypass — is threaded to the DO and recorded in
the audit log for `session_create`, `run`, `put_file`, `get_file`, `session_end`.
The session's own log keeps it as sent, in the `[identity] detail` form.

### Role check (`tools/call`)

`initialize`, `ping`, `tools/list` and every refusal above never read team
data, so `tools/list` answers the same 27 tools on any well-formed
`/w/<slug>/mcp`, created or not, without touching D1 or a Durable Object. On
`tools/call` for a listed tool, after the `session_id` check, the relay checks
that the workspace exists (`default` always does; any other slug needs a row in
`workspaces`, else the tool error `workspace not found`, whoever asks). It then
looks up the tool's permission in `src/permissions.js` and asks
`authorize(<workspace>, identity, permission)` before the tool's backend runs.
The workspace comes from the address the request arrived on. The identity is
trimmed and lowercased. `authorize` gets only the permission key, never the
tool's arguments.

| Tool | Permission |
|---|---|
| `session_create` | `sessions.create` |
| `session_list`, `session_status` | `sessions.view` |
| `session_end` | `sessions.end` |
| `device_list` | `devices.view` |
| `device_connect` | `sessions.control`, and `sessions.unattended` inside the tool when the session will not ask or the call is a take-over |
| `agent_status` | `sessions.view`, members only |
| `agent_start`, `agent_control` | `sessions.control`, members only |
| every other tool | `sessions.control` |

- No members in `default` (open): allowed, and the caller is recorded in
  `callers` with the time. Open mode is `default`'s alone. A created workspace
  with no members, which the rules never produce, is closed: every caller gets
  `you are not a member of this team`.
- Not a member: tool error `you are not a member of this team`.
- A member whose role lacks the permission: tool error
  `your role does not allow <permission>`.
- No `DB` binding: tool error `the team database (DB) is not configured`.

After the role check, and before the tool runs, the relay refuses the call when
the workspace is stopped (below): the tool error `this workspace is stopped;
someone who can manage members must resume it`. A caller who is not a member
never learns this. `EMERGENCY_STOP` is checked first of all, before any database
read, and refuses every call whoever asks: `this relay is stopped by its
operator`. `tools/list` is static and still answers.

The three agent tools are for real members only, by a flag on the tool: open
mode never admits a caller to them, and they never record a caller of the open
workspace. After the stop checks, `/mcp` reads the workspace's agent mode (one
`agent_settings` read, only for a tool that is not one of the allowed ones
below). In mode `agent` (built-in agent only) every session tool is refused with
the tool error `this team uses the built-in agent`, except `agent_start`,
`agent_status`, `agent_control`, `device_list`, `session_list` and
`session_status`. The mode is read after the role check, so a caller who is not a
member learns nothing about it. A workspace with no `agent_settings` row, or a
database without the table yet ("no such table"), is in mode `both`. Any other
database error while reading the mode refuses the call (it fails closed), with the
tool error `could not check whether this team uses the built-in agent; try again`. The built-in agent's own calls
go through the same checks but not this one, so the mode never blocks it.

A refusal is a tool error (`isError`), and nothing reaches a Session.
`session_create` sends `workspace: "<slug>"` to `/create`, and the operator
calls send it to `/command` and `/end` in the body and to `/status` as
`?workspace=<slug>`. The Session stores `workspace` at create (default
`default`; anything but `[a-z0-9-]{1,40}` is a 400). When an operator call names
a workspace other than the stored one (a session with none stored counts as
`default`), the Session answers exactly as for a session that does not exist:
`/status` gives `state: "unknown"` with every other field empty, `/command`
gives `{ok:false, error:"session ended"}`, `/end` gives `{ended:true}`, and
nothing changes. Calls that name no workspace (the download page's `/status`,
`/consume`, `/agent`, `/ws`) skip the check.

`session_list` reads the Registry object of the caller's workspace:
`idFromName("registry")` for `default` and `idFromName("registry:<slug>")` for
any other. A Session reads its stored workspace in `pushRegistry` and pushes to
that object, so sessions made before workspaces existed (no workspace stored)
stay in `default`'s list. The push order, and accepting the socket before the
first-attach push, are unchanged.

## Team API (`/api/v1/w/<slug>`)

The same gate as `/mcp`, before any database access: an `Origin` header → 403
`{"error":{"code":"forbidden",...}}` (also under the local bypass); `POST`,
`PATCH` and `DELETE` need `Content-Type: application/json` → else 415
`unsupported_media_type`; methods other than `GET`, `POST`, `PATCH`, `DELETE` →
405; then the Access JWT, failure → 403 `forbidden`. The slug `default`
always exists. Any other slug exists once it has a row in `workspaces`. A slug
that does not, or is malformed, is 404 `not_found` before any permission is
looked at, and so is any other unknown path. Bodies are JSON objects of at most
16,384 characters (32,768 on the customer, site and device routes, which carry
custom fields). Every answer is JSON with `Cache-Control: no-store`, and every
error is `{"error":{"code","message"}}`.

| Route | Needs | Body | Answer |
|---|---|---|---|
| `POST /api/v1/w` | a deployment admin | `{slug, name}` | 201 `{workspace:{slug,name,role_id:"admin",created_by,created_at}}`. One batch writes the `workspaces` row, the caller as an admin member, and the log rows `workspace_created` then `member_added`. `slug` matches `[a-z0-9-]{1,40}` and is not `default`; `name` is 1 to 100 characters. With `DEPLOYMENT_ADMINS` empty: 409 `no_deployment_admins`. A caller not listed: 403 `forbidden`. A taken slug, and `default`: 409 `workspace_exists`. With 500 workspaces already created: 409 `workspace_limit` |
| `GET /api/v1/w` | any caller | | `{workspaces:[{slug,name,role_id}]}`: `default` first when it is open (`role_id` is `null`, as in `me`) or the caller is a member of it, then the other workspaces the caller is a member of, by slug. `default`'s name is `Default` |
| `GET /api/v1/w/<slug>` | any member, anyone while open | | `{workspace:{slug,open}, me:{identity,role_id,permissions}, recent_callers?}`; `recent_callers` (`[{identity,last_seen,kind}]`, newest first, at most 50) only while open; `role_id` is `null` while open |
| `GET .../members` | `members.manage` | | `{members:[{identity,kind,name,role_id,added_at,added_by}]}` |
| `POST .../members` | `members.manage` | `{identity, name?, role_id}` | 201 `{member}` |
| `PATCH .../members/<identity>` | `members.manage` | `{name?, role_id?}` | `{member}` |
| `DELETE .../members/<identity>` | `members.manage` | | `{removed:{identity}}` |
| `GET .../roles` | `roles.manage` or `members.manage`, anyone while open | | `{roles:[{id,name,permissions,builtin,editable}]}` |
| `POST .../roles` | `roles.manage` | `{id, name?, permissions}` | 201 `{role}` |
| `PATCH .../roles/<id>` | `roles.manage` | `{name?, permissions?}` | `{role}` |
| `DELETE .../roles/<id>` | `roles.manage` | | `{removed:{id}}` |
| `GET .../audit?after=&limit=&verify=` | `audit.view` | | `{rows:[{seq,ts,actor,kind,detail,prev_hash,hash}], head:{seq,hash}, verified, verified_scope}`; rows with `seq > after` (default 0), at most `limit` (1 to 500, default 100). `verify` is left out or empty (check the returned rows only, `verified_scope: "page"`) or `full` (check the whole chain, `"full"`); any other value is 400, and a repeated parameter uses its first value |

| `GET .../agent`, `PATCH .../agent` | `members.manage` | `{mode?, default_model?, starters_pick_model?, task_cap_usd?, month_cap_usd?, openai_key?, anthropic_key?}` | `{agent:{...}}`: the settings, with each key shown only as `{set, hint}` (its last four characters). See [The built-in agent](#the-built-in-agent) |
| `POST .../agent/models`, `DELETE .../agent/models/<provider>/<id>` | `members.manage` | `{provider, id, prices?, output_limit?}` | 201 `{model, checked, check_cost_usd?}`; `{removed:true}` |
| `GET .../agent/tasks`, `POST .../agent/tasks` | `sessions.view`, `sessions.control`; members only | `{device_id \| session_id, instructions, keep_working?, model?}` | `{tasks:[...]}`; 201 `{task_id, state, ...}` |
| `GET .../agent/tasks/<id>?wait_s=`, `POST .../agent/tasks/<id>/pause\|resume\|stop` | `sessions.view`, `sessions.control`; members only | | `{task, caps, untrusted_text}`; `{task_id, state}` |

`<identity>` is URL-encoded and compared trimmed and lowercased. A member's
`kind` is `service` when the identity has no `@`, else `person`. Identities are
at most 200 characters with no spaces; names at most 100 characters with no
control characters. Role ids match `[a-z0-9-]{1,40}`. Permission keys are
`members.manage`, `roles.manage`, `audit.view`, `devices.view`,
`devices.manage`, `fields.manage`, `sessions.create`, `sessions.view`,
`sessions.control`, `sessions.end`, `sessions.unattended`. Built-in roles:
`admin` (every key, fixed), `technician` (`devices.view`, `devices.manage` and
`sessions.create`, `sessions.view`, `sessions.control`, `sessions.end`),
`viewer` (`audit.view`, `devices.view`, `sessions.view`). Only `admin` holds
`sessions.unattended` by default.

`sessions.unattended` means "connect to a PC without asking the person at it, and
switch a PC to any time". It needs a second factor like `sessions.control` does.
Open mode (a default workspace with no members) grants every `sessions.*` key
except this one, which is excluded by name, so nobody connects without asking
until a first admin is added. A workspace that
edited `technician` or `viewer` before the device keys existed keeps its stored
role without them. Because those two roles now hold more, the rule that a
non-admin hands out only what they hold means a custom role with
`members.manage` but no device keys can no longer add or change a technician or
viewer. They are not stored; a stored row overrides an
edited `technician` or `viewer`, and a deleted one keeps a row with `deleted = 1`.

| Status | Code | When |
|---|---|---|
| 400 | `bad_request` | a body that is not a JSON object, a bad identity, name, role id, permission list (an unknown key) or query value, a `PATCH` with no field |
| 400 | `unknown_role` | a member given a role that does not exist |
| 403 | `forbidden` | `Origin` header, Access refused, or a team change that breaks the escalation rules below |
| 403 | `not_member` | the workspace has members and the caller is not one, or a created workspace has none |
| 403 | `permission_denied` | the caller's role lacks the route's permission |
| 404 | `not_found` | a slug that was not created or is malformed, an unknown path, member or role |
| 409 | `no_deployment_admins` | `POST /api/v1/w` while `DEPLOYMENT_ADMINS` is empty |
| 409 | `workspace_exists` | `POST /api/v1/w` with a slug that is taken, or `default` |
| 409 | `workspace_limit` | `POST /api/v1/w` when the server already holds 500 workspaces besides `default` |
| 409 | `first_member` | in `default`: the first member is not the caller as `admin`, or `DEPLOYMENT_ADMINS` is set and the caller is not in it; or any other team write while it has no members |
| 409 | `member_exists`, `role_exists` | already there |
| 409 | `last_admin` | removing or demoting the last admin |
| 409 | `role_fixed` | creating, editing or deleting `admin` |
| 409 | `role_in_use` | deleting a role a member holds |
| 409 | `role_missing` | changing a member whose role no longer exists, other than giving them a role that exists (an admin can also remove them) |
| 400 | `unknown_customer`, `unknown_site` | a site made for, or a PC or code pointed at, a customer or site that does not exist |
| 409 | `in_use` | removing a customer that has sites, or a site that has PCs or live pairing codes |
| 409 | `customer_limit`, `site_limit`, `field_limit`, `code_limit` | 10,000 customers, 10,000 sites, 30 custom fields per record type, 20 live pairing codes |
| 409 | `pending`, `not_pending` | changing the access of a PC still waiting for approval; approving a PC that is not waiting |
| 403 | `confirm_wrong` | approving a waiting PC with a number that does not match |
| 503 | `unavailable` | a pairing or approval route when `AUTH_SECRET` is unset or under 32 characters (`Retry-After: 1`) |
| 503 | `busy` | six tries in a row lost the race to another change (`Retry-After: 1`) |

Open mode and the first-member rule below apply to `default` only. A created
workspace starts with its admin. If it ever has no members, it is closed: no
caller holds any permission, and every route that needs one is 403 `not_member`.

While `default` has no members, every caller holds only the four
`sessions.*` permissions, so `authorize` for those is as before teams existed.
`GET .../` and `GET .../roles` answer anyone; `GET .../members` and
`GET .../audit` are 403. Every write except adding the first member is 409
`first_member` ("add yourself as the first admin before changing the team"), so
nothing written while open persists into the roles that turn on later. Adding
the first member writes `member_added` and then `roles_turned_on`. Two callers
racing to add it collide on the log number; the loser retries, finds a member
and is refused `not_member`. The relay writes an open-mode caller's `last_seen`
once when new and again only when it is over 60 seconds old.

### Escalation rules

Holding `members.manage` or `roles.manage` is not enough to reach admin. Each
refusal is 403 `forbidden` with a plain `message`, and writes no log row.

- Only an `admin` member can add a member as `admin`, change anyone to or from
  `admin`, or remove an `admin`.
- Anyone else can give a member only a role whose permissions are all held by
  their own role.
- Anyone else can create a role, or edit one, only so that the role ends up
  holding no permission they lack. A rename counts: it leaves the role's
  permissions as they are, so a role holding more than the editor does can't be
  renamed by them.
- Anyone else can change a member (a rename counts), demote one or remove one
  only if that member's role holds no permission they lack. The `admin` role
  holds every permission, so it is out of reach for anyone who is not an admin,
  including a custom role that happens to hold them all. The refusal is
  "you can only change members whose role is within your own permissions" (or
  "remove"); the specific admin messages above come first where they apply.
- Anyone else can edit a role (a rename counts) or delete it only if the role's
  current permissions hold nothing they lack, so a role manager can't narrow or
  delete a stronger role. The new permissions rule above still applies to an
  edit.
- Nobody can edit or delete the role they hold.
- Nobody can change their own role. An `admin` is the exception: they can
  demote themselves, and `last_admin` (409) refuses it unless another admin
  remains.

The planning step checks these rules, and the SQL guard on the log insert checks
them again against the actor's role, the target member's role, the role being
edited or deleted, and those roles' permissions, as the plan read them. A
change that lands between the read and the commit therefore fails the guard,
and the retry gives the right 403.

A member whose stored role no longer exists holds no permissions. The planning
step answers 409 `role_missing` ("that member has a role that no longer exists;
give them a role first") to any change except giving them a role that exists,
which the usual rules allow, and except removal by an admin.

### The team log

Each change writes one row (two for the first member) of kind `member_added`,
`member_changed`, `member_removed`, `role_added`, `role_changed`,
`role_removed` or `roles_turned_on`, with `actor` the caller's identity. The
saved-device routes below add more kinds. Their actor is the technician for a
team API change, `<creator> via code` for `device_paired`, and `pc <device id>`
for a PC's own changes and requests. The last two contain a space, which no
member identity can, so no member can pass as them.
`hash` = hex SHA-256 of `prev_hash`, `seq`, `ts`, `actor`, `kind` and `detail`
joined by `\n`; the first row's `prev_hash` is 64 zeros. A change reads the log
head, checks its rules, computes the next row, then runs one `DB.batch`: the
log insert, whose `WHERE` holds the rules as SQL (for example that another
admin remains), then the change itself, which runs only if that log row went in.
A batch is atomic, so the change and its row commit together. Two writers that
read the same head collide on `PRIMARY KEY(workspace, seq)`; the loser's batch
rolls back and it starts again from a fresh read, up to five retries with a
short random wait, then `busy`. A lost log number shows as a UNIQUE or
`SQLITE_CONSTRAINT` error naming `audit`; for any other batch error the store
reads the log head again and retries if it moved since the read, else it
rethrows. A batch whose rules no longer hold also starts
again, and the fresh read gives the right 403, 404 or 409.

`verified` on a normal read (`verified_scope: "page"`) covers only the rows the
response returns. It recomputes each returned row's `hash`, checks that the
numbers run on with no gap and each `prev_hash` equals the row before, and
anchors the first returned row to the row just before it (`seq` = first `seq`
minus 1, or the 64-zero genesis hash when the first row is number 1). It also
checks that the row just after the page, when there is one, has a `prev_hash`
equal to the last returned row's `hash`, so a last row that was edited and
resealed shows. The read loads at most `limit` + 2 rows (the row before, the
page and the row after), plus the head. A missing anchor is `false`. An empty
page is `true`. An edit to a row further outside the page does not show in that
read. Only the newest row of the whole log has no row after it, so a page check
can't see that row edited and resealed; the changed `head` shows it, so note the
head. `?verify=full` (`verified_scope: "full"`) recomputes the whole chain from
row 1 (numbers 1, 2, 3 with no gap, each `prev_hash` equal to the row before,
each `hash` matching its row). An edit, removal or reordering of a row shows in
a full check unless it is among the newest entries; deleting the newest rows
still verifies, so note the `head` (`seq` and `hash`) outside the relay to catch
that.

### Customers, sites, saved PCs, custom fields and pairing codes

Reading takes `devices.view`; every change takes `devices.manage`, except custom
field definitions, which take `fields.manage`. While `default` is open the reads
are 403 `permission_denied` and the writes 409 `first_member`. Ids are 20
lowercase base32 characters (`[a-z2-7]{20}`); an id in a path that is not one is
404. A record in another workspace is 404, like a missing one. Every change is
one guarded change: the log row, the change and the actor's permission check
commit together, and a permission lost between the read and the commit is a 403.

| Route | Needs | Body | Answer |
|---|---|---|---|
| `GET .../customers?after=&limit=` | `devices.view` | | `{customers:[...], next}` |
| `POST .../customers` | `devices.manage` | `{name, phone?, email?, notes?, fields?}` | 201 `{customer}` |
| `GET`, `PATCH`, `DELETE .../customers/<id>` | `devices.view`, `devices.manage` | `PATCH`: any of the same keys | `{customer}`; `DELETE` `{removed:{id}}`, 409 `in_use` with sites |
| `GET .../sites?customer=&after=&limit=` | `devices.view` | | `{sites:[...], next}` |
| `POST .../sites` | `devices.manage` | `{customer_id, name, address?, notes?, fields?}` | 201 `{site}` |
| `GET`, `PATCH`, `DELETE .../sites/<id>` | as customers | `PATCH`: `name, address, notes, fields` | `{site}`; `DELETE` is 409 `in_use` with PCs or live codes |
| `GET .../devices?site=&status=&after=&limit=` | `devices.view` | | `{devices:[...], next}`; `status` is `pending` or `active` |
| `GET .../devices/<id>` | `devices.view` | | `{device}` |
| `PATCH .../devices/<id>` | `devices.manage`; a change of `access` from `ask` to `any` also needs `sessions.unattended` (403 `permission_denied` otherwise, checked again at commit). Sending `access: "any"` for a PC that is already `any` changes nothing and needs only `devices.manage` | `{site_id?, fields?, access?, owner_contact?, approve?:{confirm}}`; `owner_contact` is at most 200 characters and an empty string clears it; `name`, `control`, `os`, `machine` or `app_version` is 400 `bad_request` | `{device}` |
| `DELETE .../devices/<id>` | `devices.manage` | | `{removed:{id}}`; the PC's key ends with its row |
| `GET .../fields` | `devices.view` | | `{fields:[{id,entity,label,position,created_at}]}` |
| `POST .../fields` | `fields.manage` | `{entity, label}` | 201 `{field}`; `entity` is `customer`, `site` or `device` |
| `PATCH`, `DELETE .../fields/<id>` | `fields.manage` | `PATCH`: `{label?, position?}` | `{field}`; `DELETE` also clears the field's values from every record |
| `POST .../pairing` | `devices.manage` | `{site_id?}` | 201 `{pairing:{id, code:"ABCDE-FGH23", expires_at, site_id, link}}`. `link` is `<origin>/install?code=ABCDE-FGH23`, ready to send. The code and the link are in this answer only |
| `GET .../pairing` | `devices.manage` | | `{pairings:[{id,site_id,created_by,created_at,expires_at}]}`: live codes, no codes |
| `DELETE .../pairing/<id>` | `devices.manage` | | `{removed:{id}}` |

Built-in fields: a customer has `name` (required, 100 characters), `phone` and
`email` (200), `notes` (2,000, newlines allowed); a site has `name` (required,
100), `address` (300) and `notes`. A saved PC shows `id, site_id, status, name,
access, control, owner_contact, os, machine, app_version, protocol, paired_at,
paired_by, approved_by, last_seen, fields`, and `expires_at` while it is
`pending`. It never shows its key hash, its confirm hash or its six digits.
Custom field values are `fields: {"<field id>": "text"}`: text of at most 500
characters, ids from the workspace's definitions for that record type, else 400.
`PATCH` merges them: a value sets a field, `null` deletes it, and a field not
named is left alone. Lists order by id and page with `?after=<id>&limit=` (1 to
500, default 100); `after` must be an id, else 400, and `next` is the last id
when more remain, else `null`.

A technician with `devices.manage` may change a PC's `access` (`ask` or `any`)
on an active PC, in either direction. That change is logged as `device_changed`
with the technician as actor and the old and new mode in the detail. A technician
may also set or clear the PC's `owner_contact`; the log row names the field and
never the value. The PC's `control` and `name` stay the owner's: sending either,
or another field the PC reports, is 400 `bad_request`, not ignored. The owner
contact is the team's: the PC cannot send it (see `/device/pair` below). Only team members with `devices.manage` write custom fields; a PC
cannot. `approve` is its own request: a waiting PC
becomes `active` when `confirm` is the six-digit number shown on the PC (403
`confirm_wrong` otherwise, 409 `not_pending` for an active PC).

A change of `access` and an approval ring the PC's doorbell ([below](#the-doorbell))
once the change has committed, so the PC checks in at once. Removing a PC ends
its live session with the reason `removed` first, and rings its doorbell once
the row is gone; the doorbell then closes.

Limits per workspace: 10,000 customers, 10,000 sites, 2,000 PCs, 30 custom fields
per record type, 20 live pairing codes, 20 waiting PCs. The relay stores a
pairing code only as a keyed hash.

Log kinds: `customer_added`, `customer_changed`, `customer_removed`, `site_added`,
`site_changed`, `site_removed`, `field_added`, `field_changed`, `field_removed`,
`pairing_code_created`, `pairing_code_revoked`, `device_paired`,
`device_requested`, `device_approved`, `device_changed`, `device_removed`,
`device_left`, `device_session_started`, `device_session_taken_over`,
`device_session_ended` ([Saved-PC sessions](#saved-pc-sessions)),
`workspace_stopped` and `workspace_resumed`. A detail names ids and names, never a code, a key, an owner
contact or a field value. The only unlogged writes are a PC's check-in details (at
most every 5 minutes, or once a minute when a value changed) and purging expired
codes and waiting PCs. A detail can hold customer, site and PC names, so anyone
with `audit.view` can read them. A wrong approval number is refused with 403
`confirm_wrong` and is not logged; only holders of `devices.manage` can try one.
A pairing code carries its creator's authority: it redeems only while that person
still holds `devices.manage` in the workspace (checked again at commit), so
removing the person or their permission ends their live codes. Rotating
`AUTH_SECRET` ends every live pairing code and waiting PC number (both are keyed
hashes); a device key is a plain SHA-256 and is unaffected.

### Stop and resume

| Route | Needs | Answer |
|---|---|---|
| `GET .../stop` | `sessions.view` | `{stopped:true\|false}` |
| `POST .../stop` | `sessions.end` | `{stopped:true, sessions_ended:<n>}` |
| `DELETE .../stop` | `members.manage` | `{stopped:false}` |

These are team API calls only. No MCP tool stops or resumes a workspace. A body
is not read, but `POST` and `DELETE` need `Content-Type: application/json` like
every write. A workspace has no status column: a stop is the log row
`workspace_stopped` and a resume is `workspace_resumed`, and the workspace is
stopped when its newest stop row has a higher `seq` than its newest resume row.
Stopping a stopped workspace, or resuming a running one, changes nothing and
adds no row. While `default` is open, anyone admitted may stop it (they hold
`sessions.end`) and resume answers 409 `first_member`, so the first admin is
added before it can be resumed.

A stop ends every live session in the workspace's Registry list with the reason
`stopped` (at most 40 in one call; the free plan allows 50 subrequests a call),
rings every doorbell in the workspace, and from then on each tool call is
refused. A second `POST` ends any session the first one missed. A session also
checks for itself, reading the stop state at most once every 20 seconds, and a
stopped workspace ends it with the reason `stopped`. An app session (a saved PC or
a link session in app mode) checks on each `/agent` request. A PowerShell session
checks on each `/ws` attach, including the reconnect probe (answered 410), on each
message from its socket (an end frame goes to every socket and they close), and
from its own alarm, which fires every 30 seconds while it is attached, so a
PowerShell session with no traffic ends within about 30 seconds of the 20-second
window. That read failing counts as not stopped, because the stop also ends
sessions directly. Requests and tool calls to other workspaces are not affected.
A connect that was under way when the workspace stopped cannot claim the PC: the
claim holds only while the workspace is not stopped, and the connect then fails
with the stopped error.

`EMERGENCY_STOP` is a deploy setting for the whole relay. Any non-empty value
refuses every tool call (before any database read) and every connect to a saved
PC, and ends a live session on its next `/agent` request (or `/ws` attach) with
the reason `stopped`. A team cannot lift it. The check-in and the doorbell keep
working, so PCs learn their session is gone: the check-in answer leaves out
`session`. Clear the value and deploy to run
again.

## The install page (`/install`)

How a PC's owner gets the app for a saved PC. It is public, under no Access app,
like `/j/` and `/device/`. It uses no code up: the PC redeems a code itself over
`/device/pair`.

The query holds nothing, or exactly one parameter. `?code=` is a pairing code of
10 characters from the pairing alphabet, with or without the hyphen and in any
case; the relay writes it back as `ABCDE-FGH23`. `?workspace=` is a slug
(`[a-z0-9-]{1,40}`). Both together, another parameter, a repeated parameter or a
bad value is 400 `text/plain`. Plain `http:` on any host except loopback is 403.
Any method other than `GET` and `POST` is 405 (`Allow: GET, POST`). Without an
app bundle the answer is 404.

- `GET /install` answers 200 `text/html`, `Cache-Control: no-store`,
  `Referrer-Policy: same-origin` and a CSP with `default-src 'none'` and
  `form-action 'self'`. The page is in the style of the `/j/` download page, in
  English and Hebrew, headed "Set up Support on this PC", with a download button
  and no script. The page never checks or uses the code, so a chat app's link
  preview changes nothing. A page opened from a technician's link says the code
  works once, for 10 minutes.
- `POST /install` is the button. The same-origin rule as `/j/` applies: an
  `Origin` header must equal the relay's own origin, or, with none, the `Referer`
  must start with `<origin>/install`; otherwise 403. A good request answers 200
  `application/octet-stream`, `Content-Disposition: attachment;
  filename="support-setup.exe"`, `Cache-Control: no-store`: the compiled app
  followed by the device footer.

A saved PC downloads an update from the same address, as the page's button
does: `POST <origin>/install` with no query, the header `Origin: <origin>` and an
empty body. It carries no key. It strips the footer and checks the exe's size and
SHA-256 against the signed release note ([Updates](#updates)), so the download
itself needs no other protection.

The device footer uses the app's footer layout (the configuration bytes, their
length as a little-endian `uint32`, then `SUPPORTMCPCFG1`). Its JSON is
`{"kind":"device","origin":"https://...","code"?:"ABCDE-FGH23","workspace"?:"<slug>"}`
with at most one of `code` and `workspace`. It holds no session id and no key. A
session footer has no `kind`. The app's session reader refuses any footer with a
`kind`, and its device reader refuses a session footer, so no session role can run
on a device footer. The origin follows the same rule as in a session footer.

The team API's `POST .../pairing` answer carries the matching link:
`{"pairing":{"id","code":"ABCDE-FGH23","expires_at","site_id","link":"<origin>/install?code=ABCDE-FGH23"}}`.
Like the code, the link is in that answer only. It carries a working code, so it
can land in browser history, link previews and the relay's request logs.

## The PC wire (`/device/*`)

What a saved PC calls: pair or ask to join, check in, change its own settings, and
leave on uninstall, plus the doorbell below. These addresses are public, with no Access login,
because a PC has none. Every request is `POST` with `Content-Type:
application/json` and a body of at most 8 KB that carries `"protocol": 1`. Every
answer, success or error, carries `"protocol": 1`. Errors are
`{"protocol":1,"error":{"code","message"}}`.

Refusals that apply to all four, in this order: plain `http:` except loopback 403
`https_required`; any other method 405 `method_not_allowed` (`Allow: POST`); an
`Origin` header 403 `forbidden`; `?key=` or `?code=` in the URL 400
`bad_request`; not JSON 415 `unsupported_media_type`; over 8 KB 413
`payload_too_large`; a body that is not a JSON object, or a `protocol` that is
missing or not a whole number, 400 `bad_request`; a `protocol` outside 1 to 1 426
`protocol_unsupported` with the range:

```json
{"protocol":1,"error":{"code":"protocol_unsupported","message":"..."},"supported":{"min":1,"max":1}}
```

When the relay has a signed release and `UPDATE_ROLLOUT` is not `pause` or `0`,
the 426 also carries `"update"` ([Updates](#updates)), on every address and
without a key check, so a PC that speaks an older protocol can update itself. A
prerelease goes into a 426 only when `UPDATE_ROLLOUT` pins a number.

A device key is `smd1.<workspace>.<device id>.<secret>`, sent as
`Authorization: Bearer smd1...`. It must match
`^smd1\.([a-z0-9-]{1,40})\.([a-z2-7]{20})\.([A-Za-z0-9_-]{43})$`; a mismatch, a
missing header, a wrong secret, an unknown id or workspace, a removed PC and a
waiting PC past 24 hours are all 401 `device_unknown`. The relay stores the
SHA-256 of the secret and looks the row up by workspace and id.

`POST /device/pair`, no key. Technician path, with a pairing code:

```json
{"protocol":1,"code":"ABCDE-FGH23","name":"Front desk","access":"ask","control":"full",
 "os":"Windows 10 Pro 22H2","machine":"POS-1","app_version":"0.4.0"}
```

answers 201 `{"protocol":1,"status":"active","workspace":"default","device_id":"...","key":"smd1.default.<id>.<secret>"}`.
Owner path: the same body with `"workspace":"<slug>"` in place of `code` answers
202 `{"protocol":1,"status":"pending","workspace","device_id","key","confirm":"482913","expires_at"}`.
`confirm` is six digits, shown only here; the PC shows them to its owner, who
reads them to a technician. A workspace slug in `workspace` reveals whether that
workspace exists (404 `not_found` against 202 or 409), as the public protected
resource document does; slugs are public addresses. `access` is `ask` or `any` (default `ask`), `control`
is `full` or `limited` (default `limited`). A code is normalised: uppercase,
hyphens and spaces dropped. Errors: 400 `bad_request` (also both or neither of
`code` and `workspace`, a bad field, and an `owner_contact`, which only a
technician sets), 404 `code_invalid` (a code that is unknown,
used, expired or malformed: one answer), 404 `not_found` (no such workspace), 409
`request_limit` (20 join requests an hour per workspace), 409 `pending_limit` (20
waiting at once), 409 `device_limit` (2,000 PCs), 426, 503 `unavailable` (no
`AUTH_SECRET` of 32 characters or more). A failed attempt leaves no device, no log
row and the code unused. A good one writes the device, the `device_paired` (or
`device_requested`) row and, for a code, marks it used, in one batch.

`POST /device/hello`, key: `{"protocol":1,"os"?,"machine"?,"app_version"?}` answers
200 `{"protocol":1,"device":{"id","workspace","status":"active"|"pending","name","access","control","site_id"},"update"?:{...},"session"?:{...}}`.
Allowed while pending. The reported details are written at most every 5 minutes,
or once a minute when one changed (a changed value inside that minute is dropped
and sent again at the next check-in), and are not logged. `update` is there only
when the relay offers this PC its signed release ([Updates](#updates)); without
it the answer is exactly as before. `session` is a new top-level key, beside
`device` and `update`, never inside `device`. It is there only for an active PC
with a live session pointer and is `{"id":"<64 hex>","by":"<identity>",
"team":"<workspace name>","ask":true|false,"expires_at":<ms>}`: the session to pick
up (below), who started it (an email or a service token id), whether the PC must
ask the person at it, and the session's hard end. A waiting PC never gets it, and
neither does a PC whose pointer has passed its end, or any PC while `EMERGENCY_STOP` is set (the answer is otherwise the same, so the PC does not start a session that would be ended on arrival). It comes from the row the
check-in already loads, so it costs no further query. A PC on 0.5.0 ignores it.
There is no interval in the answer. Errors: 400, 401, 426.

`POST /device/update`, key: `{"protocol":1,"name"?,"access"?,"control"?}`
with at least one key answers 200 with the same `device`. Logged as
`device_changed` by `pc <device id>`; an unchanged value writes nothing. Errors:
400 (also an `owner_contact`), 401, 403 `pending` (a waiting PC may only check in or leave), 426. The saved
PC's app sends `access: "any"` here when someone at the PC turns on "any time",
and never sends `access: "ask"`; the one-way rule is the app's, since the wire lets
the key's holder set either mode.

`POST /device/leave`, key: `{"protocol":1}` answers 200
`{"protocol":1,"removed":true}`, deletes the row and so the key, and logs
`device_left` (also for a waiting PC). A live session of the PC ends first, with
the reason `removed`. Afterwards the key is 401. Errors: 401, 426.

### The doorbell

`GET /device/ring?protocol=1`, a WebSocket upgrade with `Authorization: Bearer
smd1...`. The PC keeps one open so the relay can tell it to check in. It carries
no data a PC acts on: the relay sends the text frame `{"type":"ring"}` and nothing
else, and the PC treats any text frame as "check in now" (at most once every 2
seconds) and never reads its content, so a fake ring can only cause an early
check-in. The PC sends WebSocket protocol pings every 30 seconds and nothing
else. The relay ignores any text it receives and closes the socket on a frame
over 1 KB.

Refusals, in this order: plain `http:` except loopback 403 `https_required`;
any method but `GET` 405 `method_not_allowed` (`Allow: GET`); an `Origin` header
403 `forbidden`; `?key=` or `?code=` 400 `bad_request`; a `protocol` query that is
missing or not a whole number 400 `bad_request`; a `protocol` outside 1 to 1 426
`protocol_unsupported`; a missing, malformed or wrong key 401 `device_unknown`
(a malformed key never reaches the database); a request without `Upgrade:
websocket` 400 `bad_request`; no `REGISTRY` binding 503 `unavailable`. An active
PC and a waiting PC may both connect. The Worker checks the key with the same
query as a check-in, then hands the upgrade to the workspace's Registry object
without the key. The Registry accepts it with the hibernation API under the tag
`dev:<device id>`, and a new socket for the same PC closes the older one. An idle
doorbell is a hibernated socket, which Cloudflare does not bill, and only a ring
wakes the object.

The PC opens the doorbell itself, as a direct TCP and TLS connection to the relay
(TLS 1.2, with the same certificate-revocation setting as its check-in), and does
not use a proxy. On a network where only a proxy reaches the relay the doorbell
never connects, and the PC uses the 5-minute check-in instead.

Rung, best effort (the check-in schedule is the fallback): a connect and a
take-over (`device_connect`), a team change to a PC's `access`, an approval, a
removal (after the row is deleted, then the doorbell closes), and a workspace
stop (every doorbell). `device_list` reports `online` from the Registry's
sockets, one request per list.

### The check-in schedule

While its doorbell is connected a PC checks in when the doorbell connects, at each
ring and every 6 hours (plus up to 10 minutes of jitter, for staged updates): about 10
requests a day. While it is not connected it checks in every 5 minutes plus up to
30 seconds, as before. A waiting PC always uses the 5-minute schedule, because the
six digits ring it anyway. The network-error backoff, the 426 schedule and an
update trial's own check-ins are unchanged. The PC reconnects after a close or
an error with a backoff from 5 seconds, doubling to 5 minutes, which a ring
that arrives resets. A PC that has not seen a pong within 60 seconds treats the
doorbell as dead, reconnects, and uses the 5-minute schedule until it is back.

### Updates

A saved PC updates itself to a release signed with the project's release key.
The relay can offer a release or hold it back, but cannot make one: it never
holds the private key and never checks a signature. The PC does.

The release is the relay's own app bundle. Its note is exactly five lines, UTF-8,
each ending in LF, in this order and nothing else:

```text
support-mcp-release 1
version 0.5.1
sha256 <64 lowercase hex: SHA-256 of the exe without a footer>
size <the exe's size in bytes, decimal>
released <unix seconds>
```

The signature is ECDSA P-256 over SHA-256 of those bytes, 64 bytes `r||s`
(IEEE P1363), in standard base64. The public key is the 64-byte `X||Y` in
standard base64: one line in `release-key.pub` and the constant
`ReleaseKey.ProjectKey` in the app, which a test keeps equal.

Three deploy settings drive it (`wrangler.toml` `[vars]`, empty by default):

| Setting | Holds |
|---|---|
| `RELEASE_SIGNATURE` | the note's signature, base64 of 64 bytes, from `scripts/sign-release.mjs` |
| `RELEASE_SIGNED_AT` | the note's `released` time, unix seconds, from the same run |
| `UPDATE_ROLLOUT` | empty: follow the stages; `pause`: offer nothing; a whole number 0 to 100: that share of PCs. Anything else counts as `pause` |

The relay rebuilds the note from `VERSION`, the SHA-256 and size of the bundle's
exe (computed once per isolate) and `RELEASE_SIGNED_AT`, and passes
`RELEASE_SIGNATURE` on. Either signature setting missing or malformed means no
release. A signature made for other bytes (another exe, date or version) is still
passed on, and every PC refuses it.

The `update` object, in a hello's answer or a 426:

```json
{"version":"0.5.1","note":"support-mcp-release 1\nversion 0.5.1\n...","signature":"<base64>"}
```

A hello offers it when all of these hold. The PC is active (a waiting PC is never
offered one). Its version, the request's `app_version` or else the stored one, is
a valid version and below the release by SemVer precedence, with build metadata
ignored. The release is not a prerelease, unless `UPDATE_ROLLOUT` pins a number.
The PC's group is below the stage. The group is the first 4 bytes of SHA-256 of
`<release version>:<workspace>:<device id>`, read big-endian, mod 100, so the same
PCs go first within one release and others go first in the next. The stage counts
from `RELEASE_SIGNED_AT`: 10 for the first 24 hours, 50 until 48 hours, then 100.
A pinned `UPDATE_ROLLOUT` replaces the stage. Working out the offer reads and
writes nothing more in the database than a hello without one.

The PC ignores the outer `version` for its decision and uses the note's; an
outer `version` that differs from the note's is refused. It takes the release
only when the signature verifies against its built-in key, the note has exactly
the form above, the version is newer than its own and has not failed on this PC
before, and the size is at most 2 MB. It then downloads the app from `/install`
([above](#the-install-page-install)), strips the footer, and checks the size and
SHA-256 against the note before it keeps a byte.

## Sign-in (`/auth/*` and `/account`)

Browser routes for people. They are outside Access and outside the `/mcp` and
`/api` gate: instead of refusing every `Origin`, each POST accepts only an
`Origin`, if sent, equal to the relay's own, and a form token. A browser sign-in
is not accepted on `/mcp`, `/w/<slug>/mcp` or `/api/`, so nothing a signed-in
person can do reaches a session or the team. Code: `src/auth.js` (routes),
`src/accounts.js` (the tables in `migrations/0003_signin.sql`), `src/oidc.js`,
`src/totp.js`, `src/crypto.js`, `src/pages.js` and `src/mail/`.

Settings: `PUBLIC_ORIGIN`, `GOOGLE_CLIENT_ID`, `MICROSOFT_CLIENT_ID`,
`MICROSOFT_TENANTS`, `MAIL_PROVIDER`, `MAIL_FROM`, `SIGNIN_IDLE_HOURS`,
`SIGNIN_MAX_DAYS` (vars) and `AUTH_SECRET`, `GOOGLE_CLIENT_SECRET`,
`MICROSOFT_CLIENT_SECRET`, `RESEND_API_KEY` (Wrangler secrets), plus
`DEV_SHOW_EMAIL_LINKS` (`.dev.vars` only, loopback only). Setup is in
[sign-in-setup.md](sign-in-setup.md).

Every route answers **503** with a plain page when `AUTH_SECRET` is missing or
under 32 characters, when `PUBLIC_ORIGIN` is unset on a host other than
`localhost` / `127.0.0.1`, is not an https address with no path, or names another
host than the request's, or when the database is not bound. Every response
carries `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline';
form-action 'self'` (plus `https://accounts.google.com` and
`https://login.microsoftonline.com` on `/auth/signin`) `; frame-ancestors 'none';
base-uri 'none'`, `Referrer-Policy: same-origin`, `X-Content-Type-Options:
nosniff` and `Cache-Control: no-store`. Pages contain no script.

| Route | Behaviour |
|---|---|
| `GET /auth/signin?next=<path>` | The sign-in page. Buttons for each configured provider, and the email form when a mail provider is configured (or `DEV_SHOW_EMAIL_LINKS=1` on loopback). Sets a one-hour cookie that its email form's token is tied to. Redirects (303) to `next` if already signed in. |
| `GET /auth/google`, `GET /auth/microsoft` | 404 when not configured. Else sets the sealed round-trip cookie (`__Host-smcp-oidc`, 10 minutes) and answers 302 to the provider with `response_type=code`, `scope`, `state`, `nonce`, `code_challenge` (S256) and `redirect_uri=<PUBLIC_ORIGIN>/auth/<provider>/callback`. Microsoft's authority is `common`, one listed tenant, or `organizations`. |
| `GET /auth/<provider>/callback?code&state` | Opens the cookie (any tamper, expiry, mismatch of provider or state → 400, cookie cleared), exchanges the code at the provider with the client secret and verifier, verifies the id_token (see the security model), resolves the person, and signs them in: 303 to the return path, or to `/auth/factor` first when they have an authenticator. A person nobody invited gets 403 and the same "you can't sign in here" page whatever the reason. |
| `POST /auth/email` | 404 without a mail provider. Needs `email`, `csrf` (HMAC of the sign-in page's cookie) and optional `next`. Answers 200 "check your email" for every well-formed address and sets the binding cookie (`__Host-smcp-bind`, 10 minutes). For an invited address under the limit of 5 links an hour it stores the link and mails it (after the answer, via `waitUntil`, or shows it in dev mode). A malformed address is 400. |
| `GET /auth/email/confirm?t=` | Shows a confirmation page with a button, or "open this link in the same browser" without the binding cookie. Never changes state. |
| `POST /auth/email/confirm` | Needs `t`, `csrf` (HMAC of the binding cookie) and the binding cookie. Redeems the link once if it is unused, unexpired and bound to that cookie, else 400 (a link from another browser is not used up). Then signs in as for a provider. |
| `GET /auth/factor?next=&reset=1` | A signed-in person with no authenticator gets the setup page (a key and an `otpauth://` link; the key travels as an AES-GCM sealed value tied to this sign-in, nothing is stored yet). With one but not yet verified in this sign-in: the code page. With one verified: redirect, or the replace page for `reset=1`. Signed out: redirect to sign-in. |
| `POST /auth/factor` | `action=verify` with `code` (six digits or a recovery code): success marks the sign-in `factor_at` and redirects (a recovery code instead shows a page saying every other sign-in was ended, 200); wrong is 400; locked is 429 (every fifth wrong try in a row locks, for 15 minutes, doubling each time up to 24 hours; only a right code resets). `action=enrol` with `sealed` and `code`: a matching code stores the authenticator and ten recovery codes (shown once, 200), marks the sign-in and revokes the person's other sign-ins. Replacing needs a verified sign-in. |
| `GET /account` | Your email, your workspaces and roles, your second factor (required or optional), sign out. Redirects to sign-in when signed out, and to `/auth/factor` when an enrolled person has not passed a code. |
| `POST /auth/signout`, `POST /account/signout-everywhere` | Need `csrf` (HMAC of the sign-in's id hash). Revoke this sign-in, or every sign-in of the person. 303 to `/auth/signin`. The second one, for a person with an authenticator, needs a sign-in that has passed a code, else 303 to `/auth/factor` and nothing is revoked. |

A sign-in is the cookie `__Host-smcp` (`smcp` on loopback http): 32 random
bytes, stored as `login_sessions.id_hash` (SHA-256). It is valid while it is
not revoked, was used within `SIGNIN_IDLE_HOURS`, began within
`SIGNIN_MAX_DAYS`, its person is not disabled, and the person is still invited
(a member of a workspace or in `DEPLOYMENT_ADMINS`), all read live per request.
`authorizeSignIn(team, session, workspace, permission)` in `src/auth.js` is the
check for acting on a sign-in: the role must hold the permission, and
`sessions.control`, `members.manage` and `roles.manage` also need the sign-in's
`factor_at`, else "a second factor is required".

## OAuth for MCP clients

Code: `src/oauth.js` (authorization server setup, resource documents, token
check, grant revocation), the consent page in `src/auth.js` and `src/pages.js`,
and the wiring in `src/app.js` and `src/index.js`. Guide: [mcp-clients.md](mcp-clients.md).

The library is `@cloudflare/workers-oauth-provider` 1.2.4, pinned. It is imported
only by `src/index.js` and passed to `createHandler` as
`{ OAuthAuthorizationServer, AuthorizationError, CimdFetchError }`. The relay uses
`new OAuthAuthorizationServer({ issuer, resources, authorizeEndpoint, tokenEndpoint,
clientRegistrationEndpoint, accessTokenTTL, refreshTokenTTL,
clientIdMetadataDocumentEnabled, allowPrivateUseRedirectUris })` and its `fetch`, `validateToken(resource,
token, env)` and `getOAuthApi(env)` (`parseAuthRequest`, `describeConsent`,
`beginConsent`, `approveConsent`, `denyConsent`, `completeAuthorization`,
`listUserGrants`, `revokeGrant`). The all-in-one `OAuthProvider` is not used: it
fixes its protected addresses at construction and answers 401 before the relay's
own refusals.

- **Issuer** is `PUBLIC_ORIGIN` (the request's own address on loopback). Resources
  are `<origin>/mcp` and `<origin>/w/<slug>/mcp` for every row of `workspaces`,
  read from D1 and kept ten seconds per isolate. The server is rebuilt when the
  list changes, and a consent request for a slug not in the list reads it again
  at once (at most every two seconds). So does a `/oauth/token` request the
  library refuses with `invalid_target` or `invalid_grant`, when the list has
  changed since it was read: the request runs once more on the new list. At most
  500 workspaces: creating one more is `409 workspace_limit`. Checking a token
  uses a server that declares only that one address. Before it reads KV, the
  relay checks the token's shape and that its user id (the first segment) is an
  enabled person in D1; anything else is 401 `invalid_token` with no KV read, and
  a D1 failure is 503.
- **Endpoints** the library serves: `/.well-known/oauth-authorization-server`
  (without `protected_resources`), `/oauth/token` (code, refresh, revocation) and
  `/oauth/register`. Requests for them on another host are 404.
- **Protected resource documents** (RFC 9728) are served by the relay at
  `/.well-known/oauth-protected-resource` and its `/mcp` and `/w/<slug>/mcp`
  path forms: `resource`, `authorization_servers: [<origin>]`,
  `bearer_methods_supported: ["header"]`. The bare form names the default
  address. 404 for `default`'s second spelling and for a slug not created.
- **Tokens**: access 3600 s, refresh 2,592,000 s from the code exchange,
  rotating (the current and the previous refresh token are both accepted; there is
  no reuse detection); PKCE S256 required of every request, whatever the client's
  authentication method; each bound to one resource; `iss` in the
  authorization response. Grant props are `{ user_id, email, workspace, factor }`
  where `factor` is `user_factors.created_at` of the authenticator the sign-in
  used, or null.
- **`GET /oauth/authorize`**: not signed in → 303 to `/auth/signin?next=<this
  request>` (up to 1,800 characters kept; the sign-in layer's return path check
  still applies). Signed in: the library's `parseAuthRequest`. Any failure is
  shown as a page (400) and never redirected, because the person has not chosen
  yet; the page may carry a plain link to the client's checked redirect, labelled
  with its host. The relay then refuses a request without a `code_challenge` of
  43 base64url characters and `code_challenge_method=S256`, and a redirect
  address its `form-action` source cannot name. The resource must name a workspace the
  person is a member of (else 403); a role holding a factor permission needs
  `factor_at` or the person goes to `/auth/factor?next=<this request>`; then
  the consent page, whose `form-action` lists the client's redirect origin.
- **`POST /oauth/authorize`**: the form needs `csrf` (HMAC of the sign-in's id
  hash), `handle` (the library's, bound to the browser by a `__Host-oauth-consent-*`
  cookie, single use, ten minutes) and `decision` of `approve` or `deny`.
  `deny` → 303 to the client with `error=access_denied`, `state` and `iss`.
  `approve` → the PKCE check is made again on the stored request, membership and
  factor are read again, then
  `completeAuthorization`, then 303 to the client with `code`, `state` and `iss`.
- **Sign out everywhere** lists and revokes every grant of the person.
- **Settings**: the `OAUTH_KV` binding, the `global_fetch_strictly_public`
  compatibility flag, `PUBLIC_ORIGIN`. KV use: one read per call with a token,
  two writes per client each hour while it is active (about 48 a day), five writes
  for a new connection. `ACCESS_MCP_AUD` (optional) names a second Access app: on
  the MCP addresses only, an Access JWT for it is accepted next to `ACCESS_AUD`.
  An OAuth caller is checked with `authorize(..., { membersOnly: true })`, so an
  empty `default` neither admits nor records it.

## Session state machine (Session DO)

`pending` (code minted, 10 min TTL) → `consumed` (script fetched or app
downloaded, awaiting the first connection, TTL 2 h to first attach) → `attached` (expires_at = first attach + 24 h,
fixed; reattach does not extend) → `ended` (terminal: expired, `session_end`,
customer End/close). A DO alarm fires at the current deadline; on fire, a
non-attached session past TTL → `ended`; attached past expires_at → send
`{"type":"end","reason":"expired"}`, close sockets, `ended`. If the alarm fires
**before** the deadline (clock skew / rescheduling) it re-arms rather than
ending early. `/consume`, `/ws`, `/status`, `/command` and `/end` also check the
governing deadline inline and expire the session if it has already passed, so a
late alarm never lets an expired session act. `ended` is permanent: `/j` 404,
`/ws` 410, `run`/files return an error. `/create` refuses (409) if the DO
already holds state. `/consume` mints the key and hashes it before it reads the
state, so two concurrent consumes cannot both see `pending`: the second gets
`not-pending`. `/consume` takes the session's mode and answers `wrong-client` for a mismatch
without changing state. `/ws` checks the deadline and state again after it hashes the
attach key, because hashing yields to other requests. An operator end or the
alarm during that await still returns 410, so a late attach never resumes an
ended session. On the first attach the registry push runs after the socket is
accepted, so an end that lands during it also closes the new socket.

`session_status` includes `startup_expires_at` while the state is `consumed`.
It is the deadline for the first connection, in Unix milliseconds, and is
`null` in all other states.

Only the newest agent socket is live: sockets are tagged with an attach
generation (`acceptWebSocket(server,[tag])`) and storage `ws_tag` names the
current one. Commands go only to the current socket. A new valid attach closes
**every** older socket and fails their in-flight requests with `agent
disconnected`; `end`/expire/customer-end send `end` to and close **every**
socket. When a socket closes or errors, its own pending requests fail
immediately with `agent disconnected`. A `result` resolves a pending request
only when it arrives on the socket that request was sent to, and the relay
ignores any other message from a socket that is not the current one.

### App sessions (HTTPS polling)

An `app` session has no WebSocket. The app sends JSON `POST /agent?sid=` requests
with the key in `X-Attach-Key`, and the relay answers in JSON with
`Cache-Control: no-store`. The relay applies the same deadline checks as for
`/ws`, once before and once after it hashes the key and reads the body, so a late
`hello` can never resurrect an ended session. Messages from the app:

```
{"type":"hello","machine":"..","user":"..","ps":"..","agent":"windows-app-2","version":"x.y.z","elevated":<bool>,
 "caps":["screen","uia","lanes","full"],"control":"full"|"normal"}
{"type":"poll","generation":<n>,"busy_lanes":["cmd","screen"],"busy":<bool>,
 "desktop":"default"|"secure"|"unknown","paused_until":<ms>,"input_blocked_until":<ms>}
{"type":"result","id":"<uuid>","generation":<n>,"ok":true, ...}
{"type":"end","generation":<n>}
```

`caps`, `control`, `busy_lanes`, `desktop`, `paused_until` and
`input_blocked_until` are new. An older app (agent `windows-app-1`) sends none
of them and keeps working: see [Lanes](#lanes-screen-and-control-frames).

- `hello` attaches. It is the only message that works without a generation. It
  returns `{"type":"welcome","generation":<n>,"expires_at":<ms>,"server_time":<ms>}`.
  The first `hello` from a `consumed` session sets `expires_at` to now + 24 h. Any
  later `hello` (a reconnect) gets a new generation and the same `expires_at`.
  Machine, user and `ps` are cut to 100, 100 and 40 characters, `agent` to 40.
  `version` is the app's release version. It is stored only when it is a string of
  at most 32 characters like `1.2.3` or `1.2.3-rc.1` (digits, then an optional
  prerelease or build part), else `null`; every hello replaces the stored value.
  `elevated` is stored only when it is a boolean, else `null`. `caps` keeps the
  names the relay knows (`screen`, `uia`, `lanes`, `full`) and drops the rest;
  no `caps` means `[]`. `control` is stored only when it is `full` or `normal`,
  else `null`. A hello also clears the stored `desktop`, `paused_until` and
  `input_blocked_until`. The audit log gets an `attached` row (`http<n>`,
  `reattach` when it is not the first, and `elevated=true|false|unknown`) and a
  `hello` row that adds `control=` and `caps=`.
- Every other message must carry the current generation, else 409
  `{"type":"end","reason":"replaced"}`. Each one counts as a sign of life.
  `session_status.attached` is true while the state is `attached` and the last
  request was under 60 s ago.
- `poll` is a long poll. The relay holds one for up to 25 s (shorter when a
  frame is held back by the redelivery guard below) and answers
  `{"type":"idle"}`, or with a waiting command frame as soon as there is one,
  or with `{"type":"end"}` when the session ends. A second poll releases the
  first. Any poll with the current generation counts as a sign of life. A
  client with one lane (no `lanes` cap) sends `"busy":true` while it holds its
  command. That poll is answered `idle` at once, even while a command frame is
  waiting, so the frame is not sent twice and no poll is parked. It waits for
  its operation to finish and sends a busy poll only every 2 s, as a sign of
  life that also lets it notice an operator end or expiry quickly. A client
  with lanes sends `busy_lanes` and keeps long-polling while a lane runs: see
  [Lanes](#lanes-screen-and-control-frames).
- The command frames are the `run`, `put_file` and `get_file` frames of the
  WebSocket, with a `lane` field, plus the `screen` and `control` frames below.
  At most one operation per lane is in flight: a second call for a lane that is
  busy returns the error `agent busy; wait for the current operation`.
- `result` answers the in-flight command. The relay checks the generation and
  the command id, and a repeated result for a command it already holds is
  acknowledged with `{"type":"ack"}` and not applied twice. Results use base64:
  `run` carries `stdout_b64`, `stderr_b64`, `exit_code`, `timed_out` and
  `stdout_truncated` / `stderr_truncated` flags (each stream at most 90,000
  base64 characters; a truncated stream gets a `[truncated]` marker),
  `put_file` carries `bytes`, `get_file` carries `data_b64`, `size` and `eof`,
  and `screen` and `control` results are described below. A malformed result
  gets 400 `{"error":"invalid result"}` and does not resolve the command, which
  keeps waiting for a valid one until its timeout. The app does not resend a
  result the relay refuses with 400 or 413: it replaces that result once with
  `{"ok":false,"error":"result rejected by relay"}`, sends that, and carries on
  polling. A result it cannot serialize under 750,000 bytes gets the same
  replacement. Any other failure, including 408, 429 and other 4xx answers, takes
  the normal retry path with the same result. That replacement carries only
  `type`, `id`, `generation`, `ok` and `error`, so the relay always accepts it. If
  it is refused anyway, the app drops it and carries on, and the operator's call
  ends with the relay's `timeout waiting for agent`.
- `end` is the customer ending the session: the relay marks it `ended` with
  reason `customer`. An operator `session_end`, the alarm and the 24-hour limit
  answer any waiting poll with `{"type":"end"}`, fail the waiting command, and
  every later request gets 410.

### Saved-PC sessions

A technician starts one with `device_connect`. It is a Session object like a
link's, with differences. It is named by a random 16-character code (the Session
object's name and its key in the Registry), but nobody can use that code:
`/consume` answers `not-pending` and `/j/<code>` shows an expired link. There is
no attach key.

States: `waiting`, `attached`, `ended`. The Session is created `waiting` for a
device, with the technician as its `driver`. The PC must pick it up and the person
at it answer within 510 seconds (a 330-second check-in without the doorbell, plus
180); the deadline passing ends it as `timed_out`. The first `hello` attaches it
and sets `expires_at` to that moment plus 24 hours, fixed; a later `hello` rejoins
without extending it. There is no idle timeout. The 24 hours ending is
`max_time`. The pointer's `expires_at` starts as the latest the session can end
(the creation time, plus 510 seconds, plus 24 hours) and is set to the exact end at
the first `hello`.

The device's record holds the one live session as `devices.session`, JSON text
`{"id","by","ask","expires_at","code","team"}` (`id` is the Session object's id,
`by` the driver, `code` the Session object's name, `team` the name the PC
shows). Connect claims it with one guarded `UPDATE` that holds only while the
workspace is not stopped, the PC is active and has no pointer or one whose
`expires_at` has passed, the caller still holds `sessions.control` (and
`sessions.unattended` when the session does not ask), and the
`device_session_started` row goes in; so two technicians cannot both connect, and
a stale pointer is reclaimed. A pointer also counts as free when its Session
object is not live: before refusing with `<who> is connected`, connect asks that
Session for its state, and one that has ended or does not exist (a stop can end a
new Session before its pointer is written) is replaced, with the claim guarded on
the old pointer's id. A Session that cannot be reached counts as live. A connect
retried after losing the log number keeps the Session it made only while that
Session is still waiting; otherwise it makes a new one. The check-in does not
make this check, because it must cost no further request: a PC that is handed a
pointer to an ended Session gets 410 on its first request and ends it, and the next
connect replaces the pointer. The Session object clears it with
a `UPDATE` guarded on the session id when the session ends, in the same change as
the `device_session_ended` row, and its alarm retries every 30 seconds until that
works.

`ask` is true unless the PC's access is `any`, the caller holds
`sessions.unattended` (with its second factor for an OAuth caller), and did not
pass `ask:true`. A caller without the permission is not refused: the session asks.
The PC asks the person when `ask` is true or its own saved access is `ask`.

**On the wire.** `POST /agent?sid=<sid>` with `Authorization: Bearer <device key>`.
The relay checks the key against the database on every request and requires the
PC's record to point at `sid`, else 401. The Session is called with the device id
and the PC's control level from the record, never from the client. Messages are the
app's ([above](#app-sessions-https-polling)), plus:

```
{"type":"decline","reason":"declined"|"nobody"|"busy"}
```

sent before `hello`, answered `{"type":"end"}`, and the session ends with that
reason. After a `hello` only `nobody` and `busy` are taken: a PC that restarts during a
limited session and finds its user signed out sends `nobody`, and one that finds
several Remote Desktop users to choose from sends `busy`. Anything else (another
reason, `declined` after a `hello`, on a link session) is 400.
A `hello` with `control: "full"` for a PC the record says is limited is 403 and
changes nothing. `welcome` adds `"driver":"<identity>"`. Every poll answer for a
saved-PC session, whether idle, a command frame or an end, carries `"driver"`, so the corner
window shows a take-over at once. `end` from the PC ends the session with the
reason `owner` (a `"reason":"owner"` in it is optional).

**One driver.** A command (`run`, files, screen, control) from anyone but the
driver is refused: `<driver> is driving this session; use device_connect with
take_over`. `session_status`, `session_list` and `session_end` are not commands.
`device_connect` with `take_over:true` moves the driver to the caller (always
needs `sessions.unattended`), changes `by` in the pointer, wakes the PC's parked
poll with the new driver, rings the PC and writes `device_session_taken_over`. It
is not an end. Without the permission the error says to ask the driver to end the
session and connect again, so the person at the PC is asked.

**The built-in agent's marks.** A command the built-in agent sends carries `via: "agent"`.
The Session writes its log row as `[<actor> via agent] <detail>`, and the actor stays the
person who started the task for the driver check. The Session also keeps the last 10 people
who sent it a command (past the driver check) with the time, and `GET /watch?workspace=`
(internal, for the agent task) answers `{state, ended_reason, device_id, driver, actors}`, or
`{state: "unknown", actors: []}` for another workspace's call. A task ends when a person other
than its starter appears there on a session with no driver.

**End reasons** (`ended_reason` in `session_status`, and the last word of the
`device_session_ended` detail): `declined`, `nobody` and `busy` (the PC's decline),
`timed_out` (the waiting deadline), `max_time` (the 24 hours), `owner` (the PC
ended it), `technician` (`session_end`), `stopped` (a workspace stop or
`EMERGENCY_STOP`), `removed` (the PC was removed or left) and `replaced` (made
but never claimed: this one is not logged).

`session_status` for a saved-PC session adds `device_id` and `driver`, and its
`startup_expires_at` is the waiting deadline while it waits. `session_list` shows
it with the label `PC <name> (<device id>)`. The log rows are
`device_session_started` (actor the technician; detail the device id, its name,
the first 8 characters of the session id and whether it asks), `device_session_taken_over`
(actor the new driver; detail ends `from <old driver>`) and `device_session_ended`
(actor the technician, `pc <id>` for the PC's own words, or `relay`; detail ends
with the reason). They hold ids and names, never a code or a key.

### Lanes, screen and control frames

**Lanes.** Every operation frame carries `"lane":"cmd"` or `"lane":"screen"`.
Lane `cmd` takes `run`, `put_file` and `get_file`. Lane `screen` takes `screen`
and `control` frames. The relay keeps one pending command per lane, so a
`run` and a screenshot are in flight together, but two screenshots (or two
`run` calls) are not. An operator call for a busy lane returns `agent busy;
wait for the current operation`. The relay forwards only the lanes the client
can use:

| Client | Detected by | Behaviour |
|---|---|---|
| lanes client | `caps` contains `lanes` | both lanes. Screen frames also need `caps` to contain `screen` |
| lanes client without `screen` | `caps` has `lanes` but not `screen` | commands and files only. Screen calls fail with `the customer has not approved screen control for this session`. The app sends these caps when it was resumed from a restart whose consent did not cover screen control |
| old app | no `lanes` in `caps` | the one `cmd` lane, as before, and `busy` in the poll. Screen and control calls fail with `this support app is too old for screen control`, and `run` with `as:"system"` with `this support app is too old to run as system`. Its frames also carry `lane`, which it ignores |
| PowerShell agent | `windows_mode` is `powershell` | no screen. Screen and control calls fail with `the PowerShell fallback has no screen access` (before the agent is attached too), and `run` with `as:"system"` with `the PowerShell fallback cannot run as system` |

**Poll for a lanes client.** `busy_lanes` lists the lanes with an operation
running, a subset of `["cmd","screen"]`; unknown names are ignored. When it is
absent, `"busy":true` means `["cmd"]`. The relay answers:

1. every lane busy: `{"type":"idle"}` at once, nothing parked;
2. a lane that is not busy has a waiting frame: that frame (`cmd` is checked
   first). One frame per poll, so a client with two waiting frames polls again;
3. otherwise the poll parks for up to 25 s and is answered `idle`, or with a
   frame as soon as one arrives for a lane the poll did not call busy.

So a client with a running `run` must keep a poll parked with
`busy_lanes:["cmd"]`, or screen frames never reach it. When a `result` is
accepted for a lane, the relay clears that lane from the parked poll's busy set,
so the next frame for it is delivered without a new poll.

**Duplicates.** A frame the relay already sent is not sent again within 5 s,
whatever the next poll says, and then only to a poll that says the lane is
free. A frame can be written to a poll the app has already aborted (it aborts
its parked poll when a lane finishes, so the result goes out at once). The
relay does not know, and the app's next poll arrives inside the 5 s window. That
poll parks until the guard window ends (5 s after the frame was sent) instead
of the full 25 s, and the relay then answers it with the frame. The client must mark a lane busy before it sends the next poll, and must
ignore a frame whose `id` it already ran. A result for a command the relay no
longer holds (timed out, replaced) is acknowledged and dropped.

**`screen` frame** (relay to app, lane `screen`):

```
{"type":"screen","id":"<uuid>","lane":"screen","action":{"name":"<action>", ...}}
```

The relay normalizes `action` before sending: it keeps only the fields below,
fills the defaults shown, rounds numbers to whole numbers, and refuses anything
else without sending a frame. Coordinates are integers 0 to 20000 in pixels of
the screenshot the model saw (at most 1280 x 800). `display` is an integer 0 to
15 (0 is the primary monitor).

| `name` | Fields (default) |
|---|---|
| `screenshot` | `display` (0) |
| `click` | `x`, `y`, `button` (`left`\|`right`\|`middle`, left), `count` (1 to 3, 1), `display`, `screenshot` |
| `move` | `x`, `y`, `display`, `screenshot` |
| `drag` | `x1`, `y1`, `x2`, `y2`, `display`, `screenshot` |
| `scroll` | `x`, `y`, `direction` (`up`\|`down`\|`left`\|`right`), `amount` (1 to 50, 3), `display`, `screenshot` |
| `type` | `text` (1 to 5000 chars), `display`, `screenshot` |
| `key` | `keys` (1 to 100 chars, no control characters; xdotool style such as `ctrl+s`, `alt+tab`, `Return`, `F5`), `display`, `screenshot` |
| `wait` | `seconds` (above 0, at most 10, one decimal, 1), `display`, `screenshot` |
| `zoom` | `x1`, `y1`, `x2`, `y2` (`x2 > x1`, `y2 > y1`), `display` |
| `ui_tree` | `max_lines` (1 to 2000, 300). The app reads the display that holds the foreground window, reports it as `display`, and gives the coordinates of its lines in pixels of that display's screenshot. Each line is `[ref] Type "name" (x,y) verbs`: the verbs are the `ui_act` verbs the element supports, comma separated, from its UI Automation patterns (`invoke` InvokePattern, `set_value` ValuePattern that is not read-only, `toggle` TogglePattern, `expand,collapse` ExpandCollapsePattern, `select` SelectionItemPattern, `focus` when the element can take the keyboard focus). A line for an element with none ends after the coordinates, for example `[3] Pane (10,20)`, and a line for a disabled element ends with `disabled` in place of verbs, because every verb on it would fail. `expand,collapse` are left out for a leaf node (a tree item with no children). The example with verbs is `[12] Button "OK" (640,412) invoke,focus`. A `ui_act` with a verb the element cannot do is refused: `element N does not support VERB` when the pattern is missing, and `element N cannot do VERB: ...` when the control refuses it (`focus`, a read-only `set_value`) |
| `ui_act` | `ref` (whole number 0 to 1,000,000, from `ui_tree`), `verb` (`invoke`\|`set_value`\|`toggle`\|`focus`\|`expand`\|`collapse`\|`select`), `value` (required for `set_value`, optional for `select`, at most 5000 chars, left out for other verbs), `display`, `screenshot`. The app ignores `display` and takes the screenshot from the display of the last `ui_tree` |
| `block_input` | `on` (boolean, required), `minutes` (1 to 10, 10; present only when `on` is true) |
| `send_sas` | `display`, `screenshot` |
| `type_secret` | `text` (1 to 1000 chars), `display`, `screenshot` |

`screenshot` (boolean, default `true`) asks for a fresh screenshot of `display`
after the action, taken after a short settle (about 300 ms). The input's success
never depends on it: when the input switched the desktop the app captures the
new one, retrying for up to 2 s, and if that fails it answers `ok:true` with no
image and `text` "input sent; no screenshot: <reason>". `desktop` in an input's
result is read after the input. A `block_input` result carries
`input_blocked_until` (Unix ms on the relay's clock, absent when input is not
blocked), and the relay stores it at once. The app, not the
relay, enforces everything that depends on the PC: the 3-second customer
pause, the own-window guard, the refusal of elevated windows and the refusal of
Ctrl+Alt+Del in `key`. The relay itself refuses `block_input` and
`send_sas` unless the stored `control` is `full`, with the error `<name> needs
full control`, so a normal-mode app never receives them (it would also answer
`this needs full control`). `type_secret` is forwarded in both modes. Under full
control the service sends Ctrl+Alt+Del itself and answers `send_sas` with a
screenshot taken about 1.5 s later, or with an error when `SoftwareSASGeneration`
does not let services send it; every other screen action runs in the SYSTEM
helper on the console session, so `desktop` may be `secure`.

**`control` frame** (relay to app, lane `screen`):

```
{"type":"control","id":"<uuid>","lane":"screen","action":"request_full_control"}
```

The relay waits up to 120 s (plus 15 s) for it, because the customer may have to
answer UAC and dialogs. A normal-mode app runs the same elevation as at its
start. If the customer declines or elevation fails, it answers with a `result`
(`the customer declined full control`, `full control could not be set up on this
PC`, or that the account cannot get administrator rights). On success it sends
nothing: the new service says `hello` with `control:"full"`, and the app stops
its own client without an `end` and becomes the corner window. The service
itself answers a `control` frame with `{ok:true, control:"full", text:"full
control is already on"}`. A new
`hello` while this frame is the pending command resolves it: `control:"full"`
gives `{ok:true, control:"full", text:"full control is on"}`, anything else
gives the error `the app restarted without full control`. Every other pending
command fails with `agent replaced`, as for any new `hello`.

**`run` frame** gains `lane:"cmd"` and, for a lanes client only, `as`:
`"user"` (default) or `"system"`. The relay accepts only those two values
(`as must be user or system`). It refuses `system` unless the session's stored
`control` is `full`, with `as: "system" needs full control`, and sends nothing.
The app refuses it too, and any value but `user`, in normal mode (`as: "system"
needs full control`, `as must be user`). Under full control the service runs
`user` with the console user's token (the elevated linked token for an
administrator) in that user's session and profile folder, and `system` with its
own token; with nobody signed in, `user` fails with `nobody is signed in; use
as: "system"`. `put_file` and `get_file` then run as SYSTEM. `put_file` and `get_file` frames gain
`lane:"cmd"`.

**Screen and control results** (app to relay, `ok:true`):

```
{"type":"result","id":"<uuid>","generation":<n>,"ok":true,
 "image_b64":"<base64>","mime":"image/jpeg"|"image/png","width":<int>,"height":<int>,
 "display":<int>,"displays":<int>,"desktop":"default"|"secure"|"unknown","text":"<string>"}
{"type":"result","id":"<uuid>","generation":<n>,"ok":true,"control":"full"|"normal","desktop":"..","text":".."}   (control)
{"type":"result","id":"<uuid>","generation":<n>,"ok":false,"error":"<text>"}
```

Every field is optional unless noted, and `null` counts as absent. The relay
checks all of them and answers 400 `invalid result` for any violation. Fields
it does not list are dropped.

| Field | Rule |
|---|---|
| `ok` | exactly `true` (or `false` with `error`, cut to 1000 chars; an error result carries nothing else) |
| `image_b64` | string of at most 700,000 characters, length a multiple of 4, standard base64 alphabet with `=` padding only at the end. It must start with the JPEG signature (`/9j/`) when `mime` is `image/jpeg`, or the PNG signature (`iVBORw0KGgo`) when `mime` is `image/png`. **Required** for `screenshot` and `zoom` |
| `mime` | `image/jpeg` or `image/png`; required with `image_b64`, refused without it |
| `width`, `height` | whole numbers 1 to 8192; required with `image_b64`, refused without it |
| `display` | whole number 0 to 15 |
| `displays` | whole number 1 to 16, and above `display` when both are sent. The app reports at most 16 |
| `desktop` | `default`, `secure` or `unknown` (`secure` is the Winlogon desktop: UAC, lock, sign-in, Ctrl+Alt+Del) |
| `text` | string of at most 200,000 characters (2000 for `control`). **Required** for `ui_tree`. The app stops a `ui_tree` at about 190,000 characters and ends it with a `[more elements not shown...]` line |
| `input_blocked_until` | whole number above 0 (`block_input` results) |
| `control` | `full` or `normal` (`control` results only) |

The request body limit stays 750,000 characters, so the app steps JPEG quality
down until the image is under 700,000 base64 characters. The relay stores
`desktop` from any accepted result as the session's last seen desktop, and adds
the stored `control` to the operator's result when the app did not send one.
`type_secret` results never carry `text`. When the app reports `ok:false` for
`type_secret`, the relay drops the app's `error` and returns `type_secret
failed`. The app does the same on its side, so a secret can not come back in an
error.

**Poll report.** A poll may carry `desktop`, `paused_until` and
`input_blocked_until`. The first is one of the `desktop` values. The other two
are Unix milliseconds in the relay's clock (the app converts with `server_time`
from the welcome): `paused_until` is when the customer's 3-second input pause
ends, and `input_blocked_until` is when `block_input` lifts. A field the poll
leaves out keeps its stored value, `null` or an invalid value clears it, and a
bad value is never an error. `session_status` returns a deadline only while it
is in the future.

**Timeouts.** The relay waits `30 s + 15 s` for a `screen` result, plus the
seconds of a `wait` and 35 ms per character of `type` or `type_secret` text (the app types one character every 20 ms, about 21 ms measured, and about 31 ms when Windows ignores its 1 ms timer request),
then answers the operator `timeout waiting for agent`.

Audit log: DO SQLite table `log(ts INTEGER ms, kind TEXT, detail TEXT)`;
kinds `created, consumed, hello, attached, detached, run, put_file, get_file,
screen, control, ended`. Command text is logged, cut to 512 characters (a
`run` as SYSTEM starts with `(system) `); file content is not (path + byte
count only). A `screen` row holds the action in one short line, and **never**
content: `screenshot 1280x800` (written when the result arrives; `screenshot
failed` if it did not), `click 640,412` (then `right` and `x2` for a right or
double click), `move 5,6`, `drag 1,2 3,4`, `scroll down 3 at 5,6`, `type 12
chars` (a length, never the text), `key ctrl+s`, `wait 2s`, `zoom 1,2,3,4`,
`ui_tree`, `ui_act invoke 12` (the verb and ref, never the value),
`block_input on 10m` or `block_input off`, `send_sas`, and `type_secret` with
no length and no text. A non-zero display adds ` display <n>` (not for
`type_secret`). A `control` row is `request_full_control`. Screenshots and
every other image are never stored: not in SQLite, not in the registry, not in
a log. The relay does not write to the Worker log at all, so tool arguments and
results can not reach it. A `hello` row holds the stored, truncated machine
(100), user (100), ps (40) and agent (40) values, never the raw message. The
relay accepts one `hello` per socket: storage key `hello_tag` holds the tag of
the socket that has already sent one, and a reattach gets a new tag.
The `ended` row records the reason (`code TTL`, `consume TTL`, `expired`,
`ended_by_operator`, `customer`) and `session_status` returns it as
`ended_reason`. Rows for the caller-attributed kinds are prefixed `[<caller>]`.

## Agent wire (JSON text frames over `/ws`)

Relay → agent:
```
{"type":"welcome","expires_at":<ms>}
{"type":"run","id":"<uuid>","command":"<ps>","timeout_s":<1..600, default 60>}
{"type":"put_file","id":"<uuid>","path":"<abs>","data_b64":"...","append":<bool>}
{"type":"get_file","id":"<uuid>","path":"<abs>","offset":<int64>,"length":<int ≤ 524288>}
{"type":"end","reason":"expired"|"ended_by_operator"}
```
Agent → relay:
```
{"type":"hello","machine":"<COMPUTERNAME>","user":"<USERNAME>","ps":"<PSVersion>","agent":"1","version":"x.y.z"}
{"type":"result","id":"<uuid>","ok":true,"exit_code":<int|null>,"stdout":"...","stderr":"...","timed_out":<bool>}
{"type":"result","id":"<uuid>","ok":true,"bytes":<int>}                       (put_file)
{"type":"result","id":"<uuid>","ok":true,"data_b64":"...","size":<total int64>,"eof":<bool>}  (get_file)
{"type":"result","id":"<uuid>","ok":false,"error":"<text>"}
{"type":"end","reason":"customer"}
```
`run` results carry the child's real exit code; on a timeout the agent kills the
whole child process tree and reports `timed_out:true` with **`exit_code:null`**
(the relay/MCP passes the null through). `stdout`/`stderr` are captured as plain
text (child runs `powershell -OutputFormat Text` with `$ProgressPreference=
'SilentlyContinue'`, so no "Preparing modules" record; PS 5.1 still emits stderr as CLIXML under `-EncodedCommand`, so the agent decodes it to plain text — every stream, native stderr kept verbatim, progress dropped), each
truncated agent-side to 262,144 characters (not bytes) with a `[truncated]`
marker. The agent then
budgets the **whole serialized frame** by UTF-8 bytes: if a frame would exceed
~900 KB it shrinks stdout/stderr (keeping the marker) and re-serializes, so no
frame nears the ~1 MiB WebSocket message limit. If a command leaves a
background process holding the output pipes open, the agent does not wait for
them. It gives the streams 5 s after the child exits (or until the job's own
deadline, if that comes first), stops any children the exited child left
running that it can find, waits 1 s more, then sends the result with the real
`exit_code` and `timed_out:false`, an empty string for any stream that never
finished, and `[output incomplete: a background process kept the output open]`
appended to `stderr`. A timeout kill gets the same 5 s bound. The agent reads a
stream's result only once its task is complete, so a leftover process cannot
freeze the window, the WebSocket pump or End session. Relay waits for a matching
`result` up to `timeout_s + 15` s, else returns a timeout error to MCP. If no
agent is attached, tools error immediately with `agent not attached`.

`put_file` `data_b64` is capped at 700000 chars per call (isError with guidance
otherwise); `get_file` `length` is clamped to 524288 bytes. Chunk larger files:
write the first chunk with `append:false` and each further chunk with
`append:true`; read by advancing `offset` until `eof` (`size` is the total).

## The built-in agent

A technician can hand a task to an agent that runs on the relay: `agent_start`
or `POST .../agent/tasks` names a saved PC (or a session the caller drives) and
what is wrong, and a Durable Object works through it one step per alarm, with
nobody connected. It acts as the person who started the task, through the same
tools an MCP client has, on the team's own OpenAI or Claude key, within caps an
admin set. A team picks who runs sessions: MCP clients, the built-in agent, or
both, on the same sessions. One driver at a time still applies.

### Data

Migration `0006_agent.sql` adds two tables, each keyed by workspace first. Every
query is in `src/agent-store.js` and names the workspace.

- `agent_settings` (one row per workspace that set anything): `mode` (`mcp`,
  `agent` or `both`), `openai_key_enc` and `anthropic_key_enc` (sealed) with their
  `_hint` (last four characters), `default_model`, `models` (JSON, at most 10 added
  models), `starters_pick_model`, `task_cap_microusd`, `month_cap_microusd`. No
  row means mode `both`, the built-in default model, no keys, no caps, so no task
  can start. Money is whole micro-dollars; the API speaks dollars.
- `agent_tasks`: who started it, the PC or session, its state (`running`, `paused`,
  `done`, `stuck`, `stopped`, `failed`), `cost_microusd`, `reserved_microusd` (the
  call in flight), the tool call count, the end reason and the summary. The
  month's spend is the sum of cost and reservation over the rows that count toward
  the UTC calendar month (created in it, still live, or ended in it), so a task that
  crosses a month's end is never left out of both months and there is no counter to
  drift. Counting a task in two months can only make a cap stricter. The latest three summaries
  of a PC are the latest three ended rows with a summary for its `device_id`.

Changes to settings, a task starting and a task ending go through the team
store's guarded change, so their team log rows (`agent_settings_changed`, with
field names and model ids only, `agent_task_started`, `agent_task_ended`) commit
with them.

### Keys

`PATCH .../agent` saves `openai_key` and `anthropic_key` (`null` removes one). A
key is sealed with `seal(AUTH_SECRET, "agent-key-openai" or "agent-key-anthropic",
key, workspace)`, so it opens only for its workspace and use; saving one needs an
`AUTH_SECRET` of at least 32 characters. Only the last four characters are ever
shown. The key is opened only inside an `AgentTask` object: for each step of a task
and for a model check. A key that no longer opens (a rotated secret) stops a task
with "enter the key again", and removing a key stops the tasks that use it at
their next step. There is no deployment-wide key.

### Models

Five models are in the code, with their prices per million tokens (input, cached
input, cache write, output): `gpt-6.1-terra` ($1, $0.05, $1.25, $5) and
`gpt-6.1-sol` ($2, $0.10, $2.50, $10), both at 2x input and 1.5x output above
272,000 input tokens; `claude-opus-5-5` ($4, $0.20, $5, $20); `claude-sonnet-5-5`
($2, $0.10, $2.50, $10); and `claude-haiku-5-5` ($0.10, $0.01, $0.125, $0.50), all
5x above 100,000 input tokens. Neither provider's models API returns prices.

A model is usable when its provider has a key and it is the team's default or was
added. The default is `default_model`, else `gpt-6.1-terra` when there is an OpenAI
key and `claude-sonnet-5-5` otherwise. `POST .../agent/models` adds a model (at most
10): a table model without prices (it uses the table's), any other model with
`prices` (`input` and `output`, and optionally `cached_input`, defaulting to input,
and `cache_write`, defaulting to 1.25 times input). `DELETE
.../agent/models/<provider>/<id>` removes one. A task keeps the model, settings and
prices it started with. While `starters_pick_model` is on, whoever starts a task may
name a usable model; with it off every task uses the default.

Adding a model runs a two-turn check inside a fresh `AgentTask` object, with the
team's key: turn 1 must call a `look` tool, and turn 2 answers it with a 1.5 KB PNG
of a word, which the model must read back through an `answer` tool. Each call is
limited to 2,048 output tokens and 60 seconds. It records the settings the model
accepts. On Claude they come only from `GET /v1/models/<id>`: a retired model or
one without image input is refused, adaptive thinking is used when supported,
effort `medium` when supported, and the output limit is the lower of 16,000 and the
model's `max_tokens` (8,000 when unknown); Anthropic's 400 answers name no
parameter, so there are no retries. On OpenAI the first try sends reasoning effort
`medium`; a 400 naming `reasoning` is retried once without it, and one naming
`max_output_tokens` once with 4,000. A model whose output limit is under 4,000 is
refused. The list is written once, guarded on the list read before the check, so a
clash is a 409 and a retry never repeats a paid call. New prices for a model already
added are written with no check. The check's cost (at most two calls and three
retries) is shown in the answer and is outside the caps.

### Runner

`agent_start` and `POST .../agent/tasks` need real membership (never open mode) with
`sessions.control`, a mode other than `mcp`, both caps set, and a usable model. They
create the task row and the task object. The row is inserted under a guard that no
other task is live on the same PC or session, so two starts at once make one task. The
first step connects to the PC with the `device_connect` path as the starter (a PC set
to ask still asks), or uses the given session, whose driver must be the starter or
nobody. The connect is recorded before it is made; if the object died after the relay
made the session and before it saved it, the next step takes up the live session on
that PC whose driver is the starter instead of connecting again, and an end of the task
before that step ends it. Only a session created by that connect counts (the Session's
`/watch` answer carries its `created_at`: no earlier than the connect began, no more than
60 seconds after), and a session found is saved at once, so a retry never ends a later one. A refused connect made no session, so nothing is adopted or
ended after one. While `EMERGENCY_STOP` is set, `POST .../agent/tasks` answers 503
`relay_stopped` and makes no task, as `agent_start` refuses.

Each alarm runs one step:

1. Read the task's row. It is the truth: Stop and Pause win. A stopped task ends its
   session and stops; a paused one makes no call and keeps one alarm, at 2 hours
   after it was created, where the time limit and the starter's standing end it. A
   resume wakes it and counts as a read of its status.
2. Check the limits (120 tool calls, 2 hours), the watching rule (below) and the
   starter: the operator's stop, the workspace, the account (for an OAuth starter),
   members only, `sessions.control`, and the workspace stop. A failure ends the task
   with that reason. A step that throws (the database could not answer, the team was
   busy) is counted in the task's storage and tried again after 5, 10, 20 and 40
   seconds; the fifth failure in a row ends the task as `failed`.
3. Read the settings and open the key; end the task if the caps or the key are gone.
4. Check the session: the driver is still the starter, nobody else has sent a command to
   a link session since the task began, and the session has not ended.
5. Ask the model. The worst case of the call is reserved in D1 first, in one guarded
   update that holds only if the task's cost plus the reservation fits the task cap and
   the month's spend plus it fits the month cap, so tasks running at once cannot pass a
   cap together. The output limit shrinks to fit what is left, never under 4,000
   tokens; below that the task ends with "spending cap reached". Input is estimated from
   the request's size on the high side (ASCII text at 1 token per 3 characters, any other
   character at half its UTF-8 bytes, a fixed 1,800 per image), and the same estimate
   decides when a fresh conversation starts (over 100,000 tokens) and which
   long-context price a reservation uses. The real cost settles the reservation
   afterwards. A reservation the object never settled is charged in full. So is the
   reservation of a call that got no HTTP answer (a timeout or a dropped connection),
   because the provider may still bill it; a call answered with an error status was
   refused, and its reservation is released.
6. Read the row again, and look at the session again. A stop or pause now means the
   action is not sent. So does a session that has ended or that someone else now drives
   or commands. A pause that lands on a reply with no tool call leaves the
   conversation ending with "Call a tool, or call finish.", so a resume is valid.
7. Record the call as `sending`, run it through the tool path as the starter (marked
   `via: "agent"` for the session log), record it done, and set the next alarm. A
   repeat alarm that finds `sending` sends nothing and answers that call "outcome
   unknown; take a screenshot".

The model sees the session tools without `session_id` and without `type_secret`,
`block_input`, `send_sas`, `request_full_control`, the session and PC tools and the
agent's own tools, plus `note` (progress, 400 characters) and `finish` (`done`,
`stuck` or `needs_human`, with a summary of at most 600 characters). `run` as
`system` and `put_file` are allowed, as for an MCP client. One call per reply: extra
calls are answered "not run". A reply with no tool call gets "Call a tool, or call
finish."; two in a row end the task as `stuck`.

Conversations are append-only, in memory, in the provider's own shape: OpenAI reasoning
items are replayed in order with their encrypted content, and a Claude thinking block
comes back as the model gave it, with the binding set to drop a block on a mismatch.
Screenshots are never stored. A fresh conversation starts every 12 tool calls or after
the object restarts, from the task, the last note and a new screenshot. Stored per task
are only redacted step records (the verb and a short detail, never typed text) and the
notes.

Everything from the PC (screens, UI text, command output, file contents, the PC's fields,
and earlier summaries) and the task's own last note is wrapped in `<untrusted>` tags, with
any closing tag inside it disarmed (in any letter case, and with spaces inside the tag),
and the system prompt says it is data and never an instruction. The note is the agent's own
record and may repeat text from the screen. The first
request of a task carries the PC's record and the last three summaries of that PC with
their age and who started them.

Without `keep_working`, a task stops 2 minutes after the last read of its status
(`agent_status` with a `task_id`, or `GET .../agent/tasks/<id>`). Reads go through the task
object so it records them, and `wait_s` (up to 25) holds a read until something changes.
A task ends the saved-PC session it opened when it finishes, stops or fails, and leaves a
session it was given. The Session object enforces the exception: the task asks it to end
the session only while the starter is still the driver, so a session someone else took
over, even one the task has not noticed yet, stays open. The task counts as cleaned up
only when the Session confirms the end, says it is already over, or says another person
drives it. If the Session or the database cannot be reached, the task row keeps its
stopped, done or failed state and the object keeps an alarm that tries again after 5, 10,
20, 40, 80, 160 and then 300 seconds. After 20 tries (about 75 minutes) it gives up, adds
a note to the task telling the starter to end the session by hand (`session_end` or the
PC's End session). An error inside a retry counts as a try and sets the next alarm; one
cleanup runs at a time.

### Providers

OpenAI: the official `openai` SDK, Responses API, `maxRetries: 0`, `store: false`,
`service_tier: "default"`, `include: ["reasoning.encrypted_content"]`,
`parallel_tool_calls: false`, `truncation: "disabled"`, strict function tools, the
whole conversation replayed each turn, screenshots as `input_image` inside the
`function_call_output`, and the task id as `prompt_cache_key`. Cost: `input_tokens`
includes the cached and cache-write tokens, so those are subtracted before the input
price. Claude: `@anthropic-ai/sdk`, Messages API, `maxRetries: 0`, `x-api-key` and API
version 2023-06-01 (the SDK's own defaults are a bearer token and a newer version; step 0
verified these), adaptive thinking and effort from the saved settings, caching on the
system prompt, the last tool and the tail, `tool_choice` with parallel use disabled.
Cost: `input_tokens` is the uncached rest, plus cache writes (the 5-minute price) and reads.

A provider's error text is never shown (OpenAI's 401 echoes part of the key): the runner
maps each answer to a fixed sentence. A 429 whose code names credit, quota, billing or a
spend or usage limit, a 402, a bad key, a model the key cannot use and a refused request
stop the task. Any other 429, a 503, a 5xx and a network failure retry with backoff
(2, 4, 8, 16, 32 and 60 seconds) for 2 minutes, then the task pauses with the reason.

### What the providers keep

The relay keeps no conversation at a provider, and sends `store: false` to OpenAI, but
the providers' own retention applies. OpenAI keeps abuse-monitoring logs for up to 30
days even with `store: false`, keeps flagged images for review, and holds cached prompt
state for up to 24 hours. Anthropic keeps requests and answers under its own retention
terms, and holds a cached prompt for a few minutes. Screenshots, UI text, command output
and file contents the agent reads go to the team's provider: check that the team may
share what is on its customers' screens.

### Limits and cost of running it

A task is limited to 120 tool calls and 2 hours. On the free plan, a Durable Object alarm
is not held to the 10 ms of a request: step 0 measured an alarm that built, stringified and
parsed a request body of 2 MB in 9 ms of CPU, 8 MB in 19 to 24 ms and 34 MB in 94 to 97 ms,
none cut off. A conversation holds at most 12 screenshots (about 1,225 tokens each on
OpenAI), and the real tool list and system prompt are about 3,900 input tokens. A task
object holds about 128 MB while it works, so 2 hours is about 900 GB-s, and the free plan's
13,000 GB-s a day is about 14 fully active two-hour tasks.

## MCP tools (`tools/list`, `tools/call`)

Implement `initialize` (protocolVersion echo of the client's if it is one of
`2025-06-18`, `2025-03-26`, else `2025-06-18`; serverInfo `support-mcp`),
`notifications/initialized` (202, no body), `tools/list`, `tools/call`, `ping`.
Responses `application/json`. Tool errors return `result.isError=true` with a
text content item, not JSON-RPC errors.

| Tool | Args | Returns (text content, JSON) |
|---|---|---|
| `session_create` | `label?` string, `windows_mode?` (`app` default, `powershell`; deprecated aliases `legacy`, `standard`) | `app`: `{session_id, windows_mode, download_url, one_liner, code_expires_at}` with `download_url` = `<origin>/j/<code>?client=app` and one-liner = `Start-Process '<download_url>'`. `powershell`: `{session_id, windows_mode, one_liner, code_expires_at}` with one-liner = `irm <origin>/j/<code> \| iex`. An unknown mode is a tool error and creates nothing. |
| `session_list` | — | sessions from the caller's workspace's Registry with state + expires_at + machine |
| `session_status` | `session_id`, `log_tail?` (default 20) | state, `windows_mode` (`app` or `powershell`), machine, user, expires_at, startup_expires_at, attached now?, `client_version` (the `version` of the last hello when it sent a valid one, else its `agent` string), `client_agent` (the `agent` string of the last hello, or `null`; it names the protocol generation), last log rows; `app` sessions add `elevated` (`true`, `false`, or `null` when the app did not report it), `control` (`full`, `normal` or `null`), `caps` (array), `desktop` (`default`, `secure`, `unknown` or `null`), `paused_until` and `input_blocked_until` (Unix ms while in the future, else `null`) |
| `run` | `session_id`, `command`, `timeout_s?`, `as?` (`user` default; `system` needs full control and is refused otherwise) | exit_code (null if timed out), stdout, stderr, timed_out |
| `put_file` | `session_id`, `path`, `data_b64`, `append?` | bytes |
| `get_file` | `session_id`, `path`, `offset?`, `length?` | data_b64, size, eof |
| `session_end` | `session_id` | `{ended:true}`; sends `end` to agent first |
| `device_list` | `site?` (an id), `status?` (`active` or `pending`), `after?` (an id) | `{devices:[...], next, untrusted_text}`: the team's device shape plus `online` (true while the PC's doorbell is connected; false when the Registry cannot be read), from one Registry request per call. Names, contacts and custom field values come from people and are untrusted data |
| `device_connect` | `device_id`, `ask?` (boolean), `take_over?` (boolean) | `{session_id, state:"waiting"\|"attached", asks, rang}`. `rang` is true when the PC's doorbell was connected (else the PC sees the request within about 5 minutes). Refused: an unknown PC or one in another workspace, a waiting PC, an `app_version` below 0.6.0 (`this PC updates itself to 0.6.0 first`), a PC already in a session without `take_over` (`<who> is connected`) and a stopped workspace. See [Saved-PC sessions](#saved-pc-sessions) |

| `agent_start` | `device_id` or `session_id`, `instructions`, `keep_working?`, `model?` | `{task_id, state:"running", provider, model, device_id, session_id, task_cap_usd, month_cap_usd, keep_working, next}`. See [The built-in agent](#the-built-in-agent) |
| `agent_status` | `task_id?`, `wait_s?` (0 to 25) | with a `task_id`: `{task, caps, untrusted_text}`, where `task` has the state, end reason, model, cost, the tool calls (verb and short detail), the notes and the summary. Without one: `{tasks, caps, default_model, starters_pick_model, models, untrusted_text}` |
| `agent_control` | `task_id`, `action` (`pause`, `resume`, `stop`) | `{task_id, state}` |

The tools above are in every connection, with the screen tools below. `?ui=0`
hides `ui_tree` and `ui_act` (`?ui=1` is the default); any other value gets 400
`{"error":"unknown ui value; use 0 or 1"}` after the Access check. The `shape`
parameter no longer exists: a request that carries it, with any value, gets 400
`{"error":"the shape parameter was removed; ..."}` rather than a silently
different tool list. A tool that the connection does not list is `unknown tool`.
Every tool except `session_create`, `session_list`, `device_list`,
`device_connect` and the three agent tools requires `session_id`. When
it is missing, empty or not a string, `tools/call` returns a tool error
`session_id is required; call session_list to find it` and nothing reaches the
backend. There is no default session.

| Tool | When listed | Maps to |
|---|---|---|
| `screenshot`, `click`, `move_mouse`, `drag`, `scroll`, `type_text`, `press_key`, `wait`, `zoom` | always | `screenshot`, `click`, `move`, `drag`, `scroll`, `type`, `key`, `wait`, `zoom`, with the field names of the `screen` frame table |
| `ui_tree`, `ui_act` | unless `ui=0` | `ui_tree`, `ui_act` |
| `block_input`, `send_sas`, `type_secret` | always | `block_input`, `send_sas`, `type_secret`. The first two are refused without full control; `type_secret` works in both modes |
| `request_full_control` | always | a `control` frame; returns `{control, text?, desktop?}`. A normal-mode app asks the customer through UAC; on success the result comes from the service's `hello` (`full control is on`) |

`mcp.js` turns a tool call into the normalized
action and `backend.screen({session_id, action})`, and the Session checks the
action again. A screen tool returns an image content block (`{type:"image",
data, mimeType}`) when the result has an image, then a text block with the other
result fields as JSON (`width`, `height`, `display`, `displays`, `desktop`,
`control`, `text`). Every screen tool takes `session_id`. The descriptions tell
the model that screenshots and UI text are untrusted, to type the password
with `type_secret` at the sign-in screen if the operator gave one in the
conversation and otherwise to stop and ask, to work from screenshots (zoom
for small text, the app's own Ctrl+F for text on a long page), to treat
`ui_tree` and `ui_act` as a fallback for when a screenshot and zoom are not
enough (the sentence is left out of the `screenshot` description under `ui=0`,
and no description names the two tools then), and to use `block_input` only
when the operator asks.

In normal mode the downloaded app accepts an already elevated launch only after an explicit
consent prompt whose default answer is No. An elevated reconnect
also gets that prompt unless the customer approved one administrator reconnect
during preparation. That approval is bound to the current user, session and
expiry, and the reconnect consumes it. The window and the consent text say that
the access is administrator access, and the `hello` carries an `elevated`
boolean. In normal mode commands inherit the app's consented token. The app
requests elevation only through UAC, for full control. It runs each command in a fresh non-interactive
`powershell.exe -NoProfile` inside a Windows Job Object, so cancellation,
timeout or the app exiting kills the whole process tree. When the command exits,
what it started without waiting (PowerShell does not wait for a GUI program,
such as `rundll32.exe user32.dll,LockWorkStation`) gets up to a second to finish
by itself, then the Job stops the rest. Output is capped at
64 KiB per stream. The PowerShell agent rules below still apply to that agent.

## PowerShell agent (`src/agent.ps1`)

Windows PowerShell 5.1, no admin, no modules beyond the box. Never runs
elevated. Per-session state is suffixed with `<sid8>` = the first 8 hex chars of
the sid, so two sessions on one PC never collide: folder
`%LOCALAPPDATA%\SupportMCP\<sid8>\`, Run value `SupportMCP-<sid8>`, task
`SupportMCPCleanup-<sid8>`. Three roles in one file, chosen by argument:

1. **Bootstrap** (what `irm | iex` runs in the customer's console): write itself
   (from the embedded base64 body) plus `config.json` (`sid, key, origin,
   expires_at, connect_by`) to `%LOCALAPPDATA%\SupportMCP\<sid8>\`, then start
   the `-Run` agent and print one line. `connect_by` is the local first-connect
   deadline in Unix ms, bootstrap time + 2 hours, equal to the relay's
   `CONSUMED_TTL_MS`. The bootstrap does **not** write the logon Run value (the
   `-Run` role does, see below). **If the pasted console is elevated** (current
   token is in the Administrators role), do not run anything elevated: launch the
   `-Run` agent as the interactive user at a limited run level via a one-shot
   scheduled task (`New-ScheduledTaskPrincipal -RunLevel Limited -LogonType
   Interactive`; register → start; a `finally` always unregisters it) and print
   a line saying so. If that launch, or the plain launch of the `-Run` agent in
   a non-elevated console, throws, nothing is running, so the bootstrap runs the
   cleanup to remove the folder it wrote and prints a failure line.
2. **Run**: WinForms window, TopMost on first show, title `Support
   session`, a label `Support session active until HH:mm` (local time, after
   welcome), a read-only log box (each command / file op one line, timestamped),
   an **End session** button. **Refuses to run if its own token is elevated**
   as a backstop: with UAC off, or on the built-in Administrator account, the
   limited launch task still gets a full token. The refusal runs the cleanup
   (below) and exits, so the folder and any task are removed and no logon entry
   is left. Once it passes that check, the role writes the per-user logon
   reattach (`HKCU\…\Run` value `SupportMCP-<sid8>`), but only after it has
   loaded `config.json` and passed the `expires_at` / `connect_by` checks
   below, so a broken or already-expired start never creates it. WebSocket via
   `System.Net.WebSockets.ClientWebSocket` with the key in the `X-Attach-Key`
   header; connect and reconnect are non-blocking (the connect task is polled
   from the timer). The `/ws` probe runs only after a drop or a failed connect.
   The UI thread's network and query waits all have a bound: a send waits up to
   5 s and then aborts the socket, the close handshake up to 2 s, the probe up
   to about 15 s when DNS stalls (`Invoke-WebRequest -TimeoutSec 3` does not
   bound name resolution), and the orphan WMI query up to about 3 s. Receive is
   polled from a `Windows.Forms.Timer`, draining every completed receive per
   tick. Commands run as a child `powershell.exe -NoProfile -NonInteractive
   -OutputFormat Text -EncodedCommand` (a `System.Diagnostics.Process` with both
   streams read async and polled from the timer; the whole tree is killed via
   `taskkill /T /F` at timeout).
   On welcome, persist `expires_at` to `config.json` and register the **fallback
   task** `SupportMCPCleanup-<sid8>` (per-user, `Register-ScheduledTask`,
   one-time trigger at `expires_at`, with `New-ScheduledTaskSettingsSet
   -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable` so
   it fires on battery / after sleep) that runs the cleanup. A restarted agent
   whose persisted `expires_at` has already passed cleans up by itself without
   the relay. While `expires_at` is still null (no welcome yet), `connect_by`
   plays that part: a start or a timer tick after `connect_by` runs the cleanup
   and exits, and the window registers the same fallback task with its trigger
   at `connect_by`, so cleanup happens even if the agent is killed. Welcome
   re-registers the task (`-Force` replaces it) at the real `expires_at`; if
   that registration fails, the `connect_by` task is removed so it cannot end a
   live session early. A config with no `connect_by` (older agent) just has no
   first-connect deadline. Reconnect with backoff (5 s → 60 s) on drop while not expired; a
   410/401 from the `/ws` probe = session over → cleanup. FormClosing on a
   Windows shutdown / Task Manager kill / `Application.Exit` closes **without**
   ending the session (reattach after reboot must work); only a user close
   confirms and ends.
   **Cleanup** (layer B, also the fallback task's action and the End action):
   kill every tracked child (tree), remove the Run value, unregister
   `SupportMCPCleanup-<sid8>`, then from a detached, **retrying** cmd delete
   `%LOCALAPPDATA%\SupportMCP\<sid8>` (the running script file is in it) and
   remove the parent `SupportMCP` folder if it is now empty, exit.

## Windows app (`src/agent-app.cs`)

.NET Framework 4 (the v4 compiler that ships with Windows, x86, `/warnaserror+`),
WPF window, `asInvoker` manifest, one exe with several roles chosen by the first
argument (see [Full control](#full-control)). It reads its configuration from its
own file footer, asks for full control first (see the consent rules in
[docs/security-model.md](security-model.md)), falls back to normal mode only after
an explicit Allow (default Don't allow), and keeps a small window docked
bottom-right: a connection state, a running timer, when the
session ends by itself, and a **blue** state while a command or file operation
runs. The window does not show commands, paths or output. End session, Alt+F4
and the taskbar Close ask "End the session?" inline first. An operator end,
expiry or the fixed 24-hour limit shows "Support is disconnected." and closes
the window after four seconds. In normal mode the app installs no service,
scheduled task or logon entry, so restarting the PC stops it, and it removes its
private temporary command directory on normal exit. Its hello says `agent:
"windows-app-2"`, `version` (the release), `caps: ["screen","uia","lanes"]` plus `"full"` when this
account can elevate, and `control: "normal"`. The window adds "Running without
administrator access." Screen control runs in the app's own process on the
user's desktop: capture is a BitBlt of a display scaled down to fit 1280 x 800 and sent
as JPEG under 700,000 base64 characters; input is `SendInput`; UI Automation
reads the foreground window. It reports at most 16 displays and caps a
`ui_tree` at about 190,000 characters. Typed text goes as Unicode key events, one
every 20 ms, with Return and Tab for newlines and tabs. Input stops when the
session ends or the customer uses the PC. It keeps a mutex per session so a
second copy exits. `scripts/prepare-app-restart.ps1` can prepare one automatic reconnect
after a restart the customer authorized: it combines the tested payload with
the existing downloaded configuration under
`%LOCALAPPDATA%\SupportMcp\<sid8>\agent.exe` and arms a one-time `HKCU` RunOnce
entry. The reconnect never extends the session's `expires_at`. The prepare
prompt records the customer's approval of screen, mouse and keyboard control next
to the reconnect (a second registry value, bound to the user and the deadline). A
reconnect that finds no such record starts without the `screen` cap. A prepared
reconnect is normal mode only.

### Full control

Roles, by the first argument of the one exe:

| Role | Runs as | Does |
|---|---|---|
| none | the customer | shows the corner window, decides the consent path (UAC prompt, the app's own confirm when no prompt will appear, or unavailable when a standard user has UAC off), asks "Give support full control of this PC?", runs `--elevate-install` with `ShellExecuteEx` `runas`, and reads its exit code. Before a UAC prompt the question stays open after Allow and is the prompt's owner window (`SHELLEXECUTEINFO.hwnd`): Windows shows the prompt on the secure desktop only for an app in the foreground, and the customer's click puts the app there. On 0 it becomes the corner window of the service; on UAC No (1223), any failure or Don't allow it shows the fallback dialog |
| `--elevate-install <deadline> <0\|1> <app pid> <nonce>` | administrator, through UAC | installs nothing unless the attempt's named event `Local\SupportMcpElevate-<sid8>-<nonce>` (a random 128-bit nonce; the app refuses to use one that someone created first) exists and is not set. It keeps the event open and checks it again before it starts the service: the app sets it when it stops waiting for UAC (End session, the session ended, `request_full_control` unanswered for 110 s), and it is gone when the app exited before the Yes. It runs from a copy the app put alone in a new Temp folder, reads its own file once through a handle that denies writing and renaming, creates `%ProgramFiles%\SupportMCP-<sid8>\` with `CreateDirectoryW` and its final ACL (SYSTEM and Administrators only, inheritance off), failing if it exists, copies the exe as `agent.exe` and, cut before its configuration, as `window.exe` (Users may read and run it), writes `state.json` (the full session id and the deadline), takes a share of `SoftwareSASGeneration` under `HKLM\SOFTWARE\SupportMCP` and sets it when needed, registers the backstop task, then creates and starts the service. Any failure removes all of it. The deadline is UTC milliseconds: `connect_by` before the first connection, the session's expiry after it |
| `--service` | LocalSystem, session 0 | the relay connection with both lanes (`control:"full"`, caps with `full`). It checks its deadline at start and every 2 s, moves the backstop task to `expires_at` at the first welcome (later welcomes can only bring it closer), follows session changes, sends Ctrl+Alt+Del with `SendSAS`, and runs cleanup |
| `--helper <service pid>` | SYSTEM, on the console session (`TokenSessionId`), `winsta0\default` | every screen operation, each on a fresh thread switched to the input desktop (`OpenInputDesktop`, `SetThreadDesktop`); low-level hooks re-armed on each desktop; `block_input` on one thread that holds `BlockInput` and runs every operation while it lasts. It serves two pipes only SYSTEM can open, checks that the client is the service, and runs in a kill-on-close Job of the service |
| `--window <sid8>` | the signed-in user (`WTSQueryUserToken`), started by the service at each sign-in | the corner window, through a pipe open to interactive users only (read and write data, no new instances) that answers `{"type":"status"}` and `{"type":"end"}` and closes on anything else or after 5 s of silence. It serves the active console session only, at most 2 connections per process. The window sends `end` on its open connection until the status says ended, and says it cannot reach the service when the pipe is gone |

Pipe messages are a 4-byte length and UTF-8 JSON, and pipe clients connect at
the identification level only. The backstop task runs at the deadline as SYSTEM,
also late when the PC was off, under a name of its own per install
(`SupportMcp-<sid8>-<random>`), with three actions in order, every tool by its
full `System32` path: `cmd` (`sc stop`,
`taskkill` of the service process, `sc delete`), PowerShell (release this
session's share of `SoftwareSASGeneration` under the `Global\SupportMcp-Sas`
mutex the app uses too), and `cmd` (a retrying `rd /s /q` of
the folder, then `schtasks /delete` of itself once the session has no entry left
in the record). It never runs the app. Nothing changes the record without the
mutex: after 30 s an install goes on without the share, and a release changes
nothing and keeps the session's entry and its task. The task repeats every hour
until it deletes itself, so a release that was skipped happens later. The
service's own cleanup does the same in process and leaves the folder and then the
task to a detached `cmd` that runs after it exits; when `cmd` cannot start,
`MoveFileEx` deletes the files at the next restart and the task stays. As SYSTEM,
`put_file` and `get_file` refuse a path that contains a junction, a symbolic link
or (to write) a file with a second hard link; they hold every folder of the path
while they work and create missing folders one level at a time. A system shutdown stops the service without `end`, so the session goes on
after the restart within the same `expires_at`.

`scripts/build-app.ps1` compiles on Windows and writes `src/app-bundle.json`.
`node --test` fails when the source or manifest hash in the bundle is stale.
`test/app-native.cs` is compiled with the app source (`/main:AppTests`) on a
Windows host. It runs the real client against a fake relay and covers HTTP
operations, Unicode, chunking, retry deduplication, process-tree cancellation,
timeout, local expiry, the reconnect rules, the two lanes, the 4xx result
replacement, the pause cross-check, the display and ui_tree caps, the stop
and pause checks of typing, and the pure parts of full control: the consent
path, the folder and file ACLs (checked with `icacls`), the deadline state, the
backstop command line and task XML, the token choice for `run`, the
`block_input` timer and its Ctrl+Alt+Del escape, the pipe framing and the
window's two requests, and the Client's full-control path with a fake service.

### Saved PC

The same exe also serves a saved PC. The first thing it reads is its footer. A
footer with `"kind":"device"` (from `/install`) goes only to the setup wizard or
to the device install. `Wire.ReadConfig` throws on any footer with a `kind`, so
no session role (`--service`, `--helper`, `--window`, `--elevate-install`, the
default and resume paths) can run on a device footer. `Wire.ReadDevice` reads
`kind: "device"`, checks the origin as a session footer does, and accepts at most
one of a valid code or a slug. It refuses a session footer.

| Role | Runs as | Does |
|---|---|---|
| none, with a device footer | the owner | the setup wizard, "Support setup", five steps (code, name, how support connects, how much control, install). Nothing is preselected for the last two. It first checks for the `SupportMcpDevice` service and, if it exists, says "Support is already set up on this PC" and opens the tray. It starts `--device-install` elevated with `ShellExecuteEx` `runas` and reads the exit code. After exit 0 or 10 it starts the installed exe with `--tray` as the owner |
| `--device-install <nonce> <answers>` | administrator, through UAC | stages and holds its exe like `--elevate-install`, turns on the safe DLL search, reads its own file and footer once, and goes ahead only if the wizard's named event for `<nonce>` still exists and is not set. `<answers>` is one base64url JSON argument: name (1 to 100 characters), access, control, and either the code or "use the workspace" (at most 1,024 characters; no key). It takes the origin and the workspace from its own footer. Exit codes: 0 active, 10 pending, 20 code invalid, 21 network, 22 refused, 23 already set up, 24 blocked (another program made the setup mutex first, or made it so this account cannot open it; the wizard says "Another program is blocking Support. Restart the PC and try again." and offers Try again). It pairs over `/device/pair`, creates `%ProgramFiles%\SupportMCP` with the locked ACL, writes `support.exe` (the exe without its footer, Users may read and run it), `device.json` and `history.json` (locked), registers the service `SupportMcpDevice` ("Support device service", LocalSystem, automatic, restart on failure, quoted path, `--device-service`), the `HKLM` Run value `SupportMcpTray` and the Apps entry, and starts the service. Any failure after pairing sends `/device/leave` with the new key and rolls back only what this run made. One install or remove runs at a time, under the `Global\SupportMcpDeviceSetup` mutex, which the install owns as Administrators; a second gets "already set up". Any signed-in user can make a `Global` name before the install does, with an access list of their own, and Windows then opens theirs and ignores ours. So a mutex that already exists is used only when SYSTEM or Administrators own it, and one whose owner cannot be read, or that this account may not open, counts as hostile (exit 24). It never touches `HKLM\SOFTWARE\SupportMCP` |
| `--device-service` | LocalSystem, session 0 | reads `device.json` and checks in with `/device/hello` at start, then on the schedule in [The check-in schedule](#the-check-in-schedule): every 6 hours plus up to 10 minutes of jitter, at each ring and when the doorbell connects, while the PC is active and its doorbell is up; otherwise every 5 minutes measured from the last answer plus up to 30 seconds of jitter (always, while pending). After a network error it retries after 1 minute, doubling to 15. A 200 updates the name, access, control and state (active or pending); control only goes down, because a check-in can lower full to limited and never raises it. A 401 means removed (after active) or expired (while pending), and ends check-ins and the doorbell for good. A 426 means the app needs an update and is retried every 6 hours. It keeps the last 50 history lines in `history.json`. It keeps the doorbell open from its start. An active PC's answer may carry `session`; the service then hosts it as [Sessions on the PC](#sessions-on-the-pc) says. Outside a session it runs no command, takes no screenshot and opens no file for the relay. It downloads and switches to an update only while no session is waiting or live (a session in the answer, or a run that has not finished, holds updates back). When an answer carries `update` and the checks in [Updates](#updates) pass, it downloads the release, writes it as `support-<version>-<8 hex>.exe` in the install folder with the app's ACL from the moment it exists, reads it back and hashes it through a handle that denies writing (held until it stops), records it in `update.json`, and starts its own exe with `--device-update <file>`. A release whose download or checks failed is tried again an hour later at the earliest. Starting on trial (below), it records `"started": true` in the trial, renews the deadline to at least 4 minutes from now, and starts `--device-update-rollback --at-deadline` from the old exe. On trial, a 200, 202 or 401 commits; a 426 or any other refusal (a 4xx) starts `--device-update-rollback` from the old exe instead; no network or a 5xx keeps the trial open and retries the hello every 30 seconds, and commits once the deadline is 90 seconds away or less. A commit that finds the setup mutex held tries again 5 seconds later. A service that starts while its own rollback was cut short starts `--device-update-rollback` again; a trial record that names neither its file nor the old one and is 10 minutes past its deadline is cleared, keeping the failed versions and the previous file. Outside a trial it deletes every version file but its own and the previous one; one a tray still runs is renamed to `<name>.<8 hex>.del` and that name is queued for the next restart |
| `--device-update <file>` | LocalSystem, session 0, a child of the service | the switch. It takes the setup mutex (busy: exit 30), checks that `<file>` is the version file the service recorded in `update.json` and hashes it again through a handle that denies writing (refused: exit 31), and writes the trial (`from`, `to`, both versions, a 4-minute deadline). It sets the service's failure actions to run `"<old exe>" --device-update-rollback` on every failure, crashes and stops with an error alike; stops the service (stopped or stopping already is fine); points the service's command line, the `HKLM` Run value and the Apps entry's `UninstallString`, `DisplayVersion` and `EstimatedSize` at the new file; and starts it. It then watches `update.json` and rolls back itself if the trial is still open at its deadline, as `update.json` holds it then, and at least 4 minutes after it started (exit 32), else exits 0. Its hold on the file ends before the watch |
| `--device-update-rollback` | LocalSystem, the failure action or a child of the new service | records the version as failed (never taken again), stops the service, points everything back at the old file with its own version and size, puts back the normal failure actions (restart twice, a minute apart), adds a history line, closes the trial and starts the service, trying again for up to 5 minutes when it will not start. The service is started again even when a step fails midway. With no trial open it only puts back the normal failure actions and starts the service; with `update.json` unreadable it changes nothing and only starts the service |
| `--device-update-rollback --at-deadline` | LocalSystem, a child of the new service at its start on trial | the deadline watcher that survives a restart. It takes the setup mutex, renews the trial's deadline to at least 4 minutes from now, and then watches like the switch: it exits 0 once the trial is committed or rolled back, and rolls back a trial still open at the deadline (exit 32) |
| `--device-ask <answer>` | the signed-in user, started by the service in the session it asks | the question before a saved-PC session. `<answer>` is one base64url JSON argument of at most 2,048 characters holding exactly `by`, `team` and `control` (never a key). The dialog is the consent dialog's: "Allow <technician> to connect to this PC?" (or "Allow your support team", with no name), naming the technician and the team, saying what the control level allows, and that the corner window and the Support icon end it. "Don't allow" is the default, "Allow" does nothing for its first 500 ms, and with no answer after 2 minutes it closes as "Don't allow". Exit 10 is Allow; anything else (11, a crash, a malformed argument, no answer) is no |
| `--tray` | the signed-in user, started by the `HKLM` Run value at each sign-in | one per session (a `Local` mutex). A notification icon drawn at run time, and a panel with the name, the access mode, the state, who is connected ("No one is connected.", or "Connected: <technician>" with an "End session" button while a session is live), recent history, "Uninstall Support" and a small "Version x.y.z" line (the service's version; hidden when an older service sends none). The mode line says "Support asks you before each connection. Your support team's admins can change this." in `ask`, and "Support can connect any time." with "Only your support team can change this." in `any`. It reads the service through the pipe, with at most two pipe connections at once (the service allows two per process), and exits when this PC's uninstall event is set. The event's name comes from the status frame and is opened only when SYSTEM or Administrators own it A tray keeps running the file it started from until the next sign-in, after an update too |
| `--uninstall` | the owner | copies itself to a new Temp folder and runs from there. Confirms, then starts `--device-remove` elevated and shows "Support was removed" |
| `--device-remove <nonce>` | administrator, through UAC | runs from the copy the uninstaller staged (it reads `device.json`, not a footer, so it holds no exe of its own), and goes ahead only while the uninstaller's named event for `<nonce>` still exists. It sends `/device/leave` (a 200 or a 401 both count as done), sets this PC's uninstall event (and the fixed `Global\SupportMcpDeviceUninstall` of 0.5.0, for trays still on it, each only when SYSTEM or Administrators own it) so every tray exits, waits a few seconds and ends any tray that remains, stops and deletes the service, deletes the Run value and the Apps entry, and removes the folder: it is renamed aside first (so a reinstall at the original path is never blocked), deleted with the junction-safe walk, and anything still locked is queued for the next restart. If the relay cannot be reached, or answers anything else (a refusal or a server error), it still removes everything and the owner is told the team must remove the PC. It ends trays started from any exe in the install folder (`support.exe` or a version file), and the folder removal takes every version file and `update.json` with it. One install, remove or update switch runs at a time, under a `Global` mutex. The setup mutex gets the same owner check as the install's; a hostile one is exit 22 and the window shows "Another program is blocking Support. Restart the PC and try again." Exit codes: 0 removed, 10 removed but the relay did not confirm, 20 failed, 21 busy (the mutex is held, or an update's trial is open and less than 10 minutes past its deadline), and then the window says to try again in a few minutes, 22 blocked |

The service's pipe is `SupportMcpDevice-ui`. Only SYSTEM can create instances,
interactive users can read and write data, and it is never open to the network. It
serves every interactive session, with a cap of two connections per process (the
tray, which has three threads that use it, passes them through a gate of two).
Messages are a 4-byte length and UTF-8 JSON. It answers `{"type":"status"}` with
`{name, access, control, state, confirm?, last_ok_at, history, version, session?,
uninstall_event?}`. `version` is the running service's own. `state` is `active`,
`pending`, `expired`, `removed`, `update_needed` or `offline`. `confirm` is the six
digits while pending. `session` is `{by, since}` (who drives it, Unix ms) only
while a session is live. `uninstall_event` is the random part of this install's
uninstall event name. The other requests are `{"type":"refresh"}` with a check-in
now, at most once every 30 seconds; `{"type":"allow_any_time"}`, which is answered
at once and sends `access: "any"` to `/device/update` in the background when the
mode is `ask` (the change shows on the next status read); and
`{"type":"end_session"}`, which ends the live session with the reason `owner` only
when the caller is in the Windows session the service serves, and does nothing
otherwise. Every request is answered with the status frame. No request sets `ask`,
and the service never sends `ask` on its own. A message with any other type, or
with any other key, closes the connection. A removed or expired state is kept in
`device.json`, so a restart serves it from the pipe without checking in again. A
saved install uses names of its own (the service, the folder, the pipe, the event
and the mutexes), so it does not collide with a one-off session's.

The uninstall event is `Global\SupportMcpDeviceUninstall-<32 hex>`. The service
makes it (SYSTEM and Administrators full control, interactive users may wait on it
and read its owner), keeps the random part in `device.json` as `uninstall_event`,
and puts it in the status frame. Any signed-in user can read that part, so every
opener (a tray, the uninstaller) checks the owner first and uses the event only
when SYSTEM or Administrators own it (issue #22).
When the service finds the name already taken by someone else, or by an object it
may not open, it picks a new part. The SAS mutex (`Global\SupportMcp-Sas`) and the
update lock (the setup mutex) follow the same rule; a squatted SAS mutex is
skipped as busy, and a squatted update lock holds the update back.

### Sessions on the PC

What the service does with a session. The relay's side is in
[Saved-PC sessions](#saved-pc-sessions).

  - *The pointer.* Each active PC's `/device/hello` answer may carry `session`:
    `{id, by, team, ask, expires_at}`. A new `id` starts a run. A run whose `id`
    has left the answer ends locally, and the service goes back to checking in
    without touching anything installed. A pending PC never gets a session. `by`
    and `team` are shown to the person, so the service cleans them first; an `ask`
    that is not exactly `false` counts as `true`.
  - *Where it runs.* The console session when someone is signed in there. Else the
    one active Remote Desktop session with a user. Several of those: the PC
    declines `busy`, as it cannot tell whom to ask. None: nobody is signed in.
  - *Whether it asks.* It asks when the session says `ask` or the PC's own access
    is `ask`. With nobody signed in, only a full-control PC set to any time hosts
    (on the sign-in screen); anything that would ask, and every limited PC, declines
    `nobody`. A service that restarts and finds the session it already allowed
    (`accepted_session` in `device.json`) rejoins without asking again.
  - *The question.* `--device-ask`, as the signed-in user in that session, names
    the technician and the team. "Don't allow" is the default, and no answer in 2
    minutes is "Don't allow". The service treats a crash, a closed dialog or no
    exit within 15 seconds after that as no. A no sends `{"type":"decline",
    "reason":"declined"}` to `POST /agent?sid=<id>` with the device key as Bearer;
    one that did not reach the relay is sent again at the next check-in while the
    answer still carries the `id`, without asking again.
  - *Hosting.* After a yes, or when nothing needed asking, the service saves the
    `id` as `accepted_session` (cleared when a check-in no longer carries a
    session) and runs the session with the app's polling client, the device key as
    Bearer. Full control works as SYSTEM: the helper runs on the target session (the
    console, the sign-in screen, or the one Remote Desktop session), and the hello
    says `control: "full"`. Limited support is the signed-in user: the session
    is pinned to that session and that user, the helper, the corner window and
    every command run with the user's own token, files are opened while
    impersonating the user, nothing works once another user is there, and the hello
    says `control: "normal"`.
  - *The corner window.* `--window <id>` as the signed-in user shows who is
    connected, the timer and End session, from the service's per-session pipe
    `SupportMcp-<id>-ui`, which only the target session may use. The person can
    also end it from the tray's End session; either sends `end` with the reason
    `owner`. When it ends, a saved PC's window says "Session ended after
    HH:MM:SS." and then "Your support team can connect again later." (any time) or
    "Your support team will ask you before connecting again." (ask first). A
    one-off link's window says "Support can no longer reach this PC."
  - *Stops.* Stopping the service ends the live session. Windows shutting down
    keeps it, and the saved `accepted_session` lets the restarted service rejoin.

Whatever starts or names the installed app (the tray at sign-in, the wizard's
"Open Support", the tray's "Uninstall Support", the Apps entry) uses the exe in the
service's command line when it is a version file in the install folder, and
`support.exe` otherwise. A fresh install always writes `support.exe`.
`update.json` in the install folder (locked like `device.json`) holds the
versions that failed their trial, the previous version's file, the staged file
with its size and SHA-256, and an open trial with `"started": true` once the new
version's service has run. A service that starts while a trial it is the old side
of is still open (a restart midway) puts itself back, and records the version as
failed only when the trial says it started. `update.json` is written through a
temp file flushed to disk and swapped in, with a few retries, and read with every
sharing mode; a step that cannot read it changes nothing. One-off session apps
never update themselves.

## Acceptance (each names its check)

1. `npm test` green; `npx wrangler deploy --dry-run` bundles without error
   and lists `env.DB` as a D1 database.
2. Local stack (`wrangler dev`, `.dev.vars` with `DEV_SKIP_ACCESS=1`): MCP
   `initialize` → `tools/list` returns the 7 session tools and the two device
   tools (`device_list`, `device_connect`) plus the nine screen tools, `ui_tree`,
   `ui_act`, `block_input`, `send_sas`, `type_secret` and `request_full_control`,
   and the three agent tools (27), `?ui=0` drops `ui_tree` and `ui_act`, and `?shape=...` is a 400 (curl).
3. `/mcp` without the JWT on a non-localhost host → 403 (unit test with a fake
   host + a test for bad aud / expired / wrong sig using a locally generated
   RSA key).
4. `/j/<code>` second fetch → 404 invalid-link script (curl twice).
5. A Windows test PC as customer (smoke via `ssh -R` to the local stack):
   one-liner → window shows, `run whoami` returns the interactive `machine\user`,
   `put_file` then `get_file` round-trips bytes identical, `session_end` →
   folder, Run value and task all gone.
6. Expiry: with a test-only shortened TTL (`.dev.vars` `SESSION_TTL_MS`, honoured
   only under the same localhost guard), the alarm ends the session, agent
   cleans up, `/ws` then 410.
7. Kill the agent process mid-session → fallback task still removes everything
   at expiry (shortened TTL).
8. Never-connected agent: run the one-liner against a relay that is then taken
   down, edit `connect_by` in `config.json` to a few minutes ahead and restart
   the agent. At that time the window closes (or the fallback task fires if the
   agent was killed), and the folder, Run value and task are gone. Starting the
   agent after `connect_by` has passed cleans up at once.
9. Elevated console with UAC off (or the built-in Administrator): paste the
   one-liner. No window opens, and a few seconds later the folder, the Run
   value and the `SupportMCPLaunch-` and `SupportMCPCleanup-` tasks are gone.

10. App mode: `session_create` with no `windows_mode` returns a `download_url`.
    Opening or refreshing that page leaves `session_status.state` at `pending`.
    The button downloads `remote-support-<sid8>.exe` once, the state becomes
    `consumed`, a second click shows "Check your downloads", and the app attaches
    over `/agent` after the customer clicks Allow and then Yes in the UAC prompt (the service's `hello` says `control: full`), or Allow in the fallback dialog (`control: normal`). `windows_mode: "legacy"` and
    `"standard"` behave as `app` and `powershell`.

11. Saved PC: a technician's pairing answer carries a `link`. `GET` of that link
    shows the page and consumes nothing. `POST` from the page downloads
    `support-setup.exe`, whose device footer names the relay and the code. The
    setup wizard pairs the PC after one Windows permission prompt, the team API
    lists it with its name, access and control, and the tray shows its state.
    Uninstalling from Settings > Apps makes the key answer 401 and leaves no
    service, folder, `SupportMcpTray` value, Apps entry or pipe, and leaves
    `HKLM\SOFTWARE\SupportMCP` as it was (the recipe is in
    [development.md](development.md#installing-a-saved-pc-on-a-test-machine)).

12. Built-in agent: with both caps and a key saved, `agent_start` on a saved PC
    connects as the caller, works through the session tools one step at a time,
    and finishes with a summary under both caps. `agent_status` follows it,
    `agent_control` pauses, resumes and stops it, and the session's log names the
    agent's actions as the starter's, marked `via agent`. `test/agent-*.test.js`
    drive this against fake providers; the live checks are in the PR 7 plan.

## Must keep

- `/healthz` stays public and 200.
- The PowerShell agent never runs elevated and no relay code path requests UAC.
  The app asks for elevation only for full control: at its start, where the UAC
  prompt (or the app's own confirm when none will appear) is the customer's
  consent, and on an explicit `request_full_control` call.
- Full control in a one-off session always removes itself: on any end of the
  session, at its own deadline, and through the backstop task, which never runs
  the app. A saved PC stays until its owner uninstalls it, and uninstalling
  removes the PC's key at the relay.
- The service of a saved PC runs a command, takes a screenshot or opens a file
  only inside a session its own record points at and that it accepted (asking the
  person at the PC when the session or its own setting says ask), a limited PC
  never acts as the system, a check-in never raises a PC from limited to full
  control, and nothing in the app turns the access mode
  from `any` back to `ask` (the relay still accepts either mode from a holder of
  the key, as pinned earlier). It installs releases signed with the project's
  release key and nothing else, never a version lower than or equal to its own,
  and never bytes whose size or SHA-256 differ from the signed note.
- The relay never holds the release private key and never needs it; CI holds
  none either.
- A screenshot, typed text and a secret are never stored by the relay: not in
  the audit log, the Session storage, the registry or the Worker log.
- `ended` is terminal; no path reopens a session or extends `expires_at`.
- Every `tools/call` checks the caller's role before it reaches a session; team
  management is never an MCP tool, and neither is stopping or resuming a
  workspace.
- A saved PC is connected without asking the person at it only for a caller who
  holds `sessions.unattended`, which open mode never grants; and switching a PC to
  `any` needs it too.
- Customer, site, device and custom field data is never read when the relay
  decides who may do what. A device key is never in a URL, never logged, stored
  only as a hash, compared in constant time, and refused on a request with an
  `Origin` header. `/device/` and `/install` stay public and outside every Access
  app.
- The built-in agent acts only as the person who started its task, through the same
  tool path, role checks and stops as an MCP call, and the starter is checked
  again before every model call: an active account, a real member (never open
  mode) holding `sessions.control`. Team settings, keys, caps and mode are never an
  agent tool.
- A team's AI provider key is sealed at rest, opened only inside an `AgentTask`
  object, and never appears in an API answer, a tool result, a log row, a team log
  row, a step record or an error. A provider's own error text is never shown.
- The relay never stores a screenshot or typed text for the agent either: the
  conversation lives in the task object's memory, and the stored step records
  hold only the verb and a short detail.
- No secrets in the repo: `.dev.vars` gitignored; attach keys stored hashed.
