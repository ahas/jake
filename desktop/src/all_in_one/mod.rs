// The all-in-one app (docs/all-in-one.md): the whole BMO set installed and run on this machine, its console in the
// app's window. The first run is a flow of screens the bundled page draws; the course here does the work each
// screen asks for, on the machine or in the WSL 2 distribution, and feeds what it came to back into the flow.

mod flow;
mod host;
mod installer;
mod probe;
mod record;
mod set;
mod wsl;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use jake_agent::Log;
use serde::Serialize;
use serde_json::Value;
use tauri::ipc::CapabilityBuilder;
use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::NewWindowResponse;
use tauri::{
  App, AppHandle, Manager as _, RunEvent, State, WebviewUrl, WebviewWindowBuilder, WindowEvent, Wry,
};
use tokio::sync::{mpsc, watch};
use url::Url;

use crate::channel::{Channel, Feeds};
use crate::navigation::{self, Navigation};
use crate::settings::{Change, Key, SettingsFile, SettingsView, Switch};
use crate::sign_in::{self, Alignment, Registration};
use crate::updates::{self, Moment, Updates};

use self::flow::{Chat, Event, Flow, Manager, Screen, Work};
use self::host::{As, Host, run};
use self::installer::{Layout, Outcome};

const MAIN_WINDOW: &str = "main";
const TRAY: &str = "tray";
/// How often the tray reads the set's health once it runs.
const HEALTH_EVERY: Duration = Duration::from_secs(30);
/// How many of the work's last lines the page shows.
const SHOWN_LINES: usize = 40;

/// What the commands, the course, the tray and the quit share.
struct Shared {
  flow: Mutex<Flow>,
  /// The work's last lines, for the page.
  lines: Mutex<Vec<String>>,
  busy: Mutex<bool>,
  events: mpsc::UnboundedSender<Event>,
  host: Host,
  record_file: PathBuf,
  /// The layout on the machine the set runs on, once the probe read its home.
  layout: Mutex<Option<Layout>>,
  /// The variables that put a command under the supervisor, where it runs.
  supervisor_env: Mutex<Vec<(String, String)>>,
  /// The supervisor the app runs, where the set runs under it.
  supervisor: Mutex<Option<tokio::process::Child>>,
  settings: Mutex<SettingsFile>,
  registration: Result<Registration, String>,
  autostart: CheckMenuItem<Wry>,
  /// The update channel, which the updates follow.
  channel: watch::Sender<Channel>,
  /// The app's quiet updates, where its build checks for any.
  updates: Option<Arc<Updates>>,
}

impl Shared {
  fn say(&self, line: &str) {
    let mut lines = self.lines.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    lines.push(line.to_owned());
    let over = lines.len().saturating_sub(SHOWN_LINES);
    lines.drain(..over);
  }

  fn layout(&self) -> Option<Layout> {
    self.layout.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone()
  }

  /// The environment every installer command is laid under: the lines `supervise env` printed where the set runs
  /// under the supervisor, whose PATH holds the account's tool folders since it was started with them; else that
  /// PATH alone.
  fn env(&self) -> Vec<(String, String)> {
    let kept = self.supervisor_env.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
    if !kept.is_empty() {
      return kept;
    }
    self
      .layout()
      .map_or_else(Vec::new, |layout| vec![("PATH".to_owned(), self.tool_path(&layout))])
  }

  fn tool_path(&self, layout: &Layout) -> String {
    layout.tool_path(&self.host.base_path())
  }
}

/// What the bundled page draws: the flow's screen, the work's last lines and whether work is under way.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct View {
  screen: Screen,
  lines: Vec<String>,
  busy: bool,
}

#[tauri::command]
fn aio_view(shared: State<'_, Arc<Shared>>) -> View {
  View {
    screen: shared.flow.lock().unwrap_or_else(std::sync::PoisonError::into_inner).screen.clone(),
    lines: shared.lines.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone(),
    busy: *shared.busy.lock().unwrap_or_else(std::sync::PoisonError::into_inner),
  }
}

#[tauri::command]
fn aio_consent(shared: State<'_, Arc<Shared>>, chat: Chat) {
  let _ = shared.events.send(Event::Consented(chat));
}

#[tauri::command]
fn aio_accept(shared: State<'_, Arc<Shared>>) {
  let _ = shared.events.send(Event::Accepted);
}

