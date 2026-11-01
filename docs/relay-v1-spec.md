# relay v1: build spec

The wire contract and acceptance criteria the relay was built against: relay
Worker + Durable Objects, PowerShell agent, three-layer teardown, MCP endpoint.
Code signing is out of scope: `irm | iex` content carries no Mark of the Web,
so SmartScreen does not apply.

## Design choices

- **Pairing code is 16 chars of base32 (80 bits), not 6 digits.** The customer
  pastes the one-liner, never types the code, so length costs nothing and it
  removes brute force. Still single use, 10 min TTL.
- **The MCP server is the Worker itself** (`POST /mcp`, streamable-HTTP JSON
  responses). No local wrapper process. Claude Code connects with the Access
  service-token headers.

## Components

| Path | What |
|---|---|
| `src/index.js` | Worker entry: imports `agent.ps1`, wires `src/app.js`, exports the DO classes |
| `src/app.js` | router, Access gate, MCP JSON-RPC handler (pure — no `.ps1` import or DO classes, so `node --test` can drive routes) |
| `src/session.js` | `Session` Durable Object (SQLite-backed), one per session |
| `src/registry.js` | `Registry` Durable Object, single instance `idFromName("registry")`, lists sessions |
| `src/agent.ps1` | PowerShell agent template (imported as text, placeholders substituted) |
| `test/` | `node --test` unit tests for pure logic (JWT checks, MCP dispatch, template fill) |

`wrangler.toml`: add DO bindings `SESSION` → `Session`, `REGISTRY` → `Registry`,
`[[migrations]] tag="v1" new_sqlite_classes=["Session","Registry"]` (free plan
needs SQLite-backed DOs), `[[rules]] type="Text" globs=["**/*.ps1"]`, and
`[vars] ACCESS_TEAM_DOMAIN="<team>.cloudflareaccess.com"`,
`ACCESS_AUD="<Access app AUD tag>"`. Keep the custom-domain route. Free plan: 10 ms CPU per request, so no heavy
work in the request path; use the WebSocket Hibernation API
(`ctx.acceptWebSocket`) and a DO alarm for expiry.

## HTTP surface

| Route | Auth | Behaviour |
|---|---|---|
| `GET /healthz` | public | `{"ok":true,"service":"support-mcp","stage":"relay-v1"}` |
| `GET /j/<code>` | public | **GET only, https only.** The code is consumed only for a request whose `User-Agent` contains `PowerShell/` (`irm` sends `WindowsPowerShell/5.1.x` or `PowerShell/7.x`). Code valid+unused → 200 `text/plain` agent script with placeholders filled, code consumed; else 404 `text/plain` `Write-Host 'This support link is invalid or expired.'` (runnable, harmless). Any other `User-Agent` (a chat link preview, a browser) → 200 `text/plain`, `Cache-Control: no-store`, a one-line `Write-Host` telling the reader to paste the command into PowerShell, and the Durable Object is **not** touched. Over plain `http:` on any host except `localhost` / `127.0.0.1` → 200 `text/plain` `Write-Host` line asking for the https link, code **not** consumed. Any other method → 405 `text/plain` (harmless one-liner, `Allow: GET`) and the code is **not** consumed. Malformed percent-encoding → the same harmless 404 script, never 500. The `User-Agent` test keeps previews from burning the code. It is not a security control, since any client can send the header. |
| `GET /ws?sid=<sid>` + `X-Attach-Key: <key>` | attach key | WebSocket upgrade for the agent; 403 over plain `http:` on any host except `localhost` / `127.0.0.1`; 401 on bad/missing key, on a `key` query param, or on a bad sid; 410 if session ended/expired |
| `POST /mcp` | Access JWT | MCP JSON-RPC 2.0 |
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

## Access check (`/mcp`)

`/mcp` accepts **POST only** (else 405, `Allow: POST`). Because the Access app
also admits a browser (cookie) identity, guard against CSRF first, before the
Access check:

- any request carrying an `Origin` header → 403 (MCP clients never send Origin;
  browsers always do on a cross-origin POST). Applies even under the local bypass.
- a non-`application/json` `Content-Type` → 415.

