// The set's units under their manager (docs/all-in-one.md, 「Running the set」): which units are the set's, how
// they are started and stopped, and their health read for the tray.

use serde::Deserialize;

use crate::all_in_one::flow::Manager;
use crate::all_in_one::installer::Layout;

/// Lists every enabled service of the account with the file its link names, one `<unit> <file>` a line; the
/// lines are this app's own shape, read by `set_units`.
pub const ENABLED: &str = r#"dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/default.target.wants"
for link in "$dir"/*.service; do
  test -e "$link" || continue
  printf '%s %s\n' "$(basename "$link")" "$(readlink -f "$link")"
done
"#;

/// The set's units among the enabled services: those whose file stands in a release under the install prefix.
pub fn set_units(listing: &str, prefix: &str) -> Vec<String> {
  let prefix = format!("{}/", prefix.trim_end_matches('/'));
  listing
    .lines()
    .filter_map(|line| line.split_once(' '))
    .filter(|(_, file)| file.starts_with(&prefix) && file.contains("/deploy"))
    .map(|(unit, _)| unit.to_owned())
    .collect()
}

/// One unit as the tray reads it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UnitHealth {
  pub id: String,
  pub active_state: String,
  pub sub_state: String,
  /// `healthy`, `unhealthy` or `unknown`; systemd reads none.
  pub health: String,
}

#[derive(Deserialize)]
struct Status {
  units: Vec<UnitHealth>,
}

/// The units of `bmo-testbed supervise status --json`.
pub fn supervisor_units(output: &str) -> Result<Vec<UnitHealth>, String> {
  serde_json::from_str::<Status>(output)
    .map(|status| status.units)
    .map_err(|error| error.to_string())
}

/// The units of `systemctl --user show -p Id,ActiveState,SubState`: a `Name=value` line for each property, a
/// blank line between units, systemd's own listing rather than a file format any reader is kept for.
pub fn systemd_units(output: &str) -> Vec<UnitHealth> {
  output
    .split("\n\n")
    .filter(|block| !block.trim().is_empty())
    .map(|block| {
      let mut unit = UnitHealth::default();
      for line in block.lines() {
        match line.split_once('=') {
          Some(("Id", value)) => unit.id = value.to_owned(),
          Some(("ActiveState", value)) => unit.active_state = value.to_owned(),
          Some(("SubState", value)) => unit.sub_state = value.to_owned(),
          _ => {}
        }
      }
      unit
    })
    .collect()
}

/// The set's state in a few words for the tray's tooltip.
pub fn summary(units: &[UnitHealth]) -> String {
  if units.is_empty() {
    return "BMO: 실행 중인 서비스 없음".to_owned();
  }
  let down = units
    .iter()
    .filter(|unit| !matches!(unit.active_state.as_str(), "active" | "activating"))
    .count();
  let unhealthy = units.iter().filter(|unit| unit.health == "unhealthy").count();
  let starting = units.iter().filter(|unit| unit.active_state == "activating").count();
  match (down, unhealthy, starting) {
    (0, 0, 0) => format!("BMO: 정상 · 서비스 {}개 실행 중", units.len()),
    (0, 0, starting) => format!("BMO: 시작하는 중 · {starting}개 남음"),
    (down, unhealthy, _) => {
      let mut parts = Vec::new();
      if down > 0 {
        parts.push(format!("{down}개 중단됨"));
      }
      if unhealthy > 0 {
        parts.push(format!("{unhealthy}개 응답 없음"));
      }
      format!("BMO: 서비스 {}개 중 {}", units.len(), parts.join(", "))
    }
  }
}

/// The words that start, stop and read the set under its manager.
pub struct Words<'a> {
  pub manager: Manager,
  pub layout: &'a Layout,
  /// The testbed's binary the supervisor is run from.
  pub testbed: String,
}

impl Words<'_> {
  /// The supervisor served in the foreground, for as long as the app runs it.
  pub fn serve(&self) -> Vec<String> {
    [&self.testbed, "supervise", "serve", "--data-root"]
      .into_iter()
      .map(|word| word.to_string())
      .chain([self.layout.data_root()])
      .collect()
  }

  /// The two lines that put a command under the supervisor.
  pub fn supervisor_env(&self) -> Vec<String> {
    [&self.testbed, "supervise", "env", "--data-root"]
      .into_iter()
      .map(|word| word.to_string())
      .chain([self.layout.data_root()])
      .collect()
  }

  pub fn status(&self, units: &[String]) -> Vec<String> {
    match self.manager {
      Manager::Supervisor => [&self.testbed, "supervise", "status", "--json", "--data-root"]
        .into_iter()
        .map(|word| word.to_string())
        .chain([self.layout.data_root()])
        .collect(),
      Manager::Systemd => ["systemctl", "--user", "show", "-p", "Id,ActiveState,SubState"]
        .into_iter()
        .map(str::to_owned)
        .chain(units.iter().cloned())
        .collect(),
    }
  }

  /// Under systemd, the set's units started or stopped; the supervisor starts its units as it serves.
  pub fn systemctl(&self, verb: &str, units: &[String]) -> Vec<String> {
    ["systemctl", "--user", verb]
      .into_iter()
      .map(str::to_owned)
      .chain(units.iter().cloned())
      .collect()
  }

  pub fn stop_all(&self) -> Vec<String> {
    [&self.testbed, "supervise", "stop-all", "--data-root"]
      .into_iter()
      .map(|word| word.to_string())
      .chain([self.layout.data_root()])
      .collect()
  }
}

/// The variables `supervise env` prints, `NAME=value` a line, every one of them: which lines put a command under
/// the supervisor is the supervisor's to say (bmo-testbed's docs/supervise.md, 「The words」).
pub fn env_lines(output: &str) -> Vec<(String, String)> {
  output
    .lines()
    .filter_map(|line| line.split_once('='))
    .filter(|(name, _)| {
      !name.is_empty() && name.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
    })
    .map(|(name, value)| (name.to_owned(), value.to_owned()))
    .collect()
}

#[cfg(test)]
mod tests {
  use super::*;

  fn unit(id: &str, active: &str, health: &str) -> UnitHealth {
    UnitHealth {
      id: id.into(),
      active_state: active.into(),
      sub_state: String::new(),
      health: health.into(),
    }
  }

  #[test]
  fn the_sets_units_are_the_enabled_services_of_its_releases() {
    let listing = "bmo-web.service /home/someone/.local/share/bmo-web/deploy/deploy/bmo-web.service\n\
                   other.service /home/someone/.config/systemd/user/other.service\n\
                   bmo-brain.service /home/someone/.local/share/bmo-brain/deploy/deploy/bmo-brain.service\n";
    assert_eq!(
      set_units(listing, "/home/someone/.local/share/"),
      ["bmo-web.service", "bmo-brain.service"]
    );
  }

  #[test]
  fn both_managers_answers_are_read_into_the_units_health() {
    let supervisor = r#"{"units":[{"id":"bmo-web.service","activeState":"active","subState":"running","health":"healthy","mainPID":7}]}"#;
    assert_eq!(
      supervisor_units(supervisor).unwrap(),
      [UnitHealth {
        sub_state: "running".into(),
        ..unit("bmo-web.service", "active", "healthy")
      }]
    );
    let systemd = "Id=a.service\nActiveState=active\nSubState=running\n\nId=b.service\nActiveState=failed\nSubState=failed\n";
    let read = systemd_units(systemd);
    assert_eq!(read.len(), 2);
    assert_eq!(read[1].active_state, "failed");
  }

  #[test]
  fn the_tooltip_says_how_the_set_stands() {
    assert_eq!(
      summary(&[unit("a", "active", "healthy"), unit("b", "active", "")]),
      "BMO: 정상 · 서비스 2개 실행 중"
    );
    assert_eq!(
      summary(&[unit("a", "failed", ""), unit("b", "active", "unhealthy")]),
      "BMO: 서비스 2개 중 1개 중단됨, 1개 응답 없음"
    );
    assert_eq!(summary(&[unit("a", "activating", "")]), "BMO: 시작하는 중 · 1개 남음");
    assert_eq!(summary(&[]), "BMO: 실행 중인 서비스 없음");
  }

  #[test]
  fn the_supervisors_lines_are_read_into_the_installers_environment() {
    let read = env_lines(
      "PATH=/d/supervise/bin:/usr/bin\nBMO_SUPERVISOR=/d/supervise/control.sock\nXDG_RUNTIME_DIR=/d/supervise/run\nnot a line\n",
    );
    assert_eq!(read[1], ("BMO_SUPERVISOR".to_owned(), "/d/supervise/control.sock".to_owned()));
    assert_eq!(read[2], ("XDG_RUNTIME_DIR".to_owned(), "/d/supervise/run".to_owned()));
    assert_eq!(read.len(), 3);
    let layout = Layout {
      home: "/home/someone".into(),
    };
    let words = Words {
      manager: Manager::Supervisor,
      layout: &layout,
      testbed: "/t".into(),
    };
    assert_eq!(
      words.serve(),
      ["/t", "supervise", "serve", "--data-root", "/home/someone/.local/share/bmo/data"]
    );
  }
}
