<#
.SYNOPSIS
  Install the jake remote-control agent for the current user, non-elevated.

.DESCRIPTION
  Run this from inside the folder it ships in (the build layout), in your own PowerShell session —
  no administrator rights are needed. It copies the executable to a per-user location, writes the hub
  URL and shared secret you give it into the config file beside it, registers the three per-user
  autostart anchors for both run modes (the agent and its guard), starts the pair, and then reports
  whether the agent reached the hub.

  jake is one executable run two ways: the agent carries the tunnel and every capability, and the
  guard is a small supervisor that watches the agent and brings it back. Both run from the same
  jake.exe, the guard with a flag. The browser capability drives Microsoft Edge, which is already on
  your machine — nothing extra is downloaded.

  It is safe to run again over an existing install: the anchors are overwritten in place rather than
  duplicated, a running pair is stopped before its exe is replaced and started again afterwards, and
  your tuning keys in agent.env are preserved.

  The credential you enter lives only in the config file this writes on your machine. It is never in
  the repository and never compiled into the executable.

.PARAMETER HubUrl
  The hub to dial, e.g. wss://jake.example.org . Prompted for if omitted.

.PARAMETER Secret
  The shared secret, matching the hub's JAKE_SECRET. Prompted for (hidden) if omitted.

.PARAMETER AgentName
  This agent's identity. Prompted for if omitted.

.PARAMETER InstallDir
  Where to install. Defaults to %LOCALAPPDATA%\Programs\jake (a per-user, space-free location).

.PARAMETER NonInteractive
  Never prompt. Requires HubUrl, Secret, and AgentName to be passed as arguments.
#>
[CmdletBinding()]
param(
  [string]$HubUrl,
  [string]$Secret,
  [string]$AgentName,
  [string]$InstallDir = "$env:LOCALAPPDATA\Programs\jake",
  [switch]$NonInteractive
)

$ErrorActionPreference = 'Stop'
$Payload = $PSScriptRoot

$Binary = 'jake.exe'
$AgentAnchor = 'JakeAgent'
$GuardAnchor = 'JakeGuard'
$GuardFlag = '--guard'
$RunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$StartupDir = [Environment]::GetFolderPath('Startup')
$LogPath = Join-Path $env:LOCALAPPDATA 'jake\agent.log'

function Write-Step($msg) { Write-Host "· $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  $msg" -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host "  ! $msg" -ForegroundColor Yellow }

# --- resolve config values ----------------------------------------------------------------------

# Read a KEY=value out of an existing agent.env so a re-run can offer the current value as default.
function Get-EnvValue($path, $key) {
  if (-not (Test-Path $path)) { return $null }
  foreach ($line in Get-Content -LiteralPath $path) {
    $t = $line.Trim()
    if ($t -eq '' -or $t.StartsWith('#')) { continue }
    $eq = $t.IndexOf('=')
    if ($eq -lt 1) { continue }
    if ($t.Substring(0, $eq).Trim() -eq $key) {
      $v = $t.Substring($eq + 1).Trim()
      if ($v.Length -ge 2 -and (($v.StartsWith('"') -and $v.EndsWith('"')) -or ($v.StartsWith("'") -and $v.EndsWith("'")))) {
        $v = $v.Substring(1, $v.Length - 2)
      }
      return $v
    }
  }
  return $null
}

$existingEnv = Join-Path $InstallDir 'agent.env'

function Resolve-Value($current, $key, $prompt, [switch]$secret) {
  if ($current) { return $current }
  $default = Get-EnvValue $existingEnv $key
  if ($NonInteractive) {
    if ($default) { return $default }
    throw "$key was not provided and -NonInteractive was set. Pass it as an argument."
  }
  if ($secret) {
    $label = if ($default) { "$prompt [press Enter to keep the current one]" } else { $prompt }
    $secure = Read-Host -Prompt $label -AsSecureString
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR(
      [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
    if ($plain) { return $plain }
    if ($default) { return $default }
    throw "$key is required."
  }
  $label = if ($default) { "$prompt [$default]" } else { $prompt }
  $answer = Read-Host -Prompt $label
  if ($answer) { return $answer }
  if ($default) { return $default }
  throw "$key is required."
}

Write-Host "jake agent installer" -ForegroundColor White
if (-not (Test-Path (Join-Path $Payload $Binary))) {
  throw "Run this from the folder that contains $Binary."
}

$HubUrl    = Resolve-Value $HubUrl    'JAKE_HUB_URL'    'Hub URL (e.g. wss://jake.example.org)'
$Secret    = Resolve-Value $Secret    'JAKE_SECRET'     'Shared secret' -secret
$AgentName = Resolve-Value $AgentName 'JAKE_AGENT_NAME' 'Agent name'

# --- stop any running pair (a running exe cannot be overwritten) ---------------------------------

Write-Step "stopping any running agent"
Get-Process -Name 'jake' -ErrorAction SilentlyContinue | ForEach-Object {
  try { $_ | Stop-Process -Force } catch { }
}
Start-Sleep -Milliseconds 500

# --- copy the payload into place ----------------------------------------------------------------

Write-Step "installing to $InstallDir"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
foreach ($name in @($Binary, 'nircmd.exe', 'agent.env.example', 'uninstall.ps1', 'INSTALL.md')) {
  $src = Join-Path $Payload $name
  if (Test-Path $src) { Copy-Item -LiteralPath $src -Destination $InstallDir -Force }
}
$Exe = Join-Path $InstallDir $Binary
Write-Ok "executable in place"

# --- write agent.env, preserving any existing tuning keys ---------------------------------------

Write-Step "writing agent.env"
$envPath = Join-Path $InstallDir 'agent.env'
if (Test-Path $envPath) {
  $lines = [System.Collections.Generic.List[string]](Get-Content -LiteralPath $envPath)
} else {
  $lines = [System.Collections.Generic.List[string]]@(
    '# jake agent configuration, written by the installer. The three required keys below are set;',
    '# every other key falls back to its built-in default. See agent.env.example for the full list.')
}
function Set-EnvKey([System.Collections.Generic.List[string]]$lines, $key, $value) {
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i].TrimStart().StartsWith("$key=")) { $lines[$i] = "$key=$value"; return }
  }
  $lines.Add("$key=$value")
}
Set-EnvKey $lines 'JAKE_HUB_URL' $HubUrl
Set-EnvKey $lines 'JAKE_SECRET' $Secret
Set-EnvKey $lines 'JAKE_AGENT_NAME' $AgentName
Set-Content -LiteralPath $envPath -Value $lines -Encoding UTF8
Write-Ok "config written (credential stays on this machine only)"

