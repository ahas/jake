// The built-in agent's task, started again after a pause whenever it panics.

use std::any::Any;
use std::time::Duration;

use jake_agent::Ended;
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio::time::{Instant, sleep};

/// The first pause before a task that panicked is started again; each panic in a row doubles it.
const RESTART_BASE: Duration = Duration::from_secs(1);
/// The longest pause.
const RESTART_CAP: Duration = Duration::from_secs(5 * 60);
/// A run that lasted this long was healthy, so the next panic pauses from the first step again.
const HEALTHY_RUN: Duration = Duration::from_secs(10 * 60);
// The attempt counter stops growing here; the pause reached the cap long before.
const MAX_ATTEMPT: u32 = 30;

/// Run the task `start` hands back until it ends of itself, starting it again after a pause each
/// time it panics, and telling `restarting` the pause and the panic's message first. A `quit` that
/// turns true during a pause ends it at once; the task itself is handed `quit` by `start`.
pub async fn supervise(
  mut start: impl FnMut() -> JoinHandle<Ended>,
  quit: &mut watch::Receiver<bool>,
  mut restarting: impl FnMut(Duration, String),
) -> Ended {
  let mut attempt: u32 = 0;
  loop {
    let began = Instant::now();
    let error = match start().await {
      Ok(ended) => return ended,
      Err(error) if error.is_panic() => error,
      Err(_) => return Ended::Stopped,
    };
    if began.elapsed() >= HEALTHY_RUN {
      attempt = 0;
    }
    let pause = jake_agent::backoff(RESTART_BASE, RESTART_CAP, attempt, 1.0);
    attempt = (attempt + 1).min(MAX_ATTEMPT);
    restarting(pause, panic_message(error.into_panic()));
    tokio::select! {
      () = sleep(pause) => {}
      _ = quit.wait_for(|quit| *quit) => return Ended::Stopped,
    }
  }
}

fn panic_message(payload: Box<dyn Any + Send>) -> String {
  match payload.downcast::<String>() {
    Ok(message) => *message,
    Err(payload) => payload
      .downcast_ref::<&str>()
      .map_or_else(|| "a panic with no message".to_owned(), |message| (*message).to_owned()),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  // A task that panics, until `panics` of them have, then ends as `last`.
  fn starts(panics: usize, last: Ended) -> impl FnMut() -> JoinHandle<Ended> {
    let mut started = 0;
    move || {
      started += 1;
      let panic = started <= panics;
      tokio::spawn(async move {
        assert!(!panic, "fault {started}");
        last
      })
    }
  }

  #[tokio::test(start_paused = true)]
  async fn a_panicking_task_is_started_again_after_pauses_that_double() {
    let (_quit, mut quit) = watch::channel(false);
    let mut pauses = Vec::new();
    let ended =
      supervise(starts(3, Ended::Left), &mut quit, |pause, message| pauses.push((pause, message))).await;

    assert_eq!(ended, Ended::Left);
    let seconds: Vec<u64> = pauses.iter().map(|(pause, _)| pause.as_secs()).collect();
    assert_eq!(seconds, [1, 2, 4]);
    assert_eq!(pauses[0].1, "fault 1");
  }

  #[tokio::test(start_paused = true)]
  async fn quitting_during_a_pause_ends_the_supervision() {
    let (quit_now, mut quit) = watch::channel(false);
    let ended = supervise(starts(usize::MAX, Ended::Left), &mut quit, |_, _| {
      quit_now.send_replace(true);
    })
    .await;
    assert_eq!(ended, Ended::Stopped);
  }
}
