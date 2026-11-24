// Removing by hand the install this executable belongs to, once its agent's name is checked.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::json;

use crate::connection::{Agent, LeaveNotice};
use crate::log::Log;
use crate::pair::{
  JAKE_BINARY, anchor_remove_commands, install_targets, powershell_command, ps_single_quote, read_number,
};
use crate::platform::{Platform, Role, SYSTEMD_UNIT_NAME, systemd_unit_path};
use crate::{VERSION, command, config, installed, instance, wsl};

/// The command, first among the executable's arguments, that has it remove its own install.
pub const UNINSTALL_COMMAND: &str = "uninstall";
const REMOVE_CONFIG_FLAG: &str = "--remove-config";
const NAME_FLAG: &str = "--name";
const YES_FLAG: &str = "--yes";

/// How long one removal helper may take before the uninstall presses on without it.
const STEP_BOUND: Duration = Duration::from_secs(30);

/// The files of a Linux install's layout that a removal keeping the config deletes.
const LINUX_LAYOUT_FILES: [&str; 4] = ["jake", "jake.new", "jake.previous", "uninstall.sh"];

/// The config an install keeps where the removal keeps it.
const CONFIG_FILE: &str = "agent.env";

/// What the uninstall command is asked: whose install it means, whether to ask first, and whether the
/// config goes too.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Options {
  pub name: Option<String>,
  pub yes: bool,
  pub remove_config: bool,
}

impl Options {
  /// The options the arguments after the uninstall command give; each at most once.
  pub fn parse(arguments: &[String]) -> Result<Self, String> {
    let mut options = Self::default();
    let mut rest = arguments.iter();
    while let Some(argument) = rest.next() {
      match argument.as_str() {
        REMOVE_CONFIG_FLAG if !options.remove_config => options.remove_config = true,
        YES_FLAG if !options.yes => options.yes = true,
        NAME_FLAG if options.name.is_none() => match rest.next() {
          Some(name) if !name.is_empty() && !name.starts_with('-') => options.name = Some(name.clone()),
          _ => return Err(format!("{NAME_FLAG} takes the name of the agent to remove")),
        },
        other => {
          return Err(format!(
            "{UNINSTALL_COMMAND} does not take {other:?}; it takes {NAME_FLAG} <agent>, {YES_FLAG} and \
             {REMOVE_CONFIG_FLAG}, each once"
          ));
        }
      }
    }
    Ok(options)
  }

  /// The executable's arguments that ask for these options, the command first.
  pub fn arguments(&self) -> Vec<String> {
    let mut arguments = vec![UNINSTALL_COMMAND.to_owned()];
    if let Some(name) = &self.name {
      arguments.extend([NAME_FLAG.to_owned(), name.clone()]);
    }
    if self.yes {
      arguments.push(YES_FLAG.to_owned());
    }
    if self.remove_config {
      arguments.push(REMOVE_CONFIG_FLAG.to_owned());
    }
    arguments
  }
}

/// Whether an uninstall may go on, by the agent the install in its folder serves.
#[derive(Debug, PartialEq, Eq)]
pub enum Verdict {
  /// The install is the one named, or `--yes` was given: it is removed.
  Remove(String),
  /// No name was given: the install is removed once this question is answered yes.
  Ask { name: String, question: String },
  /// It is not removed, for the reason given.
  Refuse(String),
}

/// Whether the install in `dir`, whose `agent.env` names `installed`, is removed as `options` ask.
pub fn verdict(dir: &str, installed: Option<&str>, options: &Options) -> Verdict {
  let Some(installed) = installed else {
    return Verdict::Refuse(format!(
      "no jake agent is installed in {dir}: no {CONFIG_FILE} there names one, so nothing is removed"
    ));
  };
  match &options.name {
    Some(wanted) if wanted != installed => Verdict::Refuse(format!(
      "the jake install in {dir} is {installed}'s, not {wanted}'s, so nothing is removed. Run the uninstall \
       with {NAME_FLAG} {installed} if {installed} is the one to remove."
    )),
    Some(_) => Verdict::Remove(installed.to_owned()),
    None if options.yes => Verdict::Remove(installed.to_owned()),
    None => Verdict::Ask {
      name: installed.to_owned(),
      question: format!("Remove the jake agent {installed}, installed in {dir}?"),
    },
  }
}

