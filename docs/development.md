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
timeout, local expiry and the reconnect rules. They need a Windows desktop
session, so they are not part of `node --test`; CI runs them in the `windows-app`
job. Besides the client, they cover the pure parts of screen control: coordinate
scaling, key parsing, the customer pause (hooks and the `GetLastInputInfo`
cross-check), the cap on `ui_tree` text and on the display count, the choice
of display for `ui_tree`, the stop and pause checks of typing, the replacement of
a result the relay refuses, `as` in normal mode and the screen consent of a
prepared reconnect. For full control they cover the parts that need no
administrator: the consent path (UAC prompt, the app's own confirm, or
unavailable), the folder and file ACLs (a real folder, read back with `icacls`),
the deadline state on disk and its expiry rules, the backstop command line and
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

The service, the helper and the install need administrator rights and a real
console session, so the native tests do not run them. Check them by hand on a
Windows 11 PC or VM with UAC on, against `wrangler dev` (see below; raise
`SESSION_TTL_MS` in `.dev.vars` so a session lasts long enough). The app accepts
`http://127.0.0.1` as its relay, so in a VM forward the port with `netsh interface
portproxy add v4tov4 listenaddress=127.0.0.1 listenport=8787
connectaddress=<host> connectport=8787`. Then check, with screenshots through the
relay: UAC Yes gives `control: full`; a UAC prompt in the user's session shows
`desktop: secure` and can be clicked; the lock screen can be unlocked with
`type_secret`; after a restart the session comes back within its deadline and the
sign-in screen is reachable; `block_input` blocks the physical keyboard and
Ctrl+Alt+Del lifts it; `send_sas` shows the Ctrl+Alt+Del screen; `run` as `user`
and as `system` report the right identity; UAC No gives the fallback dialog and
normal mode; `request_full_control` upgrades a normal session. After
`session_end`, an expiry, and a service killed with `taskkill /f` (the backstop
task cleans up at the deadline), `sc query SupportMcp-<id>`, `schtasks /query /tn
SupportMcp-<id>`, `Test-Path C:\ProgramData\SupportMCP` and `reg query
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

## Develop and test

```sh
node --test                          # unit and route tests, no network
npx wrangler deploy --dry-run --outdir /tmp/support-mcp-dry
cp .dev.vars.example .dev.vars && npx wrangler dev --port 8787
```

`.dev.vars` skips Access and shortens the session TTL, but only when the
request host is `localhost` or `127.0.0.1`. The deployed hostname can never
satisfy that check. Keep `wrangler dev` on loopback, its default: the bypass
trusts the `Host` header, so anyone who can reach a dev server on another
interface could send `Host: localhost` and skip Access.

`wrangler dev` presents the custom-domain route's hostname to the Worker, so to
exercise `/mcp`, `/j` or `/ws` locally, run it against a copy of the config
with the `routes` line removed. Over plain http the relay serves only
`localhost` and `127.0.0.1`.

The route tests import the real router. Most give it Durable Object bindings
that throw if touched. That proves the Access gate, the `Origin` check, the
method checks, the https check and the link-preview check all run before any
session state is read. The few `/j` tests that must reach a session use a stub
binding that records every call.

`test/app.test.js` covers the app: the bundle's hashes, the download flow and
its security headers, the polling transport, and the default mode and aliases.

The wire protocol, the state machine and the acceptance checks are in
[`docs/relay-v1-spec.md`](relay-v1-spec.md).
