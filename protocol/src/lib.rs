// The tunnel's frames as docs/protocol.md states them: the decoder with its named rejections, and the encoder.

use base64::Engine as _;
use base64::alphabet;
use base64::engine::{GeneralPurpose, GeneralPurposeConfig};
use serde_json::{Map, Number, Value, json};
use sha2::{Digest as _, Sha256};

mod stream;

pub use stream::{ReceiveWindow, STREAM_ACK_BYTES, STREAM_CHUNK_BYTES, STREAM_WINDOW_BYTES, SendWindow};

/// The version every frame carries; a frame at another version is refused, not guessed at.
pub const PROTOCOL_VERSION: i64 = 1;

/// The decoded size of one file-transfer chunk, held far below either side's payload cap.
pub const TRANSFER_CHUNK_BYTES: usize = 256 * 1024;

/// A transfer's content checksum, taken piece by piece: the sha256 of the bytes, in lowercase hex.
#[derive(Clone, Default)]
pub struct Checksum(Sha256);

impl Checksum {
  pub fn update(&mut self, data: &[u8]) {
    self.0.update(data);
  }

  pub fn finish(self) -> String {
    self.0.finalize().iter().map(|byte| format!("{byte:02x}")).collect()
  }
}

/// The checksum of content held whole.
pub fn checksum(data: &[u8]) -> String {
  let mut sum = Checksum::default();
  sum.update(data);
  sum.finish()
}

const SHELL_KINDS: [&str; 3] = ["powershell", "wsl", "linux"];

// Standard base64, but as forgiving of non-zero trailing bits as the agent's own decoder is.
const BASE64: GeneralPurpose = GeneralPurpose::new(
  &alphabet::STANDARD,
  GeneralPurposeConfig::new().with_decode_allow_trailing_bits(true),
);

/// Whether a value names a shell this build knows.
pub fn is_shell_kind(value: &str) -> bool {
  SHELL_KINDS.contains(&value)
}

/// The shells this build knows, as a message lists them.
pub fn shell_kinds() -> String {
  SHELL_KINDS.join(", ")
}

/// Which way a transfer's bytes flow: an upload writes a file on the machine, a download reads one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Direction {
  Upload,
  Download,
}

impl Direction {
  fn parse(value: &Value) -> Option<Self> {
    match value.as_str()? {
      "upload" => Some(Self::Upload),
      "download" => Some(Self::Download),
      _ => None,
    }
  }

  fn name(self) -> &'static str {
    match self {
      Self::Upload => "upload",
      Self::Download => "download",
    }
  }
}

/// A run of bytes inside a text frame: its declared decoded length and its base64.
#[derive(Clone, Debug, PartialEq)]
pub struct EncodedBytes {
  pub bytes: u64,
  pub base64: String,
}

impl EncodedBytes {
  pub fn of(data: &[u8]) -> Self {
    Self {
      bytes: data.len() as u64,
      base64: BASE64.encode(data),
    }
  }

  pub fn to_json(&self) -> Value {
    json!({ "bytes": self.bytes, "base64": self.base64 })
  }
}

/// Why a string or a byte payload was refused, by a code a caller can tell apart and a message.
#[derive(Clone, Debug, PartialEq)]
pub struct FrameError {
  pub code: &'static str,
  pub message: String,
}

fn fail<T>(code: &'static str, message: impl Into<String>) -> Result<T, FrameError> {
  Err(FrameError {
    code,
    message: message.into(),
  })
}

fn bad<T>(message: impl Into<String>) -> Result<T, FrameError> {
  fail("bad-field", message)
}

