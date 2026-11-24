// The physical machine the agent runs on, as the fingerprint its hello names (docs/architecture.md, 「The machine's fingerprint」).

use std::fs::OpenOptions;
use std::io::{ErrorKind, Write as _};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use sha2::{Digest as _, Sha256};

/// The prefix hashed before the machine's own id, so the fingerprint is jake's alone.
const PREFIX: &str = "jake-machine:";
/// How many hex digits of the hash the fingerprint keeps.
const DIGITS: usize = 32;
/// The machine id files of a Linux system, the first that holds one read.
const LINUX_IDS: [&str; 2] = ["/etc/machine-id", "/var/lib/dbus/machine-id"];
/// How long the one interop read of the Windows host's id is given.
const INTEROP_WAIT: Duration = Duration::from_secs(15);

/// Where the agent runs, which decides where the machine's id is read from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Host {
  Windows,
  /// A WSL distribution, whose machine is the Windows host's.
  Wsl,
  Linux,
}

impl Host {
  /// The host this process runs on.
  pub fn this() -> Self {
    if cfg!(windows) {
      Self::Windows
    } else if in_wsl() {
      Self::Wsl
    } else {
      Self::Linux
    }
  }
}

/// What the machine's id is read from: the machine itself for the agent, a stand-in in a test.
pub trait Sources {
  /// The Windows `MachineGuid`, read in-process from the registry.
  fn registry(&self) -> Option<String>;
  /// The Windows host's `MachineGuid` read from WSL, which starts a Windows program through interop.
  fn interop(&self) -> Option<String>;
  /// What a file holds, or none where it cannot be read.
  fn file(&self, path: &Path) -> Option<String>;
}

/// The machine this process runs on.
pub struct ThisMachine;

impl Sources for ThisMachine {
  fn registry(&self) -> Option<String> {
    registry_guid()
  }

  fn interop(&self) -> Option<String> {
    interop_guid()
  }

  fn file(&self, path: &Path) -> Option<String> {
    std::fs::read_to_string(path).ok()
  }
}

/// What a reading of the fingerprint came to: the fingerprint, none where no id could be read, and why a WSL
/// reading could not be kept, where it could not.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reading {
  pub fingerprint: Option<String>,
  pub unkept: Option<String>,
}

/// This machine's fingerprint, kept at `kept` inside WSL so the host's id is read through interop at most once.
pub fn fingerprint(kept: &Path) -> Reading {
  read(Host::this(), kept, &ThisMachine)
}

/// The fingerprint `host` reads from `sources`. Inside WSL the fingerprint kept at `kept` comes first and starts
/// nothing; with none kept the host's id is read through interop once and kept, and where interop gives none the
/// distribution's own id stands in for this reading alone, kept nowhere.
pub fn read(host: Host, kept: &Path, sources: &dyn Sources) -> Reading {
  let linux = || {
    LINUX_IDS
      .iter()
      .find_map(|path| sources.file(Path::new(path)).and_then(|id| hashed(&id)))
  };
  match host {
    Host::Windows => Reading {
      fingerprint: sources.registry().and_then(|id| hashed(&id)),
      unkept: None,
    },
    Host::Linux => Reading {
      fingerprint: linux(),
      unkept: None,
    },
    Host::Wsl => {
      if let Some(fingerprint) = sources.file(kept).and_then(|text| well_formed(&text)) {
        return Reading {
          fingerprint: Some(fingerprint),
          unkept: None,
        };
      }
      match sources.interop().and_then(|id| hashed(&id)) {
        Some(fingerprint) => Reading {
          unkept: keep(kept, &fingerprint).err(),
          fingerprint: Some(fingerprint),
        },
        None => Reading {
          fingerprint: linux(),
          unkept: Some("the Windows host's machine id could not be read through interop".to_owned()),
        },
      }
    }
  }
}

