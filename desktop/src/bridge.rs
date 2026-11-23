// The console's narrow bridge: the commands its own pages may call in the main window, and nothing else.

use tauri::ipc::CapabilityBuilder;
use url::Url;

/// The capability's identifier.
pub const CAPABILITY: &str = "console";

/// Everything the console's pages may call (docs/desktop.md, 「The window and what the console may call」):
/// read the settings, change one, and the window's own commands for the frame the console draws.
pub const PERMISSIONS: [&str; 9] = [
  "allow-settings",
  "allow-change-setting",
  "core:window:allow-minimize",
  "core:window:allow-toggle-maximize",
  "core:window:allow-internal-toggle-maximize",
  "core:window:allow-close",
  "core:window:allow-start-dragging",
  "core:window:allow-is-maximized",
  "core:window:allow-title",
];

/// The capability for the console at `console`, in the window named `window`: remote pages of the
/// console's origin alone, and no page of the app's own origin.
pub fn capability(console: &Url, window: &str) -> CapabilityBuilder {
  PERMISSIONS.into_iter().fold(
    CapabilityBuilder::new(CAPABILITY).remote(scope(console)).local(false).window(window),
    CapabilityBuilder::permission,
  )
}

/// The capability for the server the settings name, none while they name none: with no server, no
/// remote page is given anything.
pub fn for_server(console: Option<&Url>, window: &str) -> Option<CapabilityBuilder> {
  console.map(|console| capability(console, window))
}

/// The address pattern of the console's pages: its scheme, host and port, every path of them. The
/// webview names the page asking to the app by its origin alone, so a narrower path would match no
/// page; the window itself keeps to the console's own path (`navigation`).
pub fn scope(console: &Url) -> String {
  let host = console.host_str().unwrap_or_default();
  let port = console.port().map(|port| format!(":{port}")).unwrap_or_default();
  format!("{}://{host}{port}/*", console.scheme())
}

#[cfg(test)]
mod tests {
  use super::*;

  use tauri::utils::acl::RemoteUrlPattern;

  use crate::settings::console_url;

  fn pattern(console: &str) -> RemoteUrlPattern {
    let base = console_url(console).unwrap();
    scope(&base).parse().unwrap_or_else(|error| panic!("{}: {error:?}", scope(&base)))
  }

  fn matches(pattern: &RemoteUrlPattern, url: &str) -> bool {
    pattern.test(&Url::parse(url).unwrap())
  }

  #[test]
  fn the_scope_holds_the_consoles_origin_and_nothing_beside_it() {
    let console = pattern("https://console.example/bmo/");

    for inside in [
      // What the webview hands the app for any page of the console: its origin.
      "https://console.example/",
      "https://console.example/bmo/rooms/7?settings=desktop",
      "https://console.example/bmo/desktop/pair?code=K3&in=app#top",
    ] {
      assert!(matches(&console, inside), "{inside}");
    }
    for outside in [
      "http://console.example/",
      "https://console.example:8443/",
      "https://other.example/",
      "https://console.example.other.example/",
      "https://sub.console.example/",
      "tauri://localhost/index.html",
      "http://tauri.localhost/index.html",
    ] {
      assert!(!matches(&console, outside), "{outside}");
    }
  }

  #[test]
  fn a_port_and_a_loopback_address_keep_to_themselves() {
    let local = pattern("http://127.0.0.1:4000/bmo/");

    assert!(matches(&local, "http://127.0.0.1:4000/"));
    assert!(!matches(&local, "http://127.0.0.1:4001/"));
    assert!(!matches(&local, "http://localhost:4000/"));
  }

  #[test]
  fn the_scope_follows_the_server_the_settings_name() {
    let dir = std::env::temp_dir().join(format!("jake-desktop-bridge-scope-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("settings.json"), r#"{"consoleUrl":"https://bmo.example:8443/console"}"#)
      .unwrap();
    let named = crate::settings::SettingsFile::open(&dir).settings().console;
    let _ = std::fs::remove_dir_all(&dir);

    let named = named.unwrap();
    assert_eq!(scope(&named), "https://bmo.example:8443/*");
    let pattern: RemoteUrlPattern = scope(&named).parse().unwrap();
    assert!(matches(&pattern, "https://bmo.example:8443/console/rooms/7"));
    assert!(!matches(&pattern, "https://elsewhere.example/console/"));
    assert!(!matches(&pattern, "https://bmo.example/console/"));
    assert!(for_server(Some(&named), "main").is_some());
    assert!(for_server(None, "main").is_none());
  }

  #[test]
  fn the_bridge_grants_the_settings_and_the_frame_alone() {
    let own: Vec<&str> = PERMISSIONS.iter().copied().filter(|one| !one.starts_with("core:")).collect();
    assert_eq!(own, ["allow-settings", "allow-change-setting"]);
    assert!(
      PERMISSIONS
        .iter()
        .filter(|one| one.starts_with("core:"))
        .all(|one| one.starts_with("core:window:allow-"))
    );
  }
}
