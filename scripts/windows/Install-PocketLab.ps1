<#
.SYNOPSIS
    One-time laptop setup for PocketLab (Windows).

.DESCRIPTION
    - Creates .venv and installs the Python requirements (OpenCV, MediaPipe, requests).
    - Writes a managed "Host pocketlab" block in ~/.ssh/config so that
      `ssh pocketlab` also opens the dashboard and starts the gesture agent
      (via OpenSSH LocalCommand), plus "Host pocketlab-cmd" for scripts.
      Your existing config is backed up first.
    - Adds a small `ssh pocketlab` hook and a `pocketlab` command to your
      PowerShell profile as a second trigger (skip with -NoProfileHook).
    - Checks that the phone answers on SSH (8022) and HTTP (3000).

    Safe to run again at any time (for example when the phone's Tailscale
    address changes: .\Install-PocketLab.ps1 -PhoneHost <new-address>).

.EXAMPLE
    .\scripts\windows\Install-PocketLab.ps1
    .\scripts\windows\Install-PocketLab.ps1 -PhoneHost oppo-a54.tail4b1d6d.ts.net
#>
param(
    [string]$PhoneHost,
    [string]$User = 'u0_a762',
    [int]$SshPort = 8022,
    [switch]$NoProfileHook,
    [switch]$SkipPython
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$LocalScript = Join-Path $PSScriptRoot 'pocketlab-local.ps1'
$StartScript = Join-Path $Root 'Start-PocketLab.ps1'
$Utf8NoBom = New-Object System.Text.UTF8Encoding $false

function Step($text) { Write-Host "`n> $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "  OK  $text" -ForegroundColor Green }
function Warn($text) { Write-Host "  !!  $text" -ForegroundColor Yellow }

Write-Host 'PocketLab laptop setup' -ForegroundColor White
Write-Host "Project folder: $Root"

# ------------------------------------------------------------------
# 1. Python environment
# ------------------------------------------------------------------

if (-not $SkipPython) {
    Step 'Python environment'
    $venvPython = Join-Path $Root '.venv\Scripts\python.exe'
    if (-not (Test-Path $venvPython)) {
        $base = $null
        if (Get-Command py -ErrorAction SilentlyContinue) { $base = @('py', '-3') }
        elseif (Get-Command python -ErrorAction SilentlyContinue) { $base = @('python') }
        if (-not $base) { throw 'Python 3 was not found. Install it from python.org (tick "Add to PATH") and run this again.' }
        $baseArgs = @()
        if ($base.Count -gt 1) { $baseArgs = $base[1..($base.Count - 1)] }
        & $base[0] @baseArgs -m venv (Join-Path $Root '.venv')
        Ok 'Created .venv'
    } else {
        Ok '.venv already exists'
    }
    & $venvPython -m pip install --upgrade pip --quiet
    & $venvPython -m pip install -r (Join-Path $Root 'requirements.txt') --quiet
    if ($LASTEXITCODE -ne 0) { Warn 'pip install reported an error - check the output above.' } else { Ok 'Requirements installed' }
}

# ------------------------------------------------------------------
# 2. SSH config
# ------------------------------------------------------------------

Step 'SSH config (~/.ssh/config)'
$sshDir = Join-Path $HOME '.ssh'
$configPath = Join-Path $sshDir 'config'
New-Item -ItemType Directory -Force -Path $sshDir | Out-Null
$lines = @()
if (Test-Path $configPath) { $lines = @(Get-Content $configPath) }

if (-not $PhoneHost) {
    $inBlock = $false
    foreach ($raw in $lines) {
        $line = $raw.Trim()
        if ($line -eq '' -or $line.StartsWith('#')) { continue }
        $parts = $line -split '\s+', 2
        $key = $parts[0].ToLower()
        $value = if ($parts.Count -gt 1) { $parts[1].Trim() } else { '' }
        if ($key -eq 'host' -or $key -eq 'match') { $inBlock = ($key -eq 'host') -and (($value -split '\s+') -contains 'pocketlab'); continue }
        if ($inBlock -and $key -eq 'hostname') { $PhoneHost = $value; break }
    }
}
if (-not $PhoneHost) { $PhoneHost = Read-Host "Phone address (Tailscale IP like 100.x.y.z or MagicDNS name)" }
if (-not $PhoneHost) { throw 'A phone address is required.' }
Ok "Phone address: $PhoneHost"

# Drop old pocketlab / pocketlab-cmd blocks and our previous managed block.
$kept = New-Object System.Collections.Generic.List[string]
$skip = $false
$inManaged = $false
foreach ($raw in $lines) {
    if ($raw -match '^\s*# >>> PocketLab >>>') { $inManaged = $true; continue }
    if ($raw -match '^\s*# <<< PocketLab <<<') { $inManaged = $false; continue }
    if ($inManaged) { continue }
    if ($raw -match '^\s*(Host|Match)\s+(.*)$') {
        $patterns = $Matches[2].Trim() -split '\s+'
        $skip = ($Matches[1] -ieq 'Host') -and (($patterns -contains 'pocketlab') -or ($patterns -contains 'pocketlab-cmd'))
        if ($skip) { continue }
    }
    if (-not $skip) { $kept.Add($raw) }
}
while ($kept.Count -gt 0 -and $kept[$kept.Count - 1].Trim() -eq '') { $kept.RemoveAt($kept.Count - 1) }

$localCommand = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -PhoneHost %h' -f $LocalScript
$block = @(
    '# >>> PocketLab >>>',
    '# Managed by scripts\windows\Install-PocketLab.ps1 - rerun it to change these.',
    'Host pocketlab',
    "    HostName $PhoneHost",
    "    User $User",
    "    Port $SshPort",
    '    ServerAliveInterval 30',
    '    ServerAliveCountMax 4',
    '    PermitLocalCommand yes',
    "    LocalCommand $localCommand",
    '',
    'Host pocketlab-cmd',
    "    HostName $PhoneHost",
    "    User $User",
    "    Port $SshPort",
    '    ServerAliveInterval 30',
    '# <<< PocketLab <<<'
)

# Append at the end: options placed before the first Host line in an existing
# config are global, so inserting a Host block above them would change them.
$prefix = @()
if ($kept.Count -gt 0) { $prefix = @($kept) + @('') }
$newText = (($prefix + $block) -join "`r`n") + "`r`n"

if (Test-Path $configPath) {
    $backup = "$configPath.pocketlab-backup-$(Get-Date -Format yyyyMMdd-HHmmss)"
    Copy-Item $configPath $backup
    Ok "Backup: $backup"
}
[System.IO.File]::WriteAllText($configPath, $newText, $Utf8NoBom)
Ok 'Wrote Host pocketlab (with autostart) and Host pocketlab-cmd'

# ------------------------------------------------------------------
# 3. PowerShell profile hook (second trigger + `pocketlab` command)
# ------------------------------------------------------------------

if (-not $NoProfileHook) {
    Step 'PowerShell profile'
    $hook = @(
        '# >>> PocketLab >>>',
        '# `ssh pocketlab` also starts the laptop side (dashboard + gesture agent).',
        'function ssh {',
        "    if (`$args.Count -eq 1 -and `$args[0] -eq 'pocketlab') {",
        "        Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File','`"$LocalScript`"','-Worker')",
        '    }',
        '    & ssh.exe @args',
        '}',
        "function pocketlab { & '$StartScript' @args }",
        '# <<< PocketLab <<<'
    ) -join "`r`n"

    $documents = [Environment]::GetFolderPath('MyDocuments')
    if (-not $documents) { $documents = Join-Path $HOME 'Documents' }
    foreach ($profilePath in @(
        (Join-Path $documents 'WindowsPowerShell\profile.ps1'),
        (Join-Path $documents 'PowerShell\profile.ps1')
    )) {
        New-Item -ItemType Directory -Force -Path (Split-Path $profilePath) | Out-Null
        $existing = ''
        if (Test-Path $profilePath) { $existing = [System.IO.File]::ReadAllText($profilePath) }
        $existing = [regex]::Replace($existing, '(?s)\r?\n?# >>> PocketLab >>>.*?# <<< PocketLab <<<\r?\n?', "`r`n")
        $text = $existing.TrimEnd() + "`r`n`r`n" + $hook + "`r`n"
        [System.IO.File]::WriteAllText($profilePath, $text.TrimStart(), $Utf8NoBom)
        Ok "Updated $profilePath"
    }

    $policy = Get-ExecutionPolicy -Scope CurrentUser
    $effective = Get-ExecutionPolicy
    if ($effective -eq 'Restricted' -or $effective -eq 'AllSigned') {
        if ($policy -eq 'Undefined' -or $policy -eq 'Restricted') {
            Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned -Force
            Ok 'Set PowerShell execution policy to RemoteSigned for your user so the profile can load.'
        } else {
            Warn "Execution policy is $effective - the profile hook may not load (ssh LocalCommand still works)."
        }
    }
}

# ------------------------------------------------------------------
# 4. Connectivity check
# ------------------------------------------------------------------

Step 'Checking the phone'
function Test-Port($hostName, $port) {
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $task = $client.ConnectAsync($hostName, $port)
        $okay = $task.Wait(3000) -and $client.Connected
        $client.Close()
        return $okay
    } catch { return $false }
}

if (Test-Port $PhoneHost $SshPort) { Ok "SSH port $SshPort answers" } else { Warn "SSH port $SshPort not reachable - open Termux on the phone and type: sshd" }
if (Test-Port $PhoneHost 3000) { Ok 'PocketLab server port 3000 answers' } else { Warn 'Port 3000 not reachable yet - it starts when you log in with ssh pocketlab.' }

Write-Host "`nDone." -ForegroundColor Green
Write-Host 'Daily use:'
Write-Host '  phone :  open Termux (type sshd if it is not already running)'
Write-Host '  laptop:  ssh pocketlab'
Write-Host "`nIf the phone's Tailscale address changes, rerun this script with -PhoneHost <new address>."
