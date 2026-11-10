# Support-MCP agent (Windows PowerShell 5.1). Two roles chosen by switch:
#   (no switch) bootstrap  -> what `irm <origin>/j/<code> | iex` runs
#   -Run                    -> the on-disk agent: window + websocket bridge
#   -Cleanup                -> teardown (fallback task action / End action)
# Never requests elevation, and refuses to run elevated. No modules beyond the
# box. Own folder (SupportMCP), own Run value, own task name. Per-session
# state is suffixed with the first 8 hex of the sid so two sessions on one PC
# never collide.
param([switch]$Run, [switch]$Cleanup)

$ErrorActionPreference = 'Stop'

# --- values substituted by the Worker (hex / base32 / URL / base64 only) ------
$Sid      = '{{SID}}'
$Key      = '{{KEY}}'
$Origin   = '{{ORIGIN}}'
$AgentB64 = '{{AGENT_B64}}'

# Per-session names (C11): suffix everything with the first 8 hex of the sid.
$Sid8       = $Sid.Substring(0, 8)
$ParentDir  = Join-Path $env:LOCALAPPDATA 'SupportMCP'
$AppDir     = Join-Path $ParentDir $Sid8
$RunValue   = 'SupportMCP-' + $Sid8
$TaskName   = 'SupportMCPCleanup-' + $Sid8
$RunKey     = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'

function Get-AgentPath { Join-Path $AppDir 'agent.ps1' }

# True if the current process token is in the local Administrators role.
function Test-Elevated {
    try {
        $wi = [Security.Principal.WindowsIdentity]::GetCurrent()
        $wp = New-Object Security.Principal.WindowsPrincipal($wi)
        return $wp.IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
    } catch {
        return $false
    }
}

# ============================================================ CLEANUP (layer B)
# Kills any in-flight child powershell (whole tree) so nothing holds a handle on
# the folder, removes the Run value and the fallback task, then deletes only
# this session's folder from a detached, retrying cmd (the running script file
# lives inside it), and removes the parent SupportMCP folder if it is empty.
function Stop-Tree($proc) {
    if ($null -eq $proc) { return }
    try {
        if (-not $proc.HasExited) {
            & taskkill.exe /PID $proc.Id /T /F 2>$null | Out-Null
        }
    } catch {}
    try { if (-not $proc.HasExited) { $proc.Kill() } } catch {}
}

# Once a process has exited, taskkill /T can no longer walk its tree, but a child
# it left behind still records the dead parent PID in Win32_Process. Kill those
# children (and their trees). PIDs get reused, so only children created while
# the process was alive count. Best effort: a grandchild whose own parent already
# exited has no link back to $proc and is not found. The query is time-limited.
function Stop-Orphans($proc) {
    if ($null -eq $proc) { return }
    try {
        $from = $proc.StartTime.AddMilliseconds(-50)
        $to = $proc.ExitTime.AddSeconds(2)
        $kids = Get-CimInstance -ClassName Win32_Process -Filter ('ParentProcessId = {0}' -f $proc.Id) -OperationTimeoutSec 3 -ErrorAction Stop
        foreach ($k in @($kids)) {
            if ($k.CreationDate -lt $from -or $k.CreationDate -gt $to) { continue }
            $kp = $null
            try {
                $kp = [System.Diagnostics.Process]::GetProcessById([int]$k.ProcessId)
                # The orphan may have exited since the query and its PID been reused.
                # Hold a handle so the PID cannot change hands, then kill only if the
                # process started when WMI says the child did. Any error skips it.
                $null = $kp.Handle
                if ([Math]::Abs(($kp.StartTime - $k.CreationDate).TotalSeconds) -le 1) { Stop-Tree $kp }
            } catch {}
            if ($null -ne $kp) { try { $kp.Dispose() } catch {} }
        }
    } catch {}
}

function Invoke-Cleanup {
    if ($null -ne $script:jobs) {
        foreach ($id in @($script:jobs.Keys)) {
            try { Stop-Tree $script:jobs[$id].proc } catch {}
        }
    }
    try { Remove-ItemProperty -Path $RunKey -Name $RunValue -ErrorAction SilentlyContinue } catch {}
    try { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue } catch {}
    $app = $AppDir
    $parent = $ParentDir
    # Wait for us to exit, retry rmdir up to ~15 s (a just-killed child may still
    # hold a handle briefly), then remove the parent only if it is now empty.
    $inner = 'timeout /t 2 >nul & for /l %i in (1,1,15) do (rmdir /s /q "{0}" 2>nul & if not exist "{0}" (rmdir "{1}" 2>nul & goto :eof) else timeout /t 1 >nul)' -f $app, $parent
    try {
        Start-Process cmd.exe -WindowStyle Hidden -ArgumentList @('/c', $inner) | Out-Null
    } catch {}
}

