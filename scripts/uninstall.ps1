<#
.SYNOPSIS
  Remove the jake agent for the current user, non-elevated, through its own jake.exe uninstall.

.DESCRIPTION
  Runs `jake.exe uninstall` in the install folder, which does the whole removal (docs/install.md,
  Uninstall); where a policy refuses PowerShell scripts, run that command directly. It says which agent
  the install serves and asks before removing it, in a dialog. The config file (agent.env) and the log
  are kept unless -RemoveConfig is given.

.PARAMETER InstallDir
  Where jake was installed. Defaults to %LOCALAPPDATA%\Programs\jake.

.PARAMETER Name
  The agent to remove; where the install in InstallDir is another agent's, nothing is removed.

.PARAMETER Yes
  Remove without asking.

.PARAMETER RemoveConfig
  Also delete agent.env and the log/data directory, leaving nothing behind.
#>
[CmdletBinding()]
param(
  [string]$InstallDir = "$env:LOCALAPPDATA\Programs\jake",
  [string]$Name,
  [switch]$Yes,
  [switch]$RemoveConfig
)

$ErrorActionPreference = 'Stop'

$Exe = Join-Path $InstallDir 'jake.exe'
if (-not (Test-Path -LiteralPath $Exe)) { throw "no jake is installed in $InstallDir" }

$arguments = @('uninstall')
if ($Name) { $arguments += @('--name', $Name) }
if ($Yes) { $arguments += '--yes' }
if ($RemoveConfig) { $arguments += '--remove-config' }

# jake.exe opens no console, so PowerShell would not wait on it run as a command: it is started and waited
# on, and what it printed is read back from files.
$said = Join-Path ([System.IO.Path]::GetTempPath()) ('jake-uninstall-' + [System.Guid]::NewGuid().ToString('N'))
$run = Start-Process -FilePath $Exe -ArgumentList $arguments -Wait -PassThru -NoNewWindow -RedirectStandardOutput "$said.out" -RedirectStandardError "$said.err"
foreach ($file in @("$said.out", "$said.err")) {
  if (Test-Path -LiteralPath $file) {
    Get-Content -LiteralPath $file | ForEach-Object { Write-Host $_ }
    Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
  }
}
if ($run.ExitCode -ne 0) { throw "jake.exe uninstall ended with $($run.ExitCode)" }
