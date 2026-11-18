// How a Windows run mode answers a console control event: it stops only where Windows ends it anyway.

use std::time::Duration;

use serde_json::json;
use tokio::sync::Notify;

use crate::log::Log;

/// A console control event, as Windows hands it to a handler.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConsoleEvent {
  Interrupt,
  Break,
  Close,
  Logoff,
  Shutdown,
}

impl ConsoleEvent {
  /// The event a handler's code stands for; none for a code Windows does not document.
  pub fn from_code(code: u32) -> Option<Self> {
    match code {
      0 => Some(Self::Interrupt),
      1 => Some(Self::Break),
      2 => Some(Self::Close),
      5 => Some(Self::Logoff),
      6 => Some(Self::Shutdown),
      _ => None,
    }
  }

  pub fn name(self) -> &'static str {
    match self {
      Self::Interrupt => "ctrl-c",
      Self::Break => "ctrl-break",
      Self::Close => "close",
      Self::Logoff => "logoff",
      Self::Shutdown => "shutdown",
    }
  }

  /// Whether the run stops on this event. A closed console and a shutdown end the process once the
  /// handler returns, whatever it answers, so the run stops cleanly first. An interrupt or a break is a
  /// key or another process's call, and a logoff notice may be another session's; the end of this
  /// session ends the process by itself, so none of them stops the run.
  pub fn stops_the_run(self) -> bool {
    matches!(self, Self::Close | Self::Shutdown)
  }
}

/// How long the handler holds a stopping event back, so the run stops cleanly before Windows ends the
/// process; Windows gives a closing console five seconds.
pub const STOP_GRACE: Duration = Duration::from_secs(4);

/// What answers this process's console events: the log each event is written to, and the stop the
/// run awaits.
pub struct ConsoleWatch {
  log: Log,
  stop: Notify,
}

impl ConsoleWatch {
  pub fn new(log: Log) -> Self {
    Self {
      log,
      stop: Notify::new(),
    }
  }

  /// Write the event to the log, and ask the run to stop where the event stops it; the answer says
  /// whether it did.
  pub fn answer(&self, event: ConsoleEvent) -> bool {
    let stops = event.stops_the_run();
    let name = if stops { "console-event-stopping" } else { "console-event-ignored" };
    self.log.warn(name, json!({ "consoleEvent": event.name() }));
    if stops {
      self.stop.notify_one();
    }
    stops
  }

  /// Resolves once an event has stopped the run.
  pub async fn stopped(&self) {
    self.stop.notified().await;
  }
}

/// Resolves when a console event stops the run. The first call installs this process's console
/// handler, which takes the place of Windows' default one: that default ends the process on any event,
/// writing nothing, with the status 0xC000013A.
#[cfg(windows)]
pub async fn stop_requested(log: Log) {
  use std::sync::OnceLock;

  use windows_sys::Win32::Foundation::{FALSE, TRUE};
  use windows_sys::Win32::System::Console::SetConsoleCtrlHandler;
  use windows_sys::core::BOOL;

  static WATCH: OnceLock<ConsoleWatch> = OnceLock::new();

  unsafe extern "system" fn on_event(code: u32) -> BOOL {
    let (Some(watch), Some(event)) = (WATCH.get(), ConsoleEvent::from_code(code)) else {
      return FALSE;
    };
    if watch.answer(event) {
      // Windows ends the process once this returns; the run's own clean exit ends it sooner.
      std::thread::sleep(STOP_GRACE);
    }
    TRUE
  }

  let watch = WATCH.get_or_init(|| {
    // SAFETY: the handler is a plain function that stays valid for the life of the process.
    if unsafe { SetConsoleCtrlHandler(Some(on_event), TRUE) } == 0 {
      log.warn(
        "console-handler-failed",
        json!({ "error": std::io::Error::last_os_error().to_string() }),
      );
    }
    ConsoleWatch::new(log)
  });
  watch.stopped().await;
}

#[cfg(test)]
mod tests {
  use futures_util::FutureExt as _;

  use super::*;

  #[test]
  fn an_interrupt_a_break_or_a_logoff_is_ignored_and_a_close_or_a_shutdown_stops_the_run() {
    let path = std::env::temp_dir().join(format!("jake-console-{}.log", std::process::id()));
    let watch = ConsoleWatch::new(Log::open(path.clone()));
    for code in [0, 1, 5] {
      assert!(!watch.answer(ConsoleEvent::from_code(code).unwrap()));
    }
    assert_eq!(watch.stopped().now_or_never(), None);
    for code in [2, 6] {
      assert!(watch.answer(ConsoleEvent::from_code(code).unwrap()));
      assert_eq!(watch.stopped().now_or_never(), Some(()));
    }
    let written = std::fs::read_to_string(&path).unwrap();
    std::fs::remove_file(&path).unwrap();
    let events: Vec<(String, String)> = written
      .lines()
      .map(|line| {
        let line: serde_json::Value = serde_json::from_str(line).unwrap();
        (
          line["event"].as_str().unwrap().to_owned(),
          line["consoleEvent"].as_str().unwrap().to_owned(),
        )
      })
      .collect();
    let ignored = |name: &str| ("console-event-ignored".to_owned(), name.to_owned());
    let stopping = |name: &str| ("console-event-stopping".to_owned(), name.to_owned());
    assert_eq!(
      events,
      [
        ignored("ctrl-c"),
        ignored("ctrl-break"),
        ignored("logoff"),
        stopping("close"),
        stopping("shutdown")
      ]
    );
    assert_eq!(ConsoleEvent::from_code(3), None);
  }
}