if ($Cleanup) { Invoke-Cleanup; return }

# ================================================================== BOOTSTRAP
if (-not $Run) {
    New-Item -ItemType Directory -Force -Path $AppDir | Out-Null
    $agentPath = Get-AgentPath
    [IO.File]::WriteAllBytes($agentPath, [Convert]::FromBase64String($AgentB64))
    # Local first-connect deadline (Unix ms): bootstrap time + 2 hours. expires_at
    # stays null until the first welcome, so this is the only local limit on an
    # agent that never connects. Keep the 2 hours equal to CONSUMED_TTL_MS in
    # src/session.js, the relay's own first-attach window.
    $connectBy = [DateTimeOffset]::UtcNow.AddHours(2).ToUnixTimeMilliseconds()
    $cfg = New-Object psobject -Property @{ sid = $Sid; key = $Key; origin = $Origin; expires_at = $null; connect_by = $connectBy }
    [IO.File]::WriteAllText((Join-Path $AppDir 'config.json'), ($cfg | ConvertTo-Json))
    # The logon Run value is written by the -Run role once it knows it is not
    # elevated, has loaded its config and is inside its deadlines, so a run that
    # refuses to start never leaves a logon entry behind.

    if (Test-Elevated) {
        # The customer pasted us into an elevated console. Nothing here may run
        # elevated, so launch the -Run agent as the interactive user at a
        # limited run level via a one-shot scheduled task, then remove it.
        $launchTask = 'SupportMCPLaunch-' + $Sid8
        try {
            $act = New-ScheduledTaskAction -Execute 'powershell.exe' `
                -Argument ('-NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File "{0}" -Run' -f $agentPath)
            $prin = New-ScheduledTaskPrincipal -UserId $env:USERNAME -RunLevel Limited -LogonType Interactive
            $set = New-ScheduledTaskSettingsSet
            Register-ScheduledTask -TaskName $launchTask -Action $act -Principal $prin -Settings $set -Force -ErrorAction Stop | Out-Null
            Start-ScheduledTask -TaskName $launchTask
            Start-Sleep -Seconds 2
            Write-Host 'You launched this as Administrator; starting the support agent un-elevated. A window will open.'
        } catch {
            # Nothing started, so remove the folder the bootstrap just wrote.
            Invoke-Cleanup
            Write-Host 'Could not start the support agent un-elevated. Please paste the command into a normal (non-Administrator) PowerShell window.'
        } finally {
            try { Unregister-ScheduledTask -TaskName $launchTask -Confirm:$false -ErrorAction SilentlyContinue } catch {}
        }
        return
    }

    try {
        Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @(
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-WindowStyle', 'Hidden',
            '-File', ('"{0}"' -f $agentPath), '-Run'
        ) | Out-Null
        Write-Host 'Support session starting. A window will open.'
    } catch {
        # Nothing started, so remove the folder the bootstrap just wrote.
        Invoke-Cleanup
        Write-Host 'Could not start the support agent. Please ask for a new support command.'
    }
    return
}

# ===================================================================== RUN role
# Backstop for B4: even the on-disk agent refuses to run elevated. With UAC off
# or the built-in Administrator account, the limited one-shot launch task still
# gets a full token and lands here. Remove everything this session installed,
# so nothing is left to start it again at logon. (The agent.log line would live
# in the folder being deleted, so none is written.)
if (Test-Elevated) {
    Invoke-Cleanup
    return
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# config sits next to this on-disk script
$cfgPath = Join-Path (Split-Path -Parent $PSCommandPath) 'config.json'
$cfg = Get-Content -Raw -Path $cfgPath | ConvertFrom-Json
$Sid = $cfg.sid; $Key = $cfg.key; $Origin = $cfg.origin

$script:jobs       = @{}            # id -> @{ proc; outTask; errTask; deadline; type; endedAt; timedOut; sweptAt }
$script:ws         = $null
$script:connectTask = $null
$script:connecting = $false
$script:recvTask   = $null
$script:rbuf       = New-Object 'byte[]' 65536
$script:rseg       = [System.ArraySegment[byte]]::new($script:rbuf)
$script:rms        = New-Object System.IO.MemoryStream
$script:expiresAt  = $null          # DateTime (local)
$script:expiresMs  = $null          # long (unix ms), persisted to config.json
$script:connectBy  = $null          # DateTime (local): first-connect deadline, used while expiresAt is null
$script:ending     = $false
$script:backoff    = 5
$script:nextConnAt = Get-Date
$script:taskAt     = $null          # DateTime the fallback task is registered for

# B1 self-cleanup: a restarted agent whose stored expiry has passed tears itself
# down without needing the relay.
if ($cfg.expires_at) {
    $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    if ([long]$cfg.expires_at -le $nowMs) { Invoke-Cleanup; return }
    $script:expiresMs = [long]$cfg.expires_at
    $script:expiresAt = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$cfg.expires_at).LocalDateTime
} elseif ($cfg.connect_by) {
    # Never connected: expires_at is still null, so connect_by (written by the
    # bootstrap) is the only local deadline. Past it, tear down without the relay.
    $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    if ([long]$cfg.connect_by -le $nowMs) { Invoke-Cleanup; return }
    $script:connectBy = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$cfg.connect_by).LocalDateTime
}

# Per-user logon reattach (HKCU Run always runs un-elevated at logon). Written
# only now: after the elevation check, a successful config load and the expiry
# checks above, so a refused, broken or already-expired run never creates it.
# Cleanup, the expiry checks and a server end all remove it.
try {
    $launch = ('powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File "{0}" -Run' -f (Get-AgentPath))
    Set-ItemProperty -Path $RunKey -Name $RunValue -Value $launch
} catch {}

function Save-Config {
    try {
        $c = New-Object psobject -Property @{ sid = $Sid; key = $Key; origin = $Origin; expires_at = $script:expiresMs }
        [IO.File]::WriteAllText($cfgPath, ($c | ConvertTo-Json))
    } catch {}
}

# WebSocket url (key travels in the X-Attach-Key header, never the query).
function Get-WsUrl {
    $u = $Origin -replace '^http', 'ws'
    return ('{0}/ws?sid={1}' -f $u, $Sid)
}
# Probe url is the same path over plain http (Origin is already http/https).
function Get-ProbeUrl {
    return ('{0}/ws?sid={1}' -f $Origin, $Sid)
}

function Append-Log([string]$line) {
    $t = (Get-Date).ToString('HH:mm:ss')
    $script:logBox.AppendText(('[{0}] {1}{2}' -f $t, $line, [Environment]::NewLine))
}

function Send-Frame($obj) {
    if ($null -eq $script:ws) { return }
    if ($script:ws.State -ne [System.Net.WebSockets.WebSocketState]::Open) { return }
    $txt = $obj | ConvertTo-Json -Depth 6 -Compress
    $bytes = [Text.Encoding]::UTF8.GetBytes($txt)
    $seg = [System.ArraySegment[byte]]::new($bytes)
    try {
        $sent = $script:ws.SendAsync($seg, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [Threading.CancellationToken]::None).Wait(5000)
        if (-not $sent) {
            # A slow or dead link must not freeze the UI thread (End session sends
            # through here too). Abort leaves the state at not-Open, so the next
            # Tick runs Handle-Disconnect. Calling it from here would make End
            # session wait on a probe and would run it twice from On-Connected.
            try { $script:ws.Abort() } catch {}
        }
    } catch {}
}

# --- run-result frame with a serialized-byte budget (B6) ----------------------
# Cap each stream at CharCap (262,144 characters, not bytes) first, then shrink
# stdout/stderr and re-serialize until the whole UTF-8 frame is under ~900 KB
# (WebSocket messages have a ~1 MiB limit and JSON escaping / UTF-8 inflate the
# payload).
$script:CharCap  = 262144
$script:ByteMax  = 900000
$script:Marker   = [Environment]::NewLine + '[truncated]'

function Clip([string]$raw, [int]$cap) {
    if ($null -eq $raw) { return '' }
    if ($raw.Length -gt $cap) { return $raw.Substring(0, $cap) + $script:Marker }
    return $raw
}

function Send-RunResult([string]$id, $exitCode, [string]$so, [string]$se, [bool]$timedOut) {
    if ($null -eq $so) { $so = '' }
    if ($null -eq $se) { $se = '' }
    $soCap = [Math]::Min($so.Length, $script:CharCap)
    $seCap = [Math]::Min($se.Length, $script:CharCap)
    $obj = $null
    for ($i = 0; $i -lt 48; $i++) {
        $obj = New-Object psobject -Property @{
            type = 'result'; id = $id; ok = $true; exit_code = $exitCode;
            stdout = (Clip $so $soCap); stderr = (Clip $se $seCap); timed_out = $timedOut
        }
        $json = $obj | ConvertTo-Json -Depth 6 -Compress
        $n = [Text.Encoding]::UTF8.GetByteCount($json)
        if ($n -le $script:ByteMax) { break }
        # shrink the larger cap by 30% (min 512) and try again
        if ($soCap -ge $seCap) {
            $soCap = [Math]::Max(0, $soCap - [Math]::Max(512, [int]($soCap * 0.3)))
        } else {
            $seCap = [Math]::Max(0, $seCap - [Math]::Max(512, [int]($seCap * 0.3)))
        }
        if ($soCap -eq 0 -and $seCap -eq 0) { break }
    }
    Send-Frame $obj
}

function Start-Receive {
    try {
        $script:recvTask = $script:ws.ReceiveAsync($script:rseg, [Threading.CancellationToken]::None)
    } catch {
        $script:recvTask = $null
        Handle-Disconnect
    }
}

# ---- probe /ws over plain HTTP to tell "session over" from a transient drop ---
# DO returns 410 (ended), 401 (pending/bad key), 426 (alive, needs upgrade).
# Runs only after a drop or a failed connect. -TimeoutSec 3 does not bound DNS
# resolution, so a stalled lookup can hold the UI for about 15 s.
function Probe-Over {
    try {
        Invoke-WebRequest -Uri (Get-ProbeUrl) -Method Get -UseBasicParsing -TimeoutSec 3 `
            -Headers @{ 'X-Attach-Key' = $Key } | Out-Null
        return $false
    } catch {
        $r = $_.Exception.Response
        if ($r -ne $null) {
            $code = [int]$r.StatusCode
            if ($code -eq 410 -or $code -eq 401) { return $true }
            return $false   # 426 etc: alive
        }
        return $false       # network error / timeout: transient, keep retrying
    }
}

# Kick off a non-blocking connect; the tick polls $script:connectTask (C3).
function Start-Connect {
    try {
        $script:ws = New-Object System.Net.WebSockets.ClientWebSocket
        $script:ws.Options.SetRequestHeader('X-Attach-Key', $Key)
        $script:connectTask = $script:ws.ConnectAsync([Uri](Get-WsUrl), [Threading.CancellationToken]::None)
        $script:connecting = $true
        Append-Log 'Connecting...'
    } catch {
        try { if ($null -ne $script:ws) { $script:ws.Dispose() } } catch {}
        $script:ws = $null
        $script:connecting = $false
        $script:nextConnAt = (Get-Date).AddSeconds($script:backoff)
        $script:backoff = [Math]::Min(60, $script:backoff * 2)
    }
}

function On-Connected {
    Append-Log 'Connected.'
    $script:backoff = 5
    $hello = New-Object psobject -Property @{
        type = 'hello'; machine = $env:COMPUTERNAME; user = $env:USERNAME;
        ps = $PSVersionTable.PSVersion.ToString(); agent = '1'; version = '0.8.0'
    }
    Send-Frame $hello
    Start-Receive
}

function Handle-Disconnect {
    if ($null -ne $script:ws) { try { $script:ws.Dispose() } catch {} }
    $script:ws = $null
    $script:recvTask = $null
    $script:connecting = $false
    if ($script:ending) { return }
    if (Probe-Over) { Append-Log 'Session ended by server.'; Finish-Cleanup; return }
    $script:nextConnAt = (Get-Date).AddSeconds($script:backoff)
    Append-Log ('Disconnected. Reconnecting in {0}s.' -f $script:backoff)
    $script:backoff = [Math]::Min(60, $script:backoff * 2)
}

# ---------------------------------------------------------------- message pump
function Process-Message([string]$txt) {
    $m = $null
    try { $m = $txt | ConvertFrom-Json } catch { return }
    switch ($m.type) {
        'welcome' {
            $script:expiresMs = [long]$m.expires_at
            $script:expiresAt = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$m.expires_at).LocalDateTime
            Save-Config
            $script:statusLbl.Text = ('Support session active until {0}' -f $script:expiresAt.ToString('HH:mm'))
            Register-FallbackTask
            Append-Log 'Session authorized.'
        }
        'run'      { Start-RunJob $m }
        'put_file' { Do-PutFile $m }
        'get_file' { Do-GetFile $m }
        'end' {
            Append-Log ('Session ending ({0}).' -f $m.reason)
            Finish-Cleanup
        }
    }
}

