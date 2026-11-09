# Changelog

All notable changes to Support-MCP are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org). It stays at 0.x until Stage 1 is safe
to run on unattended customer PCs.

## [Unreleased]

The relay side of the technician app (the Windows app itself comes in the next release).
The version stays 0.7.0.

### Added

- The technician app's own sign-in. It uses the same consent page and OAuth server as an MCP
  client, for the resource `<origin>/app/w/<slug>` (every workspace, `default` too), so its
  token is a different grant: a 401 on `/mcp` and `/w/<slug>/mcp`, while an MCP client's token
  is a 401 on `/app`. The consent page says what the app can do and what it cannot. A request
  that names an app address gets an OAuth server that declares only that address, and a token
  the relay has just checked is remembered in memory for 60 seconds, to save free-plan KV reads.
- Routes under `/app/w/<slug>`: `POST .../mcp` (the same tools as `/mcp`), `.../api/...` (the
  team API, limited to who you are, customers, sites, PCs, custom fields to read, pairing
  codes and the agent's tasks), `GET .../teams`, `GET .../notifications` (held open for up to
  25 seconds) and `GET` and `PATCH .../notifications/settings`. Every route takes a bearer token
  only, refuses an `Origin` header, needs JSON on writes, serves members only (never open mode),
  and holds the caller to the second factor a permission needs. `/api/v1` stays Access-only.
- The agent's last picture: `GET /app/w/<slug>/api/agent/tasks/<id>/frame` returns the last full
  screenshot a task took, for the task's starter or its session's driver. It is held in the task's
  memory only, never stored, and gone when the task ends.
- Notifications for six events: task finished, task needs attention, session ended early, PC
  online, PC missing and PC waiting for approval. Rows go to members who are people, in the same
  batch as the change that causes them. Migration `0007_notify.sql` adds the `notifications` table
  and `members.notify`. Apply it before you deploy this version. An hourly Cron Trigger
  (`[triggers]` in `wrangler.toml`) finds PCs not seen for 7 days and deletes notifications older
  than 30 days. If you deploy with a copy of `wrangler.toml`, add the trigger to the copy.
- A Registry notes when a PC's doorbell goes away, and the Worker tells it the workspace. When a doorbell closes it also moves the PC's `last_seen` up to the drop, so the "missing for 7 days" count starts there. The hourly run stays under the free plan's 50 subrequests and takes teams in turn.

### Changed

- The session log folds a run of identical screenshots by one person, within a minute of each
  other, into one row: `screenshot 1280x800 (x3)`. Nothing else is merged.
- `docs/mcp-clients.md` now says that a loopback redirect address matches on any port, which the
  library has always done.

## [0.7.0] - 2026-11-09

### Added

- The built-in agent. A technician hands a task to an agent that runs on the relay: it
  works on a saved PC (or a session the technician drives) one step per alarm, as the
  technician, through the same tools, role checks and stops an MCP client has, and keeps
  going after the technician disconnects. It runs on any OpenAI or Claude model the team
  chooses (GPT-6.1 Terra by default), with the team's own key. A new Durable Object,
  `AgentTask` (binding `AGENT_TASK`, migration tag `v2`), runs each task and each model
  check.
- Three MCP tools, `agent_start`, `agent_status` and `agent_control`. The tool count goes
  from 24 to 27. They are for members only (never open mode); starting and controlling
  need `sessions.control`, reading needs `sessions.view`. `tools/list` is the same in
  every mode.
- Team API routes under `/api/v1/w/<slug>/agent`: `GET` and `PATCH` for the settings (mode,
  default model, who may pick a model, the two caps, the two keys; `members.manage`),
  `POST .../models` and `DELETE .../models/<provider>/<id>`, and `GET` and `POST
  .../tasks`, `GET .../tasks/<id>` and `POST .../tasks/<id>/pause|resume|stop`. A key is
  sealed under `AUTH_SECRET`, shown only as its last four characters, and opened only
  inside an `AgentTask` object.
- A team picks who runs sessions: MCP clients, the built-in agent, or both (the default).
  In "agent" mode `/mcp` refuses the session tools with "this team uses the built-in
  agent" but still allows the agent tools, `device_list`, `session_list` and
  `session_status`.
