// The remote controller: a BMO server's hosted console in a window of its own, carrying a built-in jake
// agent (docs/desktop.md).

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use jake_agent::Log;
use jake_agent::installed::Installed;
use serde_json::{Value, json};
use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::NewWindowResponse;
use tauri::{App, AppHandle, Manager, RunEvent, State, WebviewUrl, WebviewWindowBuilder, WindowEvent, Wry};
use tauri_plugin_deep_link::DeepLinkExt;
use tokio::sync::{mpsc, oneshot, watch};
use url::Url;

use crate::channel::{Channel, Feeds};
use crate::controller::{Controller, show_console};
use crate::follow::follow;
use crate::link::{Invitation, Invited};
use crate::navigation::Navigation;
use crate::pairing::Console;
use crate::settings::{Change, Key, SettingsFile, SettingsView, Switch, Switches};
use crate::sign_in::{Alignment, Registration};
use crate::status::{AgentState, Status, View};
use crate::updates::{Moment, Updates};
use crate::vault::Vault;
use crate::{awake, bridge, controller, link, navigation, pause, server, session, sign_in, updates, vault};

const MAIN_WINDOW: &str = "main";
const TRAY: &str = "tray";

/// What the commands, the tray and the quit share.
struct Shared {
  /// The console the app runs on, none while the settings name no server.
  console: Option<Arc<Console>>,
  log: Log,
  status: watch::Sender<Status>,
  retries: mpsc::Sender<()>,
  quit: watch::Sender<bool>,
  course: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
  settings: Mutex<SettingsFile>,
  switches: watch::Sender<Switches>,
  /// The update channel, which the updates follow.
  channel: watch::Sender<Channel>,
  /// Held so the lock's watch stays open on a platform that reports no lock.
  _locked: watch::Sender<bool>,
  /// The tray's starting-at-sign-in item, kept in step with the console's section.
  autostart: CheckMenuItem<Wry>,
  /// The person's sign-in registration, or why it cannot be made.
  registration: Result<Registration, String>,
  /// How much work the built-in agent carries for the hub.
  carrying: watch::Sender<usize>,
  /// The app's quiet updates, where its build checks for any.
  updates: Option<Arc<Updates>>,
  /// The invitation a link hands the course for its pairing (docs/desktop.md, 「Opening from a link」).
  invitations: watch::Sender<Option<Invited>>,
  /// Whether a link's question to change the server stands, so a second link is not asked over it.
  asking: AtomicBool,
  /// The app's config directory, where the settings and the pending invitation are kept.
  config_dir: PathBuf,
}

/// The main window, as the controller asks things of it.
struct MainWindow(AppHandle);

impl controller::Window for MainWindow {
  fn open(&self, url: &Url) {
    if let Some(window) = self.0.get_webview_window(MAIN_WINDOW) {
      let _ = window.navigate(url.clone());
    }
  }

  fn open_local(&self) {
    self.open(&navigation::local_page());
  }

  fn tell(&self, message: String) {
    let app = self.0.clone();
    tauri::async_runtime::spawn(async move {
      message_box(&app, message, Buttons::Ok).await;
    });
  }
}

/// The answers a message box offers.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Buttons {
  Ok,
  YesNo,
}

/// Show a native message box over the main window, made on the main thread as the system's toolkit asks and
/// waited on apart from it; whether the person answered yes.
async fn message_box(app: &AppHandle, message: String, buttons: Buttons) -> bool {
  let (answer, answered) = oneshot::channel();
  let handle = app.clone();
  let shown = app.run_on_main_thread(move || {
    let mut dialog = rfd::AsyncMessageDialog::new()
      .set_title("BMO")
      .set_description(message)
      .set_level(match buttons {
        Buttons::Ok => rfd::MessageLevel::Warning,
        Buttons::YesNo => rfd::MessageLevel::Info,
      })
      .set_buttons(match buttons {
        Buttons::Ok => rfd::MessageButtons::Ok,
        Buttons::YesNo => rfd::MessageButtons::YesNo,
      });
    if let Some(window) = handle.get_webview_window(MAIN_WINDOW) {
      dialog = dialog.set_parent(&window);
    }
    let shown = dialog.show();
    std::thread::spawn(move || {
      let _ = answer.send(tauri::async_runtime::block_on(shown));
    });
  });
  shown.is_ok() && answered.await == Ok(rfd::MessageDialogResult::Yes)
}

