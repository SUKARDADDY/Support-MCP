# Development

## Build the app

`src/app-bundle.json` is the compiled app. It is built from `src/agent-app.cs`
and `src/agent-app.manifest` on a Windows machine with the .NET Framework 4
compiler (`csc.exe` v4.0.30319). The app needs .NET Framework 4.5.2 or later and
TLS 1.2 at run time. Windows 10 and 11 include both. Windows 8.1 ships .NET 4.5.1
and needs the 4.5.2 update. Windows 7 ships only .NET 3.5.1, so a Windows 7 PC
needs .NET Framework 4.5.2 or later installed before the app will run.

The build compiles against the .NET Framework 4.5.2 reference assemblies, not the
newer framework on the build PC. Without them the compiler can pick a method that
4.5.2 lacks. That happened once: `String.Format` with a provider and three
arguments is new in .NET 4.6, and the app crashed with `MissingMethodException`
on a PC with 4.5.2. `scripts\fetch-net452-refs.ps1` downloads the NuGet package
`Microsoft.NETFramework.ReferenceAssemblies.net452` at a pinned version from
nuget.org, checks it against the SHA-512 pinned in the script, extracts it, and
prints the folder (`build\.NETFramework\v4.5.2` inside the package) to pass as
`-ReferenceDir`. CI uses the same script.

```powershell
$refs = powershell.exe -NoProfile -File scripts\fetch-net452-refs.ps1 -Destination C:\refs\net452
powershell.exe -NoProfile -File scripts\build-app.ps1 -ReferenceDir $refs
```

The script targets x86, references the 4.5.2 assemblies, embeds the `asInvoker`
manifest, compiles with warnings as errors, and writes the executable (base64),
`reference_framework: "net452"` and the SHA-256 of the source and manifest into
the bundle. `-ReferenceDir` is required, so no build can skip the references.
It always compiles
to the file name `support-mcp-app.exe`, because the compiler embeds that name in
the exe. Run it with `-OutDir <folder>` to write only the exe into that folder
and leave `src/app-bundle.json` untouched.

### Keep the build reproducible

The v4 compiler (`csc.exe` 4.8.9221.0) adds a helper class for two kinds of
source, and it names that class with a new GUID on every build. The GUID changes
the metadata and the type name, so the normalized exe differs from run to run
and the CI check fails even though the source is the same. Avoid both:

- A constant primitive array initializer of three or more elements, such as
  `new int[] { 1, 2, 3 }` or `new byte[] { 0x4D, 0x5A, 0x90 }`. The compiler
  copies the data from a `<PrivateImplementationDetails>{GUID}` class. Build
  the array in a loop or from a string, or use a list. An array of non-constant
  values, an array of strings, and an initializer of one or two elements are
  fine.
- A `switch` on a string with more than six cases. The compiler computes a hash
  of the string with a helper class named the same way. Use if-else, a
  dictionary or a loop. `switch` on an int or an enum is fine.

`src/agent-app.cs` already follows both rules, and says so in a comment where
it matters (`JpegFit.Encode`, `Screen.UiAct`, `Screen.Input`). Test code in
`test/app-native.cs` is not part of the shipped exe, so it may use both. If a
rebuild of the same source gives a different `exe_b64` and
`scripts/verify-app-binary.mjs` fails, look for one of the two first: build
twice and compare the type names in the metadata.

### What CI proves about the committed exe

`node --test` fails when the source or manifest hash in the bundle no longer
matches the files, so it catches a source change that was committed without a
rebuild. It cannot tell whether `exe_b64` was compiled from that source. The
`windows-app` job in `.github/workflows/test.yml` checks that, on every push and
pull request, on a GitHub-hosted `windows-latest` runner:

1. It fetches the .NET Framework 4.5.2 reference assemblies with
   `scripts/fetch-net452-refs.ps1`. The script fails unless the downloaded
   package matches the SHA-512 committed in the script.
2. It builds the app from the committed source with `scripts/build-app.ps1`
   against those references.
3. It compiles and runs `test/app-native.cs` against the same references, and
   fails on any failed check.
4. It runs `scripts/verify-app-binary.mjs`, which normalizes the fresh exe and
   the committed exe and fails unless they are byte for byte identical.
5. It uploads the fresh exe as the `support-app` workflow artifact.

