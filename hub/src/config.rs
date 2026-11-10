// The hub's configuration: its one env file under the data directory, overridden by the process environment.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

const DEFAULT_HUB_HOST: &str = "0.0.0.0";
const DEFAULT_HUB_PORT: i64 = 8790;
const DEFAULT_CONTROL_PORT: i64 = 8791;
const DEFAULT_MAX_PAYLOAD_BYTES: i64 = 16 * 1024 * 1024;
const DEFAULT_PING_INTERVAL_MS: i64 = 15_000;
const DEFAULT_MISSED_PONG_LIMIT: i64 = 3;
const DEFAULT_SOCKET_BACKLOG_BYTES: i64 = 4 * 1024 * 1024;

pub struct HubConfig {
  pub host: String,
  pub port: u16,
  pub secret: String,
  /// The key a credential of one agent name is made with; none admits the shared secret alone.
  pub agent_key: Option<String>,
  pub control_port: u16,
  pub control_token: String,
  pub max_payload_bytes: usize,
  pub ping_interval: Duration,
  pub missed_pong_limit: u32,
  pub socket_backlog_bytes: usize,
  pub departed_path: PathBuf,
}

/// What a client of the running hub needs to reach its control API, from the hub's own file.
pub struct ControlConfig {
  pub port: u16,
  pub token: String,
}

/// Where the hub's file is: `JAKE_HUB_ENV` when set, else `hub.env` under the data directory.
fn env_path(process: &HashMap<String, String>) -> PathBuf {
  if let Some(path) = process.get("JAKE_HUB_ENV") {
    return PathBuf::from(path);
  }
  let home = process.get("HOME").cloned().unwrap_or_default();
  PathBuf::from(home).join(".local/share/jake/hub.env")
}

/// The record of departed agents, beside the hub's file in the data directory.
fn departed_path(process: &HashMap<String, String>) -> PathBuf {
  env_path(process).with_file_name("departed.json")
}

/// The environment the hub runs against: its file's values, under the process's own.
fn merged(process: HashMap<String, String>) -> Result<HashMap<String, String>, String> {
  let path = env_path(&process);
  let mut merged = HashMap::new();
  if path.exists() {
    let entries = dotenvy::from_path_iter(&path).map_err(|error| format!("{}: {error}", path.display()))?;
    for entry in entries {
      let (key, value) = entry.map_err(|error| format!("{}: {error}", path.display()))?;
      merged.insert(key, value);
    }
  }
  merged.extend(process);
  Ok(merged)
}

// The leading integer of a value, the way JavaScript's parseInt reads one: "12abc" is 12.
pub fn leading_int(raw: &str) -> Option<i64> {
  let text = raw.trim_start();
  let digits_from = usize::from(text.starts_with(['+', '-']));
  let digits = text[digits_from..].bytes().take_while(u8::is_ascii_digit).count();
  if digits == 0 {
    return None;
  }
  text[..digits_from + digits].parse().ok()
}

struct Source(HashMap<String, String>);

impl Source {
  fn present(&self, name: &str) -> Option<&str> {
    self.0.get(name).map(String::as_str).filter(|value| !value.is_empty())
  }

  fn required(&self, name: &str) -> Result<String, String> {
    self
      .present(name)
      .map(str::to_owned)
      .ok_or_else(|| format!("{name} is not set. Copy the matching .env.example and fill it in."))
  }

  fn positive(&self, name: &str, fallback: i64) -> Result<i64, String> {
    let value = match self.present(name) {
      None => fallback,
      Some(raw) => leading_int(raw).ok_or_else(|| format!("{name} must be an integer."))?,
    };
    if value <= 0 {
      return Err(format!("{name} must be a positive integer."));
    }
    Ok(value)
  }

  fn port(&self, name: &str, fallback: i64) -> Result<u16, String> {
    u16::try_from(self.positive(name, fallback)?).map_err(|_| format!("{name} must be a port number."))
  }

  fn count(&self, name: &str, fallback: i64) -> Result<usize, String> {
    usize::try_from(self.positive(name, fallback)?).map_err(|_| format!("{name} is too large."))
  }
}

/// Read the hub's configuration, naming the first key that is missing or malformed.
pub fn load() -> Result<HubConfig, String> {
  let process: HashMap<String, String> = std::env::vars().collect();
  let departed = departed_path(&process);
  read(&Source(merged(process)?), departed)
}

/// Read the control API's port and token, naming the key that is missing or malformed.
pub fn load_control() -> Result<ControlConfig, String> {
  let env = Source(merged(std::env::vars().collect())?);
  Ok(ControlConfig {
    port: env.port("JAKE_CONTROL_PORT", DEFAULT_CONTROL_PORT)?,
    token: env.required("JAKE_CONTROL_TOKEN")?,
  })
}

