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
| `app` (default) | opens a link, clicks a button, runs the downloaded `remote-support-<sid8>.exe`, clicks Yes in the UAC prompt (or Allow for limited support) | Windows 7 to 11 with .NET Framework 4.5.2 or later (Windows 10 and 11 include it; 8.1 needs the 4.5.2 update; 7 needs it installed). The app requests TLS 1.2 itself; Windows 7 needs no registry change | HTTPS polling on `POST /agent` |
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
  service-token headers.

## Components

| Path | What |
|---|---|
| `src/index.js` | Worker entry: imports `agent.ps1` and `app-bundle.json`, wires `src/app.js`, exports the DO classes |
| `src/app.js` | router, Access gate, MCP JSON-RPC handler, download page (pure: no `.ps1` import or DO classes, so `node --test` can drive routes) |
| `src/session.js` | `Session` Durable Object (SQLite-backed), one per session |
| `src/screen.js` | the screen vocabulary: lanes, the normalized actions, their audit text, and the strict check of every app result field (pure, shared by `mcp.js` and `session.js`) |
| `src/registry.js` | `Registry` Durable Object, single instance `idFromName("registry")`, lists sessions |
| `src/agent.ps1` | PowerShell agent template (imported as text, placeholders substituted) |
| `src/agent-app.cs`, `src/agent-app.manifest` | the Windows app: .NET Framework 4 source (WPF window) and an `asInvoker` manifest |
| `src/app-bundle.json` | the compiled x86 app plus the SHA-256 of its source and manifest, built by `scripts/build-app.ps1` and checked by tests |
| `scripts/prepare-app-restart.ps1` | optional one-time reconnect after an authorized restart |
| `test/` | `node --test` unit tests for pure logic (JWT checks, MCP dispatch, template fill, screen validation) and for the Durable Object (lanes, screen and control frames, audit rules) |

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
| `GET /j/<code>?client=app` | public | The downloaded app. `legacy` is an alias for `app`; any other `client` value → 404. **https only**: over plain `http:` on any host except `localhost` / `127.0.0.1` → 403 `text/plain`, code **not** consumed. `GET` serves the download page (200 `text/html`, `Cache-Control: no-store`, `Referrer-Policy: same-origin`, a CSP with `default-src 'none'` and `form-action 'self'`) and **never consumes the code**, however often the page is opened or refreshed. Only a `POST` from the page's button consumes it. If the request has an `Origin` header it must equal the relay's own origin exactly. If it has none (IE11 on Windows 7 can omit it on a same-origin form POST), its `Referer` must start with `<origin>/j/`, which the page's `Referrer-Policy: same-origin` keeps on the click. A foreign `Origin`, a foreign or missing `Referer` without an `Origin`, or neither header → 403, code unused. A first valid `POST` returns 200 `application/octet-stream` with `Content-Disposition: attachment; filename="remote-support-<sid8>.exe"`: the compiled app followed by the session configuration (below). The code is single use: a repeat after the download shows "Check your downloads" (409), an expired or ended one shows "This support link has expired" (410). A code made for a `powershell` session shows the expired page and stays unused. `HEAD` and every other method → 405 (`Allow: GET, POST`). |
| `POST /agent?sid=<sid>` + `X-Attach-Key: <key>` | attach key | The app's transport, JSON in and out; below. 403 over plain `http:` on any host except `localhost` / `127.0.0.1`, 403 on any `Origin` header or a `key` query param, 405 on other methods, 415 on a non-JSON body, 413 over 750,000 characters (checked against `Content-Length` before the body is read, and again after it is read when there is no `Content-Length`), 401 on a bad sid, bad key, a `powershell` session or a session that is still `pending`, 409 on a stale generation, 410 when the session has ended. |
| `GET /ws?sid=<sid>` + `X-Attach-Key: <key>` | attach key | WebSocket upgrade for the agent; 403 over plain `http:` on any host except `localhost` / `127.0.0.1`; 401 on bad/missing key, on a `key` query param, on a bad sid, or on an `app` session; 410 if session ended/expired |
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
{"type":"hello","machine":"..","user":"..","ps":"..","agent":"windows-app-2","elevated":<bool>,
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
screenshot taken about 1.5 s later; every other screen action runs in the SYSTEM
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
| `session_create` | `label?` string, `windows_mode?` (`app` default, `powershell`; deprecated aliases `legacy`, `standard`) | `app`: `{session_id, windows_mode, download_url, one_liner, code_expires_at}` with `download_url` = `<origin>/j/<code>?client=app` and one-liner = `Start-Process '<download_url>'`. `powershell`: `{session_id, windows_mode, one_liner, code_expires_at}` with one-liner = `irm <origin>/j/<code> \| iex`. An unknown mode is a tool error and creates nothing. |
| `session_list` | — | sessions from Registry with state + expires_at + machine |
| `session_status` | `session_id`, `log_tail?` (default 20) | state, `windows_mode` (`app` or `powershell`), machine, user, expires_at, startup_expires_at, attached now?, `client_version` (the `agent` string of the last hello), last log rows; `app` sessions add `elevated` (`true`, `false`, or `null` when the app did not report it), `control` (`full`, `normal` or `null`), `caps` (array), `desktop` (`default`, `secure`, `unknown` or `null`), `paused_until` and `input_blocked_until` (Unix ms while in the future, else `null`) |
| `run` | `session_id`, `command`, `timeout_s?`, `as?` (`user` default; `system` needs full control and is refused otherwise) | exit_code (null if timed out), stdout, stderr, timed_out |
| `put_file` | `session_id`, `path`, `data_b64`, `append?` | bytes |
| `get_file` | `session_id`, `path`, `offset?`, `length?` | data_b64, size, eof |
| `session_end` | `session_id` | `{ended:true}`; sends `end` to agent first |

The tools above are in every connection, with the screen tools below. `?ui=0`
hides `ui_tree` and `ui_act` (`?ui=1` is the default); any other value gets 400
`{"error":"unknown ui value; use 0 or 1"}` after the Access check. The `shape`
parameter no longer exists: a request that carries it, with any value, gets 400
`{"error":"the shape parameter was removed; ..."}` rather than a silently
different tool list. A tool that the connection does not list is `unknown tool`.
Every tool except `session_create` and `session_list` requires `session_id`. When
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
timeout or the app exiting kills the whole process tree. Output is capped at
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
"windows-app-2"`, `caps: ["screen","uia","lanes"]` plus `"full"` when this
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
| none | the customer | shows the corner window, decides the consent path (UAC prompt, the app's own confirm when no prompt will appear, or unavailable when a standard user has UAC off), runs `--elevate-install` with `ShellExecuteEx` `runas`, and reads its exit code. On 0 it becomes the corner window of the service; on UAC No (1223), any failure or Don't allow it shows the fallback dialog |
| `--elevate-install <deadline> <0\|1>` | administrator, through UAC | runs from a copy the app put alone in a new Temp folder, reads its own file once through a handle that denies writing and renaming, creates `%ProgramFiles%\SupportMCP-<sid8>\` with `CreateDirectoryW` and its final ACL (SYSTEM and Administrators only, inheritance off), failing if it exists, copies the exe as `agent.exe` and, cut before its configuration, as `window.exe` (Users may read and run it), writes `state.json` (the full session id and the deadline), takes a share of `SoftwareSASGeneration` under `HKLM\SOFTWARE\SupportMCP` and sets it when needed, registers the backstop task, then creates and starts the service. Any failure removes all of it. The deadline is UTC milliseconds: `connect_by` before the first connection, the session's expiry after it |
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
the folder, then `schtasks /delete` of itself). It never runs the app. The
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

## Acceptance (each names its check)

1. `node --test` green; `npx wrangler deploy --dry-run` bundles without error.
2. Local stack (`wrangler dev`, `.dev.vars` with `DEV_SKIP_ACCESS=1`): MCP
   `initialize` → `tools/list` returns the 7 base tools plus the nine screen
   tools, `ui_tree`, `ui_act`, `block_input`, `send_sas`, `type_secret` and
   `request_full_control` (22), `?ui=0` drops `ui_tree` and `ui_act`, and
   `?shape=...` is a 400 (curl).
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
    over `/agent` after the customer clicks Yes in the UAC prompt (the service's `hello` says `control: full`), or Allow in the fallback dialog (`control: normal`). `windows_mode: "legacy"` and
    `"standard"` behave as `app` and `powershell`.

## Must keep

- `/healthz` stays public and 200.
- The PowerShell agent never runs elevated and no relay code path requests UAC.
  The app asks for elevation only for full control: at its start, where the UAC
  prompt (or the app's own confirm when none will appear) is the customer's
  consent, and on an explicit `request_full_control` call.
- Full control always removes itself: on any end of the session, at its own
  deadline, and through the backstop task, which never runs the app.
- A screenshot, typed text and a secret are never stored by the relay: not in
  the audit log, the Session storage, the registry or the Worker log.
- `ended` is terminal; no path reopens a session or extends `expires_at`.
- No secrets in the repo: `.dev.vars` gitignored; attach keys stored hashed.
