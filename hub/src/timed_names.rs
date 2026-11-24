// Agent names each kept with a time, recorded in a file: the departed agents and the revoked names.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use serde_json::{Value, json};

/// Agent names and when each was noted, kept in a file when the hub has one so a restart does not
/// forget them.
pub struct TimedNames {
  path: Option<PathBuf>,
  /// The field the status lists each name's time under.
  field: &'static str,
  at: BTreeMap<String, i64>,
}

impl TimedNames {
  /// The record held in `path`, listed with each time under `field`; a missing or unreadable file
  /// is an empty record.
  pub fn load(path: Option<PathBuf>, field: &'static str) -> Self {
    let at = path
      .as_ref()
      .and_then(|path| fs::read_to_string(path).ok())
      .and_then(|text| serde_json::from_str::<BTreeMap<String, i64>>(&text).ok())
      .unwrap_or_default();
    Self { path, field, at }
  }

  /// Note `name` at `at`, in place of any earlier time.
  pub fn record(&mut self, name: &str, at: i64) {
    self.at.insert(name.to_owned(), at);
    self.save();
  }

  pub fn contains(&self, name: &str) -> bool {
    self.at.contains_key(name)
  }

  /// Forget `name`; whether it had been recorded.
  pub fn forget(&mut self, name: &str) -> bool {
    let known = self.at.remove(name).is_some();
    if known {
      self.save();
    }
    known
  }

  /// The names as the status lists them, each with its time.
  pub fn list(&self) -> Vec<Value> {
    self.at.iter().map(|(name, at)| json!({ "name": name, self.field: at })).collect()
  }

  // Written whole to a temporary file and moved into place, so a crash mid-write cannot tear it.
  fn save(&self) {
    let Some(path) = &self.path else { return };
    let Ok(text) = serde_json::to_string_pretty(&self.at) else { return };
    let temp = path.with_extension("json.tmp");
    let written = path.parent().map_or(Ok(()), fs::create_dir_all).and_then(|()| fs::write(&temp, text));
    match written.and_then(|()| fs::rename(&temp, path)) {
      Ok(()) => {}
      Err(error) => eprintln!("jake hub: cannot write the record {}: {error}", path.display()),
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn the_record_survives_a_reload_and_a_forgotten_name_is_gone() {
    let dir = std::env::temp_dir().join(format!("jake-timed-names-{}", std::process::id()));
    let path = dir.join("departed.json");
    let mut departed = TimedNames::load(Some(path.clone()), "departedAt");
    departed.record("node3", 5);
    departed.record("lab-pc", 7);

    let mut reloaded = TimedNames::load(Some(path.clone()), "departedAt");
    assert_eq!(
      reloaded.list(),
      [
        json!({ "name": "lab-pc", "departedAt": 7 }),
        json!({ "name": "node3", "departedAt": 5 })
      ]
    );
    assert!(reloaded.contains("node3"));
    assert!(reloaded.forget("node3"));
    assert!(!reloaded.forget("node3"));
    assert_eq!(TimedNames::load(Some(path), "departedAt").list().len(), 1);
    fs::remove_dir_all(&dir).unwrap();
  }
}