- Spending caps. Nothing runs until an admin sets a per-task cap and a per-month cap. The
  worst case of every model call is reserved in D1 against both before the call, sized to
  the room left (never under 4,000 output tokens), so tasks running at once cannot pass a
  cap together. A task also stops at 120 tool calls or 2 hours, when anyone else takes
  over its session, when its starter is removed or loses `sessions.control`, when the
  workspace or the relay is stopped, and, unless started with `keep_working`, 2 minutes
  after the last time anyone read its status.
- Models: five in the code with their prices (`gpt-6.1-terra`, `gpt-6.1-sol`,
  `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`), and any other OpenAI or
  Anthropic model an admin adds with its prices. A model must pass a two-turn check (call a
  tool, then read a word off a small screenshot) before it is usable.
- The Session log marks the agent's actions: `[boss@example.com via agent] click 640,412`.
  The actor is still the person who started the task. A new internal `/watch` route lets a
  task see its session's state, driver and who has commanded it.
- Migration `0006_agent.sql` adds `agent_settings` and `agent_tasks`. Apply it before you
  deploy this version.

### Changed

- The relay now sends screenshots to the team's AI provider when a task runs on the
  built-in agent. It stores none and sends `store: false` to OpenAI, but the providers'
  own retention applies (OpenAI keeps abuse-monitoring logs for up to 30 days). The
  security model and the README say so. The relay's own size grows by the two provider
  SDKs, which load only when a task or a model check first runs.
- The package depends on `openai` and `@anthropic-ai/sdk` (both with retries off, and the
  Claude client pinned to the `x-api-key` header and API version 2023-06-01 that were
  checked against the real API).

## [0.6.0] - 2026-11-08

### Added

- Connect to a saved PC. Two new MCP tools: `device_list` (the team's saved PCs
  with `online`, and custom fields marked as untrusted text) and `device_connect`
  (`{device_id, ask?, take_over?}`, which returns `{session_id, state: "waiting",
  asks, rang}`). The tool count goes from 22 to 24. A PC set to ask first, a call
  with `ask: true`, and a caller without the new permission all make the person at
  the PC allow the session.
- Migration `0005_device_sessions.sql` adds `devices.session`, the one live
  session of a PC. The check-in answer (`/device/hello`) gets a new top-level
  `session` key, `{id, by, team, ask, expires_at}`, only for an active PC.
- The doorbell, `GET /device/ring?protocol=1`: a WebSocket each PC keeps open to
  its workspace's Registry object, which rings it with `{"type":"ring"}` when a
  technician connects or takes over, when a team change touches the PC's access or
  approves it, when the PC is removed, and when the workspace stops. A PC with its
  doorbell up checks in at connect, on each ring and every 6 hours; one without
  keeps the 5-minute check-in. `device_list` reports `online` from it.
- Sessions on saved PCs. A session starts `waiting` (510 seconds for the PC to
  pick it up and its person to answer), attaches on the PC's `hello`, and ends 24
  hours after that with no idle timeout. The PC joins with its device key in
  `Authorization` and no attach key; the relay checks it against the database on
  every request and lets it into only the session its record points at. A new
  `decline` message before `hello` (`declined`, `nobody` or `busy`) ends the
  session; after a `hello` only `nobody` and `busy` are taken. A `hello` with full control from a limited PC is 403. `welcome` and
  every poll answer carry the `driver`.
- One driver at a time. A command from anyone else is refused with the driver's
  name. `take_over` moves the driver and is logged, not an end. End reasons:
  `declined`, `nobody`, `busy`, `timed_out`, `max_time`, `owner`, `technician`,
  `stopped`, `removed` and `replaced`. New team log rows `device_session_started`,
  `device_session_taken_over` and `device_session_ended`.
