// Quiet updates: checked and downloaded in the background, installed at a quiet moment, the app started again as it was.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use jake_agent::Log;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::AppHandle;
use tauri::utils::config::BundleType;
use tauri_plugin_updater::{Update, UpdaterExt as _};
use tokio::sync::watch;

use crate::channel::{Channel, Feeds};

/// How often a running app asks its channel's update feed.
const UPDATE_EVERY: Duration = Duration::from_secs(6 * 60 * 60);
/// How far apart the two looks are that find the app idle.
const IDLE_LOOK: Duration = Duration::from_secs(60);
/// The record a quiet install leaves for the app it starts.
const RECORD_FILE: &str = "installing.json";

/// When a kept update is installed (docs/desktop.md, 「Updating quietly」).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Moment {
  /// The person quits: the update is installed and the app ends.
  Quit,
  /// The app stands idle: the update is installed and the app starts again on it, its window hidden.
  Idle,
}

/// What an install leaves for the app it starts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
  from: String,
  to: String,
  /// Whether the app starts itself again, at an idle moment, with its window hidden.
  restart: bool,
}

/// What the record of an install says to the app as it starts.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Started {
  /// The version the app was updated to, where it now runs it.
  pub updated: Option<String>,
  /// Whether the app was started again by an install, and so opens no window.
  pub hidden: bool,
}

/// An update downloaded and checked, waiting for its moment.
struct Kept {
  update: Update,
  file: PathBuf,
}

/// The app's updates: the one kept, and where it and the record stand.
pub struct Updates {
  dir: PathBuf,
  log: Log,
  kept: Mutex<Option<Kept>>,
  keeping: watch::Sender<bool>,
  installing: AtomicBool,
}

/// Whether this build installs its own updates: Windows's installer and a Linux AppImage do; a deb or an rpm is
/// the system's package manager's, and a build of no installer format has nothing to replace.
pub fn installs_itself() -> bool {
  cfg!(windows) || tauri::utils::platform::bundle_type() == Some(BundleType::AppImage)
}

/// The tray's line once the app has updated itself, in the system's language.
pub fn updated_line(version: &str) -> String {
  updated_line_in(&sys_locale::get_locale().unwrap_or_default(), version)
}

fn updated_line_in(locale: &str, version: &str) -> String {
  let language = locale.to_ascii_lowercase();
  if language.starts_with("ko") {
    format!("업데이트됨 · v{version}")
  } else if language.starts_with("ja") {
    format!("アップデート済み · v{version}")
  } else if language.starts_with("zh") {
    format!("已更新 · v{version}")
  } else {
    format!("Updated · v{version}")
  }
}

/// A version as a file's name: letters, digits, dots and dashes kept, anything else a dash.
fn file_name_of(version: &str) -> String {
  let name: String = version
    .chars()
    .map(|character| if character.is_ascii_alphanumeric() || character == '.' { character } else { '-' })
    .collect();
  format!("{name}.update")
}

/// Writes a file whole by a rename.
fn write_whole(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
  let partial = path.with_extension("partial");
  std::fs::write(&partial, bytes)?;
  std::fs::rename(&partial, path)
}

impl Updates {
  /// The updates kept under `dir`, the app's local data folder's own.
  pub fn new(dir: PathBuf, log: Log) -> Arc<Self> {
    Arc::new(Self {
      dir,
      log,
      kept: Mutex::new(None),
      keeping: watch::Sender::new(false),
      installing: AtomicBool::new(false),
    })
  }

  fn record_path(&self) -> PathBuf {
    self.dir.join(RECORD_FILE)
  }

  /// Read and take away the record an install left, as the app starts on `running`.
  pub fn started(&self, running: &str) -> Started {
    let path = self.record_path();
    let Ok(text) = std::fs::read(&path) else {
      return Started::default();
    };
    let _ = std::fs::remove_file(&path);
    let Ok(record) = serde_json::from_slice::<Record>(&text) else {
      return Started::default();
    };
    if record.to == running {
      self.log.info("updated", json!({ "from": record.from, "to": record.to }));
      Started {
        updated: Some(record.to),
        hidden: record.restart,
      }
    } else {
      self
        .log
        .warn("update-not-installed", json!({ "running": running, "wanted": record.to }));
      Started {
        updated: None,
        hidden: record.restart,
      }
    }
  }

