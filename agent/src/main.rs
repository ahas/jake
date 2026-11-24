// The jake executable: the agent, the Windows guard or a one-shot mode, by its arguments.

// On Windows it opens no console, so no console's close or key can end it.
#![cfg_attr(windows, windows_subsystem = "windows")]

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use jake_agent::pair::{self, GUARD_MODE_FLAG, Watchdog};
use jake_agent::platform::{self, Platform, Role};
use jake_agent::uninstall::{self, Outcome, UNINSTALL_COMMAND, Voice};
use jake_agent::wsl::{self, HOLD_WSL_FLAG};
use jake_agent::{Agent, Ended, Log, VERSION, config, departure, instance, machine};
use serde_json::json;

/// The argument that has the executable tell the hub it was uninstalled, and exit.
const LEAVE_FLAG: &str = "--leave";
/// The argument that has the executable print the build it is, and exit.
const VERSION_FLAG: &str = "--version";
/// The argument that has the executable read this machine's fingerprint, ask the hub which agent holds it, print
/// both, and exit; the install runs it before it puts an agent on the machine (docs/install.md, 「One jake per
/// machine」).
const MACHINE_CHECK_FLAG: &str = "--machine-check";

/// What one start of the executable does, by its arguments.
#[derive(Debug, PartialEq, Eq)]
enum Invocation {
  Version,
  HoldWsl(String),
  Uninstall(uninstall::Options),
  Configured(Mode),
}

/// A run mode that reads the agent's config and log.
#[derive(Debug, PartialEq, Eq)]
enum Mode {
  Agent,
  Guard,
  Leave,
  MachineCheck,
}

