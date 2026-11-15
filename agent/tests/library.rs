// The agent's library entry against a stand-in hub, on a runtime of many threads as the desktop app runs it.

use std::time::Duration;

use futures_util::{SinkExt as _, StreamExt as _};
use jake_agent::{Agent, AgentConfig, Ended, Link, Log, WhenSuperseded};
use jake_protocol::{Frame, SUPERSEDED_REASON, decode_frame};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{oneshot, watch};
use tokio::time::timeout;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

/// The bound on any one wait; every wait ends on an event long before it.
const BOUND: Duration = Duration::from_secs(10);
const CREDENTIAL: &str = "box.0123abcd";

struct StandInHub {
  listener: TcpListener,
}

impl StandInHub {
  async fn start() -> Self {
    Self {
      listener: TcpListener::bind("127.0.0.1:0").await.unwrap(),
    }
  }

  fn url(&self) -> String {
    format!("ws://{}", self.listener.local_addr().unwrap())
  }

  /// The next agent's socket, with the credential its upgrade presented.
  // The upgrade's callback answers in tungstenite's own error type, whose size is not the test's.
  #[allow(clippy::result_large_err)]
  async fn accept(&self) -> (WebSocketStream<TcpStream>, String) {
    let (tcp, _) = timeout(BOUND, self.listener.accept()).await.expect("the agent dials").unwrap();
    let (presented, read) = oneshot::channel();
    let socket = tokio_tungstenite::accept_hdr_async(tcp, |request: &Request, response: Response| {
      let header = request.headers().get("authorization").map(|value| value.to_str().unwrap().to_owned());
      let _ = presented.send(header.unwrap_or_default());
      Ok(response)
    })
    .await
    .unwrap();
    (socket, read.await.unwrap())
  }

  /// Whether an agent is dialing now; a connection made before the question is already queued.
  async fn dialed_again(&self) -> bool {
    timeout(Duration::ZERO, self.listener.accept()).await.is_ok()
  }
}

async fn hello(socket: &mut WebSocketStream<TcpStream>) -> Frame {
  loop {
    match timeout(BOUND, socket.next()).await.expect("the agent says hello").unwrap().unwrap() {
      Message::Text(text) => return decode_frame(text.as_str(), 1 << 20).unwrap(),
      _ => continue,
    }
  }
}

async fn welcome(socket: &mut WebSocketStream<TcpStream>) {
  let frame = Frame::Welcome {
    hub_version: "stand-in".into(),
  };
  socket.send(Message::Text(frame.encode().into())).await.unwrap();
}

async fn supersede(socket: &mut WebSocketStream<TcpStream>) {
  let close = CloseFrame {
    code: CloseCode::from(4000),
    reason: SUPERSEDED_REASON.into(),
  };
  socket.close(Some(close)).await.unwrap();
}

async fn link_becomes(link: &mut watch::Receiver<Link>, wanted: Link) {
  timeout(BOUND, link.wait_for(|link| *link == wanted))
    .await
    .expect("the link changes")
    .unwrap();
}

fn agent(hub: &StandInHub, test: &str) -> Agent {
  let mut config = AgentConfig::new(hub.url(), CREDENTIAL.into(), "box".into());
  config.redial_base = Duration::from_millis(1);
  config.redial_cap = Duration::from_millis(1);
  let log =
    Log::open(std::path::Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("jake-library-{test}.log")));
  Agent::new(config, "0.0.0-test".into(), log)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_entry_attaches_under_its_credential_and_stops_when_asked() {
  let hub = StandInHub::start().await;
  let agent = agent(&hub, "stop");
  let mut link = agent.link();
  let (stop, stopped) = oneshot::channel::<()>();
  let running = tokio::spawn(async move {
    jake_agent::run(&agent, async {
      let _ = stopped.await;
    })
    .await
  });

  let (mut socket, presented) = hub.accept().await;
  assert_eq!(presented, format!("Bearer {CREDENTIAL}"));
  assert!(matches!(hello(&mut socket).await, Frame::Hello { agent, .. } if agent == "box"));
  welcome(&mut socket).await;
  link_becomes(&mut link, Link::Attached).await;

  stop.send(()).unwrap();
  assert_eq!(timeout(BOUND, running).await.unwrap().unwrap(), Ended::Stopped);
  let closed = timeout(BOUND, async {
    while let Some(Ok(message)) = socket.next().await {
      if message.is_close() {
        break;
      }
    }
  });
  closed.await.expect("the socket closes once the agent stops");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_agent_told_to_give_its_name_up_stops_once_superseded() {
  let hub = StandInHub::start().await;
  let agent = agent(&hub, "give-up").when_superseded(WhenSuperseded::GiveUp);
  let running = tokio::spawn(async move { jake_agent::run(&agent, std::future::pending()).await });

  let (mut socket, _) = hub.accept().await;
  hello(&mut socket).await;
  welcome(&mut socket).await;
  supersede(&mut socket).await;

  assert_eq!(timeout(BOUND, running).await.unwrap().unwrap(), Ended::Superseded);
  assert!(!hub.dialed_again().await, "an agent that gave its name up dials no more");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_installed_agent_redials_once_superseded() {
  let hub = StandInHub::start().await;
  let agent = agent(&hub, "redial");
  let mut link = agent.link();
  let running = tokio::spawn(async move { jake_agent::run(&agent, std::future::pending()).await });

  let (mut first, _) = hub.accept().await;
  hello(&mut first).await;
  welcome(&mut first).await;
  link_becomes(&mut link, Link::Attached).await;
  supersede(&mut first).await;

  let (mut second, _) = hub.accept().await;
  assert!(matches!(hello(&mut second).await, Frame::Hello { .. }));
  running.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_hub_that_refuses_the_credential_reads_as_refused() {
  let hub = StandInHub::start().await;
  let agent = agent(&hub, "refused");
  let mut link = agent.link();
  let running = tokio::spawn(async move { jake_agent::run(&agent, std::future::pending()).await });

  let (mut socket, _) = hub.accept().await;
  hello(&mut socket).await;
  let reject = Frame::Reject {
    reason: "unknown agent".into(),
  };
  socket.send(Message::Text(reject.encode().into())).await.unwrap();
  link_becomes(&mut link, Link::Refused("unknown agent".into())).await;
  running.abort();
}
