// The app's course: the credential, pairing, the one-name check, and the supervised agent, in turn.

use std::sync::Arc;

use jake_agent::installed::Installed;
use jake_agent::{Agent, AgentConfig, Ended, Link, Log, WhenSuperseded};
use serde_json::json;
use tokio::sync::{mpsc, watch};
use url::Url;

use crate::link::Invited;
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
  /// Tell the person something they must read, in a native message box.
  fn tell(&self, message: String);
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
  /// How much work the built-in agent carries for the hub, 0 while none runs.
  pub carrying: watch::Sender<usize>,
  /// The app's own instance, which the built-in agent's hello names (docs/desktop.md, 「Pairing」).
  pub instance: String,
  /// This machine's fingerprint, which the built-in agent's hello names; none where it could not be read.
  pub machine: Option<String>,
  /// An invitation a link handed over, which approves the next pairing in place of the person (docs/desktop.md,
  /// 「Opening from a link」).
  pub invitations: watch::Sender<Option<Invited>>,
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
        Some(state) => {
          let waits = state.waits_on_person();
          self.set_agent(state);
          if waits {
            self.window.open_local();
          }
        }
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
    let installed = tokio::task::spawn_blocking(jake_agent::installed::installed_agent)
      .await
      .ok()
      .flatten()
      .map(|installed| installed.name);
    if let Some(name) = installed {
      self
        .log
        .info("built-in-agent-held-off", json!({ "agent": machine.node, "installed": name }));
      return Some(if name == machine.node {
        AgentState::HeldOff(name)
      } else {
        AgentState::MachineHeld(name)
      });
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
      Ended::MachineHeld(holder) => Some(AgentState::MachineHeld(holder)),
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
    let (opened, opening) = watch::channel(None);
    let pairing = self.console.pair(|pairing| {
      self.log.info("pairing-opened", json!({ "code": pairing.code }));
      self.set_agent(AgentState::Pairing {
        code: pairing.code.clone(),
        approve_url: pairing.approve_url.clone(),
      });
      // Holding an invitation, the app approves the pairing itself, and shows the approval page only if the
      // invitation is refused.
      let invited = self.invitations.borrow().as_ref().is_some_and(|invited| invited.fresh().is_some());
      if !invited {
        self.window.open(&pairing.approve_url);
      }
      opened.send_replace(Some((pairing.code.clone(), pairing.approve_url.clone())));
    });
    let paired = tokio::select! {
      paired = pairing => paired,
      never = self.approve_by_invitation(opening) => match never {},
    };
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

  /// Approve the pairing once it opens with each fresh invitation handed over while it is open, each used once;
  /// one refused opens the approval page and tells the person the console's reason. It runs until the pairing ends
  /// and drops it.
  async fn approve_by_invitation(
    &self,
    mut opening: watch::Receiver<Option<(String, Url)>>,
  ) -> std::convert::Infallible {
    let mut handed = self.invitations.subscribe();
    let opened = opening.wait_for(Option::is_some).await.ok().and_then(|opened| opened.clone());
    let Some((code, approve_url)) = opened else {
      return std::future::pending().await;
    };
    loop {
      // Taking one tells the watch, and taking none leaves it quiet, so the wait below sees only a new hand-over.
      let mut taken = None;
      self.invitations.send_if_modified(|handed| {
        taken = handed.take();
        taken.is_some()
      });
      let invite = taken.and_then(|invited| invited.fresh().map(str::to_owned));
      if let Some(invite) = invite {
        match self.console.approve(&invite, &code).await {
          Ok(()) => self.log.info("pairing-approved-by-invitation", json!({ "code": code })),
          Err(reason) => {
            self.log.warn("invitation-refused", json!({ "code": code, "reason": reason }));
            self.window.open(&approve_url);
            self.window.tell(format!(
              "초대로 이 기기를 연결하지 못했습니다.\n{reason}\n열린 승인 페이지에서 로그인해 연결해 주세요."
            ));
          }
        }
      }
      if handed.changed().await.is_err() {
        return std::future::pending().await;
      }
    }
  }

  /// Run the built-in agent under the machine's credential, supervised, until it ends or `stop` turns
  /// true.
  async fn serve(&self, machine: &Machine, mut stop: watch::Receiver<bool>) -> Ended {
    let (status, log, halt) = (self.status.clone(), self.log.clone(), stop.clone());
    let carrying = self.carrying.clone();
    let start = || {
      status.send_modify(|status| status.agent = AgentState::Link(Link::Connecting));
      let config =
        AgentConfig::new(machine.hub_url.clone(), machine.credential.clone(), machine.node.clone());
      let agent = Agent::new(config, AGENT_VERSION.to_owned(), log.clone())
        .instance(self.instance.clone())
        .machine(self.machine.clone())
        .when_superseded(WhenSuperseded::GiveUp);
      let mut link = agent.link();
      let mut carried = agent.carrying();
      let carrying = carrying.clone();
      // The count goes back to 0 once the agent's watch closes, whichever way its task ended.
      tokio::spawn(async move {
        while carried.changed().await.is_ok() {
          carrying.send_replace(*carried.borrow_and_update());
        }
        carrying.send_replace(0);
      });
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

/// Switch from the installed agent the course is held off for to the built-in one: the installed agent of that
/// name, found by `find`, is stopped through its own uninstaller, `uninstall`, and the course looks again, which then
/// starts the built-in agent. An uninstaller that fails leaves the installed agent serving, and the page says why; so
/// does a jake holding the machine that `find` does not see here, one inside a WSL distribution. Asked in any other
/// state, it does nothing.
pub async fn switch_to_built_in<F, U>(
  status: &watch::Sender<Status>,
  retries: &mpsc::Sender<()>,
  log: &Log,
  find: F,
  uninstall: U,
) where
  F: FnOnce() -> Option<Installed> + Send + 'static,
  U: FnOnce(&Installed) -> Result<(), String> + Send + 'static,
{
  let (name, held_machine) = match &status.borrow().agent {
    AgentState::HeldOff(name) | AgentState::SwitchFailed { name, .. } => (name.clone(), false),
    AgentState::MachineHeld(holder) => (holder.clone(), true),
    _ => return,
  };
  status.send_modify(|status| status.agent = AgentState::Switching);
  let wanted = name.clone();
  let outcome = tokio::task::spawn_blocking(move || match find() {
    Some(installed) if installed.name == wanted => uninstall(&installed),
    _ if held_machine => Err(unseen_holder(&wanted)),
    _ => Ok(()),
  })
  .await
  .unwrap_or_else(|error| Err(error.to_string()));
  match outcome {
    Ok(()) => {
      log.info("installed-agent-uninstalled", json!({ "agent": name }));
      let _ = retries.try_send(());
    }
    Err(reason) => {
      log.warn("installed-agent-not-uninstalled", json!({ "agent": name, "reason": reason }));
      status.send_modify(|status| status.agent = AgentState::SwitchFailed { name, reason });
    }
  }
}

/// Why a jake holding the machine cannot be stopped from the app: it is installed where the app does not see it.
fn unseen_holder(holder: &str) -> String {
  format!(
    "이 PC에서 jake 설치({holder})를 찾지 못했습니다. WSL 배포판 안에 설치되어 있다면 그 배포판에서 ~/.local/share/jake/jake uninstall을 실행한 뒤 다시 확인해 주세요."
  )
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

#[cfg(test)]
mod tests {
  use std::path::PathBuf;
  use std::sync::Mutex;

  use super::*;

  fn log() -> Log {
    Log::open(std::env::temp_dir().join(format!("jake-desktop-switch-{}.log", std::process::id())))
  }

  fn held(name: &str) -> watch::Sender<Status> {
    watch::Sender::new(Status {
      console: ConsoleState::Shown,
      agent: AgentState::HeldOff(name.to_owned()),
    })
  }

  fn installed(name: &str) -> Option<Installed> {
    Some(Installed {
      name: name.to_owned(),
      dir: PathBuf::from("/install"),
    })
  }

  #[tokio::test]
  async fn the_installed_agent_is_uninstalled_and_the_course_looks_again() {
    let status = held("agent-a");
    let (retries, mut retried) = mpsc::channel(1);
    let uninstalled = std::sync::Arc::new(Mutex::new(Vec::new()));
    let seen = uninstalled.clone();
    switch_to_built_in(
      &status,
      &retries,
      &log(),
      || installed("agent-a"),
      move |found: &Installed| {
        seen.lock().unwrap().push(found.name.clone());
        Ok(())
      },
    )
    .await;

    assert_eq!(*uninstalled.lock().unwrap(), ["agent-a"]);
    assert_eq!(retried.try_recv(), Ok(()));
    assert_eq!(status.borrow().agent, AgentState::Switching);
  }

  #[tokio::test]
  async fn an_uninstaller_that_fails_leaves_the_installed_agent_serving_and_says_why() {
    let status = held("agent-a");
    let (retries, mut retried) = mpsc::channel(1);
    switch_to_built_in(
      &status,
      &retries,
      &log(),
      || installed("agent-a"),
      |_: &Installed| Err("exit 1".to_owned()),
    )
    .await;

    assert!(retried.try_recv().is_err());
    assert_eq!(
      status.borrow().agent,
      AgentState::SwitchFailed {
        name: "agent-a".to_owned(),
        reason: "exit 1".to_owned()
      }
    );
  }

  #[tokio::test]
  async fn an_install_of_another_name_or_none_is_left_alone_and_the_course_looks_again() {
    for found in [installed("agent-b"), None] {
      let status = held("agent-a");
      let (retries, mut retried) = mpsc::channel(1);
      switch_to_built_in(
        &status,
        &retries,
        &log(),
        move || found,
        |_: &Installed| panic!("nothing is uninstalled"),
      )
      .await;
      assert_eq!(retried.try_recv(), Ok(()));
    }
  }

  #[tokio::test]
  async fn a_jake_holding_the_machine_under_another_name_is_uninstalled_where_it_is_found() {
    let status = watch::Sender::new(Status {
      console: ConsoleState::Shown,
      agent: AgentState::MachineHeld("u63".to_owned()),
    });
    let (retries, mut retried) = mpsc::channel(1);
    let uninstalled = std::sync::Arc::new(Mutex::new(Vec::new()));
    let seen = uninstalled.clone();
    switch_to_built_in(
      &status,
      &retries,
      &log(),
      || installed("u63"),
      move |found: &Installed| {
        seen.lock().unwrap().push(found.name.clone());
        Ok(())
      },
    )
    .await;

    assert_eq!(*uninstalled.lock().unwrap(), ["u63"]);
    assert_eq!(retried.try_recv(), Ok(()));
  }

  #[tokio::test]
  async fn a_jake_holding_the_machine_that_is_not_found_here_is_named_with_where_to_remove_it() {
    let status = watch::Sender::new(Status {
      console: ConsoleState::Shown,
      agent: AgentState::MachineHeld("jake-wsl".to_owned()),
    });
    let (retries, mut retried) = mpsc::channel(1);
    switch_to_built_in(
      &status,
      &retries,
      &log(),
      || installed("other"),
      |_: &Installed| panic!("nothing is uninstalled"),
    )
    .await;

    assert!(retried.try_recv().is_err());
    match &status.borrow().agent {
      AgentState::SwitchFailed { name, reason } => {
        assert_eq!(name, "jake-wsl");
        assert!(reason.contains("jake uninstall"), "{reason}");
      }
      other => panic!("{other:?}"),
    }
  }

  #[tokio::test]
  async fn a_switch_asked_in_any_other_state_does_nothing() {
    let status = watch::Sender::new(Status {
      console: ConsoleState::Shown,
      agent: AgentState::Link(Link::Attached),
    });
    let (retries, mut retried) = mpsc::channel(1);
    switch_to_built_in(
      &status,
      &retries,
      &log(),
      || panic!("nothing is looked for"),
      |_: &Installed| Ok(()),
    )
    .await;

    assert!(retried.try_recv().is_err());
    assert_eq!(status.borrow().agent, AgentState::Link(Link::Attached));
  }
}
