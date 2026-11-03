# Security model

This is the full security design. The README's [Security](../README.md#security)
section has the short version.

The customer runs a program that came from a link, so the design starts from
what that program may and may not do. The app is the default. Bullets that
apply to only one client say which.

- **Consent is always a click.** Full control is the default, and Windows' own
  UAC prompt is its consent: the corner window first says "Windows will ask for
  permission to give support full control.", then UAC asks, with **No** as its
  default. When no UAC prompt would appear (the app already runs as
  administrator, UAC is off, or an administrator elevates without a prompt), the
  app shows its own dialog first: "Give support full control of this PC?
  Support can see your screen, control your mouse and keyboard, work through
  Windows security prompts and the sign-in screen, and keep working after a
  restart. Access ends when you click End session, or after 24 hours, and
  everything is removed." If the customer says No anywhere, or elevation fails,
  the app asks "Continue with limited support? Support can see your screen and
  control your mouse and keyboard, but not Windows security prompts." Every
  dialog has **Don't allow** selected by default, and only a click on Allow
  grants access. Don't allow on the last one ends the app with nothing
  installed.
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
  process. That process reads its own file once, through a handle that stops
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
  the old value back, only if the value is still the one written. The own-window
  guard of the helper covers the corner window the service started and the app
  that installed it, not every process that talks to the window pipe. UIPI no longer limits input, so support can work
  in windows that run as administrator. Commands keep the Job Object and the
  output caps. `request_full_control` asks one prompt at a time, and not again
  within a minute after the customer declined.
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
  to click its own window or type while its own window has the focus, and it
  checks the focused window again before each key and each typed character.
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
- **Pairing codes can't be guessed.** A code is 16 base32 characters, 80 bits,
  single use, and valid for 10 minutes. The customer pastes it and never types
  it, so its length costs nothing.
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
- **The operator endpoint sits behind Cloudflare Access.** The relay verifies
  the Access JWT itself: RS256 signature, `aud`, `iss`, `exp` and `nbf` with 60
  seconds of skew. It caches signing keys for an hour and allows at most one
  forced refetch per minute when it sees an unknown `kid`. Requests carrying
  an `Origin` header get a 403 and non-JSON bodies get a 415, which blocks
  cross-site POSTs from a logged-in browser.
- **Sessions only move forward.** The states run pending, consumed, attached,
  ended, and `ended` is final. The 24-hour limit starts at the first attach and
  a reattach does not extend it. Every handler checks the deadline inline, so a
  late alarm can't let an expired session act. A delayed `hello` from the app
  can't bring an ended session back, because the relay checks again after it
  hashes the key and reads the body. A reconnect gets a new generation, and a
  request from an older one gets a 409.
- **Full control removes itself in three layers.** First, any end of the
  session (`session_end`, End session, the relay's alarm, the deadline) makes the
  service stop the helper, release its share of the registry value, delete its
  registration, and start a detached `cmd` that deletes the folder once the
  service has exited, then the backstop task, last. If `cmd` cannot start,
  Windows deletes the files at the next restart and the task stays to do the
  rest. None of this depends on `state.json`. Every install has a task name of its
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
  layers. There is no uninstall entry: nothing stays installed to uninstall.
- **Normal mode leaves nothing behind.** It installs no service, scheduled task
  or logon entry, so restarting the PC ends access, and it deletes its temporary
  command folder on exit. A command runs inside a Windows Job Object, so a
  timeout, an end or the app exiting kills the whole process tree. The
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
  screenshots, window text, and the machine and user names. Treat it as untrusted text that may try to steer
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
