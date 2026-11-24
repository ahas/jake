// The Windows self-healing pair: the autostart anchors, the single-instance lock and the watchdog.

use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write as _;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::json;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use tokio::time::{Instant, MissedTickBehavior, interval_at};

use crate::command::Unanswered;
use crate::exec::{encode_powershell_script, tree_kill_command};
use crate::log::Log;
use crate::platform::{Platform, Role, startup_dir};

// The pair is two processes of one executable: the agent runs it with no argument, the guard with the
// guard-mode flag. Each watches the other by heartbeat, and either alone brings the other back.
pub const JAKE_BINARY: &str = "jake.exe";
pub const GUARD_MODE_FLAG: &str = "--guard";

// One name serves as the registry value name, the scheduled-task name and the Startup shortcut's base
// name, so an anchor of any kind is found, rewritten and removed by the same key.
pub const AGENT_ANCHOR_NAME: &str = "JakeAgent";
pub const GUARD_ANCHOR_NAME: &str = "JakeGuard";

// The per-user Run key: HKCU needs no elevation, and explorer launches its values at this user's logon.
const RUN_KEY: &str = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

/// One run mode to anchor: the name it is registered under, the executable and its arguments.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AnchorTarget {
  pub name: &'static str,
  pub binary_path: String,
  pub args: Vec<String>,
}

/// The two anchor targets of an install in one directory: the agent and guard run modes of one exe.
pub fn install_targets(dir: &str) -> [AnchorTarget; 2] {
  let binary_path = Platform::Windows.join(dir, &[JAKE_BINARY]);
  [
    AnchorTarget {
      name: AGENT_ANCHOR_NAME,
      binary_path: binary_path.clone(),
      args: Vec::new(),
    },
    AnchorTarget {
      name: GUARD_ANCHOR_NAME,
      binary_path,
      args: vec![GUARD_MODE_FLAG.to_owned()],
    },
  ]
}

/// The anchor name a role is registered and relaunched under.
pub fn anchor_name(role: Role) -> &'static str {
  match role {
    Role::Agent => AGENT_ANCHOR_NAME,
    Role::Guard => GUARD_ANCHOR_NAME,
  }
}

// The quoted executable path followed by the run mode's arguments, so a path with spaces is one word.
fn invocation(target: &AnchorTarget) -> String {
  let quoted = format!("\"{}\"", target.binary_path);
  if target.args.is_empty() {
    quoted
  } else {
    format!("{quoted} {}", target.args.join(" "))
  }
}

/// A string as a PowerShell single-quoted literal, any single quote inside it doubled.
pub fn ps_single_quote(value: &str) -> String {
  format!("'{}'", value.replace('\'', "''"))
}

/// PowerShell run unattended — no profile, no prompt, the policy bypassed — with the script encoded.
pub fn powershell_command(script: &str) -> Vec<String> {
  [
    "powershell.exe",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
  ]
  .into_iter()
  .map(str::to_owned)
  .chain([encode_powershell_script(script)])
  .collect()
}

fn owned(parts: &[&str]) -> Vec<String> {
  parts.iter().map(|part| (*part).to_owned()).collect()
}

/// Add, or overwrite in place, the per-user Run value that launches this run mode at logon.
pub fn run_key_add_command(target: &AnchorTarget) -> Vec<String> {
  owned(&[
    "reg",
    "add",
    RUN_KEY,
    "/v",
    target.name,
    "/t",
    "REG_SZ",
    "/d",
    &invocation(target),
    "/f",
  ])
}

pub fn run_key_remove_command(target: &AnchorTarget) -> Vec<String> {
  owned(&["reg", "delete", RUN_KEY, "/v", target.name, "/f"])
}

/// How often the task's repeating trigger starts its run mode, so Task Scheduler itself brings back a
/// pair that died together while this user stays logged on. A start while the run mode runs is
/// dropped: by Task Scheduler where the task's own copy runs, by the lock where another anchor's does.
pub const TASK_REPEAT_MINUTES: u32 = 5;
/// How many times, and how far apart, Task Scheduler starts the task again after a run it counts as
/// failed; the repeating trigger covers an end it does not count.
pub const TASK_RESTART_COUNT: u32 = 3;
pub const TASK_RESTART_MINUTES: u32 = 1;

/// A whole number of minutes as Task Scheduler writes a duration.
fn task_minutes(minutes: u32) -> String {
  format!("PT{minutes}M")
}

/// Create, or overwrite in place, the task for this run mode, with the settings the installer
/// registers it with. It starts at logon and on a trigger repeating from registration on with no end,
/// and is started again after a failed run. It stores no credential and runs non-elevated; a boot
/// trigger or a task that runs logged off would need an administrator. It starts and keeps running on
/// battery and has no run-time limit, since Task Scheduler's default of three days would end both run
/// modes together; `schtasks /create` cannot set those, so the task is registered through PowerShell.
pub fn task_create_command(target: &AnchorTarget) -> Vec<String> {
  let mut action = format!("New-ScheduledTaskAction -Execute {}", ps_single_quote(&target.binary_path));
  if !target.args.is_empty() {
    action.push_str(&format!(" -Argument {}", ps_single_quote(&target.args.join(" "))));
  }
  let lines = [
    format!("$action = {action}"),
    "$logon = New-ScheduledTaskTrigger -AtLogOn".to_owned(),
    format!(
      "$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes \
       {TASK_REPEAT_MINUTES})"
    ),
    format!(
      "$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries \
       -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount {TASK_RESTART_COUNT} \
       -RestartInterval (New-TimeSpan -Minutes {TASK_RESTART_MINUTES})"
    ),
    "$principal = New-ScheduledTaskPrincipal -UserId \"$env:USERDOMAIN\\$env:USERNAME\" -LogonType Interactive \
     -RunLevel Limited"
      .to_owned(),
    format!(
      "Register-ScheduledTask -TaskName {} -Action $action -Trigger @($logon, $repeat) -Settings $settings \
       -Principal $principal -Force | Out-Null",
      ps_single_quote(target.name)
    ),
  ];
  powershell_command(&lines.join("\n"))
}

