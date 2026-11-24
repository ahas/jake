// The machine read once, where the set will run (docs/all-in-one.md, 「The first run」): a probe script of the
// app's own prints one `name=value` line for each fact, and the facts are weighed into what refuses the machine
// and what the person is asked to accept.

use crate::all_in_one::installer::Missing;

/// The probe, run with `sh` on the machine or in the distribution the set runs in. Its lines are this app's own
/// shape, `name=value`, read by `facts`.
pub const SCRIPT: &str = include_str!("scripts/probe.sh");

/// The console's port, the one port of the set the app itself names.
pub const CONSOLE_PORT: u16 = 3210;

/// The memory the set's builds need, in gibibytes, and the free disk its builds and releases need.
pub const MEMORY_GIB: u64 = 16;
pub const DISK_GIB: u64 = 60;

/// What the probe found.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Facts {
  pub os: String,
  pub arch: String,
  pub uid: Option<u32>,
  pub user: String,
  pub home: String,
  pub memory_kib: u64,
  pub disk_kib: u64,
  /// Whether a systemd user manager serves the account.
  pub systemd: bool,
  pub git: bool,
  pub cargo: bool,
  /// Whether a C compiler stands, which building the installer links with.
  pub cc: bool,
  /// What already listens on the console's port, where something does.
  pub console_port: Option<Listener>,
  /// The name of a jake agent installed on the machine, where one is.
  pub jake: Option<String>,
}

/// A program listening on a port the set would take.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Listener {
  /// Its program's name, empty where the probe could not see it.
  pub program: String,
  /// Whether it runs from one of the set's own releases, as the set's console does once installed.
  pub own: bool,
}

/// The facts of the probe's output; a line the probe did not write is passed over.
pub fn facts(output: &str) -> Facts {
  let mut facts = Facts::default();
  for line in output.lines() {
    let Some((name, value)) = line.split_once('=') else { continue };
    let value = value.trim();
    match name.trim() {
      "os" => facts.os = value.to_owned(),
      "arch" => facts.arch = value.to_owned(),
      "uid" => facts.uid = value.parse().ok(),
      "user" => facts.user = value.to_owned(),
      "home" => facts.home = value.to_owned(),
      "memory_kib" => facts.memory_kib = value.parse().unwrap_or(0),
      "disk_kib" => facts.disk_kib = value.parse().unwrap_or(0),
      "systemd" => facts.systemd = value == "yes",
      "git" => facts.git = value == "yes",
      "cargo" => facts.cargo = value == "yes",
      "cc" => facts.cc = value == "yes",
      "console_port" => facts.console_port = (value == "held").then(Listener::default),
      "console_port_holder" => {
        if let Some(listener) = &mut facts.console_port {
          listener.program = value.to_owned();
        }
      }
      "console_port_own" => {
        if let Some(listener) = &mut facts.console_port {
          listener.own = value == "yes";
        }
      }
      "jake" => facts.jake = Some(value.to_owned()).filter(|name| !name.is_empty()),
      _ => {}
    }
  }
  facts
}

/// The facts with what the Windows side adds where the set runs in a WSL 2 distribution: a listener on the console's
/// port on Windows' own loopback, which the distribution shares or is forwarded to, and a jake installed on Windows.
/// The port is tried in-process, by binding it and letting it go, and nothing is started.
pub fn with_windows_side(mut facts: Facts) -> Facts {
  if facts.console_port.is_none()
    && std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, CONSOLE_PORT))
      .is_err_and(|error| error.kind() == std::io::ErrorKind::AddrInUse)
  {
    facts.console_port = Some(Listener {
      program: "Windows 쪽 프로그램".to_owned(),
      own: false,
    });
  }
  if facts.jake.is_none() {
    facts.jake = jake_agent::installed::installed_agent().map(|installed| installed.name);
  }
  facts
}

/// What the facts come to: the reasons the machine cannot host the set, and what the person is asked to accept.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Verdict {
  pub refusals: Vec<String>,
  pub warnings: Vec<String>,
}