/// The status as the bundled page draws it.
#[tauri::command]
fn status(shared: State<'_, Shared>) -> View {
  shared.status.borrow().view()
}

/// Try the console again, and show it if it answers; with no server named there is none to try.
#[tauri::command]
async fn console(app: AppHandle, shared: State<'_, Shared>) -> Result<(), ()> {
  if let Some(console) = &shared.console {
    show_console(console, &MainWindow(app), &shared.status, &shared.log).await;
  }
  Ok(())
}

/// Name the server the app connects to, from the bundled page: true where the app now starts again on
/// it, false where it is the server the app runs on. A refusal says why in the person's words.
#[tauri::command]
async fn set_console(app: AppHandle, address: String) -> Result<bool, String> {
  change_console(&app, &address).await
}

/// Pair again, or look again for an installed agent or a credential store.
#[tauri::command]
fn retry(shared: State<'_, Shared>) {
  let _ = shared.retries.try_send(());
}

/// Stop the installed agent the app is held off for through its own uninstaller, and start the built-in one
/// (docs/desktop.md, 「One agent per name」).
#[tauri::command]
async fn switch_agent(shared: State<'_, Shared>) -> Result<(), ()> {
  controller::switch_to_built_in(
    &shared.status,
    &shared.retries,
    &shared.log,
    jake_agent::installed::installed_agent,
    Installed::uninstall,
  )
  .await;
  Ok(())
}

/// The settings as the console draws them, and who draws the window's controls; the bridge's read.
#[tauri::command]
fn settings(shared: State<'_, Shared>) -> SettingsView {
  settings_view(&shared)
}

/// Change one setting, a switch turned on or off, the update channel chosen or the server named; it is
/// written and takes effect at once, the server by the app starting again on it. The key is read as a
/// switch's, the channel's or the server's and `on` as a boolean, or the call is refused; a key given
/// the other kind's value, or none, a value of the wrong kind and a switch this platform does not offer
/// are refused before anything is written.
#[tauri::command]
async fn change_setting(
  app: AppHandle,
  setting: Key,
  on: Option<bool>,
  value: Option<Value>,
) -> Result<SettingsView, String> {
  match Change::read(setting, on, value)? {
    Change::Switch(switch, on) => change(&app, switch, on)?,
    Change::Channel(channel) => change_channel(&app, channel)?,
    Change::Console(address) => {
      change_console(&app, &address).await?;
    }
  }
  Ok(settings_view(&app.state::<Shared>()))
}

fn settings_view(shared: &Shared) -> SettingsView {
  let file = shared.settings.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
  // The server the file names, which is the one the app runs on until a change starts it again on another.
  let console = file.settings().console;
  shared
    .switches
    .borrow()
    .view(*shared.channel.borrow(), console.as_ref(), file.unreadable())
}

/// Name the server the app connects to: the address is read, asked whether it is a BMO console and
/// written; the credential paired with the server before it is forgotten, and the app starts again on
/// the new one, which pairs anew. The app starts again because the bridge granted to the old server's
/// origin cannot be withdrawn while it runs. The same address changes nothing; whether the app starts
/// again is the answer.
async fn change_console(app: &AppHandle, address: &str) -> Result<bool, String> {
  move_to(app, server::entered(address)?, None).await
}

