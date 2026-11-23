// The one step that carries an installation made by a build that had its console's address built in onto
// a settings file that names it (docs/desktop.md, 「The server」).

use url::Url;

use crate::settings::{SettingsFile, console_url};

/// The address the builds before the server became a setting carried, and that every installation of
/// them opened. It is read here alone, to keep such an installation on the console it was paired with.
pub const LEGACY_CONSOLE_URL: &str = "https://ai.example.org/bmo/";

/// What the migration did at this start.
#[derive(Debug, PartialEq, Eq)]
pub enum Migrated {
  /// The file names a server already, cannot be read, or the installation shows no sign of an earlier
  /// build: nothing was written.
  Untouched,
  /// The installation was paired by an earlier build, so the address that build carried was written.
  Legacy(Url),
  /// The address was due but could not be written, for the reason given.
  NotWritten(String),
}

/// Write the earlier builds' address into a settings file that names no server, where `paired_with`
/// answers that a credential is kept for that console, which only an earlier build could have kept
/// without the person naming it.
pub fn migrate(file: &mut SettingsFile, paired_with: impl FnOnce(&Url) -> bool) -> Migrated {
  if file.unreadable().is_some() || file.settings().console.is_some() {
    return Migrated::Untouched;
  }
  let legacy = console_url(LEGACY_CONSOLE_URL).expect("the earlier builds' address is well-formed");
  if !paired_with(&legacy) {
    return Migrated::Untouched;
  }
  match file.set_console(&legacy) {
    Ok(()) => Migrated::Legacy(legacy),
    Err(reason) => Migrated::NotWritten(reason),
  }
}

#[cfg(test)]
mod tests {
  use std::path::PathBuf;

  use super::*;

  struct Dir(PathBuf);

  impl Dir {
    fn holding(name: &str, text: Option<&str>) -> Self {
      let dir = std::env::temp_dir().join(format!("jake-desktop-{name}-{}", std::process::id()));
      let _ = std::fs::remove_dir_all(&dir);
      std::fs::create_dir_all(&dir).unwrap();
      if let Some(text) = text {
        std::fs::write(dir.join("settings.json"), text).unwrap();
      }
      Self(dir)
    }

    fn text(&self) -> Option<String> {
      std::fs::read_to_string(self.0.join("settings.json")).ok()
    }
  }

  impl Drop for Dir {
    fn drop(&mut self) {
      let _ = std::fs::remove_dir_all(&self.0);
    }
  }

  #[test]
  fn an_installation_paired_by_an_earlier_build_keeps_its_console() {
    let dir = Dir::holding("migrate-paired", Some(r#"{"startAtSignIn":true}"#));
    let mut file = SettingsFile::open(&dir.0);
    let mut asked = None;

    let migrated = migrate(&mut file, |console| {
      asked = Some(console.clone());
      true
    });

    assert_eq!(migrated, Migrated::Legacy(console_url(LEGACY_CONSOLE_URL).unwrap()));
    assert_eq!(asked.unwrap().as_str(), LEGACY_CONSOLE_URL);
    assert_eq!(file.settings().console.unwrap().as_str(), LEGACY_CONSOLE_URL);
    let written: serde_json::Value = serde_json::from_str(&dir.text().unwrap()).unwrap();
    assert_eq!(written, serde_json::json!({ "startAtSignIn": true, "consoleUrl": LEGACY_CONSOLE_URL }));
    // Once written, the next start finds the server named and asks nothing more.
    let mut reopened = SettingsFile::open(&dir.0);
    assert_eq!(migrate(&mut reopened, |_| panic!("not asked again")), Migrated::Untouched);
  }

  #[test]
  fn an_installation_with_no_file_but_a_credential_is_migrated_too() {
    let dir = Dir::holding("migrate-no-file", None);
    let mut file = SettingsFile::open(&dir.0);

    assert!(matches!(migrate(&mut file, |_| true), Migrated::Legacy(_)));
    assert!(dir.text().unwrap().contains(LEGACY_CONSOLE_URL));
  }

  #[test]
  fn a_fresh_installation_is_left_to_ask_for_its_server() {
    let dir = Dir::holding("migrate-fresh", Some(r#"{"closeToTray":false}"#));
    let mut file = SettingsFile::open(&dir.0);

    assert_eq!(migrate(&mut file, |_| false), Migrated::Untouched);
    assert_eq!(file.settings().console, None);
    assert_eq!(dir.text().unwrap(), r#"{"closeToTray":false}"#);
  }

  #[test]
  fn a_named_server_or_an_unreadable_file_is_never_touched() {
    for (name, text) in
      [("migrate-named", r#"{"consoleUrl":"https://bmo.example/"}"#), ("migrate-broken", "{")]
    {
      let dir = Dir::holding(name, Some(text));
      let mut file = SettingsFile::open(&dir.0);

      assert_eq!(migrate(&mut file, |_| panic!("not asked")), Migrated::Untouched, "{name}");
      assert_eq!(dir.text().unwrap(), text, "{name}");
    }
  }
}
