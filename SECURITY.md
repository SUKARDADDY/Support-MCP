# Security policy

Support-MCP is a small personal project. I read reports and respond on a best
effort basis, with no guaranteed response time.

## Report a vulnerability

Report it privately through GitHub. Open this repository's **Security** tab,
choose **Report a vulnerability**, and describe the problem. Include the steps
to reproduce it and the commit you tested. Please don't open a public issue or
pull request for a vulnerability.

The relay Worker, the Windows app, the PowerShell agent, the Mac apps (`Support.app`
and `Support Join.app`, in `mac-agent/`) and the scripts in `cf/` and `scripts/` are in
scope.
Test only against your own deployment, never someone else's.

## Check the Windows app binary

`src/app-bundle.json` holds the compiled Windows app. On every push and pull
request, the `windows-app` CI job builds the app from `src/agent-app.cs` and
checks that the committed exe matches that build, apart from the build
timestamp and module id. To check it yourself, run `scripts/fetch-net452-refs.ps1`
(it pins and verifies the .NET Framework 4.5.2 reference assemblies), then
`scripts/build-app.ps1 -ReferenceDir <that folder> -OutDir <folder>` on Windows, then `node scripts/verify-app-binary.mjs
<folder>\support-mcp-app.exe`. The check trusts the compiler on the build
machine. [docs/development.md](docs/development.md#what-ci-proves-about-the-committed-exe)
lists what it does not prove.

## The Mac apps

Both Mac apps are built from `mac-agent/`, for Apple silicon and macOS 14 or later.
Releases are signed with a self-signed code-signing certificate, not an Apple
Developer ID, so macOS asks the person to choose **Open Anyway** once. Check a
download against the certificate's SHA-256 fingerprint:

```text
SHA-256 fingerprint: 7F:A1:A0:76:A6:9A:89:97:BD:CD:4D:29:02:55:68:48:03:32:3D:41:FF:9C:87:0C:9E:A2:20:91:E9:BD:66:64
```

`codesign -dr- "Support Join.app"` shows the certificate the app is signed with.

**The self-signed certificate.** It is the project's own code signing certificate
(approved call 1: a self-signed identity now, an Apple Developer ID later). Apple has
not checked or notarized it, so macOS does not trust it for Gatekeeper. That is why a
downloaded package or zip needs **Open Anyway**, and why the fingerprint above, not
macOS, is what tells you a download is the project's. Its private key is kept in the
maintainers' Bitwarden and in the `mac-release` GitHub environment that builds
releases (`.github/workflows/mac-release.yml`), and nowhere else. Releases are tagged
`mac-v<version>`; the workflow run's summary lists each file's SHA-256.

**Updates of a saved Mac** need two signatures. The update note must be signed with the
project's offline release key (the same key as the Windows app's, never in CI), and
the downloaded app must be signed by the same certificate as the app that runs: the
Mac checks it with `codesign --verify --strict` against its own designated
requirement before it replaces anything. A relay, or someone who controls the network,
can hold an update back but cannot make one. If the certificate changes (a move to a
Developer ID), installed Macs refuse updates signed with the new one, and need a new
install and a new grant of Screen Recording and Accessibility.

`Support Join.app` is the one-off app. It runs as the person who opened it, never
asks for an administrator password and installs no service. It owns the
`supportmcp://` link, and it joins only the relay it was built for. It shows that
relay and the session's label before it uses the link's code.

**Leftover permissions.** macOS lets only a person grant Screen Recording and
Accessibility. `Support Join.app` asks for both, and macOS keeps a grant until it
is reset. When a session ends, the app runs `tccutil reset ScreenCapture` and
`tccutil reset Accessibility` for its own bundle id, and says whether macOS allowed
it. If it could not, or the app was force-quit first, the grants stay: remove them in
System Settings, Privacy & Security, or run `tccutil reset All
io.github.sukardaddy.supportmcp.join`. The saved Mac's app has its own bundle id and
its permissions are separate. The join app also deletes its one small state file,
`~/Library/Application Support/SupportMCP/join.json`, which holds the session's key
for at most two hours so that it can carry on after macOS restarts it.
