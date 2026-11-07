# Security model

This is the full security design. The README's [Security](../README.md#security)
section has the short version.

The customer runs a program that came from a link, so the design starts from
what that program may and may not do. The app is the default. Bullets that
apply to only one client say which.

- **Consent is always a click.** Full control is the default. The app first
  asks "Give support full control of this PC? Support can see your screen,
  control your mouse and keyboard, work through Windows security prompts and
  the sign-in screen, and keep working after a restart. Access ends when you
  click End session, or after 24 hours, and everything is removed." On **Allow**
  the question stays open, says "Windows will ask for permission to give
  support full control.", and Windows' own UAC prompt asks, with **No** as its
  default. The question is the prompt's owner window. Windows shows a UAC
  prompt on the secure desktop only for an app in the foreground, otherwise as a
  flashing taskbar button the customer may miss, and an app in the background
  (a start from a download or Explorer, or `request_full_control`) cannot take
  the foreground by itself. The customer's click on Allow gives it to the app.
  Allow does nothing for its first half second, so a click or typing meant for
  another window cannot press it; Escape, Enter or Space decline at once
  (**Don't allow** has the focus), which starts the one-minute cooldown. The
  app never answers UAC. The question is not a
  barrier against the operator: in normal mode the operator's `run` and screen
  tools work as the customer and can press Allow through UI Automation. UAC
  **Yes**, which only the customer can click on the secure desktop, is the
  consent to full control. When no UAC prompt would appear (the app already
  runs as administrator, UAC is off, or an administrator elevates without a
  prompt), the question is the only consent, and an operator in normal mode
  already has the customer's administrator rights. The question is modeless,
  so End session in the corner window works while it waits. While UAC shows on
  the secure desktop, only UAC itself can be answered; a prompt parked in the
  taskbar leaves End session usable. If the app stops waiting before the
  customer answers UAC (End session, the session ended, `request_full_control`
  unanswered for 110 s, the app closed), it withdraws the request: each attempt
  makes a named event with a random nonce, which only it may create, and the
  elevated installer goes ahead only if that event exists and is not set. The
  installer keeps it open and checks it again before it starts the service, so
  a withdrawal stops an install that already runs, and the app exiting after
  Yes (a sign-out) does not. Like the question, the withdrawal is no barrier
  against the operator: in normal mode the operator's code runs as the customer
  and could start a process outside the command's Job that holds the event. What
  holds is UAC **Yes**, which only the customer can click, and End session or
  `session_end`: the relay refuses the new service's `hello` for a session that
  ended. Until a withdrawn prompt is gone (answered, or dropped by Windows),
  `request_full_control` asks no new one, so only one prompt exists, and a No
  on it starts the cooldown. Windows drops an unanswered prompt after about
  two minutes and reports that as a No; the app counts only a No given within
  115 seconds of the prompt as a decline, so a dropped prompt starts no
  cooldown, also at the first start, which then still offers limited support.
  A prompt parked as a taskbar button is not dropped (measured for 8 minutes on
  Windows 11 and 7 on Windows 7), so a refusal because an earlier prompt is
  still open lasts until the customer answers that prompt.
  If the customer says No anywhere,
  or elevation fails, the app asks "Continue with limited support? Support can
  see your screen and control your mouse and keyboard, but not Windows
  security prompts." Every dialog has **Don't allow** selected by default, and
  the customer decides with a click. Don't allow on the last one ends the app
  with nothing installed.
- **The window shows that access exists.** The app's window stays on top in the
  bottom-right corner while support is connected. It shows a running timer and
  when the session ends by itself, turns blue while a command, file or screen
  operation runs, says "Paused while you use the PC" while the customer's input
  has the right of way, and has an **End session** button. It never shows commands, paths or
  output. End session, Alt+F4 and the taskbar Close all ask "End the session?"
  first. The PowerShell agent's window is different: it lists every command and
  file operation as it runs.
- **Full control is a temporary SYSTEM service.** UAC elevates a copy of the
  app that the app first puts alone in a new folder under the user's Temp, so
  nothing next to the download (an `.exe.config`, a DLL) loads into the elevated
  process. The app deletes that folder through handles: each level is
  opened as itself and checked, entries are opened relative to their folder, and
  a junction or link is removed, never followed. Copies left behind are swept at
  a later start only when the app runs without administrator rights. The elevated process reads its own file once, through a handle that stops
  anyone from changing or renaming it, and installs from those bytes. Between the
  copy and that read, another process of the same user could swap the copy. That
  is accepted: such a process already runs as the customer, and the threat model
  does not defend the customer from their own account. It creates
  `%ProgramFiles%\SupportMCP-<id>\` in one step with its final ACL (SYSTEM and
  Administrators only, inheritance off) and fails if anything exists there; it
  never adopts an existing folder. `%ProgramFiles%` comes from the registry, not
  from an environment variable the user could set, and Users cannot create,
  rename or delete anything in it, so nobody else can hold a handle to the
  folder or put a file in it. SYSTEM code never runs from Downloads or Temp. The service `SupportMcp-<id>` owns the
  relay connection and says `control: full`. It starts two processes on the
  console session: a helper with a SYSTEM token, which runs every screen
  operation and so reaches the secure desktop (UAC, the lock and sign-in
  screens, Ctrl+Alt+Del), and the corner window with the signed-in user's own
  token. The window's copy of the exe has no session settings, so the file a user
  can read holds no attach key. The service and the helper talk over a pipe only
  SYSTEM can open, and each checks the other's process id. The window's pipe is
  open to interactive users, never to the network, with the rights to read and
  write data but not to add a pipe instance. It serves only processes in the
  active console session, at most two connections per process, so another
  user's session (a user switch, Remote Desktop) cannot take its connections. It
  answers only a status read and `end`; anything else, or nothing for 5 seconds,
  closes the connection. Whoever is at the console can end the session through
  it, which is the point of the window. The window sends `end` on the connection
  it already holds until the service confirms the session ended; if it cannot
  reach the service it says "Cannot reach the support service." rather than
  claiming the session ended. Its reads time out, so it cannot hang there. Every pipe client allows the server to
  identify it only, so a process that took a pipe's name first cannot act as
  SYSTEM or as the user. The helper runs in a kill-on-close Job of the service,
  so it dies with it.
- **The window shows, it cannot stop code that runs as the user.** Code that runs
  in the customer's session can hide or cover the corner window. It shows that
  access exists; it does not enforce anything.
- **What full control can do.** `run` with `as: "user"` runs as the console
  user, with their elevated token when they are an administrator, in their
  session; with nobody signed in it fails with `nobody is signed in; use as:
  "system"`. After a user switch, `as: "user"` is whoever is at the console now.
  `as: "system"`, `put_file` and `get_file` run as SYSTEM. Because a user could
  aim SYSTEM at a protected file with a junction, a symbolic link or a second
  hard link in a path they control, `put_file` and `get_file` refuse a path
  with a link in it. Every folder of the path, from the drive down, is opened as
  itself, checked to be a plain folder with exactly its own path, and held so
  nobody can rename or replace it until the file is open. A missing folder is
  created one level at a time and checked before the next. The opened file must
  have exactly the requested path (and, to write, one name only). A file created
  by such an attempt is deleted again. Short 8.3 names fail
  this check too, so use the long path. `send_sas` sends Ctrl+Alt+Del through
  `SendSAS`. The installer sets `SoftwareSASGeneration` to allow services only
  when Windows would refuse it. Sessions on one PC share it: each records itself
  under `HKLM\SOFTWARE\SupportMCP` (SYSTEM and Administrators only), every change
  of that record holds one machine-wide mutex, and the last session to end puts
  the old value back, only if the value is still the one written. Nothing
  changes the record without the mutex. An install that cannot get it in 30 s
  goes on without the share, and `send_sas` then answers that Windows refuses
  it. A release that cannot get it keeps the session's entry and its backstop
  task, which tries again at the deadline and then every hour. The own-window
  guard of the helper covers the corner window the service started and the app
  that installed it, not every process that talks to the window pipe. UIPI no longer limits input, so support can work
  in windows that run as administrator. Commands keep the Job Object, its one
  second for a program the command did not wait for (as SYSTEM and as the
  user), and the output caps. `request_full_control` asks one prompt at a time,
  and not again within a minute after the customer declined. One that gets no
  answer in 110 s returns `the customer did not answer`, without the minute,
  and while its Windows prompt is still open the next request is refused.
- **Normal mode.** Without full control, screen capture, mouse, keyboard and UI
  Automation run inside the customer's own process and desktop session, with the
  customer's token. It cannot see or operate the secure desktop, it cannot run as
  SYSTEM, and it refuses to click or type into a window that runs as
  administrator, because Windows would drop that input. The window says
  "Running without administrator access." `hello` reports `control: normal`. The
  relay refuses `run` with `as: "system"`, `block_input` and `send_sas` unless
  the stored control is `full`, and the app refuses them too.
- **Locking the customer out is short and visible.** `block_input` blocks the
  physical mouse and keyboard for at most 10 minutes per call, then it lifts by
  itself. The corner window says "Support has locked your mouse and keyboard.
  Press Ctrl+Alt+Del to unlock." Ctrl+Alt+Del always lifts it (Windows
  guarantees that), and it stays off until the operator calls it again.
  `session_status` shows `input_blocked_until`.
- **Customer input wins.** Input from the operator fails with `customer is using
  the PC; try again in a few seconds` for 3 seconds after the customer last
  used the mouse or keyboard. The app finds the customer's input with low-level
  hooks that see only physical events. Windows removes a hook that times out,
  without telling the app, so the app also compares `GetLastInputInfo` with the
  time of its own last injected input, and a later input counts as the
  customer's. That time is only as fine as the system clock (about 15.6 ms), so
  the app also treats a key or mouse button that is down while it holds none as
  the customer's. Typing checks all of this during every 20 ms gap and right
  before each character, and stops within a few milliseconds. If the hooks did
  not install, the app first sends one harmless key (F24) to prove that the
  last-input time follows its own input, and refuses all input if it cannot
  prove it. Screenshots, UI reads and commands are not paused. The app refuses
  to click its own windows and refuses keys, typed text and `ui_tree` while one of
  its windows has the keyboard focus (`the support window has the keyboard focus;
  click another window first`). It checks the focused window again before each
  key and each typed character, so an input also stops if the customer moves the
  focus to the support window in the middle of it. The corner window never takes
  the focus by itself: it has `WS_EX_NOACTIVATE`, so it does not activate when it
  appears or changes, and its buttons do not take keyboard focus, so a click on
  Tuck or Expand does not activate it. It keeps its taskbar button
  (`WS_EX_APPWINDOW`), and the taskbar's Close and Alt+F4 still ask "End the
  session?". Only asking to end activates it, so the customer can answer. When
  the customer answers Keep connected (or presses Escape), the window gives the
  focus back to the window that had it before, as long as it still exists and
  the support window still holds the focus and the customer has not left it while
  the confirm was open. It checks that the window is still the same visible,
  not minimized window (same process and thread). Tucking the window while the
  confirm is open does the same. The dialogs (consent, the limited-support
  question, the full-control confirm) and the two confirm buttons take keyboard
  focus, so Tab and Enter work. The app does not move the focus for support. The customer pause covers input only: screenshots, UI reads
  (`ui_tree`) and commands are not paused.
  Typing, key sequences and drags also stop at once when the session ends or the
  customer starts using the PC, and a drag releases the mouse button first.
  While `block_input` holds the customer's input, the pause does not apply.
  Under full control the hooks move to whichever desktop is shown. A key or
  mouse button that the app pressed and whose release a desktop switch swallowed
  (Escape on the Ctrl+Alt+Del screen, a click on Yes in UAC) never counts as the
  customer's, and the app releases it on the desktop shown now. Any key that
  reads down for 10 seconds while no input at all reaches Windows is treated as
  stuck: a key the customer holds repeats, so it keeps pausing support.
- **A secret is typed, never kept.** `type_secret` types into the focused field
  in normal mode too. The relay logs only the word `type_secret`, not even a
  length. It does not return the text. If the app reports a failure, the relay
  drops the app's error text and returns `type_secret failed`, so a secret can
  not come back inside an error. The screenshot that follows shows what the field
  shows, so the operator should pass `screenshot: false` unless the field masks
  its input.
- **Elevation only with the customer's click.** The manifest is `asInvoker`.
  The app asks Windows for elevation in two places only: at its start, and for
  `request_full_control`, both through `--elevate-install` and UAC. The relay
  never asks for elevation by itself. If the customer started the app as
  administrator and then chose limited support, the dialog says commands run
  with administrator rights, the window says "Running with administrator
  rights.", and `session_status` reports `elevated: true`.
- **No elevation by the PowerShell agent.** The agent refuses to start if its own process is elevated.
  If the customer pasted into an admin console, the bootstrap starts the agent
  through a one-shot scheduled task at the limited run level. With UAC turned
  off, or on the built-in Administrator account, that task still gets a full
  token. The agent then removes everything it installed and exits, and the
  logon entry is only written after the elevation check passes. When admin
  rights are needed, the operator can ask Windows for a UAC prompt, and the
  customer decides whether to click Yes.
- **Session codes can't be guessed.** A one-off session's code is 16 base32
  characters, 80 bits, single use, and valid for 10 minutes. The customer pastes
  it and never types it, so its length costs nothing. A saved-PC pairing code is
  the one code a person types, so it is different: see the "Saved PCs and
  pairing" rule below.
- **Link previews can't use up a code.** Slack, Teams, WhatsApp and Telegram
  fetch links with a plain `GET`. The download page is served on `GET` and never
  touches the code. Only a `POST` from the page's button consumes it, and the
  relay accepts that `POST` only when its `Origin` header is the relay's own
  origin. The page sends `Referrer-Policy: same-origin` so browsers keep that
  header on the click, `Cache-Control: no-store`, and a content security policy
  with `default-src 'none'`, no scripts and `form-action 'self'`. A second click
  gets a "Check your downloads" page, not a second file. For the PowerShell
  link, the relay serves the script, and consumes the code, only when the
  `User-Agent` contains `PowerShell/`, which is what `irm` sends in Windows
  PowerShell 5.1 and PowerShell 7. Any other request gets a `Write-Host` line
  telling the reader to paste the command into PowerShell. That check protects
  the code from bots, not from someone who sets the header on purpose.
- **A code only works for its own client.** A code minted for the app cannot be
  used up by `irm`, a PowerShell code cannot be used up by the download page,
  and a session refuses the other client's transport.
- **https only.** The script and the app both carry the attach key and run the
  whole session over the origin they were served from, so the relay builds that
  origin as `https://<host>` for every host except `localhost` and `127.0.0.1`.
  A PowerShell `/j` request over plain http gets a `Write-Host` line asking for
  the https link, an app `/j` request gets a 403, and the code stays unused in
  both cases. `/ws` and `/agent` over plain http get a 403. The app also refuses
  to run against any origin that is not https, loopback excepted.
- **The attach key never goes in a URL.** It is 32 random bytes, sent only in
  the `X-Attach-Key` header so it stays out of access logs, and the relay
  stores only its SHA-256. A request with the key in the query string is
  rejected. The app's copy of the key lives in the downloaded file, which is
  specific to one session. `/agent` also rejects any request that carries an
  `Origin` header, any body that is not JSON, and any body over 750,000
  characters.
- **Nothing served can be injected into.** Every value substituted into the
  PowerShell template is checked against a hex, base32 or URL pattern before it
  goes into a single-quoted literal. The script runs inside `& { ... }` so
  nothing leaks into the customer's console session. The values appended to the
  app are checked the same way before they are written as JSON.
- **The operator endpoints sit behind Cloudflare Access.** `/mcp`, `/w/<slug>/mcp`
  and the team API under `/api/` all check the Access JWT in the relay itself: RS256
  signature, `aud`, `iss`, `exp` and `nbf` with 60 seconds of skew. It caches
  signing keys for an hour and allows at most one forced refetch per minute
  when it sees an unknown `kid`. A browser sign-in cookie is not a credential
  on these addresses. Requests carrying an `Origin` header get a 403
  and non-JSON bodies (every team API write) get a 415, which blocks cross-site
  requests from a logged-in browser. All of these refusals come before the relay
  reads any session or team data. The MCP addresses also take an OAuth bearer
  token (below), and answer a missing or failed credential with 401. The team
  API does not take bearer tokens. With OAuth, the MCP addresses may sit under a
  second Access app (`support-mcp-mcp`) that gives a service token an Access
  login and bypasses everyone else. `ACCESS_MCP_AUD` names that app. On the MCP
  addresses only, an Access login for either `ACCESS_AUD` or `ACCESS_MCP_AUD` is
  accepted, with the same signature, issuer and expiry checks. The team API
  accepts `ACCESS_AUD` only, and an empty `ACCESS_MCP_AUD` changes nothing. A
  saved PC's four addresses under `/device/` are public and sit under none of
  these Access apps, because a PC has no Access login; they have their own rules,
  below. So does `/install`, the setup page and download that a PC's owner opens
  from a link.
  Access session revocation does not apply on a bypassed path. There the relay's
  own checks are the gate: the JWT or the OAuth token, and the role check on
  every tool call.
- **Each tool call is checked against the caller's role.** The relay keeps the
  `default` workspace and any number of created ones, each with its own members
  and roles in a D1 database. The workspace is the address the call arrived on:
  `/mcp` is `default` and `/w/<slug>/mcp` is that workspace. A slug that was
  never created answers every tool call with `workspace not found`, whoever
  asks, and a malformed one is a 404, as is `/w/default/mcp`. A caller Access
  admits can tell a created slug from one that was never created: the first
  answers "you are not a member of this team" (403 `not_member` on the API),
  the second "workspace not found" (404). A slug's name is not treated as a
  secret.
  A member is an identity from the Access JWT: a person's email, or a service
  token's client id. Identities are compared trimmed and lowercased. One table
  in `src/permissions.js` maps every MCP tool to the permission it needs, and a
  test fails if a listed tool is missing from it. The check runs on
  `tools/call` only, before the call reaches a session, and it sees only that
  permission key, never the tool's arguments. A non-member gets the tool error
  `you are not a member of this team`, and a member whose role lacks the
  permission gets `your role does not allow <permission>`. Removing a member or
  changing a role takes effect on the next call. The roles are `admin` (every
  permission, fixed), `technician` (create, view, control and end sessions) and
  `viewer` (view sessions, read the team log), and admins can edit the last two
  and add their own.
- **Managing members or roles does not reach admin.** Only an admin can add a
  member as admin, change anyone to or from admin, or remove an admin. Anyone
  else can give a member only a role whose permissions are a subset of their
  own. They can create or edit a role only so that it holds permissions they
  hold, and they can't edit or delete the role they hold. Anyone else can also
  change (a rename counts), demote or remove only a member whose role holds no
  permission they lack, which leaves every admin to admins. They can edit (a
  rename counts) or delete only a role whose current permissions they hold, so
  they can't narrow or delete a stronger role. Nobody can change their own
  role. An admin may demote themselves, but only while another admin
  remains. The relay checks these rules when it plans the change and again in
  the SQL that commits it, against the actor's role, the target's role, the
  edited role and the roles' permissions as the plan read them, so a change
  that lands between the read and the commit (the target promoted, a role
  widened, the actor demoted)
  can't slip a change through. A refusal is a 403 `forbidden` and writes no log
  row.
- **Only deployment admins create workspaces, and each starts with its admin.**
  `POST /api/v1/w` is refused with 409 `no_deployment_admins` while
  `DEPLOYMENT_ADMINS` is empty, and with 403 for an identity not listed in it.
  One batch writes the workspace, its first admin (the caller) and the first two
  log rows, so a created workspace never exists without an admin. Its slug is the
  table's primary key, so two creations of one slug cannot both land.
- **Only `default` is ever open.** The next bullet describes open mode. It
  applies to `default` alone. A created workspace that somehow has no members is
  closed: nobody holds any permission, and nobody can add themselves as its first
  admin.
- **The `default` team is open until its first member.** With no members, every caller
  Access admits holds the session permissions (`sessions.create`,
  `sessions.view`, `sessions.control`, `sessions.end`), as before teams existed,
  and the relay records who called so an admin can add them. It writes a
  caller's row at most once a minute. While the team is open nobody holds a
  team permission: editing or adding a role, or changing or removing a member,
  is refused with 409 `first_member`, so nothing a stranger writes can persist
  into the roles that turn on later. Reading the workspace and the role list
  still works. One write from a stranger is allowed in any workspace, open or
  closed: an owner-started install can leave a waiting PC and its
  `device_requested` log row, at most 20 requests an hour and 20 waiting at once
  per workspace. A waiting PC can only check in or leave, and it disappears after
  24 hours. So a stranger who can reach `/device/` can cause up to 20
  `device_requested` log rows an hour, and `device_left` rows when that PC
  leaves (the same cap bounds them), and a waiting PC's check-ins are unlogged
  writes of its details, at most once a minute. The first member must be the caller, as admin. Two callers racing
  to add it get one winner, and the other is then refused as a non-member. When `DEPLOYMENT_ADMINS` is set, only an identity it lists
  can be that first member, which stops any other Access user from racing to
  claim the team. Once there is a member, a caller who is not one is refused,
  and that includes an MCP client whose service token was not added. The last
  admin can't be removed or demoted.
- **Controlling a session is administrator-level.** On a full-control session,
  `put_file` and `get_file` run as SYSTEM and screen control can click Yes on a
  UAC prompt, so a separate SYSTEM permission would not hold. Give
  `sessions.control` only to people you would trust as an administrator of the
  customer's PC.
- **Saved PCs and pairing.** A workspace keeps customers, sites, saved PCs and
  custom fields in D1, every row keyed by workspace, and none of it is read
  when the relay decides who may do what. These rules hold:
  - *A typed code is longer than a pasted one.* A technician's pairing code is 10
    characters from a 32-letter alphabet without 0, 1, I and O (50 random bits),
    shown as `ABCDE-FGH23`. It works once and dies after 10 minutes. The owner
    types it, so it cannot be 80 bits, and it cannot name its workspace, so the
    relay looks it up by its keyed hash across every workspace. With at most 20
    live codes in each of at most 501 workspaces (about 10,000), a random guess
    hits about 1 in 10^11. Keep a Cloudflare rate-limiting rule on `/device/` (see
    the README) so guessing stays out of reach. A code that is unknown, used or
    expired gets the same answer. A code carries its creator's authority: it
    redeems only while that person still holds `devices.manage` in the
    workspace, checked when it is typed and again at commit, so removing the
    person or their permission ends their live codes.
  - *What pairing stores.* The code is stored only as `HMAC-SHA-256` under a key
    derived from `AUTH_SECRET`, and never logged. A PC's key,
    `smd1.<workspace>.<device id>.<secret>`, is shown to the PC once. Only the
    SHA-256 of its 32-byte secret is stored, compared in constant time, and a
    wrong key, an unknown PC, a removed PC and a malformed key all get one 401.
    A waiting PC's six-digit number is stored as a keyed hash too, and shown only
    to the PC. Without an `AUTH_SECRET` of at least 32 characters the pairing
    routes answer 503. The code, the key and the number appear in no log row.
    Rotating `AUTH_SECRET` ends every live pairing code and every waiting PC's
    number, because both are keyed hashes; device keys are a plain SHA-256 and
    are unaffected.
  - *A key never goes in a URL.* The PC sends it in `Authorization: Bearer`, and
    a `?key=` or `?code=` in the URL of a `/device/` request is refused. (The
    install link is a different address and does carry a code: see below.) The
    four addresses are POST only, https only (loopback excepted), refuse any request with an `Origin`
    header, take only JSON of at most 8 KB, and carry `"protocol": 1` in every
    request and answer so a later version can coexist.
  - *An owner-started install needs a technician.* The PC joins as waiting and
    can only check in or leave. A technician approves it by typing the six-digit
    number the owner reads out. It is gone after 24 hours. A wrong number is
    refused (403 `confirm_wrong`) and not logged. Only holders of
    `devices.manage` can try one. There is no attempt counter, so the limits are
    that permission, the 24-hour life of the wait, and the one-in-a-million
    chance of a blind guess.
  - *`/device/pair` with a workspace slug says whether the workspace exists* (404
    against 202 or 409). Slugs are already public addresses, as the protected
    resource document shows.
  - *Uninstalling revokes.* A PC removes itself with `/device/leave`, which
    deletes its row and so its key. A technician with `devices.manage` can remove
    any PC the same way. Either takes effect on the PC's next request.
  - *Access mode.* A technician with `devices.manage` can change a PC between
    `ask` and `any`, either way. The log records who and the old and new mode. A
    technician cannot change the control level or the name; a request that sends
    either is 400, not ignored. On the PC the switch is one way: anyone signed in
    can turn `ask` to `any`, and nobody at the PC can turn it back (see "A saved
    PC installs a permanent service" below).
  - *The owner contact is the team's.* Only a technician with `devices.manage`
    sets or clears a PC's owner contact. A PC that sends one to `/device/pair` or
    `/device/update` gets 400 `bad_request`, so a person who holds the PC's key
    cannot overwrite what the team recorded. The log names the field, never the
    value.
  - *An install link carries a working code.* A technician's link,
    `/install?code=ABCDE-FGH23`, is a pairing code in a URL. The code can land in
    the browser's history, in a chat app's link preview (the preview fetches only
    the setup page, which never checks or uses the code) and in the relay's own
    request logs. Whoever uses it first within its 10 minutes pairs their PC, and
    the real owner then sees that the code did not work. The code is still single
    use and still dies after 10 minutes. Send the link over a channel you trust,
    and ask for a new one if the owner says the code failed. The team's link,
    `/install?workspace=<slug>`, carries no secret: a PC that joins through it is
    a waiting PC until a technician approves it.
  - *Custom fields never grant access, and are untrusted text.* A field value is
    plain text of at most 500 characters. Only team members with `devices.manage`
    write it; a PC cannot. What a PC reports or sets about itself (its name,
    Windows version and machine name) is untrusted text too, and
    shows beside the field values. Treat all of it as you treat session output:
    it may try to steer an agent that reads it later.
    Customer contact details need `devices.view`, which the technician and viewer
    roles hold and a session-only role does not.
  - *Check-ins are not logged.* A PC's last-seen time and unchanged details are
    written at most every five minutes, like the callers table, and a changed
    detail at most once a minute, so a PC cannot force a write on every
    check-in. Everything else about a customer, site, field or PC is a logged,
    guarded change that re-checks the actor's permission at commit.
  - *The log names customers, sites and PCs.* A log detail holds the ids and
    names of the records it concerns, never a code, a key, a contact or a field
    value. Anyone with `audit.view` reads those names, so a viewer role sees
    customer and site names there even without `devices.view`.
- **A saved PC installs a permanent service.** This is the one place the app
  stays on a PC after a session. A one-off support link is unchanged, and
  nothing here touches it. These rules hold:
  - *What the install puts on the PC, and where.* The owner runs the setup, and
    one Windows permission prompt elevates it. It creates
    `%ProgramFiles%\SupportMCP` (the path comes from the registry, as for full
    control), and in it `support.exe`, the device record `device.json` and the
    local history `history.json`. It registers a Windows service,
    "Support device service" (`SupportMcpDevice`, LocalSystem, automatic start,
    restart on failure, a quoted path), a tray startup value `SupportMcpTray`
    under `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Run`, and an entry
    under `...\Uninstall\SupportMcpDevice` that Windows Settings > Apps (Control
    Panel on Windows 7) shows.
    It does not touch `HKLM\SOFTWARE\SupportMCP`, which one-off sessions share,
    and it uses names different from theirs, so a saved install and a one-off
    session on the same PC do not step on each other.
  - *It reuses the one-off install's hardening.* The elevated step runs from a
    copy the app stages alone in a new Temp folder, turns on the safe DLL search
    (no DLL loads from the current folder), reads its own file once through a handle that denies writing and renaming,
    and installs only if the wizard that started it is still waiting for the
    answer, so a late Yes after the wizard closed installs nothing. The wizard
    passes its answers to the elevated step as one argument and takes the outcome
    back as an exit code, so no file in a user folder carries either. If any
    step fails after the PC paired, the install tells the relay to forget the PC
    and removes what it made.
  - *Who can hold the key.* The PC's key is held only by SYSTEM or by an elevated
    administrator process. `support.exe` is readable and runnable by users,
    because the tray and the uninstall run from it, but it carries no key. The
    folder, the device record and the history are readable only by SYSTEM and
    administrators (inheritance off). The key is never in a URL, a command line,
    a log, the tray or a file a standard user can read.
  - *Consent at setup.* The wizard asks for the PC's name, then how support may
    connect ("Ask me each time" or "Connect any time (unattended)") and how
    much control (full control or limited support). Nothing is preselected for
    either, so the owner must choose. The Windows permission prompt is the
    second consent. No other path installs a saved PC.
  - *The service only checks in.* In this release it contacts the relay every few
    minutes with the PC's key and writes local history. It runs no commands,
    takes no screenshots and opens no files for anyone, and it never reads a
    session footer. Nobody can connect to a saved PC yet, and Stage 1 stays off
    real customers' unattended PCs until the release that enforces rules about
    who may connect and when.
  - *The status pipe.* The tray talks to the service over the pipe
    `SupportMcpDevice-ui`. Only SYSTEM can create instances, it is closed to the
    network, and interactive users can read and write data on it. It serves
    every signed-in session, with a cap per process. It answers three requests
    and nothing else: read the status, refresh now (at most once every 30
    seconds), and turn the access mode to "any time". No request turns it back to
    "ask each time", and the service never sends that mode on its own. The
    tray's pipe client allows the server to identify it only, so a process that
    took the pipe's name first cannot act as SYSTEM or as the user.
  - *Anyone signed in can turn on unattended access.* The one-way rule is a
    decision by the project owner. The tray asks "Allow support to connect any
    time?" and says the owner cannot undo it from this PC. That prompt is not
    a barrier: every interactive user may send the request, including a standard
    user or a guest, and Windows asks for no administrator prompt. Once it is
    "any time", nobody at the PC can turn it off. Only a technician with
    `devices.manage` (through the team API) or an uninstall can end it. The
    tray says so plainly ("Only your support team can change this."). The rule
    is the app's, not the relay's: `/device/update` takes either mode from the
    holder of the key, and only SYSTEM or an elevated administrator process holds
    it. Nothing can
    connect to a saved PC yet, so this has no effect today, but weigh it before
    you use a saved PC where a stranger can sign in.
  - *Uninstall revokes and removes.* Uninstalling from Settings > Apps or the
    tray asks for one Windows permission prompt. It runs from a temporary copy,
    so nothing in the install folder stays open. It tells the relay to forget the
    PC (`/device/leave`, so the key stops working), has the service end every
    tray, stops and deletes the service, and deletes the startup value, the Apps
    entry and the folder with the junction-safe delete the one-off cleanup uses.
    Anything still locked is deleted at the next restart. If the relay cannot be
    reached, the PC is still removed locally, the key stays valid on the relay,
    and the team must remove the PC from their list to end it.
- **Each session belongs to its workspace.** A session stores the workspace that
  created it, and operator calls name their workspace. A call from another
  workspace gets the same answer as a session that does not exist. A session
  stored without one counts as `default`. The download page, the code and the
  app's own connection name no workspace and are not checked. Each workspace
  also has its own Registry object, so `session_list` shows only the caller's
  sessions. `default` keeps the original object, so sessions made before
  workspaces existed stay in its list.
- **Team changes go in a chained log.** Every change to members, roles,
  customers, sites, custom fields, pairing codes and saved PCs writes one row with a number, the time, the actor, the kind and the detail. Each row's
  hash is SHA-256 over the previous row's hash and its own fields, so an edit,
  removal or reordering of a row makes verification fail and the log API report
  `verified: false`, unless the change is among the newest entries. A normal
  read of the log checks only the rows it returns (the hash of each, each link,
  the first row against the row before it and the last against the row after
  it) and reports `verified_scope: "page"`, so an edit further outside the page
  goes unseen by that read. Only the newest row of the log has no row after it,
  so a reseal of that row alone passes a page check, and a noted head catches
  it. `verify=full` checks the whole chain and reports `"full"`. Deleting
  the newest rows (truncating the tail) leaves a shorter chain that still
  verifies. The change, its rule check and its row commit in one D1 batch, so a
  change never happens without its row. The chain has two limits. Someone with
  write access to the database could rewrite every row after the one they edit
  and seal the new chain, and could cut off the newest rows. To catch both,
  note the `head` (number and hash) the log API returns somewhere outside the
  relay, and compare it later: a lower number, or a different hash at the same
  number, means the log changed.
- **People sign in as themselves, by invitation only.** A technician signs in
  with Google, Microsoft or an emailed link at `/auth/signin`. Only a person who
  is a member of some workspace (by lowercased email) or is listed in
  `DEPLOYMENT_ADMINS` can. Anyone else gets one "you can't sign in here" page
  and nothing is stored. The check is read live on every request, so removing
  the last membership ends a sign-in on its next request, and "sign out
  everywhere" revokes every sign-in the person has (and, for a person with an
  authenticator, needs a sign-in that has passed a code, and also ends the
  person's OAuth grants). A sign-in cookie is for the account page and the
  consent page. It is not accepted on `/mcp`, `/w/<slug>/mcp` or the team API,
  so a signed-in person from one team cannot claim the open `default`
  workspace's first admin or read its recent callers. A sign-in counts its
  second factor only while the person still has the authenticator it used: if
  an operator resets the authenticator, or the person replaces it, an open
  sign-in loses its factor.
- **Google and Microsoft sign-in checks the whole token.** It uses the
  authorization code flow with PKCE (S256), a `state` and a `nonce`. The state,
  nonce, PKCE verifier and return path live in one cookie sealed with AES-GCM
  under a key derived from `AUTH_SECRET`, `HttpOnly`, `Secure`, `SameSite=Lax`,
  good for ten minutes, and cleared on the callback. The relay trades the code
  for tokens from its own server with the client secret, then checks the
  id_token: RS256 signature against the provider's published keys, `aud` equal
  to our client id (and `azp` when there are several), `exp` and `iat` with two
  minutes of skew, and the nonce. Google needs `email_verified` to be `true`
  and `iss` of either spelling. Microsoft's `iss` is built from the token's
  `tid` and must match, the `tid` must be in `MICROSOFT_TENANTS` when that list
  is set, and the email counts only if the token carries `xms_edov` or the
  tenant is listed (listing a tenant trusts its administrators to set emails).
  A person is linked to an identity by the provider's own id (Google `sub`,
  Microsoft `tid:oid`), never by email. A known identity always signs in as the
  person it was first linked to. A new identity joins the person who has its
  verified email. A link is never moved to someone else. Provider keys are
  cached per address, so Access, Google and Microsoft do not evict each other,
  and each address has its own limit of one forced refetch a minute.
- **Emailed links work once, in one browser, by a button.** A link holds 32
  random bytes. The relay stores only their SHA-256, with a ten minute expiry.
  Asking for a link sets a cookie in that browser holding a second random
  value, also stored hashed. A browser that already holds the cookie keeps its
  value, so a second request does not strand the first link, and the cookie is
  cleared once no unused link is left for it. Opening the link (GET) only shows a page, so mail
  scanners and link previews cannot use it. The button (POST) redeems it, and
  only with the same browser's cookie. A wrong browser is refused without using
  the link up. The answer to a request is identical whether or not the address
  is invited, and only invited addresses are stored or mailed. Each address
  gets at most five links an hour, counted in the same statement that inserts
  the row. In production the mail is sent after the answer, so timing doesn't
  show whether an address is invited. `DEV_SHOW_EMAIL_LINKS=1` puts the link on
  the page instead of sending it, and it is honoured only when the request host
  is `localhost` or `127.0.0.1`. In that mode only, the page does show whether
  an address was invited.
- **A second factor for roles that can control sessions or manage the team.**
  A role that holds `sessions.control`, `members.manage`, `roles.manage`,
  `devices.manage` or `fields.manage`, and a deployment admin, must enrol an authenticator app (TOTP, RFC 6238: SHA-1,
  30 seconds, six digits, one step either side). `authorizeSignIn` in
  `src/auth.js` refuses a sign-in that has not passed a code with "a second
  factor is required" for those permissions, and 2c calls the same check. Anyone
  who has enrolled passes a code at every sign-in. The secret is 20 random
  bytes, stored encrypted (AES-GCM under a key derived from `AUTH_SECRET`, with
  the person's id as associated data). The last used 30 second step is stored,
  and a code for that step or an older one is refused, so a code works once.
  Every attempt is counted before the code is checked, in the same statement
  that sets the lock, so a crash cannot leave a count without its lock. Only
  `locked_until` blocks a try, never the count. Every fifth wrong try in a row
  locks the factor, even against the right code. The first lock lasts 15
  minutes and each later one twice as long, up to 24 hours, so a guesser gets
  five tries per lock, about 35 in the first day and 5 a day after that. The count and the lock
  clear only on a right code. Ten recovery codes are shown once, stored as keyed
  hashes, and each works once. A person with an authenticator must pass a code
  before replacing it. Replacing it, or signing in with a recovery code, revokes
  every other sign-in of that person (the current one stays), because either may
  mean the phone or an old sign-in is no longer theirs. The page says so. There is no admin
  reset in the product: delete the person's `user_factors` row with
  `wrangler d1 execute` after you have checked who they are. Rotating
  `AUTH_SECRET` makes every stored authenticator secret and recovery code
  unreadable, so delete the `user_factors` rows and have people enrol again. It
  does not end sign-ins, because the cookie value doesn't depend on it.
  `devices.manage` and `fields.manage` are in this set: a person whose role
  holds either must enrol an authenticator, and the browser sign-in and the
  OAuth consent page ask for a code before they act on that role. Access
  callers and service tokens are exempt, and the team API admits only Access
  logins today, so these two permissions add the enrolment requirement for
  signed-in people before they add any new action.
- **Browser sign-in cookies.** The cookie `__Host-smcp` is `Secure`, `HttpOnly`,
  `SameSite=Lax`, `Path=/` and has no `Domain`. Its value is 32 random bytes;
  the database holds only the SHA-256. A sign-in ends after `SIGNIN_IDLE_HOURS`
  (12) without use or `SIGNIN_MAX_DAYS` (14) after it began, whichever comes
  first, and both are read from the current settings, so tightening them applies
  to sign-ins already open. The last-seen time is written at most every five
  minutes. Only for `localhost` and `127.0.0.1`, which browsers may refuse to
  store a `Secure` cookie for over plain http, the cookies are named `smcp`,
  `smcp-oidc`, `smcp-bind` and `smcp-pre` and are not `Secure`. A real host
  never gets that. The relay's own address is `PUBLIC_ORIGIN`, never the
  `Host` header, and on a real host without it, or when asked at another host,
  every sign-in route answers 503. The same 503 comes with a missing or short
  (under 32 characters) `AUTH_SECRET`.
- **Browser forms are checked for cross-site posting.** `/mcp` and `/api` refuse
  any `Origin` header outright. The sign-in and account pages are for browsers,
  so each POST instead needs an `Origin`, when the browser sends one, equal to
  the relay's own (otherwise 403), a form token, and a urlencoded body under 8 KB.
  The token is an HMAC (key derived from `AUTH_SECRET`) of the sign-in's id hash
  or, before sign-in, of the page's own cookie. Cookies are `SameSite=Lax` as a
  third layer. A return path after sign-in must start with one `/`, never `//` or
  `/\`, with no backslash or control character, and is checked again after the
  URL parser has folded dot segments (`/..//evil.example` becomes
  `//evil.example`) and refused if it then points off the site. Every redirect
  and every link or form field that carries a return path goes through that
  check, so none can be an open redirect. Form bodies are read with a byte cap
  and cut off at 8 KB even when they declare no length, and so are the
  provider's token and key responses. Every page sends a
  Content-Security-Policy of `default-src 'none'` (so no script, font or image
  can load, and the pages contain none), `frame-ancestors 'none'`,
  `base-uri 'none'` and a `form-action` that adds the Google and Microsoft
  hosts on the sign-in page only. They also send `Referrer-Policy: same-origin` (so no address leaves the site;
  `no-referrer` would make Chrome send `Origin: null` on every form post),
  `X-Content-Type-Options: nosniff` and `Cache-Control: no-store`.
- **MCP clients sign in through the relay's own OAuth server.** The relay uses
  the maintained `@cloudflare/workers-oauth-provider` library (pinned to an
  exact version) in its split roles: the authorization server for the
  discovery document, `/oauth/token` and `/oauth/register`, and its token check
  for each MCP address. The relay's own code serves the protected resource
  documents, the consent page and the 401 challenge, so the library never
  answers on an MCP address before the relay's `Origin`, method and content-type
  refusals. The library stores grants, tokens and registered clients in the
  `OAUTH_KV` namespace: tokens, codes and secrets only as hashes, and each
  grant's props (the person, the workspace) encrypted with a key that only the
  token holder can unwrap. The relay adds these rules:
  - **One address per token.** Every grant and access token is bound to exactly
    one MCP address (RFC 8707). A token for `/w/acme/mcp` is a 401 on `/mcp`, and
    the reverse. An authorization request must name exactly one address, or
    the library refuses it with `invalid_target`.
  - **PKCE S256 for every client, exact redirect addresses.** Registration is
    open and does not require a public client: a client that names no
    authentication method gets the library's default, a client secret, and the
    library requires PKCE only of clients without one. So the relay requires a
    PKCE S256 challenge (43 characters of base64url) on every authorization
    request, from every client, and refuses the request on the authorize page
    when it is missing, is `plain`, or has no method. It checks again when the
    person presses Allow, where the code is made. Redirect addresses must match
    the registration exactly, and may be `https`, `http` on loopback, or an
    RFC 8252 app link such as `cursor://` (`allowPrivateUseRedirectUris`; safe
    only because PKCE is mandatory). Access tokens last one hour. Refresh tokens
    last 30 days from approval, as one fixed limit. The library accepts the
    current refresh token and the one before it, and has no reuse detection:
    using the older one issues a new pair and makes the client's newer token
    stop working, and nothing ends the grant or raises an alert. Presenting a
    used authorization code again ends the grant. The authorization response
    carries `iss` (RFC 9207).
  - **Errors before a choice are never redirected.** Any error found while
    reading an authorization request is shown on the relay's own page. The
    library would redirect to the client's registered address, but a client
    registers itself, so that would let an attacker's client send a signed-in
    person to its own site with no click (RFC 9700 4.11.2). The page may carry a
    plain link back, named by the client's host, which the person must click.
    The client is redirected only after the person presses Allow or Deny.
  - **The consent page is the relay's.** It needs a browser sign-in, then reads
    the person's membership in the workspace the address names and refuses a
    non-member. A role that holds `sessions.control`, `members.manage` or
    `roles.manage` needs a second factor passed in this sign-in, so the person is
    sent to `/auth/factor` first, as for the account page. The page shows the
    client's name (escaped), where the client returns to (the host for a web
    address, the scheme and host for an app link, with a warning that it opens
    an app on the device), a warning for `localhost`, the workspace and what the
    role allows. Allow and Deny are
    separate form posts with the sign-in's form token, an `Origin` check and the
    library's browser-bound, single-use, ten-minute handle. The page lists the
    client's redirect origin in `form-action`, because Chrome applies
    `form-action` to the redirect that answers a form post. That source is
    built only from a plain host and port or a plain `scheme:` token that matches a
    strict pattern and is not a known dangerous scheme, never from raw text, and
    the address was matched exactly against the client's registration first. A
    return address the builder cannot write is refused on the authorize page.
    Membership and the second factor are read again when Allow is pressed.
  - **Every tool call checks the person live.** The token proves who connected.
    Each `tools/call` also reads the person, their membership and their role
    from D1, as for an Access caller, and refuses a person who was removed,
    disabled or never invited. An OAuth caller never reaches open mode: the role
    check is told to admit members only, so an empty `default` neither admits
    the caller nor records it among the recent callers. A permission that needs a second factor needs the
    authenticator the grant was made with: the grant records when that
    authenticator was set up, and a reset or replacement ends the use of control
    permissions until the client is approved again. The audit identity is the
    person's email. `tools/list`, `initialize` and `ping` with a token read the
    person in D1 and KV once, and nothing else.
  - **A junk token costs no KV read.** The free KV plan allows 100,000 reads a
    day, so a flood of made-up bearer tokens could otherwise turn every OAuth
    caller into a 503. Before KV is read, the token must have the issued shape
    (`<uuid>:<16 characters>:<32 characters>`) and its first part must be a
    person who exists and is not disabled in D1, whose free read limit is far
    higher. Anything else is a 401 `invalid_token` with no KV read. If D1 cannot
    answer, the answer is 503. A flood still costs a request and a D1 read each,
    so add a rate-limiting rule on `/mcp` and `/w/*`, as on `/oauth/`.
  - **Sign out everywhere ends the person's grants.** It lists and revokes every
    grant for the person. If KV cannot be reached it says so instead of
    claiming success. A plain sign out leaves the clients connected.
  - **Failures are 401, outages are 503.** A token that is missing, expired,
    revoked, for another address or malformed is a 401 with the discovery header,
    so the client signs in again. A KV failure (its daily limit, an outage) is a
    503, so a client does not throw away a good sign-in.
  - **The discovery document does not list the workspaces, but slugs are not
    secret.** The library would publish every address in `protected_resources`,
    which would publish every team's name, so the relay removes that field. The
    protected resource document `/.well-known/oauth-protected-resource/w/<slug>/mcp`
    is public and answers 200 for a workspace that exists and 404 for one that
    does not. So an unauthenticated visitor can learn which slugs exist by
    trying them. Treat a slug as public. It leaks no member, session or name.
  - **Dynamic registration is open.** Anyone can register a client, which writes
    to KV. The library rejects an http address that is not loopback, a
    dangerous scheme (`javascript:`, `data:`, `file:` and similar) and a
    redirect with userinfo or a fragment, and the consent page labels a client
    that registered itself as unverified. The risk is a flood of registrations
    using up the free KV write limit. Add a rate-limiting rule on `/oauth/`.
    The writes of honest use are small but real: a connected client writes two
    keys each time its access token is refreshed, once an hour, about 48 writes
    a day if it is active around the clock. About 20 such clients use the 1,000
    free writes a day.
  - **The workspace list is capped and refreshed on a miss.** The OAuth server
    lists every workspace address, and the library checks that list pairwise, so
    creating a workspace past 500 is refused with `409 workspace_limit`. The list
    is read every ten seconds and at once when the authorize page or a refused
    `/oauth/token` request meets an address it lacks, at most once every two
    seconds, so a burst of unknown addresses is not a burst of D1 reads.
  - **Client metadata documents.** The library fetches the document of an https
    `client_id` with a 5 KB cap, a 10 second timeout and checks that the
    document names the same address. The fetch needs the
    `global_fetch_strictly_public` compatibility flag so it cannot reach private
    addresses or this Worker's own zone. The consent page then shows the
    client's domain.
  - **KV is eventually consistent.** A used code might work twice at two
    locations within about a minute, and a revoked token can be accepted for
    about a minute at a location that has a copy. Membership removal has no such
    delay. See [mcp-clients.md](mcp-clients.md).
  - **Access Managed OAuth conflicts.** Turn it off for the MCP and discovery
    addresses, or the Access authorization server answers instead of this one.
    `cf/access-setup.sh` with `OAUTH=1` leaves `/oauth/`, `/.well-known/`,
    `/auth/` and `/account` outside Access, and puts `/mcp` and `/w/*` under a
    second app whose policies are Service Auth for the service token, then
    Bypass for everyone. Service tokens keep working on the MCP addresses in
    both modes.