/// Where an uninstall says what it does, and asks.
pub trait Voice {
  /// A step it takes.
  fn step(&mut self, line: &str);
  /// Something that did not go as it should, which does not stop the removal.
  fn warn(&mut self, line: &str);
  /// Whether the question is answered yes.
  fn confirm(&mut self, question: &str) -> bool;
}

/// How an uninstall ended.
#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
  /// The install of this agent was removed; where the config was kept, these are the config and the log.
  Removed {
    name: String,
    kept: Option<(String, String)>,
  },
  /// Nothing was removed, for the reason given.
  Refused(String),
  /// The question was not answered yes, so nothing was removed.
  Declined(String),
}

/// Remove the install in `install_dir`, the folder of the executable running, as `options` ask, saying each
/// step to `voice`. Nothing is touched before the install is known to be the one meant. Each step after
/// that is guarded, since a removal that stopped halfway would leave a half-installed agent behind.
pub async fn uninstall(
  platform: Platform,
  install_dir: &Path,
  process_env: HashMap<String, String>,
  options: &Options,
  voice: &mut impl Voice,
) -> Outcome {
  let dir = install_dir.to_string_lossy().into_owned();
  let name = match verdict(&dir, installed::name_beside(install_dir).as_deref(), options) {
    Verdict::Remove(name) => name,
    Verdict::Ask { name, question } => {
      if !voice.confirm(&question) {
        return Outcome::Declined(format!("{name} was not removed"));
      }
      name
    }
    Verdict::Refuse(reason) => return Outcome::Refused(reason),
  };
  let env = match config::merged(install_dir, process_env) {
    Ok(env) => env,
    Err(error) => return Outcome::Refused(error),
  };
  let data_dir = platform.data_dir(&env);
  let log = Log::open(PathBuf::from(platform.log_path(&env)));
  log.warn(
    "uninstalling",
    json!({ "agent": name, "installDir": dir, "removeConfig": options.remove_config }),
  );
  match platform {
    Platform::Linux => {
      voice.step("stopping and disabling the user service");
      let stop = ["systemctl", "--user", "disable", "--now", SYSTEMD_UNIT_NAME].map(str::to_owned);
      let _ = command::run(&stop, STEP_BOUND).await;
      tell_hub(platform, &env, &log, voice).await;
      voice.step("removing the unit");
      let _ = std::fs::remove_file(systemd_unit_path(&env));
      let _ = command::run(&["systemctl", "--user", "daemon-reload"].map(str::to_owned), STEP_BOUND).await;
      if let Some(distribution) = env.get("WSL_DISTRO_NAME").filter(|name| !name.is_empty()) {
        remove_keep_alive(distribution, voice).await;
      }
      voice.step("deleting the install layout");
      delete_linux_layout(install_dir, Path::new(&data_dir), options.remove_config);
    }
    Platform::Windows => {
      voice.step("stopping the agent and guard");
      stop_pair(&dir, &env).await;
      tell_hub(platform, &env, &log, voice).await;
      voice.step("removing autostart anchors");
      for target in install_targets(&dir) {
        for argv in anchor_remove_commands(&target, &env) {
          let _ = command::run(&argv, STEP_BOUND).await;
        }
      }
      // A trigger that fired before its anchor went may have started a process of the pair again.
      stop_pair(&dir, &env).await;
      voice.step("deleting the install folder once this program has exited");
      let script = windows_cleanup_script(&dir, options.remove_config.then_some(data_dir.as_str()));
      if let Err(error) = command::spawn_detached(&powershell_command(&script)) {
        voice.warn(&format!(
          "the install folder could not be handed to its cleanup, so delete {dir} by hand: {error}"
        ));
      }
    }
  }
  Outcome::Removed {
    name,
    kept: (!options.remove_config).then(|| (platform.join(&dir, &[CONFIG_FILE]), platform.log_path(&env))),
  }
}

/// Tell the hub the agent has gone, in one line of what the hub answered.
pub async fn announce(agent: &Agent) -> Result<String, String> {
  let name = &agent.config.agent_name;
  match agent.announce_leave().await {
    Ok(LeaveNotice::Sent) => Ok(format!("the hub was told {name} has left")),
    Ok(LeaveNotice::AlreadyRecorded) => {
      Ok(format!("the hub had already recorded {name} as left: its name is revoked"))
    }
    Err(error) => Err(format!("the hub was not told of the leave: {error}")),
  }
}

