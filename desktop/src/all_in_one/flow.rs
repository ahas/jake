// The first run as a flow of screens (docs/all-in-one.md, 「The first run」): each event, from the person or from
// work the app has done, moves the flow to its next screen and names the work to do next. The flow does no work
// itself, so every road through it is read here and tested apart from the machine.

use serde::Serialize;

use crate::all_in_one::installer::{Asked, Missing, Outcome};
use crate::all_in_one::probe::{Facts, unprepared, verdict};

/// The chat service BMO talks through besides the console, the preset's one choice.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Chat {
  Telegram,
  Discord,
}

impl Chat {
  /// The repository the installer's `--with` names.
  pub fn repository(self) -> &'static str {
    match self {
      Chat::Telegram => "bmo-telegram",
      Chat::Discord => "bmo-discord",
    }
  }
}

/// Who runs the set's units.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Manager {
  /// The systemd user manager, as on a server.
  Systemd,
  /// The testbed's supervisor, started by the app.
  Supervisor,
}

/// The screen the bundled page draws.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "screen", rename_all = "camelCase")]
pub enum Screen {
  Welcome,
  Checking,
  Refused {
    reasons: Vec<String>,
  },
  Accept {
    warnings: Vec<String>,
  },
  Preparing,
  Planning,
  Prerequisites {
    missing: Vec<Missing>,
  },
  Inputs {
    asked: Vec<Asked>,
  },
  Installing,
  Failed {
    step: String,
    detail: String,
    next: String,
  },
  Starting,
  Ready {
    console: String,
  },
}

/// What the app does next.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Work {
  /// Nothing until the person acts.
  Wait,
  Probe,
  /// The index laid down, the installer built, and the manager started where it is the supervisor.
  Prepare(Manager),
  /// The installer's dry run.
  Plan,
  /// The system's packages, then Rust and Bun for the account.
  Prerequisites,
  /// The installer's real run.
  Install,
  /// The set started under its manager.
  Start(Manager),
  /// The console opened in the window.
  Open(String),
}

/// What moves the flow.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Event {
  /// The app started: with the console an earlier install reported, or none.
  Began {
    console: Option<String>,
    manager: Option<Manager>,
  },
  /// The person consented, with the chat service chosen.
  Consented(Chat),
  Probed(Facts),
  /// The person accepted what the check warned of.
  Accepted,
  Prepared(Result<(), String>),
  Planned(Outcome),
  /// The person asked for the prerequisites installed.
  InstallPrerequisites,
  PrerequisitesDone(Result<(), String>),
  /// Every value asked was kept.
  InputsKept,
  Installed(Outcome),
  Started(Result<(), String>),
  /// The person asked for the step that stopped to be taken again.
  Retry,
}

/// The flow and what it has learned.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Flow {
  pub screen: Screen,
  pub chat: Option<Chat>,
  pub manager: Option<Manager>,
  pub facts: Option<Facts>,
  /// The console's address, once an install reported it.
  pub console: Option<String>,
  /// Whether the index is laid down and the installer built.
  pub prepared: bool,
  /// The work a retry takes again.
  last: Work,
}

impl Default for Flow {
  fn default() -> Self {
    Self {
      screen: Screen::Welcome,
      chat: None,
      manager: None,
      facts: None,
      console: None,
      prepared: false,
      last: Work::Wait,
    }
  }
}

