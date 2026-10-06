// The jake executable: the agent, the Windows guard, or the uninstaller's leave notice, by its argument.

mod command;
mod config;
mod connection;
mod departure;
mod exec;
mod log;
mod pair;
mod platform;
mod stream;
mod transfer;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use serde_json::json;

use crate::connection::Agent;
use crate::log::Log;
use crate::pair::{GUARD_MODE_FLAG, Watchdog};
use crate::platform::{Platform, Role};

/// This build's version, announced in the hello; the build stamps it in through `JAKE_VERSION`.
const VERSION: &str = match option_env!("JAKE_VERSION") {
  Some(version) => version,
  None => env!("CARGO_PKG_VERSION"),
};

/// The argument that has the executable tell the hub it was uninstalled, and exit.
const LEAVE_FLAG: &str = "--leave";

enum Mode {
  Agent,
  Guard,
  Leave,
}

/// Everything a run mode starts from: where it was installed, its environment, its config and log.
struct Start {
  install_dir: PathBuf,
  env: HashMap<String, String>,
  config: config::AgentConfig,
  log: Log,
}

fn start() -> Result<Start, String> {
  let exe = std::env::current_exe().map_err(|error| format!("cannot find this executable: {error}"))?;
  let install_dir = exe.parent().map_or_else(|| PathBuf::from("."), Path::to_path_buf);
  let env = config::merged(&install_dir, std::env::vars().collect())?;
  let config = config::read(&env)?;
  let log = Log::open(PathBuf::from(Platform::HOST.log_path(&env)));
  Ok(Start {
    install_dir,
    env,
    config,
    log,
  })
}

/// Resolves when the process is asked to stop.
async fn stop_requested() {
  #[cfg(unix)]
  {
    use tokio::signal::unix::{SignalKind, signal};
    match (signal(SignalKind::interrupt()), signal(SignalKind::terminate())) {
      (Ok(mut interrupt), Ok(mut terminate)) => {
        tokio::select! {
          _ = interrupt.recv() => {}
          _ = terminate.recv() => {}
        }
      }
      _ => std::future::pending().await,
    }
  }
  #[cfg(windows)]
  {
    if tokio::signal::ctrl_c().await.is_err() {
      std::future::pending::<()>().await;
    }
  }
}

/// The lock and watchdog that keep one copy of a Windows run mode alive, or nothing elsewhere.
struct Pair {
  lock: PathBuf,
  watchdog: tokio::task::JoinHandle<()>,
}

impl Pair {
  /// Take this run mode's lock and start its watchdog; none when another copy already holds the lock,
  /// since the three anchors all fire at one logon and only the first copy is to run.
  fn start(role: Role, start: &Start) -> Option<Self> {
    let lock = PathBuf::from(Platform::Windows.lock_path(&start.env, role));
    if !pair::acquire_lock(&lock, std::process::id(), pair::pid_alive) {
      start.log.info(&format!("{}-already-running", role.name()), json!({}));
      return None;
    }
    let watchdog = Watchdog {
      role,
      install_dir: start.install_dir.to_string_lossy().into_owned(),
      env: start.env.clone(),
      tick: start.config.tick,
      stale: start.config.watchdog_stale,
      log: start.log.clone(),
    }
    .start();
    Some(Self { lock, watchdog })
  }

  fn stop(self) {
    self.watchdog.abort();
    pair::release_lock(&self.lock);
  }
}

async fn run_agent(start: Start) -> ExitCode {
  let pair = match Platform::HOST {
    Platform::Windows => match Pair::start(Role::Agent, &start) {
      Some(pair) => Some(pair),
      None => return ExitCode::SUCCESS,
    },
    // systemd is the supervisor; a run where it is not the init has none, and says so.
    Platform::Linux => {
      if let Some(reason) = platform::systemd_unavailable_reason(platform::systemd_runs_as_init()) {
        start.log.warn("no-persistence", json!({ "reason": reason }));
      }
      None
    }
  };

  let log = start.log.clone();
  log.info(
    "agent-starting",
    json!({ "hubUrl": start.config.hub_url, "agent": start.config.agent_name, "version": VERSION }),
  );
  let agent = Agent {
    config: start.config.clone(),
    version: VERSION.to_owned(),
    log: log.clone(),
  };
  // The tunnel ends only on a hub's leave; by then every run and transfer it carried has ended.
  let leave = tokio::select! {
    () = agent.run() => true,
    () = stop_requested() => false,
  };
  // The watchdog stops before anything is torn down, so it neither rewrites an anchor nor revives the guard.
  if let Some(pair) = pair {
    pair.stop();
  }
  if leave {
    departure::depart(Platform::HOST, &start.install_dir.to_string_lossy(), &start.env, &log).await;
  }
  log.info("agent-stopped", json!({ "left": leave }));
  ExitCode::SUCCESS
}

async fn run_guard(start: Start) -> ExitCode {
  let Some(pair) = Pair::start(Role::Guard, &start) else {
    return ExitCode::SUCCESS;
  };
  start.log.info(
    "guard-starting",
    json!({ "installDir": start.install_dir.to_string_lossy(), "version": VERSION }),
  );
  stop_requested().await;
  pair.stop();
  ExitCode::SUCCESS
}

async fn run_leave(start: Start) -> ExitCode {
  let agent = Agent {
    config: start.config,
    version: VERSION.to_owned(),
    log: start.log,
  };
  match agent.announce_leave().await {
    Ok(()) => {
      println!("the hub was told {} has left", agent.config.agent_name);
      ExitCode::SUCCESS
    }
    Err(error) => {
      eprintln!("jake: the hub was not told of the leave: {error}");
      ExitCode::FAILURE
    }
  }
}

fn main() -> ExitCode {
  let arguments: Vec<String> = std::env::args().skip(1).collect();
  let mode = if arguments.iter().any(|argument| argument == GUARD_MODE_FLAG) {
    Mode::Guard
  } else if arguments.iter().any(|argument| argument == LEAVE_FLAG) {
    Mode::Leave
  } else {
    Mode::Agent
  };
  let start = match start() {
    Ok(start) => start,
    Err(message) => {
      eprintln!("jake: {message}");
      return ExitCode::FAILURE;
    }
  };
  let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
    Ok(runtime) => runtime,
    Err(error) => {
      eprintln!("jake: cannot start: {error}");
      return ExitCode::FAILURE;
    }
  };
  runtime.block_on(async move {
    match mode {
      Mode::Agent => run_agent(start).await,
      Mode::Guard => run_guard(start).await,
      Mode::Leave => run_leave(start).await,
    }
  })
}
