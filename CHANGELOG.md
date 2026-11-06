# Changelog

All notable changes to Support-MCP are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org). It stays at 0.x until Stage 1 is safe
to run on unattended customer PCs.

## [Unreleased]

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
  custom role `devices.view` and `devices.manage` to restore it. Production has
  no custom roles.
- A workspace that edited the `technician` or `viewer` role keeps its edit, which
  has none of the new permissions. Edit the role to add them. Admins hold every
  permission either way, and a workspace that never edited them gets the new
  defaults.
- Add `/device/` to the Cloudflare rate-limiting rule next to `/j` and `/ws`. It
  must stay outside Access.
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