/// One validated frame, carrying only the fields its kind defines.
#[derive(Clone, Debug, PartialEq)]
pub enum Frame {
  Hello {
    agent: String,
    agent_version: String,
    capabilities: Vec<String>,
  },
  Welcome {
    hub_version: String,
  },
  Reject {
    reason: String,
  },
  Exec {
    id: String,
    shell: String,
    command: String,
    cwd: Option<String>,
    env: Map<String, Value>,
    distro: Option<String>,
  },
  Stdout {
    id: String,
    seq: u64,
    chunk: EncodedBytes,
  },
  Stderr {
    id: String,
    seq: u64,
    chunk: EncodedBytes,
  },
  Exit {
    id: String,
    code: Option<i64>,
    signal: Option<String>,
    canceled: bool,
  },
  Cancel {
    id: String,
  },
  Leave,
  Error {
    id: String,
    code: String,
    message: String,
  },
  TransferBegin {
    id: String,
    direction: Direction,
    path: String,
    total: Option<u64>,
    checksum: Option<String>,
  },
  TransferChunk {
    id: String,
    seq: u64,
    chunk: EncodedBytes,
  },
  TransferEnd {
    id: String,
    total: u64,
    checksum: String,
  },
  StreamOpen {
    id: String,
    port: u16,
  },
  StreamOpened {
    id: String,
  },
  StreamData {
    id: String,
    seq: u64,
    chunk: EncodedBytes,
  },
  StreamAck {
    id: String,
    bytes: u64,
  },
  StreamClose {
    id: String,
    reason: String,
  },
  Ping {
    ts: Number,
  },
  Pong {
    ts: Number,
  },
}

impl Frame {
  /// The kind the frame's `type` field names.
  pub fn kind(&self) -> &'static str {
    match self {
      Self::Hello { .. } => "hello",
      Self::Welcome { .. } => "welcome",
      Self::Reject { .. } => "reject",
      Self::Exec { .. } => "exec",
      Self::Stdout { .. } => "stdout",
      Self::Stderr { .. } => "stderr",
      Self::Exit { .. } => "exit",
      Self::Cancel { .. } => "cancel",
      Self::Leave => "leave",
      Self::Error { .. } => "error",
      Self::TransferBegin { .. } => "transfer-begin",
      Self::TransferChunk { .. } => "transfer-chunk",
      Self::TransferEnd { .. } => "transfer-end",
      Self::StreamOpen { .. } => "stream-open",
      Self::StreamOpened { .. } => "stream-opened",
      Self::StreamData { .. } => "stream-data",
      Self::StreamAck { .. } => "stream-ack",
      Self::StreamClose { .. } => "stream-close",
      Self::Ping { .. } => "ping",
      Self::Pong { .. } => "pong",
    }
  }

  /// The frame as the wire carries it: a JSON object, `type` and `v` first.
  pub fn encode(&self) -> String {
    let mut object = Map::new();
    object.insert("type".into(), self.kind().into());
    object.insert("v".into(), PROTOCOL_VERSION.into());
    if let Value::Object(fields) = self.fields() {
      object.extend(fields);
    }
    Value::Object(object).to_string()
  }

  fn fields(&self) -> Value {
    match self {
      Self::Hello {
        agent,
        agent_version,
        capabilities,
      } => {
        json!({ "agent": agent, "agentVersion": agent_version, "capabilities": capabilities })
      }
      Self::Welcome { hub_version } => json!({ "hubVersion": hub_version }),
      Self::Reject { reason } => json!({ "reason": reason }),
      Self::Exec {
        id,
        shell,
        command,
        cwd,
        env,
        distro,
      } => {
        json!({ "id": id, "shell": shell, "command": command, "cwd": cwd, "env": env, "distro": distro })
      }
      Self::Stdout { id, seq, chunk }
      | Self::Stderr { id, seq, chunk }
      | Self::TransferChunk { id, seq, chunk }
      | Self::StreamData { id, seq, chunk } => {
        json!({ "id": id, "seq": seq, "chunk": chunk.to_json() })
      }
      Self::Exit {
        id,
        code,
        signal,
        canceled,
      } => json!({ "id": id, "code": code, "signal": signal, "canceled": canceled }),
      Self::Cancel { id } | Self::StreamOpened { id } => json!({ "id": id }),
      Self::Leave => json!({}),
      Self::Error { id, code, message } => json!({ "id": id, "code": code, "message": message }),
      Self::TransferBegin {
        id,
        direction,
        path,
        total,
        checksum,
      } => {
        json!({ "id": id, "direction": direction.name(), "path": path, "total": total, "checksum": checksum })
      }
      Self::TransferEnd {
        id,
        total,
        checksum,
      } => json!({ "id": id, "total": total, "checksum": checksum }),
      Self::StreamOpen { id, port } => json!({ "id": id, "port": port }),
      Self::StreamAck { id, bytes } => json!({ "id": id, "bytes": bytes }),
      Self::StreamClose { id, reason } => json!({ "id": id, "reason": reason }),
      Self::Ping { ts } | Self::Pong { ts } => json!({ "ts": ts }),
    }
  }

  /// The frame reduced to its shape for the traffic log: a payload's base64 is left out.
  pub fn summary(&self) -> Value {
    match self {
      Self::Exec {
        id, shell, command, ..
      } => json!({ "id": id, "shell": shell, "command": command }),
      Self::Stdout { id, seq, chunk }
      | Self::Stderr { id, seq, chunk }
      | Self::TransferChunk { id, seq, chunk }
      | Self::StreamData { id, seq, chunk } => {
        json!({ "id": id, "seq": seq, "bytes": chunk.bytes })
      }
      Self::TransferBegin {
        id,
        direction,
        path,
        total,
        ..
      } => {
        json!({ "id": id, "direction": direction.name(), "path": path, "total": total })
      }
      Self::TransferEnd { id, total, .. } => json!({ "id": id, "total": total }),
      _ => self.fields(),
    }
  }
}