#[tauri::command]
fn aio_prerequisites(shared: State<'_, Arc<Shared>>) {
  let _ = shared.events.send(Event::InstallPrerequisites);
}

#[tauri::command]
fn aio_retry(shared: State<'_, Arc<Shared>>) {
  let _ = shared.events.send(Event::Retry);
}

/// One value the installer asked for, kept through `install --set` with the value on standard input alone.
#[tauri::command]
async fn aio_input(shared: State<'_, Arc<Shared>>, input: String, value: String) -> Result<(), String> {
  let layout = shared.layout().ok_or("설치 위치를 아직 모릅니다.")?;
  let installer = installer_of(&shared, &layout).await;
  let line = shared.host.line(&layout.keep(&installer, &input), &shared.env(), As::Account);
  let ended = run(&line, Some(value), |_| {}).await;
  if ended.code == 0 { Ok(()) } else { Err(ended.tail) }
}

/// Every value asked was kept: the plan is read again.
#[tauri::command]
fn aio_inputs_done(shared: State<'_, Arc<Shared>>) {
  let _ = shared.events.send(Event::InputsKept);
}

/// The settings as the console draws them; the bridge's read, as the remote controller answers it.
#[tauri::command]
fn settings(shared: State<'_, Arc<Shared>>) -> SettingsView {
  settings_view(&shared)
}

/// One switch or the update channel changed; the server is this machine's set and is not changed.
#[tauri::command]
fn change_setting(
  shared: State<'_, Arc<Shared>>,
  setting: Key,
  on: Option<bool>,
  value: Option<Value>,
) -> Result<SettingsView, String> {
  let mut file = shared.settings.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
  if let Some(reason) = file.unreadable() {
    return Err(reason.to_owned());
  }
  match Change::read(setting, on, value)? {
    Change::Switch(switch, on) => {
      if switch == Switch::StartAtSignIn {
        shared.registration.as_ref().map_err(String::clone)?.set(on)?;
        let _ = shared.autostart.set_checked(on);
      }
      file.set(switch, on)?;
    }
    Change::Channel(channel) => {
      file.set_channel(channel)?;
      shared.channel.send_replace(channel);
    }
    Change::Console(_) => return Err("이 앱의 서버는 이 컴퓨터에서 실행되는 BMO입니다.".to_owned()),
  }
  drop(file);
  Ok(settings_view(&shared))
}

fn settings_view(shared: &Shared) -> SettingsView {
  let file = shared.settings.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
  let settings = file.settings();
  let console = record::read(&shared.record_file).console.and_then(|console| Url::parse(&console).ok());
  settings.switches.view(settings.channel, console.as_ref(), file.unreadable())
}

/// The testbed's binary: the one the set's deployment linked, else the one the first run built.
async fn installer_of(shared: &Shared, layout: &Layout) -> String {
  let linked = layout.linked_installer();
  let test = shared
    .host
    .line(&["test".to_owned(), "-x".to_owned(), linked.clone()], &[], As::Account);
  if run(&test, None, |_| {}).await.code == 0 { linked } else { layout.built_installer() }
}

/// The course: each event moves the flow, and the work it asks for is done here, its outcome fed back.
async fn course(app: AppHandle, shared: Arc<Shared>, mut events: mpsc::UnboundedReceiver<Event>) {
  while let Some(event) = events.recv().await {
    let work = shared.flow.lock().unwrap_or_else(std::sync::PoisonError::into_inner).on(event);
    if work == Work::Wait {
      continue;
    }
    *shared.busy.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = true;
    let next = perform(&app, &shared, work).await;
    *shared.busy.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = false;
    if let Some(next) = next {
      let _ = shared.events.send(next);
    }
  }
}

