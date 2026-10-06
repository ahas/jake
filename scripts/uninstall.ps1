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

# Remove all three anchors for one run mode, mirroring the remove commands the agent's watchdog keeps.
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

# Tell the hub this agent is gone, so it is recorded as departed rather than shown as disconnected.
# The pair is already stopped, so the notice's own hello displaces no live connection. A hub that
# cannot be reached does not stop the removal.
$Exe = Join-Path $InstallDir 'jake.exe'
if (Test-Path $Exe) {
  Write-Step "telling the hub this agent has left"
  & $Exe --leave
  if ($LASTEXITCODE -ne 0) { Write-Host "  ! the hub was not told; it will show this agent as disconnected" -ForegroundColor Yellow }
}

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