impl Flow {
  /// The flow moved by one event; the work it asks for next.
  pub fn on(&mut self, event: Event) -> Work {
    let work = match event {
      Event::Began {
        console: Some(console),
        manager: Some(manager),
      } => {
        self.manager = Some(manager);
        self.console = Some(console);
        self.screen = Screen::Starting;
        Work::Probe
      }
      Event::Began { .. } => {
        self.screen = Screen::Welcome;
        Work::Wait
      }
      Event::Consented(chat) => {
        self.chat = Some(chat);
        self.screen = Screen::Checking;
        Work::Probe
      }
      Event::Probed(facts) => {
        let read = verdict(&facts);
        let manager = if facts.systemd { Manager::Systemd } else { Manager::Supervisor };
        let starting = self.screen == Screen::Starting;
        self.facts = Some(facts);
        if starting {
          // An installed set keeps the manager it was installed under.
          return self.remember(Work::Start(self.manager.unwrap_or(manager)));
        }
        self.manager = Some(manager);
        if !read.refusals.is_empty() {
          self.screen = Screen::Refused {
            reasons: read.refusals,
          };
          Work::Wait
        } else if !read.warnings.is_empty() {
          self.screen = Screen::Accept {
            warnings: read.warnings,
          };
          Work::Wait
        } else {
          self.prepare(manager)
        }
      }
      Event::Accepted => self.prepare(self.manager.unwrap_or(Manager::Supervisor)),
      Event::Prepared(Ok(())) => {
        self.prepared = true;
        self.screen = Screen::Planning;
        Work::Plan
      }
      // The prerequisites a bare machine lacked are in place: the preparing they held back goes on.
      Event::PrerequisitesDone(Ok(())) if !self.prepared => {
        self.screen = Screen::Preparing;
        Work::Prepare(self.manager.unwrap_or(Manager::Supervisor))
      }
      Event::PrerequisitesDone(Ok(())) | Event::InputsKept => {
        self.screen = Screen::Planning;
        Work::Plan
      }
      Event::Prepared(Err(detail)) => self.failed("prepare", detail),
      Event::PrerequisitesDone(Err(detail)) => self.failed("prerequisites", detail),
      Event::InstallPrerequisites => {
        self.screen = Screen::Planning;
        Work::Prerequisites
      }
      Event::Planned(outcome) => match outcome {
        Outcome::Done { .. } => {
          self.screen = Screen::Installing;
          Work::Install
        }
        Outcome::Missing(missing) => {
          self.screen = Screen::Prerequisites { missing };
          Work::Wait
        }
        Outcome::Asked(asked) => {
          self.screen = Screen::Inputs { asked };
          Work::Wait
        }
        Outcome::Failed { step, detail, next } => self.stopped(step, detail, next),
      },
      Event::Installed(outcome) => match outcome {
        Outcome::Done {
          console: Some(console),
        } => {
          self.console = Some(console.clone());
          self.screen = Screen::Ready {
            console: console.clone(),
          };
          Work::Open(console)
        }
        Outcome::Done { console: None } => self.stopped(
          "done".into(),
          "설치는 끝났지만 콘솔 주소가 보고되지 않았습니다.".into(),
          String::new(),
        ),
        Outcome::Missing(missing) => {
          self.screen = Screen::Prerequisites { missing };
          Work::Wait
        }
        Outcome::Asked(asked) => {
          self.screen = Screen::Inputs { asked };
          Work::Wait
        }
        Outcome::Failed { step, detail, next } => self.stopped(step, detail, next),
      },
      Event::Started(Ok(())) => match self.console.clone() {
        Some(console) => {
          self.screen = Screen::Ready {
            console: console.clone(),
          };
          Work::Open(console)
        }
        None => Work::Wait,
      },
      Event::Started(Err(detail)) => self.failed("start", detail),
      Event::Retry => {
        self.screen = match &self.last {
          Work::Install => Screen::Installing,
          Work::Start(_) => Screen::Starting,
          Work::Probe => Screen::Checking,
          Work::Prepare(_) => Screen::Preparing,
          _ => Screen::Planning,
        };
        return self.last.clone();
      }
    };
    self.remember(work)
  }

  /// The index laid down and the installer built, or first the prerequisites a bare machine lacks for that: the
  /// clone needs git and the build Rust and a C compiler, which the plan's own `needs:` lines come too late to name.
  fn prepare(&mut self, manager: Manager) -> Work {
    let missing = self.facts.as_ref().map(unprepared).unwrap_or_default();
    if missing.is_empty() {
      self.screen = Screen::Preparing;
      Work::Prepare(manager)
    } else {
      self.screen = Screen::Prerequisites { missing };
      Work::Wait
    }
  }

  fn remember(&mut self, work: Work) -> Work {
    if !matches!(work, Work::Wait | Work::Open(_)) {
      self.last = work.clone();
    }
    work
  }

  fn failed(&mut self, step: &str, detail: String) -> Work {
    self.stopped(step.to_owned(), detail, String::new())
  }

