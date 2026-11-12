// The exec verb: one command on an agent's machine, its output streamed back, its exit code returned.

use futures_util::StreamExt as _;
use http_body_util::BodyExt as _;
use hyper::Method;
use hyper::header::CONTENT_TYPE;
use serde_json::{Map, Value, json};
use sse_stream::SseStream;
use tokio::io::{AsyncWrite, AsyncWriteExt as _};
use tokio::signal::unix::{SignalKind, signal};

use crate::control_client::ControlClient;
use crate::protocol::{EncodedBytes, decode_bytes, is_shell_kind, shell_kinds};

/// The exit codes of the console's own failures, the same the bun console gives.
const EXIT_USAGE: i32 = 2;
const EXIT_NO_AGENT: i32 = 3;
const EXIT_FAILED: i32 = 4;
/// The exit code of a command the caller cancelled, as a shell gives one ended by Ctrl-C.
const EXIT_CANCELED: i32 = 130;

#[derive(clap::Args)]
pub struct ExecArgs {
  /// The agent to run on; may be left out while a single agent is attached
  #[arg(short, long)]
  agent: Option<String>,
  /// The shell to run the command in
  #[arg(short, long, default_value = "powershell", value_parser = shell_kind)]
  shell: String,
  /// The directory to run in
  #[arg(long)]
  cwd: Option<String>,
  /// The WSL distribution to run in
  #[arg(long)]
  distro: Option<String>,
  /// An environment variable for the command, KEY=VAL; repeatable
  #[arg(long = "env", value_parser = env_pair)]
  env: Vec<(String, String)>,
  /// The command, its words joined by spaces
  #[arg(required = true, trailing_var_arg = true, allow_hyphen_values = true)]
  command: Vec<String>,
}

fn shell_kind(raw: &str) -> Result<String, String> {
  if is_shell_kind(raw) {
    Ok(raw.to_owned())
  } else {
    Err(format!("must be one of {}", shell_kinds()))
  }
}

fn env_pair(raw: &str) -> Result<(String, String), String> {
  raw
    .split_once('=')
    .map(|(key, value)| (key.to_owned(), value.to_owned()))
    .ok_or_else(|| format!("expects KEY=VAL (got {raw})"))
}

/// How the command's stream ended.
enum Outcome {
  Exit {
    code: Option<i64>,
    signal: Option<String>,
    canceled: bool,
  },
  Error {
    code: String,
    message: String,
  },
  Ended(String),
}

/// A failure of the verb itself: the exit code it gives and what it says.
type Failure = (i32, String);

/// Run the command the arguments name; the exit code the process ends with.
pub async fn run(args: ExecArgs) -> i32 {
  match exec(args).await {
    Ok(code) => code,
    Err((code, message)) => {
      eprintln!("jake-hub exec: {message}");
      code
    }
  }
}

