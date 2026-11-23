// The app's own settings, kept in settings.json in the app's config directory.

use std::collections::BTreeMap;
use std::io::ErrorKind;
use std::net::IpAddr;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use url::Url;

/// The console the deployment serves, which the window opens unless the settings name another.
pub const DEFAULT_CONSOLE_URL: &str = "https://ai.example.org/bmo/";
const CONSOLE_KEY: &str = "consoleUrl";
const FILE_NAME: &str = "settings.json";
/// The byte-order mark Windows editors and PowerShell write before UTF-8.
const BYTE_ORDER_MARK: &[u8] = b"\xEF\xBB\xBF";

/// A setting a person turns on or off in the console's section for the app, named in the file and over
/// the bridge by its camelCase key; a key no switch has is refused as the call is read.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Switch {
  KeepControlWhileLocked,
  CloseToTray,
  StartAtSignIn,
  StartInTray,
  KeepAwake,
}

impl Switch {
  /// Every switch, in the order the screen shows them.
  pub const ALL: [Self; 5] = [
    Self::KeepControlWhileLocked,
    Self::CloseToTray,
    Self::StartAtSignIn,
    Self::StartInTray,
    Self::KeepAwake,
  ];

  /// The value a switch the file does not name runs on.
  pub fn default_on(self) -> bool {
    match self {
      Self::KeepControlWhileLocked | Self::CloseToTray => true,
      Self::StartAtSignIn | Self::StartInTray | Self::KeepAwake => false,
    }
  }

  /// Whether this platform acts on the switch: the lock and the system's sleep are read on Windows
  /// alone.
  pub fn offered(self) -> bool {
    match self {
      Self::KeepControlWhileLocked | Self::KeepAwake => cfg!(windows),
      Self::CloseToTray | Self::StartAtSignIn | Self::StartInTray => true,
    }
  }

  /// The switch, if this platform offers it; a change to one it does not offer is refused, since
  /// nothing here would act on it.
  pub fn offered_here(self) -> Result<Self, String> {
    if self.offered() {
      Ok(self)
    } else {
      Err(format!("{} is not offered on this platform", self.key()))
    }
  }

  fn key(self) -> String {
    match serde_json::to_value(self) {
      Ok(Value::String(key)) => key,
      _ => unreachable!("a unit variant serializes as its name"),
    }
  }
}

/// The switches as the file states them; one it does not state runs on its default.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Switches(BTreeMap<Switch, bool>);

impl Switches {
  /// Whether the switch is on.
  pub fn on(&self, switch: Switch) -> bool {
    self.stated(switch).unwrap_or_else(|| switch.default_on())
  }

  /// The value the file states, if it states one.
  pub fn stated(&self, switch: Switch) -> Option<bool> {
    self.0.get(&switch).copied()
  }

  /// The same switches with this one stated.
  pub fn with(mut self, switch: Switch, on: bool) -> Self {
    self.0.insert(switch, on);
    self
  }
}

/// The settings as the console draws them: the switches this platform offers, why the file cannot be
/// changed, where it cannot, and who draws the window's controls.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
  pub switches: Vec<SwitchView>,
  pub unreadable: Option<String>,
  pub window_controls: WindowControls,
}

/// Who draws the frameless window's controls (docs/desktop.md, 「The window's frame」).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum WindowControls {
  /// The page draws minimise, maximise and close at its top bar's right end.
  Console,
  /// The system's own buttons stand inset at the top left, and the page leaves their room.
  Inset,
}

impl WindowControls {
  /// This platform's: the macOS overlay title bar keeps the system's buttons, and elsewhere the window
  /// is undecorated.
  pub fn here() -> Self {
    if cfg!(target_os = "macos") { Self::Inset } else { Self::Console }
  }
}

/// One switch in the console's section.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchView {
  pub switch: Switch,
  pub on: bool,
}

impl Switches {
  /// The console's view of these switches, with the file's reason where it cannot be read.
  pub fn view(&self, unreadable: Option<&str>) -> SettingsView {
    let offered = Switch::ALL.into_iter().filter(|switch| switch.offered());
    SettingsView {
      switches: offered
        .map(|switch| SwitchView {
          switch,
          on: self.on(switch),
        })
        .collect(),
      unreadable: unreadable.map(str::to_owned),
      window_controls: WindowControls::here(),
    }
  }
}

/// What the app runs with.
#[derive(Clone, Debug)]
pub struct Settings {
  /// The console's address, ending in a slash so its API paths join onto it.
  pub console: Url,
  pub switches: Switches,
}

impl Settings {
  /// The settings a fresh install runs with.
  pub fn defaults() -> Self {
    Self {
      console: console_url(DEFAULT_CONSOLE_URL).expect("the default console address is well-formed"),
      switches: Switches::default(),
    }
  }