/// The leave notice, said as the install's own instance; a hub that is not told stops nothing.
async fn tell_hub(platform: Platform, env: &HashMap<String, String>, log: &Log, voice: &mut impl Voice) {
  voice.step("telling the hub this agent has left");
  let config = match config::read(env) {
    Ok(config) => config,
    Err(error) => {
      voice.warn(&format!("the hub was not told, since the config cannot be read ({error}); it will show this agent as disconnected"));
      return;
    }
  };
  let path = PathBuf::from(platform.join(&platform.data_dir(env), &["instance"]));
  let (instance, _) = instance::kept_at(&path);
  let agent = Agent::new(config, VERSION.to_owned(), log.clone()).instance(instance);
  match announce(&agent).await {
    Ok(line) => voice.step(&line),
    Err(reason) => voice.warn(&format!("{reason}; it will show this agent as disconnected")),
  }
}

/// End the Windows pair of this install by the ids its locks hold, until neither runs, since either may
/// revive the other in between.
async fn stop_pair(dir: &str, env: &HashMap<String, String>) {
  for _ in 0..5 {
    let running: Vec<u32> = [Role::Agent, Role::Guard]
      .into_iter()
      .filter_map(|role| read_number(Path::new(&Platform::Windows.lock_path(env, role))))
      .filter_map(|pid| u32::try_from(pid).ok())
      .filter(|pid| runs_from(*pid, dir))
      .collect();
    if running.is_empty() {
      return;
    }
    for pid in running {
      let _ = command::run(&crate::exec::tree_kill_command(pid), STEP_BOUND).await;
    }
    tokio::time::sleep(Duration::from_millis(500)).await;
  }
}

/// Whether a process runs this install's own executable, so a lock naming another install's process, or an
/// id Windows has handed to another program, never ends it.
#[cfg(windows)]
fn runs_from(pid: u32, dir: &str) -> bool {
  match crate::pair::process_image(pid) {
    crate::pair::ProcessImage::Path(exe) => {
      let named = exe.file_name().and_then(|name| name.to_str());
      let folder = exe
        .parent()
        .map(|folder| folder.to_string_lossy().trim_end_matches('\\').to_lowercase());
      named.is_some_and(|name| name.eq_ignore_ascii_case(crate::pair::JAKE_BINARY))
        && folder.as_deref() == Some(dir.trim_end_matches('\\').to_lowercase().as_str())
    }
    _ => false,
  }
}

#[cfg(not(windows))]
fn runs_from(_pid: u32, _dir: &str) -> bool {
  false
}

/// The lines of a Windows cleanup that wait for the install's executable to become deletable, once every process
/// running it has exited, and delete it.
fn exe_released_lines(install_dir: &str) -> Vec<String> {
  let exe = Platform::Windows.join(install_dir, &[JAKE_BINARY]);
  vec![
    format!("$exe = {}", ps_single_quote(&exe)),
    "for ($i = 0; $i -lt 100; $i++) {".to_owned(),
    "  if (-not (Test-Path -LiteralPath $exe)) { break }".to_owned(),
    "  try { Remove-Item -LiteralPath $exe -Force -ErrorAction Stop; break } catch { Start-Sleep -Milliseconds 200 }"
      .to_owned(),
    "}".to_owned(),
  ]
}

/// What the Windows cleanup runs once the uninstaller has exited: it waits for the executable to become
/// deletable, then deletes the install folder, all of it where the data directory is given to go too, and
/// otherwise all but the config.
pub fn windows_cleanup_script(install_dir: &str, data_dir: Option<&str>) -> String {
  let mut lines = exe_released_lines(install_dir);
  let folder = ps_single_quote(install_dir);
  match data_dir {
    Some(data_dir) => {
      lines.push(format!("Remove-Item -LiteralPath {folder} -Recurse -Force -ErrorAction SilentlyContinue"));
      lines.push(format!(
        "Remove-Item -LiteralPath {} -Recurse -Force -ErrorAction SilentlyContinue",
        ps_single_quote(data_dir)
      ));
    }
    None => lines.push(format!(
      "Get-ChildItem -LiteralPath {folder} -Force -ErrorAction SilentlyContinue | Where-Object {{ $_.Name -ne \
       '{CONFIG_FILE}' }} | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue"
    )),
  }
  lines.join("\n")
}

