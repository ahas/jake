// Starting a helper command with no window and nothing read from it, and waiting on it within a bound.

use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;

/// The Windows process-creation flag that gives a console program no visible window.
#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// A command whose standard streams are discarded and which opens no window of its own.
pub fn quiet(argv: &[String]) -> Option<Command> {
  let (file, args) = argv.split_first()?;
  let mut command = Command::new(file);
  command.args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
  #[cfg(windows)]
  command.creation_flags(CREATE_NO_WINDOW);
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

/// The arguments of a command line, owned.
pub fn argv(parts: &[&str]) -> Vec<String> {
  parts.iter().map(|part| (*part).to_owned()).collect()
}