/// Move to the server at `console`, as a change of server does; an invitation a link carried is kept for the new
/// start, which pairs with it.
async fn move_to(app: &AppHandle, console: Url, invitation: Option<&Invitation>) -> Result<bool, String> {
  let shared = app.state::<Shared>();
  let before = shared.console.as_ref().map(|before| before.base().clone());
  if before.as_ref() == Some(&console) {
    return Ok(false);
  }
  Console::new(console.clone()).answers_as_bmo().await?;
  {
    let mut file = shared.settings.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(reason) = file.unreadable() {
      return Err(format!("설정 파일을 읽을 수 없어 변경할 수 없습니다. {reason}"));
    }
    file.set_console(&console)?;
  }
  shared.log.info(
    "server-changed",
    json!({ "from": before.as_ref().map(Url::as_str), "to": console.as_str() }),
  );
  if let Some(before) = before {
    let forgotten = tokio::task::spawn_blocking(move || Vault::for_console(&before).forget()).await;
    if let Ok(Err(vault::NoStore(reason))) = forgotten {
      shared.log.warn("credential-not-forgotten", json!({ "reason": reason }));
    }
  }
  // An invitation that cannot be kept leaves the new start to pair as any first start does.
  if let Some(invitation) = invitation
    && let Err(error) = link::keep_pending(&shared.config_dir, invitation, SystemTime::now())
  {
    shared.log.warn("invitation-not-kept", json!({ "error": error.to_string() }));
  }
  stop_then(app, restart);
  Ok(true)
}

/// Start the app again with the arguments it was started with but a link, which the new start must not act on
/// again: what it carries crosses in the pending file alone.
fn restart(app: &AppHandle) {
  let mut env = app.env();
  env.args_os = env
    .args_os
    .into_iter()
    .enumerate()
    .filter(|(at, arg)| *at == 0 || !link::is_link(arg))
    .map(|(_, arg)| arg)
    .collect();
  let handle = app.clone();
  // The runtime's own restart frees what the app holds, the single-instance lock among it, on the main thread
  // before it starts the new process; this does the same with the arguments it is given.
  if app
    .run_on_main_thread(move || {
      handle.cleanup_before_exit();
      tauri::process::restart(&env);
    })
    .is_err()
  {
    app.restart();
  }
}

/// Act on a link the app was handed (docs/desktop.md, 「Opening from a link」): one refused is logged and said; one
/// to the server the app runs on hands its invitation to the course; one to another server asks the person, once,
/// before the app moves to it.
async fn open_link(app: AppHandle, link: String) {
  let shared = app.state::<Shared>();
  reveal(&app);
  let invitation = match link::read(&link) {
    Ok(invitation) => invitation,
    Err(reason) => {
      shared.log.warn("link-refused", json!({ "reason": reason }));
      message_box(&app, format!("이 링크를 열 수 없습니다.\n{reason}"), Buttons::Ok).await;
      return;
    }
  };
  let before = shared.console.as_ref().map(|console| console.base().clone());
  if before.as_ref() == Some(&invitation.server) {
    hand_to_course(&shared, invitation);
    return;
  }
  if shared.asking.swap(true, Ordering::SeqCst) {
    shared
      .log
      .info("link-ignored-while-asking", json!({ "server": invitation.server.as_str() }));
    return;
  }
  let mut question = format!("이 서버에 연결할까요?\n{}", authority(&invitation.server));
  if let Some(before) = &before {
    question.push_str(&format!(
      "\n\n지금 연결된 서버({})의 연결 정보는 이 앱에서 삭제됩니다.",
      authority(before)
    ));
  }
  let yes = message_box(&app, question, Buttons::YesNo).await;
  shared
    .log
    .info("link-asked", json!({ "server": invitation.server.as_str(), "yes": yes }));
  if yes && let Err(reason) = move_to(&app, invitation.server.clone(), Some(&invitation)).await {
    shared
      .log
      .warn("link-server-refused", json!({ "server": invitation.server.as_str(), "reason": reason }));
    message_box(&app, format!("이 서버에 연결하지 못했습니다.\n{reason}"), Buttons::Ok).await;
  }
  shared.asking.store(false, Ordering::SeqCst);
}