$script:RunPreamble = '$ProgressPreference=''SilentlyContinue'';$ErrorActionPreference=''Continue'';$OutputEncoding=[Text.Encoding]::UTF8'

function Start-RunJob($m) {
    $id = [string]$m.id
    $timeout = 60
    if ($m.timeout_s) { $timeout = [int]$m.timeout_s }
    if ($timeout -lt 1) { $timeout = 1 }
    if ($timeout -gt 600) { $timeout = 600 }
    Append-Log ('run: {0}' -f $m.command)
    # Suppress the "Preparing modules for first use" progress record and force
    # UTF-8. The preamble sits on its own line so error positions quote only the
    # operator's command. PS 5.1 still emits stderr as CLIXML under
    # -EncodedCommand despite -OutputFormat Text; Pump-Jobs decodes it.
    $pre = $script:RunPreamble + "`n"
    $enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($pre + [string]$m.command))
    try {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = 'powershell.exe'
        $psi.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -OutputFormat Text -EncodedCommand ' + $enc
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.StandardOutputEncoding = [Text.Encoding]::UTF8
        $psi.StandardErrorEncoding = [Text.Encoding]::UTF8
        $p = New-Object System.Diagnostics.Process
        $p.StartInfo = $psi
        [void]$p.Start()
        # Read both streams async so a child that fills a pipe can't deadlock.
        # Pump-Jobs only reads a task's Result once it IsCompleted: a background
        # process the command leaves running can hold the pipes open after the
        # child exits, and such a task would never finish.
        $outTask = $p.StandardOutput.ReadToEndAsync()
        $errTask = $p.StandardError.ReadToEndAsync()
    } catch {
        Send-Frame (New-Object psobject -Property @{ type = 'result'; id = $id; ok = $false; error = ('spawn failed: ' + $_.Exception.Message) })
        return
    }
    $script:jobs[$id] = @{ proc = $p; outTask = $outTask; errTask = $errTask; deadline = (Get-Date).AddSeconds($timeout); type = 'run'
                           endedAt = $null; timedOut = $false; sweptAt = $null }
}

