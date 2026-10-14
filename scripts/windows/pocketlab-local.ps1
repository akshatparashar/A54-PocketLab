<#
.SYNOPSIS
    Laptop side of PocketLab autostart.

.DESCRIPTION
    Runs automatically when you type `ssh pocketlab` (via LocalCommand in
    ~/.ssh/config, installed by Install-PocketLab.ps1), or from
    Start-PocketLab.ps1.

      1. Waits until the PocketLab server on the phone answers.
         (The phone starts it on SSH login; if it doesn't answer, this script
         asks the phone to start it over SSH.)
      2. Opens the dashboard in your browser (at most once every 10 minutes).
      3. Starts hand_tracking.py in its own window, unless it is already running.

    When called from LocalCommand it returns immediately and does the work in a
    hidden background PowerShell, so your SSH session opens without delay.
    A mutex guarantees only one launcher runs at a time.

    Log: %LOCALAPPDATA%\PocketLab\launcher.log
#>
param(
    [string]$PhoneHost,
    [int]$Port = 3000,
    [switch]$Worker,
    [switch]$Foreground,
    [switch]$StartRemote,
    [switch]$NoBrowser,
    [switch]$NoCV,
    [int]$TimeoutSeconds = 90
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$StateDir = Join-Path $env:LOCALAPPDATA 'PocketLab'
New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
$LogFile = Join-Path $StateDir 'launcher.log'

function Write-Log {
    param([string]$Message, [string]$Color = 'Gray')
    $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    try { Add-Content -Path $LogFile -Value $line -Encoding UTF8 } catch {}
    if ($Foreground) { Write-Host $Message -ForegroundColor $Color }
}

function Get-SshHostName {
    param([string]$Alias = 'pocketlab')
    $config = Join-Path $HOME '.ssh\config'
    if (-not (Test-Path $config)) { return $null }
    $inBlock = $false
    foreach ($raw in Get-Content $config) {
        $line = $raw.Trim()
        if ($line -eq '' -or $line.StartsWith('#')) { continue }
        $parts = $line -split '\s+', 2
        $key = $parts[0].ToLower()
        $value = if ($parts.Count -gt 1) { $parts[1].Trim() } else { '' }
        if ($key -eq 'host' -or $key -eq 'match') {
            $inBlock = ($key -eq 'host') -and (($value -split '\s+') -contains $Alias)
            continue
        }
        if ($inBlock -and $key -eq 'hostname') { return $value }
    }
    return $null
}

function Test-PocketLab {
    param([string]$Base)
    try {
        $response = Invoke-WebRequest -Uri "$Base/api/health" -UseBasicParsing -TimeoutSec 3
        return ($response.StatusCode -eq 200 -and $response.Content -match '"service"\s*:\s*"PocketLab"')
    } catch {
        return $false
    }
}

function Find-Python {
    foreach ($candidate in @(
        (Join-Path $Root '.venv\Scripts\python.exe'),
        (Join-Path $Root 'venv\Scripts\python.exe'),
        (Join-Path $Root 'env\Scripts\python.exe')
    )) {
        if (Test-Path $candidate) { return @($candidate) }
    }
    if (Get-Command py -ErrorAction SilentlyContinue) { return @('py', '-3') }
    if (Get-Command python -ErrorAction SilentlyContinue) { return @('python') }
    return $null
}

function Test-CVRunning {
    try {
        $procs = Get-CimInstance Win32_Process -Filter "Name LIKE 'python%' OR Name LIKE 'py.exe'" -ErrorAction Stop
        return [bool]($procs | Where-Object { $_.CommandLine -like '*hand_tracking.py*' })
    } catch {
        return $false
    }
}

function Show-Problem {
    param([string]$Message)
    Write-Log "PROBLEM: $Message" 'Red'
    if (-not $Foreground) {
        try {
            $shell = New-Object -ComObject WScript.Shell
            [void]$shell.Popup($Message, 20, 'PocketLab', 48)
        } catch {}
    }
}

# ------------------------------------------------------------------
# Resolve the phone address (same one SSH uses)
# ------------------------------------------------------------------

if (-not $PhoneHost) { $PhoneHost = Get-SshHostName 'pocketlab' }
if (-not $PhoneHost) {
    Show-Problem 'No "Host pocketlab" entry in ~/.ssh/config. Run scripts\windows\Install-PocketLab.ps1 first.'
    exit 1
}

# ------------------------------------------------------------------
# LocalCommand mode: hand off to a hidden worker and return at once.
# ------------------------------------------------------------------

if (-not $Worker -and -not $Foreground) {
    $exe = (Get-Process -Id $PID).Path
    $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
        '-File', ('"{0}"' -f $PSCommandPath), '-Worker', '-PhoneHost', $PhoneHost, '-Port', $Port)
    if ($NoBrowser) { $arguments += '-NoBrowser' }
    if ($NoCV) { $arguments += '-NoCV' }
    Start-Process -FilePath $exe -ArgumentList $arguments -WindowStyle Hidden
    exit 0
}

