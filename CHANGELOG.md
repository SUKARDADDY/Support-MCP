# Changelog

All notable changes to Support-MCP are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org). It stays at 0.x until Stage 1 is safe
to run on unattended customer PCs.

## [Unreleased]

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
  Nobody at the PC can switch it back. Only the support team can, through the
  team API. This means any signed-in user, including a standard user or a guest,
  can turn on unattended access. Nothing can connect to a saved PC yet, but read
  this before you deploy a release that can.
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
