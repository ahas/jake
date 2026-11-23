// The app's own settings, kept in settings.json in the app's config directory.

use std::collections::BTreeMap;
use std::io::ErrorKind;
use std::net::IpAddr;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use url::Url;

use crate::channel::Channel;

const CONSOLE_KEY: &str = "consoleUrl";
const CHANNEL_KEY: &str = "updateChannel";
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

/// A setting's key over the bridge: a switch's, the update channel's or the server's; any other is refused
/// as the call is read.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(untagged)]
pub enum Key {
  Switch(Switch),
  Value(ValueKey),
}

/// A setting that takes a value rather than on or off.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ValueKey {
  /// The update channel, `stable` or `nightly`.
  UpdateChannel,
  /// The server the app connects to, the console's address.
  ConsoleUrl,
}

/// One change the console asks for, checked before anything is written.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Change {
  Switch(Switch, bool),
  Channel(Channel),
  /// The server's address as it was entered, checked in full before it is written.
  Console(String),
}

impl Change {
  /// The change a call names: a switch this platform offers with `on`, the channel with a `value` that
  /// is a channel, or the server with a `value` that is a text; a key given the other kind's value, or
  /// none, is refused.
  pub fn read(key: Key, on: Option<bool>, value: Option<Value>) -> Result<Self, String> {
    match (key, on, value) {
      (Key::Switch(switch), Some(on), None) => Ok(Self::Switch(switch.offered_here()?, on)),
      (Key::Switch(switch), _, _) => Err(format!("{} takes on, true or false, and no value", switch.key())),
      (Key::Value(ValueKey::UpdateChannel), None, Some(value)) => serde_json::from_value(value)
        .map(Self::Channel)
        .map_err(|_| format!("{CHANNEL_KEY} takes a value, stable or nightly")),
      (Key::Value(ValueKey::UpdateChannel), _, _) => {
        Err(format!("{CHANNEL_KEY} takes a value, stable or nightly, and no on"))
      }
      (Key::Value(ValueKey::ConsoleUrl), None, Some(Value::String(address))) => Ok(Self::Console(address)),
      (Key::Value(ValueKey::ConsoleUrl), _, _) => {
        Err(format!("{CONSOLE_KEY} takes a value, an address, and no on"))
      }
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

/// The settings as the console draws them: the switches this platform offers, the update channel, the
/// server the app connects to, why the file cannot be changed, where it cannot, and who draws the window's
/// controls.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
  pub switches: Vec<SwitchView>,
  pub update_channel: Channel,
  /// The console's address the app runs on, none while it has none.
  pub console_url: Option<String>,
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
  /// The console's view of these switches, the channel and the server, with the file's reason where it
  /// cannot be read.
  pub fn view(&self, channel: Channel, console: Option<&Url>, unreadable: Option<&str>) -> SettingsView {
    let offered = Switch::ALL.into_iter().filter(|switch| switch.offered());
    SettingsView {
      switches: offered
        .map(|switch| SwitchView {
          switch,
          on: self.on(switch),
        })
        .collect(),
      update_channel: channel,
      console_url: console.map(|url| url.as_str().to_owned()),
      unreadable: unreadable.map(str::to_owned),
      window_controls: WindowControls::here(),
    }
  }
}

/// What the app runs with.
#[derive(Clone, Debug, Default)]
pub struct Settings {
  /// The console's address, ending in a slash so its API paths join onto it; none until the person
  /// names their server, since a build carries no deployment's address.
  pub console: Option<Url>,
  pub switches: Switches,
  pub channel: Channel,
}

impl Settings {
  fn from_document(document: &Map<String, Value>) -> Result<Self, String> {
    let console = match document.get(CONSOLE_KEY) {
      None => None,
      Some(Value::String(raw)) => Some(console_url(raw)?),
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
    let channel = match document.get(CHANNEL_KEY) {
      None => Channel::default(),
      Some(value) => serde_json::from_value(value.clone())
        .map_err(|_| format!("{CHANNEL_KEY} is neither stable nor nightly"))?,
    };
    Ok(Self {
      console,
      switches,
      channel,
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
      Err(_) => Settings::default(),
    }
  }

  /// Why the file cannot be read, where it cannot.
  pub fn unreadable(&self) -> Option<&str> {
    self.kept.as_ref().err().map(String::as_str)
  }

  /// State a switch and write the whole file at once, keeping every other key as it was read; the
  /// switches as they now stand.
  pub fn set(&mut self, switch: Switch, on: bool) -> Result<Switches, String> {
    let settings = self.write_key(switch.key(), Value::Bool(on))?;
    settings.switches = std::mem::take(&mut settings.switches).with(switch, on);
    Ok(settings.switches.clone())
  }

  /// State the update channel and write the whole file at once, keeping every other key as it was read.
  pub fn set_channel(&mut self, channel: Channel) -> Result<(), String> {
    let value = serde_json::to_value(channel).map_err(|error| error.to_string())?;
    self.write_key(CHANNEL_KEY.to_owned(), value)?.channel = channel;
    Ok(())
  }

  /// State the server's address and write the whole file at once, keeping every other key as it was read.
  pub fn set_console(&mut self, console: &Url) -> Result<(), String> {
    self
      .write_key(CONSOLE_KEY.to_owned(), Value::String(console.as_str().to_owned()))?
      .console = Some(console.clone());
    Ok(())
  }

  /// Write one key into the file as read, replacing it whole; the settings to bring into line with it.
  fn write_key(&mut self, key: String, value: Value) -> Result<&mut Settings, String> {
    let (document, settings) = self.kept.as_mut().map_err(|reason| reason.clone())?;
    let mut changed = document.clone();
    changed.insert(key, value);
    write(&self.path, &changed).map_err(|error| format!("{}: {error}", self.path.display()))?;
    *document = changed;
    Ok(settings)
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

/// A console address as the base its API paths join onto: HTTPS, or plain HTTP on this machine alone
/// (`localhost` or a loopback address), with no query or fragment, and ending in a slash.
pub fn console_url(raw: &str) -> Result<Url, String> {
  let mut url =
    Url::parse(raw).map_err(|error| format!("the console address {raw} is not a URL: {error}"))?;
  let loopback = url.host_str().is_some_and(|host| {
    host.eq_ignore_ascii_case("localhost")
      || host.trim_matches(['[', ']']).parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback())
  });
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
  }

  #[test]
  fn a_console_address_is_https_or_plain_http_on_this_machine_alone() {
    for local in [
      "http://127.0.0.1:4000",
      "http://localhost:3000/bmo",
      "http://LOCALHOST/",
      "http://[::1]:8080/",
    ] {
      assert!(console_url(local).is_ok(), "{local}");
    }
    assert_eq!(console_url("http://localhost:3000/bmo").unwrap().as_str(), "http://localhost:3000/bmo/");
    for refused in [
      "http://console.example/",
      "http://localhost.example/",
      "http://10.0.0.7/",
      "ftp://console.example/",
      "console.example",
      "",
    ] {
      assert!(console_url(refused).is_err(), "{refused}");
    }
  }

  #[test]
  fn a_missing_file_names_no_server_and_runs_on_the_defaults() {
    let dir = Dir::new("settings-missing");
    let file = SettingsFile::open(&dir.0);

    assert_eq!(file.unreadable(), None);
    let settings = file.settings();
    assert_eq!(settings.console, None);
    let on: Vec<bool> = Switch::ALL.iter().map(|switch| settings.switches.on(*switch)).collect();
    assert_eq!(on, [true, true, false, false, false]);
    assert_eq!(settings.switches.stated(Switch::StartAtSignIn), None);
    assert_eq!(settings.channel, Channel::Stable);
  }

  #[test]
  fn the_file_names_the_console_and_states_switches() {
    let dir = Dir::holding(
      "settings-named",
      r#"{"consoleUrl":"https://console.example/","closeToTray":false,"keepAwake":true}"#,
    );
    let settings = SettingsFile::open(&dir.0).settings();

    assert_eq!(settings.console.unwrap().as_str(), "https://console.example/");
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
      ("settings-no-channel", r#"{"updateChannel":"beta"}"#),
      ("settings-channel-type", r#"{"updateChannel":true}"#),
      ("settings-console-type", r#"{"consoleUrl":7}"#),
      ("settings-console-http", r#"{"consoleUrl":"http://console.example/"}"#),
    ] {
      let dir = Dir::holding(name, text);
      let mut file = SettingsFile::open(&dir.0);

      assert!(file.unreadable().unwrap().contains(FILE_NAME), "{name}");
      assert_eq!(file.settings().console, None, "{name}");
      assert!(file.set(Switch::KeepAwake, true).is_err(), "{name}");
      assert!(file.set_channel(Channel::Nightly).is_err(), "{name}");
      assert!(file.set_console(&console_url("https://console.example/").unwrap()).is_err(), "{name}");
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
  fn the_channel_is_written_at_once_and_read_back() {
    let dir = Dir::holding("settings-channel", r#"{"closeToTray":false}"#);
    let mut file = SettingsFile::open(&dir.0);
    file.set_channel(Channel::Nightly).unwrap();

    assert_eq!(file.settings().channel, Channel::Nightly);
    assert_eq!(dir.file(), serde_json::json!({ "closeToTray": false, "updateChannel": "nightly" }));
    let reopened = SettingsFile::open(&dir.0).settings();
    assert_eq!(reopened.channel, Channel::Nightly);
    assert!(!reopened.switches.on(Switch::CloseToTray));
  }

  #[test]
  fn the_bridge_reads_a_key_as_a_switch_or_the_channel_alone() {
    let read = |value: Value| serde_json::from_value::<Key>(value);

    assert_eq!(read(Value::from("keepAwake")).unwrap(), Key::Switch(Switch::KeepAwake));
    assert_eq!(read(Value::from("updateChannel")).unwrap(), Key::Value(ValueKey::UpdateChannel));
    assert_eq!(read(Value::from("consoleUrl")).unwrap(), Key::Value(ValueKey::ConsoleUrl));
    for refused in [
      Value::from("ConsoleUrl"),
      Value::from("console_url"),
      Value::from("UpdateChannel"),
      Value::from("update_channel"),
      Value::from(""),
      Value::from(1),
      Value::Null,
    ] {
      assert!(read(refused.clone()).is_err(), "{refused}");
    }
  }

  #[test]
  fn a_change_takes_on_for_a_switch_and_a_value_for_the_channel_and_the_server() {
    let channel = Key::Value(ValueKey::UpdateChannel);
    let console = Key::Value(ValueKey::ConsoleUrl);
    let switch = Key::Switch(Switch::CloseToTray);
    let address = || Some(Value::from("https://console.example/"));

    assert_eq!(
      Change::read(channel, None, Some(Value::from("nightly"))).unwrap(),
      Change::Channel(Channel::Nightly)
    );
    assert_eq!(
      Change::read(switch, Some(false), None).unwrap(),
      Change::Switch(Switch::CloseToTray, false)
    );
    assert_eq!(
      Change::read(console, None, address()).unwrap(),
      Change::Console("https://console.example/".to_owned())
    );
    for (key, on, value) in [
      (channel, None, None),
      (channel, Some(true), None),
      (channel, Some(true), Some(Value::from("stable"))),
      (channel, None, Some(Value::from("beta"))),
      (channel, None, address()),
      (console, None, None),
      (console, Some(true), None),
      (console, Some(true), address()),
      (console, None, Some(Value::from(7))),
      (switch, None, None),
      (switch, None, Some(Value::from("stable"))),
      (switch, Some(true), Some(Value::from("stable"))),
    ] {
      assert!(Change::read(key, on, value.clone()).is_err(), "{key:?} {on:?} {value:?}");
    }
    let windows_only = Change::read(Key::Switch(Switch::KeepAwake), Some(true), None);
    assert_eq!(windows_only.is_ok(), cfg!(windows));
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
    let console = console_url("https://console.example/bmo").unwrap();
    let view =
      serde_json::to_value(switches.view(Channel::Nightly, Some(&console), Some("unreadable"))).unwrap();
    let offered: Vec<Value> = Switch::ALL
      .into_iter()
      .filter(|switch| switch.offered())
      .map(|switch| serde_json::json!({ "switch": switch.key(), "on": switches.on(switch) }))
      .collect();

    assert_eq!(view["switches"], Value::Array(offered));
    assert_eq!(view["updateChannel"], "nightly");
    assert_eq!(view["consoleUrl"], "https://console.example/bmo/");
    assert_eq!(view["unreadable"], "unreadable");
    let serverless = serde_json::to_value(switches.view(Channel::Stable, None, None)).unwrap();
    assert_eq!(serverless["consoleUrl"], Value::Null);
    let controls = if cfg!(target_os = "macos") { "inset" } else { "console" };
    assert_eq!(view["windowControls"], controls);
  }

  #[test]
  fn the_server_is_written_at_once_keeping_every_other_key_and_read_back() {
    let dir = Dir::holding("settings-console", r#"{"closeToTray":false,"laterSetting":1}"#);
    let mut file = SettingsFile::open(&dir.0);
    file.set_console(&console_url("https://bmo.example/console").unwrap()).unwrap();

    assert_eq!(file.settings().console.unwrap().as_str(), "https://bmo.example/console/");
    assert_eq!(
      dir.file(),
      serde_json::json!({ "closeToTray": false, "laterSetting": 1, "consoleUrl": "https://bmo.example/console/" })
    );
    let reopened = SettingsFile::open(&dir.0).settings();
    assert_eq!(reopened.console.unwrap().as_str(), "https://bmo.example/console/");
    assert!(!reopened.switches.on(Switch::CloseToTray));
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
