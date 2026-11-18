// The app's course: the credential, pairing, the one-name check, and the supervised agent, in turn.

use std::sync::Arc;

use jake_agent::{Agent, AgentConfig, Ended, Link, Log, WhenSuperseded};
use serde_json::json;
use tokio::sync::{mpsc, watch};
use url::Url;

use crate::pairing::{Console, Machine, PairingError};
use crate::pause::serve_unpaused;
use crate::status::{AgentState, ConsoleState, PairingFailure, Status};
use crate::supervisor::supervise;
use crate::vault::{NoStore, Vault};

/// What the controller asks of the window it does not own.
pub trait Window: Send + Sync + 'static {
  /// Open a page of the console's origin in the main window.
  fn open(&self, url: &Url);
  /// Show the bundled page in the main window.
  fn open_local(&self);
}

/// Everything the course runs with.
pub struct Controller<W: Window> {
  pub console: Arc<Console>,
  pub vault: Arc<Vault>,
  pub log: Log,
  pub window: Arc<W>,
  pub status: watch::Sender<Status>,
  pub quit: watch::Receiver<bool>,
  /// Whether the agent is paused while the session is locked.
  pub paused: watch::Receiver<bool>,
  /// The page's asks to try again: pair again, or look again.
  pub retries: mpsc::Receiver<()>,
}

/// How long a quit waits for the built-in agent to close its connection.
const QUIT_GRACE: std::time::Duration = std::time::Duration::from_secs(3);

/// The version the built-in agent announces in its hello, telling it from an installed one.
const AGENT_VERSION: &str = concat!("desktop-", env!("CARGO_PKG_VERSION"));

impl<W: Window> Controller<W> {
  /// Run the course until the app quits; a state that needs the person waits for the page's ask.
  pub async fn run(mut self) {
    let mut quit = self.quit.clone();
    // The console is shown before a pairing can open its approval page, so nothing replaces that page.
    show_console(&self.console, self.window.as_ref(), &self.status, &self.log).await;
    loop {
      let held = {
        let course = self.course();
        tokio::pin!(course);
        tokio::select! {
          held = &mut course => held,
          () = quitting(&mut quit) => {
            // A serving agent sees the quit too and closes its connection; a pairing is simply dropped.
            let _ = tokio::time::timeout(QUIT_GRACE, course).await;
            return;
          }
        }
      };
      match held {
        Some(state) => self.set_agent(state),
        None => return,
      }
      tokio::select! {
        retry = self.retries.recv() => if retry.is_none() { return },
        () = quitting(&mut quit) => return,
      }
    }
  }

  /// One pass: the state it stopped in for the person to act on, or none once the agent stopped
  /// because the app quits.
  async fn course(&self) -> Option<AgentState> {
    self.set_agent(AgentState::Starting);
    let machine = match self.machine().await {
      Ok(machine) => machine,
      Err(state) => return Some(state),
    };
    let (mut paused, mut quit) = (self.paused.clone(), self.quit.clone());
    let pause = || {
      self.log.info("built-in-agent-paused", json!({ "agent": machine.node }));
      self.set_agent(AgentState::Paused);
    };
    serve_unpaused(|stop| self.held_or_serve(&machine, stop), &mut paused, &mut quit, pause)
      .await
      .flatten()
  }

  /// The machine's agent served until `stop`, or the state it was held off in; none once stopped.
  async fn held_or_serve(&self, machine: &Machine, stop: watch::Receiver<bool>) -> Option<AgentState> {
    let installed = tokio::task::spawn_blocking(jake_agent::installed::running_agent_name)
      .await
      .ok()
      .flatten();
    if installed.as_deref() == Some(machine.node.as_str()) {
      self.log.info("built-in-agent-held-off", json!({ "agent": machine.node }));
      return Some(AgentState::HeldOff(machine.node.clone()));
    }
    match self.serve(machine, stop).await {
      Ended::Stopped => None,
      Ended::Left => {
        self.log.warn("machine-removed", json!({ "agent": machine.node }));
        let vault = self.vault.clone();
        if let Ok(Err(NoStore(reason))) = tokio::task::spawn_blocking(move || vault.forget()).await {
          self.log.warn("credential-not-forgotten", json!({ "reason": reason }));
        }
        Some(AgentState::Removed)
      }
      Ended::Superseded => Some(AgentState::Yielded(machine.node.clone())),
    }
  }

