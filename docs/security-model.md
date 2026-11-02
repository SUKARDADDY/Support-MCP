# Security model

This is the full security design. The README's [Security](../README.md#security)
section has the short version.

The customer runs a program that came from a link, so the design starts from
what that program may and may not do. The app is the default. Bullets that
apply to only one client say which.

- **Consent is explicit.** The app does nothing until the customer clicks
  **Allow** in a dialog that says what access they are giving: support can see
  the screen, control the mouse and keyboard, run commands, and read or change
  files, as the signed-in user (or with administrator rights, when the app was
  started that way). **Don't allow** is selected by default, and only a click on
  Allow grants access.
- **The window shows that access exists.** The app's window stays on top in the
  bottom-right corner while support is connected. It shows a running timer and
  when the session ends by itself, turns blue while a command, file or screen
  operation runs, says "Paused while you use the PC" while the customer's input
  has the right of way, and has an **End session** button. It never shows commands, paths or
  output. End session, Alt+F4 and the taskbar Close all ask "End the session?"
  first. The PowerShell agent's window is different: it lists every command and
  file operation as it runs.
- **Normal mode only.** This version of the app has no full control. Its
  screen capture, mouse, keyboard and UI Automation run inside the customer's own
  process and desktop session, with the customer's token. It cannot see or
  operate UAC prompts, the lock screen or the sign-in screen (the secure desktop),
  it cannot run as SYSTEM, and it refuses to click or type into a window that runs
  as administrator, because Windows would drop that input. `hello` reports
  `control: normal`. The relay refuses `run` with `as: "system"`, `block_input`
  and `send_sas` unless the stored control is `full`, and the app refuses them
  too. A later release will add full control, with its own consent flow.
- **Customer input wins.** Input from the operator fails with `customer is using
  the PC; try again in a few seconds` for 3 seconds after the customer last
  used the mouse or keyboard. The app finds the customer's input with low-level
  hooks that see only physical events. Windows removes a hook that times out,
  without telling the app, so the app also compares `GetLastInputInfo` with the
  time of its own last injected input, and a later input counts as the
  customer's. Screenshots, UI reads and commands are not paused. The app refuses
  to click its own window or type while its own window has the focus, and it
  checks the focused window again before each key and each typed character.
  Typing, key sequences and drags also stop at once when the session ends or the
  customer starts using the PC, and a drag releases the mouse button first.
- **A secret is typed, never kept.** `type_secret` types into the focused field
  in normal mode too. The relay logs only the word `type_secret`, not even a
  length. It does not return the text. If the app reports a failure, the relay
  drops the app's error text and returns `type_secret failed`, so a secret can
  not come back inside an error. The screenshot that follows shows what the field
  shows, so the operator should pass `screenshot: false` unless the field masks
  its input.
- **No elevation by the app.** The manifest is `asInvoker`, so Windows never
  shows a UAC prompt for the app itself and no code path asks for elevation. If
  the customer starts it with Run as administrator anyway, it asks a second,
  explicit question before connecting, with No selected by default. The window
  then says "Running with administrator rights.", and `session_status` reports
  `elevated: true`. Commands inherit that token.
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
- **The app leaves nothing behind.** In this version it installs no service,
  scheduled task or logon entry, so restarting the PC ends access, and it deletes
  its temporary command folder on exit. A command runs inside a Windows Job Object, so a
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
  does not stop an operator acting in bad faith: commands, the mouse and the
  keyboard run with the signed-in user's rights, and what they change stays
  changed. The PowerShell agent's
  cleanup covers only its own folder, logon entry and scheduled tasks, and the
  app's covers its temporary folder. Neither undoes files an operator wrote,
  software it installed or settings it changed.
- **The app is unsigned.** See [Unsigned app](#unsigned-app). Anyone can ask the
  customer to run an unsigned program, so tell the customer who you are before
  you send the link.

## Unsigned app

The downloaded app has no code signature, and the repository does not ship a
signing key. Edge may hold the download until the customer keeps it, and Windows SmartScreen
shows "Windows protected your PC" when the customer opens it. The download page
tells them both steps: **Keep anyway** in Edge, then **More info** and **Run anyway**. The warning goes away
only when you sign the app with a certificate your customers' Windows trusts.
Signing, for example with `signtool`, is out of scope for this repository.