/// Print the definition Task Scheduler holds for this run mode's task, as XML; it fails where the task
/// is absent. A plain query, so a tick that finds the task as it must be starts no PowerShell.
pub fn task_query_command(target: &AnchorTarget) -> Vec<String> {
  owned(&["schtasks", "/query", "/tn", target.name, "/xml"])
}

/// The text `schtasks` printed. Into a pipe it prints single-byte text whatever encoding its XML
/// declaration names; it is read as UTF-8, a byte that is not replaced, so a path outside ASCII reads
/// as another and the task is merely registered again. UTF-16, told by a byte order mark or by the zero
/// high byte of the first character, is read as such.
pub fn query_text(bytes: &[u8]) -> String {
  let utf16 = bytes.starts_with(&[0xFF, 0xFE]) || bytes.get(1) == Some(&0);
  let text = if utf16 {
    let units: Vec<u16> = bytes.as_chunks::<2>().0.iter().map(|pair| u16::from_le_bytes(*pair)).collect();
    String::from_utf16_lossy(&units)
  } else {
    String::from_utf8_lossy(bytes).into_owned()
  };
  text.trim_start_matches('\u{FEFF}').to_owned()
}

/// Whether a task definition, as `schtasks /query /xml` prints it, is the one `task_create_command`
/// registers for this run mode: an enabled logon trigger and an enabled trigger repeating at the
/// interval with no end, the action that runs this run mode, the restarts after a failed run, no
/// run-time limit, and starting, and running on, battery. An element left out holds Task Scheduler's
/// default, and a definition that cannot be read is not the one.
pub fn task_definition_holds(xml: &str, target: &AnchorTarget) -> bool {
  let Ok(document) = roxmltree::Document::parse(xml) else {
    return false;
  };
  let task = document.root_element();
  let Some(settings) = child(task, "Settings") else {
    return false;
  };
  let triggers = child(task, "Triggers");
  let logon_trigger = triggers.and_then(|triggers| child(triggers, "LogonTrigger"));
  let time_trigger = triggers.and_then(|triggers| child(triggers, "TimeTrigger"));
  let repetition = time_trigger.and_then(|trigger| child(trigger, "Repetition"));
  let restart = child(settings, "RestartOnFailure");
  let exec = child(task, "Actions").and_then(|actions| child(actions, "Exec"));
  let command = text(exec.and_then(|exec| child(exec, "Command")), "");
  let arguments = text(exec.and_then(|exec| child(exec, "Arguments")), "");
  logon_trigger.is_some_and(enabled)
    && time_trigger.is_some_and(enabled)
    && text(repetition.and_then(|repetition| child(repetition, "Interval")), "")
      == task_minutes(TASK_REPEAT_MINUTES)
    && text(repetition.and_then(|repetition| child(repetition, "Duration")), "").is_empty()
    && command.trim_matches('"').eq_ignore_ascii_case(&target.binary_path)
    && arguments == target.args.join(" ")
    && text(restart.and_then(|restart| child(restart, "Count")), "") == TASK_RESTART_COUNT.to_string()
    && text(restart.and_then(|restart| child(restart, "Interval")), "")
      == task_minutes(TASK_RESTART_MINUTES)
    && text(child(settings, "ExecutionTimeLimit"), "PT72H") == "PT0S"
    && text(child(settings, "DisallowStartIfOnBatteries"), "true") == "false"
    && text(child(settings, "StopIfGoingOnBatteries"), "true") == "false"
    && text(child(settings, "StartWhenAvailable"), "false") == "true"
}

/// Whether a trigger fires: one with no `Enabled` element does.
fn enabled(trigger: roxmltree::Node<'_, '_>) -> bool {
  text(child(trigger, "Enabled"), "true") == "true"
}

/// The child element of a task definition's element with the given name, whatever its namespace.
fn child<'a, 'input>(node: roxmltree::Node<'a, 'input>, name: &str) -> Option<roxmltree::Node<'a, 'input>> {
  node.children().find(|child| child.is_element() && child.tag_name().name() == name)
}

/// An element's text, or the default an absent element stands for.
fn text(node: Option<roxmltree::Node<'_, '_>>, default: &str) -> String {
  node.map_or(default.to_owned(), |node| node.text().unwrap_or_default().trim().to_owned())
}

/// The command that registers this run mode's task, where the definition Task Scheduler holds for it
/// (none where the task is absent) is not the one it must hold; none where it is.
pub fn task_refresh_command(target: &AnchorTarget, held: Option<&str>) -> Option<Vec<String>> {
  if held.is_some_and(|xml| task_definition_holds(xml, target)) {
    None
  } else {
    Some(task_create_command(target))
  }
}

