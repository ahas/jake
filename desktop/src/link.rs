// The `bmo://connect` link the console's join page opens the app with, and the invitation it carries.

use std::ffi::OsStr;
use std::io::ErrorKind;
use std::path::Path;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use url::Url;

use crate::settings::console_url;

/// The scheme the app registers for its links.
pub const SCHEME: &str = "bmo";
/// The one action a link may name, as its host.
const ACTION: &str = "connect";
/// How many characters an invitation token holds, all lowercase hexadecimal.
const INVITE_LENGTH: usize = 48;
/// How long an invitation is held for a pairing, in memory or in the pending file across a start.
pub const INVITATION_LIFETIME: Duration = Duration::from_secs(10 * 60);
/// The file beside `settings.json` that carries an invitation across the app's start on a new server.
const PENDING_FILE: &str = "pending-invitation.json";

/// What a link asks for: connect to the server and pair bound to the invitation. Its debug form leaves the
/// invitation out.
#[derive(Clone, PartialEq, Eq)]
pub struct Invitation {
  /// The console's address, as the base its paths join onto.
  pub server: Url,
  /// The invitation's token.
  pub invite: String,
}

impl std::fmt::Debug for Invitation {
  fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    formatter
      .debug_struct("Invitation")
      .field("server", &self.server.as_str())
      .finish_non_exhaustive()
  }
}

/// Whether a command-line argument is one of the app's links, which a start of the app's own never hands on.
pub fn is_link(arg: &OsStr) -> bool {
  arg
    .to_str()
    .and_then(|arg| arg.split_once(':'))
    .is_some_and(|(scheme, _)| scheme.eq_ignore_ascii_case(SCHEME))
}

/// The invitation a link carries, read strictly: `bmo://connect` with exactly one `server`, an HTTPS console
/// address (plain HTTP on this machine alone) taken as the server page takes it, and one `invite`, an
/// invitation token. Anything else is refused with the reason in the person's words.
pub fn read(link: &str) -> Result<Invitation, String> {
  let not_a_link = || "BMO 앱에서 열 수 있는 링크가 아닙니다.".to_owned();
  let link = Url::parse(link.trim()).map_err(|_| not_a_link())?;
  let bare = link.username().is_empty()
    && link.password().is_none()
    && link.port().is_none()
    && link.fragment().is_none()
    && matches!(link.path(), "" | "/");
  if link.scheme() != SCHEME || link.host_str() != Some(ACTION) || !bare {
    return Err(not_a_link());
  }
  let (mut server, mut invite) = (None, None);
  for (key, value) in link.query_pairs() {
    let slot = match key.as_ref() {
      "server" => &mut server,
      "invite" => &mut invite,
      _ => return Err(only_server_and_invite()),
    };
    if slot.replace(value.into_owned()).is_some() {
      return Err(only_server_and_invite());
    }
  }
  let (Some(server), Some(invite)) = (server, invite) else {
    return Err(only_server_and_invite());
  };
  Ok(Invitation {
    server: server_address(&server)?,
    invite: token(invite)?,
  })
}

fn only_server_and_invite() -> String {
  "링크에는 서버 주소와 초대 코드가 하나씩만 있어야 합니다.".to_owned()
}

/// The server a link names, as the console's base; it names its scheme itself and holds no user or password.
fn server_address(raw: &str) -> Result<Url, String> {
  let parsed = Url::parse(raw)
    .ok()
    .filter(|url| url.host_str().is_some_and(|host| !host.is_empty()))
    .ok_or_else(|| "링크의 서버 주소가 올바르지 않습니다.".to_owned())?;
  if !parsed.username().is_empty() || parsed.password().is_some() {
    return Err("링크의 서버 주소에 계정 정보가 들어 있어 열지 않습니다.".to_owned());
  }
  console_url(raw).map_err(|_| {
    "링크의 서버 주소는 https 주소여야 합니다. http는 localhost에서만 쓸 수 있습니다.".to_owned()
  })
}

fn token(invite: String) -> Result<String, String> {
  let hex = invite.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
  if invite.len() == INVITE_LENGTH && hex {
    Ok(invite)
  } else {
    Err("링크의 초대 코드가 올바르지 않습니다.".to_owned())
  }
}

/// An invitation handed to the app's course, used for a pairing only until it expires.
#[derive(Clone)]
pub struct Invited {
  invite: String,
  until: Instant,
}

impl Invited {
  pub fn new(invite: String) -> Self {
    Self {
      invite,
      until: Instant::now() + INVITATION_LIFETIME,
    }
  }

  /// The invitation's token while it is fresh, none once it expired.
  pub fn fresh(&self) -> Option<&str> {
    (Instant::now() < self.until).then_some(self.invite.as_str())
  }
}

