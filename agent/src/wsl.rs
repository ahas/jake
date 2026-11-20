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
  #[cfg(windows)]
  end_sessions_with_this_process();
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

/// Put this process in a job that ends every process in it once its last handle closes, which is
/// when this process ends, however it ends; the session it opens joins the job, so stopping the
/// hold's task ends the session too rather than leaving it to hold the distribution. Where the job
/// cannot be made the hold runs all the same.
#[cfg(windows)]
fn end_sessions_with_this_process() {
  use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation, SetInformationJobObject,
  };
  use windows_sys::Win32::System::Threading::GetCurrentProcess;
  // SAFETY: the job's handle is checked before use; the limits passed are a zeroed structure of the
  // size given with them. The handle is kept open on purpose: it closes as this process ends.
  unsafe {
    let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
    if job.is_null() {
      return;
    }
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    let size = u32::try_from(std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>()).unwrap_or(0);
    let limited = SetInformationJobObject(
      job,
      JobObjectExtendedLimitInformation,
      std::ptr::from_ref(&limits).cast(),
      size,
    );
    if limited != 0 {
      AssignProcessToJobObject(job, GetCurrentProcess());
    }
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