# ------------------------------------------------------------------
# Worker
# ------------------------------------------------------------------

$created = $false
$mutex = New-Object System.Threading.Mutex($true, 'Local\PocketLabLauncher', [ref]$created)
if (-not $created) {
    Write-Log 'Another PocketLab launcher is already running; leaving it to finish.'
    exit 0
}

try {
    $hostForUrl = if ($PhoneHost -match ':' -and $PhoneHost -notmatch '^\[') { "[$PhoneHost]" } else { $PhoneHost }
    $Base = "http://${hostForUrl}:$Port"
    Write-Log "PocketLab launcher started for $Base" 'Cyan'

    if ($StartRemote) {
        Write-Log 'Starting PocketLab on the phone over SSH (ssh pocketlab-cmd)...' 'Cyan'
        & ssh.exe -o ConnectTimeout=10 pocketlab-cmd 'bash ~/pocketlab/bin/pocketlab up'
        if ($LASTEXITCODE -ne 0) {
            Write-Log "SSH returned exit code $LASTEXITCODE. Is sshd running on the phone (type: sshd) and Tailscale connected on both devices?" 'Yellow'
        }
    }

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $kicked = $StartRemote.IsPresent
    $started = Get-Date
    $healthy = $false

    while ((Get-Date) -lt $deadline) {
        if (Test-PocketLab $Base) { $healthy = $true; break }

        # The phone normally starts the server on login. If it hasn't after
        # 15 s, ask it directly (BatchMode: never block on a password prompt).
        if (-not $kicked -and ((Get-Date) - $started).TotalSeconds -gt 15) {
            $kicked = $true
            Write-Log 'Server not answering yet - asking the phone to start it over SSH.' 'Yellow'
            try {
                & ssh.exe -o BatchMode=yes -o ConnectTimeout=8 pocketlab-cmd 'bash ~/pocketlab/bin/pocketlab up --job' 2>&1 |
                    ForEach-Object { Write-Log "  phone: $_" }
            } catch {
                Write-Log "  ssh failed: $($_.Exception.Message)"
            }
        }
        Start-Sleep -Seconds 2
    }

    if (-not $healthy) {
        Show-Problem ("The PocketLab server at $Base did not answer within $TimeoutSeconds s.`n`n" +
            "On the phone run:  pocketlab status`n" +
            "Check that Tailscale is connected on both devices.")
        exit 2
    }

    Write-Log "Server is online at $Base" 'Green'

    # Dashboard (at most once every 10 minutes, so repeated SSH logins don't spam tabs)
    if (-not $NoBrowser -and $env:POCKETLAB_AUTOSTART_BROWSER -ne '0') {
        $stamp = Join-Path $StateDir 'dashboard-opened'
        $recent = (Test-Path $stamp) -and (((Get-Date) - (Get-Item $stamp).LastWriteTime).TotalMinutes -lt 10)
        if (-not $recent -or $Foreground) {
            Start-Process "$Base/dashboard/"
            Set-Content -Path $stamp -Value (Get-Date -Format o)
            Write-Log "Opened dashboard: $Base/dashboard/" 'Green'
        } else {
            Write-Log 'Dashboard was opened less than 10 minutes ago - not opening another tab.'
        }
    }

    # Gesture agent
    if (-not $NoCV -and $env:POCKETLAB_AUTOSTART_CV -ne '0') {
        if (Test-CVRunning) {
            Write-Log 'hand_tracking.py is already running.' 'Green'
        } else {
            $python = Find-Python
            $script = Join-Path $Root 'hand_tracking.py'
            if (-not $python) {
                Show-Problem 'Python was not found. Run scripts\windows\Install-PocketLab.ps1 to create the virtual environment.'
            } elseif (-not (Test-Path $script)) {
                Show-Problem "hand_tracking.py not found at $script"
            } else {
                $exe = $python[0]
                $pyArgs = @()
                if ($python.Count -gt 1) { $pyArgs += $python[1..($python.Count - 1)] }
                $pyArgs += @(('"{0}"' -f $script), '--api', $Base)
                Start-Process -FilePath $exe -ArgumentList $pyArgs -WorkingDirectory $Root
                Write-Log "Started gesture agent: $exe $($pyArgs -join ' ')" 'Green'
            }
        }
    }

    Write-Log 'PocketLab is ready.' 'Green'
} finally {
    $mutex.ReleaseMutex()
    $mutex.Dispose()
}
