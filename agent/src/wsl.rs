// Holding a WSL distribution running from Windows with no window, for a task that runs at logon.

use std::time::Duration;

/// The argument, followed by a distribution's name, that has the executable hold that distribution.
pub const HOLD_WSL_FLAG: &str = "--hold-wsl";

/// How long the hold rests before it opens a session again after one ended.
const REOPEN_AFTER: Duration = Duration::from_secs(10);

/// A session into the distribution that does nothing and never ends, which WSL keeps the distribution
/// running for.
pub fn hold_command(distribution: &str) -> Vec<String> {
  ["wsl.exe", "-d", distribution, "--exec", "sleep", "infinity"]
    .map(str::to_owned)
    .to_vec()
}

/// Keep a session into the distribution open, opening it again a short rest after it ends, for as
/// long as this process runs. The session starts with no window, as every helper does, so the hold
/// shows nothing and no terminal closed by hand ends it.
pub async fn hold(distribution: &str) {
  let argv = hold_command(distribution);
  loop {
    if let Some(mut command) = crate::command::quiet(&argv)
      && let Ok(mut session) = command.spawn()
    {
      let _ = session.wait().await;
    }
    tokio::time::sleep(REOPEN_AFTER).await;
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn the_hold_is_a_session_running_sleep_in_the_named_distribution() {
    assert_eq!(
      hold_command("Ubuntu-24.04"),
      ["wsl.exe", "-d", "Ubuntu-24.04", "--exec", "sleep", "infinity"]
    );
  }
}
