// Pausing the built-in agent while the session is locked, where the settings say control is not kept.

use std::future::Future;

use tokio::sync::watch;

use crate::settings::{Switch, Switches};

/// Whether the agent is to be paused: the session is locked and control is not kept while it is.
pub fn paused(locked: &bool, switches: &Switches) -> bool {
  *locked && !switches.on(Switch::KeepControlWhileLocked)
}

/// Run `serve` while the agent is not paused, handing it a stop that turns true once a pause or the
/// app's quit comes and waiting for it to end; a pause tells `on_pause`, waits for its end and serves
/// again. Answers what `serve` ended with of itself, or none once the app quits.
pub async fn serve_unpaused<T, Serving: Future<Output = T>>(
  mut serve: impl FnMut(watch::Receiver<bool>) -> Serving,
  paused: &mut watch::Receiver<bool>,
  quit: &mut watch::Receiver<bool>,
  mut on_pause: impl FnMut(),
) -> Option<T> {
  loop {
    if *quit.borrow() {
      return None;
    }
    if *paused.borrow_and_update() {
      on_pause();
      tokio::select! {
        () = turns(paused, false) => continue,
        () = quitting(quit) => return None,
      }
    }
    let (stop, stopped) = watch::channel(false);
    let serving = serve(stopped);
    tokio::pin!(serving);
    tokio::select! {
      ended = &mut serving => return (!*quit.borrow()).then_some(ended),
      () = turns(paused, true) => {
        stop.send_replace(true);
        serving.await;
      }
      () = quitting(quit) => {
        stop.send_replace(true);
        serving.await;
        return None;
      }
    }
  }
}

/// Resolves once the watch holds `value`; a watch whose sender is gone never changes again.
async fn turns(watch: &mut watch::Receiver<bool>, value: bool) {
  if watch.wait_for(|held| *held == value).await.is_err() {
    std::future::pending::<()>().await;
  }
}

/// Resolves once the app quits, or its quit can no longer be sent.
async fn quitting(quit: &mut watch::Receiver<bool>) {
  let _ = quit.wait_for(|quit| *quit).await;
}

#[cfg(test)]
mod tests {
  use super::*;
  use tokio::sync::mpsc;

  #[test]
  fn only_a_lock_with_control_not_kept_pauses() {
    let kept = Switches::default();
    let not_kept = Switches::default().with(Switch::KeepControlWhileLocked, false);
    assert!(!paused(&false, &kept));
    assert!(!paused(&true, &kept));
    assert!(!paused(&false, &not_kept));
    assert!(paused(&true, &not_kept));
  }

  type Serving = std::pin::Pin<Box<dyn Future<Output = &'static str> + Send>>;

  /// A stand-in for the agent: it says when it starts and when its stop has ended it.
  fn agent(events: mpsc::UnboundedSender<&'static str>) -> impl FnMut(watch::Receiver<bool>) -> Serving {
    move |mut stop| {
      let events = events.clone();
      Box::pin(async move {
        events.send("started").unwrap();
        let _ = stop.wait_for(|stop| *stop).await;
        events.send("stopped").unwrap();
        "stopped"
      })
    }
  }

  async fn next(events: &mut mpsc::UnboundedReceiver<&'static str>) -> &'static str {
    events.recv().await.unwrap()
  }

  #[tokio::test]
  async fn a_lock_stops_the_agent_and_an_unlock_serves_again_until_the_quit() {
    let (events, mut seen) = mpsc::unbounded_channel();
    let (pause, mut paused) = watch::channel(false);
    let (quit, mut quitting) = watch::channel(false);
    let paused_events = events.clone();
    let course = tokio::spawn(async move {
      serve_unpaused(agent(events), &mut paused, &mut quitting, || {
        paused_events.send("paused").unwrap();
      })
      .await
    });

    assert_eq!(next(&mut seen).await, "started");
    pause.send_replace(true);
    assert_eq!(next(&mut seen).await, "stopped");
    assert_eq!(next(&mut seen).await, "paused");
    pause.send_replace(false);
    assert_eq!(next(&mut seen).await, "started");
    quit.send_replace(true);
    assert_eq!(next(&mut seen).await, "stopped");
    assert_eq!(course.await.unwrap(), None);
  }

  #[tokio::test]
  async fn an_app_started_behind_a_lock_serves_nothing_until_it_is_unlocked() {
    let (events, mut seen) = mpsc::unbounded_channel();
    let (pause, mut paused) = watch::channel(true);
    let (quit, mut quitting) = watch::channel(false);
    let paused_events = events.clone();
    let course = tokio::spawn(async move {
      serve_unpaused(agent(events), &mut paused, &mut quitting, || {
        paused_events.send("paused").unwrap();
      })
      .await
    });

    assert_eq!(next(&mut seen).await, "paused");
    quit.send_replace(true);
    assert_eq!(course.await.unwrap(), None);
    drop(pause);
    assert!(seen.try_recv().is_err());
  }

  #[tokio::test]
  async fn what_the_agent_ends_with_of_itself_is_answered() {
    let (_pause, mut paused) = watch::channel(false);
    let (_quit, mut quitting) = watch::channel(false);
    let ended = serve_unpaused(|_| async { "left" }, &mut paused, &mut quitting, || {}).await;
    assert_eq!(ended, Some("left"));
  }
}