async fn perform(app: &AppHandle, shared: &Arc<Shared>, work: Work) -> Option<Event> {
  let say = |line: &str| shared.say(line);
  match work {
    Work::Wait => None,
    Work::Probe => {
      if let Err(why) = ready_host(shared).await {
        return Some(Event::Prepared(Err(why)));
      }
      let line = shared.host.script(&[], &[], As::Account);
      let ended = run(&line, Some(probe::SCRIPT.to_owned()), |_| {}).await;
      let facts = match shared.host {
        Host::Local => probe::facts(&ended.out),
        Host::Wsl { .. } => probe::with_windows_side(probe::facts(&ended.out)),
      };
      *shared.layout.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(Layout {
        home: facts.home.clone(),
      });
      Some(Event::Probed(facts))
    }
    Work::Prepare(manager) => {
      let layout = shared.layout()?;
      // The consent and the choices are kept before anything is written to the machine.
      let chat = shared.flow.lock().unwrap_or_else(std::sync::PoisonError::into_inner).chat;
      let _ = record::write(
        &shared.record_file,
        &record::Record {
          consented_at: Some(seconds_now()),
          chat,
          manager: Some(manager),
          console: None,
        },
      );
      let line = shared.host.script(&[layout.index()], &[], As::Account);
      let ended = run(&line, Some(installer::PREPARE.to_owned()), say).await;
      if ended.code != 0 {
        return Some(Event::Prepared(Err(ended.tail)));
      }
      if manager == Manager::Supervisor
        && let Err(why) = start_supervisor(shared, &layout).await
      {
        return Some(Event::Prepared(Err(why)));
      }
      Some(Event::Prepared(Ok(())))
    }
    Work::Plan | Work::Install => {
      let dry_run = work == Work::Plan;
      let layout = shared.layout()?;
      let chat = shared
        .flow
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .chat
        .unwrap_or(Chat::Telegram);
      let installer = installer_of(shared, &layout).await;
      let line = shared.host.line(
        &layout.install(&installer, chat.repository(), dry_run),
        &shared.env(),
        As::Account,
      );
      let mut steps = Vec::new();
      let ended = run(&line, None, |line| match installer::step(line) {
        Some(step) => {
          shared.say(&format!("{} · {} · {}", step.step, step.status, step.detail));
          steps.push(step);
        }
        None => shared.say(line),
      })
      .await;
      let outcome = installer::outcome(&steps, ended.code, &ended.tail);
      if dry_run {
        return Some(Event::Planned(outcome));
      }
      if let Outcome::Done {
        console: Some(console),
      } = &outcome
      {
        let mut kept = record::read(&shared.record_file);
        kept.console = Some(console.clone());
        let _ = record::write(&shared.record_file, &kept);
      }
      Some(Event::Installed(outcome))
    }
    Work::Prerequisites => {
      let layout = shared.layout()?;
      let account = account_of(&layout);
      let system = shared.host.script(&[account], &[], As::Root);
      let ended = run(&system, Some(installer::SYSTEM.to_owned()), say).await;
      if ended.code != 0 {
        return Some(Event::PrerequisitesDone(Err(ended.tail)));
      }
      let own = shared.host.script(&[], &[], As::Account);
      let ended = run(&own, Some(installer::ACCOUNT.to_owned()), say).await;
      Some(Event::PrerequisitesDone(if ended.code == 0 { Ok(()) } else { Err(ended.tail) }))
    }
    Work::Start(manager) => Some(Event::Started(start_set(shared, manager).await)),
    Work::Open(console) => {
      if let (Some(window), Ok(url)) = (app.get_webview_window(MAIN_WINDOW), Url::parse(&console)) {
        let _ = app.add_capability(console_bridge(&url));
        let _ = window.navigate(url);
      }
      tauri::async_runtime::spawn(keep_tray(app.clone(), shared.clone()));
      None
    }
  }
}

/// On Windows, WSL 2 and the BMO distribution made ready before anything runs in it.
async fn ready_host(shared: &Shared) -> Result<(), String> {
  let Host::Wsl { account, .. } = &shared.host else { return Ok(()) };
  if run(&wsl::status(), None, |_| {}).await.code != 0 {
    return Err(format!(
      "WSL 2가 설치되어 있지 않습니다. 관리자 권한으로 `{}`를 실행한 뒤 다시 시도해 주세요.",
      wsl::install_wsl().join(" ")
    ));
  }
  let listed = tokio::process::Command::new("wsl.exe").args(["--list", "--quiet"]).output().await;
  if listed.as_ref().is_ok_and(|output| wsl::listed(&output.stdout)) {
    return Ok(());
  }
  let folder = dirs_local().join("wsl");
  let image = folder.join(wsl::IMAGE);
  download_image(&image).await?;
  let import = wsl::import(&folder.join("disk").to_string_lossy(), &image.to_string_lossy());
  let imported = run(&import, None, |line| shared.say(line)).await;
  if imported.code != 0 {
    return Err(imported.tail);
  }
  let bootstrapped =
    run(&wsl::bootstrap(account), Some(wsl::BOOTSTRAP.to_owned()), |line| shared.say(line)).await;
  if bootstrapped.code != 0 {
    return Err(bootstrapped.tail);
  }
  Ok(())
}

