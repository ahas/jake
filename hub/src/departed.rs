// The agents that have left: uninstalled by a leave or by hand, told apart from ones merely disconnected.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use serde_json::{Value, json};

/// Every departed agent's name and when it left, kept in a file when the hub has one so a restart
/// does not forget them.
pub struct Departed {
  path: Option<PathBuf>,
  left_at: BTreeMap<String, i64>,
}

impl Departed {
  /// The record held in `path`; a missing or unreadable file is an empty record.
  pub fn load(path: Option<PathBuf>) -> Self {
    let left_at = path
      .as_ref()
      .and_then(|path| fs::read_to_string(path).ok())
      .and_then(|text| serde_json::from_str::<BTreeMap<String, i64>>(&text).ok())
      .unwrap_or_default();
    Self { path, left_at }
  }

  /// Note that `name` has left.
  pub fn record(&mut self, name: &str, at: i64) {
    self.left_at.insert(name.to_owned(), at);
    self.save();
  }

  /// Forget `name`, which has said hello again; whether it had been recorded as departed.
  pub fn forget(&mut self, name: &str) -> bool {
    let known = self.left_at.remove(name).is_some();
    if known {
      self.save();
    }
    known
  }

  /// The departed agents as the status lists them.
  pub fn list(&self) -> Vec<Value> {
    self
      .left_at
      .iter()
      .map(|(name, at)| json!({ "name": name, "departedAt": at }))
      .collect()
  }

  // Written whole to a temporary file and moved into place, so a crash mid-write cannot tear it.
  fn save(&self) {
    let Some(path) = &self.path else { return };
    let Ok(text) = serde_json::to_string_pretty(&self.left_at) else { return };
    let temp = path.with_extension("json.tmp");
    let written = path.parent().map_or(Ok(()), fs::create_dir_all).and_then(|()| fs::write(&temp, text));
    match written.and_then(|()| fs::rename(&temp, path)) {
      Ok(()) => {}
      Err(error) => eprintln!("jake hub: cannot record the departed agents in {}: {error}", path.display()),
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn the_record_survives_a_reload_and_a_returning_agent_is_forgotten() {
    let dir = std::env::temp_dir().join(format!("jake-departed-{}", std::process::id()));
    let path = dir.join("departed.json");
    let mut departed = Departed::load(Some(path.clone()));
    departed.record("node3", 5);
    departed.record("jungsu-wsl", 7);

    let mut reloaded = Departed::load(Some(path.clone()));
    assert_eq!(
      reloaded.list(),
      [
        json!({ "name": "jungsu-wsl", "departedAt": 7 }),
        json!({ "name": "node3", "departedAt": 5 })
      ]
    );
    assert!(reloaded.forget("node3"));
    assert!(!reloaded.forget("node3"));
    assert_eq!(Departed::load(Some(path)).list().len(), 1);
    fs::remove_dir_all(&dir).unwrap();
  }
}
