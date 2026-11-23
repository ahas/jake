// The set's own installer, driven (docs/all-in-one.md, 「The first run」): the index laid down and the installer
// built as the index's INSTALL.md says, then the testbed's `install` verb run with the personal preset, each of
// its JSON lines read as it comes and the run's end weighed into what the app does next.

use serde::{Deserialize, Serialize};

/// The index's public repository, which the first run clones.
pub const INDEX_REPOSITORY: &str = "https://github.com/ahas/bmo.git";
/// The preset the all-in-one installs.
pub const PRESET: &str = "personal";

/// Lays down the index and builds the installer, as INSTALL.md 「Lay down the index and build the installer」
/// does; the index is its first word.
pub const PREPARE: &str = include_str!("scripts/prepare.sh");
/// The system's packages of INSTALL.md 「Install the prerequisites」, run as root; the account is its first word.
pub const SYSTEM: &str = include_str!("scripts/system.sh");
/// Rust and Bun for the account, as the same section installs them.
pub const ACCOUNT: &str = include_str!("scripts/account.sh");

/// One line the installer printed.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub struct Step {
  pub step: String,
  pub status: String,
  pub detail: String,
  pub next: String,
}

/// A line of the installer read as a step; none for a line that is not one.
pub fn step(line: &str) -> Option<Step> {
  serde_json::from_str(line.trim()).ok()
}

/// A program the plan found missing.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Missing {
  pub program: String,
  pub detail: String,
  pub next: String,
}

/// A value the plan asks of the person.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Asked {
  pub input: String,
  pub detail: String,
  /// Whether the value is one the person keeps secret, such as a password or a token, drawn as a hidden field.
  pub secret: bool,
}

/// What a run of the installer came to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
  /// Every step done or planned; the console's address where the `done` line names one.
  Done { console: Option<String> },
  /// Programs the machine lacks.
  Missing(Vec<Missing>),
  /// Values only the person has.
  Asked(Vec<Asked>),
  /// A step that failed, or a refusal before any step.
  Failed {
    step: String,
    detail: String,
    next: String,
  },
}

/// The exit codes the installer ends with (bmo-testbed's docs/install.md, 「What it prints」).
pub const DONE: i32 = 0;
pub const FAILED: i32 = 1;
pub const WAITING: i32 = 3;

/// A run's lines and its exit code weighed.
pub fn outcome(steps: &[Step], code: i32, said: &str) -> Outcome {
  let missing: Vec<Missing> = steps
    .iter()
    .filter(|step| step.status == "failed")
    .filter_map(|step| {
      step.step.strip_prefix("needs:").map(|program| Missing {
        program: program.to_owned(),
        detail: step.detail.clone(),
        next: step.next.clone(),
      })
    })
    .collect();
  let asked: Vec<Asked> = steps
    .iter()
    .filter(|step| step.status == "needs-input" && step.step != "done")
    .map(|step| {
      let input = step.step.strip_prefix("input:").unwrap_or(&step.step).to_owned();
      let secret = ["password", "bot", "token", "key"].iter().any(|word| input.contains(word));
      Asked {
        input,
        detail: step.detail.clone(),
        secret,
      }
    })
    .collect();
  match code {
    DONE => Outcome::Done {
      console: steps
        .iter()
        .rev()
        .find(|step| step.step == "done")
        .map(|step| step.next.clone())
        .filter(|next| next.starts_with("http")),
    },
    WAITING if !asked.is_empty() => Outcome::Asked(asked),
    FAILED if !missing.is_empty() => Outcome::Missing(missing),
    _ => match steps.iter().find(|step| step.status == "failed") {
      Some(step) => Outcome::Failed {
        step: step.step.clone(),
        detail: step.detail.clone(),
        next: step.next.clone(),
      },
      None => Outcome::Failed {
        step: "install".to_owned(),
        detail: if said.trim().is_empty() {
          format!("설치 프로그램이 {code}로 끝났습니다.")
        } else {
          said.trim().to_owned()
        },
        next: String::new(),
      },
    },
  }
}

/// Where the set is laid down on the machine it runs on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Layout {
  pub home: String,
}

impl Layout {
  pub fn index(&self) -> String {
    format!("{}/bmo", self.home)
  }

  pub fn data_root(&self) -> String {
    format!("{}/.local/share/bmo/data", self.home)
  }

  pub fn prefix(&self) -> String {
    format!("{}/.local/share", self.home)
  }

  /// The installer the first run builds, before the set's deployment links its own beside `bmo`.
  pub fn built_installer(&self) -> String {
    format!("{}/services/testbed/target/release/bmo-testbed", self.index())
  }

  /// The PATH every installer command and the supervisor run with: the account's own tool folders, Rust's, the set's
  /// linked commands and Bun's, laid before `rest`, since a session that began before the prerequisites installed
  /// them does not hold them, and the installer's `needs:` and every build read the PATH.
  pub fn tool_path(&self, rest: &str) -> String {
    let home = &self.home;
    format!("{home}/.cargo/bin:{home}/.local/bin:{home}/.bun/bin:{rest}")
  }