# --- register the three anchors for both run modes ----------------------------------------------
# These mirror src/agent/anchors.ts exactly, so the watchdog's per-tick rewrite maintains the same
# registrations rather than competing with them: a per-user Run value, a logon-triggered scheduled
# task with no stored credentials at the limited run level, and a Startup-folder shortcut. All three
# are per-user and need no elevation. Overwriting in place is what makes a re-run add no duplicates.
# The guard run mode launches the same exe with the guard flag.

function Register-Anchor($name, $exe, $arguments, $workingDir) {
  # Run key: value data is the quoted exe path plus any argument, as the watchdog writes it. The key
  # itself is created only if absent — it normally already holds other apps' entries, which stay.
  if (-not (Test-Path $RunKey)) { New-Item -Path $RunKey -Force | Out-Null }
  $data = if ($arguments) { '"' + $exe + '" ' + $arguments } else { '"' + $exe + '"' }
  New-ItemProperty -Path $RunKey -Name $name -Value $data -PropertyType String -Force | Out-Null

  # Scheduled task: logon-triggered, self-owned (current user, interactive token, no stored
  # password), limited run level. Equivalent to `schtasks /create /sc onlogon /rl limited /f`, which
  # the watchdog uses to maintain it and `schtasks /run` to relaunch it; created here via the cmdlets
  # to pass the exe path and argument as values rather than through fragile native-command quoting.
  if ($arguments) {
    $action = New-ScheduledTaskAction -Execute $exe -Argument $arguments
  } else {
    $action = New-ScheduledTaskAction -Execute $exe
  }
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null

  # Startup shortcut: built through WScript.Shell, the same way anchors.ts builds it.
  $lnk = Join-Path $StartupDir "$name.lnk"
  $shell = New-Object -ComObject WScript.Shell
  $sc = $shell.CreateShortcut($lnk)
  $sc.TargetPath = $exe
  if ($arguments) { $sc.Arguments = $arguments }
  $sc.WorkingDirectory = $workingDir
  $sc.Save()
}

Write-Step "registering autostart anchors"
Register-Anchor $AgentAnchor $Exe '' $InstallDir
Register-Anchor $GuardAnchor $Exe $GuardFlag $InstallDir
Write-Ok "anchors registered for the agent and the guard"

# --- start the pair and verify it reached the hub -----------------------------------------------

Write-Step "starting the agent and guard"
$logMark = 0
if (Test-Path $LogPath) { $logMark = (Get-Item $LogPath).Length }
Start-Process -FilePath $Exe -WorkingDirectory $InstallDir -WindowStyle Hidden
Start-Process -FilePath $Exe -ArgumentList $GuardFlag -WorkingDirectory $InstallDir -WindowStyle Hidden

Write-Step "waiting for the agent to reach the hub"
$reached = $false
$failure = $null
for ($i = 0; $i -lt 15; $i++) {
  Start-Sleep -Seconds 1
  if (-not (Test-Path $LogPath)) { continue }
  $fs = [System.IO.File]::Open($LogPath, 'Open', 'Read', 'ReadWrite')
  try {
    if ($fs.Length -gt $logMark) { $fs.Position = $logMark }
    $reader = New-Object System.IO.StreamReader($fs)
    $tail = $reader.ReadToEnd()
  } finally { $fs.Close() }
  if ($tail -match '"event":"welcomed"') { $reached = $true; break }
  elseif ($tail -match '"event":"rejected"') { $failure = "the hub rejected the agent (check the shared secret and agent name)"; break }
  elseif ($tail -match '"event":"dial-failed"') { $failure = "the agent could not reach the hub (check the hub URL and that the hub is running)" }
}

Write-Host ""
if ($reached) {
  Write-Host "Installed. The agent is connected to the hub." -ForegroundColor Green
} elseif ($failure) {
  Write-Host "Installed, but the agent has not connected: $failure" -ForegroundColor Yellow
  Write-Host "It will keep retrying. See the log at $LogPath" -ForegroundColor Yellow
} else {
  Write-Host "Installed. The agent has not reported a connection yet; it keeps retrying on its own." -ForegroundColor Yellow
  Write-Host "See the log at $LogPath" -ForegroundColor Yellow
}
Write-Host "To remove it later, run uninstall.ps1 from $InstallDir" -ForegroundColor White
