# Download the .NET Framework 4.5.2 reference assemblies from nuget.org, check the
# package against the SHA-512 pinned below, and extract them. Prints the folder to
# pass as -ReferenceDir to build-app.ps1 and test-app-native.ps1. CI and
# maintainers use this same script. It stops, and extracts nothing, when the
# download does not match the pin.
#
# To move to a new version, change both values below. Take the hash from the
# package's catalog entry on nuget.org (packageHash, base64 SHA-512) and compute
# it yourself from the downloaded .nupkg to confirm the two agree.
param([string]$Destination = (Join-Path $env:TEMP 'net452-refs'))
$ErrorActionPreference = 'Stop'
$id = 'Microsoft.NETFramework.ReferenceAssemblies.net452'
$version = '1.0.3'
$sha512 = '125b35cb0b1b2c3fd7a44810595d3232900e1e4d0b79ccf88d698e78bc33192149dca15707ee7bc0a8d7e2b109c6a25ff7b08816752670efa9bc8cfc2df4d7bf'
$url = "https://api.nuget.org/v3-flatcontainer/$($id.ToLowerInvariant())/$version/$($id.ToLowerInvariant()).$version.nupkg"
$references = Join-Path $Destination 'build\.NETFramework\v4.5.2'

if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Recurse -Force }
New-Item -ItemType Directory -Force -Path $Destination | Out-Null
$package = Join-Path $Destination "$id.$version.nupkg"
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
(New-Object Net.WebClient).DownloadFile($url, $package)

$stream = [IO.File]::OpenRead($package)
try { $actual = ([BitConverter]::ToString([Security.Cryptography.SHA512]::Create().ComputeHash($stream))).Replace('-', '').ToLowerInvariant() } finally { $stream.Dispose() }
if ($actual -ne $sha512) { Remove-Item -LiteralPath $package -Force; throw "SHA-512 mismatch for $id $version. Expected $sha512, got $actual." }

Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::ExtractToDirectory($package, (Join-Path $Destination 'package'))
$extracted = Join-Path $Destination 'package\build\.NETFramework\v4.5.2'
if (-not (Test-Path -LiteralPath (Join-Path $extracted 'mscorlib.dll'))) { throw "mscorlib.dll is missing from $extracted." }
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $references) | Out-Null
Move-Item -LiteralPath $extracted -Destination $references
Remove-Item -LiteralPath (Join-Path $Destination 'package') -Recurse -Force
Write-Host "Verified $id $version (SHA-512 $sha512)"
Write-Output $references