/// A server's host and port, as the person is shown it.
fn authority(server: &Url) -> String {
  match (server.host_str(), server.port()) {
    (Some(host), Some(port)) => format!("{host}:{port}"),
    (Some(host), None) => host.to_owned(),
    (None, _) => server.to_string(),
  }
}

/// Hand an invitation for the server the app runs on to the course: a pairing open or opening is approved with
/// it, and a course stopped on a failed pairing pairs again. A machine already paired has nothing to pair.
fn hand_to_course(shared: &Shared, invitation: Invitation) {
  let agent = shared.status.borrow().agent.clone();
  match agent {
    AgentState::Starting | AgentState::Pairing { .. } | AgentState::PairingFailed(_) => {
      shared.log.info("invitation-handed", json!({ "server": invitation.server.as_str() }));
      shared.invitations.send_replace(Some(Invited::new(invitation.invite)));
      if matches!(agent, AgentState::PairingFailed(_)) {
        let _ = shared.retries.try_send(());
      }
    }
    state => shared.log.info(
      "link-nothing-to-pair",
      json!({ "server": invitation.server.as_str(), "state": format!("{state:?}") }),
    ),
  }
}

/// Write the update channel and hand it to the updates, which ask its feed at once.
fn change_channel(app: &AppHandle, channel: Channel) -> Result<(), String> {
  let shared = app.state::<Shared>();
  let mut file = shared.settings.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
  if let Some(reason) = file.unreadable() {
    return Err(reason.to_owned());
  }
  file.set_channel(channel)?;
  drop(file);
  shared.channel.send_replace(channel);
  Ok(())
}

/// Write a setting and hand it to what acts on it; starting at sign-in is registered first, and a
/// registration the system refuses changes nothing.
fn change(app: &AppHandle, switch: Switch, on: bool) -> Result<(), String> {
  let shared = app.state::<Shared>();
  let mut file = shared.settings.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
  if let Some(reason) = file.unreadable() {
    return Err(reason.to_owned());
  }
  let signing_in = switch == Switch::StartAtSignIn;
  if signing_in {
    shared.registration.as_ref().map_err(String::clone)?.set(on)?;
  }
  let switches = file.set(switch, on).inspect_err(|_| {
    if let (true, Ok(registration)) = (signing_in, &shared.registration) {
      let _ = registration.set(!on);
    }
  })?;
  drop(file);
  shared.switches.send_replace(switches);
  if signing_in {
    let _ = shared.autostart.set_checked(on);
  }
  Ok(())
}

/// Bring the sign-in registration into line with the setting as the app starts; the switches as they
/// then stand.
fn align_sign_in(
  registration: &Result<Registration, String>,
  file: &mut SettingsFile,
  log: &Log,
) -> Switches {
  let switches = file.settings().switches;
  let registration = match registration {
    Ok(registration) => registration,
    Err(reason) => {
      log.warn("autostart-unavailable", json!({ "reason": reason }));
      return switches;
    }
  };
  let alignment = sign_in::align(switches.stated(Switch::StartAtSignIn), registration.is_set());
  let registering = match alignment {
    Alignment::Adopt(on) => {
      return file
        .set(Switch::StartAtSignIn, on)
        .unwrap_or_else(|_| switches.with(Switch::StartAtSignIn, on));
    }
    Alignment::Keep => return switches,
    Alignment::Register => registration.set(true),
    Alignment::Unregister => registration.set(false),
  };
  if let Err(error) = registering {
    log.warn(
      "autostart-not-aligned",
      json!({ "alignment": format!("{alignment:?}"), "error": error }),
    );
  }
  switches
}

fn reveal(app: &AppHandle) {
  if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
  }
}

fn open_in_browser(url: &Url, log: &Log) {
  if let Err(error) = tauri_plugin_opener::open_url(url.as_str(), None::<&str>) {
    log.warn("browser-not-opened", json!({ "url": url.as_str(), "error": error.to_string() }));
  }
}