/// Ubuntu's WSL image downloaded and checked against its folder's checksums.
async fn download_image(image: &std::path::Path) -> Result<(), String> {
  use sha2::Digest as _;
  let client = reqwest::Client::new();
  let fetch = |name: &str| {
    let client = client.clone();
    let address = format!("{}{name}", wsl::IMAGE_FOLDER);
    async move {
      client
        .get(&address)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|error| error.to_string())?
        .bytes()
        .await
        .map_err(|error| error.to_string())
    }
  };
  let sums = fetch(wsl::CHECKSUMS).await?;
  let wanted = wsl::checksum_of(&String::from_utf8_lossy(&sums), wsl::IMAGE)
    .ok_or("이미지의 체크섬을 찾을 수 없습니다.")?;
  let bytes = fetch(wsl::IMAGE).await?;
  let found: String = sha2::Sha256::digest(&bytes).iter().map(|byte| format!("{byte:02x}")).collect();
  if found != wanted {
    return Err("내려받은 이미지의 체크섬이 맞지 않습니다.".to_owned());
  }
  if let Some(dir) = image.parent() {
    std::fs::create_dir_all(dir).map_err(|error| error.to_string())?;
  }
  std::fs::write(image, &bytes).map_err(|error| error.to_string())
}

fn dirs_local() -> PathBuf {
  std::env::var_os("LOCALAPPDATA")
    .map(PathBuf::from)
    .unwrap_or_default()
    .join("BMO All-in-One")
}

fn account_of(layout: &Layout) -> String {
  layout.home.rsplit('/').next().unwrap_or_default().to_owned()
}

/// The supervisor started as the app's child, and the lines that put the installer under it read.
async fn start_supervisor(shared: &Shared, layout: &Layout) -> Result<(), String> {
  let testbed = installer_of(shared, layout).await;
  let words = set::Words {
    manager: Manager::Supervisor,
    layout,
    testbed,
  };
  // The supervisor, and every unit and deployment it runs, keep the PATH it starts with; `supervise env` prints the
  // PATH it is itself run with.
  let path = vec![("PATH".to_owned(), shared.tool_path(layout))];
  let running = shared
    .supervisor
    .lock()
    .unwrap_or_else(std::sync::PoisonError::into_inner)
    .as_mut()
    .is_some_and(|child| child.try_wait().ok().flatten().is_none());
  if !running {
    let line = shared.host.line(&words.serve(), &path, As::Account);
    let mut command = tokio::process::Command::new(&line[0]);
    command
      .args(&line[1..])
      .stdin(std::process::Stdio::null())
      .stdout(std::process::Stdio::null())
      .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let child = command.spawn().map_err(|error| error.to_string())?;
    *shared.supervisor.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(child);
  }
  let env = run(&shared.host.line(&words.supervisor_env(), &path, As::Account), None, |_| {}).await;
  *shared.supervisor_env.lock().unwrap_or_else(std::sync::PoisonError::into_inner) =
    set::env_lines(&env.out);
  // The supervisor answers once its socket listens.
  let status = shared.host.line(&words.status(&[]), &[], As::Account);
  for _ in 0..60 {
    if run(&status, None, |_| {}).await.code == 0 {
      return Ok(());
    }
    tokio::time::sleep(Duration::from_millis(500)).await;
  }
  Err("감독 프로세스가 응답하지 않습니다.".to_owned())
}

/// The set started under its manager as the app starts.
async fn start_set(shared: &Shared, manager: Manager) -> Result<(), String> {
  let layout = shared.layout().ok_or("설치 위치를 아직 모릅니다.")?;
  if matches!(shared.host, Host::Wsl { .. }) {
    run(&wsl::start_servers(), None, |line| shared.say(line)).await;
  }
  match manager {
    Manager::Supervisor => start_supervisor(shared, &layout).await,
    Manager::Systemd => {
      let units = set_units(shared, &layout).await;
      let words = set::Words {
        manager,
        layout: &layout,
        testbed: String::new(),
      };
      let ended =
        run(&shared.host.line(&words.systemctl("start", &units), &[], As::Account), None, |_| {}).await;
      if ended.code == 0 { Ok(()) } else { Err(ended.tail) }
    }
  }
}