pub fn task_remove_command(target: &AnchorTarget) -> Vec<String> {
  owned(&["schtasks", "/delete", "/tn", target.name, "/f"])
}

/// Run a registered task now. Task Scheduler starts it on the caller's behalf, so what it starts is
/// not the caller's child and shares no teardown boundary with it.
pub fn task_run_command(name: &str) -> Vec<String> {
  owned(&["schtasks", "/run", "/tn", name])
}

/// This run mode's shortcut in the per-user Startup folder.
pub fn startup_shortcut_path(target: &AnchorTarget, env: &HashMap<String, String>) -> String {
  Platform::Windows.join(&startup_dir(env), &[&format!("{}.lnk", target.name)])
}

/// Create, or overwrite, the Startup shortcut. A `.lnk` is not plain bytes, so it is built through the
/// WScript.Shell COM object, every path crossing as a single-quoted literal.
pub fn startup_shortcut_create_command(
  target: &AnchorTarget,
  env: &HashMap<String, String>,
) -> Vec<String> {
  let directory = target.binary_path.rsplit_once('\\').map_or("", |(directory, _)| directory);
  let mut lines = vec![
    format!(
      "$s = (New-Object -ComObject WScript.Shell).CreateShortcut({})",
      ps_single_quote(&startup_shortcut_path(target, env))
    ),
    format!("$s.TargetPath = {}", ps_single_quote(&target.binary_path)),
    format!("$s.WorkingDirectory = {}", ps_single_quote(directory)),
  ];
  if !target.args.is_empty() {
    lines.push(format!("$s.Arguments = {}", ps_single_quote(&target.args.join(" "))));
  }
  lines.push("$s.Save()".to_owned());
  powershell_command(&lines.join("\n"))
}

/// Remove the Startup shortcut; one that is already gone is not an error.
pub fn startup_shortcut_remove_command(
  target: &AnchorTarget,
  env: &HashMap<String, String>,
) -> Vec<String> {
  let lnk = ps_single_quote(&startup_shortcut_path(target, env));
  powershell_command(&format!("Remove-Item -LiteralPath {lnk} -Force -ErrorAction SilentlyContinue"))
}

/// Every command that removes all three anchors of one run mode.
pub fn anchor_remove_commands(target: &AnchorTarget, env: &HashMap<String, String>) -> [Vec<String>; 3] {
  [
    run_key_remove_command(target),
    task_remove_command(target),
    startup_shortcut_remove_command(target, env),
  ]
}

// --- The single-instance lock ----------------------------------------------------------------------

/// Try to become the one running copy of a run mode. The lock is a file created exclusively — the OS
/// lets exactly one create win — holding the holder's id; a lock whose holder is gone is reclaimed
/// once, so two copies racing over a stale lock cannot loop.
pub fn acquire_lock(path: &Path, pid: u32, alive: impl Fn(u32) -> bool) -> bool {
  if create_exclusive(path, pid) {
    return true;
  }
  let holder = fs::read_to_string(path).ok().and_then(|text| text.trim().parse::<u32>().ok());
  if holder.is_some_and(alive) {
    return false;
  }
  let _ = fs::remove_file(path);
  create_exclusive(path, pid)
}

fn create_exclusive(path: &Path, pid: u32) -> bool {
  if let Some(parent) = path.parent() {
    let _ = fs::create_dir_all(parent);
  }
  match OpenOptions::new().write(true).create_new(true).open(path) {
    Ok(mut file) => file.write_all(pid.to_string().as_bytes()).is_ok(),
    Err(_) => false,
  }
}

/// Give the lock up on a clean exit; a crash leaves it for the next copy's liveness check.
pub fn release_lock(path: &Path) {
  let _ = fs::remove_file(path);
}

/// The process id a lock or heartbeat file holds, if it holds one.
pub fn read_number(path: &Path) -> Option<u64> {
  fs::read_to_string(path).ok().and_then(|text| text.trim().parse().ok())
}

/// What runs under the process id a lock holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Holder {
  /// Nothing does, or another program that took the id over once the holder had ended.
  Gone,
  /// A copy of this executable.
  Jake,
  /// Something runs that cannot be told apart, so the lock is never stolen from it nor is it ended.
  Unknown,
}

impl Holder {
  /// Whether the lock is still held: by anything but a holder that is gone.
  pub fn holds(self) -> bool {
    self != Self::Gone
  }
}

/// What runs under a process id. A Linux host runs no pair, so there a living process is not told
/// apart from another program.
#[cfg(unix)]
pub fn lock_holder(pid: u32) -> Holder {
  let Ok(pid) = libc::pid_t::try_from(pid) else { return Holder::Unknown };
  // SAFETY: signal 0 only asks whether the process exists; nothing is delivered.
  if unsafe { libc::kill(pid, 0) } == 0 {
    return Holder::Unknown;
  }
  if std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
    Holder::Gone
  } else {
    Holder::Unknown
  }
}