/// Stop the built-in agent and wait for its course to end, then hand over to `then`.
fn stop_then(app: &AppHandle, then: impl FnOnce(&AppHandle) + Send + 'static) {
  let app = app.clone();
  tauri::async_runtime::spawn(async move {
    stop_agent(&app).await;
    then(&app);
  });
}

/// Stop the built-in agent and wait for its course to end.
async fn stop_agent(app: &AppHandle) {
  let course = {
    let shared = app.state::<Shared>();
    shared.quit.send_replace(true);
    shared.course.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take()
  };
  if let Some(course) = course {
    let _ = course.await;
  }
}

/// Quit: the built-in agent stopped, an update kept for its moment installed, then the app ended.
fn quit(app: &AppHandle) {
  let app = app.clone();
  tauri::async_runtime::spawn(async move {
    stop_agent(&app).await;
    let updates = app.state::<Shared>().updates.clone();
    if let Some(updates) = updates {
      updates.install(&app, Moment::Quit, || async {}).await;
    }
    app.exit(0);
  });
}

/// Whether the app is quiet enough to be replaced: no window shown, no pairing open and nothing the agent carries.
fn idle(app: &AppHandle) -> bool {
  let Some(shared) = app.try_state::<Shared>() else {
    return false;
  };
  let hidden = app
    .get_webview_window(MAIN_WINDOW)
    .is_none_or(|window| !window.is_visible().unwrap_or(true));
  let pairing = matches!(shared.status.borrow().agent, AgentState::Pairing { .. });
  hidden && !pairing && *shared.carrying.borrow() == 0
}

/// Act on an item of the tray's menu.
fn on_menu(app: &AppHandle, id: &str) {
  match id {
    "open" => {
      reveal(app);
      let app = app.clone();
      tauri::async_runtime::spawn(async move {
        let shared = app.state::<Shared>();
        if let Some(console) = &shared.console {
          show_console(console, &MainWindow(app.clone()), &shared.status, &shared.log).await;
        }
      });
    }
    "server" => {
      reveal(app);
      controller::Window::open(&MainWindow(app.clone()), &navigation::server_page());
    }
    "autostart" => {
      let shared = app.state::<Shared>();
      let wanted = shared.autostart.is_checked().unwrap_or(false);
      if let Err(error) = change(app, Switch::StartAtSignIn, wanted) {
        shared.log.warn("autostart-not-changed", json!({ "error": error }));
        let _ = shared.autostart.set_checked(!wanted);
      }
    }
    "quit" => quit(app),
    _ => {}
  }
}

/// The window with no native title bar or menu bar (docs/desktop.md, 「The window's frame」): undecorated,
/// the page drawing the controls, where Tauri offers no overlay title bar; on macOS an overlay title
/// bar with its title hidden, the system's buttons inset over the page.
#[cfg(not(target_os = "macos"))]
fn frameless<'a>(builder: WebviewWindowBuilder<'a, Wry, App>) -> WebviewWindowBuilder<'a, Wry, App> {
  builder.decorations(false)
}

#[cfg(target_os = "macos")]
fn frameless<'a>(builder: WebviewWindowBuilder<'a, Wry, App>) -> WebviewWindowBuilder<'a, Wry, App> {
  builder.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true)
}