- A new permission, `sessions.unattended` ("connect to a PC without asking the
  person at it, and switch a PC to any time"). Admins hold it. It needs a second
  factor and open mode never grants it.
- The Windows side of a session on a saved PC. The service asks the person at the
  PC with `--device-ask` (names the technician and the team, "Don't allow" by
  default, no answer in 2 minutes is a no), or declines `nobody` or `busy`. Full
  control works as the system on the console or the one Remote Desktop session;
  limited support works only as the signed-in user. A corner window shows who is
  connected and ends the session, and its last message says whether the team can
  connect again later or will ask first. The tray shows who is connected and has
  an End session button; the status pipe gets `end_session` and `session` and
  `uninstall_event` fields. A restarted service rejoins a session the person
  already allowed. No update is installed during a session.
- The PC's uninstall event has a random name per install. The setup mutex, the
  SAS mutex and the uninstall event are used only when SYSTEM or Administrators
  own them; one that someone else made first, or that shuts this account out, is
  refused or skipped (issue #22). A refused install or uninstall says "Another
  program is blocking Support. Restart the PC and try again."
- While `EMERGENCY_STOP` is set the check-in answer leaves out `session`.
- Stop and resume. `POST` and `DELETE /api/v1/w/<slug>/stop` (and `GET` for the
  state) stop a workspace, which ends every live session in it and refuses its
  tool calls, and resume it. Stop needs `sessions.end`, resume needs
  `members.manage`. Each session also checks the stop itself, at most every 20
  seconds: an app session on its polls, a PowerShell session on its attach, its
  messages and an alarm every 30 seconds. A connect under way when the stop lands
  cannot claim the PC, and a pointer to a Session that has ended is replaced by the
  next connect. New log rows `workspace_stopped` and `workspace_resumed`.
- `EMERGENCY_STOP`, a deploy setting. Any non-empty value refuses every tool
  call, every connect and every `/agent` request for the whole relay, and ends
  live sessions on their next request.

### Changed

- Switching a PC to "any time" in the team API now needs `sessions.unattended` as
  well as `devices.manage` (403 otherwise, checked again at commit). Switching to
  "ask" needs only `devices.manage`. A change of access and an approval ring the
  PC.
- Removing a PC, or a PC leaving, ends its live session with the reason `removed`.
- The README no longer says nobody can connect to a saved PC. The Stage 1 warning
  stays: do not use a saved PC on a real customer's unattended machine yet.

## [0.5.0] - 2026-11-08

### Added

- Saved PCs update themselves. At a check-in the relay may offer its current
  release in a new `update` field of the `/device/hello` answer. The PC takes it
  only when the release note is signed with the project's release key (ECDSA
  P-256, built into the app), the version is newer than its own and has not failed
  on this PC, and the app it downloads has the size and SHA-256 the note names.
  It all runs in the background: no prompt and no window, only history lines.
- Staged rollout. A release reaches 10% of PCs for a day, then half for a day,
  then all, by a group worked out from the release and each PC's id. Waiting PCs
  are never offered one. Nothing new is stored: no migration.
- Trial and rollback. Each version is kept as its own file,
  `support-<version>-<8 hex>.exe`, in `%ProgramFiles%\SupportMCP`. The service,
  the tray's startup entry and the Apps entry are pointed at the new file, which
  runs on trial for 4 minutes. A check-in answered with 200, 202 or 401 keeps
  it. A crash, a failed start, a protocol refusal (426) or any other refusal
  puts the old version back, and so does a trial still open at its deadline.
  With no network or a server error, the new version tries again every 30
  seconds, and is kept if the relay is still unreachable near the deadline.
  After a restart during the trial, the new version gets a fresh 4 minutes and
  starts a watcher from the old file, so the deadline holds across restarts. A
  version that failed is never tried again; a restart before it ever ran does
  not count against it. Old files are deleted once nothing uses them; one still
  in use is renamed and removed at the next restart.
- Three deploy settings: `RELEASE_SIGNATURE` and `RELEASE_SIGNED_AT`, made at
  deploy time by `scripts/sign-release.mjs`, and `UPDATE_ROLLOUT` (empty for the
  stages, `pause`, or a share from 0 to 100). Without a signature the relay
  offers nothing.
- `scripts/release-key.mjs` makes the release key in memory and prints the
  private key only to stdout, for a secrets manager. `release-key.pub` holds the
  public key, and a test keeps it equal to the app's.
- The tray shows the app's version, and the status pipe's answer carries it.

### Changed

- A protocol refusal (426) from `/device/` carries the signed release too,
  unless the rollout is paused, so a PC on an older protocol can update itself.
- The PC downloads updates from `/install`, with the same `POST` and `Origin` as
  the setup page's button.
- Uninstall ends trays started from any version of the app in the install
  folder, removes every version file and the update record, and answers "busy,
  try again in a few minutes" (exit 21) while an update is on trial.
- Everything that starts the installed app (the tray at sign-in, the setup
  wizard's "Open Support", the tray's "Uninstall Support") uses the file the
  service runs.

### Security

- The service of a saved PC now installs new versions of itself, but only
  releases signed with the project's release key. The private key is kept
  offline and read only at deploy time; the relay, Cloudflare and CI never hold
  it. A relay can offer a release or hold one back, but cannot make a PC run
  anything else or go back to an older version. It can make a new version fail
  its trial by refusing its check-ins (a 426 or another refusal); that version
  is then skipped until a newer one.
- The apps stay unsigned for Windows. The release key signs only the release
  note, which only a saved PC's update check reads.

### Not yet

- PCs on 0.4.0 have no updater and need a reinstall to reach 0.5.0.
- A failed update is recorded on the PC only. A team view comes later.

## [0.4.0] - 2026-11-07

### Added

- A saved PC. The Windows app can now be installed permanently on a PC by its
  owner, through a setup wizard. The owner enters a pairing code (prefilled when
  they start from a technician's link) or joins from the team's install link,
  names the PC, chooses how support may connect ("ask each time" or "any time")
  and how much control (full control or limited support), then answers one
  Windows permission prompt. Nothing is preselected for the last two choices. A
  PC that joined without a code shows a six-digit number until a technician
  approves it.
- What the install puts on the PC. `%ProgramFiles%\SupportMCP` holds the app
  (`support.exe`, which users can read and run) and a device record with the
  PC's key and a short local history (readable only by SYSTEM and
  administrators). A Windows service, "Support device service"
  (`SupportMcpDevice`, LocalSystem, starts automatically, restarts on failure),
  checks in with the relay every few minutes. In this release it runs no
  commands, takes no screenshots and opens no files for anyone. A tray icon
  starts at each sign-in, and an entry in Windows Settings > Apps lets the owner
  uninstall.
- The tray shows the PC's name, its access mode, its state ("No one is
  connected.") and recent local history, and has "Uninstall Support".
- Uninstall, from Settings > Apps or the tray. After one Windows permission
  prompt, the relay forgets the PC (its key stops working), the tray closes, and
  the service, the startup entry, the Apps entry and the folder are removed.
  Anything locked is deleted at the next restart. If the relay cannot be reached,
  everything is still removed on the PC, and the team must remove the PC from
  their list.
- A public install page at `/install`. `GET` shows a page with a download
  button. `POST` downloads the Windows app with a small "device" footer that
  names the relay and either a pairing code (`?code=`) or a workspace
  (`?workspace=`). A chat app's link preview only fetches the page, so it
  downloads nothing. `/install` stays outside Cloudflare Access, like `/j/` and
  `/device/`.
- The team API's pairing answer includes a ready-to-send `link`, the install
  link with the new code.

### Changed

- The one-way rule for access on the PC. Anyone signed in at the PC can switch
  "ask each time" to "any time" from the tray, with no administrator prompt.
  Nothing in the app switches it back; only the support team can, through the
  team API. The rule is enforced by the app, not the relay, which still takes
  either mode from a holder of the PC's key (only SYSTEM or an elevated
  administrator can read it), as pinned earlier. This means any signed-in user,
  including a standard user or a guest, can turn on unattended access. Nothing
  can connect to a saved PC yet, but read this before you deploy a release that
  can.
