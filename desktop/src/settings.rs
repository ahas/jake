// The app's own settings: the console's address, from settings.json in the app's config directory.

use std::io::ErrorKind;
use std::net::IpAddr;
use std::path::Path;

use serde::Deserialize;
use url::Url;

/// The console the deployment serves, which the window opens unless the settings name another.
pub const DEFAULT_CONSOLE_URL: &str = "https://ai.example.org/bmo/";

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct File {
  console_url: Option<String>,
}

/// What the app runs with.
pub struct Settings {
  /// The console's address, ending in a slash so its API paths join onto it.
  pub console: Url,
}

impl Settings {
  /// The settings kept in `dir`, the defaults where no file is kept; a file that cannot be read is an
  /// error naming it.
  pub fn read(dir: &Path) -> Result<Self, String> {
    let path = dir.join("settings.json");
    let file: File = match std::fs::read(&path) {
      Ok(bytes) => {
        serde_json::from_slice(&bytes).map_err(|error| format!("{}: {error}", path.display()))?
      }
      Err(error) if error.kind() == ErrorKind::NotFound => File::default(),
      Err(error) => return Err(format!("{}: {error}", path.display())),
    };
    let console = console_url(file.console_url.as_deref().unwrap_or(DEFAULT_CONSOLE_URL))?;
    Ok(Self { console })
  }

  /// The settings a fresh install runs with.
  pub fn defaults() -> Self {
    Self {
      console: console_url(DEFAULT_CONSOLE_URL).expect("the default console address is well-formed"),
    }
  }
}

/// A console address as the base its API paths join onto: HTTPS, or plain HTTP on the loopback alone,
/// with no query or fragment, and ending in a slash.
pub fn console_url(raw: &str) -> Result<Url, String> {
  let mut url =
    Url::parse(raw).map_err(|error| format!("the console address {raw} is not a URL: {error}"))?;
  let loopback = url
    .host_str()
    .and_then(|host| host.trim_matches(['[', ']']).parse::<IpAddr>().ok())
    .is_some_and(|ip| ip.is_loopback());
  if url.scheme() != "https" && !(url.scheme() == "http" && loopback) {
    return Err(format!("the console address {raw} must be an https address"));
  }
  if !url.path().ends_with('/') {
    let path = format!("{}/", url.path());
    url.set_path(&path);
  }
  url.set_query(None);
  url.set_fragment(None);
  Ok(url)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn a_console_address_becomes_a_base_its_paths_join_onto() {
    let base = console_url("https://console.example/bmo?tab=1#top").unwrap();
    assert_eq!(base.as_str(), "https://console.example/bmo/");
    assert_eq!(
      base.join("api/desktop/pairings").unwrap().as_str(),
      "https://console.example/bmo/api/desktop/pairings"
    );
    assert_eq!(console_url("http://127.0.0.1:4000").unwrap().as_str(), "http://127.0.0.1:4000/");
    assert!(console_url("http://console.example/").is_err());
  }

  #[test]
  fn the_settings_file_names_the_console_or_leaves_the_default() {
    let dir = std::env::temp_dir().join(format!("jake-desktop-settings-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let absent = Settings::read(&dir).map(|settings| settings.console);
    std::fs::write(dir.join("settings.json"), r#"{"consoleUrl":"https://console.example/"}"#).unwrap();
    let named = Settings::read(&dir).map(|settings| settings.console);
    std::fs::write(dir.join("settings.json"), "{").unwrap();
    let broken = Settings::read(&dir).map(|settings| settings.console);
    std::fs::remove_dir_all(&dir).unwrap();

    assert_eq!(absent.unwrap().as_str(), DEFAULT_CONSOLE_URL);
    assert_eq!(named.unwrap().as_str(), "https://console.example/");
    assert!(broken.unwrap_err().contains("settings.json"));
  }
}
