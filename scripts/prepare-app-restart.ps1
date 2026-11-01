# Run inside the already authorized customer session, using PowerShell 2.0.
# The attach key stays on that PC. Pass the relay's current fixed expiry.
param(
    [string]$SessionId,
    [string]$SessionExe,
    [string]$PayloadPath,
    [string]$ExpectedSha256,
    [long]$ExpiresAt,
    [switch]$PrepareOnly
)
$ErrorActionPreference = 'Stop'
if ($SessionId -notmatch '^[0-9a-f]{64}$' -or $ExpectedSha256 -notmatch '^[0-9a-f]{64}$') { throw 'Invalid session or payload digest.' }
$now = [long]([DateTime]::UtcNow - (New-Object DateTime(1970,1,1))).TotalMilliseconds
if ($ExpiresAt -le $now -or $ExpiresAt -gt ($now + 86400000)) { throw 'Reconnect must use the existing session deadline, within 24 hours.' }
$folder = Join-Path (Join-Path $env:LOCALAPPDATA 'SupportMcp') ($SessionId.Substring(0,8))
$agent = Join-Path $folder 'agent.exe'
if ([IO.Path]::GetFullPath($PayloadPath) -ne [IO.Path]::GetFullPath((Join-Path $folder 'agent-base.bin'))) { throw 'Unexpected payload location.' }
if (Test-Path -LiteralPath $agent) { throw 'A restart client already exists; inspect it before preparing another.' }
$payload = [IO.File]::ReadAllBytes($PayloadPath)
$sha = [Security.Cryptography.SHA256]::Create()
try { $digest = ([BitConverter]::ToString($sha.ComputeHash($payload))).Replace('-','').ToLowerInvariant() } finally { $sha.Clear() }
if ($digest -ne $ExpectedSha256 -or $payload[0] -ne 77 -or $payload[1] -ne 90) { throw 'Reconnect client digest or executable header does not match.' }
$original = [IO.File]::ReadAllBytes($SessionExe)
$marker = 'SUPPORTMCPCFG1'
$tail = 4 + $marker.Length
if ($original.Length -lt $tail -or [Text.Encoding]::ASCII.GetString($original,$original.Length-$marker.Length,$marker.Length) -ne $marker) { throw 'The existing support file has no valid session configuration.' }
$length = [BitConverter]::ToInt32($original,$original.Length-$tail)
if ($length -lt 1 -or $length -gt 4096 -or ($original.Length-$tail-$length) -lt 0) { throw 'Invalid existing session configuration length.' }
$config = [Text.Encoding]::UTF8.GetString($original,$original.Length-$tail-$length,$length).Trim()
$sidMatch = [regex]::Match($config,'"sid"\s*:\s*"([0-9a-f]{64})"')
if (-not $sidMatch.Success -or $sidMatch.Groups[1].Value -ne $SessionId -or $config -match '"restart_resume"' -or -not $config.EndsWith('}')) { throw 'The downloaded file does not match this session.' }
if (-not [regex]::IsMatch($config,'"origin"\s*:\s*"https://[a-z0-9.-]+(:\d{1,5})?"') -or -not [regex]::IsMatch($config,'"key"\s*:\s*"[0-9a-f]{64}"')) { throw 'Invalid existing support endpoint or credentials.' }
$config = $config.Substring(0,$config.Length-1) + ',"restart_resume":true,"resume_expires_at":' + $ExpiresAt + '}'
$bytes = [Text.Encoding]::UTF8.GetBytes($config)
$stream = New-Object IO.MemoryStream
try {
    $stream.Write($payload,0,$payload.Length)
    $stream.Write($bytes,0,$bytes.Length)
    $count = [BitConverter]::GetBytes([int]$bytes.Length); $stream.Write($count,0,$count.Length)
    $footer = [Text.Encoding]::ASCII.GetBytes($marker); $stream.Write($footer,0,$footer.Length)
    [IO.File]::WriteAllBytes($agent,$stream.ToArray())
} finally { $stream.Close() }
Remove-Item -LiteralPath $PayloadPath -Force
if ($PrepareOnly) {
    'RestartClientPrepared='+$agent
    'ExistingSessionExpiresAt='+$ExpiresAt
    return
}
# Local WMI starts the replacement outside the old command's kill-on-close
# Job. It uses the caller's normal user token on the interactive desktop.
# Delay gives the current command time to acknowledge before session handoff.
$launch = "Start-Sleep -Seconds 5; Start-Process -FilePath '" + $agent.Replace("'","''") + "' -ArgumentList '--prepare-restart'"
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($launch))
$powershell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$startup = ([wmiclass]'Win32_ProcessStartup').CreateInstance()
$startup.ShowWindow = 0
$startup.WinstationDesktop = 'WinSta0\Default'
$command = '"' + $powershell + '" -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ' + $encoded
$created = ([wmiclass]'Win32_Process').Create($command,$folder,$startup)
if ($created.ReturnValue -ne 0) { throw ('Reconnect launcher failed, WMI result ' + $created.ReturnValue) }
'ReconnectLauncherPid='+$created.ProcessId
'RestartClientPath='+$agent
'ReconnectLaunchRequested=True'
'ExistingSessionExpiresAt='+$ExpiresAt