- The owner contact of a saved PC is now set by technicians, not by the PC. A
  technician with `devices.manage` sets or clears it with `PATCH .../devices/<id>`
  and `owner_contact` (the team log names the field, never the value).
  `/device/pair` and `/device/update` now answer 400 `bad_request` when the body
  has `owner_contact`.
- Full control still removes itself, and a one-off session still leaves no
  uninstall entry. Both statements now apply to one-off sessions only. A saved PC
  stays installed until its owner uninstalls it.

### Security

- A technician's install link carries a working pairing code. It can land in
  browser history, chat link previews and the relay's request logs, so whoever
  uses the link first within its 10 minutes gets the PC. Send it over a channel
  you trust.
- Only SYSTEM or an elevated administrator process can hold a saved PC's key.
  The install, the key file and the history file are readable only by SYSTEM and
  administrators.

### Not yet

- Nobody can connect to a saved PC. That comes in a later release.
- Do not install a saved PC on a real customer's unattended machine. Wait for
  the release that enforces rules about who may connect and when.
- The one-off support link flow is unchanged.

## [0.3.0] - 2026-11-07

### Added

- Customers, sites and saved PCs. A workspace keeps customers, their sites and
  their PCs through the team API, with built-in fields and text custom fields
  that admins define. Migration `0004_devices.sql` adds the tables. Nothing here
  connects to a saved PC yet.