// A JSON number that is a whole number, the way JavaScript's Number.isInteger reads one.
fn as_int(value: &Value) -> Option<i64> {
  let number = value.as_number()?;
  if let Some(int) = number.as_i64() {
    return Some(int);
  }
  let float = number.as_f64()?;
  (float.is_finite() && float.fract() == 0.0 && float.abs() < 9.0e15).then_some(float as i64)
}

fn as_count(value: &Value) -> Option<u64> {
  as_int(value).and_then(|int| u64::try_from(int).ok())
}

fn string_field(object: &Map<String, Value>, key: &str, message: &str) -> Result<String, FrameError> {
  match object.get(key) {
    Some(Value::String(text)) => Ok(text.clone()),
    _ => bad(message),
  }
}

// A field that must be present and be either null or a string.
fn nullable_string(
  object: &Map<String, Value>,
  key: &str,
  message: &str,
) -> Result<Option<String>, FrameError> {
  match object.get(key) {
    Some(Value::Null) => Ok(None),
    Some(Value::String(text)) => Ok(Some(text.clone())),
    _ => bad(message),
  }
}

fn seq_field(object: &Map<String, Value>, kind: &str) -> Result<u64, FrameError> {
  object
    .get("seq")
    .and_then(as_count)
    .map_or_else(|| bad(format!("{kind}.seq must be a non-negative integer")), Ok)
}

// The envelope check on an encoded-bytes field: enough to refuse an oversized or plainly broken
// payload without decoding it.
fn encoded_bytes(
  value: Option<&Value>,
  field: &str,
  max_payload_bytes: usize,
) -> Result<EncodedBytes, FrameError> {
  let Some(Value::Object(object)) = value else {
    return bad(format!("{field} must be an object"));
  };
  let Some(bytes) = object.get("bytes").and_then(as_count) else {
    return bad(format!("{field}.bytes must be a non-negative integer"));
  };
  if bytes > max_payload_bytes as u64 {
    return fail("payload-too-large", format!("{field}.bytes {bytes} exceeds cap {max_payload_bytes}"));
  }
  let Some(Value::String(base64)) = object.get("base64") else {
    return bad(format!("{field}.base64 must be a string"));
  };
  Ok(EncodedBytes {
    bytes,
    base64: base64.clone(),
  })
}