/// The invocation the arguments name. Anything else is refused rather than run as the agent, since a
/// second agent under the installed one's name would displace its connection.
fn invocation(arguments: &[String]) -> Result<Invocation, String> {
  match arguments {
    [] => Ok(Invocation::Configured(Mode::Agent)),
    [flag] if flag == GUARD_MODE_FLAG => Ok(Invocation::Configured(Mode::Guard)),
    [flag] if flag == LEAVE_FLAG => Ok(Invocation::Configured(Mode::Leave)),
    [flag] if flag == MACHINE_CHECK_FLAG => Ok(Invocation::Configured(Mode::MachineCheck)),
    [flag] if flag == VERSION_FLAG => Ok(Invocation::Version),
    [flag, distribution] if flag == HOLD_WSL_FLAG && !distribution.is_empty() => {
      Ok(Invocation::HoldWsl(distribution.clone()))
    }
    [command, options @ ..] if command == UNINSTALL_COMMAND => {
      uninstall::Options::parse(options).map(Invocation::Uninstall)
    }
    _ => Err(format!(
      "unknown arguments {arguments:?}; run with none for the agent, or with {GUARD_MODE_FLAG}, {LEAVE_FLAG}, \
       {MACHINE_CHECK_FLAG}, {VERSION_FLAG}, {HOLD_WSL_FLAG} <distribution> or {UNINSTALL_COMMAND} \
       [--name <agent>] [--yes] [--remove-config]"
    )),
  }
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

impl Start {
  /// The install's instance, kept in its data directory, so the leave notice says hello as the agent does
  /// (docs/architecture.md, 「The agent's connection」).
  fn instance(&self) -> String {
    let path = PathBuf::from(Platform::HOST.join(&Platform::HOST.data_dir(&self.env), &["instance"]));
    let (id, unkept) = instance::kept_at(&path);
    if let Some(reason) = unkept {
      self.log.warn("instance-not-kept", json!({ "reason": reason }));
    }
    id
  }

  /// This machine's fingerprint, kept in the data directory where reading it starts a Windows program
  /// (docs/architecture.md, 「The machine's fingerprint」).
  fn machine(&self) -> Option<String> {
    let path = PathBuf::from(Platform::HOST.join(&Platform::HOST.data_dir(&self.env), &["machine"]));
    let reading = machine::fingerprint(&path);
    if let Some(reason) = reading.unkept {
      self.log.warn("machine-not-kept", json!({ "reason": reason }));
    }
    if reading.fingerprint.is_none() {
      self.log.warn("machine-unread", json!({ "reason": "no machine id could be read" }));
    }
    reading.fingerprint
  }
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
  let agent = Agent::new(start.config.clone(), VERSION.to_owned(), log.clone())
    .instance(start.instance())
    .machine(start.machine());
  // The tunnel ends only on a hub's leave; by then every run and transfer it carried has ended.
  let leave = jake_agent::run(&agent, stop_requested(&log)).await == Ended::Left;
  // The watchdog stops before anything is torn down, so it neither rewrites an anchor nor revives the guard.
  if let Some(pair) = pair {
    pair.stop().await;
  }
  if leave {
    departure::depart(
      Platform::HOST,
      &start.install_dir.to_string_lossy(),
      &start.config.agent_name,
      &start.env,
      &log,
    )
    .await;
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
  // The notice names no machine, so it is never refused for one another agent holds.
  let instance = start.instance();
  let agent = Agent::new(start.config, VERSION.to_owned(), start.log).instance(instance);
  match uninstall::announce(&agent).await {
    Ok(line) => {
      println!("{line}");
      ExitCode::SUCCESS
    }
    Err(reason) => {
      eprintln!("jake: {reason}");
      ExitCode::FAILURE
    }
  }
}

/// Print this machine's fingerprint and which attached agent the hub says holds it, one `name=value` line each:
/// `machine`, then `hub` as `answered` or `unanswered` with why, then `held-by` where an agent holds it.
async fn run_machine_check(start: Start) -> ExitCode {
  let machine = start.machine();
  let agent = Agent::new(start.config, VERSION.to_owned(), start.log).machine(machine.clone());
  println!("machine={}", machine.unwrap_or_default());
  match agent.machine_held_by().await {
    Ok(holder) => {
      println!("hub=answered");
      if let Some(holder) = holder {
        println!("held-by={holder}");
      }
    }
    Err(reason) => println!("hub=unanswered {reason}"),
  }
  ExitCode::SUCCESS
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
  match runtime() {
    Ok(runtime) => {
      runtime.block_on(wsl::hold(distribution));
      ExitCode::SUCCESS
    }
    Err(code) => code,
  }
}

/// The uninstall's voice on a Linux host: each step on standard output, a question answered on standard input.
#[cfg(not(windows))]
struct Console;

#[cfg(not(windows))]
impl Voice for Console {
  fn step(&mut self, line: &str) {
    println!("· {line}");
  }

  fn warn(&mut self, line: &str) {
    println!("  ! {line}");
  }

  fn confirm(&mut self, question: &str) -> bool {
    use std::io::Write as _;
    print!("{question} [y/N] ");
    let _ = std::io::stdout().flush();
    let mut answer = String::new();
    let read = std::io::stdin().read_line(&mut answer).unwrap_or(0);
    if read == 0 {
      println!();
    }
    matches!(answer.trim().to_lowercase().as_str(), "y" | "yes")
  }
}

#[cfg(not(windows))]
impl Console {
  /// The outcome is already on standard output and standard error.
  #[allow(clippy::unused_self)]
  fn finish(&mut self, _outcome: &str, _failed: bool) {}
}

/// The uninstall's voice on Windows, where the executable opens no console: each step on standard output
/// for a caller that reads it, a question asked in a dialog, and the outcome shown in a dialog as well where
/// the person was asked or nothing reads the output.
#[cfg(windows)]
struct Console {
  asked: bool,
}

#[cfg(windows)]
impl Console {
  fn dialog(text: &str, style: u32) -> i32 {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MB_SETFOREGROUND, MB_TOPMOST, MessageBoxW};
    let wide = |text: &str| text.encode_utf16().chain([0]).collect::<Vec<u16>>();
    let (text, caption) = (wide(text), wide("jake uninstall"));
    // SAFETY: both strings are NUL-terminated UTF-16 that outlive the call, and no owner window is named.
    unsafe {
      MessageBoxW(
        std::ptr::null_mut(),
        text.as_ptr(),
        caption.as_ptr(),
        style | MB_SETFOREGROUND | MB_TOPMOST,
      )
    }
  }

  /// Whether anything reads this process's standard output: a caller that started it with its output taken.
  fn output_read() -> bool {
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::System::Console::{GetStdHandle, STD_OUTPUT_HANDLE};
    // SAFETY: GetStdHandle only reads this process's standard handle.
    let handle = unsafe { GetStdHandle(STD_OUTPUT_HANDLE) };
    !handle.is_null() && handle != INVALID_HANDLE_VALUE
  }
}

#[cfg(windows)]
impl Voice for Console {
  fn step(&mut self, line: &str) {
    println!("· {line}");
  }

  fn warn(&mut self, line: &str) {
    println!("  ! {line}");
  }

  fn confirm(&mut self, question: &str) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{IDYES, MB_DEFBUTTON2, MB_ICONWARNING, MB_YESNO};
    self.asked = true;
    Self::dialog(question, MB_YESNO | MB_ICONWARNING | MB_DEFBUTTON2) == IDYES
  }
}

