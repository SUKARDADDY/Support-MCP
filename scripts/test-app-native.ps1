# Compile test/app-native.cs together with src/agent-app.cs and run it. Run on
# Windows with the built-in .NET Framework v4 compiler. Exits non-zero when the
# compile fails, any check throws, or the last check never ran.
param([string]$WorkDir = (Join-Path $env:TEMP ('support-mcp-native-' + [Guid]::NewGuid().ToString('N'))))
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$fx = "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319"
$wpf = "$fx\WPF"
function Find-Assembly($name) { foreach ($dir in @($fx, $wpf)) { $file = Join-Path $dir $name; if (Test-Path -LiteralPath $file) { return $file } }; throw "Missing $name" }
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
$exe = Join-Path $WorkDir 'app-native.exe'
& "$fx\csc.exe" /nologo /target:exe /platform:x86 /main:AppTests /warnaserror+ /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll "/reference:$wpf\PresentationFramework.dll" "/reference:$wpf\PresentationCore.dll" "/reference:$(Find-Assembly 'WindowsBase.dll')" "/reference:$(Find-Assembly 'System.Xaml.dll')" "/out:$exe" (Join-Path $root 'src\agent-app.cs') (Join-Path $root 'test\app-native.cs')
if ($LASTEXITCODE -ne 0) { throw 'Native test compilation failed.' }
$ErrorActionPreference = 'Continue'
$lines = & $exe 2>&1 | ForEach-Object { "$_"; Write-Host "$_" }
$code = $LASTEXITCODE
if ($code -ne 0) { throw "Native tests failed with exit code $code." }
if (-not ($lines -match '^PASS executable session overlay')) { throw 'Native tests ended before the last check.' }
Write-Host 'Native tests passed.'
