// Running a command through one of the host's shells and streaming its output back as it arrives.

use std::process::{ExitStatus, Stdio};
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use jake_protocol::{EncodedBytes, Frame};
use tokio::io::{AsyncRead, AsyncReadExt as _};
use tokio::process::Command;
use tokio::sync::{mpsc, oneshot};
use tokio::time::{Instant, sleep, sleep_until};

use crate::log::Log;
use crate::platform::Platform;

/// How long a Linux process group is given to leave on the polite signal before it is forced.
#[cfg(unix)]
const TERM_GRACE: Duration = Duration::from_secs(2);

/// How much of a pipe is read at once; a chunk is forwarded as soon as it is read.
const READ_BYTES: usize = 64 * 1024;

// Forces PowerShell's console output to UTF-8, so a non-ASCII character does not cross the tunnel in
// the machine's OEM code page.
const POWERSHELL_UTF8_PRELUDE: &str = "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8";

/// A command to run, as the exec frame carried it.
#[derive(Clone, Debug)]
pub struct ExecRequest {
  pub id: String,
  pub shell: String,
  pub command: String,
  pub cwd: Option<String>,
  pub env: Vec<(String, String)>,
  pub distro: Option<String>,
}

/// A ready-to-spawn command: the overlay is laid over the agent's own environment, never in place of it.
#[derive(Clone, Debug, PartialEq)]
pub struct Invocation {
  pub file: String,
  pub args: Vec<String>,
  pub cwd: Option<String>,
  pub env: Vec<(String, String)>,
}

/// A PowerShell script as `-EncodedCommand` takes it: base64 of its UTF-16LE bytes, so nothing needs quoting.
pub fn encode_powershell_script(script: &str) -> String {
  let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
  STANDARD.encode(bytes)
}

/// PowerShell run unattended: no profile, no prompt, the policy bypassed and the output in UTF-8.
pub fn powershell_invocation(request: &ExecRequest) -> Invocation {
  let script = format!("{POWERSHELL_UTF8_PRELUDE}\n{}", request.command);
  Invocation {
    file: "powershell.exe".into(),
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-OutputFormat",
      "Text",
      "-EncodedCommand",
    ]
    .into_iter()
    .map(str::to_owned)
    .chain([encode_powershell_script(&script)])
    .collect(),
    cwd: request.cwd.clone(),
    env: request.env.clone(),
  }
}

/// WSL entered through its launcher, the command in a login shell; the overlay crosses by `WSLENV`.
pub fn wsl_invocation(request: &ExecRequest) -> Invocation {
  let mut args = Vec::new();
  if let Some(distro) = request.distro.as_deref().filter(|distro| !distro.is_empty()) {
    args.extend(["--distribution".to_owned(), distro.to_owned()]);
  }
  if let Some(cwd) = request.cwd.as_deref().filter(|cwd| !cwd.is_empty()) {
    args.extend(["--cd".to_owned(), cwd.to_owned()]);
  }
  args.extend(["--", "bash", "-lc"].map(str::to_owned));
  args.push(request.command.clone());

  let mut env = request.env.clone();
  let shared: Vec<String> = request
    .env
    .iter()
    .filter(|(key, _)| key != "WSLENV")
    .map(|(key, _)| format!("{key}/u"))
    .collect();
  if !shared.is_empty() {
    let declared = shared.join(":");
    let given = request.env.iter().find(|(key, _)| key == "WSLENV").map(|(_, value)| value.as_str());
    env.retain(|(key, _)| key != "WSLENV");
    env.push((
      "WSLENV".into(),
      match given.filter(|value| !value.is_empty()) {
        Some(value) => format!("{declared}:{value}"),
        None => declared,
      },
    ));
  }
  Invocation {
    file: "wsl.exe".into(),
    args,
    cwd: None,
    env,
  }
}

/// The host's own shell: the command in a login shell, so its environment matches an interactive prompt.
pub fn linux_invocation(request: &ExecRequest) -> Invocation {
  Invocation {
    file: "bash".into(),
    args: vec!["-lc".into(), request.command.clone()],
    cwd: request.cwd.clone(),
    env: request.env.clone(),
  }
}

