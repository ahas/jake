// Where the main window may go: the console's pages under its address and the app's own page, and nowhere else.

use url::Url;

/// What becomes of a navigation the window is asked for.
#[derive(Debug, PartialEq, Eq)]
pub enum Navigation {
  /// A page under the console's address or the app's own page: the window goes.
  Stay,
  /// A web page elsewhere, another path of the console's own host among them: the person's default
  /// browser opens it, and the window stays.
  Browser,
  /// Anything else: nothing happens.
  Refuse,
}

/// The decision for one address, against the console's own, none while the app names no server. The
/// console's bridge is granted to its whole origin, since the webview names a page to the app by its
/// origin alone, so the window keeps to the console's own path and another site served beside it on the
/// same host never stands in it.
pub fn decide(url: &Url, console: Option<&Url>) -> Navigation {
  let under_console = console
    .is_some_and(|console| url.origin() == console.origin() && url.path().starts_with(console.path()));
  if under_console || is_local(url) {
    Navigation::Stay
  } else if matches!(url.scheme(), "https" | "http") {
    Navigation::Browser
  } else {
    Navigation::Refuse
  }
}

/// The address the app's own bundled page is served at, which differs by platform's webview.
pub fn local_page() -> Url {
  let base = if cfg!(windows) {
    "http://tauri.localhost/index.html"
  } else {
    "tauri://localhost/index.html"
  };
  Url::parse(base).expect("the bundled page's address is well-formed")
}

/// The bundled page opened to change the server, its form filled with the address the app runs on.
pub fn server_page() -> Url {
  let mut page = local_page();
  page.set_query(Some("server=change"));
  page
}

fn is_local(url: &Url) -> bool {
  let local = local_page();
  url.scheme() == local.scheme() && url.host_str() == local.host_str()
}

#[cfg(test)]
mod tests {
  use super::*;

  fn url(text: &str) -> Url {
    Url::parse(text).unwrap()
  }

  #[test]
  fn the_window_stays_under_the_consoles_address_and_on_its_own_page() {
    let console = url("https://console.example/bmo/");
    let console = Some(&console);
    assert_eq!(
      decide(&url("https://console.example/bmo/desktop/pair?code=K3"), console),
      Navigation::Stay
    );
    assert_eq!(decide(&url("https://console.example/bmo/"), console), Navigation::Stay);
    assert_eq!(decide(&url("https://console.example/elsewhere"), console), Navigation::Browser);
    assert_eq!(decide(&url("https://console.example/bmonster/"), console), Navigation::Browser);
    assert_eq!(decide(&local_page().join("index.html").unwrap(), console), Navigation::Stay);
    assert_eq!(decide(&url("https://other.example/"), console), Navigation::Browser);
    assert_eq!(decide(&url("http://console.example/bmo/"), console), Navigation::Browser);
    assert_eq!(decide(&url("file:///etc/passwd"), console), Navigation::Refuse);
  }

  #[test]
  fn with_no_server_the_window_keeps_to_its_own_page() {
    assert_eq!(decide(&local_page(), None), Navigation::Stay);
    assert_eq!(decide(&server_page(), None), Navigation::Stay);
    assert_eq!(decide(&url("https://console.example/bmo/"), None), Navigation::Browser);
  }

  #[test]
  fn the_fence_follows_the_server_named() {
    let page = url("https://bmo.example/console/rooms/7");
    let named = url("https://bmo.example/console/");
    let other = url("https://console.example/bmo/");
    assert_eq!(decide(&page, Some(&named)), Navigation::Stay);
    assert_eq!(decide(&page, Some(&other)), Navigation::Browser);
  }
}