/// The fingerprint of a raw machine id: the first hex digits of SHA-256 over the prefix and the id, trimmed and
/// lowercased; none for an empty id.
pub fn hashed(raw: &str) -> Option<String> {
  let id = raw.trim().to_lowercase();
  if id.is_empty() {
    return None;
  }
  let digest = Sha256::digest(format!("{PREFIX}{id}").as_bytes());
  let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
  Some(hex[..DIGITS].to_owned())
}

fn well_formed(text: &str) -> Option<String> {
  let fingerprint = text.trim();
  (fingerprint.len() == DIGITS && fingerprint.bytes().all(|byte| byte.is_ascii_hexdigit()))
    .then(|| fingerprint.to_lowercase())
}

/// Write the fingerprint where none stands yet, so two first starts at once keep the one written first.
fn keep(path: &Path, fingerprint: &str) -> Result<(), String> {
  if let Some(parent) = path.parent() {
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
  }
  match OpenOptions::new().write(true).create_new(true).open(path) {
    Ok(mut file) => file.write_all(fingerprint.as_bytes()).map_err(|error| error.to_string()),
    Err(error) if error.kind() == ErrorKind::AlreadyExists => {
      // A file that stands but holds no fingerprint is replaced; one that holds a fingerprint is kept.
      let standing = std::fs::read_to_string(path).unwrap_or_default();
      if well_formed(&standing).is_some() {
        return Ok(());
      }
      std::fs::write(path, fingerprint).map_err(|error| error.to_string())
    }
    Err(error) => Err(error.to_string()),
  }
}

/// Whether this Linux system is a WSL distribution, read from the kernel's own release name.
fn in_wsl() -> bool {
  std::fs::read_to_string("/proc/sys/kernel/osrelease")
    .is_ok_and(|release| release.to_lowercase().contains("microsoft"))
}

#[cfg(windows)]
fn registry_guid() -> Option<String> {
  use windows_sys::Win32::System::Registry::{
    HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ, RRF_SUBKEY_WOW6464KEY, RegGetValueW,
  };
  let wide = |text: &str| text.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
  let (key, value) = (wide("SOFTWARE\\Microsoft\\Cryptography"), wide("MachineGuid"));
  let mut buffer = [0u16; 128];
  let mut size = u32::try_from(std::mem::size_of_val(&buffer)).ok()?;
  // SAFETY: the key and value names are NUL-terminated wide strings that outlive the call, and the buffer's
  // size in bytes is passed with it, which the call writes no further than.
  let status = unsafe {
    RegGetValueW(
      HKEY_LOCAL_MACHINE,
      key.as_ptr(),
      value.as_ptr(),
      RRF_RT_REG_SZ | RRF_SUBKEY_WOW6464KEY,
      std::ptr::null_mut(),
      buffer.as_mut_ptr().cast(),
      &raw mut size,
    )
  };
  if status != 0 {
    return None;
  }
  let units = (usize::try_from(size).ok()? / 2).min(buffer.len());
  Some(String::from_utf16_lossy(&buffer[..units]).trim_end_matches('\0').to_owned())
}

#[cfg(not(windows))]
fn registry_guid() -> Option<String> {
  None
}

/// The Windows host's `MachineGuid` from WSL: one start of `reg.exe`, only where interop's handler is registered.
fn interop_guid() -> Option<String> {
  if !interop_registered() {
    return None;
  }
  let reg = reg_exe()?;
  let mut child = std::process::Command::new(reg)
    .args(["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"])
    .stdin(std::process::Stdio::null())
    .stdout(std::process::Stdio::piped())
    .stderr(std::process::Stdio::null())
    .spawn()
    .ok()?;
  let started = Instant::now();
  loop {
    match child.try_wait() {
      Ok(Some(_)) => break,
      Ok(None) if started.elapsed() < INTEROP_WAIT => std::thread::sleep(Duration::from_millis(50)),
      _ => {
        let _ = child.kill();
        let _ = child.wait();
        return None;
      }
    }
  }
  let mut out = String::new();
  std::io::Read::read_to_string(&mut child.stdout.take()?, &mut out).ok()?;
  guid_in_reg_output(&out)
}