Then require header `Cf-Access-Jwt-Assertion`. Verify RS256 against
`https://<ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs`, `aud` contains `ACCESS_AUD`,
`exp` in the future, `nbf` (if present) not in the future beyond 60 s of skew,
`iss` = `https://<ACCESS_TEAM_DOMAIN>`. Failure → 403 JSON `{"error":"forbidden"}`.
The signing keys are cached in module scope for 1 h and fetched lazily (only once
a well-formed token names a `kid`); an unknown `kid` forces one refetch that
**bypasses the edge cache** (`cache:'no-store'`) and is rate-limited to at most
one per 60 s. Local bypass: only when `env.DEV_SKIP_ACCESS === "1"` (set from
`.dev.vars`, never committed) **and** the request URL hostname is `localhost` or
`127.0.0.1`. The deployed hostname can never satisfy it.

The caller identity — `email` (user), else `common_name` (service token), else
`sub`, or `local-dev` under the bypass — is threaded to the DO and recorded in
the audit log for `session_create`, `run`, `put_file`, `get_file`, `session_end`.

## Session state machine (Session DO)

`pending` (code minted, 10 min TTL) → `consumed` (script fetched, awaiting WS,
TTL 2 h to first attach) → `attached` (expires_at = first attach + 24 h,
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
`not-pending`. `/ws` checks the deadline and state again after it hashes the
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

Audit log: DO SQLite table `log(ts INTEGER ms, kind TEXT, detail TEXT)`;
kinds `created, consumed, hello, attached, detached, run, put_file, get_file,
ended`. Command text is logged, cut to 512 characters; file content is not
(path + byte count only). A `hello` row holds the stored, truncated machine
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
{"type":"hello","machine":"<COMPUTERNAME>","user":"<USERNAME>","ps":"<PSVersion>","agent":"1"}
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

## MCP tools (`tools/list`, `tools/call`)

Implement `initialize` (protocolVersion echo of the client's if it is one of
`2025-06-18`, `2025-03-26`, else `2025-06-18`; serverInfo `support-mcp`),
`notifications/initialized` (202, no body), `tools/list`, `tools/call`, `ping`.
Responses `application/json`. Tool errors return `result.isError=true` with a
text content item, not JSON-RPC errors.

| Tool | Args | Returns (text content, JSON) |
|---|---|---|
| `session_create` | `label?` string | `{session_id, one_liner, code_expires_at}`; one-liner = `irm <origin>/j/<code> \| iex` |
| `session_list` | — | sessions from Registry with state + expires_at + machine |
| `session_status` | `session_id`, `log_tail?` (default 20) | state, machine, user, expires_at, startup_expires_at, attached now?, last log rows |
| `run` | `session_id`, `command`, `timeout_s?` | exit_code (null if timed out), stdout, stderr, timed_out |
| `put_file` | `session_id`, `path`, `data_b64`, `append?` | bytes |
| `get_file` | `session_id`, `path`, `offset?`, `length?` | data_b64, size, eof |
| `session_end` | `session_id` | `{ended:true}`; sends `end` to agent first |

No elevate tool, no screen tools.

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
2. **Run**: WinForms window, TopMost on first show, title `Remote
   support`, a compact notice with the information icon whose height changes
   when the log is shown. Its headline and detail line follow the connection:
   `Connecting to remote support...` / `This window stays open while support
   is connected.` before the first welcome; `A remote support agent is
   connected to your machine.` / `Session active until ddd d MMM, HH:mm.` and
   `You can end it at any time.` (local time) after welcome; and `Remote
   support is reconnecting...` with the same end time after a disconnect, or on
   a reattach that loaded `expires_at` from config. A `Show activity` /
   `Hide activity` link toggles a read-only log box (hidden at start; each
   command / file op one line, timestamped), next to an
   **End session** button. **Refuses to run if its own token is elevated**
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

## Acceptance (each names its check)

1. `node --test` green; `npx wrangler deploy --dry-run` bundles without error.
2. Local stack (`wrangler dev`, `.dev.vars` with `DEV_SKIP_ACCESS=1`): MCP
   `initialize` → `tools/list` returns exactly the 7 tools (curl).
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

## Must keep

- `/healthz` stays public and 200.
- Nothing ever runs elevated; no code path requests UAC.
- `ended` is terminal; no path reopens a session or extends `expires_at`.
- No secrets in the repo: `.dev.vars` gitignored; attach keys stored hashed.
