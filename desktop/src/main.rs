// The desktop app: BMO's web console in a window of its own, carrying a built-in jake agent.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod awake;
mod bridge;
mod channel;
mod controller;
mod follow;
mod navigation;
mod pairing;
mod pause;
mod session;
mod settings;
mod sign_in;
mod status;
mod supervisor;
mod vault;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use jake_agent::Log;
use serde_json::json;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::NewWindowResponse;
use tauri::{App, AppHandle, Manager, RunEvent, State, WebviewUrl, WebviewWindowBuilder, WindowEvent, Wry};
use tauri_plugin_updater::UpdaterExt as _;
use tokio::sync::{mpsc, watch};
use url::Url;

use crate::channel::{Channel, Feeds};
use crate::controller::{Controller, show_console};
use crate::follow::follow;
use crate::navigation::Navigation;
use crate::pairing::Console;
use crate::settings::{Change, Key, SettingsFile, SettingsView, Switch, Switches};
use crate::sign_in::{Alignment, Registration};
use crate::status::{AgentState, Status, View};
use crate::vault::Vault;

const MAIN_WINDOW: &str = "main";
const TRAY: &str = "tray";
/// How often a running app asks its channel's update feed.
const UPDATE_EVERY: Duration = Duration::from_secs(6 * 60 * 60);

/// What the commands, the tray and the quit share.
struct Shared {
  console: Arc<Console>,
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
}

/// The status as the bundled page draws it.
#[tauri::command]
fn status(shared: State<'_, Shared>) -> View {
  shared.status.borrow().view()
}

/// Try the console again, and show it if it answers.
#[tauri::command]
async fn console(app: AppHandle, shared: State<'_, Shared>) -> Result<(), ()> {
  show_console(&shared.console, &MainWindow(app), &shared.status, &shared.log).await;
  Ok(())
}

/// Pair again, or look again for an installed agent or a credential store.
#[tauri::command]
fn retry(shared: State<'_, Shared>) {
  let _ = shared.retries.try_send(());
}

/// The settings as the console draws them, and who draws the window's controls; the bridge's read.
#[tauri::command]
fn settings(shared: State<'_, Shared>) -> SettingsView {
  settings_view(&shared)
}

/// Change one setting, a switch turned on or off or the update channel chosen; it is written and takes
/// effect at once. The key is read as a switch's or the channel's, `on` as a boolean and `value` as a
/// channel, or the call is refused; a key given the other's value, or none, and a switch this platform
/// does not offer are refused before anything is written.
#[tauri::command]
async fn change_setting(
  app: AppHandle,
  setting: Key,
  on: Option<bool>,
  value: Option<Channel>,
) -> Result<SettingsView, String> {
  match Change::read(setting, on, value)? {
    Change::Switch(switch, on) => change(&app, switch, on)?,
    Change::Channel(channel) => change_channel(&app, channel)?,
  }
  Ok(settings_view(&app.state::<Shared>()))
}

fn settings_view(shared: &Shared) -> SettingsView {
  let file = shared.settings.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
  shared.switches.borrow().view(*shared.channel.borrow(), file.unreadable())
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
  let shared = app.state::<Shared>();
  shared.quit.send_replace(true);
  let course = shared.course.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take();
  let app = app.clone();
  tauri::async_runtime::spawn(async move {
    if let Some(course) = course {
      let _ = course.await;
    }
    then(&app);
  });
}

