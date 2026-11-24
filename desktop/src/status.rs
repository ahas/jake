// What the app shows of itself: the console's and the built-in agent's states, in the words a person reads.

use std::time::Duration;

use jake_agent::Link;
use serde::Serialize;
use url::Url;

/// Where the console stands as the window last tried it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ConsoleState {
  Checking,
  Shown,
  Unreachable(String),
}

/// Where the built-in agent stands.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AgentState {
  Starting,
  /// The app names no server yet, so nothing runs until the person names one.
  NoServer,
  /// No credential store stands on this machine, for the reason given.
  NoStore(String),
  /// A pairing is open under this code, approved on this page of the console.
  Pairing {
    code: String,
    approve_url: Url,
  },
  /// A pairing gave no machine, for the reason given.
  PairingFailed(PairingFailure),
  Link(Link),
  /// The agent panicked and starts again after this pause.
  Restarting(Duration),
  /// The session is locked and control is not kept while it is, so the agent waits for the unlock.
  Paused,
  /// An installed agent of this name is on the machine, so the built-in one stays off.
  HeldOff(String),
  /// The installed agent's uninstaller runs, after which the built-in agent starts.
  Switching,
  /// The installed agent's uninstaller could not stop it, for the reason given, so it serves on.
  SwitchFailed {
    name: String,
    reason: String,
  },
  /// Another connection took this name at the hub, so the built-in agent gave it up.
  Yielded(String),
  /// The hub sent a leave: the machine was removed and its credential forgotten.
  Removed,
}

/// Why a pairing gave no machine, as the person is told it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PairingFailure {
  ConsoleUnreachable,
  Gone,
  Invalid,
  NotKept,
}

/// Everything the app shows of itself.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Status {
  pub console: ConsoleState,
  pub agent: AgentState,
}

impl Default for Status {
  fn default() -> Self {
    Self {
      console: ConsoleState::Checking,
      agent: AgentState::Starting,
    }
  }
}

/// How a state reads at a glance, which the page colours its mark by.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Tone {
  Good,
  Working,
  /// Waiting on the person, with nothing wrong and nothing under way.
  Idle,
  Attention,
}

/// What the page offers to do about the state it shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Action {
  /// Ask the console for a new pairing.
  PairAgain,
  /// Look again for an installed agent, or a credential store, and start the built-in agent if it may.
  LookAgain,
}

/// The status as the bundled page draws it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
  /// The window's title, which the page's own top bar shows since the window draws none.
  pub title: String,
  pub headline: String,
  pub detail: Vec<String>,
  pub tone: Tone,
  pub code: Option<String>,
  pub action: Option<Action>,
  /// Whether the page offers to stop the installed agent and start the built-in one in its place.
  pub offers_switch: bool,
  pub console_shown: bool,
  pub console_detail: Option<String>,
  /// Whether the page asks for the server's address, which it does while the app names none.
  pub asks_server: bool,
}

impl Status {
  pub fn view(&self) -> View {
    let (headline, detail, tone, action) = self.agent.words();
    let (console_shown, console_detail) = match &self.console {
      ConsoleState::Shown => (true, None),
      ConsoleState::Checking => (false, None),
      ConsoleState::Unreachable(_) => (false, Some("콘솔에 연결되지 않습니다.".to_owned())),
    };
    View {
      title: self.title(),
      headline,
      detail,
      tone,
      code: match &self.agent {
        AgentState::Pairing { code, .. } => Some(code.clone()),
        _ => None,
      },
      action,
      offers_switch: self.agent.offers_switch(),
      console_shown,
      console_detail,
      asks_server: self.agent == AgentState::NoServer,
    }
  }

  /// The window's title: the product, led by the pairing code while one is open so a title cut short
  /// still shows it.
  pub fn title(&self) -> String {
    match &self.agent {
      AgentState::Pairing { code, .. } => format!("연결 코드 {code} · BMO"),
      _ => "BMO".to_owned(),
    }
  }

  /// The tray icon's tooltip.
  pub fn tooltip(&self) -> String {
    format!("BMO · {}", self.agent.words().0)
  }
}

impl AgentState {
  /// Whether the course stopped here for the person to act, which the local page is where they do.
  pub fn waits_on_person(&self) -> bool {
    matches!(
      self,
      Self::NoStore(_)
        | Self::PairingFailed(_)
        | Self::HeldOff(_)
        | Self::SwitchFailed { .. }
        | Self::Yielded(_)
        | Self::Removed
    )
  }

  /// Whether the page offers to switch from the installed agent to the built-in one.
  pub fn offers_switch(&self) -> bool {
    matches!(self, Self::HeldOff(_) | Self::SwitchFailed { .. })
  }

