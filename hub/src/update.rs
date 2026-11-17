// Ordering an installed agent onto the agent build the hub's release carries.

use std::path::Path;

use serde_json::Map;

use crate::core::ExecParams;

/// The file of an agent build that names the version stamped into its binaries.
pub const VERSION_FILE: &str = "version.txt";

/// How long the hub leaves an agent it ordered before ordering it again, so a build that cannot reach
/// a machine is retried rather than ordered in a loop.
pub const RETRY_AFTER_MS: i64 = 60 * 60 * 1000;

/// The Windows task the update runs under, which deletes itself once it is done.
const WINDOWS_TASK: &str = "JakeUpdate";
/// The transient user unit the Linux update runs under, outside the agent's own unit.
const LINUX_UNIT: &str = "jake-update";
/// How long the runner gives the agent's command to end before it stops the agent.
const SETTLE_SECONDS: u32 = 5;
/// How often, and how many times, the runner asks the download for the version it was ordered onto.
const POLL_SECONDS: u32 = 10;
const POLLS: u32 = 60;

/// The agent build a release carries, and the address the agents download it from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentBuild {
  pub version: String,
  pub download_url: String,
}

impl AgentBuild {
  /// The build in `dir`, named by its version file.
  pub fn read(dir: &Path, download_url: &str) -> Result<Self, String> {
    let path = dir.join(VERSION_FILE);
    let text = std::fs::read_to_string(&path).map_err(|error| format!("{}: {error}", path.display()))?;
    let version = text.trim();
    if version.is_empty() {
      return Err(format!("{} names no version", path.display()));
    }
    Ok(Self {
      version: version.to_owned(),
      download_url: download_url.trim_end_matches('/').to_owned(),
    })
  }

  /// The command that moves an agent onto this build; none where the agent runs it already, is no
  /// installed build, or offers no shell this build has a binary for.
  pub fn order(&self, agent_version: &str, capabilities: &[String]) -> Option<ExecParams> {
    if agent_version == self.version || !is_installed_build(agent_version) {
      return None;
    }
    let host = Host::of(capabilities)?;
    Some(ExecParams {
      shell: host.shell().to_owned(),
      command: host.command(self),
      cwd: None,
      env: Map::new(),
      distro: None,
    })
  }
}

/// Whether a version is one the install's build stamps: it carries the commit, as `+g<hash>`. The
/// desktop app's built-in agent and an unstamped development build announce none.
fn is_installed_build(version: &str) -> bool {
  version.contains("+g")
}

/// The kind of machine an agent runs on, told by the shells it offers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Host {
  Windows,
  Linux,
}

impl Host {
  fn of(capabilities: &[String]) -> Option<Self> {
    let offers = |shell: &str| capabilities.iter().any(|capability| capability == shell);
    if offers("exec:powershell") {
      Some(Self::Windows)
    } else if offers("exec:linux") {
      Some(Self::Linux)
    } else {
      None
    }
  }

  fn shell(self) -> &'static str {
    match self {
      Self::Windows => "powershell",
      Self::Linux => "linux",
    }
  }

  fn command(self, build: &AgentBuild) -> String {
    match self {
      Self::Windows => windows_command(build),
      Self::Linux => linux_command(build),
    }
  }
}

/// A string as one POSIX shell word.
fn sh_quote(value: &str) -> String {
  format!("'{}'", value.replace('\'', "'\\''"))
}

/// A string as one PowerShell single-quoted literal.
fn ps_quote(value: &str) -> String {
  format!("'{}'", value.replace('\'', "''"))
}

/// What the Linux runner does: wait for the agent's command to end, leave a machine with no installed
/// agent alone, wait for the download to offer the build, then run the install in its update mode.
fn linux_runner(build: &AgentBuild) -> String {
  format!(
    r#"base={base}
want={want}
log="$HOME/.local/share/jake/update.log"
say() {{ printf '%s %s\n' "$(date -Iseconds)" "$1" >> "$log"; }}
fetch() {{ if command -v curl >/dev/null 2>&1; then curl -fsSL "$1"; else wget -qO- "$1"; fi; }}
sleep {SETTLE_SECONDS}
if ! systemctl --user is-active --quiet jake-agent.service; then
  say 'no installed agent runs here, so nothing was updated'
  exit 0
fi
published=''
tries=0
while [ "$tries" -lt {POLLS} ]; do
  published="$(fetch "$base/{VERSION_FILE}" 2>/dev/null | tr -d '[:space:]')"
  [ "$published" = "$want" ] && break
  tries=$((tries + 1))
  sleep {POLL_SECONDS}
done
if [ "$published" != "$want" ]; then
  say "the download offers ${{published:-nothing}}, not $want, so nothing was updated"
  exit 1
fi
installer="$(mktemp)"
if ! fetch "$base/install.sh" > "$installer"; then
  say 'the install script could not be downloaded'
  rm -f "$installer"
  exit 1
fi
say "updating to $want"
bash "$installer" --update >> "$log" 2>&1
code=$?
rm -f "$installer"
say "the install ended with exit $code"
exit "$code""#,
    base = sh_quote(&build.download_url),
    want = sh_quote(&build.version),
  )
}

/// The Linux order: the runner handed to a transient unit of the user's service manager.
fn linux_command(build: &AgentBuild) -> String {
  format!(
    "systemd-run --user --collect --unit {LINUX_UNIT} /bin/sh -c {}",
    sh_quote(&linux_runner(build))
  )
}

