// The agent's local, size-bounded rolling log, one JSON object per line.

use std::fs::{self, OpenOptions};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use serde_json::{Map, Value};

const DEFAULT_MAX_BYTES: u64 = 4 * 1024 * 1024;
const DEFAULT_KEEP: u32 = 3;

struct Rolling {
  path: PathBuf,
  max_bytes: u64,
  keep: u32,
}

/// A handle on the log; clones write to the same file.
#[derive(Clone)]
pub struct Log(Arc<Mutex<Rolling>>);

impl Log {
  /// The log the agent runs with, at its per-user path.
  pub fn open(path: PathBuf) -> Self {
    Self::with_limits(path, DEFAULT_MAX_BYTES, DEFAULT_KEEP)
  }

  fn with_limits(path: PathBuf, max_bytes: u64, keep: u32) -> Self {
    Self(Arc::new(Mutex::new(Rolling {
      path,
      max_bytes,
      keep,
    })))
  }

  pub fn info(&self, event: &str, detail: Value) {
    self.write("info", event, detail);
  }

  pub fn warn(&self, event: &str, detail: Value) {
    self.write("warn", event, detail);
  }

  /// Append one line. A log that cannot be written is not a reason to stop serving the hub.
  fn write(&self, level: &str, event: &str, detail: Value) {
    let mut line = Map::new();
    line.insert("t".into(), humantime::format_rfc3339_millis(SystemTime::now()).to_string().into());
    line.insert("level".into(), level.into());
    line.insert("event".into(), event.into());
    if let Value::Object(fields) = detail {
      line.extend(fields);
    }
    let text = format!("{}\n", Value::Object(line));
    let rolling = self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let _ = rolling.append(&text);
  }
}

impl Rolling {
  fn append(&self, text: &str) -> std::io::Result<()> {
    let size = fs::metadata(&self.path).map_or(0, |meta| meta.len());
    if size + text.len() as u64 > self.max_bytes {
      self.rotate();
    }
    if let Some(parent) = self.path.parent() {
      fs::create_dir_all(parent)?;
    }
    OpenOptions::new()
      .create(true)
      .append(true)
      .open(&self.path)?
      .write_all(text.as_bytes())
  }

  // The oldest kept file falls off, each survivor moves up a slot, and the live file becomes slot 1.
  fn rotate(&self) {
    let slot = |n: u32| -> PathBuf { suffixed(&self.path, n) };
    let _ = fs::remove_file(slot(self.keep));
    for n in (1..self.keep).rev() {
      let _ = fs::rename(slot(n), slot(n + 1));
    }
    let _ = fs::rename(&self.path, slot(1));
  }
}

fn suffixed(path: &Path, n: u32) -> PathBuf {
  let mut name = path.as_os_str().to_owned();
  name.push(format!(".{n}"));
  PathBuf::from(name)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn rotates_by_size_and_keeps_a_bounded_number_of_files() {
    let dir = std::env::temp_dir().join(format!("jake-log-{}", std::process::id()));
    let path = dir.join("agent.log");
    let log = Log::with_limits(path.clone(), 200, 2);
    for n in 0..20 {
      log.info("tick", serde_json::json!({ "n": n }));
    }
    let live = fs::read_to_string(&path).unwrap();
    let mut names: Vec<String> = fs::read_dir(&dir)
      .unwrap()
      .map(|entry| entry.unwrap().file_name().into_string().unwrap())
      .collect();
    names.sort();
    fs::remove_dir_all(&dir).unwrap();

    assert_eq!(names, ["agent.log", "agent.log.1", "agent.log.2"]);
    assert!(live.len() <= 200);
    let last: Value = serde_json::from_str(live.lines().last().unwrap()).unwrap();
    assert_eq!(last["event"], "tick");
    assert_eq!(last["level"], "info");
    assert_eq!(last["n"], 19);
  }
}