# Child stderr under -EncodedCommand arrives as '#< CLIXML' + <Objs>...</Objs>,
# possibly with native-process stderr (sc, netsh, git ...) before, inside or
# after the XML. Decode every stream to plain text and keep native text
# verbatim; progress records are dropped. On any parse failure return the input.
$script:CliXmlMaxChars = 2000000
$script:StreamPrefix = @{ 'warning' = 'WARNING: '; 'verbose' = 'VERBOSE: '; 'debug' = 'DEBUG: '; 'information' = '' }
function ConvertFrom-CliXmlStderr([string]$raw) {
    if ([string]::IsNullOrEmpty($raw)) { return '' }
    $h = $raw.IndexOf('#< CLIXML', [StringComparison]::Ordinal)
    if ($h -lt 0) { return $raw }
    if ($raw.Length -gt $script:CliXmlMaxChars) { return $raw }   # don't stall the UI parsing huge XML
    try {
        $before = $raw.Substring(0, $h)
        $rest = $raw.Substring($h + 9).TrimStart("`r", "`n")
        $o = $rest.IndexOf('<Objs', [StringComparison]::Ordinal)
        if ($o -lt 0) { return $before + $rest }                   # header only (e.g. killed on timeout)
        $between = $rest.Substring(0, $o)
        $c = $rest.IndexOf('</Objs>', $o, [StringComparison]::Ordinal)
        if ($c -lt 0) { return $raw }
        $after = $rest.Substring($c + 7)
        $doc = New-Object System.Xml.XmlDocument
        $doc.PreserveWhitespace = $true
        $doc.LoadXml($rest.Substring($o, $c + 7 - $o))
        $sb = New-Object System.Text.StringBuilder
        [void]$sb.Append($before).Append($between)
        foreach ($n in $doc.DocumentElement.ChildNodes) {
            if ($n.NodeType -eq [System.Xml.XmlNodeType]::Text -or $n.NodeType -eq [System.Xml.XmlNodeType]::Whitespace -or $n.NodeType -eq [System.Xml.XmlNodeType]::SignificantWhitespace) {
                [void]$sb.Append($n.Value); continue
            }
            if ($n.NodeType -ne [System.Xml.XmlNodeType]::Element -or $n.LocalName -ne 'S') { continue }
            $stream = $n.GetAttribute('S')
            $text = [System.Xml.XmlConvert]::DecodeName($n.InnerText)
            if ($stream -ceq 'Error') { [void]$sb.Append($text); continue }
            $k = $stream.ToLowerInvariant()
            if ($script:StreamPrefix.ContainsKey($k)) { [void]$sb.Append($script:StreamPrefix[$k] + $text + "`r`n") }
            else { [void]$sb.Append($text) }
        }
        [void]$sb.Append($after)
        return $sb.ToString()
    } catch {
        return $raw
    }
}

