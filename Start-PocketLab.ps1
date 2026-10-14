<#
.SYNOPSIS
    One command to start PocketLab from the laptop, with visible progress.

.DESCRIPTION
    Normally you don't need this: `ssh pocketlab` already starts everything.
    Use this when you want to see each step, or without opening an SSH shell.

      1. ssh pocketlab-cmd 'pocketlab up'   (starts the server and agent on the phone)
      2. waits for http://<phone>:3000/api/health
      3. opens the dashboard
      4. starts hand_tracking.py

.EXAMPLE
    .\Start-PocketLab.ps1
    .\Start-PocketLab.ps1 -NoCV
    .\Start-PocketLab.ps1 -PhoneHost oppo-a54.tail4b1d6d.ts.net
#>
param(
    [string]$PhoneHost,
    [switch]$NoBrowser,
    [switch]$NoCV
)

$launcher = Join-Path $PSScriptRoot 'scripts\windows\pocketlab-local.ps1'
$params = @{ Foreground = $true; StartRemote = $true; TimeoutSeconds = 45 }
if ($PhoneHost) { $params.PhoneHost = $PhoneHost }
if ($NoBrowser) { $params.NoBrowser = $true }
if ($NoCV) { $params.NoCV = $true }

& $launcher @params
exit $LASTEXITCODE