#[cfg(windows)]
pub fn lock_holder(pid: u32) -> Holder {
  match process_image(pid) {
    ProcessImage::Gone => Holder::Gone,
    ProcessImage::Unreadable => Holder::Unknown,
    ProcessImage::Path(path) => {
      let named = path.file_name().and_then(|name| name.to_str());
      if named.is_some_and(|name| name.eq_ignore_ascii_case(JAKE_BINARY)) {
        Holder::Jake
      } else {
        Holder::Gone
      }
    }
  }
}

/// The executable a running process was started from, as far as this user may read it.
#[cfg(windows)]
pub enum ProcessImage {
  Gone,
  Unreadable,
  Path(std::path::PathBuf),
}

#[cfg(windows)]
pub fn process_image(pid: u32) -> ProcessImage {
  use std::os::windows::ffi::OsStringExt as _;
  use windows_sys::Win32::Foundation::{CloseHandle, ERROR_INVALID_PARAMETER, GetLastError, STILL_ACTIVE};
  use windows_sys::Win32::System::Threading::{
    GetExitCodeProcess, OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    QueryFullProcessImageNameW,
  };
  let mut path = vec![0u16; 32 * 1024];
  let mut length = u32::try_from(path.len()).unwrap_or(u32::MAX);
  // SAFETY: the handle is checked before use and closed once read; the buffer's length is passed
  // with it and the call writes at most that many units, reporting how many it wrote.
  let read = unsafe {
    let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
    if handle.is_null() {
      return if GetLastError() == ERROR_INVALID_PARAMETER {
        ProcessImage::Gone
      } else {
        ProcessImage::Unreadable
      };
    }
    let mut code = 0u32;
    let running = GetExitCodeProcess(handle, &mut code) == 0 || code == STILL_ACTIVE as u32;
    let named = running
      && QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, path.as_mut_ptr(), &mut length) != 0;
    CloseHandle(handle);
    if !running {
      return ProcessImage::Gone;
    }
    named
  };
  if !read {
    return ProcessImage::Unreadable;
  }
  path.truncate(usize::try_from(length).unwrap_or(0));
  ProcessImage::Path(std::path::PathBuf::from(std::ffi::OsString::from_wide(&path)))
}

// --- The watchdog ----------------------------------------------------------------------------------

/// Start a helper command and leave it to run; anchor rewrites and relaunches are quick and their
/// output is not needed.
fn launch(argv: &[String]) {
  if let Some(mut command) = crate::command::quiet(argv) {
    let _ = command.spawn();
  }
}

/// How long a tick waits on Task Scheduler to print a task's definition, and on a hung peer's tree to
/// be ended before its task is run again.
const HELPER_WITHIN: Duration = Duration::from_secs(10);

/// How long a stop waits for the watchdog's thread to end what it was doing.
const STOP_WITHIN: Duration = Duration::from_secs(15);

/// How long a registration of a task is waited on before it is ended.
const REGISTER_WITHIN: Duration = Duration::from_secs(60);

/// The command that registers this run mode's task, from what its query answered: none where the query
/// said nothing, since a query that does not answer tells nothing of the task; the registration where
/// the query failed, the task being absent; and as `task_refresh_command` says where it printed a
/// definition.
pub fn task_refresh_after(
  target: &AnchorTarget,
  queried: Result<Vec<u8>, Unanswered>,
) -> Option<Vec<String>> {
  match queried {
    Ok(bytes) => task_refresh_command(target, Some(&query_text(&bytes))),
    Err(Unanswered::Failed(_)) => task_refresh_command(target, None),
    Err(Unanswered::Silent(_)) => None,
  }
}

/// The tasks whose refresh stands, so a tick starts none for a task whose refresh before has not ended.
#[derive(Clone, Default)]
pub struct Refreshing(Arc<Mutex<HashSet<&'static str>>>);

/// A refresh standing for one task, which lets the task go when dropped.
pub struct Refresh {
  refreshing: Refreshing,
  name: &'static str,
}

impl Refreshing {
  /// A refresh of the task `name`, or none where one stands already.
  pub fn begin(&self, name: &'static str) -> Option<Refresh> {
    let mut names = self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    names.insert(name).then(|| Refresh {
      refreshing: self.clone(),
      name,
    })
  }
}

impl Drop for Refresh {
  fn drop(&mut self) {
    let mut names = self.refreshing.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    names.remove(self.name);
  }
}

/// Read the run mode's task back and register it again only where the query answers that it is absent
/// or not as it must be, so a tick that finds it in order starts nothing but the query. The registration
/// is waited on within its bound and ended there, and the refresh holds its task until then.
async fn refresh_task(target: AnchorTarget, refresh: Refresh) {
  let queried = crate::command::output(&task_query_command(&target), HELPER_WITHIN).await;
  if let Some(command) = task_refresh_after(&target, queried) {
    let _ = crate::command::finish(&command, REGISTER_WITHIN).await;
  }
  drop(refresh);
}

fn epoch_ms() -> u64 {
  SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |since| since.as_millis() as u64)
}

/// Whether a peer last seen at `seen` reads as dead at `now`: a missing heartbeat does, and so does
/// one older than `stale`, so a hung peer that never exited is brought back like a crashed one.
pub fn peer_stale(now: u64, seen: Option<u64>, stale: Duration) -> bool {
  seen.is_none_or(|seen| now.saturating_sub(seen) > stale.as_millis() as u64)
}

