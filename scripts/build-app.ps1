# Run on Windows with the built-in .NET Framework v4 compiler. The bundle is
# imported by Wrangler as JSON. Source hashes make stale binaries fail tests.
# -ReferenceDir is the folder with the .NET Framework 4.5.2 reference assemblies
# (scripts\fetch-net452-refs.ps1 downloads and checks them). The app targets
# 4.5.2, so the build compiles against them instead of the newer framework on
# the build machine. Without them the compiler can bind to a method that 4.5.2
# lacks and the app then crashes on a 4.5.2 PC. It is mandatory: every build,
# including the CI comparison build, must use the same references.
# The compiler embeds the output file name in the executable, so the script always
# compiles to the same file name. With -OutDir it writes only that executable into
# the folder and leaves the bundle alone, which is how CI and reviewers rebuild it.
param([Parameter(Mandatory = $true)][string]$ReferenceDir, [string]$OutDir)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
. (Join-Path $PSScriptRoot 'app-references.ps1')
$source = Join-Path $root 'src\agent-app.cs'
$manifest = Join-Path $root 'src\agent-app.manifest'
$references = Get-AppCompilerReferences $ReferenceDir
$workDir = if ($OutDir) { $OutDir } else { Join-Path $env:TEMP ('support-mcp-build-' + [Guid]::NewGuid().ToString('N')) }
New-Item -ItemType Directory -Force -Path $workDir | Out-Null
$out = Join-Path $workDir 'support-mcp-app.exe'
try {
    $fx = "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319"
    & "$fx\csc.exe" /nologo $references /target:winexe /platform:x86 /optimize+ /warnaserror+ "/win32manifest:$manifest" "/out:$out" $source
    if ($LASTEXITCODE -ne 0) { throw 'App compilation failed.' }
    if ($OutDir) { return }
    $sha = [Security.Cryptography.SHA256]::Create()
    function Hash-File($path) { ([BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($path)))).Replace('-', '').ToLowerInvariant() }
    $bundle = @{ reference_framework = 'net452'; source_sha256 = (Hash-File $source); manifest_sha256 = (Hash-File $manifest); exe_b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($out)) }
    [IO.File]::WriteAllText((Join-Path $root 'src\app-bundle.json'), ($bundle | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
} finally { if (-not $OutDir -and (Test-Path $workDir)) { Remove-Item -LiteralPath $workDir -Recurse -Force } }
