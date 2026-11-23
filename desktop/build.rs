// The Tauri build: the app's context, and the commands its capabilities may grant. The remote controller and the
// all-in-one each grant their own bundled page's commands, from capabilities of their own (docs/all-in-one.md,
// 「The crate」).

fn main() {
  let all_in_one = std::env::var_os("CARGO_FEATURE_ALL_IN_ONE").is_some();
  let (commands, capabilities): (&[&str], &'static str) = if all_in_one {
    (
      &[
        "aio_view",
        "aio_consent",
        "aio_accept",
        "aio_prerequisites",
        "aio_retry",
        "aio_input",
        "aio_inputs_done",
        "settings",
        "change_setting",
      ],
      "./capabilities/all-in-one/*.json",
    )
  } else {
    (
      &["status", "console", "retry", "settings", "change_setting", "set_console"],
      "./capabilities/*.json",
    )
  };
  let manifest = tauri_build::AppManifest::new().commands(commands);
  let attributes = tauri_build::Attributes::new()
    .app_manifest(manifest)
    .capabilities_path_pattern(capabilities);
  tauri_build::try_build(attributes).expect("the Tauri build runs");
}