  /// The testbed's binary the deployment links, once the set is installed.
  pub fn linked_installer(&self) -> String {
    format!("{}/.local/bin/bmo-testbed", self.home)
  }

  /// The installer's words for a run of the personal preset, its chat service chosen.
  pub fn install(&self, installer: &str, chat: &str, dry_run: bool) -> Vec<String> {
    let mut words: Vec<String> = [installer, "install", "--preset", PRESET, "--with", chat, "--index"]
      .into_iter()
      .map(str::to_owned)
      .collect();
    words.push(self.index());
    if dry_run {
      words.push("--dry-run".to_owned());
    }
    words
  }

  /// The installer's words that keep one input, its value read from standard input.
  pub fn keep(&self, installer: &str, input: &str) -> Vec<String> {
    [installer, "install", "--set", input, "--index"]
      .into_iter()
      .map(str::to_owned)
      .chain([self.index()])
      .collect()
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn line(step: &str, status: &str, detail: &str, next: &str) -> Step {
    Step {
      step: step.into(),
      status: status.into(),
      detail: detail.into(),
      next: next.into(),
    }
  }

  #[test]
  fn a_line_of_the_installer_is_read_as_a_step_and_anything_else_is_passed_over() {
    let read = step(r#"{"step":"clone:bmo-web","status":"ok","detail":"cloned","next":""}"#).unwrap();
    assert_eq!(read, line("clone:bmo-web", "ok", "cloned", ""));
    assert_eq!(step("   Compiling bmo-testbed v0.1.0"), None);
  }

  #[test]
  fn a_done_run_names_the_console_its_done_line_reports() {
    let steps = [
      line("preset", "ok", "", ""),
      line("done", "ok", "installed", "http://127.0.0.1:3210/bmo/"),
    ];
    assert_eq!(
      outcome(&steps, DONE, ""),
      Outcome::Done {
        console: Some("http://127.0.0.1:3210/bmo/".into())
      }
    );
    let dry = [line("done", "ok", "planned", "")];
    assert_eq!(outcome(&dry, DONE, ""), Outcome::Done { console: None });
  }

  #[test]
  fn a_plan_that_waits_names_each_value_and_hides_the_secret_ones() {
    let steps = [
      line(
        "input:web.owner-name",
        "needs-input",
        "the console's sign-in name",
        "bmo install --set web.owner-name",
      ),
      line(
        "input:web.owner-password",
        "needs-input",
        "the password",
        "bmo install --set web.owner-password",
      ),
      line("input:telegram.bot", "needs-input", "the bot's token", ""),
      line("done", "needs-input", "waits", ""),
    ];
    let Outcome::Asked(asked) = outcome(&steps, WAITING, "") else { panic!("asked") };
    let names: Vec<(&str, bool)> = asked.iter().map(|asked| (asked.input.as_str(), asked.secret)).collect();
    assert_eq!(
      names,
      vec![("web.owner-name", false), ("web.owner-password", true), ("telegram.bot", true)]
    );
  }

  #[test]
  fn missing_programs_are_listed_and_any_other_failure_names_its_step() {
    let steps = [
      line("needs:herdr", "failed", "the terminal host", "install Zig"),
      line("needs:git", "ok", "", ""),
    ];
    assert_eq!(
      outcome(&steps, FAILED, ""),
      Outcome::Missing(vec![Missing {
        program: "herdr".into(),
        detail: "the terminal host".into(),
        next: "install Zig".into()
      }])
    );
    let failed = [line(
      "deploy:bmo-web",
      "failed",
      "the build ran out of memory",
      "journalctl --user -u x",
    )];
    assert_eq!(
      outcome(&failed, FAILED, ""),
      Outcome::Failed {
        step: "deploy:bmo-web".into(),
        detail: "the build ran out of memory".into(),
        next: "journalctl --user -u x".into()
      }
    );
    assert!(matches!(outcome(&[], 2, "no index"), Outcome::Failed { detail, .. } if detail == "no index"));
  }

  #[test]
  fn the_install_is_run_with_the_personal_preset_and_the_index() {
    let layout = Layout {
      home: "/home/someone".into(),
    };
    assert_eq!(
      layout.install("/bin/bmo-testbed", "bmo-telegram", true),
      [
        "/bin/bmo-testbed",
        "install",
        "--preset",
        "personal",
        "--with",
        "bmo-telegram",
        "--index",
        "/home/someone/bmo",
        "--dry-run"
      ]
    );
    assert_eq!(
      layout.keep("/bin/bmo-testbed", "web.owner-name"),
      ["/bin/bmo-testbed", "install", "--set", "web.owner-name", "--index", "/home/someone/bmo"]
    );
    assert_eq!(layout.data_root(), "/home/someone/.local/share/bmo/data");
  }

  #[test]
  fn the_account_s_tool_folders_stand_first_on_the_installer_s_path() {
    let layout = Layout {
      home: "/home/someone".into(),
    };
    assert_eq!(
      layout.tool_path("/usr/bin:/bin"),
      "/home/someone/.cargo/bin:/home/someone/.local/bin:/home/someone/.bun/bin:/usr/bin:/bin"
    );
  }
}
