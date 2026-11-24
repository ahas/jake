// The agent's departure on a hub's leave: every part that keeps it running stopped, then every file removed.

use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

use serde_json::json;

use crate::command;
use crate::exec::tree_kill_command;
use crate::log::Log;
use crate::pair::{
  JAKE_BINARY, anchor_remove_commands, install_targets, powershell_command, ps_single_quote, read_number,
  task_run_command,
};
use crate::platform::{Platform, SYSTEMD_UNIT_NAME};

/// The one-shot task the Windows cleanup runs under; it deletes itself as its last act.
pub const DEPART_TASK_NAME: &str = "JakeDepart";

/// The transient unit the Linux teardown runs under, so stopping the agent's unit cannot kill it.
pub const DEPART_UNIT_NAME: &str = "jake-depart";

/// How long one teardown helper may take before the departure presses on without it.
const STEP_BOUND: Duration = Duration::from_secs(30);

/// A string as one POSIX shell word, so a path with spaces or quotes crosses `sh -c` intact.
fn sh_quote(value: &str) -> String {
  format!("'{}'", value.replace('\'', "'\\''"))
}

/// What the Linux teardown runs: the unit stopped and disabled so nothing restarts it, its file
/// removed and forgotten, and the agent's whole per-user tree — binary, config and log — deleted.
pub fn linux_cleanup_script(unit_path: &str, data_dir: &str) -> String {
  [
    format!("systemctl --user disable --now {SYSTEMD_UNIT_NAME}"),
    format!("rm -f {}", sh_quote(unit_path)),
    "systemctl --user daemon-reload".to_owned(),
    format!("rm -rf {}", sh_quote(data_dir)),
  ]
  .join("\n")
}

/// The teardown as a transient unit of its own, so it outlives the agent's unit and the agent's exit.
pub fn linux_depart_command(unit_path: &str, data_dir: &str) -> Vec<String> {
  ["systemd-run", "--user", "--collect", "--unit", DEPART_UNIT_NAME, "/bin/sh", "-c"]
    .into_iter()
    .map(str::to_owned)
    .chain([linux_cleanup_script(unit_path, data_dir)])
    .collect()
}

/// What the Windows cleanup runs once the agent has exited: it waits for the executable to become
/// deletable, removes the install folder and the data directory, and last deletes its own task.
pub fn windows_cleanup_script(install_dir: &str, data_dir: &str) -> String {
  let mut lines = exe_released_lines(install_dir);
  lines.extend([
    format!(
      "Remove-Item -LiteralPath {} -Recurse -Force -ErrorAction SilentlyContinue",
      ps_single_quote(install_dir)
    ),
    format!(
      "Remove-Item -LiteralPath {} -Recurse -Force -ErrorAction SilentlyContinue",
      ps_single_quote(data_dir)
    ),
    format!("schtasks /delete /tn {DEPART_TASK_NAME} /f"),
  ]);
  lines.join("\n")
}

/// The lines of a Windows cleanup that wait for the install's executable to become deletable, once the
/// process running it has exited, and delete it.
pub(crate) fn exe_released_lines(install_dir: &str) -> Vec<String> {
  let exe = Platform::Windows.join(install_dir, &[JAKE_BINARY]);
  vec![
    format!("$exe = {}", ps_single_quote(&exe)),
    "for ($i = 0; $i -lt 100; $i++) {".to_owned(),
    "  if (-not (Test-Path -LiteralPath $exe)) { break }".to_owned(),
    "  try { Remove-Item -LiteralPath $exe -Force -ErrorAction Stop; break } catch { Start-Sleep -Milliseconds 200 }"
      .to_owned(),
    "}".to_owned(),
  ]
}

/// The one-shot cleanup task, registered like the anchors — per-user, no stored credential,
/// non-elevated. It is run at once and deletes itself, so its logon trigger only fills the schedule
/// schtasks demands.
pub fn depart_task_create_command(install_dir: &str, data_dir: &str) -> Vec<String> {
  let command = powershell_command(&windows_cleanup_script(install_dir, data_dir)).join(" ");
  [
    "schtasks",
    "/create",
    "/tn",
    DEPART_TASK_NAME,
    "/tr",
    &command,
    "/sc",
    "onlogon",
    "/rl",
    "limited",
    "/f",
  ]
  .map(str::to_owned)
  .to_vec()
}