# After a job's process has exited (or been killed on timeout) its stdout/stderr
# tasks normally finish within a tick. A background process the command left
# running can keep the pipes open, so the wait is bounded: DrainSecs after the
# exit, or the job's own deadline if that comes first (never less than
# DrainGraceSecs; a killed job has no deadline left and gets the full DrainSecs).
# Then Stop-Orphans runs once and the tasks get DrainGraceSecs more to finish,
# after which the result goes out with whatever completed. The UI thread never
# waits on a task.
$script:DrainSecs      = 5
$script:DrainGraceSecs = 1
$script:IncompleteMark = '[output incomplete: a background process kept the output open]'

function Pump-Jobs {
    if ($script:jobs.Count -eq 0) { return }
    foreach ($id in @($script:jobs.Keys)) {
        $j = $script:jobs[$id]
        $now = Get-Date
        if ($null -eq $j.endedAt) {
            $exited = $true
            try { $exited = $j.proc.HasExited } catch {}
            if ($exited) {
                $j.endedAt = $now
            } elseif ($now -gt $j.deadline) {
                Stop-Tree $j.proc          # kill the whole child tree on timeout
                $j.endedAt = $now; $j.timedOut = $true
            } else {
                continue
            }
        }
        # Draining: both stream tasks must be complete before their Result is read.
        if (-not ($j.outTask.IsCompleted -and $j.errTask.IsCompleted)) {
            if ($null -eq $j.sweptAt) {
                $limit = $j.endedAt.AddSeconds($script:DrainSecs)
                if (-not $j.timedOut -and $j.deadline -lt $limit) { $limit = $j.deadline }
                $floor = $j.endedAt.AddSeconds($script:DrainGraceSecs)
                if ($limit -lt $floor) { $limit = $floor }
                if ($now -lt $limit) { continue }
                Stop-Orphans $j.proc       # kill what still holds the pipes, then re-check
                $j.sweptAt = Get-Date
                continue
            }
            if ($now -lt $j.sweptAt.AddSeconds($script:DrainGraceSecs)) { continue }
        }
        $script:jobs.Remove($id)   # first, so a later throw can't wedge the job into retrying every tick
        $so = ''; $se = ''; $incomplete = $false
        if ($j.outTask.IsCompleted) { try { $so = $j.outTask.Result } catch {} } else { $incomplete = $true }
        if ($j.errTask.IsCompleted) { try { $se = $j.errTask.Result } catch {} } else { $incomplete = $true }
        try { $se = (ConvertFrom-CliXmlStderr $se) -replace ('(?m)^' + [regex]::Escape($script:RunPreamble) + '\r?\n'), '' } catch {}
        if ($incomplete) {
            if ($se.Length -gt 0 -and -not $se.EndsWith("`n")) { $se += [Environment]::NewLine }
            $se += $script:IncompleteMark
        }
        # exit_code null on timeout (A3); otherwise the child's real code (A1).
        $exit = $null
        if (-not $j.timedOut) { try { $exit = [int]$j.proc.ExitCode } catch { $exit = $null } }
        try { $j.proc.Dispose() } catch {}
        Send-RunResult $id $exit $so $se $j.timedOut
    }
}