  /// The machine kept in the store, or one a new pairing yields and the store keeps.
  async fn machine(&self) -> Result<Machine, AgentState> {
    let vault = self.vault.clone();
    let kept = tokio::task::spawn_blocking(move || vault.load())
      .await
      .unwrap_or_else(|error| Err(NoStore(error.to_string())));
    match kept {
      Ok(Some(machine)) => return Ok(machine),
      Ok(None) => {}
      Err(NoStore(reason)) => {
        self.log.warn("no-credential-store", json!({ "reason": reason }));
        return Err(AgentState::NoStore(reason));
      }
    }
    let paired = self
      .console
      .pair(|pairing| {
        self.log.info("pairing-opened", json!({ "code": pairing.code }));
        self.set_agent(AgentState::Pairing {
          code: pairing.code.clone(),
          approve_url: pairing.approve_url.clone(),
        });
        self.window.open(&pairing.approve_url);
      })
      .await;
    let machine = match paired {
      Ok(machine) => machine,
      Err(error) => {
        self.log.warn("pairing-failed", json!({ "reason": format!("{error:?}") }));
        return Err(AgentState::PairingFailed(match error {
          PairingError::Unreachable(_) => PairingFailure::ConsoleUnreachable,
          PairingError::Gone => PairingFailure::Gone,
          PairingError::Invalid(_) => PairingFailure::Invalid,
        }));
      }
    };
    self.log.info("paired", json!({ "agent": machine.node }));
    self.set_agent(AgentState::Starting);
    let vault = self.vault.clone();
    let kept = machine.clone();
    let stored = tokio::task::spawn_blocking(move || vault.keep(&kept))
      .await
      .unwrap_or_else(|error| Err(NoStore(error.to_string())));
    show_console(&self.console, self.window.as_ref(), &self.status, &self.log).await;
    match stored {
      Ok(()) => Ok(machine),
      Err(NoStore(reason)) => {
        self.log.warn("credential-not-kept", json!({ "reason": reason }));
        Err(AgentState::PairingFailed(PairingFailure::NotKept))
      }
    }
  }

  /// Run the built-in agent under the machine's credential, supervised, until it ends or `stop` turns
  /// true.
  async fn serve(&self, machine: &Machine, mut stop: watch::Receiver<bool>) -> Ended {
    let (status, log, halt) = (self.status.clone(), self.log.clone(), stop.clone());
    let start = || {
      status.send_modify(|status| status.agent = AgentState::Link(Link::Connecting));
      let config =
        AgentConfig::new(machine.hub_url.clone(), machine.credential.clone(), machine.node.clone());
      let agent =
        Agent::new(config, AGENT_VERSION.to_owned(), log.clone()).when_superseded(WhenSuperseded::GiveUp);
      let mut link = agent.link();
      let status = status.clone();
      // The watch's sender goes with the agent, so this ends with the task however the task ends. A
      // link reported once the agent is stopped never covers the state the stop left.
      tokio::spawn(async move {
        while link.changed().await.is_ok() {
          let now = link.borrow_and_update().clone();
          status.send_if_modified(|status| {
            let serving = matches!(status.agent, AgentState::Link(_));
            if serving {
              status.agent = AgentState::Link(now);
            }
            serving
          });
        }
      });
      let mut halt = halt.clone();
      tokio::spawn(async move {
        let stop = async move {
          let _ = halt.wait_for(|halt| *halt).await;
        };
        jake_agent::run(&agent, stop).await
      })
    };
    let restarting = |pause: std::time::Duration, message: String| {
      self
        .log
        .warn("agent-panicked", json!({ "message": message, "restartInMs": pause.as_millis() as u64 }));
      self.status.send_modify(|status| status.agent = AgentState::Restarting(pause));
    };
    supervise(start, &mut stop, restarting).await
  }

  fn set_agent(&self, state: AgentState) {
    self.status.send_modify(|status| status.agent = state);
  }
}

/// Show the console if it answers, the bundled page with the reason if it does not; while a pairing
/// is open, the console's page is its approval page.
pub async fn show_console<W: Window>(
  console: &Console,
  window: &W,
  status: &watch::Sender<Status>,
  log: &Log,
) {
  status.send_modify(|status| status.console = ConsoleState::Checking);
  match console.reachable().await {
    Ok(()) => {
      let page = match &status.borrow().agent {
        AgentState::Pairing { approve_url, .. } => approve_url.clone(),
        _ => console.base().clone(),
      };
      window.open(&page);
      status.send_modify(|status| status.console = ConsoleState::Shown);
    }
    Err(reason) => {
      log.warn("console-unreachable", json!({ "reason": reason }));
      window.open_local();
      status.send_modify(|status| status.console = ConsoleState::Unreachable(reason));
    }
  }
}

/// Resolves once the app quits, holding no borrow of the watch past that moment.
async fn quitting(quit: &mut watch::Receiver<bool>) {
  let _ = quit.wait_for(|quit| *quit).await;
}
