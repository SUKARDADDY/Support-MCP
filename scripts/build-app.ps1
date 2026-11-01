# Run on Windows with the built-in .NET Framework v4 compiler. The bundle is
# imported by Wrangler as JSON. Source hashes make stale binaries fail tests.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$source = Join-Path $root 'src\agent-app.cs'
$manifest = Join-Path $root 'src\agent-app.manifest'
$out = Join-Path $env:TEMP ('support-mcp-build-' + [Guid]::NewGuid().ToString('N') + '.exe')
try {
    $fx = "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319"
    $wpf = "$fx\WPF"
    # WindowsBase and System.Xaml sit in the framework folder on some installs and under WPF on others.
    function Find-Assembly($name) { foreach ($dir in @($fx, $wpf)) { $file = Join-Path $dir $name; if (Test-Path -LiteralPath $file) { return $file } }; throw "Missing $name" }
    & "$fx\csc.exe" /nologo /target:winexe /platform:x86 /optimize+ /warnaserror+ /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll "/reference:$wpf\PresentationFramework.dll" "/reference:$wpf\PresentationCore.dll" "/reference:$(Find-Assembly 'WindowsBase.dll')" "/reference:$(Find-Assembly 'System.Xaml.dll')" "/win32manifest:$manifest" "/out:$out" $source
    if ($LASTEXITCODE -ne 0) { throw 'App compilation failed.' }
    $sha = [Security.Cryptography.SHA256]::Create()
    function Hash-File($path) { ([BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($path)))).Replace('-', '').ToLowerInvariant() }
    $bundle = @{ source_sha256 = (Hash-File $source); manifest_sha256 = (Hash-File $manifest); exe_b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($out)) }
    [IO.File]::WriteAllText((Join-Path $root 'src\app-bundle.json'), ($bundle | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
} finally { if (Test-Path $out) { Remove-Item -LiteralPath $out -Force } }