/// What the Windows runner does, as the Linux one, from the folder the running agent was installed
/// in; it deletes its own task whatever happened.
fn windows_runner(build: &AgentBuild) -> String {
  format!(
    r#"$ErrorActionPreference = 'Stop'
$base = {base}
$want = {want}
$log = Join-Path $env:LOCALAPPDATA 'jake\update.log'
function Say($message) {{ Add-Content -LiteralPath $log -Value ((Get-Date -Format o) + ' ' + $message) -Encoding UTF8 }}
try {{
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  Start-Sleep -Seconds {SETTLE_SECONDS}
  $running = Get-Process -Name 'jake' -ErrorAction SilentlyContinue | Where-Object {{ $_.Path }} | Select-Object -First 1
  if (-not $running) {{ Say 'no installed agent runs here, so nothing was updated'; return }}
  $installDir = Split-Path -Parent $running.Path
  $web = New-Object System.Net.WebClient
  $published = ''
  for ($i = 0; $i -lt {POLLS}; $i++) {{
    try {{ $published = $web.DownloadString("$base/{VERSION_FILE}").Trim() }} catch {{ $published = '' }}
    if ($published -eq $want) {{ break }}
    Start-Sleep -Seconds {POLL_SECONDS}
  }}
  if ($published -ne $want) {{ Say "the download offers '$published', not $want, so nothing was updated"; return }}
  $work = Join-Path ([System.IO.Path]::GetTempPath()) ('jake-update-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $work | Out-Null
  $installer = Join-Path $work 'install.ps1'
  $web.DownloadFile("$base/install.ps1", $installer)
  Say "updating $installDir to $want"
  $ErrorActionPreference = 'Continue'
  & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $installer -Update -InstallDir $installDir 2>&1 | Out-File -LiteralPath $log -Append -Encoding UTF8
  Say "the install ended with exit $LASTEXITCODE"
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}} catch {{
  Say "the update failed: $_"
}} finally {{
  Unregister-ScheduledTask -TaskName '{WINDOWS_TASK}' -Confirm:$false -ErrorAction SilentlyContinue
}}"#,
    base = ps_quote(&build.download_url),
    want = ps_quote(&build.version),
  )
}

/// The Windows order: the runner written beside the agent's log and handed to a one-shot task,
/// registered like the agent's own anchors, per-user and non-elevated, and started at once.
fn windows_command(build: &AgentBuild) -> String {
  format!(
    r#"$ErrorActionPreference = 'Stop'
$dir = Join-Path $env:LOCALAPPDATA 'jake'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$runner = Join-Path $dir 'update.ps1'
[System.IO.File]::WriteAllText($runner, @'
{runner}
'@)
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $runner + '"')
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
Register-ScheduledTask -TaskName '{WINDOWS_TASK}' -Action $action -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName '{WINDOWS_TASK}'
'the update to {version} is handed to the {WINDOWS_TASK} task'"#,
    runner = windows_runner(build),
    version = build.version.replace('\'', "''"),
  )
}

#[cfg(test)]
mod tests {
  use super::*;

  fn build() -> AgentBuild {
    AgentBuild {
      version: "0.1.0+gabc1234".into(),
      download_url: "https://example.test/jake".into(),
    }
  }

  fn offers(capabilities: &[&str]) -> Vec<String> {
    capabilities.iter().map(|capability| (*capability).to_owned()).collect()
  }

  #[test]
  fn the_build_is_read_from_its_version_file_and_the_address_loses_a_trailing_slash() {
    let dir = std::env::temp_dir().join(format!("jake-agent-build-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("made");
    std::fs::write(dir.join(VERSION_FILE), "0.1.0+gabc1234\n").expect("written");
    let read = AgentBuild::read(&dir, "https://example.test/jake/");
    let empty = std::fs::write(dir.join(VERSION_FILE), " \n").map(|()| AgentBuild::read(&dir, "x"));
    std::fs::remove_dir_all(&dir).expect("removed");
    assert_eq!(read, Ok(build()));
    assert!(empty.expect("written").is_err());
  }

  #[test]
  fn an_agent_running_the_build_or_no_installed_build_is_not_ordered() {
    let linux = offers(&["exec:linux", "transfer"]);
    assert!(build().order("0.1.0+gabc1234", &linux).is_none());
    assert!(build().order("desktop-0.1.0", &linux).is_none());
    assert!(build().order("0.1.0", &linux).is_none());
    assert!(build().order("0.1.0+g0000000", &offers(&["transfer"])).is_none());
  }

  #[test]
  fn a_linux_agent_is_ordered_through_its_shell_onto_a_transient_unit() {
    let order = build().order("0.1.0+g0000000", &offers(&["exec:linux", "stream:22"])).expect("ordered");
    assert_eq!(order.shell, "linux");
    assert!(
      order
        .command
        .starts_with("systemd-run --user --collect --unit jake-update /bin/sh -c '")
    );
    assert!(order.command.contains("want='\\''0.1.0+gabc1234'\\''"));
    assert!(order.command.contains("bash \"$installer\" --update"));
  }

  #[test]
  fn a_windows_agent_is_ordered_through_powershell_onto_a_task_that_deletes_itself() {
    let order = build()
      .order("0.1.0+g0000000", &offers(&["exec:powershell", "exec:wsl"]))
      .expect("ordered");
    assert_eq!(order.shell, "powershell");
    assert!(order.command.contains("Register-ScheduledTask -TaskName 'JakeUpdate'"));
    assert!(order.command.contains("Start-ScheduledTask -TaskName 'JakeUpdate'"));
    assert!(order.command.contains("$want = '0.1.0+gabc1234'"));
    assert!(order.command.contains("-Update -InstallDir $installDir"));
    assert!(order.command.contains("Unregister-ScheduledTask -TaskName 'JakeUpdate'"));
  }
}