#[cfg(windows)]
impl Console {
  fn finish(&mut self, outcome: &str, failed: bool) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MB_ICONERROR, MB_ICONINFORMATION, MB_OK};
    if self.asked || !Self::output_read() {
      Self::dialog(outcome, MB_OK | if failed { MB_ICONERROR } else { MB_ICONINFORMATION });
    }
  }
}

/// Remove the install this executable belongs to, as docs/architecture.md 「The uninstaller」 states: 0 once
/// removed, 1 where refused or not confirmed.
fn run_uninstall(options: &uninstall::Options) -> ExitCode {
  let install_dir = match std::env::current_exe() {
    Ok(exe) => exe.parent().map_or_else(|| PathBuf::from("."), Path::to_path_buf),
    Err(error) => {
      eprintln!("jake: cannot find this executable: {error}");
      return ExitCode::FAILURE;
    }
  };
  let runtime = match runtime() {
    Ok(runtime) => runtime,
    Err(code) => return code,
  };
  #[cfg(windows)]
  let mut console = Console { asked: false };
  #[cfg(not(windows))]
  let mut console = Console;
  println!("jake agent uninstaller");
  let outcome = runtime.block_on(uninstall::uninstall(
    Platform::HOST,
    &install_dir,
    std::env::vars().collect(),
    options,
    &mut console,
  ));
  match outcome {
    Outcome::Removed { name, kept: None } => {
      let said = format!("Removed {name}. Nothing is left behind.");
      println!("\n{said}");
      console.finish(&said, false);
      ExitCode::SUCCESS
    }
    Outcome::Removed {
      name,
      kept: Some((config, log)),
    } => {
      let said = format!(
        "Removed {name}. Its config is kept at {config} and the log at {log}; uninstall with --remove-config to \
         delete those too."
      );
      println!("\n{said}");
      console.finish(&said, false);
      ExitCode::SUCCESS
    }
    Outcome::Refused(reason) | Outcome::Declined(reason) => {
      eprintln!("jake: {reason}");
      console.finish(&reason, true);
      ExitCode::FAILURE
    }
  }
}

fn main() -> ExitCode {
  let arguments: Vec<String> = std::env::args().skip(1).collect();
  match invocation(&arguments) {
    Ok(Invocation::Version) => {
      println!("{VERSION}");
      ExitCode::SUCCESS
    }
    Ok(Invocation::HoldWsl(distribution)) => hold_wsl(&distribution),
    Ok(Invocation::Uninstall(options)) => run_uninstall(&options),
    Ok(Invocation::Configured(mode)) => run_configured(mode),
    Err(message) => {
      eprintln!("jake: {message}");
      ExitCode::from(2)
    }
  }
}

fn run_configured(mode: Mode) -> ExitCode {
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
      Mode::MachineCheck => run_machine_check(start).await,
    }
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  fn invoked(arguments: &[&str]) -> Result<Invocation, String> {
    invocation(&arguments.iter().map(|argument| (*argument).to_owned()).collect::<Vec<_>>())
  }

  #[test]
  fn each_run_mode_is_named_by_its_own_arguments_alone() {
    assert_eq!(invoked(&[]), Ok(Invocation::Configured(Mode::Agent)));
    assert_eq!(invoked(&["--guard"]), Ok(Invocation::Configured(Mode::Guard)));
    assert_eq!(invoked(&["--leave"]), Ok(Invocation::Configured(Mode::Leave)));
    assert_eq!(invoked(&["--machine-check"]), Ok(Invocation::Configured(Mode::MachineCheck)));
    assert_eq!(invoked(&["--version"]), Ok(Invocation::Version));
    assert_eq!(
      invoked(&["--hold-wsl", "Ubuntu-24.04"]),
      Ok(Invocation::HoldWsl("Ubuntu-24.04".to_owned()))
    );
    assert_eq!(invoked(&["uninstall"]), Ok(Invocation::Uninstall(uninstall::Options::default())));
    assert_eq!(
      invoked(&["uninstall", "--name", "u63", "--yes"]),
      Ok(Invocation::Uninstall(uninstall::Options {
        name: Some("u63".to_owned()),
        yes: true,
        remove_config: false
      }))
    );
  }

  #[test]
  fn anything_else_is_refused_rather_than_run_as_a_second_agent() {
    for arguments in [
      &["status"][..],
      &["--hold-wsl"],
      &["--hold-wsl", ""],
      &["--guard", "--leave"],
      &["uninstall", "--force"],
      &["--yes", "uninstall"],
    ] {
      assert!(invoked(arguments).is_err(), "{arguments:?}");
    }
  }
}