/// Every command of a Windows departure after the agent's own watchdog has stopped, in order: the
/// guard's tree ended by the id its lock holds, every anchor of both run modes removed, and the
/// cleanup task created and run.
pub fn windows_depart_commands(
  install_dir: &str,
  data_dir: &str,
  guard_pid: Option<u64>,
  env: &HashMap<String, String>,
) -> Vec<Vec<String>> {
  let mut commands = Vec::new();
  if let Some(pid) = guard_pid.and_then(|pid| u32::try_from(pid).ok()) {
    commands.push(tree_kill_command(pid));
  }
  for target in install_targets(install_dir) {
    commands.extend(anchor_remove_commands(&target, env));
  }
  commands.push(depart_task_create_command(install_dir, data_dir));
  commands.push(task_run_command(DEPART_TASK_NAME));
  commands
}

/// Depart on a leave, the caller having already stopped its own reconnect loop and watchdog. Each step
/// is guarded, since a removal that stopped halfway would leave a half-installed agent behind.
pub async fn depart(platform: Platform, install_dir: &str, env: &HashMap<String, String>, log: &Log) {
  let data_dir = platform.data_dir(env);
  log.warn("departing", json!({ "installDir": install_dir, "dataDir": data_dir }));
  let commands = match platform {
    Platform::Linux => vec![linux_depart_command(&crate::platform::systemd_unit_path(env), &data_dir)],
    Platform::Windows => {
      let guard_pid = read_number(Path::new(&platform.lock_path(env, crate::platform::Role::Guard)));
      windows_depart_commands(install_dir, &data_dir, guard_pid, env)
    }
  };
  for argv in commands {
    if let Err(error) = command::run(&argv, STEP_BOUND).await {
      log.warn("depart-step-failed", json!({ "error": error }));
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn the_linux_teardown_runs_detached_and_removes_the_unit_and_the_whole_tree() {
    let command = linux_depart_command("/h/.config/systemd/user/jake-agent.service", "/h/it's/jake");
    assert_eq!(
      command[..7],
      ["systemd-run", "--user", "--collect", "--unit", "jake-depart", "/bin/sh", "-c"]
    );
    assert_eq!(
      command[7],
      "systemctl --user disable --now jake-agent.service\nrm -f '/h/.config/systemd/user/jake-agent.service'\n\
       systemctl --user daemon-reload\nrm -rf '/h/it'\\''s/jake'"
    );
  }

  #[test]
  fn the_windows_departure_ends_the_guard_then_the_anchors_then_hands_the_files_to_its_own_task() {
    let env = HashMap::from([("APPDATA".to_owned(), "C:\\R".to_owned())]);
    let commands = windows_depart_commands("C:\\P\\jake", "C:\\L\\jake", Some(77), &env);
    let heads: Vec<String> = commands.iter().map(|command| command[..2].join(" ")).collect();
    assert_eq!(
      heads,
      [
        "taskkill /PID",
        "reg delete",
        "schtasks /delete",
        "powershell.exe -NoProfile",
        "reg delete",
        "schtasks /delete",
        "powershell.exe -NoProfile",
        "schtasks /create",
        "schtasks /run"
      ]
    );
    assert_eq!(commands[0], ["taskkill", "/PID", "77", "/T", "/F"]);
    assert_eq!(commands[7][3], "JakeDepart");
    assert_eq!(commands[8], ["schtasks", "/run", "/tn", "JakeDepart"]);
    assert_eq!(windows_depart_commands("C:\\P\\jake", "C:\\L\\jake", None, &env).len(), 8);
  }

  #[test]
  fn the_windows_cleanup_waits_for_the_executable_then_removes_everything_and_its_own_task() {
    let script = windows_cleanup_script("C:\\P\\jake", "C:\\L\\jake");
    assert!(script.starts_with("$exe = 'C:\\P\\jake\\jake.exe'\n"));
    assert!(script.contains("Remove-Item -LiteralPath 'C:\\P\\jake' -Recurse"));
    assert!(script.contains("Remove-Item -LiteralPath 'C:\\L\\jake' -Recurse"));
    assert!(script.ends_with("schtasks /delete /tn JakeDepart /f"));
  }
}