async fn set_units(shared: &Shared, layout: &Layout) -> Vec<String> {
  let listing =
    run(&shared.host.script(&[], &[], As::Account), Some(set::ENABLED.to_owned()), |_| {}).await;
  set::set_units(&listing.out, &layout.prefix())
}

/// The set stopped as the app quits: the supervisor's units stopped and the supervisor waited for, or the
/// systemd units stopped.
async fn stop_set(shared: &Shared) {
  let Some(layout) = shared.layout() else { return };
  let manager = record::read(&shared.record_file).manager;
  match manager {
    Some(Manager::Supervisor) => {
      let testbed = installer_of(shared, &layout).await;
      let words = set::Words {
        manager: Manager::Supervisor,
        layout: &layout,
        testbed,
      };
      run(&shared.host.line(&words.stop_all(), &[], As::Account), None, |_| {}).await;
      let child = shared.supervisor.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take();
      if let Some(mut child) = child {
        let _ = tokio::time::timeout(Duration::from_secs(120), child.wait()).await;
      }
    }
    Some(Manager::Systemd) => {
      let units = set_units(shared, &layout).await;
      if !units.is_empty() {
        let words = set::Words {
          manager: Manager::Systemd,
          layout: &layout,
          testbed: String::new(),
        };
        run(&shared.host.line(&words.systemctl("stop", &units), &[], As::Account), None, |_| {}).await;
      }
    }
    None => {}
  }
}

/// The tray's tooltip kept to the set's health while the app runs.
async fn keep_tray(app: AppHandle, shared: Arc<Shared>) {
  let Some(layout) = shared.layout() else { return };
  let Some(manager) = record::read(&shared.record_file).manager else { return };
  loop {
    let testbed = installer_of(&shared, &layout).await;
    let units = set_units(&shared, &layout).await;
    let words = set::Words {
      manager,
      layout: &layout,
      testbed,
    };
    let read = run(&shared.host.line(&words.status(&units), &[], As::Account), None, |_| {}).await;
    let health = match manager {
      Manager::Supervisor => set::supervisor_units(&read.out).unwrap_or_default(),
      Manager::Systemd => set::systemd_units(&read.out),
    };
    if let Some(tray) = app.tray_by_id(TRAY) {
      let _ = tray.set_tooltip(Some(set::summary(&health)));
    }
    tokio::time::sleep(HEALTH_EVERY).await;
  }
}

/// The console's pages get the window's commands and the settings' read and change, as the remote
/// controller's bridge gives them (docs/desktop.md, 「The window and what the console may call」).
fn console_bridge(console: &Url) -> CapabilityBuilder {
  let host = console.host_str().unwrap_or_default();
  let port = console.port().map(|port| format!(":{port}")).unwrap_or_default();
  [
    "allow-settings",
    "allow-change-setting",
    "core:window:allow-minimize",
    "core:window:allow-toggle-maximize",
    "core:window:allow-internal-toggle-maximize",
    "core:window:allow-close",
    "core:window:allow-start-dragging",
    "core:window:allow-is-maximized",
    "core:window:allow-title",
  ]
  .into_iter()
  .fold(
    CapabilityBuilder::new("console")
      .remote(format!("{}://{host}{port}/*", console.scheme()))
      .local(false)
      .window(MAIN_WINDOW),
    CapabilityBuilder::permission,
  )
}

fn seconds_now() -> u64 {
  std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|since| since.as_secs())
    .unwrap_or(0)
}

fn reveal(app: &AppHandle) {
  if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
  }
}

/// The set stopped, then the app ended.
fn quit(app: &AppHandle) {
  let app = app.clone();
  tauri::async_runtime::spawn(async move {
    if let Some(tray) = app.tray_by_id(TRAY) {
      let _ = tray.set_tooltip(Some("BMO: 멈추는 중"));
    }
    let shared = app.state::<Arc<Shared>>().inner().clone();
    stop_set(&shared).await;
    if let Some(updates) = &shared.updates {
      updates.install(&app, Moment::Quit, || async {}).await;
    }
    app.exit(0);
  });
}