/// The pending file's content.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Pending {
  server: String,
  invite: String,
  /// Seconds since the Unix epoch.
  expires_at: u64,
}

fn seconds(time: SystemTime) -> u64 {
  time.duration_since(UNIX_EPOCH).map_or(0, |since| since.as_secs())
}

/// Keep the invitation in `dir` for the app's next start, until it expires; on Unix the file is the person's
/// alone.
pub fn keep_pending(dir: &Path, invitation: &Invitation, now: SystemTime) -> std::io::Result<()> {
  let pending = Pending {
    server: invitation.server.to_string(),
    invite: invitation.invite.clone(),
    expires_at: seconds(now + INVITATION_LIFETIME),
  };
  let text = serde_json::to_vec(&pending)?;
  std::fs::create_dir_all(dir)?;
  let path = dir.join(PENDING_FILE);
  let _ = std::fs::remove_file(&path);
  let mut options = std::fs::OpenOptions::new();
  options.write(true).create_new(true);
  #[cfg(unix)]
  std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
  std::io::Write::write_all(&mut options.open(&path)?, &text)
}

/// Take the invitation kept in `dir`: the file is deleted whatever it holds, so it is read once at most, and
/// an invitation that expired, or a file that does not hold one, gives none.
pub fn take_pending(dir: &Path, now: SystemTime) -> Result<Option<Invitation>, String> {
  let path = dir.join(PENDING_FILE);
  let text = match std::fs::read(&path) {
    Ok(text) => text,
    Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
    Err(error) => return Err(error.to_string()),
  };
  std::fs::remove_file(&path).map_err(|error| error.to_string())?;
  let pending: Pending = serde_json::from_slice(&text).map_err(|error| error.to_string())?;
  if pending.expires_at <= seconds(now) {
    return Ok(None);
  }
  Ok(Some(Invitation {
    server: console_url(&pending.server)?,
    invite: token(pending.invite)?,
  }))
}

#[cfg(test)]
mod tests {
  use super::*;

  const INVITE: &str = "0123456789abcdef0123456789abcdef0123456789abcdef";

  fn link(server: &str) -> String {
    format!("bmo://connect?server={server}&invite={INVITE}")
  }

  #[test]
  fn a_link_names_the_server_and_the_invitation() {
    let invitation = read(&link("https%3A%2F%2Fbmo.example%2Fbmo%2F")).unwrap();
    assert_eq!(invitation.server.as_str(), "https://bmo.example/bmo/");
    assert_eq!(invitation.invite, INVITE);
    // The order of the two is the link's own.
    let swapped = read(&format!("bmo://connect?invite={INVITE}&server=https%3A%2F%2Fbmo.example")).unwrap();
    assert_eq!(swapped.server.as_str(), "https://bmo.example/");
  }

  #[test]
  fn the_server_is_taken_as_the_server_page_takes_it() {
    for (server, base) in [
      ("https%3A%2F%2Fbmo.example%2Fbmo", "https://bmo.example/bmo/"),
      ("https%3A%2F%2Fbmo.example%2Fbmo%2F", "https://bmo.example/bmo/"),
      ("https%3A%2F%2Fbmo.example%3A8443%2Fbmo%3Fx%3D1%23top", "https://bmo.example:8443/bmo/"),
      ("https://bmo.example", "https://bmo.example/"),
      ("http%3A%2F%2Flocalhost%3A3000", "http://localhost:3000/"),
      ("http%3A%2F%2F127.0.0.1%3A4000%2Fbmo", "http://127.0.0.1:4000/bmo/"),
      ("http%3A%2F%2F%5B%3A%3A1%5D%3A4000", "http://[::1]:4000/"),
    ] {
      assert_eq!(read(&link(server)).unwrap().server.as_str(), base, "{server}");
    }
  }

  #[test]
  fn a_server_that_is_not_https_off_this_machine_is_refused() {
    for server in [
      "http%3A%2F%2Fbmo.example",
      "http%3A%2F%2F10.0.0.5%3A3000",
      "ftp%3A%2F%2Fbmo.example",
      "bmo.example",
      "https%3A%2F%2F",
      "https%3A%2F%2Fperson%3Asecret%40bmo.example",
      "",
    ] {
      assert!(read(&link(server)).is_err(), "{server}");
    }
    assert!(read(&link("http%3A%2F%2Fbmo.example")).unwrap_err().contains("https"));
  }

