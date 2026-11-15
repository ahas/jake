// The agent's configuration: agent.env beside its executable, overridden by the process environment.

use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

const DEFAULT_HEARTBEAT_MS: i64 = 15_000;
const DEFAULT_TICK_MS: i64 = 60_000;
// Three ticks: a peer is declared dead only after it missed three heartbeat writes in a row.
const DEFAULT_WATCHDOG_STALE_MS: i64 = 180_000;
const DEFAULT_MAX_PAYLOAD_BYTES: i64 = 16 * 1024 * 1024;
const DEFAULT_EXEC_MAX_OUTPUT_BYTES: i64 = 8 * 1024 * 1024;
const DEFAULT_EXEC_TIMEOUT_MS: i64 = 5 * 60 * 1000;
const DEFAULT_REDIAL_BASE_MS: i64 = 1_000;
const DEFAULT_REDIAL_CAP_MS: i64 = 60_000;
// The SSH port: what a byte stream is for, unless the machine's config says otherwise.
const DEFAULT_STREAM_PORTS: &str = "22";
// The value of the port list that lets no stream reach the machine.
const NO_STREAM_PORTS: &str = "none";
// The byte order mark Windows tools put before UTF-8 text, which the env parser would read as part of the first key.
const UTF8_BOM: &[u8] = b"\xEF\xBB\xBF";

/// What the agent needs to dial the hub, serve it, and keep itself alive.
#[derive(Clone, Debug)]
pub struct AgentConfig {
  pub hub_url: String,
  pub secret: String,
  pub agent_name: String,
  pub heartbeat: Duration,
  pub tick: Duration,
  pub watchdog_stale: Duration,
  pub max_payload_bytes: usize,
  pub exec_max_output_bytes: u64,
  pub exec_timeout: Duration,
  pub redial_base: Duration,
  pub redial_cap: Duration,
  /// The local ports a byte stream from the hub may reach.
  pub stream_ports: Vec<u16>,
  /// The local ports the agent may listen on for streams back to the hub, at its loopback alone.
  pub listen_ports: Vec<u16>,
}

impl AgentConfig {
  /// A configuration held in memory: the three values a hub needs, every other setting at the
  /// default an `agent.env` holding only those three would give.
  pub fn new(hub_url: String, secret: String, agent_name: String) -> Self {
    settings(&Source(&HashMap::new()), hub_url, secret, agent_name)
      .expect("every default setting is well-formed")
  }
}

/// The environment the agent runs against: agent.env beside the executable, under the process's own.
pub fn merged(
  install_dir: &Path,
  process: HashMap<String, String>,
) -> Result<HashMap<String, String>, String> {
  let path = install_dir.join("agent.env");
  let mut merged = HashMap::new();
  if path.exists() {
    let bytes = std::fs::read(&path).map_err(|error| format!("{}: {error}", path.display()))?;
    let body = bytes.strip_prefix(UTF8_BOM).unwrap_or(&bytes);
    for entry in dotenvy::from_read_iter(body) {
      let (key, value) = entry.map_err(|error| format!("{}: {error}", path.display()))?;
      merged.insert(key, value);
    }
  }
  merged.extend(process);
  Ok(merged)
}

// The leading integer of a value, the way JavaScript's parseInt reads one: "12abc" is 12.
fn leading_int(raw: &str) -> Option<i64> {
  let text = raw.trim_start();
  let digits_from = usize::from(text.starts_with(['+', '-']));
  let digits = text[digits_from..].bytes().take_while(u8::is_ascii_digit).count();
  if digits == 0 {
    return None;
  }
  text[..digits_from + digits].parse().ok()
}

struct Source<'a>(&'a HashMap<String, String>);

impl Source<'_> {
  fn present(&self, name: &str) -> Option<&str> {
    self.0.get(name).map(String::as_str).filter(|value| !value.is_empty())
  }

  fn required(&self, name: &str) -> Result<String, String> {
    self
      .present(name)
      .map(str::to_owned)
      .ok_or_else(|| format!("{name} is not set. Copy the matching .env.example and fill it in."))
  }

  fn positive(&self, name: &str, fallback: i64) -> Result<u64, String> {
    let value = match self.present(name) {
      None => fallback,
      Some(raw) => leading_int(raw).ok_or_else(|| format!("{name} must be an integer."))?,
    };
    u64::try_from(value)
      .ok()
      .filter(|value| *value > 0)
      .ok_or_else(|| format!("{name} must be a positive integer."))
  }

  fn millis(&self, name: &str, fallback: i64) -> Result<Duration, String> {
    self.positive(name, fallback).map(Duration::from_millis)
  }

  // A comma-separated list of port numbers, or the word that names none.
  fn ports(&self, name: &str, fallback: &str) -> Result<Vec<u16>, String> {
    let raw = self.present(name).unwrap_or(fallback).trim();
    if raw.eq_ignore_ascii_case(NO_STREAM_PORTS) {
      return Ok(Vec::new());
    }
    let malformed =
      || format!("{name} must be a comma-separated list of port numbers, or {NO_STREAM_PORTS}.");
    let mut ports = Vec::new();
    for item in raw.split(',') {
      let port = item.trim().parse::<u16>().ok().filter(|port| *port > 0).ok_or_else(malformed)?;
      if !ports.contains(&port) {
        ports.push(port);
      }
    }
    Ok(ports)
  }
}

/// Read the agent's configuration, naming the first key that is missing or malformed.
pub fn read(env: &HashMap<String, String>) -> Result<AgentConfig, String> {
  let env = Source(env);
  let hub_url = env.required("JAKE_HUB_URL")?;
  let secret = env.required("JAKE_SECRET")?;
  let agent_name = env.required("JAKE_AGENT_NAME")?;
  settings(&env, hub_url, secret, agent_name)
}