/// Delete a Linux install's layout: the whole install folder and data directory, or the layout's files
/// alone where the config and the log are kept.
fn delete_linux_layout(install_dir: &Path, data_dir: &Path, remove_config: bool) {
  if remove_config {
    let _ = std::fs::remove_dir_all(install_dir);
    let _ = std::fs::remove_dir_all(data_dir);
  } else {
    for file in LINUX_LAYOUT_FILES {
      let _ = std::fs::remove_file(install_dir.join(file));
    }
  }
}

/// Remove, through Windows interop, the task that keeps this WSL distribution running, with the hold's
/// executable where the task had one.
async fn remove_keep_alive(distribution: &str, voice: &mut impl Voice) {
  let task = wsl::keep_alive_task_name(distribution);
  voice.step(&format!("removing the Windows task that keeps {distribution} running"));
  let Some(powershell) = windows_powershell() else {
    voice.warn(&format!(
      "Windows interop is not reachable from here, so the task {task} is left in Task Scheduler. Run the \
       uninstall again from a WSL shell to remove it."
    ));
    return;
  };
  let mut argv = powershell_command(&wsl::keep_alive_removal_script(distribution));
  argv[0] = powershell;
  if command::run(&argv, STEP_BOUND).await.is_err() {
    voice.warn(&format!("the task {task} could not be removed; remove it in Task Scheduler"));
  }
}

