# The technician app (Windows)

A small Windows program for the people on your team who help customers. It signs in to your
relay, shows your saved PCs, pairs and approves new ones, lets you watch a PC's screen and
the built-in agent's work, and tells you about the six things that need you. It is a Tauri 2
app: a Rust core that holds the sign-in and talks to the relay, and React screens drawn by
Windows' own web view (WebView2). The code is in `technician-app/`.

Contents: [Install](#install) · [Sign in](#sign-in) · [The screens](#the-screens) ·
[Notifications](#notifications) · [Updates](#updates) · [SmartScreen](#smartscreen) ·
[Free-plan limits](#free-plan-limits) · [Security](#security) · [Build](#build-and-release) ·
[How it is tested](#how-it-is-tested)

## Install

Run `support-technician-<version>-setup.exe` from the GitHub release. It installs for the current
Windows account only, so it never asks for administrator rights, and puts Support in the
Start menu. Windows 10 and 11 on 64-bit PCs. If WebView2 is missing (an old Windows 10), the
installer downloads Microsoft's bootstrapper and installs it first.

To remove it, use Windows Settings, Apps. That deletes the app and its files. Your sign-in
sits in `%APPDATA%\dev.support-mcp.technician\app.json`, sealed so only your Windows account
can read it; **Sign out** in the app's Settings deletes it too. A downloaded update waits in
`%LOCALAPPDATA%\dev.support-mcp.technician\update\`, not in the roaming folder, because the installer is
large and only useful on this PC.

### What an uninstall removes

Both folders, `%APPDATA%\dev.support-mcp.technician` (the sealed sign-in, `app.json`) and
`%LOCALAPPDATA%\dev.support-mcp.technician` (the web view cache and a staged update), are the
app's data. What happens to them depends on how the app is removed:

- **Windows Settings, Apps** shows the uninstaller's window with Tauri's **Delete app data**
  box, unchecked. Tick it to delete both folders.
- **A silent uninstall** (`uninstall.exe /S`, as winget, Intune and scripts run it) has no window,
  so that box is never read. `technician-app/src-tauri/windows/hooks.nsh`, set as
  `bundle.windows.nsis.installerHooks`, runs after the template's own uninstall steps and deletes
  both folders.
- **An update never deletes them.** Tauri's template enters update mode only when the installer is
  started with `/UPDATE`; `/S` and `/R` do not set it. The app starts its installer with
  `/S /R /UPDATE` (`INSTALLER_ARGS` in `update.rs`). In update mode the template installs over the
  old files without running the old uninstaller and tells any uninstaller it does start. The hook
  has two guards of its own: it checks `$UpdateMode <> 1`, and it acts only when `${Silent}`
  is true, which means that uninstaller was itself started with `/S`. The old uninstaller that a
  new installer runs for an interactive reinstall is started without `/S`, so it never matches.
  A test (`lockdown.rs`) holds the hook, its two guards and the installer's arguments.

Upgrading by running `uninstall.exe /S` and then the new installer (as winget and some Intune setups
do) is a silent uninstall, so it wipes the sign-in by design; only the app's own updater and an
installer run over the old one keep it. During a silent uninstall WebView2 may still hold files in
`EBWebView` for a moment, so a few may remain in the local folder.

The hook is plain NSIS and is not built on Linux. Check it on Windows: sign in, run
`uninstall.exe /S` and confirm both folders are gone; then sign in again and let the app update
itself, and confirm `app.json` is still there.

## Sign in

The first screen asks for the relay address (`support.example.com`) and the team (`default`
unless your relay has several). Press **Sign in with your browser**. The app opens your
default browser, you sign in there the way you do on the relay's own pages (email link or
provider, and your authenticator code), and approve a page that reads "Support technician app:
works as you in `<team>`, including seeing PCs and their screens, pairing and approving PCs,
changing how they can be reached, and starting agent tasks. It can't change members, roles or
agent keys." Only approve it when you just started signing in from the app.

The browser then returns to a loopback address on your own PC and the app signs in. The
sign-in is the app's own, separate from the one Claude Code or Codex use, and it works only on
the app's address (`/app/w/<team>`). It is kept sealed with Windows' DPAPI. The app renews it
before the hour is up and asks you to sign in again only when the relay refuses it, for
example after **Sign out everywhere** or when an admin removes you. A busy relay is retried and
never costs you the sign-in.

If you belong to more than one team on the relay, Settings lists the others. Each needs its own
approval in the browser, and the Devices screen gets a team picker.

## The screens

- **Devices.** Your saved PCs, with search, filter chips with counts (all, online, offline,
  waiting, any time, asks first) and a mark for each: solid green is online, dotted grey offline,
  solid blue connected, dashed blue waiting. Select a PC to see how it can be reached and
  press **Connect**. A PC set to "any time" connects at once if your role may connect without
  asking. One set to "asks first" shows "Waiting for someone at the PC to click Allow", and a
  decline, nobody signed in, or a busy PC is explained in words. If someone else is connected,
  holders of `sessions.unattended` see **Take over**. **Hand to the agent** starts a built-in
  agent task on an online PC.
- **Waiting PCs.** A PC whose owner started an install and is waiting for you shows
  "Needs approval". Select it, ask the owner for the six-digit number on their screen, type it
  and press **Approve**.
- **Add a device.** Press **Get a pairing code**. The owner installs Support on the PC and enters the
  code (it works once, for ten minutes). The screen watches the list and the code. When the PC
  arrives, or the code is no longer live, the countdown is replaced by "Code used by <PC>". **Copy install link** copies the relay's `/install` link with the code in it.
- **One-off link.** For a PC you will help once: creates a session link that works once, for ten
  minutes, and nothing is saved to your devices.
- **Session tabs.** Each open session is a tab at the top. See below.
- **Notifications.** The recent items, and a Settings tab with a switch for each of the six
  events, the PCs you watch for "came online", and a switch for Windows notifications on this PC.
- **Settings.** Accounts, appearance (light, dark or the same as Windows), starting the app with
  Windows (off until you choose it), and updates. **Sign out** asks first. When you confirm,
  the app asks the relay to revoke its sign-in (RFC 7009, `POST /oauth/token` with the refresh
  token, which ends the whole grant) and waits at most 5 seconds for the answer. Then it deletes
  the account and its sealed tokens from this PC, whether or not the relay answered. If the relay
  could not be reached, the sign-in stays valid there until it expires or **Sign out everywhere**
  on the relay ends it.
  The native title bar and window border follow the appearance setting (the `window_theme`
  command), so the dark theme has a dark title bar.

### The session tab (view only)

The tab shows the PC's screen. It never clicks or types: those arrive in a later release, and
the app's core has no tool for them.

- While a built-in agent task works on the session, the tab shows the last picture the task
  took. The relay holds the picture in memory only, for the task's starter and the session's
  driver. The tab keeps the task's status open on the relay and fetches the picture again whenever
  it changes. It takes no screenshot of its own then, because the PC handles one command at a time.
- Otherwise, if you are the driver and the tab is on screen, it takes a screenshot every 3 seconds.
  It stops at once when the relay answers that someone else is driving or the PC is busy with the
  agent, and starts again when you press **Try the screen again** or take over. It also stops
  while the window is minimised or in the tray.
- Every task start (from a tab or from a PC's detail) first stops the screenshots of any open tab on
  that PC or session and waits for one in flight to finish, so the agent's first step does not meet
  a busy PC. The tab then follows the task and takes no screenshot until it is over.
  When the PC's session is open in a tab and you drive it, a task started from the PC's detail starts
  on that session, because starting by PC would make the relay connect again and be refused. The
  activity panel lists the session log only from the task's start on, and says why a task failed
  or was stopped.
- Every 15 seconds it looks for a task running on the session and switches to its picture.
- The activity panel shows what the task has cost against the team's cap for one task ("Spent
  $0.42 of the $2.00 task cap."), and the same line in the summary when the task is over. The
  relay's task status carries `cost_usd` and the caps.
- The relay cuts a task's title at 100 characters. For a task this app started, the app keeps the
  first line of the instructions (for the last 50 tasks, in its own storage) and shows it whole in
  the panel header and in the Notifications list. Otherwise the title ends at the last whole word
  with an ellipsis, as does the Windows notification, which cannot see the instructions.
- **Activity** lists the task's steps and notes together with the session log, in time order.
  Everything from the PC (step details, notes, log text, names) is shown as text, never as markup.
- **End session** ends it. **Take over** appears for holders of `sessions.unattended` when someone
  else drives. **Pause**, **Resume** and **Stop the task** control a running task.

## Notifications

The relay writes a row for each of six events (task finished, task needs you, session turned
down, a watched PC came online, a PC went missing, a PC is waiting for approval) for the people
who should hear it, and the app holds a request open on it, so an item arrives within seconds.
It shows each as a Windows notification, and keeps the recent ones in the Notifications screen.
Switching an event off in the app's settings stops the relay writing it for you. The first time
the app runs for an account it reads the backlog silently: the list shows it, but no
notification pops up for old news.

Clicking a notification opens the PC or the task it is about, **while the notification is
still on screen**. Windows reports a click only then. A notification you open later from the
Notification Center only opens the app, so use the Notifications screen to find the item.
Closing the window sends the app to the tray, where it keeps running so notifications keep
coming. Use the tray icon's Quit to stop it.

## Updates

The app does not use Tauri's own updater. When it starts, and every 6 hours, it asks GitHub for
the latest release and looks for `support-technician-<version>-setup.note` and `.note.sig`. A
release without them, or with a version that is not newer, is no update. The note is five lines
that the project's release key signed (`scripts/sign-release.mjs --product technician`); the app
checks the ECDSA P-256 signature against the public key built into it (`release-key.pub`), then
the note's header, version, size and SHA-256. It downloads
`support-technician-<version>-setup.exe`, checks its size and SHA-256 against the signed note,
and keeps the file. At the next start it checks the signature and the file again, runs the
installer silently (`/S /R /UPDATE`) and exits so the installer can replace the app. An installer that
keeps failing is not run more than twice. A PC's update note (`support-mcp-release 1`) is not a
technician note: the headers differ and the signature covers the header.

## SmartScreen

The installer is not signed with a code-signing certificate (the project's release key signs the
update note, not the installer). Windows SmartScreen may say "Windows protected your PC": press
**More info**, then **Run anyway**. Updates the app installs itself are run by the app and do not
carry the download mark that triggers SmartScreen.

## Free-plan limits

On Cloudflare's free plan the relay allows 100,000 Worker requests and 100,000 KV reads a day. The
app's calls cost mostly Worker requests: the feed is about 3,500 requests a day for one person
who keeps the app open, the device list is one request every 15 seconds while the Devices screen
is on screen, and an open session tab you are driving costs about 1,800 requests an hour (a
screenshot every 3 seconds, a status every 10 seconds, a task check every 15). Watching a task
costs far less. The relay remembers a checked sign-in for 60 seconds, so the app's calls use
about one KV read a minute. Close session tabs you are not using. Workers Paid lifts the limits.

## Security

- The screens can call only the commands listed in `technician-app/src-tauri/src/command_list.rs`.
  The capability file grants those and event listening, and nothing else: no shell, no file
  system, no HTTP, no plugin commands. A test holds the list, the handler and the capability to one
  another. The content security policy is `default-src 'self'; img-src 'self' data:; connect-src
  ipc: http://ipc.localhost` and the web view cannot navigate away from the app's own screens or
  open another window.
- Every relay call is made by the Rust core, which sends no `Origin` header (the relay refuses
  one). The screens reach only the routes and MCP tools the app uses (`relay.rs`), none of which
  clicks, types or runs a command.
- The app holds no secret: it is a public OAuth client, and the relay checks PKCE on every
  sign-in.
- Fonts (Barlow Condensed, Atkinson Hyperlegible Next and Mono) are bundled, with their SIL Open
  Font License texts in `technician-app/src/fonts/` and in the installer under `licenses/`.

## Build and release

```sh
cd technician-app
npm ci --ignore-scripts
npm test                      # the screens
npm run build                 # the screens into dist/
cd src-tauri
cargo test                    # the Rust core
cd .. && npx tauri build      # the NSIS installer, on Windows
```

`cargo test` runs on Linux and macOS as well (the Windows-only code, DPAPI and the silent installer,
sits behind `cfg(windows)` and a trait). `SUPPORT_DEFAULT_RELAY` (the relay address the sign-in form
starts with) is read at compile time. `SUPPORT_RELEASE_REPO` (the GitHub repository to check,
`SUKARDADDY/Support-MCP` by default) and `SUPPORT_RELEASE_KEY` (a throwaway public key, so a test
release can be signed without the real one) are read only by a build with the `test-release` cargo
feature. Without that feature, building with either one set fails with a compile error, so the
installer that ships cannot carry them; the CI job also checks both are unset. The `e2e` cargo feature makes sign-in write its address to the file named by
`SUPPORT_E2E_AUTHORIZE_FILE` instead of opening a browser; it is never part of a release.

On Windows with the MSVC linker, `build.rs` embeds `src-tauri/windows-app-manifest.xml` (Common
Controls version 6) into every executable the package links: the app, the library's unit tests and
`tests/real_relay.rs`. Tauri's windowing code imports `TaskDialogIndirect`, which only version 6
has, so a test executable without the manifest fails to start with `0xc0000139`
(`STATUS_ENTRYPOINT_NOT_FOUND`). Tauri's own copy of the manifest is switched off so each file
carries one.

To release: bump the version with `scripts/bump-version.mjs` (it covers the app's `package.json`,
both entries of its `package-lock.json`, the `[package]` version in `src-tauri/Cargo.toml` and the
app's entry in `Cargo.lock`), build the installer in CI, then sign it:

```sh
wl-paste | node scripts/sign-release.mjs --product technician \
  --file Support_<version>_x64-setup.exe --out release-files
```

and attach `support-technician-<version>-setup.exe`, `.note` and `.note.sig` to the GitHub
release. The key goes in on stdin and is never written to disk, as for the PC app.

## How it is tested

- `cargo test` (in `technician-app/src-tauri`): the relay client's handling of 401, 503 and
  `invalid_grant`, the OAuth flow against a fake relay (registration, PKCE, the loopback
  listener), the sealed token store, the feed loop, the lock-down (commands, capability, CSP,
  navigation), and the update check with good and bad notes, wrong keys, sizes and hashes.
- `npm test` (in `technician-app`): the screens against a stand-in for the core that answers as the
  relay does.
- `node e2e/core-check.mjs` runs the real core against a real relay (`wrangler dev`) on any system:
  sign-in through the actual pages, API and tool calls, the feed, approval and token refresh. The
  relay runs from a folder of its own under the system's temp folder (its config, `.dev.vars` and
  database), removed at the end; the repository's `.wrangler/state` and `.dev.vars` are never read
  or changed.
- The `technician-app` CI job runs all of that on Windows, builds the installer, installs an
  end-to-end build silently and drives it: Playwright opens the sign-in address the app writes,
  walks the pages, then attaches to the app's WebView2 through a debug port (opened by a
  machine policy, because the runner is elevated) and checks that the device list shows the
  seeded PC, that a pairing code appears, and that a PC asking to join reaches the notification list.
