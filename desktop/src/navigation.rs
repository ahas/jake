// Where the main window may go: the console's origin and the app's own page, and nowhere else.

use url::Url;

/// What becomes of a navigation the window is asked for.
#[derive(Debug, PartialEq, Eq)]
pub enum Navigation {
  /// The console's origin or the app's own page: the window goes.
  Stay,
  /// A web page elsewhere: the person's default browser opens it, and the window stays.
  Browser,
  /// Anything else: nothing happens.
  Refuse,
}

/// The decision for one address, against the console's own.
pub fn decide(url: &Url, console: &Url) -> Navigation {
  if url.origin() == console.origin() || is_local(url) {
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
  fn the_window_stays_on_the_consoles_origin_and_its_own_page() {
    let console = url("https://console.example/bmo/");
    assert_eq!(
      decide(&url("https://console.example/bmo/desktop/pair?code=K3"), &console),
      Navigation::Stay
    );
    assert_eq!(decide(&url("https://console.example/elsewhere"), &console), Navigation::Stay);
    assert_eq!(decide(&local_page().join("index.html").unwrap(), &console), Navigation::Stay);
    assert_eq!(decide(&url("https://other.example/"), &console), Navigation::Browser);
    assert_eq!(decide(&url("http://console.example/bmo/"), &console), Navigation::Browser);
    assert_eq!(decide(&url("file:///etc/passwd"), &console), Navigation::Refuse);
  }
}
