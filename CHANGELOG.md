# Changelog

All notable changes to Support-MCP are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org). It stays at 0.x until Stage 1 is safe
to run on unattended customer PCs.

## [Unreleased]

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
