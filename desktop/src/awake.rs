// Keeping the PC from sleeping for idleness while the built-in agent serves, where the settings ask it.

use jake_agent::Log;
use tokio::sync::watch;

use crate::settings::{Switch, Switches};
use crate::status::{AgentState, Status};

/// Whether the system is to be kept awake: the setting is on and the agent serves the hub.
pub fn wanted(switches: &Switches, status: &Status) -> bool {
  switches.on(Switch::KeepAwake) && matches!(status.agent, AgentState::Link(_))
}

/// Hold the system's wake request as `wanted` says, releasing it once the watch's sender is gone.
pub async fn hold(mut wanted: watch::Receiver<bool>, log: Log) {
  let request = system::Request::start(log);
  loop {
    request.set(*wanted.borrow_and_update());
    if wanted.changed().await.is_err() {
      request.set(false);
      return;
    }
  }
}

#[cfg(windows)]
mod system {
  use std::sync::mpsc;

  use jake_agent::Log;
  use serde_json::json;
  use windows_sys::Win32::System::Power::{ES_CONTINUOUS, ES_SYSTEM_REQUIRED, SetThreadExecutionState};

  /// The wake request, made from a thread of its own: Windows holds a continuous request for as long
  /// as the thread that made it lives.
  pub struct Request(mpsc::Sender<bool>);

  impl Request {
    pub fn start(log: Log) -> Self {
      let (wanted, asked) = mpsc::channel::<bool>();
      let requester = log.clone();
      let started = std::thread::Builder::new().name("keep-awake".into()).spawn(move || {
        for on in asked {
          let flags = if on { ES_CONTINUOUS | ES_SYSTEM_REQUIRED } else { ES_CONTINUOUS };
          // SAFETY: the call takes flags alone and touches no memory of the caller's.
          if unsafe { SetThreadExecutionState(flags) } == 0 {
            requester.warn("keep-awake-refused", json!({ "on": on }));
          } else {
            requester.info("keep-awake", json!({ "on": on }));
          }
        }
      });
      if let Err(error) = started {
        log.warn("keep-awake-not-started", json!({ "error": error.to_string() }));
      }
      Self(wanted)
    }

    pub fn set(&self, on: bool) {
      let _ = self.0.send(on);
    }
  }
}

#[cfg(not(windows))]
mod system {
  use jake_agent::Log;

  /// No request is made where the setting is not offered.
  pub struct Request;

  impl Request {
    pub fn start(_log: Log) -> Self {
      Self
    }

    pub fn set(&self, _on: bool) {}
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use jake_agent::Link;

  #[test]
  fn the_system_is_kept_awake_only_while_the_agent_serves_and_the_setting_asks() {
    let on = Switches::default().with(Switch::KeepAwake, true);
    let serving = Status {
      agent: AgentState::Link(Link::Attached),
      ..Status::default()
    };
    let paused = Status {
      agent: AgentState::Paused,
      ..Status::default()
    };
    assert!(wanted(&on, &serving));
    assert!(!wanted(&on, &paused));
    assert!(!wanted(&Switches::default(), &serving));
  }
}
