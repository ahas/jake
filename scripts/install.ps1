<#
.SYNOPSIS
  Install the jake agent (a bmo agent proxy) for the current user, non-elevated.

.DESCRIPTION
  Two ways in, one script. The one-liner `powershell -c "irm <base>/install.ps1 | iex"` downloads the
  executable from the same base and installs it; run from inside the build folder it ships in it
  installs the executable sitting beside it. Either way it copies the executable to a per-user
  location, writes the hub URL and shared secret you give it into the config file beside it, registers
  the three per-user autostart anchors for both run modes (the agent and its guard), starts the pair,
  and then reports whether the agent reached the hub. No administrator rights are needed.

  jake is one executable run two ways: the agent carries the tunnel and runs PowerShell and WSL
  commands and moves files, and the guard is a small supervisor that watches the agent and brings it
  back. Both run from the same jake.exe, the guard with a flag. Nothing else is installed.

  It is safe to run again over an existing install: the anchors are overwritten in place rather than
  duplicated, a running pair is stopped before its exe is replaced and started again afterwards, and
  your tuning keys in agent.env are preserved.

  The credential you enter lives only in the config file this writes on your machine. It is never in
  the repository and never compiled into the executable.

.PARAMETER HubUrl
  The hub to dial. Prompted for if omitted; an empty answer takes the hub of the deployment that published
  this script, and a copy no deployment published has no such default.

.PARAMETER Secret
  The shared secret, matching the hub's JAKE_SECRET. Prompted for (hidden) if omitted.

.PARAMETER AgentName
  This agent's identity. Prompted for if omitted.

.PARAMETER StreamPorts
  The local ports a byte stream from the hub may reach, comma-separated, or none. Left out, agent.env
  keeps what it has, and the agent's default is 22, this machine's OpenSSH server.

.PARAMETER SshKey
  A public key to add to this user's ~\.ssh\authorized_keys, so ssh over the hub logs in with it.

.PARAMETER InstallDir
  Where to install. Defaults to %LOCALAPPDATA%\Programs\jake (a per-user, space-free location).

.PARAMETER NonInteractive
  Never prompt. Requires Secret and AgentName to be passed as arguments or already in agent.env;
  HubUrl falls back to the default.

.PARAMETER Replace
  Where another jake already serves this machine, a WSL install of it among them, run that install's own
  uninstaller first rather than refuse (INSTALL.md, One jake per machine).

.PARAMETER Update
  An unattended update: never prompt, and put the previous executable back where the new one does not
  reach the hub, ending with an error. Whatever fails once the pair is stopped, the install leaves an
  executable in place and starts the pair again before it ends.
#>
[CmdletBinding()]
param(
  [string]$HubUrl,
  [string]$Secret,
  [string]$AgentName,
  [string]$StreamPorts,
  [string]$SshKey,
  [string]$InstallDir = "$env:LOCALAPPDATA\Programs\jake",
  [switch]$NonInteractive,
  [switch]$Replace,
  [switch]$Update
)

$ErrorActionPreference = 'Stop'
if ($Update) { $NonInteractive = $true }

# The download address and the hub the deployment that publishes this script writes in (docs/install.md,
# 「Where the agent comes from」); a copy no deployment published names neither, and asks for the hub.
$Base = '@JAKE_AGENT_DOWNLOAD_URL@'
$DefaultHubUrl = '@JAKE_PUBLIC_URL@'
if ($Base -like '@*@') { $Base = '' }
if ($DefaultHubUrl -like '@*@') { $DefaultHubUrl = '' }
$Binary = 'jake.exe'
$AgentAnchor = 'JakeAgent'
$GuardAnchor = 'JakeGuard'
$GuardFlag = '--guard'
$RunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$StartupDir = [Environment]::GetFolderPath('Startup')
$LogPath = Join-Path $env:LOCALAPPDATA 'jake\agent.log'
$PreviousBinary = 'jake.previous.exe'
$IncomingBinary = 'jake.new.exe'
# How long the agent is given to report reaching the hub once it has written its first line, and how
# long to write that line: longer for an update, which puts the previous executable back where the new
# one does not, and whose freshly written executable may be held at its launch by a first scan.
# JAKE_INSTALL_WAIT_SECONDS sets both outright.
$WaitSeconds = if ($Update) { 30 } else { 15 }
$StartSeconds = if ($Update) { 120 } else { 15 }
if ($env:JAKE_INSTALL_WAIT_SECONDS) {
  $WaitSeconds = [int]$env:JAKE_INSTALL_WAIT_SECONDS
  $StartSeconds = $WaitSeconds
}
# How long a stopped process is given to exit.
$ExitSeconds = 120

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

