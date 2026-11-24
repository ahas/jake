// Starting a helper command with no window, and waiting on it, or on what it prints, within a bound.

use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;

/// How every child starts on Windows: a console of its own with no visible window, and a process group
/// of its own, so a console event a child sends to its group or its console never reaches the agent.
#[cfg(windows)]
pub const CHILD_CREATION_FLAGS: u32 = CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(windows)]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

/// A command whose standard streams are discarded and which opens no window of its own.
pub fn quiet(argv: &[String]) -> Option<Command> {
  let (file, args) = argv.split_first()?;
  let mut command = Command::new(file);
  command.args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
  #[cfg(windows)]
  command.creation_flags(CHILD_CREATION_FLAGS);
  Some(command)
}

/// Run a helper to its end, or give up waiting on it once `within` has passed.
pub async fn run(argv: &[String], within: Duration) -> Result<(), String> {
  let mut command = quiet(argv).ok_or("an empty command")?;
  let mut child = command.spawn().map_err(|error| format!("{}: {error}", argv[0]))?;
  match tokio::time::timeout(within, child.wait()).await {
    Ok(Ok(status)) if status.success() => Ok(()),
    Ok(Ok(status)) => Err(format!("{} ended with {status}", argv[0])),
    Ok(Err(error)) => Err(format!("{}: {error}", argv[0])),
    Err(_) => Err(format!("{} did not finish within {within:?}", argv[0])),
  }
}

/// How a helper that printed nothing to take ended.
#[derive(Debug, PartialEq, Eq)]
pub enum Unanswered {
  /// It ran and ended in failure: what it was asked does not hold.
  Failed(String),
  /// It could not be started, or did not finish within its bound and was ended: it said nothing.
  Silent(String),
}

/// Run a helper to its end and take what it printed, or give up on it, ending it, once `within` has
/// passed; a helper that ends in failure prints nothing taken.
pub async fn output(argv: &[String], within: Duration) -> Result<Vec<u8>, Unanswered> {
  let mut command = quiet(argv).ok_or_else(|| Unanswered::Silent("an empty command".to_owned()))?;
  command.stdout(Stdio::piped()).kill_on_drop(true);
  match tokio::time::timeout(within, command.output()).await {
    Ok(Ok(output)) if output.status.success() => Ok(output.stdout),
    Ok(Ok(output)) => Err(Unanswered::Failed(format!("{} ended with {}", argv[0], output.status))),
    Ok(Err(error)) => Err(Unanswered::Silent(format!("{}: {error}", argv[0]))),
    Err(_) => Err(Unanswered::Silent(format!("{} did not finish within {within:?}", argv[0]))),
  }
}

/// Run a helper to its end, or end it once `within` has passed, so a helper given up on does not stay
/// behind.
pub async fn finish(argv: &[String], within: Duration) -> Result<(), String> {
  let mut command = quiet(argv).ok_or("an empty command")?;
  command.kill_on_drop(true);
  let mut child = command.spawn().map_err(|error| format!("{}: {error}", argv[0]))?;
  match tokio::time::timeout(within, child.wait()).await {
    Ok(Ok(status)) if status.success() => Ok(()),
    Ok(Ok(status)) => Err(format!("{} ended with {status}", argv[0])),
    Ok(Err(error)) => Err(format!("{}: {error}", argv[0])),
    Err(_) => Err(format!("{} did not finish within {within:?} and was ended", argv[0])),
  }
}

/// Start a program that outlives this one: with no window, in a process group of its own, and out of any
/// job that would end it with this process where the job lets it leave.
pub fn spawn_detached(argv: &[String]) -> Result<(), String> {
  let (program, arguments) = argv.split_first().ok_or("an empty command")?;
  let mut command = std::process::Command::new(program);
  command.args(arguments).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt as _;
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
    command.creation_flags(CHILD_CREATION_FLAGS | CREATE_BREAKAWAY_FROM_JOB);
    if command.spawn().is_ok() {
      return Ok(());
    }
    command.creation_flags(CHILD_CREATION_FLAGS);
  }
  command.spawn().map(drop).map_err(|error| format!("{program}: {error}"))
}