pub fn verdict(facts: &Facts) -> Verdict {
  let mut verdict = Verdict::default();
  if facts.os != "Linux" {
    verdict
      .refusals
      .push(format!("BMO는 Linux에서 실행됩니다. 이 컴퓨터는 {}입니다.", or_unknown(&facts.os)));
  }
  if !matches!(facts.arch.as_str(), "x86_64" | "aarch64") {
    verdict.refusals.push(format!(
      "64비트 x86 또는 ARM 프로세서가 필요합니다. 이 컴퓨터는 {}입니다.",
      or_unknown(&facts.arch)
    ));
  }
  if facts.uid == Some(0) {
    verdict
      .refusals
      .push("root 계정으로는 설치할 수 없습니다. 일반 사용자 계정으로 실행해 주세요.".to_owned());
  }
  if facts.home.is_empty() {
    verdict.refusals.push("홈 폴더를 찾을 수 없습니다.".to_owned());
  }
  if let Some(listener) = facts.console_port.as_ref().filter(|listener| !listener.own) {
    let holder = if listener.program.is_empty() {
      "다른 프로그램"
    } else {
      listener.program.as_str()
    };
    verdict.refusals.push(format!(
      "콘솔이 쓸 포트 {CONSOLE_PORT}을(를) 이미 {holder}이(가) 사용하고 있습니다. 같은 컴퓨터의 다른 설치가 쓰는 포트는 가져오지 않습니다. 그 프로그램을 멈춘 뒤 다시 확인해 주세요."
    ));
  }
  if let Some(name) = &facts.jake {
    verdict.warnings.push(format!(
      "이 컴퓨터에는 이미 jake 에이전트({name})가 설치되어 BMO 서버의 기기로 연결되어 있습니다. All-in-One은 jake를 설치하지 않으므로 그대로 두고, 이 컴퓨터에 BMO를 따로 설치합니다."
    ));
  }
  let gib = |kib: u64| kib / (1024 * 1024);
  if gib(facts.memory_kib) + 1 < MEMORY_GIB {
    verdict.warnings.push(format!(
      "메모리가 {} GB입니다. 빌드에는 {MEMORY_GIB} GB 이상을 권장하며, 부족하면 빌드가 중단될 수 있습니다.",
      gib(facts.memory_kib)
    ));
  }
  if gib(facts.disk_kib) < DISK_GIB {
    verdict.warnings.push(format!(
      "홈 폴더의 남은 공간이 {} GB입니다. 빌드와 릴리스에 {DISK_GIB} GB 이상이 필요합니다.",
      gib(facts.disk_kib)
    ));
  }
  verdict
}

/// The programs the first run's preparing needs before any installer stands to name what else is missing: git for
/// the index's clone, and Rust with a C compiler for the installer's build. The prerequisites bring each.
pub fn unprepared(facts: &Facts) -> Vec<Missing> {
  [
    (facts.git, "git", "색인과 각 저장소를 내려받는 데 필요합니다."),
    (
      facts.cargo,
      "cargo",
      "Rust 도구입니다. 설치 프로그램과 각 서비스를 소스에서 빌드합니다.",
    ),
    (facts.cc, "cc", "C 컴파일러입니다. 빌드가 링크하는 데 필요합니다."),
  ]
  .into_iter()
  .filter(|(stands, ..)| !stands)
  .map(|(_, program, detail)| Missing {
    program: program.to_owned(),
    detail: detail.to_owned(),
    next: String::new(),
  })
  .collect()
}

fn or_unknown(value: &str) -> &str {
  if value.is_empty() { "알 수 없는 시스템" } else { value }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn fit(extra: &str) -> Facts {
    facts(&format!(
      "os=Linux\narch=x86_64\nuid=1000\nuser=p\nhome=/home/p\nmemory_kib=33554432\ndisk_kib=104857600\n{extra}"
    ))
  }

  #[test]
  fn a_console_port_another_program_holds_refuses_the_machine_naming_both() {
    let held = fit("console_port=held\nconsole_port_holder=node\nconsole_port_own=no\n");
    assert_eq!(
      held.console_port,
      Some(Listener {
        program: "node".into(),
        own: false
      })
    );
    let refusals = verdict(&held).refusals;
    assert_eq!(refusals.len(), 1);
    assert!(refusals[0].contains("3210") && refusals[0].contains("node"), "{refusals:?}");

    let unseen = verdict(&fit("console_port=held\nconsole_port_holder=\nconsole_port_own=no\n")).refusals;
    assert!(unseen[0].contains("다른 프로그램"), "{unseen:?}");
  }

  #[test]
  fn the_sets_own_console_or_a_free_port_refuses_nothing() {
    for extra in [
      "console_port=held\nconsole_port_holder=bun\nconsole_port_own=yes\n",
      "console_port=free\n",
      "",
    ] {
      assert_eq!(verdict(&fit(extra)).refusals, Vec::<String>::new(), "{extra}");
    }
  }

  #[test]
  fn a_jake_installed_on_the_machine_is_said_as_something_to_accept() {
    let found = fit("jake=jake-wsl\n");
    assert_eq!(found.jake.as_deref(), Some("jake-wsl"));
    let verdict = verdict(&found);
    assert!(verdict.refusals.is_empty());
    assert!(verdict.warnings.iter().any(|warning| warning.contains("jake-wsl")), "{verdict:?}");
    assert_eq!(fit("jake=\n").jake, None);
  }

  #[test]
  fn a_console_port_held_on_this_side_is_found_by_binding_it() {
    // Facts the distribution already settled are kept as they stand.
    let free = with_windows_side(Facts {
      console_port: Some(Listener {
        program: "kept".into(),
        own: true,
      }),
      jake: Some("kept".into()),
      ..Facts::default()
    });
    assert_eq!(free.console_port.map(|listener| listener.program).as_deref(), Some("kept"));
    assert_eq!(free.jake.as_deref(), Some("kept"));
    // The test holds the console's port itself, where it is free, standing for a Windows program that holds it.
    if let Ok(_holder) = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, CONSOLE_PORT)) {
      let held = with_windows_side(Facts {
        jake: Some("kept".into()),
        ..Facts::default()
      });
      assert_eq!(held.console_port.map(|listener| listener.own), Some(false));
    }
  }

  #[test]
  fn the_probe_script_reads_the_console_port_and_an_installed_jake() {
    assert!(SCRIPT.contains("console_port=3210"));
    assert!(SCRIPT.contains("jake-agent.service"));
  }
}