/// Turn a received string into a validated frame or a named rejection.
pub fn decode_frame(raw: &str, max_payload_bytes: usize) -> Result<Frame, FrameError> {
  let Ok(parsed) = serde_json::from_str::<Value>(raw) else {
    return fail("not-json", "payload is not valid JSON");
  };
  let Value::Object(object) = parsed else {
    return fail("not-object", "frame must be a JSON object");
  };
  let Some(Value::String(kind)) = object.get("type") else {
    return fail("missing-type", "frame is missing a string type");
  };
  let kind = kind.as_str();
  const KNOWN: [&str; 20] = [
    "hello",
    "welcome",
    "reject",
    "exec",
    "stdout",
    "stderr",
    "exit",
    "cancel",
    "leave",
    "error",
    "transfer-begin",
    "transfer-chunk",
    "transfer-end",
    "stream-open",
    "stream-opened",
    "stream-data",
    "stream-ack",
    "stream-close",
    "ping",
    "pong",
  ];
  if !KNOWN.contains(&kind) {
    return fail("unknown-type", format!("unknown frame type {kind}"));
  }
  let Some(version) = object.get("v").and_then(as_int) else {
    return bad("v must be an integer");
  };
  if version != PROTOCOL_VERSION {
    return fail("version-mismatch", format!("frame version {version} is not {PROTOCOL_VERSION}"));
  }

  let o = &object;
  match kind {
    "hello" => {
      let agent = string_field(o, "agent", "hello.agent must be a string")?;
      let agent_version = string_field(o, "agentVersion", "hello.agentVersion must be a string")?;
      let capabilities = match o.get("capabilities") {
        Some(Value::Array(items)) if items.iter().all(Value::is_string) => {
          items.iter().filter_map(|item| item.as_str().map(str::to_owned)).collect()
        }
        _ => return bad("hello.capabilities must be a string array"),
      };
      Ok(Frame::Hello {
        agent,
        agent_version,
        capabilities,
      })
    }
    "welcome" => Ok(Frame::Welcome {
      hub_version: string_field(o, "hubVersion", "welcome.hubVersion must be a string")?,
    }),
    "reject" => Ok(Frame::Reject {
      reason: string_field(o, "reason", "reject.reason must be a string")?,
    }),
    "exec" => {
      let id = string_field(o, "id", "exec.id must be a string")?;
      let shell = match o.get("shell") {
        Some(Value::String(shell)) if is_shell_kind(shell) => shell.clone(),
        _ => return bad(format!("exec.shell must be one of {}", shell_kinds())),
      };
      let command = string_field(o, "command", "exec.command must be a string")?;
      if command.len() > max_payload_bytes {
        return fail("payload-too-large", format!("exec.command exceeds cap {max_payload_bytes}"));
      }
      let cwd = nullable_string(o, "cwd", "exec.cwd must be a string or null")?;
      let env = match o.get("env") {
        Some(Value::Object(env)) if env.values().all(Value::is_string) => env.clone(),
        _ => return bad("exec.env must be a string map"),
      };
      let distro = nullable_string(o, "distro", "exec.distro must be a string or null")?;
      Ok(Frame::Exec {
        id,
        shell,
        command,
        cwd,
        env,
        distro,
      })
    }
    "stdout" | "stderr" => {
      let id = string_field(o, "id", &format!("{kind}.id must be a string"))?;
      let seq = seq_field(o, kind)?;
      let chunk = encoded_bytes(o.get("chunk"), &format!("{kind}.chunk"), max_payload_bytes)?;
      Ok(if kind == "stdout" {
        Frame::Stdout { id, seq, chunk }
      } else {
        Frame::Stderr { id, seq, chunk }
      })
    }
    "exit" => {
      let id = string_field(o, "id", "exit.id must be a string")?;
      let code = match o.get("code") {
        Some(Value::Null) => None,
        Some(value) if as_int(value).is_some() => as_int(value),
        _ => return bad("exit.code must be an integer or null"),
      };
      let signal = nullable_string(o, "signal", "exit.signal must be a string or null")?;
      let Some(Value::Bool(canceled)) = o.get("canceled") else {
        return bad("exit.canceled must be a boolean");
      };
      Ok(Frame::Exit {
        id,
        code,
        signal,
        canceled: *canceled,
      })
    }
    "cancel" => Ok(Frame::Cancel {
      id: string_field(o, "id", "cancel.id must be a string")?,
    }),
    "leave" => Ok(Frame::Leave),
    "error" => Ok(Frame::Error {
      id: string_field(o, "id", "error.id must be a string")?,
      code: string_field(o, "code", "error.code must be a string")?,
      message: string_field(o, "message", "error.message must be a string")?,
    }),
    "transfer-begin" => {
      let id = string_field(o, "id", "transfer-begin.id must be a string")?;
      let Some(direction) = o.get("direction").and_then(Direction::parse) else {
        return bad("transfer-begin.direction must be one of upload, download");
      };
      let path = string_field(o, "path", "transfer-begin.path must be a string")?;
      let total = match o.get("total") {
        Some(Value::Null) => None,
        Some(value) if as_count(value).is_some() => as_count(value),
        _ => return bad("transfer-begin.total must be a non-negative integer or null"),
      };
      let checksum = nullable_string(o, "checksum", "transfer-begin.checksum must be a string or null")?;
      Ok(Frame::TransferBegin {
        id,
        direction,
        path,
        total,
        checksum,
      })
    }
    "transfer-chunk" => {
      let id = string_field(o, "id", "transfer-chunk.id must be a string")?;
      let seq = seq_field(o, "transfer-chunk")?;
      let chunk = encoded_bytes(o.get("chunk"), "transfer-chunk.chunk", max_payload_bytes)?;
      Ok(Frame::TransferChunk { id, seq, chunk })
    }
    "transfer-end" => {
      let id = string_field(o, "id", "transfer-end.id must be a string")?;
      let Some(total) = o.get("total").and_then(as_count) else {
        return bad("transfer-end.total must be a non-negative integer");
      };
      let checksum = string_field(o, "checksum", "transfer-end.checksum must be a string")?;
      Ok(Frame::TransferEnd {
        id,
        total,
        checksum,
      })
    }
    "stream-open" => {
      let id = string_field(o, "id", "stream-open.id must be a string")?;
      let Some(port) = o.get("port").and_then(as_int).and_then(|port| u16::try_from(port).ok()) else {
        return bad("stream-open.port must be a port number");
      };
      Ok(Frame::StreamOpen { id, port })
    }
    "stream-opened" => Ok(Frame::StreamOpened {
      id: string_field(o, "id", "stream-opened.id must be a string")?,
    }),
    "stream-data" => {
      let id = string_field(o, "id", "stream-data.id must be a string")?;
      let seq = seq_field(o, "stream-data")?;
      let chunk = encoded_bytes(o.get("chunk"), "stream-data.chunk", max_payload_bytes)?;
      Ok(Frame::StreamData { id, seq, chunk })
    }
    "stream-ack" => {
      let id = string_field(o, "id", "stream-ack.id must be a string")?;
      let Some(bytes) = o.get("bytes").and_then(as_count) else {
        return bad("stream-ack.bytes must be a non-negative integer");
      };
      Ok(Frame::StreamAck { id, bytes })
    }
    "stream-close" => Ok(Frame::StreamClose {
      id: string_field(o, "id", "stream-close.id must be a string")?,
      reason: string_field(o, "reason", "stream-close.reason must be a string")?,
    }),
    _ => {
      // ping and pong: the probe's clock, any finite number, echoed as it came.
      let Some(Value::Number(ts)) = o.get("ts") else {
        return bad(format!("{kind}.ts must be a number"));
      };
      let ts = ts.clone();
      Ok(if kind == "ping" { Frame::Ping { ts } } else { Frame::Pong { ts } })
    }
  }
}