fn on_menu(app: &AppHandle, id: &str) {
  match id {
    "open" => reveal(app),
    "autostart" => {
      let shared = app.state::<Arc<Shared>>();
      let wanted = shared.autostart.is_checked().unwrap_or(false);
      let registered = shared
        .registration
        .as_ref()
        .map_err(String::clone)
        .and_then(|registration| registration.set(wanted));
      let written = registered.and_then(|()| {
        shared
          .settings
          .lock()
          .unwrap_or_else(std::sync::PoisonError::into_inner)
          .set(Switch::StartAtSignIn, wanted)
          .map(|_| ())
      });
      if written.is_err() {
        let _ = shared.autostart.set_checked(!wanted);
      }
    }
    "quit" => quit(app),
    _ => {}
  }
}

fn main_window(app: &App, visible: bool) -> tauri::Result<()> {
  let page = WebviewUrl::App("all-in-one/index.html".into());
  let handle = app.handle().clone();
  let builder = WebviewWindowBuilder::new(app, MAIN_WINDOW, page)
    .title("BMO All-in-One")
    .inner_size(1280.0, 860.0)
    .min_inner_size(360.0, 560.0)
    .visible(visible);
  #[cfg(not(target_os = "macos"))]
  let builder = builder.decorations(false);
  #[cfg(target_os = "macos")]
  let builder = builder.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true);
  let console = |handle: &AppHandle| {
    record::read(&handle.state::<Arc<Shared>>().record_file)
      .console
      .and_then(|console| Url::parse(&console).ok())
  };
  let (navigating, opening) = (handle.clone(), handle);
  let window = builder
    .on_navigation(move |url| match navigation::decide(url, console(&navigating).as_ref()) {
      Navigation::Stay => true,
      Navigation::Browser => {
        let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
        false
      }
      Navigation::Refuse => false,
    })
    .on_new_window(move |url, _| {
      if navigation::decide(&url, console(&opening).as_ref()) != Navigation::Refuse {
        let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
      }
      NewWindowResponse::Deny
    })
    .build()?;
  let closing = window.clone();
  window.on_window_event(move |event| {
    if let WindowEvent::CloseRequested { api, .. } = event {
      api.prevent_close();
      let app = closing.app_handle();
      let to_tray = app.try_state::<Arc<Shared>>().is_none_or(|shared| {
        shared
          .settings
          .lock()
          .unwrap_or_else(std::sync::PoisonError::into_inner)
          .settings()
          .switches
          .on(Switch::CloseToTray)
      });
      if to_tray {
        let _ = closing.hide();
      } else {
        quit(app);
      }
    }
  });
  Ok(())
}

/// The tray icon and its menu, opening with the quiet line of the version the app updated itself to where it did.
fn tray(app: &App, starting: bool, updated: Option<&str>) -> tauri::Result<CheckMenuItem<Wry>> {
  let updated = updated
    .map(|version| MenuItem::with_id(app, "updated", updates::updated_line(version), false, None::<&str>))
    .transpose()?;
  let open = MenuItem::with_id(app, "open", "콘솔 열기", true, None::<&str>)?;
  let autostart =
    CheckMenuItem::with_id(app, "autostart", "로그인할 때 시작", true, starting, None::<&str>)?;
  let quit = MenuItem::with_id(app, "quit", "종료 (BMO 멈춤)", true, None::<&str>)?;
  let (first, second) = (PredefinedMenuItem::separator(app)?, PredefinedMenuItem::separator(app)?);
  let after_update = PredefinedMenuItem::separator(app)?;
  let mut items: Vec<&dyn IsMenuItem<Wry>> = Vec::new();
  if let Some(updated) = &updated {
    items.extend([updated as &dyn IsMenuItem<Wry>, &after_update]);
  }
  items.extend([&open as &dyn IsMenuItem<Wry>, &first, &autostart, &second, &quit]);
  let menu = Menu::with_items(app, &items)?;
  let icon = app
    .default_window_icon()
    .cloned()
    .ok_or(tauri::Error::InvalidIcon(std::io::Error::other("the app carries no icon")))?;
  TrayIconBuilder::with_id(TRAY)
    .icon(icon)
    .tooltip("BMO: 시작하는 중")
    .menu(&menu)
    .show_menu_on_left_click(false)
    .on_menu_event(|app, event| on_menu(app, event.id().as_ref()))
    .on_tray_icon_event(|tray, event| {
      if let TrayIconEvent::Click {
        button: MouseButton::Left,
        button_state: MouseButtonState::Up,
        ..
      } = event
      {
        reveal(tray.app_handle());
      }
    })
    .build(app)?;
  Ok(autostart)
}