/// Act on an item of the tray's menu.
fn on_menu(app: &AppHandle, id: &str) {
  match id {
    "open" => {
      reveal(app);
      let app = app.clone();
      tauri::async_runtime::spawn(async move {
        let shared = app.state::<Shared>();
        show_console(&shared.console, &MainWindow(app.clone()), &shared.status, &shared.log).await;
      });
    }
    "autostart" => {
      let shared = app.state::<Shared>();
      let wanted = shared.autostart.is_checked().unwrap_or(false);
      if let Err(error) = change(app, Switch::StartAtSignIn, wanted) {
        shared.log.warn("autostart-not-changed", json!({ "error": error }));
        let _ = shared.autostart.set_checked(!wanted);
      }
    }
    "quit" => stop_then(app, |app| app.exit(0)),
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

fn main_window(app: &App, console: &Url, log: &Log, visible: bool) -> tauri::Result<()> {
  let (navigating, opening) =
    ((console.clone(), log.clone()), (console.clone(), log.clone(), app.handle().clone()));
  let window = frameless(WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::App("index.html".into())))
    .title("BMO")
    .inner_size(1280.0, 860.0)
    .min_inner_size(360.0, 560.0)
    .visible(visible)
    .on_navigation(move |url| {
      let (console, log) = &navigating;
      match navigation::decide(url, console) {
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
      match navigation::decide(&url, console) {
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
        stop_then(app, |app| app.exit(0));
      }
    }
  });
  Ok(())
}

/// The tray icon and its menu; the starting-at-sign-in item is handed back to be kept in step.
fn tray(app: &App, starting: bool) -> tauri::Result<CheckMenuItem<Wry>> {
  let open = MenuItem::with_id(app, "open", "콘솔 열기", true, None::<&str>)?;
  let autostart =
    CheckMenuItem::with_id(app, "autostart", "로그인할 때 시작", true, starting, None::<&str>)?;
  let quit = MenuItem::with_id(app, "quit", "종료", true, None::<&str>)?;
  let menu = Menu::with_items(
    app,
    &[
      &open,
      &PredefinedMenuItem::separator(app)?,
      &autostart,
      &PredefinedMenuItem::separator(app)?,
      &quit,
    ],
  )?;
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

/// Ask the channel's update feed now, every few hours and whenever the channel changes; an update whose
/// signature verifies is installed and the app starts again on it. An update is taken only above the
/// running version, so a channel changed to stable waits for a release above the nightly it runs.
async fn keep_updated(app: AppHandle, log: Log, feeds: Feeds, mut channel: watch::Receiver<Channel>) {
  loop {
    let following = *channel.borrow_and_update();
    let found = match app
      .updater_builder()
      .endpoints(vec![feeds.of(following).clone()])
      .and_then(|builder| builder.build())
    {
      Ok(updater) => updater.check().await.map_err(|error| error.to_string()),
      Err(error) => Err(error.to_string()),
    };
    match found {
      Ok(Some(update)) => {
        log.info("update-found", json!({ "version": update.version, "channel": following }));
        match update.download_and_install(|_, _| {}, || {}).await {
          Ok(()) => {
            stop_then(&app, |app| app.restart());
            return;
          }
          Err(error) => log.warn("update-not-installed", json!({ "error": error.to_string() })),
        }
      }
      Ok(None) => {}
      Err(error) => log.warn("update-check-failed", json!({ "channel": following, "error": error })),
    }
    tokio::select! {
      () = tokio::time::sleep(UPDATE_EVERY) => {}
      changed = channel.changed() => {
        if changed.is_err() {
          return;
        }
      }
    }
  }
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
  let console = Arc::new(Console::new(settings.console.clone()));
  let status = watch::Sender::new(Status::default());
  let (retries, retried) = mpsc::channel(1);
  let (quit, quitting) = watch::channel(false);

  main_window(app, console.base(), &log, sign_in::opens_window(std::env::args(), &switches))?;
  // The console's pages get the bridge alone, scoped to the address the app opens (docs/desktop.md,
  // 「The window and what the console may call」).
  app.add_capability(bridge::capability(console.base(), MAIN_WINDOW))?;
  let autostart = tray(app, switches.on(Switch::StartAtSignIn))?;

  let switches = watch::Sender::new(switches);
  let channel = watch::Sender::new(settings.channel);
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

  let window = Arc::new(MainWindow(app.handle().clone()));
  let course = tauri::async_runtime::spawn(
    Controller {
      console: console.clone(),
      vault: Arc::new(Vault::for_console(console.base())),
      log: log.clone(),
      window,
      status: status.clone(),
      quit: quitting,
      paused: pausing,
      retries: retried,
    }
    .run(),
  );
  match updates {
    Some(Ok(feeds)) => {
      tauri::async_runtime::spawn(keep_updated(
        app.handle().clone(),
        log.clone(),
        feeds,
        channel.subscribe(),
      ));
    }
    Some(Err(reason)) => log.warn("update-feed-unreadable", json!({ "reason": reason })),
    None => {}
  }
  app.manage(Shared {
    console,
    log,
    status,
    retries,
    quit,
    course: Mutex::new(Some(course)),
    settings: Mutex::new(file),
    switches,
    channel,
    _locked: locked,
    autostart,
    registration,
  });
  Ok(())
}

fn main() {
  let context = tauri::generate_context!();
  // The updater runs only once the owner's public key is written into the configuration, and reads the
  // feed of the channel the settings name beside the endpoint it gives (docs/desktop.md, 「The update
  // channel」).
  let updates = context.config().plugins.0.get("updater").map(Feeds::from_updater_config);
  let mut builder =
    tauri::Builder::default().plugin(tauri_plugin_single_instance::init(|app, _, _| reveal(app)));
  if updates.is_some() {
    builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
  }
  let app = builder
    .invoke_handler(tauri::generate_handler![status, console, retry, settings, change_setting])
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
