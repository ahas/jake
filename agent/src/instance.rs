// The install an agent runs from, named in its hello so the hub tells two installs of one name apart
// (docs/architecture.md, 「Many agents, one hub」): an id made once and kept in a file of the install's own.

use std::fs::OpenOptions;
use std::io::{ErrorKind, Write as _};
use std::path::Path;

/// The id kept at `path`, made and written there by the first call that finds none; a fresh id for this run
/// alone, with the reason, where the file can be neither read nor written.
pub fn kept_at(path: &Path) -> (String, Option<String>) {
  match read_or_make(path) {
    Ok(id) => (id, None),
    Err(reason) => (fresh(), Some(reason)),
  }
}

/// A new random id.
pub fn fresh() -> String {
  format!("{:016x}{:016x}", rand::random::<u64>(), rand::random::<u64>())
}

fn read_or_make(path: &Path) -> Result<String, String> {
  if let Some(id) = read(path)? {
    return Ok(id);
  }
  if let Some(parent) = path.parent() {
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
  }
  let id = fresh();
  // Created only where none stands, so two first runs at once keep the one written first.
  match OpenOptions::new().write(true).create_new(true).open(path) {
    Ok(mut file) => {
      file.write_all(id.as_bytes()).map_err(|error| error.to_string())?;
      Ok(id)
    }
    Err(error) if error.kind() == ErrorKind::AlreadyExists => {
      read(path)?.ok_or_else(|| format!("{} stands empty", path.display()))
    }
    Err(error) => Err(error.to_string()),
  }
}

fn read(path: &Path) -> Result<Option<String>, String> {
  match std::fs::read_to_string(path) {
    Ok(text) => Ok(Some(text.trim().to_owned()).filter(|id| !id.is_empty())),
    Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
    Err(error) => Err(error.to_string()),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn the_first_call_makes_the_id_and_every_later_one_reads_it() {
    let dir = std::env::temp_dir().join(format!("jake-instance-{}", std::process::id()));
    let path = dir.join("nested").join("instance");
    let (made, made_reason) = kept_at(&path);
    let (again, again_reason) = kept_at(&path);
    let written = std::fs::read_to_string(&path).unwrap();
    std::fs::remove_dir_all(&dir).unwrap();

    assert_eq!(made.len(), 32);
    assert_eq!(made, again);
    assert_eq!(written, made);
    assert_eq!((made_reason, again_reason), (None, None));
  }

  #[test]
  fn a_path_that_cannot_hold_the_file_gives_an_id_for_this_run_with_the_reason() {
    let dir = std::env::temp_dir().join(format!("jake-instance-blocked-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    // A file stands where the folder would be, so the id cannot be kept beneath it.
    let blocker = dir.join("blocker");
    std::fs::write(&blocker, "").unwrap();
    let (first, reason) = kept_at(&blocker.join("instance"));
    let (second, _) = kept_at(&blocker.join("instance"));
    std::fs::remove_dir_all(&dir).unwrap();

    assert!(reason.is_some());
    assert_eq!(first.len(), 32);
    assert_ne!(first, second);
  }
}