/// Whether the app is quiet enough to be replaced: no window shown and nothing it is installing.
fn idle(app: &AppHandle) -> bool {
  let Some(shared) = app.try_state::<Arc<Shared>>() else {
    return false;
  };
  let hidden = app
    .get_webview_window(MAIN_WINDOW)
    .is_none_or(|window| !window.is_visible().unwrap_or(true));
  hidden && !*shared.busy.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn host_here() -> Host {
  if cfg!(windows) {
    let windows_name = std::env::var("USERNAME").unwrap_or_default();
    Host::Wsl {
      distro: wsl::DISTRO.to_owned(),
      account: wsl::account_for(&windows_name),
    }
  } else {
    Host::Local
  }
}

fn setup(app: &mut App, updates: Option<Result<Feeds, String>>) -> Result<(), Box<dyn std::error::Error>> {
  let config = app.path().app_config_dir()?;
  let mut file = SettingsFile::open(&config);
  let registration = Registration::new(&app.package_info().name);
  if let Ok(registration) = &registration {
    let switches = file.settings().switches;
    match sign_in::align(switches.stated(Switch::StartAtSignIn), registration.is_set()) {
      Alignment::Adopt(on) => {
        let _ = file.set(Switch::StartAtSignIn, on);
      }
      Alignment::Register => {
        let _ = registration.set(true);
      }
      Alignment::Unregister => {
        let _ = registration.set(false);
      }
      Alignment::Keep => {}
    }
  }
  let switches = file.settings().switches;
  let channel = watch::Sender::new(file.settings().channel);
  let kept = record::read(&record::path(&config));
  let local = app.path().app_local_data_dir()?;
  let updates =
    updates.map(|feeds| (Updates::new(local.join("update"), Log::open(local.join("app.log"))), feeds));
  let started = updates
    .as_ref()
    .map(|(updates, _)| updates.started(&app.package_info().version.to_string()))
    .unwrap_or_default();
  let visible =
    kept.console.is_none() || (!started.hidden && sign_in::opens_window(std::env::args(), &switches));
  let autostart = tray(app, switches.on(Switch::StartAtSignIn), started.updated.as_deref())?;
  let feeds = match updates {
    Some((updates, Ok(feeds))) => Some((updates, feeds)),
    _ => None,
  };
  let (events, received) = mpsc::unbounded_channel();
  let shared = Arc::new(Shared {
    flow: Mutex::new(Flow::default()),
    lines: Mutex::new(Vec::new()),
    busy: Mutex::new(false),
    events: events.clone(),
    host: host_here(),
    record_file: record::path(&config),
    layout: Mutex::new(None),
    supervisor_env: Mutex::new(Vec::new()),
    supervisor: Mutex::new(None),
    settings: Mutex::new(file),
    registration,
    autostart,
    channel,
    updates: feeds.as_ref().map(|(updates, _)| updates.clone()),
  });
  app.manage(shared.clone());
  main_window(app, visible)?;
  let following = shared.channel.subscribe();
  tauri::async_runtime::spawn(course(app.handle().clone(), shared, received));
  let _ = events.send(Event::Began {
    console: kept.console,
    manager: kept.manager,
  });
  if let Some((updates, feeds)) = feeds {
    let handle = app.handle().clone();
    tauri::async_runtime::spawn(updates::keep_updated(handle.clone(), updates.clone(), feeds, following));
    tauri::async_runtime::spawn(updates::install_when_idle(handle, updates, idle, |app| async move {
      let shared = app.state::<Arc<Shared>>().inner().clone();
      stop_set(&shared).await;
    }));
  }
  Ok(())
}

pub fn main() {
  let context = tauri::generate_context!();
  let updates = context.config().plugins.0.get("updater").map(Feeds::from_updater_config);
  let mut builder =
    tauri::Builder::default().plugin(tauri_plugin_single_instance::init(|app, _, _| reveal(app)));
  if updates.is_some() {
    builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
  }
  let app = builder
    .invoke_handler(tauri::generate_handler![
      aio_view,
      aio_consent,
      aio_accept,
      aio_prerequisites,
      aio_retry,
      aio_input,
      aio_inputs_done,
      settings,
      change_setting
    ])
    .setup(move |app| setup(app, updates))
    .build(context)
    .expect("the app's configuration is valid");
  app.run(|_, event| {
    if let RunEvent::ExitRequested {
      code: None, api, ..
    } = event
    {
      api.prevent_exit();
    }
  });
}
