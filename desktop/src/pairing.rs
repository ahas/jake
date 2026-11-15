// The console's device pairing as the app's Rust side speaks it: ask, show the approval page, poll.

use std::time::Duration;

use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use tokio::time::{Instant, sleep};
use url::Url;

/// How long a pairing lives on the console's side.
const PAIRING_LIFETIME: Duration = Duration::from_secs(10 * 60);
/// How long past the lifetime the app keeps polling, for a clock that runs a little apart.
const LIFETIME_MARGIN: Duration = Duration::from_secs(30);
/// How long one request to the console may take.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
/// The shortest pause between polls, whatever the console asks for.
const POLL_FLOOR: Duration = Duration::from_secs(1);

/// The machine a pairing was approved for: its name, its own credential and the hub it dials.
#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Machine {
  pub node: String,
  pub credential: String,
  pub hub_url: String,
}

impl Machine {
  /// The machine, once its credential is seen to be made for its name and its hub is a WebSocket
  /// address; the credential's value is never part of the refusal.
  fn checked(self) -> Result<Self, PairingError> {
    let invalid = |what: &str| Err(PairingError::Invalid(what.to_owned()));
    let Some((name, mac)) = self.credential.rsplit_once('.') else {
      return invalid("the credential is not of the form <name>.<mac>");
    };
    if name != self.node {
      return invalid("the credential was made for another machine than the one named");
    }
    if mac.len() != 64 || !mac.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) {
      return invalid("the credential's mac is not a hex HMAC-SHA256");
    }
    match Url::parse(&self.hub_url) {
      Ok(hub) if matches!(hub.scheme(), "wss" | "ws") => Ok(self),
      _ => invalid("the hub's address is not a WebSocket address"),
    }
  }
}

/// A pairing the console opened: what the app keeps, and what it shows.
pub struct Pairing {
  pub id: String,
  pub code: String,
  pub approve_url: Url,
  pub poll_after: Duration,
}

/// Why a pairing gave no machine.
#[derive(Debug, PartialEq, Eq)]
pub enum PairingError {
  /// The console could not be asked for a pairing.
  Unreachable(String),
  /// The pairing expired, was refused, or was already read.
  Gone,
  /// The console's answer did not hold together, for the reason given.
  Invalid(String),
}

enum Poll {
  Waiting,
  Approved(Machine),
  Gone,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Opened {
  pairing: String,
  code: String,
  approve_url: String,
  poll_after_seconds: u64,
}

/// The console the app pairs with, reached over the app's own HTTPS client.
pub struct Console {
  base: Url,
  http: reqwest::Client,
  poll_floor: Duration,
}

impl Console {
  pub fn new(base: Url) -> Self {
    Self::with_poll_floor(base, POLL_FLOOR)
  }

  fn with_poll_floor(base: Url, poll_floor: Duration) -> Self {
    let http = reqwest::Client::builder()
      .timeout(REQUEST_TIMEOUT)
      .user_agent(concat!("jake-desktop/", env!("CARGO_PKG_VERSION")))
      .build()
      .expect("an HTTPS client with a timeout and an agent name can be built");
    Self {
      base,
      http,
      poll_floor,
    }
  }

  /// The console's own address.
  pub fn base(&self) -> &Url {
    &self.base
  }

  /// Whether the console answers as a server would; an answer of 500 or above is a console that is
  /// down behind its proxy.
  pub async fn reachable(&self) -> Result<(), String> {
    let response = self.http.get(self.base.clone()).send().await.map_err(|error| error.to_string())?;
    match response.status() {
      status if status.is_server_error() => Err(format!("the console answered {status}")),
      _ => Ok(()),
    }
  }

  /// Ask for a pairing, hand it to `shown` once it is open, and poll it until it is approved, refused
  /// or expired.
  pub async fn pair(&self, shown: impl FnOnce(&Pairing)) -> Result<Machine, PairingError> {
    let pairing = self.open().await?;
    shown(&pairing);
    let deadline = Instant::now() + PAIRING_LIFETIME + LIFETIME_MARGIN;
    loop {
      sleep(pairing.poll_after).await;
      if Instant::now() > deadline {
        return Err(PairingError::Gone);
      }
      // A poll that fails on the way is asked again at the next interval; the deadline bounds it.
      match self.poll(&pairing.id).await {
        Ok(Poll::Waiting) | Err(_) => {}
        Ok(Poll::Approved(machine)) => return machine.checked(),
        Ok(Poll::Gone) => return Err(PairingError::Gone),
      }
    }
  }

  fn pairings(&self) -> Url {
    self
      .base
      .join("api/desktop/pairings")
      .expect("a relative path joins onto the console's address")
  }

  async fn open(&self) -> Result<Pairing, PairingError> {
    let unreachable = |error: reqwest::Error| PairingError::Unreachable(error.to_string());
    let response = self.http.post(self.pairings()).send().await.map_err(unreachable)?;
    let response = response.error_for_status().map_err(unreachable)?;
    let opened: Opened = response.json().await.map_err(|error| PairingError::Invalid(error.to_string()))?;
    let approve_url = self
      .base
      .join(&opened.approve_url)
      .map_err(|error| PairingError::Invalid(format!("the approval page's address: {error}")))?;
    if approve_url.origin() != self.base.origin() {
      return Err(PairingError::Invalid("the approval page is not on the console's origin".into()));
    }
    Ok(Pairing {
      id: opened.pairing,
      code: opened.code,
      approve_url,
      poll_after: Duration::from_secs(opened.poll_after_seconds).max(self.poll_floor),
    })
  }

