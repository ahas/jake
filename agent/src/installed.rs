// The installed agent running on this machine, found by the footprint its install leaves.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::config;
#[cfg(windows)]
use crate::platform::{Platform, Role};

/// The name of the installed jake agent running on this machine, if one runs.
pub fn running_agent_name() -> Option<String> {
  name_of_running(running_agent_pid(), executable_dir)
}

/// The name in the `agent.env` beside the executable of the running process, if any.
fn name_of_running(pid: Option<u32>, executable_dir: impl Fn(u32) -> Option<PathBuf>) -> Option<String> {
  let dir = executable_dir(pid?)?;
  name_beside(&dir)
}

fn name_beside(dir: &Path) -> Option<String> {
  let env = config::merged(dir, HashMap::new()).ok()?;
  env.get("JAKE_AGENT_NAME").filter(|name| !name.is_empty()).cloned()
}

/// On Windows the pair's single-instance locks name the running agent or guard; either one alive
/// means the install is live, since the guard revives the agent within a few ticks.
#[cfg(windows)]
fn running_agent_pid() -> Option<u32> {
  let env: HashMap<String, String> = std::env::vars().collect();
  [Role::Agent, Role::Guard].into_iter().find_map(|role| {
    let lock = PathBuf::from(Platform::Windows.lock_path(&env, role));
    let pid = u32::try_from(crate::pair::read_number(&lock)?).ok()?;
    crate::pair::lock_holder(pid).holds().then_some(pid)
  })
}

/// On Linux the agent's user unit names its main process; zero means it is not running. The user
/// manager is asked at its own bus under the runtime directory, never at whatever session bus the
/// caller was started with, which a desktop session may have pointed elsewhere.
#[cfg(unix)]
fn running_agent_pid() -> Option<u32> {
  let output = std::process::Command::new("systemctl")
    .args(["--user", "show", "--property=MainPID", "--value", crate::platform::SYSTEMD_UNIT_NAME])
    .env_remove("DBUS_SESSION_BUS_ADDRESS")
    .stdin(std::process::Stdio::null())
    .stderr(std::process::Stdio::null())
    .output()
    .ok()?;
  let pid = String::from_utf8_lossy(&output.stdout).trim().parse::<u32>().ok()?;
  (pid != 0).then_some(pid)
}

#[cfg(unix)]
fn executable_dir(pid: u32) -> Option<PathBuf> {
  let exe = std::fs::read_link(format!("/proc/{pid}/exe")).ok()?;
  exe.parent().map(Path::to_path_buf)
}

#[cfg(windows)]
fn executable_dir(pid: u32) -> Option<PathBuf> {
  match crate::pair::process_image(pid) {
    crate::pair::ProcessImage::Path(exe) => exe.parent().map(Path::to_path_buf),
    _ => None,
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn the_running_agent_is_named_by_the_agent_env_beside_its_executable() {
    let dir = std::env::temp_dir().join(format!("jake-installed-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("agent.env"), "JAKE_HUB_URL=wss://hub\nJAKE_AGENT_NAME=box\n").unwrap();
    let beside = |_| Some(dir.clone());
    let named = name_of_running(Some(7), beside);
    let none_running = name_of_running(None, beside);
    let elsewhere = name_of_running(Some(7), |_| Some(dir.join("missing")));
    std::fs::remove_dir_all(&dir).unwrap();

    assert_eq!(named.as_deref(), Some("box"));
    assert_eq!(none_running, None);
    assert_eq!(elsewhere, None);
  }

  #[cfg(unix)]
  #[test]
  fn a_running_process_is_found_in_its_executable_folder() {
    let own = std::env::current_exe().unwrap();
    assert_eq!(executable_dir(std::process::id()).as_deref(), own.parent());
  }
}