  fn stopped(&mut self, step: String, detail: String, next: String) -> Work {
    self.screen = Screen::Failed { step, detail, next };
    Work::Wait
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn facts(systemd: bool, memory_gib: u64) -> Facts {
    Facts {
      os: "Linux".into(),
      arch: "x86_64".into(),
      uid: Some(1000),
      user: "someone".into(),
      home: "/home/someone".into(),
      memory_kib: memory_gib * 1024 * 1024,
      disk_kib: 200 * 1024 * 1024,
      systemd,
      git: true,
      cargo: true,
      cc: true,
    }
  }

  #[test]
  fn nothing_happens_before_the_person_consents() {
    let mut flow = Flow::default();
    assert_eq!(
      flow.on(Event::Began {
        console: None,
        manager: None
      }),
      Work::Wait
    );
    assert_eq!(flow.screen, Screen::Welcome);
    assert_eq!(flow.on(Event::Consented(Chat::Discord)), Work::Probe);
    assert_eq!(flow.chat.map(Chat::repository), Some("bmo-discord"));
  }

  #[test]
  fn the_whole_first_run_goes_from_consent_to_the_console() {
    let mut flow = Flow::default();
    flow.on(Event::Consented(Chat::Telegram));
    assert_eq!(flow.on(Event::Probed(facts(false, 32))), Work::Prepare(Manager::Supervisor));
    assert_eq!(flow.on(Event::Prepared(Ok(()))), Work::Plan);
    let asked = vec![Asked {
      input: "web.owner-name".into(),
      detail: "the name".into(),
      secret: false,
    }];
    assert_eq!(flow.on(Event::Planned(Outcome::Asked(asked.clone()))), Work::Wait);
    assert_eq!(flow.screen, Screen::Inputs { asked });
    assert_eq!(flow.on(Event::InputsKept), Work::Plan);
    assert_eq!(flow.on(Event::Planned(Outcome::Done { console: None })), Work::Install);
    let console = "http://127.0.0.1:3210/bmo/".to_owned();
    assert_eq!(
      flow.on(Event::Installed(Outcome::Done {
        console: Some(console.clone())
      })),
      Work::Open(console.clone())
    );
    assert_eq!(flow.screen, Screen::Ready { console });
  }

  #[test]
  fn a_machine_with_systemd_runs_the_set_under_it() {
    let mut flow = Flow::default();
    flow.on(Event::Consented(Chat::Telegram));
    assert_eq!(flow.on(Event::Probed(facts(true, 32))), Work::Prepare(Manager::Systemd));
  }

  #[test]
  fn a_root_account_is_refused_and_too_little_memory_is_asked_to_be_accepted() {
    let mut flow = Flow::default();
    flow.on(Event::Consented(Chat::Telegram));
    let root = Facts {
      uid: Some(0),
      ..facts(true, 32)
    };
    assert_eq!(flow.on(Event::Probed(root)), Work::Wait);
    assert!(matches!(&flow.screen, Screen::Refused { reasons } if reasons.len() == 1));

    let mut flow = Flow::default();
    flow.on(Event::Consented(Chat::Telegram));
    assert_eq!(flow.on(Event::Probed(facts(true, 8))), Work::Wait);
    assert!(matches!(&flow.screen, Screen::Accept { warnings } if warnings.len() == 1));
    assert_eq!(flow.on(Event::Accepted), Work::Prepare(Manager::Systemd));
  }

  #[test]
  fn missing_programs_offer_the_prerequisites_and_the_plan_is_read_again() {
    let mut flow = Flow::default();
    flow.on(Event::Consented(Chat::Telegram));
    flow.on(Event::Probed(facts(true, 32)));
    flow.on(Event::Prepared(Ok(())));
    let missing = vec![Missing {
      program: "cargo".into(),
      detail: "Rust".into(),
      next: String::new(),
    }];
    assert_eq!(flow.on(Event::Planned(Outcome::Missing(missing))), Work::Wait);
    assert_eq!(flow.on(Event::InstallPrerequisites), Work::Prerequisites);
    assert_eq!(flow.on(Event::PrerequisitesDone(Ok(()))), Work::Plan);
  }

  #[test]
  fn a_bare_machine_gets_its_prerequisites_before_the_index_is_laid_down() {
    let mut flow = Flow::default();
    flow.on(Event::Consented(Chat::Telegram));
    let bare = Facts {
      git: false,
      cargo: false,
      cc: false,
      ..facts(false, 32)
    };
    assert_eq!(flow.on(Event::Probed(bare)), Work::Wait);
    let Screen::Prerequisites { missing } = &flow.screen else { panic!("prerequisites") };
    let programs: Vec<&str> = missing.iter().map(|missing| missing.program.as_str()).collect();
    assert_eq!(programs, ["git", "cargo", "cc"]);
    assert_eq!(flow.on(Event::InstallPrerequisites), Work::Prerequisites);
    assert_eq!(flow.on(Event::PrerequisitesDone(Ok(()))), Work::Prepare(Manager::Supervisor));
    assert_eq!(flow.screen, Screen::Preparing);
    assert_eq!(flow.on(Event::Prepared(Ok(()))), Work::Plan);
    flow.on(Event::Planned(Outcome::Missing(Vec::new())));
    flow.on(Event::InstallPrerequisites);
    assert_eq!(flow.on(Event::PrerequisitesDone(Ok(()))), Work::Plan);
  }

  #[test]
  fn a_failed_step_is_shown_and_a_retry_takes_the_same_work_again() {
    let mut flow = Flow::default();
    flow.on(Event::Consented(Chat::Telegram));
    flow.on(Event::Probed(facts(true, 32)));
    flow.on(Event::Prepared(Ok(())));
    flow.on(Event::Planned(Outcome::Done { console: None }));
    let failed = Outcome::Failed {
      step: "deploy:bmo-web".into(),
      detail: "out of memory".into(),
      next: "rerun".into(),
    };
    assert_eq!(flow.on(Event::Installed(failed)), Work::Wait);
    assert!(matches!(&flow.screen, Screen::Failed { step, .. } if step == "deploy:bmo-web"));
    assert_eq!(flow.on(Event::Retry), Work::Install);
    assert_eq!(flow.screen, Screen::Installing);
  }

  #[test]
  fn an_installed_set_is_started_under_the_manager_it_was_installed_under() {
    let mut flow = Flow::default();
    let began = Event::Began {
      console: Some("http://127.0.0.1:3210/bmo/".into()),
      manager: Some(Manager::Supervisor),
    };
    assert_eq!(flow.on(began), Work::Probe);
    assert_eq!(flow.screen, Screen::Starting);
    assert_eq!(flow.on(Event::Probed(facts(true, 32))), Work::Start(Manager::Supervisor));
    assert_eq!(flow.on(Event::Started(Ok(()))), Work::Open("http://127.0.0.1:3210/bmo/".into()));
  }
}
