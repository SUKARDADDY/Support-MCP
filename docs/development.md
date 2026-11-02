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
job. `scripts/test-app-native.ps1` also takes `-ReferenceDir`, so the tests are
compiled against the 4.5.2 references and the compile fails if the app or the
tests call a method 4.5.2 lacks. They still run on the build PC's framework, so
they cannot catch a method that is missing at run time on 4.5.2 by themselves;
the reference assembly build does that. The first connection from a real
Windows 7 PC was checked live (see [Limits](../README.md#limits)).

An operator can prepare one automatic reconnect after a restart the customer
authorized. `scripts/prepare-app-restart.ps1` runs inside the live session on
the customer's PC, combines the tested app payload with the existing downloaded
configuration (the attach key never leaves the PC), and asks the customer to
approve one reconnect with the same rights at the next sign-in. The reconnect
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