  fn from_document(document: &Map<String, Value>) -> Result<Self, String> {
    let console = match document.get(CONSOLE_KEY) {
      None => DEFAULT_CONSOLE_URL,
      Some(Value::String(raw)) => raw,
      Some(_) => return Err(format!("{CONSOLE_KEY} is not a string")),
    };
    let mut switches = Switches::default();
    for switch in Switch::ALL {
      let key = switch.key();
      match document.get(&key) {
        None => {}
        Some(Value::Bool(on)) => switches = switches.with(switch, *on),
        Some(_) => return Err(format!("{key} is not true or false")),
      }
    }
    Ok(Self {
      console: console_url(console)?,
      switches,
    })
  }
}

/// The settings file: what it held as read, every key the app does not know among it, or why it could
/// not be read, in which case the app runs on its defaults and writes nothing over it.
pub struct SettingsFile {
  path: PathBuf,
  kept: Result<(Map<String, Value>, Settings), String>,
}

impl SettingsFile {
  /// The file in `dir`; a missing file reads as an empty one.
  pub fn open(dir: &Path) -> Self {
    let path = dir.join(FILE_NAME);
    let kept = read(&path).map_err(|reason| format!("{}: {reason}", path.display()));
    Self { path, kept }
  }

  /// The settings the app runs with: the file's, or the defaults where it cannot be read.
  pub fn settings(&self) -> Settings {
    match &self.kept {
      Ok((_, settings)) => settings.clone(),
      Err(_) => Settings::defaults(),
    }
  }

  /// Why the file cannot be read, where it cannot.
  pub fn unreadable(&self) -> Option<&str> {
    self.kept.as_ref().err().map(String::as_str)
  }

  /// State a switch and write the whole file at once, keeping every other key as it was read; the
  /// switches as they now stand.
  pub fn set(&mut self, switch: Switch, on: bool) -> Result<Switches, String> {
    let (document, settings) = self.kept.as_mut().map_err(|reason| reason.clone())?;
    let mut changed = document.clone();
    changed.insert(switch.key(), Value::Bool(on));
    write(&self.path, &changed).map_err(|error| format!("{}: {error}", self.path.display()))?;
    *document = changed;
    settings.switches = std::mem::take(&mut settings.switches).with(switch, on);
    Ok(settings.switches.clone())
  }
}

fn read(path: &Path) -> Result<(Map<String, Value>, Settings), String> {
  let document = match std::fs::read(path) {
    Ok(bytes) => match serde_json::from_slice(bytes.strip_prefix(BYTE_ORDER_MARK).unwrap_or(&bytes))
      .map_err(|error| error.to_string())?
    {
      Value::Object(document) => document,
      _ => return Err("the file is not a JSON object".to_owned()),
    },
    Err(error) if error.kind() == ErrorKind::NotFound => Map::new(),
    Err(error) => return Err(error.to_string()),
  };
  let settings = Settings::from_document(&document)?;
  Ok((document, settings))
}