fn main_window(app: &App, console: Option<&Url>, log: &Log, visible: bool) -> tauri::Result<()> {
  let console = console.cloned();
  let (navigating, opening) =
    ((console.clone(), log.clone()), (console, log.clone(), app.handle().clone()));
  let window = frameless(WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::App("index.html".into())))
    .title("BMO")
    .inner_size(1280.0, 860.0)
    .min_inner_size(360.0, 560.0)
    .visible(visible)
    .on_navigation(move |url| {
      let (console, log) = &navigating;
      match navigation::decide(url, console.as_ref()) {
        Navigation::Stay => true,
        Navigation::Browser => {
          open_in_browser(url, log);
          false
        }
        Navigation::Refuse => false,
      }
    })
    .on_new_window(move |url, _| {
      let (console, log, app) = &opening;
      match navigation::decide(&url, console.as_ref()) {
        Navigation::Stay => {
          if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
            let _ = window.navigate(url);
          }
        }
        Navigation::Browser => open_in_browser(&url, log),
        Navigation::Refuse => {}
      }
      NewWindowResponse::Deny
    })
    .build()?;
  // Closing the window hides it, the agent carrying on until the tray's quit, unless the settings say
  // closing quits.
  let closing = window.clone();
  window.on_window_event(move |event| {
    if let WindowEvent::CloseRequested { api, .. } = event {
      api.prevent_close();
      let app = closing.app_handle();
      let to_tray = app
        .try_state::<Shared>()
        .is_none_or(|shared| shared.switches.borrow().on(Switch::CloseToTray));
      if to_tray {
        let _ = closing.hide();
      } else {
        quit(app);
      }
    }
  });
  Ok(())
}

