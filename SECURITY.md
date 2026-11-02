# Security policy

Support-MCP is a small personal project. I read reports and respond on a best
effort basis, with no guaranteed response time.

## Report a vulnerability

Report it privately through GitHub. Open this repository's **Security** tab,
choose **Report a vulnerability**, and describe the problem. Include the steps
to reproduce it and the commit you tested. Please don't open a public issue or
pull request for a vulnerability.

The relay Worker, the Windows app, the PowerShell agent and the scripts in `cf/`
and `scripts/` are in scope.
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