// Every setting past the three required ones, each read from the source or left at its default.
fn settings(
  env: &Source,
  hub_url: String,
  secret: String,
  agent_name: String,
) -> Result<AgentConfig, String> {
  Ok(AgentConfig {
    hub_url,
    secret,
    agent_name,
    heartbeat: env.millis("JAKE_HEARTBEAT_MS", DEFAULT_HEARTBEAT_MS)?,
    tick: env.millis("JAKE_TICK_MS", DEFAULT_TICK_MS)?,
    watchdog_stale: env.millis("JAKE_WATCHDOG_STALE_MS", DEFAULT_WATCHDOG_STALE_MS)?,
    max_payload_bytes: usize::try_from(env.positive("JAKE_MAX_PAYLOAD_BYTES", DEFAULT_MAX_PAYLOAD_BYTES)?)
      .map_err(|_| "JAKE_MAX_PAYLOAD_BYTES is too large.".to_owned())?,
    exec_max_output_bytes: env.positive("JAKE_EXEC_MAX_OUTPUT_BYTES", DEFAULT_EXEC_MAX_OUTPUT_BYTES)?,
    exec_timeout: env.millis("JAKE_EXEC_TIMEOUT_MS", DEFAULT_EXEC_TIMEOUT_MS)?,
    redial_base: env.millis("JAKE_REDIAL_BASE_MS", DEFAULT_REDIAL_BASE_MS)?,
    redial_cap: env.millis("JAKE_REDIAL_CAP_MS", DEFAULT_REDIAL_CAP_MS)?,
    stream_ports: env.ports("JAKE_STREAM_PORTS", DEFAULT_STREAM_PORTS)?,
    listen_ports: env.ports("JAKE_LISTEN_PORTS", NO_STREAM_PORTS)?,
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
    pairs.iter().map(|(key, value)| ((*key).to_owned(), (*value).to_owned())).collect()
  }

  const REQUIRED: [(&str, &str); 3] =
    [("JAKE_HUB_URL", "ws://hub"), ("JAKE_SECRET", "s"), ("JAKE_AGENT_NAME", "box")];

  #[test]
  fn reads_the_required_keys_and_applies_the_defaults() {
    let config = read(&env(&REQUIRED)).unwrap();
    assert_eq!(config.agent_name, "box");
    assert_eq!(config.heartbeat, Duration::from_secs(15));
    assert_eq!(config.watchdog_stale, Duration::from_secs(180));
    assert_eq!(config.exec_max_output_bytes, 8 * 1024 * 1024);
    assert_eq!(config.redial_cap, Duration::from_secs(60));
    assert_eq!(config.stream_ports, [22]);
  }

  #[test]
  fn a_configuration_held_in_memory_is_the_one_the_three_required_keys_alone_give() {
    let read = read(&env(&REQUIRED)).unwrap();
    let held = AgentConfig::new("ws://hub".into(), "s".into(), "box".into());
    assert_eq!(format!("{held:?}"), format!("{read:?}"));
  }

  #[test]
  fn reads_the_stream_ports_as_a_list_or_none() {
    let with = |ports: &str| {
      let mut pairs = env(&REQUIRED);
      pairs.insert("JAKE_STREAM_PORTS".into(), ports.into());
      read(&pairs)
    };
    assert_eq!(with(" 22, 2222,22 ").unwrap().stream_ports, [22, 2222]);
    assert_eq!(with("none").unwrap().stream_ports, Vec::<u16>::new());
    for bad in ["22,", "ssh", "0", "70000"] {
      assert_eq!(
        with(bad).unwrap_err(),
        "JAKE_STREAM_PORTS must be a comma-separated list of port numbers, or none."
      );
    }
  }

  #[test]
  fn names_the_key_that_is_missing_or_malformed() {
    assert!(read(&env(&REQUIRED[..2])).unwrap_err().starts_with("JAKE_AGENT_NAME is not set"));
    let mut bad = env(&REQUIRED);
    bad.insert("JAKE_TICK_MS".into(), "soon".into());
    assert_eq!(read(&bad).unwrap_err(), "JAKE_TICK_MS must be an integer.");
    bad.insert("JAKE_TICK_MS".into(), "0".into());
    assert_eq!(read(&bad).unwrap_err(), "JAKE_TICK_MS must be a positive integer.");
  }

  #[test]
  fn the_file_beside_the_executable_sits_under_the_process_environment() {
    let dir = std::env::temp_dir().join(format!("jake-config-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("agent.env"), "# comment\nJAKE_AGENT_NAME='from file'\nJAKE_SECRET=file\n")
      .unwrap();
    let merged = merged(&dir, env(&[("JAKE_SECRET", "process")])).unwrap();
    std::fs::remove_dir_all(&dir).unwrap();
    assert_eq!(merged["JAKE_AGENT_NAME"], "from file");
    assert_eq!(merged["JAKE_SECRET"], "process");
  }

  #[test]
  fn a_byte_order_mark_before_the_file_is_skipped() {
    let dir = std::env::temp_dir().join(format!("jake-config-bom-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("agent.env"), "\u{FEFF}JAKE_HUB_URL=wss://hub\r\nJAKE_SECRET=file\r\n")
      .unwrap();
    let merged = merged(&dir, HashMap::new());
    std::fs::remove_dir_all(&dir).unwrap();
    let merged = merged.unwrap();
    assert_eq!(merged["JAKE_HUB_URL"], "wss://hub");
    assert_eq!(merged["JAKE_SECRET"], "file");
  }
}