  #[test]
  fn a_link_of_another_scheme_action_or_shape_is_refused() {
    let query = format!("server=https%3A%2F%2Fbmo.example&invite={INVITE}");
    for refused in [
      format!("https://connect?{query}"),
      format!("jake://connect?{query}"),
      format!("bmo://join?{query}"),
      format!("bmo://connect/more?{query}"),
      format!("bmo://connect:80?{query}"),
      format!("bmo://person@connect?{query}"),
      format!("bmo://connect?{query}#top"),
      format!("bmo:connect?{query}"),
      "not a link".to_owned(),
    ] {
      assert!(read(&refused).is_err(), "{refused}");
    }
    assert!(read(&format!("BMO://connect/?{query}")).is_ok());
  }

  #[test]
  fn a_link_with_a_parameter_missing_repeated_or_added_is_refused() {
    let server = "server=https%3A%2F%2Fbmo.example";
    let invite = format!("invite={INVITE}");
    for query in [
      server.to_owned(),
      invite.clone(),
      String::new(),
      format!("{server}&{invite}&code=K3-9Q"),
      format!("{server}&{invite}&token={INVITE}"),
      format!("{server}&{server}&{invite}"),
      format!("{server}&{invite}&{invite}"),
    ] {
      let refused = read(&format!("bmo://connect?{query}")).unwrap_err();
      assert_eq!(refused, only_server_and_invite(), "{query}");
    }
  }

  #[test]
  fn an_invitation_that_is_not_48_lowercase_hex_characters_is_refused() {
    let base = "bmo://connect?server=https%3A%2F%2Fbmo.example&invite=";
    for invite in [
      &INVITE[..47],
      &format!("{INVITE}0"),
      &INVITE.to_uppercase(),
      &format!("{}g", &INVITE[..47]),
      &format!("{}%20", &INVITE[..47]),
      "",
    ] {
      assert!(read(&format!("{base}{invite}")).is_err(), "{invite}");
    }
  }

  #[test]
  fn only_the_apps_own_links_are_told_apart_among_arguments() {
    assert!(is_link(OsStr::new("bmo://connect?server=x&invite=y")));
    assert!(is_link(OsStr::new("BMO:anything")));
    assert!(!is_link(OsStr::new("--at-sign-in")));
    assert!(!is_link(OsStr::new("https://bmo.example")));
    assert!(!is_link(OsStr::new("/usr/bin/bmo")));
  }

  #[test]
  fn the_debug_form_leaves_the_invitation_out() {
    let invitation = read(&link("https%3A%2F%2Fbmo.example")).unwrap();
    assert!(!format!("{invitation:?}").contains(INVITE));
  }

  /// A directory of the test's own, removed when the test ends.
  struct Dir(std::path::PathBuf);

  impl Dir {
    fn new(name: &str) -> Self {
      let dir = std::env::temp_dir().join(format!("jake-desktop-link-{name}-{}", std::process::id()));
      let _ = std::fs::remove_dir_all(&dir);
      Self(dir)
    }
  }

  impl Drop for Dir {
    fn drop(&mut self) {
      let _ = std::fs::remove_dir_all(&self.0);
    }
  }

  #[test]
  fn a_pending_invitation_is_taken_once() {
    let dir = Dir::new("once");
    let invitation = read(&link("https%3A%2F%2Fbmo.example%2Fbmo")).unwrap();
    let now = SystemTime::now();
    keep_pending(&dir.0, &invitation, now).unwrap();
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      let mode = std::fs::metadata(dir.0.join(PENDING_FILE)).unwrap().permissions().mode();
      assert_eq!(mode & 0o777, 0o600);
    }

    assert_eq!(take_pending(&dir.0, now + Duration::from_secs(60)), Ok(Some(invitation)));
    assert_eq!(take_pending(&dir.0, now + Duration::from_secs(60)), Ok(None));
  }

  #[test]
  fn an_expired_or_broken_pending_invitation_is_dropped() {
    let dir = Dir::new("expired");
    let invitation = read(&link("https%3A%2F%2Fbmo.example")).unwrap();
    let now = SystemTime::now();
    keep_pending(&dir.0, &invitation, now).unwrap();
    assert_eq!(take_pending(&dir.0, now + INVITATION_LIFETIME), Ok(None));
    assert!(!dir.0.join(PENDING_FILE).exists());

    std::fs::write(dir.0.join(PENDING_FILE), "{").unwrap();
    assert!(take_pending(&dir.0, now).is_err());
    assert!(!dir.0.join(PENDING_FILE).exists());
  }

  #[test]
  fn a_fresh_invitation_is_given_until_it_expires() {
    let invited = Invited::new(INVITE.to_owned());
    assert_eq!(invited.fresh(), Some(INVITE));
    let expired = Invited {
      invite: INVITE.to_owned(),
      until: Instant::now(),
    };
    assert_eq!(expired.fresh(), None);
  }
}