  async fn poll(&self, id: &str) -> Result<Poll, String> {
    let mut url = self.pairings();
    url
      .path_segments_mut()
      .map_err(|()| "the console's address cannot take a path".to_owned())?
      .push(id);
    let response = self.http.get(url).send().await.map_err(|error| error.to_string())?;
    match response.status() {
      StatusCode::ACCEPTED => Ok(Poll::Waiting),
      StatusCode::OK => response.json().await.map(Poll::Approved).map_err(|error| error.to_string()),
      StatusCode::GONE | StatusCode::NOT_FOUND => Ok(Poll::Gone),
      status => Err(format!("the console answered {status}")),
    }
  }
}

#[cfg(test)]
mod tests {
  use std::sync::Arc;
  use std::sync::atomic::{AtomicUsize, Ordering};

  use axum::Router;
  use axum::extract::{Path, State};
  use axum::http::StatusCode as Status;
  use axum::response::{IntoResponse, Json, Response};
  use axum::routing::{get, post};
  use serde_json::json;

  use super::*;

  const MAC: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

  /// What the stand-in console answers once a pairing is approved, and how its polls go.
  #[derive(Clone)]
  struct StandIn {
    approved: serde_json::Value,
    approve_url: String,
    /// The answers to the polls in order; the last one repeats.
    polls: Arc<Vec<Status>>,
    polled: Arc<AtomicUsize>,
  }

  impl StandIn {
    fn approving(polls: &[Status]) -> Self {
      Self {
        approved: json!({ "node": "u7", "credential": format!("u7.{MAC}"), "hubUrl": "wss://hub.example" }),
        approve_url: "desktop/pair?code=K3-9Q".into(),
        polls: Arc::new(polls.to_vec()),
        polled: Arc::new(AtomicUsize::new(0)),
      }
    }

    /// A console under the path `/bmo/`, as the deployment's console stands, answering on the loopback.
    async fn serve(self) -> Console {
      let routes = Router::new()
        .route("/bmo/api/desktop/pairings", post(open))
        .route("/bmo/api/desktop/pairings/{pairing}", get(poll))
        .with_state(self);
      let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
      let address = listener.local_addr().unwrap();
      tokio::spawn(async move { axum::serve(listener, routes).await });
      let base = crate::settings::console_url(&format!("http://{address}/bmo/")).unwrap();
      Console::with_poll_floor(base, Duration::ZERO)
    }
  }

  async fn open(State(stand_in): State<StandIn>) -> Json<serde_json::Value> {
    Json(json!({
      "pairing": "p-1",
      "code": "K3-9Q",
      "approveUrl": stand_in.approve_url,
      "pollAfterSeconds": 0,
    }))
  }

  async fn poll(State(stand_in): State<StandIn>, Path(pairing): Path<String>) -> Response {
    assert_eq!(pairing, "p-1");
    let turn = stand_in.polled.fetch_add(1, Ordering::SeqCst).min(stand_in.polls.len() - 1);
    match stand_in.polls[turn] {
      Status::OK => Json(stand_in.approved.clone()).into_response(),
      status => status.into_response(),
    }
  }

  #[tokio::test]
  async fn an_approved_pairing_yields_the_machine_after_the_waiting_polls() {
    let stand_in = StandIn::approving(&[Status::ACCEPTED, Status::ACCEPTED, Status::OK]);
    let polled = stand_in.polled.clone();
    let console = stand_in.serve().await;
    let mut shown = None;

    let machine = console
      .pair(|pairing| shown = Some((pairing.code.clone(), pairing.approve_url.clone())))
      .await
      .unwrap();

    assert_eq!(machine.node, "u7");
    assert_eq!(machine.credential, format!("u7.{MAC}"));
    assert_eq!(machine.hub_url, "wss://hub.example");
    assert_eq!(polled.load(Ordering::SeqCst), 3);
    let (code, approve_url) = shown.unwrap();
    assert_eq!(code, "K3-9Q");
    assert_eq!(approve_url.path(), "/bmo/desktop/pair");
    assert_eq!(approve_url.query(), Some("code=K3-9Q"));
  }

  #[tokio::test]
  async fn an_expired_refused_or_already_read_pairing_yields_nothing() {
    for status in [Status::GONE, Status::NOT_FOUND] {
      let console = StandIn::approving(&[Status::ACCEPTED, status]).serve().await;
      assert_eq!(console.pair(|_| {}).await.err(), Some(PairingError::Gone));
    }
  }

  #[tokio::test]
  async fn a_credential_for_another_machine_is_refused() {
    let mut stand_in = StandIn::approving(&[Status::OK]);
    stand_in.approved["credential"] = json!(format!("u8.{MAC}"));
    let console = stand_in.serve().await;
    assert!(matches!(console.pair(|_| {}).await, Err(PairingError::Invalid(_))));
  }

  #[tokio::test]
  async fn an_approval_page_off_the_consoles_origin_is_refused_before_it_is_shown() {
    let mut stand_in = StandIn::approving(&[Status::OK]);
    stand_in.approve_url = "https://elsewhere.example/desktop/pair?code=K3-9Q".into();
    let console = stand_in.serve().await;
    let mut shown = false;
    assert!(matches!(console.pair(|_| shown = true).await, Err(PairingError::Invalid(_))));
    assert!(!shown);
  }

  #[test]
  fn a_hub_address_that_is_not_a_websocket_is_refused() {
    let machine = Machine {
      node: "u7".into(),
      credential: format!("u7.{MAC}"),
      hub_url: "https://hub.example".into(),
    };
    assert!(matches!(machine.checked(), Err(PairingError::Invalid(_))));
  }
}