The .NET Framework v4 compiler is not reproducible: two builds of the same source
differ only in the COFF header timestamp (4 bytes) and the 16-byte module
version id (MVID) in the metadata.
The compiler leaves the optional-header checksum at 0 and writes no debug
directory. `scripts/normalize-pe.mjs` parses the PE headers, the CLR header and
the metadata tables, then zeroes the timestamp, the checksum and the MVID that
the Module table points at. It does not use fixed offsets. After that, two
builds of one source are identical, and a one-character source change alters
thousands of bytes. `test/normalize-pe.test.js` checks this against the
committed exe, including that a change to any other byte changes the result.

Line endings count as build input, because the compiler embeds the manifest
bytes. `.gitattributes` keeps every file on LF so a Windows checkout builds the
same bytes as a Linux one.

What this proves: the committed exe is the output of the committed source and
manifest, built with the .NET Framework 4.8 compiler (`csc.exe` 4.8.9221.0) on
the runner. What it does not prove:

- It trusts the runner's compiler and the framework assemblies. A different
  compiler version can change the output and fail the check. If that happens,
  rebuild the bundle with the same compiler version as CI and commit it.
- It does not prove the source is safe. Review `src/agent-app.cs`.
- It ignores 24 bytes: the timestamp, the checksum and the MVID. They hold no
  code, but a check that skips bytes is only as good as its rule, so read
  `scripts/normalize-pe.mjs`.
- The exe in a download carries the session configuration appended to the end
  (`SUPPORTMCPCFG1`). That tail is added at download time and is not part of the
  check.

When you change `src/agent-app.cs` or `src/agent-app.manifest`, rebuild the
bundle on a Windows PC with the v4 compiler and commit it with the source.
Use the references from `scripts\fetch-net452-refs.ps1`, as above: a bundle built
without them has the same source hash but a different exe, and the job fails:

```powershell
$refs = powershell.exe -NoProfile -File scripts\fetch-net452-refs.ps1 -Destination C:\refs\net452
powershell.exe -NoProfile -File scripts\build-app.ps1 -ReferenceDir $refs
```

If the `windows-app` job fails on the exe check, it prints both normalized
hashes. Rebuild the bundle, push, and the job passes when the hashes agree.
To check a bundle yourself, build with `-ReferenceDir` and `-OutDir` and run
`node scripts/verify-app-binary.mjs <folder>\support-mcp-app.exe`.