function Resolve-Value($current, $key, $prompt, [switch]$secret, $fallback) {
  if ($current) { return $current }
  $default = Get-EnvValue $existingEnv $key
  if ($NonInteractive) {
    if ($default) { return $default }
    if ($fallback) { return $fallback }
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
  $label = if ($default) { "$prompt [$default]" } elseif ($fallback) { "$prompt [default: $fallback]" } else { $prompt }
  $answer = Read-Host -Prompt $label
  if ($answer) { return $answer }
  if ($default) { return $default }
  if ($fallback) { return $fallback }
  throw "$key is required."
}

Write-Host "jake agent installer" -ForegroundColor White

if ($StreamPorts -and $StreamPorts -notmatch '^(none|[0-9]{1,5}(,[0-9]{1,5})*)$') {
  throw "-StreamPorts takes port numbers separated by commas, or none (got $StreamPorts)"
}

# Resolve the payload: the build folder this script sits in, or a temp folder downloaded from the base
# when the script is run through the one-liner (irm | iex), where there is no build folder beside it.
$TempPayload = $null
if ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot $Binary))) {
  $Payload = $PSScriptRoot
} else {
  if (-not $Base) {
    throw "This copy of the installer was not published by a hub's deployment, so it names no download address: run the install.ps1 your hub's download address serves, or this one from a build folder."
  }
  Write-Step "downloading the agent from $Base"
  $TempPayload = Join-Path ([System.IO.Path]::GetTempPath()) ("jake-install-" + [System.Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $TempPayload | Out-Null
  Invoke-WebRequest -Uri "$Base/$Binary" -OutFile (Join-Path $TempPayload $Binary) -UseBasicParsing
  foreach ($name in @('uninstall.ps1', 'agent.env.example', 'INSTALL.md')) {
    try { Invoke-WebRequest -Uri "$Base/$name" -OutFile (Join-Path $TempPayload $name) -UseBasicParsing } catch { }
  }
  $Payload = $TempPayload
}
if (-not (Test-Path (Join-Path $Payload $Binary))) {
  throw "Could not find or download $Binary."
}

$HubUrl    = Resolve-Value $HubUrl    'JAKE_HUB_URL'    'Hub URL' -fallback $DefaultHubUrl
$Secret    = Resolve-Value $Secret    'JAKE_SECRET'     'Shared secret' -secret
$AgentName = Resolve-Value $AgentName 'JAKE_AGENT_NAME' 'Agent name'

# --- the pair, the executable and the anchors ---------------------------------------------------

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$Exe = Join-Path $InstallDir $Binary
$Previous = Join-Path $InstallDir $PreviousBinary
$Incoming = Join-Path $InstallDir $IncomingBinary

# Whether the pair is stopped and not yet started again, which an install must never end with; held in
# a table so the functions below change the one the script reads, whatever scope the script runs in.
$Pair = @{ Down = $false }

# Stop every jake process and wait for each to exit: a killed process holds its executable, and its
# task's instance refuses a new start, until it has exited, which Stop-Process does not wait for.
function Stop-Pair {
  $Pair.Down = $true
  $running = @(Get-Process -Name 'jake' -ErrorAction SilentlyContinue)
  foreach ($process in $running) { try { $process | Stop-Process -Force } catch { } }
  foreach ($process in $running) { try { $null = $process.WaitForExit($ExitSeconds * 1000) } catch { } }
}

# Start both run modes through their logon tasks, as the watchdog relaunches a peer, so Task Scheduler
# owns both and they outlive whatever ran this install, a scheduled update among them. A run mode whose
# task cannot be started is launched directly instead.
function Start-Pair {
  foreach ($run in @(@{ Task = $AgentAnchor; Arguments = '' }, @{ Task = $GuardAnchor; Arguments = $GuardFlag })) {
    try {
      Start-ScheduledTask -TaskName $run.Task
    } catch {
      Write-Warn2 "the $($run.Task) task could not be started ($_), so it is launched directly"
      if ($run.Arguments) {
        Start-Process -FilePath $Exe -ArgumentList $run.Arguments -WorkingDirectory $InstallDir
      } else {
        Start-Process -FilePath $Exe -WorkingDirectory $InstallDir
      }
    }
  }
  $Pair.Down = $false
}

# Put the file at $source in $target's place. The file in place is renamed aside rather than
# overwritten, which Windows allows even while that file still runs, and is renamed back where the move
# fails, so $target is never left empty.
function Replace-File($source, $target) {
  $aside = $null
  if (Test-Path -LiteralPath $target) {
    $aside = "$target." + [System.Guid]::NewGuid().ToString('N') + '.old'
    Move-Item -LiteralPath $target -Destination $aside
  }
  try {
    Move-Item -LiteralPath $source -Destination $target
  } catch {
    if ($aside) { Move-Item -LiteralPath $aside -Destination $target }
    throw
  }
  if ($aside) { Remove-Item -LiteralPath $aside -Force -ErrorAction SilentlyContinue }
}

# Leave an executable in place where a failed swap left none: the previous build where there is one,
# else the incoming one, copied so the file it comes from stays whatever stopped it from moving.
function Restore-Executable {
  if (Test-Path -LiteralPath $Exe) { return }
  foreach ($candidate in @($Previous, $Incoming)) {
    if (Test-Path -LiteralPath $candidate) {
      Copy-Item -LiteralPath $candidate -Destination $Exe -Force
      return
    }
  }
}

function Get-LogSize {
  if (Test-Path $LogPath) { return (Get-Item $LogPath).Length }
  return 0
}

# What the log gained since the mark; a log shorter than the mark was rotated, and is read whole.
function Read-LogSince($logMark) {
  if (-not (Test-Path $LogPath)) { return '' }
  $fs = [System.IO.File]::Open($LogPath, 'Open', 'Read', 'ReadWrite')
  try {
    if ($fs.Length -ge $logMark) { $fs.Position = $logMark }
    $reader = New-Object System.IO.StreamReader($fs)
    return $reader.ReadToEnd()
  } finally { $fs.Close() }
}

# Read what the log gains since the mark: whether the agent reached the hub, or why not. The agent is
# given $StartSeconds to write its first line, and $WaitSeconds from that line to reach the hub.
function Wait-ForHub($logMark) {
  $failure = $null
  $startedAt = $null
  for ($i = 0; ; $i++) {
    if ($i -gt 0) { Start-Sleep -Seconds 1 }
    $tail = Read-LogSince $logMark
    if ($tail -match '"event":"welcomed"') { return @{ Reached = $true; Failure = $null } }
    if ($tail -match 'machine held by another agent') { return @{ Reached = $false; Failure = "another jake holds this machine (see INSTALL.md, One jake per machine)" } }
    if ($tail -match '"event":"rejected"') { return @{ Reached = $false; Failure = "the hub rejected the agent (the shared secret or the agent name is wrong)" } }
    if ($tail -match '"event":"dial-failed"') { $failure = "the agent could not reach the hub (check the hub URL and that the hub is running)" }
    if ($null -eq $startedAt -and $tail -match '"event":"agent-starting"') { $startedAt = $i }
    $limit = if ($null -ne $startedAt) { $startedAt + $WaitSeconds } else { $StartSeconds }
    if ($i -ge $limit) { break }
  }
  if ($null -eq $startedAt) { $failure = "the agent did not start within $StartSeconds seconds" }
  return @{ Reached = $false; Failure = $failure }
}

# --- one jake per machine (INSTALL.md, One jake per machine) --------------------------------------
# One PC carries one jake agent whatever its names: this Windows install and an install in one of its WSL
# distributions are two agents of one machine. Before anything is stopped or written, the install looks for
# another and refuses to add a second, unless -Replace has the other's own uninstaller run first. An update
# refreshes the install already here, so it looks at none of this.

# The one look into WSL: the default distribution's name, the agent its jake install names where its unit is
# registered, and the TCP ports listening there, all from one wsl.exe call, since every start of a WSL program
# costs Windows dearly. The script goes over as base64, so no quoting stands between PowerShell and the shell.
# Refuse before anything is written: a downloaded payload is removed, and the install ends with why.
function Stop-Install($message) {
  if ($TempPayload -and (Test-Path $TempPayload)) {
    Remove-Item -LiteralPath $TempPayload -Recurse -Force -ErrorAction SilentlyContinue
  }
  throw $message
}

function Read-WslSide {
  $side = @{ Distribution = $null; Agent = $null; Listening = @{} }
  if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) { return $side }
  $script = @'
printf 'distribution=%s\n' "$WSL_DISTRO_NAME"
unit="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/jake-agent.service"
config="$HOME/.local/share/jake/agent.env"
if [ -f "$unit" ] && [ -f "$config" ]; then printf 'jake=%s\n' "$(sed -n 's/^[[:space:]]*JAKE_AGENT_NAME=//p' "$config" | head -n 1 | tr -d "\"'")"; fi
ss -ltnpH 2>/dev/null | while read -r state recv send local peer rest; do printf 'listen=%s %s\n' "${local##*:}" "$(printf '%s' "$rest" | sed -n 's/.*users:(("\([^"]*\)".*/\1/p')"; done
'@
  $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($script.Replace("`r", '')))
  try { $lines = @(& wsl.exe -e sh -c "echo $encoded | base64 -d | sh" 2>$null) } catch { return $side }
  foreach ($line in $lines) {
    $t = "$line".Trim()
    if ($t.StartsWith('distribution=')) { $side.Distribution = $t.Substring(13) }
    elseif ($t.StartsWith('jake=') -and $t.Length -gt 5) { $side.Agent = $t.Substring(5) }
    elseif ($t.StartsWith('listen=')) {
      $parts = $t.Substring(7).Split(' ', 2)
      $side.Listening[$parts[0]] = $(if ($parts.Count -gt 1) { $parts[1] } else { '' })
    }
  }
  return $side
}

# The hub's answer: the new executable, where it still stands in the payload, reads this machine's fingerprint and
# asks which attached agent holds it, with the values being installed laid over its environment for that run alone.
function Read-HubHolder {
  $values = @{ JAKE_HUB_URL = $HubUrl; JAKE_SECRET = $Secret; JAKE_AGENT_NAME = $AgentName }
  $saved = @{}
  foreach ($key in $values.Keys) {
    $saved[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
    [Environment]::SetEnvironmentVariable($key, $values[$key], 'Process')
  }
  try {
    $check = @(& (Join-Path $Payload $Binary) --machine-check 2>$null | ForEach-Object { "$_".Trim() })
  } catch {
    $check = @()
  } finally {
    foreach ($key in $saved.Keys) { [Environment]::SetEnvironmentVariable($key, $saved[$key], 'Process') }
  }
  $unanswered = $check | Where-Object { $_.StartsWith('hub=unanswered ') } | Select-Object -First 1
  if ($unanswered) { Write-Warn2 "the hub could not say whether another jake holds this machine: $($unanswered.Substring(15))" }
  $held = $check | Where-Object { $_.StartsWith('held-by=') } | Select-Object -First 1
  if ($held) { return $held.Substring(8) }
  return $null
}

$WslSide = $null
if (-not $Update) {
  Write-Step "looking for another jake on this machine"
  $WslSide = Read-WslSide
  $others = @()
  if ($WslSide.Agent) {
    $others += @{ Where = "a WSL install in $($WslSide.Distribution)"; Name = $WslSide.Agent; Distribution = $WslSide.Distribution }
  }
  $desktopSettings = if ($env:APPDATA) { Join-Path $env:APPDATA 'io.ahas.jake.desktop\settings.json' } else { $null }
  if ($desktopSettings -and (Test-Path -LiteralPath $desktopSettings) -and ((Get-Content -Raw -LiteralPath $desktopSettings) -match '"consoleUrl"')) {
    Write-Warn2 "the BMO desktop app is set up here ($desktopSettings); it keeps its own agent off beside an installed jake it sees, and the hub names it below where its agent is attached"
  }
  $holder = Read-HubHolder
  # This install, attached under the name it had before, is the one being replaced in place.
  $ownName = Get-EnvValue $existingEnv 'JAKE_AGENT_NAME'
  if ($holder -and $holder -ne $AgentName -and $holder -ne $ownName -and -not ($others | Where-Object { $_.Name -eq $holder })) {
    $others += @{ Where = 'an agent the hub says holds this machine'; Name = $holder; Distribution = $null }
  }
  if ($others.Count -eq 0) {
    Write-Ok "none found"
  } else {
    foreach ($other in $others) { Write-Warn2 "$($other.Where): $($other.Name)" }
    $first = $others[0].Name
    if (-not $Replace) {
      Stop-Install "another jake already serves this machine as $first, and one machine carries one jake. Either join it: install nothing here, since this machine is $first's node, and ask the BMO administrator to bind your account to $first as a shared node. Or replace it: run this install again with -Replace, which runs its own uninstaller first."
    }
    foreach ($other in $others) {
      if (-not $other.Distribution) {
        Stop-Install "$($other.Name) holds this machine from where this install cannot reach it, a WSL distribution other than the default or the BMO desktop app: run its own uninstaller there (~/.local/share/jake/jake uninstall in that distribution), or quit the desktop app, then run this install again."
      }
      Write-Step "removing $($other.Name) through its own uninstaller"
      # The name found there goes with it, so an install that has taken its place meanwhile is refused.
      & wsl.exe -d $other.Distribution -e bash -c '"$HOME/.local/share/jake/jake" uninstall --name "$1" --yes' jake $other.Name
      if ($LASTEXITCODE -ne 0) { Stop-Install "$($other.Name) in $($other.Distribution) could not be removed: its uninstaller ended with $LASTEXITCODE." }
      Write-Ok "removed"
    }
  }

  # --- the ports the agent listens on (INSTALL.md, Ports) ---------------------------------------
  # The agent listens only on JAKE_LISTEN_PORTS. A port something else already listens on, on Windows or in
  # WSL, which shares or is forwarded Windows' loopback, stops the install rather than being taken; this
  # install's own running agent is not counted.
  $listenPorts = Get-EnvValue $existingEnv 'JAKE_LISTEN_PORTS'
  if ($listenPorts -and $listenPorts -ne 'none') {
    Write-Step "checking that nothing else listens on $listenPorts"
    foreach ($port in $listenPorts.Split(',')) {
      $port = $port.Trim()
      $held = Get-NetTCPConnection -State Listen -LocalPort ([int]$port) -ErrorAction SilentlyContinue |
        ForEach-Object { Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue } |
        Where-Object { -not ($_.Name -eq 'jake' -and $_.Path -eq $Exe) } | Select-Object -First 1
      if ($held) { Stop-Install "port $port is already held on this machine by $($held.Name); an install never takes a port another program holds. Free it, or take it out of JAKE_LISTEN_PORTS in $existingEnv." }
      if ($WslSide.Listening.ContainsKey($port)) {
        $program = $WslSide.Listening[$port]
        if (-not $program) { $program = 'another program' }
        Stop-Install "port $port is already held in WSL ($($WslSide.Distribution)) by $program; an install never takes a port another program holds. Free it, or take it out of JAKE_LISTEN_PORTS in $existingEnv."
      }
    }
  }
}

# --- stage the payload beside the executable, while the pair still runs ---------------------------

Write-Step "installing to $InstallDir"
# An executable renamed aside by an earlier install is removed once nothing runs it any more.
Get-ChildItem -LiteralPath $InstallDir -Filter "$Binary.*.old" -ErrorAction SilentlyContinue |
  Remove-Item -Force -ErrorAction SilentlyContinue
Copy-Item -LiteralPath (Join-Path $Payload $Binary) -Destination $Incoming -Force
if ($Update -and (Test-Path -LiteralPath $Exe)) {
  Copy-Item -LiteralPath $Exe -Destination $Previous -Force
}
foreach ($name in @('agent.env.example', 'uninstall.ps1', 'INSTALL.md')) {
  $src = Join-Path $Payload $name
  if (Test-Path $src) { Copy-Item -LiteralPath $src -Destination $InstallDir -Force }
}
if ($TempPayload -and (Test-Path $TempPayload)) {
  Remove-Item -LiteralPath $TempPayload -Recurse -Force -ErrorAction SilentlyContinue
}

# From here the pair is stopped, and whatever fails, the install ends with an executable in place and the
# pair started again.
try {
  Write-Step "stopping any running agent"
  Stop-Pair

  try {
    Replace-File $Incoming $Exe
  } catch {
    throw "the new build could not be put in place: $_"
  }
  Write-Ok "executable in place"

  # --- write agent.env, preserving any existing tuning keys -------------------------------------

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
  if ($StreamPorts) { Set-EnvKey $lines 'JAKE_STREAM_PORTS' $StreamPorts }
  # Windows PowerShell's UTF8 encoding writes a byte order mark, so the file is written through .NET
  # without one; .NET resolves a relative path against the process directory, so it gets the full path.
  $envFullPath = Join-Path (Resolve-Path -LiteralPath $InstallDir).ProviderPath 'agent.env'
  [System.IO.File]::WriteAllLines($envFullPath, $lines, (New-Object System.Text.UTF8Encoding $false))
  Write-Ok "config written (credential stays on this machine only)"

  # --- the SSH side of a byte stream: the key it logs in with, and an sshd to answer -------------

  if ($SshKey) {
    Write-Step "adding the SSH key to ~\.ssh\authorized_keys"
    $sshDir = Join-Path $env:USERPROFILE '.ssh'
    $keys = Join-Path $sshDir 'authorized_keys'
    New-Item -ItemType Directory -Force -Path $sshDir | Out-Null
    if ((Test-Path $keys) -and ((Get-Content -LiteralPath $keys) -contains $SshKey)) {
      Write-Ok "the key was already there"
    } else {
      Add-Content -LiteralPath $keys -Value $SshKey -Encoding ascii
      Write-Ok "key added"
    }
    # OpenSSH reads an administrator's keys from one machine-wide file instead, which needs elevation.
    $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
      [Security.Principal.WindowsBuiltInRole]::Administrator) -or
      ((whoami /groups) -match 'S-1-5-32-544')
    if ($admin) {
      Write-Warn2 "this account is an administrator, so OpenSSH reads its keys from C:\ProgramData\ssh\administrators_authorized_keys; add the key there from an elevated PowerShell (see INSTALL.md)."
    }
  }

  $ports = Get-EnvValue $envPath 'JAKE_STREAM_PORTS'
  if (-not $ports) { $ports = '22' }
  if ($ports -ne 'none') {
    foreach ($port in $ports.Split(',')) {
      $probe = New-Object System.Net.Sockets.TcpClient
      try { $answered = $probe.ConnectAsync('127.0.0.1', [int]$port).Wait(1000) } catch { $answered = $false } finally { $probe.Dispose() }
      if (-not $answered) {
        Write-Warn2 "nothing answers on port $port here, so a stream to it will fail. For ssh, install and start the OpenSSH server (see INSTALL.md)."
      }
    }
  }

  # --- register the three anchors for both run modes --------------------------------------------
  # These mirror the agent's own anchor commands exactly, so the watchdog's per-tick rewrite keeps the
  # same registrations rather than competing with them: a per-user Run value, a scheduled task started
  # at logon and on a repeating trigger with no stored credentials at the limited run level, and a
  # Startup-folder shortcut.
  # All three are per-user and need no elevation. Overwriting in place is what makes a re-run add no
  # duplicates. The guard run mode launches the same exe with the guard flag.

  function Register-Anchor($name, $exe, $arguments, $workingDir) {
    # Run key: value data is the quoted exe path plus any argument, as the watchdog writes it. The key
    # itself is created only if absent — it normally already holds other apps' entries, which stay.
    if (-not (Test-Path $RunKey)) { New-Item -Path $RunKey -Force | Out-Null }
    $data = if ($arguments) { '"' + $exe + '" ' + $arguments } else { '"' + $exe + '"' }
    New-ItemProperty -Path $RunKey -Name $name -Value $data -PropertyType String -Force | Out-Null

    # Scheduled task: started at logon and every five minutes from now on with no end, so Task
    # Scheduler itself brings back a pair that died together while this user stays logged on, a start
    # while the run mode runs being dropped; started again up to three times a minute apart after a
    # run it counts as failed. Self-owned (current user, interactive token, no stored password),
    # limited run level, starting and running on battery and with no run-time limit, since the default
    # of three days would end both run modes together. The exe path and argument pass as values rather
    # than through fragile native-command quoting.
    if ($arguments) {
      $action = New-ScheduledTaskAction -Execute $exe -Argument $arguments
    } else {
      $action = New-ScheduledTaskAction -Execute $exe
    }
    $logon = New-ScheduledTaskTrigger -AtLogOn
    $repeat = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $name -Action $action -Trigger @($logon, $repeat) -Settings $settings -Principal $principal -Force | Out-Null

    # Startup shortcut: built through WScript.Shell, the same way the watchdog builds it.
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

  # --- start the pair and verify it reached the hub ---------------------------------------------

  Write-Step "starting the agent and guard"
  $logMark = Get-LogSize
  Start-Pair

  Write-Step "waiting for the agent to reach the hub"
  $outcome = Wait-ForHub $logMark
  $reached = $outcome.Reached
  $failure = $outcome.Failure

  # An update must leave the machine attached: a new executable that does not reach the hub gives way
  # to the previous one, and the update fails.
  if ($Update -and (Test-Path $Previous)) {
    if ($reached) {
      Remove-Item -LiteralPath $Previous -Force -ErrorAction SilentlyContinue
    } else {
      Write-Warn2 ("the new build did not reach the hub" + $(if ($failure) { ": $failure" } else { "" }))
      Write-Step "putting the previous build back"
      Stop-Pair
      try {
        Replace-File $Previous $Exe
      } catch {
        throw "the update did not take, and the previous build could not be put back: $_"
      }
      $logMark = Get-LogSize
      Start-Pair
      $outcome = Wait-ForHub $logMark
      if ($outcome.Reached) {
        throw "the update did not take; the previous build is back and connected to the hub."
      }
      throw "the update did not take; the previous build is back but has not connected yet: $($outcome.Failure)"
    }
  }
} finally {
  if ($Pair.Down) {
    Write-Warn2 "the install ended before it started the agent again, so it starts the agent and guard now"
    try { Restore-Executable } catch { Write-Warn2 "no executable could be put in place: $_" }
    try { Start-Pair } catch { Write-Warn2 "the agent and guard could not be started: $_" }
  }
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
Write-Host "To remove it later, run: & '$InstallDir\jake.exe' uninstall" -ForegroundColor White