/// Since when the watchdog has ticked without a break. A gap of more than two ticks, or a clock set
/// back, means it was not running itself, as when the machine slept or stalled, and it starts over.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Watching {
  pub since: u64,
  last: u64,
}

impl Watching {
  pub fn new(now: u64) -> Self {
    Self {
      since: now,
      last: now,
    }
  }

  /// Take one tick at `now`, the ticks meant to come `tick` apart.
  pub fn tick(&mut self, now: u64, tick: Duration) {
    let gap_allowed = 2 * tick.as_millis() as u64;
    if now < self.last || now - self.last > gap_allowed {
      self.since = now;
    }
    self.last = now;
  }
}

/// What a tick does about its peer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PeerAction {
  /// Its heartbeat is fresh.
  Leave,
  /// Run its task: it is gone, or this watchdog has not watched it long enough to judge it hung.
  Relaunch,
  /// End the hung copy holding its lock, whole tree, then run its task, which the hung copy's task
  /// instance and lock would otherwise drop.
  EndAndRelaunch(u32),
}

/// What to do about a peer last seen at `seen`, whose lock `holder` names a running copy of this
/// executable or nothing. A copy is ended only once this watchdog has itself ticked without a break
/// for longer than `stale`, so a stall both processes shared, a sleep of the machine among them, is
/// never read as the peer hanging alone, and the two never end each other.
pub fn peer_action(
  now: u64,
  seen: Option<u64>,
  stale: Duration,
  watching: Watching,
  holder: Option<u32>,
) -> PeerAction {
  if !peer_stale(now, seen, stale) {
    return PeerAction::Leave;
  }
  match holder {
    Some(pid) if now.saturating_sub(watching.since) > stale.as_millis() as u64 => {
      PeerAction::EndAndRelaunch(pid)
    }
    _ => PeerAction::Relaunch,
  }
}

/// The last moment the process's own runtime ran, stamped from that runtime and read by the
/// watchdog's thread, so the heartbeat it writes goes stale when the runtime that carries the tunnel
/// hangs, while what the watchdog runs never holds that runtime up.
#[derive(Clone)]
struct Pulse(Arc<AtomicU64>);

impl Pulse {
  fn new() -> Self {
    Self(Arc::new(AtomicU64::new(epoch_ms())))
  }

  fn beat(&self) {
    self.0.store(epoch_ms(), Ordering::Relaxed);
  }

  fn last(&self) -> u64 {
    self.0.load(Ordering::Relaxed)
  }
}

/// How many times the pulse is stamped between two ticks of the watchdog, so the heartbeat a tick
/// writes is never much older than the tick itself.
const PULSE_BEATS_PER_TICK: u32 = 4;

/// What one process's watchdog over its peer works with.
pub struct Watchdog {
  pub role: Role,
  pub install_dir: String,
  pub env: HashMap<String, String>,
  pub tick: Duration,
  pub stale: Duration,
  pub log: Log,
}

/// A started watchdog: the pulse on the caller's runtime and the thread the watchdog runs on.
pub struct Running {
  pulse: JoinHandle<()>,
  stop: oneshot::Sender<()>,
  thread: Option<std::thread::JoinHandle<()>>,
}

impl Running {
  /// Stop the watchdog and wait for its thread to end, so it neither rewrites an anchor nor revives
  /// the peer once this returns; a thread that has not ended within the bound is left behind.
  pub async fn stop(self) {
    self.pulse.abort();
    let _ = self.stop.send(());
    if let Some(thread) = self.thread {
      let _ = tokio::time::timeout(STOP_WITHIN, tokio::task::spawn_blocking(move || thread.join())).await;
    }
  }
}

impl Watchdog {
  /// Start the pulse on the caller's runtime, the one carrying the tunnel, and the watchdog on a
  /// thread and runtime of its own, where starting a helper, waiting on one and writing a file never
  /// hold the tunnel up. Missed ticks are skipped rather than run in a burst.
  pub fn start(self) -> Running {
    let pulse = Pulse::new();
    let beating = pulse.clone();
    let beat_every = self.tick / PULSE_BEATS_PER_TICK;
    let pulse_task = tokio::spawn(async move {
      let mut ticks = skipping_interval(beat_every);
      loop {
        ticks.tick().await;
        beating.beat();
      }
    });
    let (stop, stopped) = oneshot::channel();
    let log = self.log.clone();
    let thread = std::thread::Builder::new()
      .name("watchdog".to_owned())
      .spawn(move || self.run(pulse, stopped))
      .inspect_err(|error| log.warn("watchdog-unavailable", json!({ "error": error.to_string() })))
      .ok();
    Running {
      pulse: pulse_task,
      stop,
      thread,
    }
  }

