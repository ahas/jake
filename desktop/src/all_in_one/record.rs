// The app's own record (docs/all-in-one.md, 「Where everything stands」): what the app decided with the person,
// kept in `all-in-one.json` in its config directory. Everything else is read from the machine each time.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::all_in_one::flow::{Chat, Manager};

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Record {
  /// When the person consented, in seconds since the epoch.
  pub consented_at: Option<u64>,
  pub chat: Option<Chat>,
  pub manager: Option<Manager>,
  /// The console's address, once the install reported it.
  pub console: Option<String>,
}

/// Where the record stands under the app's config directory.
pub fn path(config_dir: &Path) -> PathBuf {
  config_dir.join("all-in-one.json")
}

/// The record as it stands; a record that does not read is none, and the first run starts again from consent.
pub fn read(file: &Path) -> Record {
  std::fs::read_to_string(file)
    .ok()
    .and_then(|text| serde_json::from_str(&text).ok())
    .unwrap_or_default()
}

/// The record written whole by a rename, so a reader never sees half of it.
pub fn write(file: &Path, record: &Record) -> Result<(), String> {
  let text = serde_json::to_string_pretty(record).map_err(|error| error.to_string())?;
  if let Some(dir) = file.parent() {
    std::fs::create_dir_all(dir).map_err(|error| error.to_string())?;
  }
  let written = file.with_extension("json.new");
  std::fs::write(&written, text)
    .and_then(|()| std::fs::rename(&written, file))
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn a_record_is_written_and_read_back_and_a_broken_one_reads_as_none() {
    let dir = std::env::temp_dir().join(format!("all-in-one-record-{}", std::process::id()));
    let file = path(&dir);
    let record = Record {
      consented_at: Some(1_795_000_000),
      chat: Some(Chat::Telegram),
      manager: Some(Manager::Supervisor),
      console: Some("http://127.0.0.1:3210/bmo/".into()),
    };
    write(&file, &record).unwrap();
    assert_eq!(read(&file), record);
    std::fs::write(&file, "{ broken").unwrap();
    assert_eq!(read(&file), Record::default());
    let _ = std::fs::remove_dir_all(&dir);
  }
}
