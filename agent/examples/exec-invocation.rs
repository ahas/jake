// Prints the launch the agent makes of one exec frame on a given platform, without running it.

use std::io::Read as _;

use jake_agent::platform::Platform;
use jake_agent::{ExecRequest, invocation};
use jake_protocol::decode_frame;

/// Far above any command a test hands it; the frame is read whole from standard input.
const MAX_PAYLOAD_BYTES: usize = 16 * 1024 * 1024;

fn main() {
  let platform = match std::env::args().nth(1).as_deref() {
    Some("windows") => Platform::Windows,
    Some("linux") => Platform::Linux,
    _ => fail("usage: exec-invocation windows|linux < exec-frame.json"),
  };
  let mut raw = String::new();
  if let Err(error) = std::io::stdin().read_to_string(&mut raw) {
    fail(&format!("standard input: {error}"));
  }
  let frame =
    decode_frame(raw.trim(), MAX_PAYLOAD_BYTES).unwrap_or_else(|error| fail(&format!("{error:?}")));
  let request = ExecRequest::from_frame(frame).unwrap_or_else(|| fail("not an exec frame"));
  let launch = invocation(platform, &request);
  let printed = serde_json::json!({
    "file": launch.file,
    "args": launch.args,
    "cwd": launch.cwd,
    "env": launch.env,
  });
  println!("{printed}");
}

fn fail(message: &str) -> ! {
  eprintln!("{message}");
  std::process::exit(2)
}