function Do-PutFile($m) {
    $id = [string]$m.id
    Append-Log ('put_file: {0}' -f $m.path)
    try {
        $bytes = [Convert]::FromBase64String([string]$m.data_b64)
        $dir = Split-Path -Parent ([string]$m.path)
        if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
        if ($m.append) {
            $fs = [System.IO.File]::Open([string]$m.path, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write)
            try { $fs.Write($bytes, 0, $bytes.Length) } finally { $fs.Close() }
        } else {
            [IO.File]::WriteAllBytes([string]$m.path, $bytes)
        }
        Send-Frame (New-Object psobject -Property @{ type = 'result'; id = $id; ok = $true; bytes = $bytes.Length })
    } catch {
        Send-Frame (New-Object psobject -Property @{ type = 'result'; id = $id; ok = $false; error = $_.Exception.Message })
    }
}

function Do-GetFile($m) {
    $id = [string]$m.id
    Append-Log ('get_file: {0}' -f $m.path)
    try {
        $offset = [long]0; if ($m.offset) { $offset = [long]$m.offset }
        $length = 524288; if ($m.length) { $length = [int]$m.length }
        if ($length -gt 524288) { $length = 524288 }
        $fs = [System.IO.File]::Open([string]$m.path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        try {
            $size = [long]$fs.Length
            if ($offset -gt $size) { $offset = $size }
            [void]$fs.Seek($offset, [System.IO.SeekOrigin]::Begin)
            $toRead = [int][Math]::Min([long]$length, $size - $offset)
            $buf = New-Object 'byte[]' $toRead
            $read = 0
            while ($read -lt $toRead) {
                $n = $fs.Read($buf, $read, $toRead - $read)
                if ($n -le 0) { break }
                $read += $n
            }
        } finally { $fs.Close() }
        if ($read -lt $buf.Length) { $tmp = New-Object 'byte[]' $read; [Array]::Copy($buf, $tmp, $read); $buf = $tmp }
        $eof = ($offset + $read) -ge $size
        Send-Frame (New-Object psobject -Property @{
            type = 'result'; id = $id; ok = $true;
            data_b64 = [Convert]::ToBase64String($buf); size = [long]$size; eof = [bool]$eof
        })
    } catch {
        Send-Frame (New-Object psobject -Property @{ type = 'result'; id = $id; ok = $false; error = $_.Exception.Message })
    }
}

# ------------------------------------------------------------- fallback task (A)
# Fires at expires_at once the relay has authorised the session. Before the first
# welcome there is no expires_at, so it fires at connect_by instead, and cleanup
# still happens for an agent that never connects. Register-ScheduledTask -Force
# replaces the task of the same name, so the welcome call moves it from
# connect_by to the real expiry.
function Register-FallbackTask {
    $at = $script:expiresAt
    if ($null -eq $at) { $at = $script:connectBy }
    if ($null -eq $at -or $script:taskAt -eq $at) { return }
    try {
        $agentPath = Get-AgentPath
        $act = New-ScheduledTaskAction -Execute 'powershell.exe' `
            -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -Cleanup' -f $agentPath)
        $trg = New-ScheduledTaskTrigger -Once -At $at
        # Must fire even on battery / if the machine was asleep at the deadline.
        $set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
        Register-ScheduledTask -TaskName $TaskName -Action $act -Trigger $trg -Settings $set -Force -ErrorAction Stop | Out-Null
        $script:taskAt = $at
    } catch {
        # A connect_by task left in place would end a live session early; drop it.
        if ($null -ne $script:taskAt) {
            try { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue } catch {}
            $script:taskAt = $null
        }
        Append-Log 'Note: fallback cleanup task could not be registered.'
    }
}

function Finish-Cleanup {
    if ($script:ending) { return }
    $script:ending = $true
    try { if ($null -ne $script:ws -and $script:ws.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
        $script:ws.CloseAsync([System.Net.WebSockets.WebSocketCloseStatus]::NormalClosure, 'bye', [Threading.CancellationToken]::None).Wait(2000)
    } } catch {}
    Invoke-Cleanup
    try { $script:timer.Stop() } catch {}
    try { $script:form.Close() } catch {}
}

# --------------------------------------------------------------------- the tick
function Tick {
    try {
        Pump-Jobs
        if ($script:ending) { return }
        # expiry guard (belt and braces; server also sends 'end')
        if ($null -ne $script:expiresAt -and (Get-Date) -ge $script:expiresAt) { Finish-Cleanup; return }
        # never connected: expires_at is still null, so connect_by is the deadline
        if ($null -eq $script:expiresAt -and $null -ne $script:connectBy -and (Get-Date) -ge $script:connectBy) {
            Append-Log 'No connection within 2 hours. Session closed.'
            Finish-Cleanup; return
        }

        if ($script:connecting) {
            if ($null -ne $script:connectTask -and $script:connectTask.IsCompleted) {
                $ok = -not ($script:connectTask.IsFaulted -or $script:connectTask.IsCanceled)
                $script:connecting = $false
                if ($ok -and $null -ne $script:ws -and $script:ws.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
                    On-Connected
                } else {
                    try { if ($null -ne $script:ws) { $script:ws.Dispose() } } catch {}
                    $script:ws = $null
                    if (Probe-Over) { Append-Log 'Session ended by server.'; Finish-Cleanup; return }
                    $script:nextConnAt = (Get-Date).AddSeconds($script:backoff)
                    Append-Log ('Disconnected. Reconnecting in {0}s.' -f $script:backoff)
                    $script:backoff = [Math]::Min(60, $script:backoff * 2)
                }
            }
            return
        }

        if ($null -eq $script:ws) {
            if (-not $script:ending -and (Get-Date) -ge $script:nextConnAt) { Start-Connect }
            return
        }
        if ($script:ws.State -ne [System.Net.WebSockets.WebSocketState]::Open) { Handle-Disconnect; return }

        # Drain every receive that has already completed this tick (C5), not just
        # one 64 KiB chunk per interval.
        while ($null -ne $script:recvTask -and $script:recvTask.IsCompleted) {
            $r = $null
            try { $r = $script:recvTask.Result } catch { Handle-Disconnect; return }
            if ($r.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) { Handle-Disconnect; return }
            $script:rms.Write($script:rbuf, 0, $r.Count)
            if ($r.EndOfMessage) {
                $msgTxt = [Text.Encoding]::UTF8.GetString($script:rms.ToArray())
                $script:rms.SetLength(0)
                Process-Message $msgTxt
            }
            if ($script:ending) { return }
            if ($null -ne $script:ws -and $script:ws.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
                Start-Receive
            } else {
                break
            }
        }
    } catch {
        # never let a tick throw out of the UI loop
    }
}

# ------------------------------------------------------------------------- UI
$script:form = New-Object System.Windows.Forms.Form
$script:form.Text = 'Support session'
$script:form.Size = New-Object System.Drawing.Size(560, 400)
$script:form.StartPosition = 'CenterScreen'
$script:form.TopMost = $true

$script:statusLbl = New-Object System.Windows.Forms.Label
$script:statusLbl.Text = 'Support session starting...'
$script:statusLbl.AutoSize = $false
$script:statusLbl.Dock = 'Top'
$script:statusLbl.Height = 28
$script:statusLbl.TextAlign = 'MiddleLeft'
$script:statusLbl.Padding = New-Object System.Windows.Forms.Padding(8, 4, 8, 0)

$script:logBox = New-Object System.Windows.Forms.TextBox
$script:logBox.Multiline = $true
$script:logBox.ReadOnly = $true
$script:logBox.ScrollBars = 'Vertical'
$script:logBox.Dock = 'Fill'

$endBtn = New-Object System.Windows.Forms.Button
$endBtn.Text = 'End session'
$endBtn.Dock = 'Bottom'
$endBtn.Height = 36
$endBtn.Add_Click({
    $ans = [System.Windows.Forms.MessageBox]::Show('End the support session now?', 'Support session', 'YesNo', 'Question')
    if ($ans -eq 'Yes') {
        Send-Frame (New-Object psobject -Property @{ type = 'end'; reason = 'customer' })
        Finish-Cleanup
    }
})

$script:form.Controls.Add($script:logBox)
$script:form.Controls.Add($script:statusLbl)
$script:form.Controls.Add($endBtn)

$script:form.Add_FormClosing({
    # A shutdown / Task Manager kill / Application.Exit must close WITHOUT ending
    # the session, so reattach after reboot still works. Only a user close asks
    # to confirm and then ends. (C4)
    $reason = $_.CloseReason
    if ($reason -eq [System.Windows.Forms.CloseReason]::WindowsShutDown -or
        $reason -eq [System.Windows.Forms.CloseReason]::TaskManagerClosing -or
        $reason -eq [System.Windows.Forms.CloseReason]::ApplicationExitCall) {
        return
    }
    if ($script:ending) { return }
    $ans = [System.Windows.Forms.MessageBox]::Show('End the support session now?', 'Support session', 'YesNo', 'Question')
    if ($ans -ne 'Yes') { $_.Cancel = $true; return }
    Send-Frame (New-Object psobject -Property @{ type = 'end'; reason = 'customer' })
    Finish-Cleanup
})

$script:form.Add_Shown({
    $script:form.Activate()
    $script:form.TopMost = $false
    Append-Log 'Connecting...'
    $script:nextConnAt = Get-Date   # the tick starts the (non-blocking) connect
    # Not yet connected: arm the fallback cleanup at connect_by (welcome moves it).
    if ($null -eq $script:expiresAt) { Register-FallbackTask }
})

$script:timer = New-Object System.Windows.Forms.Timer
$script:timer.Interval = 200
$script:timer.Add_Tick({ Tick })
$script:timer.Start()

[System.Windows.Forms.Application]::Run($script:form)