  /// Tick at once — so the first heartbeat and the anchors are in place immediately — then on every
  /// tick until stopped.
  fn run(self, pulse: Pulse, stopped: oneshot::Receiver<()>) {
    let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
      Ok(runtime) => runtime,
      Err(error) => {
        self.log.warn("watchdog-unavailable", json!({ "error": error.to_string() }));
        return;
      }
    };
    runtime.block_on(async move {
      let mut ticks = skipping_interval(self.tick);
      let mut watching = Watching::new(epoch_ms());
      let refreshing = Refreshing::default();
      let watch = async {
        loop {
          ticks.tick().await;
          watching.tick(epoch_ms(), self.tick);
          self.run_tick(&pulse, watching, &refreshing).await;
        }
      };
      tokio::select! {
        () = watch => {}
        _ = stopped => {}
      }
    });
  }

  /// Write the heartbeat as the pulse last stamped it, put back every anchor that is missing or, for
  /// the task, not as it must be, and act on the peer as `peer_action` says. A redundant relaunch is
  /// harmless, as the peer's lock drops it.
  async fn run_tick(&self, pulse: &Pulse, watching: Watching, refreshing: &Refreshing) {
    let windows = Platform::Windows;
    let now = epoch_ms();
    let own = windows.heartbeat_path(&self.env, self.role);
    if let Some(parent) = Path::new(&own).parent() {
      let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(&own, pulse.last().to_string());
    for target in install_targets(&self.install_dir) {
      launch(&run_key_add_command(&target));
      if !Path::new(&startup_shortcut_path(&target, &self.env)).exists() {
        launch(&startup_shortcut_create_command(&target, &self.env));
      }
      if let Some(refresh) = refreshing.begin(target.name) {
        tokio::spawn(refresh_task(target, refresh));
      }
    }

    let peer = self.role.peer();
    let seen = read_number(Path::new(&windows.heartbeat_path(&self.env, peer)));
    let holder = read_number(Path::new(&windows.lock_path(&self.env, peer)))
      .and_then(|pid| u32::try_from(pid).ok())
      .filter(|pid| lock_holder(*pid) == Holder::Jake);
    let action = peer_action(now, seen, self.stale, watching, holder);
    if action == PeerAction::Leave {
      return;
    }
    let age = seen.map(|seen| now.saturating_sub(seen));
    let name = anchor_name(peer);
    match action {
      PeerAction::EndAndRelaunch(pid) => {
        self
          .log
          .warn("peer-hung", json!({ "peer": name, "lastSeenMs": seen, "ageMs": age, "pid": pid }));
        if let Err(error) = crate::command::run(&tree_kill_command(pid), HELPER_WITHIN).await {
          self.log.warn("peer-end-failed", json!({ "peer": name, "pid": pid, "error": error }));
        }
      }
      _ => self.log.warn("peer-stale", json!({ "peer": name, "lastSeenMs": seen, "ageMs": age })),
    }
    launch(&task_run_command(name));
  }
}

/// An interval that ticks at once, then every `period`, skipping the ticks it missed.
fn skipping_interval(period: Duration) -> tokio::time::Interval {
  let mut ticks = interval_at(Instant::now(), period);
  ticks.set_missed_tick_behavior(MissedTickBehavior::Skip);
  ticks
}

#[cfg(test)]
mod tests {
  use super::*;

  fn env() -> HashMap<String, String> {
    HashMap::from([("APPDATA".to_owned(), "C:\\Users\\h\\AppData\\Roaming".to_owned())])
  }

  fn decode(encoded: &str) -> String {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD.decode(encoded).unwrap();
    let units: Vec<u16> = bytes.chunks(2).map(|pair| u16::from_le_bytes([pair[0], pair[1]])).collect();
    String::from_utf16(&units).unwrap()
  }

  #[test]
  fn both_run_modes_are_one_executable_told_apart_by_the_guard_flag() {
    let [agent, guard] = install_targets("C:\\Program Files\\jake\\");
    assert_eq!(agent.binary_path, "C:\\Program Files\\jake\\jake.exe");
    assert_eq!((agent.name, agent.args.len()), ("JakeAgent", 0));
    assert_eq!((guard.name, guard.args.as_slice()), ("JakeGuard", ["--guard".to_owned()].as_slice()));
  }

  #[test]
  fn the_run_value_and_the_task_launch_the_quoted_path_with_the_run_modes_argument() {
    let [agent, guard] = install_targets("C:\\Program Files\\jake");
    assert_eq!(
      run_key_add_command(&guard),
      [
        "reg",
        "add",
        "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
        "/v",
        "JakeGuard",
        "/t",
        "REG_SZ",
        "/d",
        "\"C:\\Program Files\\jake\\jake.exe\" --guard",
        "/f"
      ]
    );
    let agent_task = decode(&task_create_command(&agent)[6]);
    assert!(
      agent_task
        .contains("$action = New-ScheduledTaskAction -Execute 'C:\\Program Files\\jake\\jake.exe'\n")
    );
    assert!(agent_task.contains("Register-ScheduledTask -TaskName 'JakeAgent' "));
    let guard_task = decode(&task_create_command(&guard)[6]);
    assert!(guard_task.contains("-Execute 'C:\\Program Files\\jake\\jake.exe' -Argument '--guard'\n"));
    assert_eq!(task_run_command("JakeGuard"), ["schtasks", "/run", "/tn", "JakeGuard"]);
    assert_eq!(run_key_remove_command(&agent)[..2], ["reg", "delete"]);
    assert_eq!(task_remove_command(&guard), ["schtasks", "/delete", "/tn", "JakeGuard", "/f"]);
  }