The native tests compile `test/app-native.cs` together with `src/agent-app.cs`
on Windows, using the same references plus `/main:AppTests /target:exe`, and run
the result. They start the real client against a fake relay and exercise HTTP
operations, Unicode, chunking, retry deduplication, process-tree cancellation,
the second a program the command did not wait for gets to finish, timeout,
local expiry and the reconnect rules. They need a Windows desktop
session, so they are not part of `node --test`; CI runs them in the `windows-app`
job. Besides the client, they cover the pure parts of screen control: coordinate
scaling, key parsing, the customer pause (hooks and the `GetLastInputInfo`
cross-check), the cap on `ui_tree` text and on the display count, the choice
of display for `ui_tree`, the stop and pause checks of typing, the corner window's `WS_EX_NOACTIVATE` and `WS_EX_APPWINDOW` styles, the focus that Keep connected gives back (the choice of window, and a real confirm and Keep on a window of this process), the replacement of
a result the relay refuses, `as` in normal mode and the screen consent of a
prepared reconnect. For full control they cover the parts that need no
administrator: the consent path (UAC prompt, the app's own confirm, or
unavailable), the full-control question that stays open as the owner of the UAC
prompt (modeless, with the corner window still enabled, and Allow dead for its
first 500 ms), the named event that lets the elevated installer go ahead, the folder and file ACLs (a real folder, read back with `icacls`),
the exclusive creation of the folder and the parent it goes in, the deadline
state on disk and its expiry rules, the shared `SoftwareSASGeneration` record (in
C# and in the backstop's PowerShell, and that neither changes it without the
mutex), the staging copy and the held exe of the
elevated installer, the refusal of junctions and hard links by SYSTEM file
operations, identification-only pipe clients, the 5-second pipe timeout, the
window's unconfirmed end, the backstop command line and
task XML, the token choice for `run`, the `block_input` timer and its
Ctrl+Alt+Del escape, the pipe framing and the corner window's two requests over
a real pipe, the cut of `window.exe`, the silent handover after
`request_full_control`, and the Client's full-control path against a fake
service (`as: "user"` runs with a copy of the test's own token). `scripts/test-app-native.ps1` also takes `-ReferenceDir`, so the tests are
compiled against the 4.5.2 references and the compile fails if the app or the
tests call a method 4.5.2 lacks. They still run on the build PC's framework, so
they cannot catch a method that is missing at run time on 4.5.2 by themselves;
the reference assembly build does that. The first connection from a real
Windows 7 PC was checked live (see [Limits](../README.md#limits)).

The saved PC roles (the setup wizard, `--device-install`, `--device-service`,
`--tray`, `--uninstall` and `--device-remove`) are built in `src/agent-app.cs`
beside the one-off roles and share its helpers (`Elevation`, `FullAcl`, `Pipes`,
`Scm`, `UiServer`). The native tests cover the parts that need no administrator
and no second user: the device footer reader and its refusals (`ReadConfig` throws
on any footer with a `kind`, `ReadDevice` refuses a session footer), the answers
argument (encode, decode, limits), the exit codes, `DeviceLink` against a fake
`/device/` relay for every status, the check-in timing and backoff, the state a
check-in leads to (active, pending to active, removed, expired, needs an update,
offline), the 50-line history cap, the registry value builders, the folder, file
and pipe ACLs, the one-way rule (no pipe frame sets `ask`), and the tray's state
text. They also drive the real service against the fake `/device/` relay with a
temp folder: a 200 with no `device` object counts as offline and never ends the
worker, a team mode change applies and is a history line, `allow_any_time` is
answered at once and sends `any` (never `ask`) in the background, and `removed`
and `expired` are saved in `device.json` and served from the pipe after a reload
without a fresh check-in. Uninstall is covered too: what it removes (only our own
artifacts, never `HKLM\SOFTWARE\SupportMCP`), the rename-aside removal of a
locked folder (so a reinstall at the original path is not blocked), the setup
mutex that lets one install or remove run at a time, and a waiter seeing the
`Global` uninstall event once it is set. The relay side is covered by
`npm test`: `test/app.test.js` has the `/install` page, the same-origin matrix,
the refusals and the footer bytes, and `test/devices.test.js`,
`test/devices-api.test.js` and `test/device-api.test.js` have the pairing `link`
and the owner contact. The last native check must stay "PASS executable session
overlay".

The service, the helper and the install need administrator rights and a real
console session, so the native tests do not run them. Check them by hand on a
Windows 11 PC or VM with UAC on, against `wrangler dev` (see below; raise
`SESSION_TTL_MS` in `.dev.vars` so a session lasts long enough). The app accepts
`http://127.0.0.1` as its relay, so in a VM forward the port with `netsh interface
portproxy add v4tov4 listenaddress=127.0.0.1 listenport=8787
connectaddress=<host> connectport=8787`. Then check, with screenshots through the
relay: started from Explorer, from Edge's download and with another window in front, a click on Allow brings the UAC prompt up on the secure desktop, not as a taskbar button, and so does `request_full_control` after a decline and the one-minute wait; UAC Yes gives `control: full`; with Notepad focused before the app starts, `type_text` right after the attach goes to Notepad; with the corner window deliberately in front, `type_text` is refused with `the support window has the keyboard focus`; End session then Keep connected returns the focus to Notepad; the corner window has a taskbar button, and Win+T then Alt+F4 asks "End the session?" and can be answered from the keyboard; clicking Tuck or Expand leaves the foreground window unchanged; a `click` on the corner window is refused; a UAC prompt in the user's session shows
`desktop: secure` and can be clicked; the lock screen can be unlocked with
`type_secret`; after a restart the session comes back within its deadline and the
sign-in screen is reachable; `block_input` blocks the physical keyboard and
Ctrl+Alt+Del lifts it; `send_sas` shows the Ctrl+Alt+Del screen; `run` as `user`
and as `system` report the right identity; UAC No gives the fallback dialog and
normal mode; `request_full_control` upgrades a normal session. After
`session_end`, an expiry, and a service killed with `taskkill /f` (the backstop
task cleans up at the deadline), `sc query SupportMcp-<id>`, `schtasks /query /tn
SupportMcp-<id>-<random>` (or `schtasks /query /fo csv` for any
`SupportMcp-<id>-` task), `Test-Path "C:\Program Files\SupportMCP-<id>"`, `reg query
HKLM\SOFTWARE\SupportMCP` and `reg query
HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System /v
SoftwareSASGeneration` must all find nothing (unless that value existed before).

Typing into other programs is not in the native tests, because the target has
to be another process. When you change `Screen.TypeText`, check it by hand on
Windows 11: type `abc def 123`, `The quick brown fox 12345`, `split shape` and
`Hello world, שלום עולם! 123` into Notepad, a WinForms `TextBox` and a text
field in Edge, and read each field back with UI Automation (use `ValuePattern`;
Chromium's `TextPattern` returns right-to-left text in visual order). Run it
with the system timer at 1 ms as well, for example while a browser or an
animated WPF window is open. The reason is in the comment above `TypeText`:
Windows 11 Notepad reads the character of a Unicode key event late, so events
sent less than about 10 ms apart replace one another. The code waits 20 ms
between characters and the relay budgets 35 ms for each (the app measures about 21 ms; Windows 11 can ignore its 1 ms timer request for a minimized window, which costs about 31 ms).

An operator can prepare one automatic reconnect after a restart the customer
authorized. `scripts/prepare-app-restart.ps1` runs inside the live session on
the customer's PC, combines the tested app payload with the existing downloaded
configuration (the attach key never leaves the PC), and asks the customer to
approve one reconnect with the same rights at the next sign-in. The prompt
also records that the customer saw the screen control text, and a reconnect
without that record starts with commands and files only. The reconnect
cannot extend the session's original 24-hour deadline, and End session or the
operator ending the session cancels it.

## Versions and releases

The project has one release version, written as `MAJOR.MINOR.PATCH`
([SemVer](https://semver.org)). The relay (`/healthz` and the MCP `serverInfo`),
the Windows app (its hello and the exe's file version) and the PowerShell agent
(its hello) all carry it. The version stays at `0.x` until Stage 1 is safe to run
on unattended customer PCs. Each roadmap feature PR raises the minor number, and
a fix raises the patch number. `CHANGELOG.md` lists what each version contains.

Two strings look alike and mean different things. The hello's `agent` field
(`windows-app-2`, `1`) names the wire protocol generation. The relay stores and
reports it, and an app changes it only when the protocol changes. The
hello's `version` field is the release. `session_status` reports the release as
`client_version` when the client sent one, and the `agent` string as
`client_agent`.

To cut a release:

1. Run `node scripts/bump-version.mjs 0.3.0`. It rewrites `package.json`,
   `package-lock.json`, `src/version.js`, `src/agent.ps1` and `src/agent-app.cs`,
   and refuses to write anything when a pattern does not match exactly once.
2. Rebuild `src/app-bundle.json` on Windows, as in
   [Build the app](#build-the-app). The version is part of the app source, so the
   bundle hash test fails until you do.
3. Add the `## [0.3.0]` entry to `CHANGELOG.md`.
4. Open the PR. `test/version.test.js` fails when any copy of the version differs
   from `package.json`.

After the PR merges, tag the merge commit `v0.3.0` and create a GitHub release
from the CHANGELOG entry. Then sign the release and deploy it, as below.

### Sign and deploy a release

Saved PCs update themselves only to a release signed with the project's release
key ([Updates](relay-v1-spec.md#updates)). The private key is a secure note,
"Support MCP release key", in the maintainers' Bitwarden organisation vault. It is
never written to disk: not on your computer, not in Cloudflare, not in CI. You sign at deploy time, because the stages (10% of PCs
for a day, then half for a day, then all) count from the signing time; a
release signed long before its deploy would skip them.

1. Make sure `src/app-bundle.json` is the bundle built from the merged source
   (CI's `verify-app-binary` passed on the PR).
2. Sign. Open the note in the Bitwarden web vault, click **Copy notes**, and
   pipe the clipboard straight into the signer, then clear the clipboard:

   ```sh
   wl-paste | node scripts/sign-release.mjs --out release-files   # pbpaste on macOS
   wl-copy --clear
   ```

   With the Bitwarden CLI signed in and unlocked, `bw get notes "Support MCP
   release key" | node scripts/sign-release.mjs --out release-files` does the
   same. Either way the key goes from pipe to pipe and is never on a command line
   or on disk.

   `scripts/sign-release.mjs` reads the key from stdin only. It checks that the
   bundle was built from `src/agent-app.cs` and carries `VERSION`, builds the
   release note from the exe's SHA-256 and size and the current time, signs it,
   and checks the signature against `release-key.pub`. A key that does not match
   signs nothing. It prints `RELEASE_SIGNATURE=...`, `RELEASE_SIGNED_AT=...` and
   the note, and `--out` writes the exe, the note and the signature
   (`support-mcp-<version>.exe`, `.note` and `.note.sig`) into that folder.
3. Deploy right away with the two settings, so the relay offers the release:

   ```sh
   npx wrangler deploy --tag vX.Y.Z --message "<one-line summary>" \
     --var RELEASE_SIGNATURE:<signature> --var RELEASE_SIGNED_AT:<seconds>
   ```

   (add `--config` if you deploy from a separate config file) so the version
   list in the Cloudflare dashboard shows which release each deployment is.
   Without the two settings the relay offers no update, and nothing else
   changes. A later deploy of the same bundle and version can pass the same two
   values again; any rebuild or new version needs a new signature.
4. Attach the three files from `release-files` to the GitHub release, so anyone
   can check a PC's app against the signed note.

`UPDATE_ROLLOUT` controls who is offered the release: empty follows the stages,
`pause` (or `0`) offers nothing at once, also in the 426 answer, and a whole
number 0 to 100 pins that share of PCs. Set it with `--var
UPDATE_ROLLOUT:pause` on a deploy. A prerelease version (`0.6.0-rc.1`) is offered
only when `UPDATE_ROLLOUT` pins a number. A PC that waits for approval is never
offered one. Each PC reports its version at every check-in, so the team's device
list shows how far a release has gone.

The release key was made once with `scripts/release-key.mjs`, which creates the
key in memory, writes the private key (a PEM block) to stdout for your secrets
manager, and writes only the public key (64 bytes `X||Y`, base64) to the file you
name. It refuses to print the key to a terminal, so pipe it to the clipboard:

```sh
node scripts/release-key.mjs release-key.pub | pbcopy   # macOS; clip on Windows, wl-copy on Linux
```

Paste it, from `-----BEGIN` to `-----END ... -----` inclusive, into the Notes of
a new secure note in the Bitwarden web vault, owned by the organisation, then
clear the clipboard (and any clipboard history). Do not pass it to a command such
as `bw create`: that puts the key on a command line, where other processes and the
shell history can see it. Any other way of storing it works if it never puts the
key on a command line or on disk.

The same public key is the constant `ReleaseKey.ProjectKey` in
`src/agent-app.cs`; `test/release.test.js` fails when the two differ. To move to a
new key, ship a release signed by the old key that carries the new public key;
PCs that never got it need a reinstall.

If you host your own relay with a tagged release's `src/app-bundle.json`
unchanged, you can deploy with the signature and the `released` time from that
GitHub release's `.note` and `.note.sig`: the relay rebuilds the same note from
the same bundle. If you build your own app, make your own key the same way, put
its public key in `release-key.pub` and in `ReleaseKey.ProjectKey`, rebuild the
app, and sign with your key. A relay that serves a bundle the project key did
not sign offers PCs nothing they will take.

## Develop and test

```sh
npm ci --ignore-scripts              # once: the OAuth library is the one dependency
npm test                             # unit and route tests, no network
npx wrangler deploy --dry-run --outdir /tmp/support-mcp-dry
npx wrangler d1 migrations apply support-mcp --local   # the team tables, once
cp .dev.vars.example .dev.vars && npx wrangler dev --port 8787
```

`npm test` is `node --import ./test/stubs/register.mjs --test`. The OAuth library
imports `cloudflare:workers`, which only the Workers runtime has, so
`test/stubs/register.mjs` installs a resolve hook that maps it to
`test/stubs/cloudflare-workers.mjs`, an empty `WorkerEntrypoint` plus the global
that turns on client metadata documents. The library is imported only by
`src/index.js` and handed to `createHandler`, so `src/app.js` and every test
that does not need OAuth load without the hook. `test/oauth.test.js` needs it:
under a bare `node --test` its tests skip with a message, and CI runs `npm ci --ignore-scripts`
then `npm test`, so there they all run. (`node --test` also runs the helper files
under `test/` as one empty test each, so the totals include them.)

`.dev.vars` skips Access and shortens the session TTL, but only when the
request host is `localhost` or `127.0.0.1`. The deployed hostname can never
satisfy that check. Keep `wrangler dev` on loopback, its default: the bypass
trusts the `Host` header, so anyone who can reach a dev server on another
interface could send `Host: localhost` and skip Access.

`wrangler dev` presents the custom-domain route's hostname to the Worker, so to
exercise `/mcp`, `/j` or `/ws` locally, run it against a copy of the config
with the `routes` line removed. Over plain http the relay serves only
`localhost` and `127.0.0.1`.

### Teams locally

`wrangler dev` gives the Worker a local D1 database for the `DB` binding. Apply
the migrations to it once with
`npx wrangler d1 migrations apply support-mcp --local`, and again after any
change to `migrations/`. Without the tables, every MCP tool call fails with a
D1 error and the team API answers 500.

Under the local bypass every caller is the identity `local-dev`, for `/mcp` and
the team API alike. A new local database has no members, so every tool works.
To try roles, add `local-dev` as the first admin:

```sh
curl -s localhost:8787/api/v1/w/default/members -H 'content-type: application/json' \
  -d '{"identity":"local-dev","role_id":"admin"}'
```

Because every local request is `local-dev`, you can't sign in as a second
member. To see a refusal, change `local-dev`'s role instead: add a second admin
(any identity), then demote `local-dev` to `viewer` with
`PATCH /api/v1/w/default/members/local-dev` and `{"role_id":"viewer"}`. A `run`
over MCP then returns `your role does not allow sessions.control`. The download
page at `/j/<code>?client=app` loads whatever the roles, because it never
checks them. To start over, delete `.wrangler/state` and apply the migrations
again.

To try a second workspace, set `DEPLOYMENT_ADMINS=local-dev` in `.dev.vars`,
create it with `POST /api/v1/w` and `{"slug":"acme","name":"Acme"}`, and point
the MCP client at `/w/acme/mcp`. `local-dev` is its admin.

### Pairing a PC locally

Saved PCs need `AUTH_SECRET` in `.dev.vars` (at least 32 characters, as for
sign-in) and the migrations applied. With `local-dev` as the first admin
(above), play the PC with `curl`. The `/device/` addresses take no Access login
and work over plain http on loopback. Every body carries `"protocol": 1`.

```sh
api=localhost:8787/api/v1/w/default
# A technician asks for a code. It is shown in this answer only.
curl -s $api/pairing -H 'content-type: application/json' -d '{}'
# {"pairing":{"id":"...","code":"ABCDE-FGH23","expires_at":...,"site_id":null}}

# The PC pairs with the code and keeps the key it gets back.
curl -s localhost:8787/device/pair -H 'content-type: application/json' \
  -d '{"protocol":1,"code":"ABCDE-FGH23","name":"Front desk","access":"ask","control":"full"}'
# {"protocol":1,"status":"active","workspace":"default","device_id":"...","key":"smd1.default.<id>.<secret>"}

key='smd1.default.<id>.<secret>'
curl -s localhost:8787/device/hello -H 'content-type: application/json' \
  -H "authorization: Bearer $key" -d '{"protocol":1,"os":"Windows 10","machine":"POS-1","app_version":"0.3.0"}'
curl -s $api/devices                                            # the saved PC, without any hash
curl -s localhost:8787/device/leave -H 'content-type: application/json' \
  -H "authorization: Bearer $key" -d '{"protocol":1}'           # the key now answers 401
```

For an install the owner starts, send `"workspace":"default"` instead of `code`.
The answer is 202 with a `confirm` number and a key. A technician approves it
with `PATCH $api/devices/<device_id>` and `{"approve":{"confirm":"482913"}}`.
`GET $api/audit?verify=full` shows every step in the team log.

`test/workspace.test.js`, `test/api.test.js`, `test/devices.test.js`,
`test/devices-api.test.js` and `test/device-api.test.js` run the team code on a D1
stand-in built on `node:sqlite` (`test/d1-fake.js`), with every file in
`migrations/` applied in name order.
It yields before every statement like a network round trip, and its `batch()`
is one transaction, so the concurrency tests race the way Workers do.
`node:sqlite` prints an ExperimentalWarning on Node 22; that is expected.

The route tests import the real router. Most give it Durable Object bindings
that throw if touched. That proves the Access gate, the `Origin` check, the
method checks, the https check and the link-preview check all run before any
session state is read. The few `/j` tests that must reach a session use a stub
binding that records every call.

`test/app.test.js` covers the app: the bundle's hashes, the download flow and
its security headers, the polling transport, and the default mode and aliases.

### Connecting to a saved PC locally

With a paired PC (above) whose `app_version` is 0.6.0 or later, `device_connect`
starts a session and `GET /device/hello` shows it as `session`. Play the PC with
`curl`. An authenticated MCP client (not the bare local bypass, which is one
identity) is easiest for the tools; the team API calls below need no client.

```sh
# The check-in answer carries the session once a technician has connected.
curl -s localhost:8787/device/hello -H 'content-type: application/json' \
  -H "authorization: Bearer $key" -d '{"protocol":1,"app_version":"0.6.0"}'
# {"protocol":1,"device":{...},"session":{"id":"<64 hex>","by":"...","team":"Default","ask":true,"expires_at":...}}

# The PC joins its session with its own key: no X-Attach-Key.
curl -s "localhost:8787/agent?sid=<id>" -H 'content-type: application/json' \
  -H "authorization: Bearer $key" -d '{"type":"hello","machine":"POS-1","control":"full","caps":["lanes","screen"]}'
# or say no: {"type":"decline","reason":"declined"}

# Stop a workspace (ends its sessions), and resume it.
curl -s -X POST   $api/stop -H 'content-type: application/json' -d '{}'
curl -s -X DELETE $api/stop -H 'content-type: application/json' -d '{}'
```

The doorbell is a WebSocket: `wscat -c "ws://localhost:8787/device/ring?protocol=1"
-H "authorization: Bearer $key"` stays quiet until a `device_connect`, a team
change to the PC's access, or a stop, then prints `{"type":"ring"}`. `device_list`
shows `online: true` while it is open. `EMERGENCY_STOP` is a variable like any other
in `.dev.vars`: set it to `1` and restart `wrangler dev` to see every tool call
refused and every live session end on its next request.

`test/device-sessions-world.js` builds a whole relay for the tests of these
paths: the real router, the real `Session` and `Registry` classes behind small
Durable Object stand-ins, the D1 stand-in and Access logins signed by a local key.
`test/device-connect.test.js`, `test/device-session-wire.test.js`,
`test/doorbell.test.js` and `test/stop.test.js` use it. Time moves only when a test
moves it. The one thing Node cannot do is a WebSocket upgrade, so the doorbell
tests give the Worker a recording Registry and test the Registry's own sockets
directly.

### Installing a saved PC on a test machine

The native tests do not install the service, so check a saved PC by hand on a
Windows test machine, ideally a Windows 11 VM with UAC on, and also on Windows 7
if you support it. You need a relay the machine can reach, with a database and a
team admin.

1. On your computer, set up the relay as in [Pairing a PC locally](#pairing-a-pc-locally):
   apply the migrations to the local D1 database, put `AUTH_SECRET` (at least 32
   characters) in `.dev.vars`, and run `npx wrangler dev --port 8787` on loopback.
   Make `local-dev` the first admin of `default`. `/install` answers 404 until
   `src/app-bundle.json` holds an app, so rebuild the bundle first if you changed
   the app (see [Build the app](#build-the-app)).
2. Let the test machine reach the relay at `127.0.0.1:8787`. The app accepts
   plain http only on loopback, so in the VM forward the port with `netsh
   interface portproxy add v4tov4 listenaddress=127.0.0.1 listenport=8787
   connectaddress=<host> connectport=8787`, as for a session.
3. Ask for a pairing code from your computer with the address the VM will use, so
   the `link` in the answer is right for it:
   `curl -s 127.0.0.1:8787/api/v1/w/default/pairing -H 'content-type: application/json' -d '{}'`.
   The answer carries `code` and `link`. For the owner-started path, use
   `http://127.0.0.1:8787/install?workspace=default` instead.
4. In the VM's browser, open the link. The page must download nothing until you
   click the button. Download, open `support-setup.exe`, and step through the
   wizard. Check that nothing is preselected for access or control, answer the
   Windows permission prompt, and wait for "ready". For the owner-started path,
   the wizard shows six digits. Approve with `PATCH .../devices/<id>` and
   `{"approve":{"confirm":"<digits>"}}`.
5. Check the install. `sc query SupportMcpDevice` shows RUNNING, the tray icon is
   in the notification area (Windows 11 puts new icons in the overflow),
   `GET .../devices` lists the PC with its name, access and control, and a standard
   user cannot read `device.json` in `%ProgramFiles%\SupportMCP`.
6. Check the one-way rule. As a standard user, turn on "any time" from the tray.
   The tray then offers no way back. A technician's `PATCH .../devices/<id>` with
   `{"access":"ask"}` puts the PC back to asking, and the tray shows it after the
   next check-in. Set an owner contact with `{"owner_contact":"..."}`, and send
   `owner_contact` to `/device/update` with the PC's key to see the 400.
7. Uninstall from Settings > Apps, and again from the tray. Then run the leftover
   checklist below.

Leftover checklist after an uninstall. Each of these must find nothing, and the
last must be unchanged from before you installed:

- the service: `sc query SupportMcpDevice` says the service does not exist
- the folder: `Test-Path "$env:ProgramFiles\SupportMCP"` is False (if a file was
  locked, restart the machine and check again)
- the tray's startup value: `reg query HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Run /v SupportMcpTray /reg:64`
  finds nothing
- the Apps entry: `reg query HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\SupportMcpDevice /reg:64`
  finds nothing
- the pipe: `[IO.Directory]::GetFiles('\\.\pipe\') | Select-String SupportMcpDevice`
  finds nothing
- `reg query HKLM\SOFTWARE\SupportMCP` is untouched. It belongs to one-off
  sessions. Compare its output before the install and after the uninstall.

Also check that `GET .../devices` no longer lists the PC and that its old key
answers 401 on `/device/hello`. Stop the relay and uninstall once more on a new
install: everything must still go from the PC, and the last window must say the
team will still see the PC until they remove it. Finally, start a one-off
full-control session on a paired PC and check both work and clean up
independently.

### OAuth locally

`test/oauth.test.js` drives the real router and the real library with an
in-memory KV (`test/kv-fake.js`: get as text or json, put with `expirationTtl`
and metadata, delete, list with prefix and cursor, a 60 second TTL floor like the
real one, and read and write counters) on top of the D1 stand-in. A scripted
client registers, a cookie-jar browser signs in and consents, and the tokens are
used on the MCP addresses. Tests move the clock by replacing `Date.now`, which the
library, the KV fake and the D1 fake all read. Access logins are signed with a
local key, as in `test/api.test.js`.

To try it with a real client under `wrangler dev`, follow [Sign-in
locally](#sign-in-locally) and leave `DEV_SKIP_ACCESS` unset: with it set every
local caller is accepted without a token and no client is asked to sign in.
`wrangler dev` simulates the `OAUTH_KV` binding locally, so no namespace id is
needed. Then `claude mcp add --transport http local-support
http://localhost:8787/mcp` and run `/mcp` in Claude Code. Details are in
[mcp-clients.md](mcp-clients.md#try-it-locally).

### Sign-in locally

Sign-in works on `localhost` and `127.0.0.1` without a public address or any
provider. In `.dev.vars` (copy `.dev.vars.example`) keep `AUTH_SECRET` and
`DEV_SHOW_EMAIL_LINKS=1`. The second is honoured only for those hosts, and
shows an emailed link on the page instead of sending it. Leave `PUBLIC_ORIGIN`
empty: on loopback the relay uses the address the request came to. As for `/mcp`
above, run `wrangler dev` against a copy of the config with the `routes` line
removed, or the Worker sees the route's hostname instead of `localhost`. Cookies on
plain http are named `smcp`, `smcp-oidc`, `smcp-bind` and `smcp-pre` and are not
`Secure`, because browsers may refuse to store a `Secure` cookie for http.

1. Apply the migrations to the local database (they include sign-in's):
   `npx wrangler d1 migrations apply support-mcp --local`.
2. Invite yourself by adding a member straight into the local database. Only
   a member or a `DEPLOYMENT_ADMINS` identity can sign in.
   ```sh
   npx wrangler d1 execute support-mcp --local --command \
     "INSERT INTO members(workspace, identity, kind, name, role_id, added_at, added_by) VALUES ('default', 'you@example.com', 'person', NULL, 'admin', 0, 'dev')"
   ```
   Or put `DEPLOYMENT_ADMINS=you@example.com` in `.dev.vars`.
3. Run `npx wrangler dev --port 8787`, open `http://localhost:8787/auth/signin`,
   enter the address, and open the link that appears. Press **Sign in**.
4. On the account page choose **Set up your authenticator**. Type the key into
   an authenticator app (or compute a code with `src/totp.js`), enter the
   code, and save the recovery codes. The next sign-in asks for a code.

Google and Microsoft sign-in need real client IDs and a redirect address on
`localhost`; add `http://localhost:8787/auth/google/callback` (and the Microsoft
one) to the app registrations if you want to try them. Resend is not called in
development when `DEV_SHOW_EMAIL_LINKS=1`.

`test/auth.test.js` covers sign-in through the real router with locally signed
id_tokens, a fake token and key endpoint, a fake mailer and a cookie jar, so
nothing touches the network. It reads and writes the same D1 stand-in.

The wire protocol, the state machine and the acceptance checks are in
[`docs/relay-v1-spec.md`](relay-v1-spec.md).