  /// The version kept for its moment, if any.
  fn kept_version(&self) -> Option<String> {
    self
      .kept
      .lock()
      .unwrap_or_else(std::sync::PoisonError::into_inner)
      .as_ref()
      .map(|kept| kept.update.version.clone())
  }

  /// Download an update found, check its signature and keep it for its moment; one this build does not install is
  /// left to the system, said once.
  async fn found(&self, update: Update, channel: Channel, left: &mut Option<String>) {
    if !installs_itself() {
      if left.as_deref() != Some(update.version.as_str()) {
        self
          .log
          .info("update-left-to-system", json!({ "version": update.version, "channel": channel }));
        *left = Some(update.version.clone());
      }
      return;
    }
    if self.kept_version().as_deref() == Some(update.version.as_str()) {
      return;
    }
    self.log.info("update-found", json!({ "version": update.version, "channel": channel }));
    let bytes = match update.download(|_, _| {}, || {}).await {
      Ok(bytes) => bytes,
      Err(error) => {
        self.log.warn(
          "update-not-downloaded",
          json!({ "version": update.version, "error": error.to_string() }),
        );
        return;
      }
    };
    let file = self.dir.join(file_name_of(&update.version));
    let written = std::fs::create_dir_all(&self.dir).and_then(|()| write_whole(&file, &bytes));
    if let Err(error) = written {
      self
        .log
        .warn("update-not-kept", json!({ "version": update.version, "error": error.to_string() }));
      return;
    }
    self.log.info("update-kept", json!({ "version": update.version }));
    let before = self.kept.lock().unwrap_or_else(std::sync::PoisonError::into_inner).replace(Kept {
      update,
      file: file.clone(),
    });
    if let Some(before) = before
      && before.file != file
    {
      let _ = std::fs::remove_file(before.file);
    }
    self.keeping.send_replace(true);
  }

  /// Let go of the kept update and its file.
  fn drop_kept(&self) {
    if let Some(kept) = self.kept.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take() {
      let _ = std::fs::remove_file(kept.file);
    }
    self.keeping.send_replace(false);
  }

  /// Install the kept update at `moment`: its bytes checked again, the record written, `stop` awaited, which stops
  /// what the app runs, then the installer. At an idle moment the app starts again, on the new version or, where
  /// the install did not start, on the one it ran; at a quit this returns and the caller ends the app. With nothing
  /// kept, or the kept bytes no longer verifying, nothing is stopped and this returns.
  pub async fn install<F: Future<Output = ()>>(
    &self,
    app: &AppHandle,
    moment: Moment,
    stop: impl FnOnce() -> F,
  ) {
    if self.installing.swap(true, Ordering::SeqCst) {
      return;
    }
    let kept = self
      .kept
      .lock()
      .unwrap_or_else(std::sync::PoisonError::into_inner)
      .as_ref()
      .map(|kept| (kept.update.clone(), kept.file.clone()));
    let Some((update, file)) = kept else {
      self.installing.store(false, Ordering::SeqCst);
      return;
    };
    let bytes = match std::fs::read(&file)
      .map_err(|error| error.to_string())
      .and_then(|bytes| update.verify(&bytes).map(|()| bytes).map_err(|error| error.to_string()))
    {
      Ok(bytes) => bytes,
      Err(error) => {
        self.log.warn("update-dropped", json!({ "version": update.version, "error": error }));
        self.drop_kept();
        self.installing.store(false, Ordering::SeqCst);
        return;
      }
    };
    let record = Record {
      from: app.package_info().version.to_string(),
      to: update.version.clone(),
      restart: moment == Moment::Idle,
    };
    let written = serde_json::to_vec(&record)
      .map_err(std::io::Error::other)
      .and_then(|text| write_whole(&self.record_path(), &text));
    if let Err(error) = written {
      self.log.warn("update-record-not-written", json!({ "error": error.to_string() }));
    }
    self.log.info(
      "update-installing",
      json!({ "version": update.version, "moment": format!("{moment:?}") }),
    );
    stop().await;
    // Windows's installer ends this process once it has started, and starts the app again where it is asked to.
    let version = update.version.clone();
    let installed = update.restart_after_install(moment == Moment::Idle).install(&bytes);
    self.drop_kept();
    if let Err(error) = installed {
      self
        .log
        .warn("update-not-installed", json!({ "version": version, "error": error.to_string() }));
      let _ = std::fs::remove_file(self.record_path());
    }
    if moment == Moment::Idle {
      app.restart();
    }
  }
}