  #[test]
  fn every_rewrite_registers_the_task_repeating_and_restarting_with_no_run_time_limit_and_on_battery() {
    for target in install_targets("C:\\jake") {
      let task = decode(&task_create_command(&target)[6]);
      assert!(task.contains("$logon = New-ScheduledTaskTrigger -AtLogOn\n"));
      assert!(task.contains(
        "$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)\n"
      ));
      assert!(task.contains(
        "$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries \
         -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval \
         (New-TimeSpan -Minutes 1)\n"
      ));
      assert!(task.contains("-Trigger @($logon, $repeat) -Settings $settings"));
    }
  }

  const INSTALL_DIR: &str = "C:\\Users\\tester\\AppData\\Local\\Programs\\jake";

  /// The guard's task as `schtasks /query /xml` prints it into a pipe on a Windows PC, once registered
  /// the way the installer and `task_create_command` register it: single-byte text under a declaration
  /// that names UTF-16. The user's SID and folder are replaced. A PC printed it before the restarts and
  /// the repeating trigger were registered; those are laid out as Task Scheduler's schema writes them.
  const REGISTERED_AS_IT_MUST_BE: &str = r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <URI>\JakeGuard</URI>
  </RegistrationInfo>
  <Principals>
    <Principal id="Author">
      <UserId>S-1-5-21-0-0-0-1001</UserId>
      <LogonType>InteractiveToken</LogonType>
    </Principal>
  </Principals>
  <Settings>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <StartWhenAvailable>true</StartWhenAvailable>
    <IdleSettings>
      <Duration>PT10M</Duration>
      <WaitTimeout>PT1H</WaitTimeout>
      <StopOnIdleEnd>true</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <UseUnifiedSchedulingEngine>true</UseUnifiedSchedulingEngine>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Triggers>
    <LogonTrigger />
    <TimeTrigger>
      <Repetition>
        <Interval>PT5M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <StartBoundary>2026-11-18T10:16:40+09:00</StartBoundary>
    </TimeTrigger>
  </Triggers>
  <Actions Context="Author">
    <Exec>
      <Command>C:\Users\tester\AppData\Local\Programs\jake\jake.exe</Command>
      <Arguments>--guard</Arguments>
    </Exec>
  </Actions>
</Task>
"#;

  /// The agent's task as the same PC printed it once `schtasks /create` had registered it: no
  /// run-time limit element, so the default of three days, the battery defaults, and a quoted command.
  const REGISTERED_BY_SCHTASKS: &str = r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Date>2026-11-18T10:07:34</Date>
    <URI>\JakeAgent</URI>
  </RegistrationInfo>
  <Principals>
    <Principal id="Author">
      <UserId>S-1-5-21-0-0-0-1001</UserId>
      <LogonType>InteractiveToken</LogonType>
    </Principal>
  </Principals>
  <Settings>
    <DisallowStartIfOnBatteries>true</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>true</StopIfGoingOnBatteries>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <IdleSettings>
      <Duration>PT10M</Duration>
      <WaitTimeout>PT1H</WaitTimeout>
      <StopOnIdleEnd>true</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
  </Settings>
  <Triggers>
    <LogonTrigger>
      <StartBoundary>2026-11-18T10:07:00</StartBoundary>
    </LogonTrigger>
  </Triggers>
  <Actions Context="Author">
    <Exec>
      <Command>"C:\Users\tester\AppData\Local\Programs\jake\jake.exe"</Command>
    </Exec>
  </Actions>
</Task>
"#;

  #[test]
  fn a_task_as_it_must_be_is_not_registered_again() {
    let [_, guard] = install_targets(INSTALL_DIR);
    let printed = REGISTERED_AS_IT_MUST_BE.as_bytes();
    assert_eq!(task_refresh_command(&guard, Some(&query_text(printed))), None);
    let printed_as_utf16: Vec<u8> = [0xFF, 0xFE]
      .into_iter()
      .chain(REGISTERED_AS_IT_MUST_BE.encode_utf16().flat_map(u16::to_le_bytes))
      .collect();
    assert_eq!(task_refresh_command(&guard, Some(&query_text(&printed_as_utf16))), None);
  }

  #[test]
  fn a_task_missing_any_setting_or_absent_is_registered_again() {
    let [agent, guard] = install_targets(INSTALL_DIR);
    let restarts = "    <RestartOnFailure>\n      <Interval>PT1M</Interval>\n      <Count>3</Count>\n    </RestartOnFailure>\n";
    let changed = [
      (
        "<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
        "<ExecutionTimeLimit>PT72H</ExecutionTimeLimit>",
      ),
      (restarts, ""),
      ("<Count>3</Count>", "<Count>1</Count>"),
      ("<Interval>PT5M</Interval>", "<Interval>PT1H</Interval>"),
      ("<StopAtDurationEnd>", "<Duration>P1D</Duration>\n        <StopAtDurationEnd>"),
      ("</StartBoundary>", "</StartBoundary>\n      <Enabled>false</Enabled>"),
      ("<LogonTrigger />", "<LogonTrigger><Enabled>false</Enabled></LogonTrigger>"),
    ];
    for (held, changed_to) in changed {
      assert!(REGISTERED_AS_IT_MUST_BE.contains(held), "{held}");
      let changed = REGISTERED_AS_IT_MUST_BE.replace(held, changed_to);
      assert_eq!(
        task_refresh_command(&guard, Some(&changed)),
        Some(task_create_command(&guard)),
        "{changed_to}"
      );
    }
    let by_schtasks = query_text(REGISTERED_BY_SCHTASKS.as_bytes());
    assert_eq!(task_refresh_command(&agent, Some(&by_schtasks)), Some(task_create_command(&agent)));
    assert_eq!(task_refresh_command(&guard, None), Some(task_create_command(&guard)));
  }

