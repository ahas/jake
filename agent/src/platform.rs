// Every path and choice that differs by operating system, derived from the platform and its environment.

use std::collections::HashMap;

/// The two kinds of host the agent runs on, each with its own shells and its own way to stay alive.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
  /// A Windows host: PowerShell and WSL, kept alive by the agent and guard pair.
  Windows,
  /// A Linux or WSL host: a Linux shell, kept alive by a `systemd --user` unit.
  Linux,
}

/// The name of the agent's systemd user unit, as `systemctl --user` and `journalctl --user -u` use it.
pub const SYSTEMD_UNIT_NAME: &str = "jake-agent.service";

/// Which process of the Windows pair this is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
  Agent,
  Guard,
}

impl Role {
  pub fn name(self) -> &'static str {
    match self {
      Self::Agent => "agent",
      Self::Guard => "guard",
    }
  }

  pub fn peer(self) -> Self {
    match self {
      Self::Agent => Self::Guard,
      Self::Guard => Self::Agent,
    }
  }
}

fn var<'a>(env: &'a HashMap<String, String>, name: &str) -> Option<&'a str> {
  env.get(name).map(String::as_str).filter(|value| !value.is_empty())
}

impl Platform {
  /// The platform this build runs on.
  pub const HOST: Self = if cfg!(windows) { Self::Windows } else { Self::Linux };

  /// The shells this host can run a command through, as the hello names them.
  pub fn shells(self) -> &'static [&'static str] {
    match self {
      Self::Windows => &["powershell", "wsl"],
      Self::Linux => &["linux"],
    }
  }

  /// A path under `base`, in this platform's own separators wherever it is derived.
  pub fn join(self, base: &str, parts: &[&str]) -> String {
    let separator = match self {
      Self::Windows => '\\',
      Self::Linux => '/',
    };
    let mut path = base.trim_end_matches(separator).to_owned();
    for part in parts {
      path.push(separator);
      path.push_str(part);
    }
    path
  }

  /// The per-user directory the agent keeps its log, heartbeats and locks in; no elevation needed.
  pub fn data_dir(self, env: &HashMap<String, String>) -> String {
    match self {
      Self::Windows => match (var(env, "LOCALAPPDATA"), var(env, "USERPROFILE")) {
        (Some(local), _) => self.join(local, &["jake"]),
        (None, Some(profile)) => self.join(profile, &["AppData", "Local", "jake"]),
        (None, None) => self.join("C:\\", &["jake"]),
      },
      Self::Linux => self.join(var(env, "HOME").unwrap_or("/tmp"), &[".local", "share", "jake"]),
    }
  }

  /// The rolling log, readable on the machine when the hub is the thing that cannot be reached.
  pub fn log_path(self, env: &HashMap<String, String>) -> String {
    self.join(&self.data_dir(env), &["agent.log"])
  }

  /// The file one process of the pair refreshes for its peer to read.
  pub fn heartbeat_path(self, env: &HashMap<String, String>, role: Role) -> String {
    self.join(&self.data_dir(env), &[&format!("{}.heartbeat", role.name())])
  }

  /// The single-instance lock of one process of the pair, holding its process id.
  pub fn lock_path(self, env: &HashMap<String, String>, role: Role) -> String {
    self.join(&self.data_dir(env), &[&format!("{}.lock", role.name())])
  }
}

/// The per-user Startup folder, whose shortcuts launch at this user's logon.
pub fn startup_dir(env: &HashMap<String, String>) -> String {
  let windows = Platform::Windows;
  let base = match var(env, "APPDATA") {
    Some(app_data) => app_data.to_owned(),
    None => windows.join(var(env, "USERPROFILE").unwrap_or("C:\\"), &["AppData", "Roaming"]),
  };
  windows.join(&base, &["Microsoft", "Windows", "Start Menu", "Programs", "Startup"])
}

/// Where the agent's systemd user unit file is, under the XDG config home.
pub fn systemd_unit_path(env: &HashMap<String, String>) -> String {
  let linux = Platform::Linux;
  let config_home = match var(env, "XDG_CONFIG_HOME") {
    Some(xdg) => xdg.to_owned(),
    None => linux.join(var(env, "HOME").unwrap_or("/root"), &[".config"]),
  };
  linux.join(&config_home, &["systemd", "user", SYSTEMD_UNIT_NAME])
}

/// Why `systemctl --user` cannot supervise the agent here, or nothing when it can.
pub fn systemd_unavailable_reason(systemd_as_init: bool) -> Option<&'static str> {
  (!systemd_as_init).then_some(
    "systemd is not running as this system's init, so `systemctl --user` cannot supervise the agent. \
     On WSL, enable systemd (set `[boot] systemd=true` in /etc/wsl.conf, then run `wsl.exe --shutdown` \
     from Windows) and try again.",
  )
}

/// Whether systemd is this system's init.
pub fn systemd_runs_as_init() -> bool {
  std::path::Path::new("/run/systemd/system").exists()
}

#[cfg(test)]
mod tests {
  use super::*;

  fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
    pairs.iter().map(|(key, value)| ((*key).to_owned(), (*value).to_owned())).collect()
  }

  #[test]
  fn data_paths_are_per_user_in_the_platforms_own_separators() {
    let windows = env(&[("LOCALAPPDATA", "C:\\Users\\h\\AppData\\Local")]);
    assert_eq!(Platform::Windows.log_path(&windows), "C:\\Users\\h\\AppData\\Local\\jake\\agent.log");
    assert_eq!(
      Platform::Windows.data_dir(&env(&[("USERPROFILE", "C:\\Users\\h")])),
      "C:\\Users\\h\\AppData\\Local\\jake"
    );
    assert_eq!(
      Platform::Windows.heartbeat_path(&windows, Role::Guard),
      "C:\\Users\\h\\AppData\\Local\\jake\\guard.heartbeat"
    );
    assert_eq!(Platform::Linux.lock_path(&env(&[("HOME", "/home/h")]), Role::Agent), "/home/h/.local/share/jake/agent.lock");
  }

  #[test]
  fn the_startup_folder_and_the_unit_are_the_per_user_ones() {
    assert_eq!(
      startup_dir(&env(&[("APPDATA", "C:\\R")])),
      "C:\\R\\Microsoft\\Windows\\Start Menu\\Programs\\Startup"
    );
    assert_eq!(
      startup_dir(&env(&[("USERPROFILE", "C:\\Users\\h")])),
      "C:\\Users\\h\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup"
    );
    assert_eq!(systemd_unit_path(&env(&[("HOME", "/home/h")])), "/home/h/.config/systemd/user/jake-agent.service");
    assert_eq!(systemd_unit_path(&env(&[("XDG_CONFIG_HOME", "/x")])), "/x/systemd/user/jake-agent.service");
  }

  #[test]
  fn each_host_offers_its_own_shells_and_wsl_without_systemd_is_told_why() {
    assert_eq!(Platform::Windows.shells(), ["powershell", "wsl"]);
    assert_eq!(Platform::Linux.shells(), ["linux"]);
    assert!(systemd_unavailable_reason(true).is_none());
    assert!(systemd_unavailable_reason(false).unwrap().contains("/etc/wsl.conf"));
  }
}
