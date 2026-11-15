// The desktop app: BMO's web console in a window of its own, carrying a built-in jake agent.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod controller;
mod navigation;
mod pairing;
mod settings;
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
use tauri::{App, AppHandle, Manager, RunEvent, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as _};
use tauri_plugin_updater::UpdaterExt as _;
use tokio::sync::{mpsc, watch};
use url::Url;

use crate::controller::{Controller, show_console};
use crate::navigation::Navigation;
use crate::pairing::Console;
use crate::settings::Settings;
use crate::status::{Status, View};
use crate::vault::Vault;

const MAIN_WINDOW: &str = "main";
const TRAY: &str = "tray";
/// How often a running app asks the update feed.
const UPDATE_EVERY: Duration = Duration::from_secs(6 * 60 * 60);

/// What the commands, the tray and the quit share.
struct Shared {
  console: Arc<Console>,
  log: Log,
  status: watch::Sender<Status>,
  retries: mpsc::Sender<()>,
  quit: watch::Sender<bool>,
  course: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
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

fn main_window(app: &App, console: &Url, log: &Log) -> tauri::Result<()> {
  let (navigating, opening) =
    ((console.clone(), log.clone()), (console.clone(), log.clone(), app.handle().clone()));
  let window = WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::App("index.html".into()))
    .title("BMO")
    .inner_size(1280.0, 860.0)
    .min_inner_size(360.0, 560.0)
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
  // Closing the window hides it; the agent carries on until the tray's quit.
  let hidden = window.clone();
  window.on_window_event(move |event| {
    if let WindowEvent::CloseRequested { api, .. } = event {
      api.prevent_close();
      let _ = hidden.hide();
    }
  });
  Ok(())
}

fn tray(app: &App) -> tauri::Result<()> {
  let open = MenuItem::with_id(app, "open", "콘솔 열기", true, None::<&str>)?;
  let state = MenuItem::with_id(app, "status", "상태 보기", true, None::<&str>)?;
  let starting = app.autolaunch().is_enabled().unwrap_or(false);
  let autostart =
    CheckMenuItem::with_id(app, "autostart", "로그인할 때 시작", true, starting, None::<&str>)?;
  let quit = MenuItem::with_id(app, "quit", "종료", true, None::<&str>)?;
  let menu = Menu::with_items(
    app,
    &[
      &open,
      &state,
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
    .on_menu_event(move |app, event| match event.id().as_ref() {
      "open" => {
        reveal(app);
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
          let shared = app.state::<Shared>();
          show_console(&shared.console, &MainWindow(app.clone()), &shared.status, &shared.log).await;
        });
      }
      "status" => {
        reveal(app);
        controller::Window::open_local(&MainWindow(app.clone()));
      }
      "autostart" => {
        let wanted = autostart.is_checked().unwrap_or(false);
        let autolaunch = app.autolaunch();
        let done = if wanted { autolaunch.enable() } else { autolaunch.disable() };
        if let Err(error) = done {
          app
            .state::<Shared>()
            .log
            .warn("autostart-not-changed", json!({ "error": error.to_string() }));
          let _ = autostart.set_checked(!wanted);
        }
      }
      "quit" => stop_then(app, |app| app.exit(0)),
      _ => {}
    })
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
  Ok(())
}

/// Ask the update feed now and every few hours; an update whose signature verifies is installed and
/// the app starts again on it.
async fn keep_updated(app: AppHandle, log: Log) {
  loop {
    let found = match app.updater() {
      Ok(updater) => updater.check().await.map_err(|error| error.to_string()),
      Err(error) => Err(error.to_string()),
    };
    match found {
      Ok(Some(update)) => {
        log.info("update-found", json!({ "version": update.version }));
        match update.download_and_install(|_, _| {}, || {}).await {
          Ok(()) => {
            stop_then(&app, |app| app.restart());
            return;
          }
          Err(error) => log.warn("update-not-installed", json!({ "error": error.to_string() })),
        }
      }
      Ok(None) => {}
      Err(error) => log.warn("update-check-failed", json!({ "error": error })),
    }
    tokio::time::sleep(UPDATE_EVERY).await;
  }
}

fn setup(app: &mut App, updates: bool) -> Result<(), Box<dyn std::error::Error>> {
  let log = Log::open(app.path().app_local_data_dir()?.join("agent.log"));
  let settings = Settings::read(&app.path().app_config_dir()?).unwrap_or_else(|reason| {
    log.warn("settings-unreadable", json!({ "reason": reason }));
    Settings::defaults()
  });
  let console = Arc::new(Console::new(settings.console.clone()));
  let status = watch::Sender::new(Status::default());
  let (retries, retried) = mpsc::channel(1);
  let (quit, quitting) = watch::channel(false);

  main_window(app, console.base(), &log)?;
  tray(app)?;

  // The window's title and the tray's tooltip follow the status.
  let mut shown = status.subscribe();
  let handle = app.handle().clone();
  tauri::async_runtime::spawn(async move {
    loop {
      let now = shown.borrow_and_update().clone();
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
      retries: retried,
    }
    .run(),
  );
  if updates {
    tauri::async_runtime::spawn(keep_updated(app.handle().clone(), log.clone()));
  }
  app.manage(Shared {
    console,
    log,
    status,
    retries,
    quit,
    course: Mutex::new(Some(course)),
  });
  Ok(())
}

fn main() {
  let context = tauri::generate_context!();
  // The updater runs only once the owner's public key is written into the configuration.
  let updates = context.config().plugins.0.contains_key("updater");
  let mut builder = tauri::Builder::default()
    .plugin(tauri_plugin_single_instance::init(|app, _, _| reveal(app)))
    .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None));
  if updates {
    builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
  }
  let app = builder
    .invoke_handler(tauri::generate_handler![status, console, retry])
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