/// The invocation for the shell a request names, on this platform. A name the host has no shell for
/// runs in the host's own: callers that name no shell send the console's default, PowerShell, to
/// Linux hosts too.
pub fn invocation(platform: Platform, request: &ExecRequest) -> Invocation {
  match (platform, request.shell.as_str()) {
    (Platform::Windows, "wsl") => wsl_invocation(request),
    (Platform::Windows, _) => powershell_invocation(request),
    (Platform::Linux, _) => linux_invocation(request),
  }
}

/// The Windows command that ends a whole process tree by its root's id.
pub fn tree_kill_command(pid: u32) -> Vec<String> {
  ["taskkill", "/PID", &pid.to_string(), "/T", "/F"].map(str::to_owned).to_vec()
}

/// The two ceilings that keep a runaway command from flooding the hub.
#[derive(Clone, Copy, Debug)]
pub struct Limits {
  pub max_output_bytes: u64,
  pub timeout: Duration,
}

/// A run in flight, as the connection holds it.
pub struct RunHandle {
  cancel: oneshot::Sender<()>,
  pid: Option<u32>,
}

impl RunHandle {
  /// Stop the run, ending its whole process tree; the run still reports its end, as a cancel.
  pub fn cancel(self) {
    let _ = self.cancel.send(());
  }

  /// Whether the run has already ended on its own.
  pub fn finished(&self) -> bool {
    self.cancel.is_closed()
  }

  /// End the run's tree at once, for a connection that is gone or an agent that is stopping.
  pub fn end_now(self) {
    if self.finished() {
      return;
    }
    if let Some(pid) = self.pid {
      kill_tree(pid);
    }
    self.cancel();
  }
}

/// Start a command, its output streamed by a task of its own through `out` for as long as the
/// connection holds; a command that cannot start is answered with the reason.
pub fn start(
  request: ExecRequest,
  limits: Limits,
  out: mpsc::Sender<Frame>,
  log: Log,
) -> Result<RunHandle, String> {
  let invocation = invocation(Platform::HOST, &request);
  let child = spawn(&invocation).map_err(|error| format!("{}: {error}", invocation.file))?;
  let pid = child.id();
  let (cancel, canceled) = oneshot::channel();
  tokio::spawn(run(request.id, child, limits, out, canceled, log));
  Ok(RunHandle { cancel, pid })
}

