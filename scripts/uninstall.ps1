<#
.SYNOPSIS
  Remove the jake agent for the current user, non-elevated.

.DESCRIPTION
  Stops the agent/guard pair, removes all three autostart anchors for both run modes, and deletes the
  install folder. The config file (agent.env) is kept by default so a reinstall keeps your hub URL
  and secret; pass -RemoveConfig to delete it too. The rolling log under %LOCALAPPDATA%\jake is left
  in place unless -RemoveConfig is given.

.PARAMETER InstallDir
  Where jake was installed. Defaults to %LOCALAPPDATA%\Programs\jake.

.PARAMETER RemoveConfig
  Also delete agent.env and the log/data directory, leaving nothing behind.
#>
[CmdletBinding()]
param(
  [string]$InstallDir = "$env:LOCALAPPDATA\Programs\jake",
  [switch]$RemoveConfig
)

$ErrorActionPreference = 'Stop'

$AgentAnchor = 'JakeAgent'
$GuardAnchor = 'JakeGuard'
$RunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$StartupDir = [Environment]::GetFolderPath('Startup')
$DataDir = Join-Path $env:LOCALAPPDATA 'jake'

function Write-Step($msg) { Write-Host "· $msg" -ForegroundColor Cyan }

# Remove all three anchors for one run mode, mirroring the remove commands in src/agent/anchors.ts.
# Absence of any one anchor is not an error — the point is that none remains afterwards.
function Unregister-Anchor($name) {
  try { Remove-ItemProperty -Path $RunKey -Name $name -ErrorAction Stop } catch { }
  try { Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction Stop } catch { }
  $lnk = Join-Path $StartupDir "$name.lnk"
  Remove-Item -LiteralPath $lnk -Force -ErrorAction SilentlyContinue
}

Write-Host "jake agent uninstaller" -ForegroundColor White

Write-Step "stopping the agent and guard"
Get-Process -Name 'jake' -ErrorAction SilentlyContinue | ForEach-Object {
  try { $_ | Stop-Process -Force } catch { }
}
Start-Sleep -Milliseconds 500

Write-Step "removing autostart anchors"
Unregister-Anchor $AgentAnchor
Unregister-Anchor $GuardAnchor

Write-Step "deleting the install folder"
if (Test-Path $InstallDir) {
  if ($RemoveConfig) {
    Remove-Item -LiteralPath $InstallDir -Recurse -Force
  } else {
    # Delete everything but the config, so a later reinstall keeps the hub URL and secret.
    Get-ChildItem -LiteralPath $InstallDir -Force | Where-Object { $_.Name -ne 'agent.env' } | ForEach-Object {
      Remove-Item -LiteralPath $_.FullName -Recurse -Force
    }
  }
}

if ($RemoveConfig) {
  Write-Step "removing the log and data directory"
  Remove-Item -LiteralPath $DataDir -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ""
if ($RemoveConfig) {
  Write-Host "Removed. Nothing is left behind." -ForegroundColor Green
} else {
  Write-Host "Removed. Your config is kept at $InstallDir\agent.env and the log at $DataDir." -ForegroundColor Green
  Write-Host "Pass -RemoveConfig to delete those too." -ForegroundColor White
}
