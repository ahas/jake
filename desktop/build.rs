// The Tauri build: the app's context, and the commands its capabilities may grant.

fn main() {
  let commands = tauri_build::AppManifest::new().commands(&[
    "status",
    "console",
    "retry",
    "settings",
    "change_setting",
    "open_settings",
    "close_settings",
  ]);
  tauri_build::try_build(tauri_build::Attributes::new().app_manifest(commands))
    .expect("the Tauri build runs");
}
