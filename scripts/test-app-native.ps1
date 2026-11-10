# Compile test/app-native.cs together with src/agent-app.cs and run it. Run on
# Windows with the built-in .NET Framework v4 compiler. Exits non-zero when the
# compile fails, any check throws, or the last check never ran.
# -ReferenceDir is the .NET Framework 4.5.2 reference assemblies, the same ones
# build-app.ps1 uses. The tests still run on the framework installed on this PC,
# so the references do not change what they exercise. They make the compile fail
# if the app or the tests call a method that 4.5.2 lacks.
param([Parameter(Mandatory = $true)][string]$ReferenceDir, [string]$WorkDir = (Join-Path $env:TEMP ('support-mcp-native-' + [Guid]::NewGuid().ToString('N'))))
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
. (Join-Path $PSScriptRoot 'app-references.ps1')
$references = Get-AppCompilerReferences $ReferenceDir
$fx = "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319"
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
$exe = Join-Path $WorkDir 'app-native.exe'
# The shared rules cases (PASS rules vectors) are read from beside the test exe.
Copy-Item -LiteralPath (Join-Path $root 'test\fixtures\rules-cases.json') -Destination (Join-Path $WorkDir 'rules-cases.json') -Force
& "$fx\csc.exe" /nologo $references /target:exe /platform:x86 /main:AppTests /warnaserror+ "/out:$exe" (Join-Path $root 'src\agent-app.cs') (Join-Path $root 'test\app-native.cs')
if ($LASTEXITCODE -ne 0) { throw 'Native test compilation failed.' }
$ErrorActionPreference = 'Continue'
$lines = & $exe 2>&1 | ForEach-Object { "$_"; Write-Host "$_" }
$code = $LASTEXITCODE
if ($code -ne 0) { throw "Native tests failed with exit code $code." }
if (-not ($lines -match '^PASS executable session overlay')) { throw 'Native tests ended before the last check.' }
Write-Host 'Native tests passed.'