/// The value `reg.exe query ... /v MachineGuid` printed, from its line naming the value.
fn guid_in_reg_output(output: &str) -> Option<String> {
  output
    .lines()
    .find(|line| line.trim_start().starts_with("MachineGuid"))
    .and_then(|line| line.split_whitespace().last())
    .map(str::to_owned)
}

fn interop_registered() -> bool {
  ["WSLInterop", "WSLInterop-late"]
    .iter()
    .any(|name| Path::new("/proc/sys/fs/binfmt_misc").join(name).exists())
}

/// `reg.exe` where it stands, on the PATH or in Windows' own folder under the default mount, found without
/// starting anything.
fn reg_exe() -> Option<PathBuf> {
  let on_path = std::env::var_os("PATH")
    .map(|path| std::env::split_paths(&path).map(|dir| dir.join("reg.exe")).collect::<Vec<_>>())
    .unwrap_or_default();
  on_path
    .into_iter()
    .chain([PathBuf::from("/mnt/c/Windows/System32/reg.exe")])
    .find(|candidate| candidate.is_file())
}

#[cfg(test)]
mod tests {
  use std::cell::Cell;
  use std::collections::HashMap;

  use super::*;

  /// Stand-in sources: the ids they hold, and how many interop reads were asked of them.
  #[derive(Default)]
  struct Stand {
    registry: Option<&'static str>,
    interop: Option<&'static str>,
    files: HashMap<PathBuf, String>,
    interop_reads: Cell<usize>,
  }

  impl Sources for Stand {
    fn registry(&self) -> Option<String> {
      self.registry.map(str::to_owned)
    }

    fn interop(&self) -> Option<String> {
      self.interop_reads.set(self.interop_reads.get() + 1);
      self.interop.map(str::to_owned)
    }

    // The stand-in's own files, and the test's kept file under the temporary folder; never the machine's own ids.
    fn file(&self, path: &Path) -> Option<String> {
      let kept = || {
        path
          .starts_with(std::env::temp_dir())
          .then(|| std::fs::read_to_string(path).ok())
          .flatten()
      };
      self.files.get(path).cloned().or_else(kept)
    }
  }

  /// A folder of its own for one test's kept file, removed when dropped.
  struct Folder(PathBuf);

  impl Folder {
    fn new(tag: &str) -> Self {
      Self(std::env::temp_dir().join(format!("jake-machine-{tag}-{}", std::process::id())))
    }

    fn kept(&self) -> PathBuf {
      self.0.join("nested").join("machine")
    }
  }

  impl Drop for Folder {
    fn drop(&mut self) {
      let _ = std::fs::remove_dir_all(&self.0);
    }
  }

  const GUID: &str = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";

  #[test]
  fn the_fingerprint_is_a_short_hash_of_the_trimmed_lowercased_id_never_the_id() {
    let fingerprint = hashed(GUID).unwrap();
    assert_eq!(fingerprint.len(), 32);
    assert!(fingerprint.bytes().all(|byte| byte.is_ascii_hexdigit()));
    assert!(!fingerprint.contains("0f1e2d3c"));
    assert_eq!(hashed(&format!("  {}\r\n", GUID.to_uppercase())), Some(fingerprint));
    assert_eq!(hashed(" \n"), None);
  }

  #[test]
  fn a_wsl_agent_and_a_windows_agent_of_one_pc_name_one_machine() {
    let folder = Folder::new("one-pc");
    let windows = read(
      Host::Windows,
      &folder.kept(),
      &Stand {
        registry: Some(GUID),
        ..Stand::default()
      },
    );
    let wsl = read(
      Host::Wsl,
      &folder.kept(),
      &Stand {
        interop: Some(GUID),
        ..Stand::default()
      },
    );
    assert_eq!(windows.fingerprint, hashed(GUID));
    assert_eq!(wsl.fingerprint, windows.fingerprint);
    assert_eq!(wsl.unkept, None);
  }

