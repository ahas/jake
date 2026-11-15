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
  /// An installed agent of this name runs on the machine, so the built-in one stays off.
  HeldOff(String),
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
  pub headline: String,
  pub detail: Vec<String>,
  pub tone: Tone,
  pub code: Option<String>,
  pub action: Option<Action>,
  pub console_shown: bool,
  pub console_detail: Option<String>,
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
      headline,
      detail,
      tone,
      code: match &self.agent {
        AgentState::Pairing { code, .. } => Some(code.clone()),
        _ => None,
      },
      action,
      console_shown,
      console_detail,
    }
  }

  /// The window's title: the product, and the pairing code while one is open.
  pub fn title(&self) -> String {
    match &self.agent {
      AgentState::Pairing { code, .. } => format!("BMO · 연결 코드 {code}"),
      _ => "BMO".to_owned(),
    }
  }

  /// The tray icon's tooltip.
  pub fn tooltip(&self) -> String {
    format!("BMO · {}", self.agent.words().0)
  }
}

impl AgentState {
  fn words(&self) -> (String, Vec<String>, Tone, Option<Action>) {
    let line = |text: &str| vec![text.to_owned()];
    match self {
      Self::Starting => ("에이전트 준비 중".into(), vec![], Tone::Working, None),
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
      Self::HeldOff(name) => (
        "설치된 에이전트를 사용합니다".into(),
        vec![
          format!("이 기기에서 같은 이름({name})의 jake 에이전트가 실행 중입니다."),
          "내장 에이전트는 꺼 두었습니다.".into(),
        ],
        Tone::Good,
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