/// Windows PowerShell as this WSL distribution reaches it through interop, if it does.
fn windows_powershell() -> Option<String> {
  if let Some(found) = std::env::var_os("PATH")
    .iter()
    .flat_map(std::env::split_paths)
    .map(|dir| dir.join("powershell.exe"))
    .find(|path| path.is_file())
  {
    return Some(found.to_string_lossy().into_owned());
  }
  let output = std::process::Command::new("wslpath")
    .args(["-u", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"])
    .stdin(std::process::Stdio::null())
    .stderr(std::process::Stdio::null())
    .output()
    .ok()?;
  let path = String::from_utf8_lossy(&output.stdout).trim().to_owned();
  (output.status.success() && Path::new(&path).is_file()).then_some(path)
}

#[cfg(test)]
mod tests {
  use super::*;

  fn parsed(arguments: &[&str]) -> Result<Options, String> {
    Options::parse(&arguments.iter().map(|argument| (*argument).to_owned()).collect::<Vec<_>>())
  }

  #[test]
  fn the_options_are_a_name_yes_and_remove_config_each_once_in_any_order() {
    assert_eq!(parsed(&[]), Ok(Options::default()));
    let all = Options {
      name: Some("u63".to_owned()),
      yes: true,
      remove_config: true,
    };
    assert_eq!(parsed(&["--yes", "--remove-config", "--name", "u63"]), Ok(all.clone()));
    assert_eq!(all.arguments(), ["uninstall", "--name", "u63", "--yes", "--remove-config"]);
    assert_eq!(Options::parse(&all.arguments()[1..]), Ok(all));
    for refused in [
      &["--name"][..],
      &["--name", ""],
      &["--name", "--yes"],
      &["--yes", "--yes"],
      &["-RemoveConfig"],
    ] {
      assert!(parsed(refused).is_err(), "{refused:?}");
    }
  }

  #[test]
  fn a_name_that_is_not_the_installs_own_is_refused_naming_the_one_found() {
    let named = Options {
      name: Some("u63".to_owned()),
      ..Options::default()
    };
    let Verdict::Refuse(reason) = verdict("C:\\P\\jake", Some("u64"), &named) else {
      panic!("another agent's install is not removed");
    };
    assert!(reason.contains("u64's, not u63's"), "{reason}");
    assert!(reason.contains("nothing is removed"), "{reason}");
    assert_eq!(verdict("C:\\P\\jake", Some("u63"), &named), Verdict::Remove("u63".to_owned()));
  }

  #[test]
  fn with_no_name_it_asks_naming_the_install_unless_told_yes() {
    assert_eq!(
      verdict("/h/.local/share/jake", Some("u64"), &Options::default()),
      Verdict::Ask {
        name: "u64".to_owned(),
        question: "Remove the jake agent u64, installed in /h/.local/share/jake?".to_owned()
      }
    );
    let yes = Options {
      yes: true,
      ..Options::default()
    };
    assert_eq!(verdict("/h/.local/share/jake", Some("u64"), &yes), Verdict::Remove("u64".to_owned()));
  }

  #[test]
  fn a_folder_whose_config_names_no_agent_holds_no_install() {
    let yes = Options {
      yes: true,
      ..Options::default()
    };
    assert!(
      matches!(verdict("/tmp/build", None, &yes), Verdict::Refuse(reason) if reason.contains("no jake agent"))
    );
  }

  #[test]
  fn the_windows_cleanup_waits_for_the_executable_then_keeps_the_config_unless_told_otherwise() {
    let kept = windows_cleanup_script("C:\\P\\jake", None);
    assert!(kept.starts_with("$exe = 'C:\\P\\jake\\jake.exe'\n"), "{kept}");
    assert!(kept.contains("Get-ChildItem -LiteralPath 'C:\\P\\jake' -Force"), "{kept}");
    assert!(kept.contains("$_.Name -ne 'agent.env'"), "{kept}");
    assert!(!kept.contains("C:\\L\\jake"), "{kept}");

    let all = windows_cleanup_script("C:\\P\\jake", Some("C:\\L\\jake"));
    assert!(all.contains("Remove-Item -LiteralPath 'C:\\P\\jake' -Recurse"), "{all}");
    assert!(all.contains("Remove-Item -LiteralPath 'C:\\L\\jake' -Recurse"), "{all}");
    assert!(!all.contains("agent.env"), "{all}");
  }

  /// A voice that keeps what it is told and answers every question as given.
  struct Heard {
    lines: Vec<String>,
    answer: bool,
    asked: Vec<String>,
  }

  impl Voice for Heard {
    fn step(&mut self, line: &str) {
      self.lines.push(line.to_owned());
    }
    fn warn(&mut self, line: &str) {
      self.lines.push(format!("! {line}"));
    }
    fn confirm(&mut self, question: &str) -> bool {
      self.asked.push(question.to_owned());
      self.answer
    }
  }

  /// An install folder holding an `agent.env` naming `name` and an executable, removed when dropped.
  struct Folder(PathBuf);

  impl Folder {
    fn named(tag: &str, name: &str) -> Self {
      let dir = std::env::temp_dir().join(format!("jake-uninstall-{tag}-{}", std::process::id()));
      std::fs::create_dir_all(&dir).unwrap();
      std::fs::write(
        dir.join("agent.env"),
        format!("JAKE_HUB_URL=ws://127.0.0.1:1\nJAKE_SECRET=s\nJAKE_AGENT_NAME={name}\n"),
      )
      .unwrap();
      std::fs::write(dir.join("jake"), "the executable").unwrap();
      Self(dir)
    }
  }

  impl Drop for Folder {
    fn drop(&mut self) {
      let _ = std::fs::remove_dir_all(&self.0);
    }
  }

  #[tokio::test]
  async fn a_refused_or_declined_uninstall_touches_nothing() {
    let folder = Folder::named("refused", "u64");
    let mut voice = Heard {
      lines: Vec::new(),
      answer: false,
      asked: Vec::new(),
    };
    let named = Options {
      name: Some("u63".to_owned()),
      yes: true,
      ..Options::default()
    };
    let refused = uninstall(Platform::Linux, &folder.0, HashMap::new(), &named, &mut voice).await;
    assert!(matches!(refused, Outcome::Refused(reason) if reason.contains("u64's, not u63's")));

    let declined =
      uninstall(Platform::Linux, &folder.0, HashMap::new(), &Options::default(), &mut voice).await;
    assert_eq!(declined, Outcome::Declined("u64 was not removed".to_owned()));
    assert_eq!(voice.asked.len(), 1);
    assert!(voice.lines.is_empty(), "{:?}", voice.lines);
    assert!(folder.0.join("jake").is_file());
    assert!(folder.0.join("agent.env").is_file());
  }
}