/// Ask the channel's feed now, every six hours and whenever the channel changes, and keep what it offers above the
/// running version for its moment.
pub async fn keep_updated(
  app: AppHandle,
  updates: Arc<Updates>,
  feeds: Feeds,
  mut channel: watch::Receiver<Channel>,
) {
  let mut left = None;
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
      Ok(Some(update)) => updates.found(update, following, &mut left).await,
      Ok(None) => {}
      Err(error) => {
        updates.log.warn("update-check-failed", json!({ "channel": following, "error": error }))
      }
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

/// Install the kept update once the app has stood quiet at two looks a minute apart; `quiet` says whether it is quiet
/// now, and `stop` stops what it runs.
pub async fn install_when_idle<F: Future<Output = ()>>(
  app: AppHandle,
  updates: Arc<Updates>,
  quiet: impl Fn(&AppHandle) -> bool,
  stop: impl Fn(AppHandle) -> F,
) {
  let mut keeping = updates.keeping.subscribe();
  let mut quiet_before = false;
  loop {
    if keeping.wait_for(|keeping| *keeping).await.is_err() {
      return;
    }
    tokio::time::sleep(IDLE_LOOK).await;
    let quiet_now = quiet(&app);
    if quiet_now && quiet_before {
      let stopping = app.clone();
      updates.install(&app, Moment::Idle, || stop(stopping)).await;
      quiet_before = false;
    } else {
      quiet_before = quiet_now;
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn the_updated_line_speaks_the_systems_language() {
    assert_eq!(updated_line_in("ko-KR", "1.2.0"), "업데이트됨 · v1.2.0");
    assert_eq!(updated_line_in("ja_JP", "1.2.0"), "アップデート済み · v1.2.0");
    assert_eq!(updated_line_in("zh-Hans-CN", "1.2.0"), "已更新 · v1.2.0");
    assert_eq!(updated_line_in("en-US", "1.2.0"), "Updated · v1.2.0");
    assert_eq!(updated_line_in("", "1.2.0"), "Updated · v1.2.0");
    assert_eq!(updated_line_in("fr-FR", "1.2.0"), "Updated · v1.2.0");
  }

  #[test]
  fn a_version_is_kept_under_a_name_of_its_own() {
    assert_eq!(file_name_of("1.1.0-nightly.20261124.2"), "1.1.0-nightly.20261124.2.update");
    assert_eq!(file_name_of("1.0.0+build/../x"), "1.0.0-build-..-x.update");
  }

  fn updates_in(dir: &Path) -> Arc<Updates> {
    Updates::new(dir.to_path_buf(), Log::open(dir.join("test.log")))
  }

  fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("jake-desktop-updates-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
  }

  fn record(dir: &Path, record: &Record) {
    std::fs::write(dir.join(RECORD_FILE), serde_json::to_vec(record).unwrap()).unwrap();
  }

  #[test]
  fn an_app_started_on_the_version_it_installed_says_so_and_stays_hidden() {
    let dir = scratch("updated");
    record(
      &dir,
      &Record {
        from: "1.0.0".into(),
        to: "1.1.0".into(),
        restart: true,
      },
    );

    let started = updates_in(&dir).started("1.1.0");
    assert_eq!(
      started,
      Started {
        updated: Some("1.1.0".into()),
        hidden: true
      }
    );
    assert!(!dir.join(RECORD_FILE).exists(), "the record is read once");
    assert_eq!(updates_in(&dir).started("1.1.0"), Started::default());
    let _ = std::fs::remove_dir_all(dir);
  }

  #[test]
  fn an_install_that_did_not_take_names_no_update() {
    let dir = scratch("failed");
    record(
      &dir,
      &Record {
        from: "1.0.0".into(),
        to: "1.1.0".into(),
        restart: true,
      },
    );
    assert_eq!(
      updates_in(&dir).started("1.0.0"),
      Started {
        updated: None,
        hidden: true
      }
    );

    record(
      &dir,
      &Record {
        from: "1.0.0".into(),
        to: "1.1.0".into(),
        restart: false,
      },
    );
    assert_eq!(
      updates_in(&dir).started("1.1.0"),
      Started {
        updated: Some("1.1.0".into()),
        hidden: false
      }
    );

    std::fs::write(dir.join(RECORD_FILE), "not json").unwrap();
    assert_eq!(updates_in(&dir).started("1.1.0"), Started::default());
    let _ = std::fs::remove_dir_all(dir);
  }
}