fn read(env: &Source, departed_path: PathBuf) -> Result<HubConfig, String> {
  Ok(HubConfig {
    host: env.present("JAKE_HUB_HOST").unwrap_or(DEFAULT_HUB_HOST).to_owned(),
    port: env.port("JAKE_HUB_PORT", DEFAULT_HUB_PORT)?,
    secret: env.required("JAKE_SECRET")?,
    agent_key: env.present("JAKE_AGENT_KEY").map(|key| key.trim().to_owned()),
    control_port: env.port("JAKE_CONTROL_PORT", DEFAULT_CONTROL_PORT)?,
    control_token: env.required("JAKE_CONTROL_TOKEN")?,
    max_payload_bytes: env.count("JAKE_MAX_PAYLOAD_BYTES", DEFAULT_MAX_PAYLOAD_BYTES)?,
    ping_interval: Duration::from_millis(
      env.count("JAKE_HUB_PING_INTERVAL_MS", DEFAULT_PING_INTERVAL_MS)? as u64
    ),
    missed_pong_limit: u32::try_from(
      env.positive("JAKE_HUB_MISSED_PONG_LIMIT", DEFAULT_MISSED_PONG_LIMIT)?,
    )
    .map_err(|_| "JAKE_HUB_MISSED_PONG_LIMIT is too large.".to_owned())?,
    socket_backlog_bytes: env.count("JAKE_HUB_SOCKET_BACKLOG_BYTES", DEFAULT_SOCKET_BACKLOG_BYTES)?,
    departed_path,
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  fn source(pairs: &[(&str, &str)]) -> Source {
    Source(pairs.iter().map(|(key, value)| ((*key).to_owned(), (*value).to_owned())).collect())
  }

  const REQUIRED: [(&str, &str); 2] = [("JAKE_SECRET", "s3cr3t"), ("JAKE_CONTROL_TOKEN", "c0nsole")];

  fn error_of(pairs: &[(&str, &str)]) -> String {
    read(&source(pairs), PathBuf::new()).err().expect("refused")
  }

  #[test]
  fn reads_the_required_keys_and_applies_defaults() {
    let config = read(&source(&REQUIRED), PathBuf::new()).expect("loads");
    assert_eq!((config.host.as_str(), config.port, config.control_port), ("0.0.0.0", 8790, 8791));
    assert_eq!((config.secret.as_str(), config.control_token.as_str()), ("s3cr3t", "c0nsole"));
    assert_eq!(config.max_payload_bytes, 16 * 1024 * 1024);
    assert_eq!((config.ping_interval, config.missed_pong_limit), (Duration::from_secs(15), 3));
  }

  #[test]
  fn honours_overrides() {
    let pairs = [
      REQUIRED[0],
      REQUIRED[1],
      ("JAKE_HUB_HOST", "127.0.0.1"),
      ("JAKE_HUB_PORT", "9000"),
      ("JAKE_CONTROL_PORT", "9001"),
    ];
    let config = read(&source(&pairs), PathBuf::new()).expect("loads");
    assert_eq!((config.host.as_str(), config.port, config.control_port), ("127.0.0.1", 9000, 9001));
  }

  #[test]
  fn names_a_missing_or_malformed_key() {
    assert!(error_of(&[REQUIRED[1]]).starts_with("JAKE_SECRET is not set"));
    assert!(
      error_of(&[REQUIRED[0], ("JAKE_CONTROL_TOKEN", "")]).starts_with("JAKE_CONTROL_TOKEN is not set")
    );
    assert_eq!(
      error_of(&[REQUIRED[0], REQUIRED[1], ("JAKE_HUB_PORT", "eighty")]),
      "JAKE_HUB_PORT must be an integer."
    );
    assert_eq!(
      error_of(&[REQUIRED[0], REQUIRED[1], ("JAKE_CONTROL_PORT", "0")]),
      "JAKE_CONTROL_PORT must be a positive integer."
    );
    assert_eq!(
      error_of(&[REQUIRED[0], REQUIRED[1], ("JAKE_HUB_PORT", "70000")]),
      "JAKE_HUB_PORT must be a port number."
    );
  }

  #[test]
  fn the_file_sits_under_the_process_environment() {
    let path = std::env::temp_dir().join(format!("jake-hub-config-{}.env", std::process::id()));
    std::fs::write(
      &path,
      "# hub\nJAKE_SECRET=from-file\nJAKE_CONTROL_TOKEN=\"quoted\"\nJAKE_HUB_PORT=9001\n",
    )
    .expect("writes");
    let process = HashMap::from([
      ("JAKE_HUB_ENV".to_owned(), path.display().to_string()),
      ("JAKE_SECRET".to_owned(), "from-env".to_owned()),
    ]);
    let config = read(&Source(merged(process).expect("reads")), PathBuf::new());
    std::fs::remove_file(&path).expect("removes");
    let config = config.expect("loads");
    assert_eq!(
      (config.secret.as_str(), config.control_token.as_str(), config.port),
      ("from-env", "quoted", 9001)
    );
  }

  #[test]
  fn an_integer_is_read_from_the_front_of_a_value() {
    assert_eq!(leading_int("8790"), Some(8790));
    assert_eq!(leading_int(" 12abc"), Some(12));
    assert_eq!(leading_int("-3"), Some(-3));
    assert_eq!(leading_int("abc"), None);
    assert_eq!(leading_int("+"), None);
  }
}