// The first, polite step of ending a tree: the group's terminate signal on Linux, which the run's own
// task follows with a kill if the group outstays its grace, and the forced tree kill on Windows.
fn kill_tree(pid: u32) {
  #[cfg(unix)]
  signal_group(pid, libc::SIGTERM);
  #[cfg(windows)]
  if let Some(mut command) = crate::command::quiet(&tree_kill_command(pid)) {
    let _ = command.spawn();
  }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum EndReason {
  Cancel,
  Cap,
  Timeout,
}

struct Run {
  id: String,
  out: mpsc::Sender<Frame>,
  pid: Option<u32>,
  limits: Limits,
  seq: u64,
  produced: u64,
  end: Option<EndReason>,
  force_at: Option<Instant>,
  log: Log,
}

#[derive(Clone, Copy)]
enum Stream {
  Stdout,
  Stderr,
}

impl Run {
  async fn emit(&mut self, stream: Stream, bytes: &[u8]) {
    let (id, seq, chunk) = (self.id.clone(), self.seq, EncodedBytes::of(bytes));
    self.seq += 1;
    let frame = match stream {
      Stream::Stdout => Frame::Stdout { id, seq, chunk },
      Stream::Stderr => Frame::Stderr { id, seq, chunk },
    };
    let _ = self.out.send(frame).await;
  }

  // Once jake has decided to stop the run, output is dropped so the cap stays a real bound.
  async fn forward(&mut self, stream: Stream, bytes: &[u8]) {
    if self.end.is_some() {
      return;
    }
    let remaining = self.limits.max_output_bytes - self.produced;
    let take = bytes.len().min(usize::try_from(remaining).unwrap_or(usize::MAX));
    if take > 0 {
      self.produced += take as u64;
      self.emit(stream, &bytes[..take]).await;
    }
    if self.produced >= self.limits.max_output_bytes {
      self.terminate(EndReason::Cap);
    }
  }

  // The first reason wins; a later cause of death does not change what the caller is told.
  fn terminate(&mut self, reason: EndReason) {
    if self.end.is_some() {
      return;
    }
    self.end = Some(reason);
    let reason = match reason {
      EndReason::Cancel => "cancel",
      EndReason::Cap => "output cap",
      EndReason::Timeout => "time limit",
    };
    self.log.info("exec-stopping", serde_json::json!({ "id": self.id, "reason": reason }));
    let Some(pid) = self.pid else { return };
    kill_tree(pid);
    #[cfg(unix)]
    {
      self.force_at = Some(Instant::now() + TERM_GRACE);
    }
  }

  fn force(&mut self) {
    self.force_at = None;
    #[cfg(unix)]
    if let Some(pid) = self.pid {
      signal_group(pid, libc::SIGKILL);
    }
  }

  async fn finish(&mut self, status: Option<ExitStatus>) {
    let line = match self.end {
      Some(EndReason::Cap) => Some(format!(
        "\n[jake] output cap of {} bytes reached; command terminated\n",
        self.limits.max_output_bytes
      )),
      Some(EndReason::Timeout) => Some(format!(
        "\n[jake] time limit of {} ms reached; command terminated\n",
        self.limits.timeout.as_millis()
      )),
      _ => None,
    };
    if let Some(line) = line {
      self.emit(Stream::Stderr, line.as_bytes()).await;
    }
    let (code, signal) = status.map_or((None, None), exit_parts);
    let frame = Frame::Exit {
      id: self.id.clone(),
      code,
      signal,
      canceled: self.end == Some(EndReason::Cancel),
    };
    let _ = self.out.send(frame).await;
  }
}

#[cfg(unix)]
fn signal_group(pid: u32, signal: libc::c_int) {
  if let Ok(pid) = libc::pid_t::try_from(pid) {
    // SAFETY: kill only sends a signal; a group already gone answers ESRCH, which changes nothing.
    unsafe {
      libc::kill(-pid, signal);
    }
  }
}

fn spawn(invocation: &Invocation) -> std::io::Result<tokio::process::Child> {
  let mut command = Command::new(&invocation.file);
  command
    .args(&invocation.args)
    .envs(invocation.env.iter().map(|(key, value)| (key, value)))
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
  // An empty directory names none, and the run starts where the agent runs.
  if let Some(cwd) = invocation.cwd.as_deref().filter(|cwd| !cwd.is_empty()) {
    command.current_dir(cwd);
  }
  // A group of its own, so stopping the run reaches everything the shell started.
  #[cfg(unix)]
  command.process_group(0);
  #[cfg(windows)]
  command.creation_flags(crate::command::CREATE_NO_WINDOW);
  command.spawn()
}

async fn read_some(pipe: &mut Option<impl AsyncRead + Unpin>, buffer: &mut [u8]) -> usize {
  match pipe {
    Some(pipe) => pipe.read(buffer).await.unwrap_or(0),
    None => std::future::pending().await,
  }
}

async fn run(
  id: String,
  mut child: tokio::process::Child,
  limits: Limits,
  out: mpsc::Sender<Frame>,
  mut canceled: oneshot::Receiver<()>,
  log: Log,
) {
  let mut stdout = child.stdout.take();
  let mut stderr = child.stderr.take();
  let mut run = Run {
    id,
    out,
    pid: child.id(),
    limits,
    seq: 0,
    produced: 0,
    end: None,
    force_at: None,
    log,
  };
  let deadline = sleep(limits.timeout);
  tokio::pin!(deadline);
  let (mut out_buffer, mut err_buffer) = (vec![0; READ_BYTES], vec![0; READ_BYTES]);
  let mut listening = true;
  let mut status = None;
  let mut exited = false;

  // The run ends once both pipes have closed and the process has exited; killing the tree closes the
  // pipes, so a cancel, the cap and the time limit all arrive here the same way.
  while stdout.is_some() || stderr.is_some() || !exited {
    tokio::select! {
      read = read_some(&mut stdout, &mut out_buffer) => match read {
        0 => stdout = None,
        n => run.forward(Stream::Stdout, &out_buffer[..n]).await,
      },
      read = read_some(&mut stderr, &mut err_buffer) => match read {
        0 => stderr = None,
        n => run.forward(Stream::Stderr, &err_buffer[..n]).await,
      },
      ended = child.wait(), if !exited => {
        exited = true;
        status = ended.ok();
      }
      // A cancel from the hub, or the connection dropping the handle: either way the run stops.
      _ = &mut canceled, if listening => {
        listening = false;
        run.terminate(EndReason::Cancel);
      }
      () = &mut deadline, if run.end.is_none() => run.terminate(EndReason::Timeout),
      () = sleep_until(run.force_at.unwrap_or_else(Instant::now)), if run.force_at.is_some() => run.force(),
    }
  }
  run.finish(status).await;
}

#[cfg(unix)]
fn exit_parts(status: ExitStatus) -> (Option<i64>, Option<String>) {
  use std::os::unix::process::ExitStatusExt as _;
  (status.code().map(i64::from), status.signal().map(signal_name))
}

#[cfg(windows)]
fn exit_parts(status: ExitStatus) -> (Option<i64>, Option<String>) {
  (status.code().map(i64::from), None)
}

/// A signal's conventional name, as a caller reads it in an exit frame.
#[cfg(unix)]
fn signal_name(signal: i32) -> String {
  let name = match signal {
    libc::SIGHUP => "SIGHUP",
    libc::SIGINT => "SIGINT",
    libc::SIGQUIT => "SIGQUIT",
    libc::SIGABRT => "SIGABRT",
    libc::SIGKILL => "SIGKILL",
    libc::SIGSEGV => "SIGSEGV",
    libc::SIGPIPE => "SIGPIPE",
    libc::SIGALRM => "SIGALRM",
    libc::SIGTERM => "SIGTERM",
    other => return format!("SIG{other}"),
  };
  name.to_owned()
}

#[cfg(test)]
mod tests {
  use super::*;

  fn request(shell: &str, command: &str) -> ExecRequest {
    ExecRequest {
      id: "r".into(),
      shell: shell.into(),
      command: command.into(),
      cwd: None,
      env: Vec::new(),
      distro: None,
    }
  }

  fn decode_script(encoded: &str) -> String {
    let bytes = STANDARD.decode(encoded).unwrap();
    let units: Vec<u16> = bytes.chunks(2).map(|pair| u16::from_le_bytes([pair[0], pair[1]])).collect();
    String::from_utf16(&units).unwrap()
  }

  #[test]
  fn powershell_runs_unattended_with_the_command_encoded_after_the_utf8_prelude() {
    let mut asked = request("powershell", "Write-Output \"it's\"\n'two'; 3");
    asked.cwd = Some("C:\\work".into());
    asked.env = vec![("A".into(), "1".into())];
    let built = invocation(Platform::Windows, &asked);
    assert_eq!(built.file, "powershell.exe");
    assert_eq!(
      built.args[..7],
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-OutputFormat",
        "Text",
        "-EncodedCommand"
      ]
    );
    assert_eq!(decode_script(&built.args[7]), format!("{POWERSHELL_UTF8_PRELUDE}\n{}", asked.command));
    assert_eq!((built.cwd, built.env), (asked.cwd, asked.env));
  }

  #[test]
  fn wsl_enters_through_its_launcher_into_a_login_shell_and_shares_the_overlay() {
    let mut asked = request("wsl", "echo $A");
    let bare = invocation(Platform::Windows, &asked);
    assert_eq!((bare.file.as_str(), bare.args.join(" ")), ("wsl.exe", "-- bash -lc echo $A".to_owned()));
    assert!(bare.env.is_empty());

    asked.distro = Some("Ubuntu".into());
    asked.cwd = Some("/srv".into());
    asked.env = vec![("A".into(), "1".into()), ("WSLENV".into(), "PATH/l".into())];
    let built = invocation(Platform::Windows, &asked);
    assert_eq!(built.args[..4], ["--distribution", "Ubuntu", "--cd", "/srv"]);
    assert_eq!(built.cwd, None);
    assert_eq!(
      built.env,
      [("A".to_owned(), "1".to_owned()), ("WSLENV".to_owned(), "A/u:PATH/l".to_owned())]
    );
  }

  #[test]
  fn a_linux_host_runs_its_own_login_shell_with_the_directory_and_overlay_applied_directly() {
    let mut asked = request("linux", "make");
    asked.cwd = Some("/srv".into());
    asked.distro = Some("ignored".into());
    let built = invocation(Platform::Linux, &asked);
    assert_eq!(
      (built.file.as_str(), built.args.as_slice()),
      ("bash", ["-lc".to_owned(), "make".to_owned()].as_slice())
    );
    assert_eq!(built.cwd.as_deref(), Some("/srv"));
  }

  #[test]
  fn the_tree_kill_reaches_the_whole_tree_by_force() {
    assert_eq!(tree_kill_command(42), ["taskkill", "/PID", "42", "/T", "/F"]);
  }
}