async fn exec(args: ExecArgs) -> Result<i32, Failure> {
  let client = ControlClient::load().map_err(|message| (EXIT_USAGE, message))?;
  let env: Map<String, Value> = args.env.into_iter().map(|(key, value)| (key, value.into())).collect();
  let body = json!({
    "shell": args.shell,
    "command": args.command.join(" "),
    "cwd": args.cwd,
    "env": env,
    "distro": args.distro,
  });
  let target = match &args.agent {
    Some(agent) => format!(
      "/exec?{}",
      form_urlencoded::Serializer::new(String::new()).append_pair("agent", agent).finish()
    ),
    None => "/exec".to_owned(),
  };
  // Ctrl-C is taken over before the request, so one that comes before the command has an id still ends
  // the run rather than the process.
  let mut interrupt = signal(SignalKind::interrupt()).map_err(|error| (EXIT_FAILED, error.to_string()))?;
  let response = client
    .request(Method::POST, &target, Some(&body))
    .await
    .map_err(|message| (EXIT_FAILED, format!("could not reach the hub: {message}")))?;
  let streams = response
    .headers()
    .get(CONTENT_TYPE)
    .and_then(|value| value.to_str().ok())
    .is_some_and(|value| value.starts_with("text/event-stream"));
  if !streams {
    return Err(refused(response).await);
  }

  let mut events = SseStream::new(response.into_body());
  let (mut stdout, mut stderr) = (tokio::io::stdout(), tokio::io::stderr());
  let mut command_id: Option<String> = None;
  let mut outcome = None;
  loop {
    let event = tokio::select! {
      event = events.next() => event,
      _ = interrupt.recv() => {
        let Some(id) = &command_id else { return Ok(EXIT_CANCELED) };
        // The exit arrives on the stream once the agent has stopped the command.
        let _ = client.request(Method::POST, "/cancel", Some(&json!({ "id": id }))).await;
        continue;
      }
    };
    let Some(event) = event else { break };
    let event = event.map_err(|error| (EXIT_FAILED, format!("connection ended: {error}")))?;
    let data: Value = event
      .data
      .as_deref()
      .and_then(|data| serde_json::from_str(data).ok())
      .unwrap_or(Value::Null);
    match event.event.as_deref() {
      Some("started") => command_id = data["id"].as_str().map(str::to_owned),
      Some("stdout") => write_chunk(&mut stdout, &data).await?,
      Some("stderr") => write_chunk(&mut stderr, &data).await?,
      Some("exit") => {
        outcome = Some(Outcome::Exit {
          code: data["code"].as_i64(),
          signal: data["signal"].as_str().map(str::to_owned),
          canceled: data["canceled"] == true,
        });
      }
      Some("error") => {
        outcome = Some(Outcome::Error {
          code: data["code"].as_str().unwrap_or("error").to_owned(),
          message: data["message"].as_str().unwrap_or_default().to_owned(),
        });
      }
      // A natural exit already recorded an outcome; `ended` only speaks when it is the last word.
      Some("ended") if outcome.is_none() => {
        outcome = Some(Outcome::Ended(data["reason"].as_str().unwrap_or("stream ended").to_owned()));
      }
      _ => {}
    }
  }

  match outcome.unwrap_or_else(|| Outcome::Ended("the stream closed without an exit".into())) {
    Outcome::Exit { canceled: true, .. } => Ok(EXIT_CANCELED),
    Outcome::Exit {
      code: Some(code), ..
    } => Ok(code.rem_euclid(256) as i32),
    Outcome::Exit {
      code: None, signal, ..
    } => {
      let signal = signal.map(|signal| format!(" ({signal})")).unwrap_or_default();
      Err((1, format!("the command was killed{signal}")))
    }
    Outcome::Error { code, message } => {
      Err((EXIT_FAILED, format!("the command failed [{code}]: {message}")))
    }
    Outcome::Ended(reason) => Err((EXIT_FAILED, format!("connection ended: {reason}"))),
  }
}

// One chunk of the command's output, written through as its raw bytes.
async fn write_chunk(out: &mut (impl AsyncWrite + Unpin), data: &Value) -> Result<(), Failure> {
  let chunk = &data["chunk"];
  let encoded = EncodedBytes {
    bytes: chunk["bytes"].as_u64().unwrap_or_default(),
    base64: chunk["base64"].as_str().unwrap_or_default().to_owned(),
  };
  let bytes = decode_bytes(&encoded, usize::MAX).map_err(|error| (EXIT_FAILED, error.message))?;
  // A reader that has gone away, as `head` does, is not the command's failure.
  let _ = out.write_all(&bytes).await;
  let _ = out.flush().await;
  Ok(())
}

// What the hub said when it declined the command before streaming anything, and the exit code for
// it: no agent, or none by that name, is "no agent"; a name missing among several is a usage error.
async fn refused(response: hyper::Response<hyper::body::Incoming>) -> Failure {
  let status = response.status().as_u16();
  let body = response.into_body().collect().await.map(|body| body.to_bytes()).unwrap_or_default();
  let message = serde_json::from_slice::<Value>(&body)
    .ok()
    .and_then(|body| body["error"].as_str().map(str::to_owned))
    .unwrap_or_else(|| format!("the hub refused the command ({status})"));
  let code = match status {
    404 | 409 => EXIT_NO_AGENT,
    400 => EXIT_USAGE,
    _ => EXIT_FAILED,
  };
  (code, message)
}
