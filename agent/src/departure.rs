// The agent's departure on a hub's leave: every part that keeps it running stopped, then every file removed.

use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

use serde_json::json;

use crate::command;
use crate::exec::tree_kill_command;
use crate::log::Log;
use crate::pair::{JAKE_BINARY, anchor_remove_commands, install_targets, read_number};
use crate::platform::{Platform, SYSTEMD_UNIT_NAME};
use crate::uninstall;

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

/// The install's own uninstaller, asked to remove this agent's install whole and unattended: it is started
/// detached once the agent has stopped its watchdog and ended the guard, and does the rest as a removal by
/// hand does it, so no scheduled task and no long command line is needed (docs/architecture.md, 「Leaving」).
pub fn windows_uninstall_command(install_dir: &str, agent_name: &str) -> Vec<String> {
  let options = uninstall::Options {
    name: Some(agent_name.to_owned()),
    yes: true,
    remove_config: true,
  };
  std::iter::once(Platform::Windows.join(install_dir, &[JAKE_BINARY]))
    .chain(options.arguments())
    .collect()
}

/// The guard's tree ended by the id its lock holds, before the uninstaller starts, so it revives nothing meanwhile.
pub fn windows_guard_stop_commands(guard_pid: Option<u64>) -> Vec<Vec<String>> {
  guard_pid
    .and_then(|pid| u32::try_from(pid).ok())
    .map(tree_kill_command)
    .into_iter()
    .collect()
}

/// What the agent removes itself where its uninstaller cannot be started: every anchor of both run modes, so
/// nothing revives it; the files stay.
pub fn windows_fallback_commands(install_dir: &str, env: &HashMap<String, String>) -> Vec<Vec<String>> {
  install_targets(install_dir)
    .iter()
    .flat_map(|target| anchor_remove_commands(target, env))
    .collect()
}

/// Depart on a leave, the caller having already stopped its own reconnect loop and watchdog and given up its lock.
/// Each step is guarded, since a removal that stopped halfway would leave a half-installed agent behind.
pub async fn depart(
  platform: Platform,
  install_dir: &str,
  agent_name: &str,
  env: &HashMap<String, String>,
  log: &Log,
) {
  let data_dir = platform.data_dir(env);
  log.warn("departing", json!({ "installDir": install_dir, "dataDir": data_dir }));
  match platform {
    Platform::Linux => {
      run_all(&[linux_depart_command(&crate::platform::systemd_unit_path(env), &data_dir)], log).await;
    }
    Platform::Windows => {
      let guard_pid = read_number(Path::new(&platform.lock_path(env, crate::platform::Role::Guard)));
      run_all(&windows_guard_stop_commands(guard_pid), log).await;
      if let Err(error) = command::spawn_detached(&windows_uninstall_command(install_dir, agent_name)) {
        log.warn("depart-uninstaller-unstarted", json!({ "error": error, "filesKept": install_dir }));
        run_all(&windows_fallback_commands(install_dir, env), log).await;
      }
    }
  }
}

async fn run_all(commands: &[Vec<String>], log: &Log) {
  for argv in commands {
    if let Err(error) = command::run(argv, STEP_BOUND).await {
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
  fn the_windows_departure_hands_the_removal_to_the_installs_own_uninstaller_by_name() {
    let command = windows_uninstall_command("C:\\P\\jake", "u63");
    assert_eq!(
      command,
      ["C:\\P\\jake\\jake.exe", "uninstall", "--name", "u63", "--yes", "--remove-config"]
    );
    let options =
      uninstall::Options::parse(&command[2..]).expect("the uninstaller takes its own arguments");
    assert_eq!(options.name.as_deref(), Some("u63"));
    assert!(options.yes && options.remove_config);
  }

  #[test]
  fn no_windows_departure_step_registers_a_task_or_carries_a_long_command_line() {
    let env = HashMap::from([("APPDATA".to_owned(), "C:\\R".to_owned())]);
    let mut every = windows_guard_stop_commands(Some(77));
    every.push(windows_uninstall_command("C:\\P\\jake", "u63"));
    every.extend(windows_fallback_commands("C:\\P\\jake", &env));
    for command in &every {
      assert!(!(command[0] == "schtasks" && command[1] == "/create"), "{command:?}");
    }
    // The uninstaller's whole command line stays short, whatever a task's 261-character limit would allow.
    assert!(every[1].join(" ").len() < 261, "{:?}", every[1]);
    assert_eq!(every[0], ["taskkill", "/PID", "77", "/T", "/F"]);
    assert!(windows_guard_stop_commands(None).is_empty());
  }

  #[test]
  fn where_the_uninstaller_cannot_start_the_agent_removes_every_anchor_itself() {
    let env = HashMap::from([("APPDATA".to_owned(), "C:\\R".to_owned())]);
    let heads: Vec<String> = windows_fallback_commands("C:\\P\\jake", &env)
      .iter()
      .map(|command| command[..2].join(" "))
      .collect();
    assert_eq!(
      heads,
      [
        "reg delete",
        "schtasks /delete",
        "powershell.exe -NoProfile",
        "reg delete",
        "schtasks /delete",
        "powershell.exe -NoProfile"
      ]
    );
  }
}
