// The installed agent on this machine, running or not, found by the footprint its install leaves, and removed
// by its own executable's uninstall command (docs/desktop.md, 「One agent per name」).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::config;
use crate::platform::Platform;
#[cfg(windows)]
use crate::platform::Role;

/// An installed jake agent: the name its `agent.env` gives and the folder it is installed in.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Installed {
  pub name: String,
  pub dir: PathBuf,
}

/// The default install's folder, and whether an install is registered there.
struct DefaultInstall {
  dir: PathBuf,
  registered: bool,
}

/// The installed jake agent on this machine, if one is installed: the running one first, else the default
/// install where it is registered.
pub fn installed_agent() -> Option<Installed> {
  let env: HashMap<String, String> = std::env::vars().collect();
  found(running_agent_pid().and_then(executable_dir), default_install(&env))
}

fn found(running: Option<PathBuf>, default: Option<DefaultInstall>) -> Option<Installed> {
  running
    .and_then(named)
    .or_else(|| default.filter(|install| install.registered).and_then(|install| named(install.dir)))
}

fn named(dir: PathBuf) -> Option<Installed> {
  name_beside(&dir).map(|name| Installed { name, dir })
}

/// The executable and arguments that run an install's own uninstaller, which keeps its `agent.env` and its log
/// and refuses where the install is no longer the named agent's.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Uninstaller {
  pub program: PathBuf,
  pub arguments: Vec<String>,
}

impl Installed {
  /// The uninstall command of the install's own executable, for this machine's platform.
  pub fn uninstaller(&self) -> Uninstaller {
    uninstaller_for(Platform::HOST, &self.dir, &self.name)
  }

  /// Stop and unregister the installed agent through its own uninstaller, waiting for it to end. Nothing is
  /// deleted here: the uninstaller removes what the install placed and keeps the config and the log.
  pub fn uninstall(&self) -> Result<(), String> {
    let uninstaller = self.uninstaller();
    if !uninstaller.program.is_file() {
      return Err(format!("{} is missing", uninstaller.program.display()));
    }
    let mut command = std::process::Command::new(&uninstaller.program);
    command.args(&uninstaller.arguments).stdin(std::process::Stdio::null());
    #[cfg(windows)]
    {
      use std::os::windows::process::CommandExt as _;
      // The app is a window, so the uninstaller opens no console of its own.
      const CREATE_NO_WINDOW: u32 = 0x0800_0000;
      command.creation_flags(CREATE_NO_WINDOW);
    }
    let output = command
      .output()
      .map_err(|error| format!("{}: {error}", uninstaller.program.display()))?;
    if output.status.success() {
      return Ok(());
    }
    // An executable that refuses its arguments was built before the uninstall command.
    if output.status.code() == Some(2) {
      return Err(format!(
        "the jake installed in {} is older than its uninstall command: update it, or remove it with the uninstall \
         script beside it",
        self.dir.display()
      ));
    }
    let said = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    Err(if said.is_empty() {
      format!("the uninstaller ended with {}", output.status)
    } else {
      said
    })
  }
}

fn uninstaller_for(platform: Platform, dir: &Path, name: &str) -> Uninstaller {
  let binary = match platform {
    Platform::Linux => "jake",
    Platform::Windows => crate::pair::JAKE_BINARY,
  };
  let options = crate::uninstall::Options {
    name: Some(name.to_owned()),
    yes: true,
    remove_config: false,
  };
  Uninstaller {
    program: PathBuf::from(platform.join(&dir.to_string_lossy(), &[binary])),
    arguments: options.arguments(),
  }
}

/// The default install on Linux: the executable in the data directory, registered by its user unit.
#[cfg(unix)]
fn default_install(env: &HashMap<String, String>) -> Option<DefaultInstall> {
  let dir = PathBuf::from(Platform::Linux.data_dir(env));
  let registered =
    dir.join("jake").is_file() && Path::new(&crate::platform::systemd_unit_path(env)).is_file();
  Some(DefaultInstall { dir, registered })
}