/// Replace the file whole by a rename, so a reader never sees half of it.
fn write(path: &Path, document: &Map<String, Value>) -> std::io::Result<()> {
  if let Some(dir) = path.parent() {
    std::fs::create_dir_all(dir)?;
  }
  let mut text = serde_json::to_vec_pretty(document)?;
  text.push(b'\n');
  let staged = path.with_extension("json.new");
  std::fs::write(&staged, text)?;
  std::fs::rename(&staged, path)
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

  /// A directory of the test's own, removed when the test ends.
  struct Dir(PathBuf);

  impl Dir {
    fn new(name: &str) -> Self {
      let dir = std::env::temp_dir().join(format!("jake-desktop-{name}-{}", std::process::id()));
      let _ = std::fs::remove_dir_all(&dir);
      std::fs::create_dir_all(&dir).unwrap();
      Self(dir)
    }

    fn holding(name: &str, text: &str) -> Self {
      let dir = Self::new(name);
      std::fs::write(dir.0.join(FILE_NAME), text).unwrap();
      dir
    }

    fn file(&self) -> Value {
      serde_json::from_slice(&std::fs::read(self.0.join(FILE_NAME)).unwrap()).unwrap()
    }
  }

  impl Drop for Dir {
    fn drop(&mut self) {
      let _ = std::fs::remove_dir_all(&self.0);
    }
  }

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
  fn a_missing_file_runs_on_the_defaults() {
    let dir = Dir::new("settings-missing");
    let file = SettingsFile::open(&dir.0);

    assert_eq!(file.unreadable(), None);
    let settings = file.settings();
    assert_eq!(settings.console.as_str(), DEFAULT_CONSOLE_URL);
    let on: Vec<bool> = Switch::ALL.iter().map(|switch| settings.switches.on(*switch)).collect();
    assert_eq!(on, [true, true, false, false, false]);
    assert_eq!(settings.switches.stated(Switch::StartAtSignIn), None);
  }

  #[test]
  fn the_file_names_the_console_and_states_switches() {
    let dir = Dir::holding(
      "settings-named",
      r#"{"consoleUrl":"https://console.example/","closeToTray":false,"keepAwake":true}"#,
    );
    let settings = SettingsFile::open(&dir.0).settings();

    assert_eq!(settings.console.as_str(), "https://console.example/");
    assert!(!settings.switches.on(Switch::CloseToTray));
    assert!(settings.switches.on(Switch::KeepAwake));
    assert!(settings.switches.on(Switch::KeepControlWhileLocked));
  }

  #[test]
  fn a_byte_order_mark_before_the_file_is_read_past() {
    let dir = Dir::new("settings-bom");
    let mut text = BYTE_ORDER_MARK.to_vec();
    text.extend_from_slice(br#"{"keepAwake":true}"#);
    std::fs::write(dir.0.join(FILE_NAME), text).unwrap();
    let file = SettingsFile::open(&dir.0);

    assert_eq!(file.unreadable(), None);
    assert!(file.settings().switches.on(Switch::KeepAwake));
  }

  #[test]
  fn a_file_that_cannot_be_read_whole_runs_on_the_defaults_and_is_never_written() {
    for (name, text) in [
      ("settings-broken", "{"),
      ("settings-wrong-type", r#"{"consoleUrl":"https://console.example/","closeToTray":"no"}"#),
    ] {
      let dir = Dir::holding(name, text);
      let mut file = SettingsFile::open(&dir.0);

      assert!(file.unreadable().unwrap().contains(FILE_NAME), "{name}");
      assert_eq!(file.settings().console.as_str(), DEFAULT_CONSOLE_URL, "{name}");
      assert!(file.set(Switch::KeepAwake, true).is_err(), "{name}");
      assert_eq!(std::fs::read_to_string(dir.0.join(FILE_NAME)).unwrap(), text, "{name}");
    }
  }

  #[test]
  fn a_change_is_written_at_once_and_keeps_every_other_key() {
    let dir = Dir::holding(
      "settings-change",
      r#"{"consoleUrl":"https://console.example/","laterSetting":{"kept":[1,2]}}"#,
    );
    let mut file = SettingsFile::open(&dir.0);
    let switches = file.set(Switch::CloseToTray, false).unwrap();

    assert!(!switches.on(Switch::CloseToTray));
    assert_eq!(
      dir.file(),
      serde_json::json!({
        "consoleUrl": "https://console.example/",
        "laterSetting": { "kept": [1, 2] },
        "closeToTray": false,
      })
    );
    let reopened = SettingsFile::open(&dir.0).settings();
    assert!(!reopened.switches.on(Switch::CloseToTray));
    assert!(!dir.0.join("settings.json.new").exists());
  }

  #[test]
  fn the_bridge_reads_a_switch_by_its_key_alone() {
    let read = |value: Value| serde_json::from_value::<Switch>(value);

    assert_eq!(read(Value::from("keepAwake")).unwrap(), Switch::KeepAwake);
    assert_eq!(read(Value::from("closeToTray")).unwrap(), Switch::CloseToTray);
    for refused in [
      Value::from("consoleUrl"),
      Value::from("KeepAwake"),
      Value::from("keep_awake"),
      Value::from(""),
      Value::from(1),
      Value::Null,
      serde_json::json!({ "keepAwake": true }),
    ] {
      assert!(read(refused.clone()).is_err(), "{refused}");
    }
  }

  #[test]
  fn a_switch_this_platform_does_not_offer_is_refused() {
    for switch in Switch::ALL {
      assert_eq!(switch.offered_here().is_ok(), switch.offered(), "{switch:?}");
    }
    assert!(Switch::CloseToTray.offered_here().is_ok());
    let windows_only = Switch::KeepAwake.offered_here();
    if cfg!(windows) {
      assert!(windows_only.is_ok());
    } else {
      assert_eq!(windows_only.unwrap_err(), "keepAwake is not offered on this platform");
    }
  }

  #[test]
  fn the_view_holds_the_offered_switches_and_who_draws_the_controls() {
    let switches = Switches::default().with(Switch::CloseToTray, false);
    let view = serde_json::to_value(switches.view(Some("unreadable"))).unwrap();
    let offered: Vec<Value> = Switch::ALL
      .into_iter()
      .filter(|switch| switch.offered())
      .map(|switch| serde_json::json!({ "switch": switch.key(), "on": switches.on(switch) }))
      .collect();

    assert_eq!(view["switches"], Value::Array(offered));
    assert_eq!(view["unreadable"], "unreadable");
    let controls = if cfg!(target_os = "macos") { "inset" } else { "console" };
    assert_eq!(view["windowControls"], controls);
  }

  #[test]
  fn a_first_change_makes_the_file_and_its_directory() {
    let dir = Dir::new("settings-first");
    let mut file = SettingsFile::open(&dir.0.join("config"));
    file.set(Switch::StartAtSignIn, true).unwrap();

    let written: Value =
      serde_json::from_slice(&std::fs::read(dir.0.join("config").join(FILE_NAME)).unwrap()).unwrap();
    assert_eq!(written, serde_json::json!({ "startAtSignIn": true }));
  }
}
