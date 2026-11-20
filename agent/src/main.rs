// The jake executable: the agent, the Windows guard, a leave notice or a WSL hold, by its argument.

// On Windows it opens no console, so no console's close or key can end it.
#![cfg_attr(windows, windows_subsystem = "windows")]

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use jake_agent::pair::{self, GUARD_MODE_FLAG, Watchdog};
use jake_agent::platform::{self, Platform, Role};
use jake_agent::wsl::{self, HOLD_WSL_FLAG};
use jake_agent::{Agent, Ended, LeaveNotice, Log, VERSION, config, departure};
use serde_json::json;

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

/// Resolves when the process is asked to stop, by an interrupt or a termination signal.
#[cfg(unix)]
async fn stop_requested(_log: &Log) {
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

/// Resolves when the process is asked to stop, by a console event that ends it anyway; the log takes
/// every console event it is sent.
#[cfg(windows)]
async fn stop_requested(log: &Log) {
  jake_agent::console::stop_requested(log.clone()).await;
}

/// The lock and watchdog that keep one copy of a Windows run mode alive, or nothing elsewhere.
struct Pair {
  lock: PathBuf,
  watchdog: pair::Running,
}

impl Pair {
  /// Take this run mode's lock and start its watchdog; none when another copy already holds the lock,
  /// since the three anchors all fire at one logon and the task's repeating trigger fires while it
  /// runs, and only the first copy is to run. A copy that finds the lock held exits writing nothing, so
  /// the repeating trigger adds no line to the log.
  fn start(role: Role, start: &Start) -> Option<Self> {
    let lock = PathBuf::from(Platform::Windows.lock_path(&start.env, role));
    if !pair::acquire_lock(&lock, std::process::id(), |pid| pair::lock_holder(pid).holds()) {
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

  async fn stop(self) {
    self.watchdog.stop().await;
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
  let agent = Agent::new(start.config.clone(), VERSION.to_owned(), log.clone());
  // The tunnel ends only on a hub's leave; by then every run and transfer it carried has ended.
  let leave = jake_agent::run(&agent, stop_requested(&log)).await == Ended::Left;
  // The watchdog stops before anything is torn down, so it neither rewrites an anchor nor revives the guard.
  if let Some(pair) = pair {
    pair.stop().await;
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
  stop_requested(&start.log).await;
  pair.stop().await;
  ExitCode::SUCCESS
}

async fn run_leave(start: Start) -> ExitCode {
  let agent = Agent::new(start.config, VERSION.to_owned(), start.log);
  match agent.announce_leave().await {
    Ok(LeaveNotice::Sent) => {
      println!("the hub was told {} has left", agent.config.agent_name);
      ExitCode::SUCCESS
    }
    Ok(LeaveNotice::AlreadyRecorded) => {
      println!("the hub had already recorded {} as left: its name is revoked", agent.config.agent_name);
      ExitCode::SUCCESS
    }
    Err(error) => {
      eprintln!("jake: the hub was not told of the leave: {error}");
      ExitCode::FAILURE
    }
  }
}

fn runtime() -> Result<tokio::runtime::Runtime, ExitCode> {
  tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|error| {
    eprintln!("jake: cannot start: {error}");
    ExitCode::FAILURE
  })
}

/// Hold a WSL distribution running, which needs neither the agent's config nor its log: a WSL
/// install's task runs it where Windows refuses that task a session of its own with no logon.
fn hold_wsl(distribution: &str) -> ExitCode {
  if Platform::HOST != Platform::Windows {
    eprintln!("jake: {HOLD_WSL_FLAG} holds a WSL distribution from Windows, and this is not Windows");
    return ExitCode::FAILURE;
  }
  if distribution.is_empty() {
    eprintln!("jake: {HOLD_WSL_FLAG} takes the name of the distribution to hold");
    return ExitCode::FAILURE;
  }
  match runtime() {
    Ok(runtime) => {
      runtime.block_on(wsl::hold(distribution));
      ExitCode::SUCCESS
    }
    Err(code) => code,
  }
}

fn main() -> ExitCode {
  let arguments: Vec<String> = std::env::args().skip(1).collect();
  if let Some(at) = arguments.iter().position(|argument| argument == HOLD_WSL_FLAG) {
    return hold_wsl(arguments.get(at + 1).map_or("", String::as_str));
  }
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
  let runtime = match runtime() {
    Ok(runtime) => runtime,
    Err(code) => return code,
  };
  runtime.block_on(async move {
    match mode {
      Mode::Agent => run_agent(start).await,
      Mode::Guard => run_guard(start).await,
      Mode::Leave => run_leave(start).await,
    }
  })
}