/// The default install on Windows: the executable in the per-user programs folder.
#[cfg(windows)]
fn default_install(env: &HashMap<String, String>) -> Option<DefaultInstall> {
  let local = env.get("LOCALAPPDATA").filter(|local| !local.is_empty())?;
  let dir = PathBuf::from(Platform::Windows.join(local, &["Programs", "jake"]));
  let registered = dir.join("jake.exe").is_file();
  Some(DefaultInstall { dir, registered })
}

/// The agent the install in `dir` serves: the one its own `agent.env` names, the process environment unread.
pub fn name_beside(dir: &Path) -> Option<String> {
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

  /// A folder holding an `agent.env` naming `name`, removed when dropped.
  struct Folder(PathBuf);

  impl Folder {
    fn named(tag: &str, name: Option<&str>) -> Self {
      let dir = std::env::temp_dir().join(format!("jake-installed-{tag}-{}", std::process::id()));
      std::fs::create_dir_all(&dir).unwrap();
      if let Some(name) = name {
        std::fs::write(dir.join("agent.env"), format!("JAKE_HUB_URL=wss://hub\nJAKE_AGENT_NAME={name}\n"))
          .unwrap();
      }
      Self(dir)
    }
  }

  impl Drop for Folder {
    fn drop(&mut self) {
      let _ = std::fs::remove_dir_all(&self.0);
    }
  }

  fn installed(name: &str, folder: &Folder) -> Option<Installed> {
    Some(Installed {
      name: name.to_owned(),
      dir: folder.0.clone(),
    })
  }

  #[test]
  fn the_running_agent_is_named_by_the_agent_env_beside_its_executable() {
    let running = Folder::named("running", Some("box"));
    let default = Folder::named("default", Some("other"));
    let registered = || {
      Some(DefaultInstall {
        dir: default.0.clone(),
        registered: true,
      })
    };

    assert_eq!(found(Some(running.0.clone()), registered()), installed("box", &running));
    assert_eq!(found(Some(running.0.join("missing")), None), None);
  }

  #[test]
  fn an_agent_installed_but_not_running_is_found_where_its_install_is_registered() {
    let default = Folder::named("stopped", Some("box"));
    let at = |registered| {
      Some(DefaultInstall {
        dir: default.0.clone(),
        registered,
      })
    };

    assert_eq!(found(None, at(true)), installed("box", &default));
    assert_eq!(found(None, at(false)), None, "an executable left with no registration is no install");
    assert_eq!(found(None, None), None);
  }

  #[test]
  fn an_install_whose_config_names_no_agent_is_none() {
    let unnamed = Folder::named("unnamed", None);
    assert_eq!(
      found(
        Some(unnamed.0.clone()),
        Some(DefaultInstall {
          dir: unnamed.0.clone(),
          registered: true
        })
      ),
      None
    );
  }

  #[test]
  fn the_uninstaller_is_the_installs_own_executable_naming_its_agent_and_keeping_the_config() {
    let linux = uninstaller_for(Platform::Linux, Path::new("/home/person/.local/share/jake"), "u63");
    assert_eq!(linux.program, PathBuf::from("/home/person/.local/share/jake/jake"));
    assert_eq!(linux.arguments, ["uninstall", "--name", "u63", "--yes"]);

    let windows = uninstaller_for(
      Platform::Windows,
      Path::new("C:\\Users\\person\\AppData\\Local\\Programs\\jake"),
      "u63",
    );
    assert_eq!(
      windows.program,
      PathBuf::from("C:\\Users\\person\\AppData\\Local\\Programs\\jake\\jake.exe")
    );
    assert_eq!(windows.arguments, ["uninstall", "--name", "u63", "--yes"]);
  }

  #[test]
  fn a_missing_uninstaller_is_refused_and_runs_nothing() {
    let folder = Folder::named("no-uninstaller", Some("box"));
    let refused = Installed {
      name: "box".to_owned(),
      dir: folder.0.clone(),
    }
    .uninstall();
    assert!(refused.is_err_and(|reason| reason.contains("missing")));
  }

  #[cfg(unix)]
  #[test]
  fn a_running_process_is_found_in_its_executable_folder() {
    let own = std::env::current_exe().unwrap();
    assert_eq!(executable_dir(std::process::id()).as_deref(), own.parent());
  }
}