/// The tray icon and its menu, opening with the quiet line of the version the app updated itself to where it did;
/// the starting-at-sign-in item is handed back to be kept in step.
fn tray(app: &App, starting: bool, updated: Option<&str>) -> tauri::Result<CheckMenuItem<Wry>> {
  let updated = updated
    .map(|version| MenuItem::with_id(app, "updated", updates::updated_line(version), false, None::<&str>))
    .transpose()?;
  let open = MenuItem::with_id(app, "open", "콘솔 열기", true, None::<&str>)?;
  let server = MenuItem::with_id(app, "server", "서버 변경", true, None::<&str>)?;
  let autostart =
    CheckMenuItem::with_id(app, "autostart", "로그인할 때 시작", true, starting, None::<&str>)?;
  let quit = MenuItem::with_id(app, "quit", "종료", true, None::<&str>)?;
  let (first, second) = (PredefinedMenuItem::separator(app)?, PredefinedMenuItem::separator(app)?);
  let after_update = PredefinedMenuItem::separator(app)?;
  let mut items: Vec<&dyn IsMenuItem<Wry>> = Vec::new();
  if let Some(updated) = &updated {
    items.extend([updated as &dyn IsMenuItem<Wry>, &after_update]);
  }
  items.extend([&open as &dyn IsMenuItem<Wry>, &server, &first, &autostart, &second, &quit]);
  let menu = Menu::with_items(app, &items)?;
  let icon = app
    .default_window_icon()
    .cloned()
    .ok_or(tauri::Error::InvalidIcon(std::io::Error::other("the app carries no icon")))?;
  TrayIconBuilder::with_id(TRAY)
    .icon(icon)
    .tooltip("BMO")
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

fn setup(app: &mut App, updates: Option<Result<Feeds, String>>) -> Result<(), Box<dyn std::error::Error>> {
  let log = Log::open(app.path().app_local_data_dir()?.join("agent.log"));
  let mut file = SettingsFile::open(&app.path().app_config_dir()?);
  if let Some(reason) = file.unreadable() {
    log.warn("settings-unreadable", json!({ "reason": reason }));
  }
  let settings = file.settings();
  let registration = Registration::new(&app.package_info().name);
  let switches = align_sign_in(&registration, &mut file, &log);
  let console = settings.console.clone().map(|base| Arc::new(Console::new(base)));
  let base = console.as_ref().map(|console| console.base().clone());
  let status = watch::Sender::new(Status::default());
  if console.is_none() {
    status.send_modify(|status| status.agent = AgentState::NoServer);
  }
  // An invitation carried across the start that moved the app to this server pairs it (docs/desktop.md,
  // 「Opening from a link」); the file is taken whatever it holds, so it is acted on once at most.
  let config_dir = app.path().app_config_dir()?;
  let invitations = watch::Sender::new(None);
  match link::take_pending(&config_dir, SystemTime::now()) {
    Ok(Some(pending)) if Some(&pending.server) == base.as_ref() => {
      log.info("invitation-carried", json!({ "server": pending.server.as_str() }));
      invitations.send_replace(Some(Invited::new(pending.invite)));
    }
    Ok(Some(pending)) => log.warn("invitation-dropped", json!({ "server": pending.server.as_str() })),
    Ok(None) => {}
    Err(reason) => log.warn("invitation-unreadable", json!({ "reason": reason })),
  }
  let (retries, retried) = mpsc::channel(1);
  let (quit, quitting) = watch::channel(false);
  let kept = app.path().app_local_data_dir()?.join("update");
  let updates = updates.map(|feeds| (Updates::new(kept, log.clone()), feeds));
  let started = updates
    .as_ref()
    .map(|(updates, _)| updates.started(&app.package_info().version.to_string()))
    .unwrap_or_default();

  // With no server named the window always opens, since only the person can name one; started again by a quiet
  // update, the app opens none, as its window was hidden when it was replaced.
  let visible =
    console.is_none() || (!started.hidden && sign_in::opens_window(std::env::args(), &switches));
  main_window(app, base.as_ref(), &log, visible)?;
  // The console's pages get the bridge alone, scoped to the address the app opens, and no page any
  // while it names none (docs/desktop.md, 「The window and what the console may call」).
  if let Some(capability) = bridge::for_server(base.as_ref(), MAIN_WINDOW) {
    app.add_capability(capability)?;
  }
  let autostart = tray(app, switches.on(Switch::StartAtSignIn), started.updated.as_deref())?;

  let switches = watch::Sender::new(switches);
  let channel = watch::Sender::new(settings.channel);
  let carrying = watch::Sender::new(0);
  let locked = watch::Sender::new(false);
  session::report(locked.clone(), log.clone());
  let paused = watch::Sender::new(false);
  let pausing = paused.subscribe();
  tauri::async_runtime::spawn(follow(locked.subscribe(), switches.subscribe(), pause::paused, paused));
  let awake = watch::Sender::new(false);
  let staying_awake = awake.subscribe();
  tauri::async_runtime::spawn(follow(switches.subscribe(), status.subscribe(), awake::wanted, awake));
  tauri::async_runtime::spawn(awake::hold(staying_awake, log.clone()));

  // The window's title and the tray's tooltip follow the status, and a pairing, which needs the
  // person, shows the window.
  let mut shown = status.subscribe();
  let handle = app.handle().clone();
  tauri::async_runtime::spawn(async move {
    let mut pairing = false;
    loop {
      let now = shown.borrow_and_update().clone();
      let pairs = matches!(now.agent, AgentState::Pairing { .. });
      if pairs && !pairing {
        reveal(&handle);
      }
      pairing = pairs;
      if let Some(window) = handle.get_webview_window(MAIN_WINDOW) {
        let _ = window.set_title(&now.title());
      }
      if let Some(tray) = handle.tray_by_id(TRAY) {
        let _ = tray.set_tooltip(Some(now.tooltip()));
      }
      if shown.changed().await.is_err() {
        return;
      }
    }
  });

  // The built-in agent's hello names the app's own instance, kept beside the settings (docs/desktop.md, 「Pairing」).
  let (instance, unkept) =
    jake_agent::instance::kept_at(&app.path().app_config_dir()?.join("agent-instance"));
  if let Some(reason) = unkept {
    log.warn("instance-not-kept", json!({ "reason": reason }));
  }
  // It names the machine too, kept beside the instance where reading it starts a Windows program (docs/desktop.md,
  // 「Pairing」).
  let machine = jake_agent::machine::fingerprint(&app.path().app_config_dir()?.join("agent-machine"));
  if let Some(reason) = &machine.unkept {
    log.warn("machine-not-kept", json!({ "reason": reason }));
  }

  // The course runs on a named server alone; with none, the bundled page asks for one and the app starts
  // again on it.
  let course = console.clone().map(|console| {
    let vault = Arc::new(Vault::for_console(console.base()));
    tauri::async_runtime::spawn(
      Controller {
        console,
        vault,
        log: log.clone(),
        window: Arc::new(MainWindow(app.handle().clone())),
        status: status.clone(),
        quit: quitting,
        paused: pausing,
        retries: retried,
        carrying: carrying.clone(),
        instance: instance.clone(),
        machine: machine.fingerprint.clone(),
        invitations: invitations.clone(),
      }
      .run(),
    )
  });
  let updates = match updates {
    Some((updates, Ok(feeds))) => {
      let handle = app.handle().clone();
      tauri::async_runtime::spawn(updates::keep_updated(
        handle.clone(),
        updates.clone(),
        feeds,
        channel.subscribe(),
      ));
      tauri::async_runtime::spawn(updates::install_when_idle(
        handle,
        updates.clone(),
        idle,
        |app| async move {
          stop_agent(&app).await;
        },
      ));
      Some(updates)
    }
    Some((_, Err(reason))) => {
      log.warn("update-feed-unreadable", json!({ "reason": reason }));
      None
    }
    None => None,
  };
  app.manage(Shared {
    console,
    log,
    status,
    retries,
    quit,
    course: Mutex::new(course),
    settings: Mutex::new(file),
    switches,
    channel,
    _locked: locked,
    autostart,
    registration,
    carrying,
    updates,
    invitations,
    asking: AtomicBool::new(false),
    config_dir,
  });
  links(app, started.hidden);
  Ok(())
}

/// Take the app's links (docs/desktop.md, 「Opening from a link」): those a running app is handed, and the one it was
/// started with, unless a quiet update started it again with its first start's arguments. An AppImage, which no
/// installer registers, and a development build register the scheme themselves.
fn links(app: &App, updated_quietly: bool) {
  let deep_link = app.deep_link();
  let handle = app.handle().clone();
  deep_link.on_open_url(move |event| {
    for url in event.urls() {
      tauri::async_runtime::spawn(open_link(handle.clone(), url.to_string()));
    }
  });
  let started_with = deep_link.get_current().ok().flatten().unwrap_or_default();
  if !updated_quietly {
    for url in started_with {
      tauri::async_runtime::spawn(open_link(app.handle().clone(), url.to_string()));
    }
  }
  #[cfg(target_os = "linux")]
  let appimage = app.env().appimage.is_some();
  #[cfg(not(target_os = "linux"))]
  let appimage = false;
  let unregistered = cfg!(debug_assertions) || appimage;
  if unregistered && let Err(error) = deep_link.register_all() {
    app
      .state::<Shared>()
      .log
      .warn("link-scheme-not-registered", json!({ "error": error.to_string() }));
  }
}

pub fn main() {
  let context = tauri::generate_context!();
  // The updater runs only once the owner's public key is written into the configuration, and reads the
  // feed of the channel the settings name beside the endpoint it gives (docs/desktop.md, 「The update
  // channel」).
  let updates = context.config().plugins.0.get("updater").map(Feeds::from_updater_config);
  // The single instance comes first, and hands a link a second launch carries to the deep links before it shows
  // the window (docs/desktop.md, 「Opening from a link」).
  let mut builder = tauri::Builder::default()
    .plugin(tauri_plugin_single_instance::init(|app, _, _| reveal(app)))
    .plugin(tauri_plugin_deep_link::init());
  if updates.is_some() {
    builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
  }
  let app = builder
    .invoke_handler(tauri::generate_handler![
      status,
      console,
      retry,
      switch_agent,
      settings,
      change_setting,
      set_console
    ])
    .setup(move |app| setup(app, updates))
    .build(context)
    .expect("the app's configuration is valid");
  app.run(|_, event| {
    // The window only hides, so an exit with no code is the runtime's own and is held off.
    if let RunEvent::ExitRequested {
      code: None, api, ..
    } = event
    {
      api.prevent_exit();
    }
  });
}