- Pairing. A technician asks for a 10-character code that works once and dies
  after 10 minutes, and the owner types it on the PC. Or the owner starts the
  install and a technician approves it with a six-digit number the owner reads
  out. A PC gets its own long-lived key and keeps it until it leaves or a
  technician removes it. The PC's side is four public addresses under
  `/device/`: `pair`, `hello`, `update` and `leave`, each speaking `"protocol": 1`.
- Three permissions: `devices.view`, `devices.manage` and `fields.manage`. A
  technician gets the first two, a viewer gets the first, and admins hold all.
- The team log records every change to customers, sites, custom fields, pairing
  codes and PCs. A technician with `devices.manage` can switch a PC between
  "asks first" and "any time"; the log names the technician and both modes.

### Changed

- A custom role with `members.manage` but no device permissions can no longer add
  or change a technician or a viewer, because those roles now hold permissions
  the custom role lacks (the rule that you hand out only what you hold). Give the
  custom role `devices.view` and `devices.manage` to restore it.
- A workspace that edited the `technician` or `viewer` role keeps its edit, which
  has none of the new permissions. Edit the role to add them. Admins hold every
  permission either way, and a workspace that never edited them gets the new
  defaults.
- Add `/device/` to the Cloudflare rate-limiting rule next to `/j` and `/ws`. It
  must stay outside Access.
- `devices.manage` and `fields.manage` join the permissions that need a second
  factor at browser sign-in and OAuth consent. A person whose role holds either
  must enrol an authenticator; Access callers are still exempt.
- A technician's `PATCH .../devices/<id>` with `name`, `control` or another
  field the PC owns is now 400 `bad_request`; those stay the owner's.
- A PC's changed check-in details are written at most once a minute (unchanged
  ones still every 5 minutes). A pairing code works only while the person who
  made it still holds `devices.manage`. Migration `0004_devices.sql` adds the
  indexes `devices_by_status` and `audit_by_kind`.
- The README's tool count badge now says 22, as the relay lists.

## [0.2.0] - 2026-11-06

### Added

- Computer use: screen capture, mouse and keyboard input and UI Automation, with
  two lanes so a screen operation does not wait for a running command (#10).
- Full control through a UAC-approved SYSTEM service that reaches the secure
  desktop and survives a restart (#11, #12).
- Team members and roles. Every MCP tool call is checked against the caller's
  role (#13). Team managers cannot edit members or roles stronger than their own,
  and checking a log page is cheaper (#14).
- Workspaces. Each team gets its own MCP address, team API and session list (#15).
- Technician sign-in with Google, Microsoft or an email link, followed by an
  authenticator code (#16).
- OAuth sign-in for MCP clients. A client signs in as the person, for one
  workspace address (#17).
- One release version for the relay, the Windows app and the PowerShell agent.
  `/healthz`, the MCP `serverInfo` and the exe's file version carry it, and both
  agents send it in their hello. `session_status` reports it as `client_version`
  and adds `client_agent` for the protocol generation string.
- `scripts/bump-version.mjs` sets the version everywhere, and
  `test/version.test.js` fails when the copies disagree.

### Changed

- `session_status` `client_version` is the release version when the client sends
  one. Older clients still show their `agent` string.

## [0.1.0]

The first public release. It is the state of `main` at #7 (commit 99f242b), deployed
to production on 2 November 2026, and production runs it until 0.2.0 is deployed.

- Consent-based, self-expiring Windows remote support sessions, run by an AI
  agent over MCP.
- A Cloudflare Worker with Durable Objects relays commands. A session ends when
  the customer closes it, when the operator ends it, or after 24 hours.
- A downloadable Windows app, with a PowerShell agent as the alternative. The
  customer approves the session before anything runs.
- A reproducible app build, checked against the committed exe in CI (#6).
- The app runs on .NET Framework 4.5.2 without crashing (#7).