  #[test]
  fn a_query_that_says_nothing_registers_nothing_and_a_failed_one_registers_the_task() {
    let [agent, _] = install_targets("C:\\jake");
    let silent = Unanswered::Silent("schtasks did not finish within 10s".to_owned());
    let failed = Unanswered::Failed("schtasks ended with exit code: 1".to_owned());

    assert_eq!(task_refresh_after(&agent, Err(silent)), None);
    assert_eq!(task_refresh_after(&agent, Err(failed)), Some(task_create_command(&agent)));
    assert_eq!(
      task_refresh_after(&agent, Ok(b"not a task".to_vec())),
      Some(task_create_command(&agent))
    );
  }

  #[test]
  fn a_task_has_one_refresh_standing_until_it_ends() {
    let refreshing = Refreshing::default();
    let first = refreshing.begin(AGENT_ANCHOR_NAME);

    assert!(first.is_some());
    assert!(refreshing.begin(AGENT_ANCHOR_NAME).is_none());
    assert!(refreshing.begin(GUARD_ANCHOR_NAME).is_some());
    drop(first);
    assert!(refreshing.begin(AGENT_ANCHOR_NAME).is_some());
  }

  #[test]
  fn the_shortcut_is_built_through_wscript_with_every_path_single_quoted() {
    let [_, guard] = install_targets("C:\\it's here");
    let command = startup_shortcut_create_command(&guard, &env());
    assert_eq!(
      command[..6],
      [
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand"
      ]
    );
    let script = decode(&command[6]);
    let lnk =
      "C:\\Users\\h\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\JakeGuard.lnk";
    assert!(script.contains(&format!("CreateShortcut('{lnk}')")));
    assert!(script.contains("$s.TargetPath = 'C:\\it''s here\\jake.exe'"));
    assert!(script.contains("$s.WorkingDirectory = 'C:\\it''s here'"));
    assert!(script.contains("$s.Arguments = '--guard'"));
    assert!(script.ends_with("$s.Save()"));
    let removal = decode(&startup_shortcut_remove_command(&guard, &env())[6]);
    assert_eq!(
      removal,
      format!("Remove-Item -LiteralPath '{lnk}' -Force -ErrorAction SilentlyContinue")
    );
  }

  #[test]
  fn one_copy_takes_the_lock_and_a_dead_holders_lock_is_reclaimed() {
    let dir = std::env::temp_dir().join(format!("jake-lock-{}", std::process::id()));
    let path = dir.join("agent.lock");
    assert!(acquire_lock(&path, 10, |_| true));
    assert!(!acquire_lock(&path, 11, |pid| pid == 10));
    assert_eq!(read_number(&path), Some(10));
    assert!(acquire_lock(&path, 12, |_| false));
    assert_eq!(read_number(&path), Some(12));
    release_lock(&path);
    assert!(!path.exists());
    fs::remove_dir_all(&dir).unwrap();
  }

  #[test]
  fn a_peer_is_dead_once_its_heartbeat_is_missing_or_older_than_the_threshold() {
    let stale = Duration::from_secs(180);
    assert!(peer_stale(1_000_000, None, stale));
    assert!(!peer_stale(1_000_000, Some(1_000_000 - 180_000), stale));
    assert!(peer_stale(1_000_000, Some(1_000_000 - 180_001), stale));
    // A heartbeat written after this tick read the clock is fresh, not an overflow.
    assert!(!peer_stale(1_000_000, Some(1_000_500), stale));
  }

  #[test]
  fn a_stall_longer_than_two_ticks_or_a_clock_set_back_starts_the_watching_over() {
    let tick = Duration::from_secs(60);
    let mut watching = Watching::new(1_000_000);
    watching.tick(1_120_000, tick);
    assert_eq!(watching.since, 1_000_000);
    watching.tick(1_240_001, tick);
    assert_eq!(watching.since, 1_240_001);
    watching.tick(1_200_000, tick);
    assert_eq!(watching.since, 1_200_000);
  }

  #[test]
  fn a_stale_peer_is_ended_only_once_this_watchdog_watched_it_longer_than_the_threshold() {
    let stale = Duration::from_secs(180);
    let now = 10_000_000;
    let long_watched = Watching::new(now - 180_001);
    let just_woken = Watching::new(now - 60_000);
    let fresh = Some(now - 60_000);
    let silent = Some(now - 600_000);
    assert_eq!(peer_action(now, fresh, stale, long_watched, Some(42)), PeerAction::Leave);
    assert_eq!(peer_action(now, silent, stale, long_watched, Some(42)), PeerAction::EndAndRelaunch(42));
    assert_eq!(peer_action(now, silent, stale, just_woken, Some(42)), PeerAction::Relaunch);
    assert_eq!(peer_action(now, silent, stale, long_watched, None), PeerAction::Relaunch);
    assert_eq!(peer_action(now, None, stale, long_watched, None), PeerAction::Relaunch);
  }

  #[test]
  fn this_process_does_not_read_as_a_gone_lock_holder() {
    assert!(lock_holder(std::process::id()).holds());
  }
}
