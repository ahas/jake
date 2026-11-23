// The machine read once, where the set will run (docs/all-in-one.md, 「The first run」): a probe script of the
// app's own prints one `name=value` line for each fact, and the facts are weighed into what refuses the machine
// and what the person is asked to accept.

/// The probe, run with `sh` on the machine or in the distribution the set runs in. Its lines are this app's own
/// shape, `name=value`, read by `facts`.
pub const SCRIPT: &str = include_str!("scripts/probe.sh");

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
      _ => {}
    }
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

fn or_unknown(value: &str) -> &str {
  if value.is_empty() { "알 수 없는 시스템" } else { value }
}