  fn words(&self) -> (String, Vec<String>, Tone, Option<Action>) {
    let line = |text: &str| vec![text.to_owned()];
    match self {
      Self::Starting => ("에이전트 준비 중".into(), vec![], Tone::Working, None),
      Self::NoServer => (
        "BMO 서버 연결".into(),
        line("이 앱이 연결할 BMO 서버의 주소를 입력합니다."),
        Tone::Idle,
        None,
      ),
      Self::NoStore(_) => (
        "자격 증명을 저장할 수 없습니다".into(),
        vec![
          "자격 증명 저장소가 없어 내장 에이전트를 켜지 않았습니다.".into(),
          "자격 증명은 파일로 저장하지 않습니다.".into(),
        ],
        Tone::Attention,
        Some(Action::LookAgain),
      ),
      Self::Pairing { .. } => (
        "기기 연결 대기 중".into(),
        line("콘솔에서 같은 연결 코드인지 확인하고 승인해 주세요."),
        Tone::Working,
        None,
      ),
      Self::PairingFailed(failure) => (
        "기기를 연결하지 못했습니다".into(),
        line(match failure {
          PairingFailure::ConsoleUnreachable => "콘솔에 연결되지 않습니다.",
          PairingFailure::Gone => "승인 요청이 만료되었거나 거부되었습니다.",
          PairingFailure::Invalid => "콘솔의 응답이 올바르지 않습니다.",
          PairingFailure::NotKept => "자격 증명을 저장하지 못했습니다.",
        }),
        Tone::Attention,
        Some(Action::PairAgain),
      ),
      Self::Link(Link::Connecting) => ("허브에 연결하는 중".into(), vec![], Tone::Working, None),
      Self::Link(Link::Attached) => ("허브에 연결됨".into(), vec![], Tone::Good, None),
      Self::Link(Link::Refused(_)) => (
        "허브가 연결을 거부했습니다".into(),
        line("자동으로 다시 시도합니다."),
        Tone::Attention,
        None,
      ),
      Self::Link(Link::Unreachable(_)) => (
        "허브에 연결되지 않습니다".into(),
        line("자동으로 다시 시도합니다."),
        Tone::Attention,
        None,
      ),
      Self::Restarting(pause) => (
        "에이전트를 다시 시작합니다".into(),
        vec![format!("오류로 중지되어 {}초 후 다시 실행합니다.", pause.as_secs().max(1))],
        Tone::Attention,
        None,
      ),
      Self::Paused => (
        "PC 잠금 중 일시 중지".into(),
        line("잠금을 해제하면 다시 연결합니다."),
        Tone::Idle,
        None,
      ),
      Self::HeldOff(name) => (
        "설치된 jake를 사용합니다".into(),
        vec![
          format!("이 PC에 같은 기기 이름({name})의 jake 에이전트가 설치되어 있어 내장 에이전트는 켜지 않았습니다."),
          "내장 에이전트로 전환하면 설치된 jake를 중지하고 제거합니다. 설정 파일(agent.env)과 로그는 남습니다."
            .into(),
        ],
        Tone::Good,
        Some(Action::LookAgain),
      ),
      Self::Switching => (
        "내장 에이전트로 전환하는 중".into(),
        line("설치된 jake를 중지하고 제거하는 중입니다."),
        Tone::Working,
        None,
      ),
      Self::SwitchFailed { name, reason } => (
        "내장 에이전트로 전환하지 못했습니다".into(),
        vec![format!("설치된 jake 에이전트({name})를 계속 사용합니다."), reason.clone()],
        Tone::Attention,
        Some(Action::LookAgain),
      ),
      Self::Yielded(name) => (
        "다른 에이전트가 이 이름을 사용합니다".into(),
        vec![
          format!("같은 이름({name})으로 다른 에이전트가 허브에 연결했습니다."),
          "내장 에이전트는 꺼 두었습니다.".into(),
        ],
        Tone::Attention,
        Some(Action::LookAgain),
      ),
      Self::Removed => (
        "기기 연결이 해제되었습니다".into(),
        line("허브에서 이 기기를 제거했습니다."),
        Tone::Attention,
        Some(Action::PairAgain),
      ),
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn the_title_leads_with_an_open_pairing_code() {
    let pairing = Status {
      console: ConsoleState::Shown,
      agent: AgentState::Pairing {
        code: "ABCD-EFGH".to_owned(),
        approve_url: Url::parse("https://console.example.test/desktop/pair").expect("url"),
      },
    };
    assert_eq!(pairing.title(), "연결 코드 ABCD-EFGH · BMO");
    assert_eq!(Status::default().title(), "BMO");
    assert_eq!(pairing.view().title, "연결 코드 ABCD-EFGH · BMO");
  }

  #[test]
  fn the_page_asks_for_the_server_while_the_app_names_none() {
    let serverless = Status {
      console: ConsoleState::Checking,
      agent: AgentState::NoServer,
    };
    assert!(serverless.view().asks_server);
    assert!(!Status::default().view().asks_server);
  }

  #[test]
  fn the_states_that_wait_on_the_person_are_those_the_page_offers_to_go_on_from() {
    let waiting = [
      AgentState::NoStore("none".to_owned()),
      AgentState::PairingFailed(PairingFailure::Gone),
      AgentState::HeldOff("agent-a".to_owned()),
      AgentState::SwitchFailed {
        name: "agent-a".to_owned(),
        reason: "failed".to_owned(),
      },
      AgentState::Yielded("agent-a".to_owned()),
      AgentState::Removed,
    ];
    let going = [
      AgentState::Starting,
      AgentState::NoServer,
      AgentState::Link(Link::Attached),
      AgentState::Paused,
      AgentState::Switching,
    ];

    for state in waiting {
      assert!(state.waits_on_person(), "{state:?}");
      assert!(state.words().3.is_some(), "{state:?}");
    }
    for state in going {
      assert!(!state.waits_on_person(), "{state:?}");
    }
  }

  #[test]
  fn an_installed_agent_in_use_offers_the_switch_and_nothing_else_does() {
    let held = AgentState::HeldOff("agent-a".to_owned());
    let failed = AgentState::SwitchFailed {
      name: "agent-a".to_owned(),
      reason: "the uninstaller ended with 1".to_owned(),
    };
    for state in [&held, &failed] {
      let view = Status {
        console: ConsoleState::Shown,
        agent: state.clone(),
      }
      .view();
      assert!(view.offers_switch, "{state:?}");
      assert_eq!(view.action, Some(Action::LookAgain), "{state:?}");
    }
    assert!(failed.words().1.iter().any(|line| line.contains("ended with 1")));
    for state in [
      AgentState::Switching,
      AgentState::Link(Link::Attached),
      AgentState::Yielded("agent-a".to_owned()),
    ] {
      assert!(!state.offers_switch(), "{state:?}");
    }
  }
}
