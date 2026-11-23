// The BMO distribution of WSL 2 on Windows (docs/all-in-one.md, 「Windows through WSL 2」): whether WSL 2 stands,
// whether the distribution is there, the image it is imported from and checked against, and the account it is
// laid out for. The words are built and read here on every platform; only Windows runs them.

/// The distribution's name.
pub const DISTRO: &str = "BMO";

/// Ubuntu's WSL image the distribution is imported from, and the checksums beside it, from Ubuntu's own release
/// folder.
pub const IMAGE_FOLDER: &str = "https://cloud-images.ubuntu.com/wsl/releases/24.04/current/";
pub const IMAGE: &str = "ubuntu-noble-wsl-amd64-wsl.rootfs.tar.gz";
pub const CHECKSUMS: &str = "SHA256SUMS";

/// Lays the distribution out once, as root: the account and the distribution's own settings; the account is its
/// first word.
pub const BOOTSTRAP: &str = include_str!("scripts/wsl-bootstrap.sh");

/// Whether WSL stands: `wsl.exe --status`.
pub fn status() -> Vec<String> {
  words(&["wsl.exe", "--status"])
}

/// WSL installed with no distribution, which asks for the administrator's consent through Windows itself.
pub fn install_wsl() -> Vec<String> {
  words(&["wsl.exe", "--install", "--no-distribution"])
}

/// The distributions WSL holds, one name a line.
pub fn list() -> Vec<String> {
  words(&["wsl.exe", "--list", "--quiet"])
}

/// The image imported as the distribution, its disk in `folder`.
pub fn import(folder: &str, image: &str) -> Vec<String> {
  words(&["wsl.exe", "--import", DISTRO, folder, image, "--version", "2"])
}

/// The bootstrap run as root, handed on standard input, for `account`.
pub fn bootstrap(account: &str) -> Vec<String> {
  words(&["wsl.exe", "-d", DISTRO, "-u", "root", "--exec", "sh", "-s", "--", account])
}

/// The servers the set needs started as root through their service scripts, each time the app starts it.
pub fn start_servers() -> Vec<String> {
  words(&[
    "wsl.exe",
    "-d",
    DISTRO,
    "-u",
    "root",
    "--exec",
    "sh",
    "-c",
    "service postgresql start; service valkey-server start 2>/dev/null || service redis-server start",
  ])
}

/// Whether `wsl.exe --list --quiet`'s output names the distribution. WSL writes it in UTF-16, little-endian,
/// whatever the console's code page; output that is not UTF-16 is read as UTF-8.
pub fn listed(output: &[u8]) -> bool {
  let text = if output.len() >= 2
    && output.len().is_multiple_of(2)
    && output.iter().skip(1).step_by(2).all(|byte| *byte == 0)
  {
    let units: Vec<u16> = output.as_chunks::<2>().0.iter().map(|pair| u16::from_le_bytes(*pair)).collect();
    String::from_utf16_lossy(&units)
  } else {
    String::from_utf8_lossy(output).into_owned()
  };
  text
    .lines()
    .map(|line| line.trim_matches(|character: char| character.is_whitespace() || character == '\u{feff}'))
    .any(|name| name == DISTRO)
}

/// The SHA-256 the checksums file names for `file`. The file is `sha256sum`'s listing, a digest and a name a
/// line, the name after a space and a `*` where it was read as binary: the tool's own output, not a general format.
pub fn checksum_of(sums: &str, file: &str) -> Option<String> {
  sums.lines().find_map(|line| {
    let (digest, name) = line.split_once(' ')?;
    (name.trim_start_matches([' ', '*']) == file && digest.len() == 64).then(|| digest.to_ascii_lowercase())
  })
}

/// The account made in the distribution for the person's Windows account: its name lowered, with what a Linux
/// account name may not hold left out, `bmo` where nothing is left.
pub fn account_for(windows_name: &str) -> String {
  let name: String = windows_name
    .to_lowercase()
    .chars()
    .filter(|character| {
      character.is_ascii_lowercase() || character.is_ascii_digit() || matches!(character, '_' | '-')
    })
    .collect();
  let name = name.trim_start_matches(|character: char| !character.is_ascii_lowercase()).to_owned();
  if name.is_empty() { "bmo".to_owned() } else { name.chars().take(32).collect() }
}

fn words(text: &[&str]) -> Vec<String> {
  text.iter().map(|word| (*word).to_owned()).collect()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn the_distribution_is_found_in_wsls_utf16_listing() {
    let utf16: Vec<u8> = "Ubuntu\r\nBMO\r\n".encode_utf16().flat_map(u16::to_le_bytes).collect();
    assert!(listed(&utf16));
    let other: Vec<u8> = "Ubuntu\r\nBMO-old\r\n".encode_utf16().flat_map(u16::to_le_bytes).collect();
    assert!(!listed(&other));
    assert!(listed(b"BMO\n"));
    assert!(!listed(b""));
  }

  #[test]
  fn the_images_checksum_is_read_from_the_listing() {
    let digest = "a".repeat(64);
    let sums = format!("{} *other.tar.gz\n{digest} *{IMAGE}\n", "b".repeat(64));
    assert_eq!(checksum_of(&sums, IMAGE), Some(digest));
    assert_eq!(checksum_of(&sums, "missing.tar.gz"), None);
  }

  #[test]
  fn the_account_is_named_for_the_windows_account() {
    assert_eq!(account_for("Jane Doe"), "janedoe");
    assert_eq!(account_for("1st.User"), "stuser");
    assert_eq!(account_for("관리자"), "bmo");
  }

  #[test]
  fn the_distribution_is_imported_and_laid_out_as_root() {
    assert_eq!(import("C:\\BMO", "C:\\image.tar.gz")[2], DISTRO);
    assert_eq!(
      bootstrap("someone"),
      words(&["wsl.exe", "-d", "BMO", "-u", "root", "--exec", "sh", "-s", "--", "someone"])
    );
  }
}