  #[test]
  fn inside_wsl_the_host_is_asked_once_and_every_later_start_reads_the_kept_fingerprint() {
    let folder = Folder::new("kept");
    let first = Stand {
      interop: Some(GUID),
      ..Stand::default()
    };
    let read_first = read(Host::Wsl, &folder.kept(), &first);
    assert_eq!(first.interop_reads.get(), 1);
    assert_eq!(std::fs::read_to_string(folder.kept()).ok(), hashed(GUID));

    let later = Stand {
      interop: Some("another-id"),
      ..Stand::default()
    };
    let read_later = read(Host::Wsl, &folder.kept(), &later);
    assert_eq!(later.interop_reads.get(), 0, "a kept fingerprint starts nothing");
    assert_eq!(read_later.fingerprint, read_first.fingerprint);
  }

  #[test]
  fn inside_wsl_without_interop_the_distributions_id_stands_in_and_nothing_is_kept() {
    let folder = Folder::new("no-interop");
    let stand = Stand {
      files: HashMap::from([(PathBuf::from("/etc/machine-id"), "abc123\n".to_owned())]),
      ..Stand::default()
    };
    let reading = read(Host::Wsl, &folder.kept(), &stand);
    assert_eq!(reading.fingerprint, hashed("abc123"));
    assert!(reading.unkept.is_some());
    assert!(!folder.kept().exists());

    // A later start that reaches interop keeps the host's.
    let reached = Stand {
      interop: Some(GUID),
      ..Stand::default()
    };
    assert_eq!(read(Host::Wsl, &folder.kept(), &reached).fingerprint, hashed(GUID));
    assert_eq!(std::fs::read_to_string(folder.kept()).ok(), hashed(GUID));
  }

  #[test]
  fn a_kept_file_that_holds_no_fingerprint_is_read_again_and_replaced() {
    let folder = Folder::new("broken");
    std::fs::create_dir_all(folder.kept().parent().unwrap()).unwrap();
    std::fs::write(folder.kept(), "not a fingerprint").unwrap();
    let stand = Stand {
      interop: Some(GUID),
      ..Stand::default()
    };
    assert_eq!(read(Host::Wsl, &folder.kept(), &stand).fingerprint, hashed(GUID));
    assert_eq!(stand.interop_reads.get(), 1);
    assert_eq!(std::fs::read_to_string(folder.kept()).ok(), hashed(GUID));
  }

  #[test]
  fn linux_reads_its_machine_id_then_dbus_and_windows_its_registry_alone() {
    let folder = Folder::new("linux");
    let dbus = Stand {
      files: HashMap::from([(PathBuf::from("/var/lib/dbus/machine-id"), "d-bus-id".to_owned())]),
      interop: Some(GUID),
      ..Stand::default()
    };
    assert_eq!(read(Host::Linux, &folder.kept(), &dbus).fingerprint, hashed("d-bus-id"));
    assert_eq!(dbus.interop_reads.get(), 0, "Linux never asks Windows");
    let both = Stand {
      files: HashMap::from([
        (PathBuf::from("/etc/machine-id"), "etc-id".to_owned()),
        (PathBuf::from("/var/lib/dbus/machine-id"), "d-bus-id".to_owned()),
      ]),
      ..Stand::default()
    };
    assert_eq!(read(Host::Linux, &folder.kept(), &both).fingerprint, hashed("etc-id"));
    assert!(!folder.kept().exists());

    let unread = read(Host::Windows, &folder.kept(), &Stand::default());
    assert_eq!(
      unread,
      Reading {
        fingerprint: None,
        unkept: None
      }
    );
  }

  #[test]
  fn the_guid_is_read_from_the_line_reg_prints_for_the_value() {
    let output = "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0\r\n\r\n";
    assert_eq!(guid_in_reg_output(output).as_deref(), Some(GUID));
    assert_eq!(
      guid_in_reg_output("ERROR: The system was unable to find the specified registry key"),
      None
    );
  }
}