- **What sign-in stores.** `users` (email), `user_identities` (provider, the
  provider's id, the email seen at link time), `login_sessions` (hash of the
  cookie, times, when the second factor passed), `email_links` (hashes, address,
  times) and `user_factors` (the sealed secret, the last step, the failure
  count, hashed recovery codes). Never a cookie value, link token, plain
  recovery code or plain authenticator secret. Provider client secrets, the
  mail API key and `AUTH_SECRET` are Wrangler secrets. The sign-in code writes
  nothing to the Worker log. `login_sessions` rows that expired or were revoked
  more than 30 days ago are deleted when a new sign-in is made, and `email_links`
  rows are deleted after two hours. The idle limit is never shorter than ten
  minutes, so a very small `SIGNIN_IDLE_HOURS` cannot sign out someone who is
  using the site (the last-seen time is written every five minutes).
- **Sessions only move forward.** The states run pending, consumed, attached,
  ended, and `ended` is final. The 24-hour limit starts at the first attach and
  a reattach does not extend it. Every handler checks the deadline inline, so a
  late alarm can't let an expired session act. A delayed `hello` from the app
  can't bring an ended session back, because the relay checks again after it
  hashes the key and reads the body. A reconnect gets a new generation, and a
  request from an older one gets a 409.
- **Full control in a one-off session removes itself in three layers.** First, any end of the
  session (`session_end`, End session, the relay's alarm, the deadline) makes the
  service stop the helper, release its share of the registry value, delete its
  registration, and start a detached `cmd` that deletes the folder once the
  service has exited, then the backstop task, last. If `cmd` cannot start,
  Windows deletes the files at the next restart and the task stays to do the
  rest. If the release could not get the mutex, the task stays too. None of this depends on `state.json`. Every install has a task name of its
  own, so the late self-delete of an earlier install's task cannot remove a newer
  one, and an install that finds an earlier task with no record runs it and waits
  for it first. Second, the service keeps its deadline on disk as a UTC
  time: `connect_by` until the first welcome, then the session's expiry. It checks
  it at every start, also after a restart with no network, and on a timer.
  Third, a SYSTEM scheduled task at the deadline stops and deletes the service,
  releases the registry value, removes the folder and deletes itself, in that
  order. It runs only `cmd`, `sc`, `ping`, `taskkill`, PowerShell (for the
  registry) and `schtasks`, each by its full `System32` path, never the app, which antivirus may have removed. Full
  control survives a restart or a sign-out within the same deadline, and a
  restart never extends it. That guarantee is against the customer's PC, not the
  operator: with SYSTEM rights an operator can change or remove any of these
  layers. A one-off session has no uninstall entry: nothing stays installed to
  uninstall. (A saved PC is different and does have one, described above.)
- **Normal mode leaves nothing behind.** It installs no service, scheduled task
  or logon entry, so restarting the PC ends access, and it deletes its temporary
  command folder on exit. A command runs inside a Windows Job Object, so a
  timeout, an end or the app exiting kills the whole process tree. A program
  the command started without waiting for it gets up to a second after the
  command exits to finish by itself, then it is stopped too. The
  optional restart-reconnect script is the one exception, and it needs the
  customer's approval for one reconnect. That approval covers screen, mouse and
  keyboard control only if the prompt that recorded it carried the text above.
  A reconnect prepared without it, for example by an older app, gets commands
  and files only: the app then reports no `screen` cap, and screen calls return
  `the customer has not approved screen control for this session`.
- **PowerShell cleanup has three layers.** The relay alarm sends `end`. The agent
  remembers its own deadline and cleans up on restart. That deadline is the
  session expiry once connected, and `connect_by` (two hours after the script
  ran) until then. A per-user scheduled task runs the cleanup at the same
  deadline even if the agent was killed, and it still fires on battery or after
  sleep. The first welcome from the relay moves the task from `connect_by` to
  the real expiry.
- **Everything is audited.** Each session records created, consumed, attached,
  every `run` with its command text (cut to 512 characters), file operations
  with path and size but not content, every screen action, and the reason it
  ended. A screen row names the action and its target, such as `screenshot
  1280x800`, `click 640,412`, `key ctrl+s` or `ui_act invoke 12`. Typed text is
  recorded only as a length (`type 12 chars`), and `type_secret` is recorded
  with no length and no text. The relay never stores a screenshot or any other
  image: not in the audit log, not in the session's storage, not in the registry,
  and it writes nothing about tool arguments or results to the Worker log. Rows for
  operator actions name the caller identity from the JWT. The machine, user
  and PowerShell version the client reports are cut to 100, 100 and 40
  characters. On the WebSocket only the first `hello` on each socket counts.
  An app `hello` writes an `attached` row with the reported rights and a
  `hello` row.
- **Screenshots and typed text go to your model provider.** A screenshot is
  returned to the operator's AI agent, and so is the text of a UI tree. Whatever
  is on the customer's screen when you take one, and whatever you tell the
  agent to type, reaches the provider that runs the model. Check that you may
  share that with it before you open a session. Tell the model not to guess
  passwords: `type_secret` types only a secret the operator supplied, and the
  relay neither logs it nor returns it.
- **Session output is untrusted input.** Everything that comes back from a
  session is written by the customer's PC: stdout, stderr, file contents,
  screenshots, window text, and the machine and user names. So is what a saved
  PC reports about itself and the custom field text of any record. Treat it as untrusted text that may try to steer
  the operator's AI agent. That agent can have a shell on the operator's own
  machine, so do not run it with tool calls auto-approved.
- **The window shows, it does not enforce.** The window shows that support is
  connected and working, and the consent dialog says what access is granted. It
  does not stop an operator acting in bad faith: under full control commands run
  as SYSTEM or as the signed-in user with administrator rights, and what they
  change stays changed. The PowerShell agent's
  cleanup covers only its own folder, logon entry and scheduled tasks, and the
  app's covers its service, task, folder and registry value. Neither undoes files an operator wrote,
  software it installed or settings it changed.
- **The app is unsigned.** See [Unsigned app](#unsigned-app). An unsigned exe
  that installs a service may be removed by antivirus, so the download page says
  "If your antivirus removes the file, tell support." Anyone can ask the
  customer to run an unsigned program, so tell the customer who you are before
  you send the link.

## Unsigned app

The downloaded app has no code signature, and the repository does not ship a
signing key. Edge may hold the download until the customer keeps it, and Windows SmartScreen
shows "Windows protected your PC" when the customer opens it. The download page
tells them both steps: **Keep anyway** in Edge, then **More info** and **Run anyway**. The warning goes away
only when you sign the app with a certificate your customers' Windows trusts.
Signing, for example with `signtool`, is out of scope for this repository.