/// Decode an encoded-bytes value to its bytes, re-checking the cap and the declared length.
pub fn decode_bytes(encoded: &EncodedBytes, max_payload_bytes: usize) -> Result<Vec<u8>, FrameError> {
  if encoded.bytes > max_payload_bytes as u64 {
    return fail("payload-too-large", format!("bytes {} exceeds cap {max_payload_bytes}", encoded.bytes));
  }
  let text = encoded.base64.as_bytes();
  let body_end = text.iter().rposition(|&c| c != b'=').map_or(0, |at| at + 1);
  let well_formed = text.len().is_multiple_of(4)
    && text.len() - body_end <= 2
    && text[..body_end].iter().all(|&c| c.is_ascii_alphanumeric() || c == b'+' || c == b'/');
  let Some(data) = well_formed.then(|| BASE64.decode(text).ok()).flatten() else {
    return bad("base64 is not valid standard base64");
  };
  if data.len() as u64 != encoded.bytes {
    return bad(format!("decoded length {} does not match declared {}", data.len(), encoded.bytes));
  }
  Ok(data)
}

#[cfg(test)]
mod tests {
  use super::*;

  const CAP: usize = 1024;

  fn code_of(raw: &str) -> &'static str {
    decode_frame(raw, CAP).expect_err("refused").code
  }

  #[test]
  fn each_rejection_is_named() {
    assert_eq!(code_of("{"), "not-json");
    assert_eq!(code_of("[1]"), "not-object");
    assert_eq!(code_of(r#"{"v":1}"#), "missing-type");
    assert_eq!(code_of(r#"{"type":"call","v":1}"#), "unknown-type");
    assert_eq!(code_of(r#"{"type":"ping","v":2,"ts":1}"#), "version-mismatch");
    assert_eq!(code_of(r#"{"type":"exit","v":1,"id":"c1","code":null,"signal":null}"#), "bad-field");
    let big = r#"{"type":"stdout","v":1,"id":"c1","seq":0,"chunk":{"bytes":2048,"base64":""}}"#;
    assert_eq!(code_of(big), "payload-too-large");
  }

  #[test]
  fn extra_fields_are_dropped_and_a_whole_float_counts_as_an_integer() {
    let frame = decode_frame(r#"{"type":"cancel","v":1.0,"id":"c1","extra":true}"#, CAP).expect("valid");
    assert_eq!(frame.encode(), r#"{"type":"cancel","v":1,"id":"c1"}"#);
  }

  #[test]
  fn a_ping_clock_is_echoed_as_it_came() {
    let frame = decode_frame(r#"{"type":"ping","v":1,"ts":1759730000123}"#, CAP).expect("valid");
    let Frame::Ping { ts } = frame else { panic!("not a ping") };
    assert_eq!(Frame::Pong { ts }.encode(), r#"{"type":"pong","v":1,"ts":1759730000123}"#);
  }

  #[test]
  fn bytes_round_trip_and_a_wrong_length_is_refused() {
    let encoded = EncodedBytes::of(b"hello");
    assert_eq!(decode_bytes(&encoded, CAP).expect("decodes"), b"hello");
    let lying = EncodedBytes {
      bytes: 4,
      base64: encoded.base64.clone(),
    };
    assert_eq!(decode_bytes(&lying, CAP).expect_err("refused").code, "bad-field");
    let broken = EncodedBytes {
      bytes: 1,
      base64: "a=b=".into(),
    };
    assert_eq!(decode_bytes(&broken, CAP).expect_err("refused").code, "bad-field");
  }
}
