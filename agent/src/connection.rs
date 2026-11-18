// The agent's tunnel: dialing the hub, serving one connection's frames, and redialing without end.

use std::collections::HashMap;
use std::time::Duration;

use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt as _, StreamExt as _};
use jake_protocol::{Frame, SUPERSEDED_REASON, decode_frame};
use serde_json::{Number, json};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::JoinHandle;
use tokio::time::{Instant, interval_at, sleep, timeout};
use tokio_tungstenite::tungstenite::client::IntoClientRequest as _;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::http::header::AUTHORIZATION;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

use crate::config::AgentConfig;
use crate::exec::{self, ExecRequest, Limits, RunHandle};
use crate::log::Log;
use crate::platform::Platform;
use crate::stream::{Accepted, Streams};
use crate::transfer::Transfers;

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// How many heartbeat windows of silence from the hub mark a connection dead.
const MISSED_HEARTBEAT_LIMIT: u32 = 3;
/// How long a dial may take before it counts as failed.
const DIAL_TIMEOUT: Duration = Duration::from_secs(30);
/// How many frames may wait for the socket; a producer past it waits, so memory stays bounded.
const OUTBOUND_FRAMES: usize = 16;
/// How long a closing socket may take to carry its close frame.
const CLOSE_GRACE: Duration = Duration::from_secs(1);
// The attempt counter stops growing here; the delay reached the cap long before.
const MAX_ATTEMPT: u32 = 30;

/// Who this agent is and what it serves with.
#[derive(Clone)]
pub struct Agent {
  pub config: AgentConfig,
  pub version: String,
  pub log: Log,
  when_superseded: WhenSuperseded,
  link: watch::Sender<Link>,
}

/// Where the agent's link to the hub stands, as a caller watching it reads it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Link {
  /// Dialing the hub, or about to dial it again after a connection ended.
  Connecting,
  /// Welcomed by the hub.
  Attached,
  /// The hub turned the credential or the name away, for the reason given.
  Refused(String),
  /// The hub could not be reached, for the reason given.
  Unreachable(String),
}

/// What the agent does once the hub hands its name to a newer connection.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WhenSuperseded {
  /// Dial again, as an installed agent does after a half-dead connection was replaced.
  Redial,
  /// Stop, leaving the name to the connection that took it.
  GiveUp,
}

/// Why the agent stopped serving the hub.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ended {
  /// The caller asked it to stop.
  Stopped,
  /// The hub sent a leave.
  Left,
  /// The hub handed its name to a newer connection, and it was told to give the name up.
  Superseded,
}

/// How the hub learned of a leave the uninstaller announced.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LeaveNotice {
  /// The hub welcomed the hello and was sent the leave.
  Sent,
  /// The hub answered the hello with a leave of its own: the name is revoked, and the hub has
  /// recorded the departure already.
  AlreadyRecorded,
}

enum DialError {
  /// The hub answered the upgrade and turned the credential away with this status.
  Refused(u16),
  Failed(String),
}

impl Agent {
  /// An agent that redials when superseded, its link starting as connecting.
  pub fn new(config: AgentConfig, version: String, log: Log) -> Self {
    Self {
      config,
      version,
      log,
      when_superseded: WhenSuperseded::Redial,
      link: watch::Sender::new(Link::Connecting),
    }
  }

  /// The same agent, doing this once the hub hands its name to a newer connection.
  pub fn when_superseded(self, when: WhenSuperseded) -> Self {
    Self {
      when_superseded: when,
      ..self
    }
  }

  /// A watch on the agent's link, current from the moment it is taken.
  pub fn link(&self) -> watch::Receiver<Link> {
    self.link.subscribe()
  }

  fn capabilities(&self) -> Vec<String> {
    let shells = Platform::HOST.shells().iter().map(|shell| format!("exec:{shell}"));
    let ports = self.config.stream_ports.iter().map(|port| format!("stream:{port}"));
    let listens = self.config.listen_ports.iter().map(|port| format!("listen:{port}"));
    shells.chain(["transfer".to_owned()]).chain(ports).chain(listens).collect()
  }

  fn hello(&self) -> Frame {
    Frame::Hello {
      agent: self.config.agent_name.clone(),
      agent_version: self.version.clone(),
      capabilities: self.capabilities(),
    }
  }

  async fn dial(&self) -> Result<Socket, DialError> {
    let mut request = self
      .config
      .hub_url
      .as_str()
      .into_client_request()
      .map_err(|error| DialError::Failed(error.to_string()))?;
    let credential = HeaderValue::from_str(&format!("Bearer {}", self.config.secret))
      .map_err(|_| DialError::Failed("the shared secret cannot be sent as a header".into()))?;
    request.headers_mut().insert(AUTHORIZATION, credential);
    // A frame carries at most one payload at the cap, grown by a third in base64, plus its envelope.
    let frame_limit = self.config.max_payload_bytes / 3 * 4 + 1024 * 1024;
    let settings = WebSocketConfig::default()
      .max_message_size(Some(frame_limit))
      .max_frame_size(Some(frame_limit));
    let dialing = tokio_tungstenite::connect_async_with_config(request, Some(settings), true);
    match timeout(DIAL_TIMEOUT, dialing).await {
      Ok(Ok((socket, _))) => Ok(socket),
      Ok(Err(WsError::Http(response))) if response.status() == 401 => Err(DialError::Refused(401)),
      Ok(Err(error)) => Err(DialError::Failed(error.to_string())),
      Err(_) => Err(DialError::Failed(format!("no answer within {DIAL_TIMEOUT:?}"))),
    }
  }

  /// Dial and redial for ever, one connection at a time; it returns only when the hub sends a leave,
  /// or supersedes an agent told to give its name up.
  pub(crate) async fn run(&self) -> Ended {
    let stable = self.config.heartbeat * 2;
    let mut attempt: u32 = 0;
    loop {
      match self.dial().await {
        Ok(socket) => {
          let started = Instant::now();
          let session = Session::new(self, socket).run().await;
          if session.leave {
            return Ended::Left;
          }
          if session.superseded && self.when_superseded == WhenSuperseded::GiveUp {
            self.log.warn("name-given-up", json!({ "agent": self.config.agent_name }));
            return Ended::Superseded;
          }
          if session.welcomed && started.elapsed() >= stable {
            attempt = 0;
          }
        }
        Err(DialError::Refused(status)) => {
          let reason = "the hub refused the shared secret";
          self.log.warn("rejected", json!({ "status": status, "reason": reason }));
          self.link.send_replace(Link::Refused(format!("{reason} (HTTP {status})")));
        }
        Err(DialError::Failed(error)) => {
          self.log.warn("dial-failed", json!({ "error": error }));
          self.link.send_replace(Link::Unreachable(error));
        }
      }
      let delay = self.backoff(attempt);
      attempt = (attempt + 1).min(MAX_ATTEMPT);
      self
        .log
        .info("redial-scheduled", json!({ "attempt": attempt, "delayMs": delay.as_millis() as u64 }));
      sleep(delay).await;
    }
  }

  fn backoff(&self, attempt: u32) -> Duration {
    backoff(self.config.redial_base, self.config.redial_cap, attempt, rand::random::<f64>())
  }

  /// Tell the hub this agent is uninstalled, so it is forgotten rather than counted as disconnected.
  pub async fn announce_leave(&self) -> Result<LeaveNotice, String> {
    let socket = self.dial().await.map_err(|error| match error {
      DialError::Refused(status) => format!("the hub refused the shared secret (HTTP {status})"),
      DialError::Failed(error) => format!("the hub could not be reached: {error}"),
    })?;
    let (mut sink, mut stream) = socket.split();
    let send = async |sink: &mut SplitSink<Socket, Message>, frame: Frame| {
      sink.send(Message::Text(frame.encode().into())).await.map_err(|error| error.to_string())
    };
    send(&mut sink, self.hello()).await?;
    let answer = timeout(DIAL_TIMEOUT, async {
      while let Some(Ok(message)) = stream.next().await {
        if let Message::Text(text) = message {
          match decode_frame(text.as_str(), self.config.max_payload_bytes) {
            Ok(Frame::Welcome { .. }) => return Ok(LeaveNotice::Sent),
            Ok(Frame::Leave) => return Ok(LeaveNotice::AlreadyRecorded),
            Ok(Frame::Reject { reason }) => return Err(format!("the hub refused the agent: {reason}")),
            _ => {}
          }
        }
      }
      Err("the hub closed the connection before welcoming it".to_owned())
    });
    let notice = answer.await.map_err(|_| "the hub did not answer the hello".to_owned())??;
    if notice == LeaveNotice::Sent {
      send(&mut sink, Frame::Leave).await?;
    }
    let _ = timeout(CLOSE_GRACE, sink.close()).await;
    let event = match notice {
      LeaveNotice::Sent => "leave-announced",
      LeaveNotice::AlreadyRecorded => "leave-already-recorded",
    };
    self.log.warn(event, json!({ "agent": self.config.agent_name }));
    Ok(notice)
  }
}

// The one task that writes to the socket, so no handler ever waits on the writer it would block.
fn writer(
  mut sink: SplitSink<Socket, Message>,
  mut frames: mpsc::Receiver<Frame>,
  close: oneshot::Receiver<()>,
) -> JoinHandle<()> {
  tokio::spawn(async move {
    tokio::pin!(close);
    loop {
      tokio::select! {
        frame = frames.recv() => {
          let Some(frame) = frame else { break };
          if sink.send(Message::Text(frame.encode().into())).await.is_err() {
            return;
          }
        }
        _ = &mut close => break,
      }
    }
    let _ = timeout(CLOSE_GRACE, sink.close()).await;
  })
}

struct Outcome {
  welcomed: bool,
  leave: bool,
  superseded: bool,
}

struct Session<'a> {
  agent: &'a Agent,
  stream: SplitStream<Socket>,
  out: mpsc::Sender<Frame>,
  writer: JoinHandle<()>,
  close: Option<oneshot::Sender<()>>,
  runs: HashMap<String, RunHandle>,
  transfers: Transfers,
  streams: Streams,
  // The connections accepted on the ports the hub asked the agent to listen on, each a stream back.
  accepted: mpsc::UnboundedReceiver<Accepted>,
  welcomed: bool,
  leave: bool,
  superseded: bool,
  last_inbound: Instant,
}

impl<'a> Session<'a> {
  fn new(agent: &'a Agent, socket: Socket) -> Self {
    let (sink, stream) = socket.split();
    let (out, frames) = mpsc::channel(OUTBOUND_FRAMES);
    let (close, closed) = oneshot::channel();
    let (accepts, accepted) = mpsc::unbounded_channel();
    Self {
      agent,
      stream,
      writer: writer(sink, frames, closed),
      close: Some(close),
      transfers: Transfers::new(out.clone(), agent.config.max_payload_bytes, agent.log.clone()),
      streams: Streams::new(
        out.clone(),
        agent.config.stream_ports.clone(),
        agent.config.listen_ports.clone(),
        accepts,
        agent.config.max_payload_bytes,
        agent.log.clone(),
      ),
      accepted,
      out,
      runs: HashMap::new(),
      welcomed: false,
      leave: false,
      superseded: false,
      last_inbound: Instant::now(),
    }
  }

  async fn send(&self, frame: Frame) {
    let _ = self.out.send(frame).await;
  }

  async fn run(mut self) -> Outcome {
    let log = self.agent.log.clone();
    log.info(
      "connecting",
      json!({ "agent": self.agent.config.agent_name, "capabilities": self.agent.capabilities() }),
    );
    self.send(self.agent.hello()).await;
    let beat = self.agent.config.heartbeat;
    let mut heartbeat = interval_at(Instant::now() + beat, beat);
    let reason = loop {
      tokio::select! {
        message = self.stream.next() => match message {
          None => break "socket closed".to_owned(),
          Some(Err(error)) => break format!("socket error: {error}"),
          Some(Ok(Message::Close(frame))) => {
            self.superseded = frame.as_ref().is_some_and(|frame| frame.reason == SUPERSEDED_REASON);
            break match frame {
              Some(frame) => format!("socket closed (code {}: {})", u16::from(frame.code), frame.reason),
              None => "socket closed".to_owned(),
            };
          }
          Some(Ok(Message::Text(text))) => {
            if let Some(reason) = self.receive(text.as_str()).await {
              break reason;
            }
          }
          Some(Ok(_)) => {}
        },
        _ = heartbeat.tick() => {
          if self.last_inbound.elapsed() > beat * MISSED_HEARTBEAT_LIMIT {
            break "no traffic from the hub within the liveness window".to_owned();
          }
          self.send(Frame::Ping { ts: Number::from(epoch_ms()) }).await;
        }
        Some(accepted) = self.accepted.recv() => self.streams.adopt(accepted).await,
        _ = &mut self.writer => break "a send failed: the socket is gone".to_owned(),
      }
    };
    self.end().await;
    log.info("connection-ended", json!({ "reason": reason, "welcomed": self.welcomed }));
    // A link that was up is down now, and the agent dials again; a refusal stands until it does.
    if self.welcomed {
      self.agent.link.send_replace(Link::Connecting);
    }
    Outcome {
      welcomed: self.welcomed,
      leave: self.leave,
      superseded: self.superseded,
    }
  }

  // Nothing in flight outlives the socket it streamed over: every run's tree is ended, every
  // transfer dropped and every stream's connection closed, and output a run produces afterwards
  // goes nowhere.
  async fn end(&mut self) {
    for (_, run) in self.runs.drain() {
      run.end_now();
    }
    self.transfers.abandon().await;
    self.streams.abandon();
    if let Some(close) = self.close.take() {
      let _ = close.send(());
    }
    if !self.writer.is_finished() {
      let _ = timeout(CLOSE_GRACE * 2, &mut self.writer).await;
    }
    self.writer.abort();
  }

  /// Act on one received text; the reason the connection ends, when it does.
  async fn receive(&mut self, text: &str) -> Option<String> {
    let log = &self.agent.log;
    let frame = match decode_frame(text, self.agent.config.max_payload_bytes) {
      Ok(frame) => frame,
      Err(error) => {
        log.warn("frame-rejected", json!({ "code": error.code, "message": error.message }));
        return None;
      }
    };
    // Any well-formed frame proves the hub alive, which is what lets silence alone end a connection.
    self.last_inbound = Instant::now();
    match frame {
      Frame::Welcome { hub_version } => {
        self.welcomed = true;
        log.info("welcomed", json!({ "hubVersion": hub_version }));
        self.agent.link.send_replace(Link::Attached);
      }
      Frame::Reject { reason } => {
        log.warn("rejected", json!({ "reason": reason }));
        self.agent.link.send_replace(Link::Refused(reason.clone()));
        return Some(format!("hub rejected the connection: {reason}"));
      }
      Frame::Ping { ts } => self.send(Frame::Pong { ts }).await,
      exec @ Frame::Exec { .. } => {
        if let Some(request) = ExecRequest::from_frame(exec) {
          self.exec(request).await;
        }
      }
      // A cancel for a run that already ended reaches nothing.
      Frame::Cancel { id } => {
        if let Some(run) = self.runs.remove(&id) {
          run.cancel();
        }
      }
      Frame::Leave => {
        log.warn("leave-received", json!({}));
        self.leave = true;
        return Some("the hub asked this agent to leave".to_owned());
      }
      // The agent asks nothing of the hub, so an error names a transfer the hub has given up.
      Frame::Error { id, code, message } => {
        log.warn("hub-error", json!({ "id": id, "code": code, "message": message }));
        self.transfers.discard(&id).await;
      }
      Frame::TransferBegin {
        id,
        direction,
        path,
        ..
      } => self.transfers.begin(id, direction, path).await,
      Frame::TransferChunk { id, seq, chunk } => self.transfers.chunk(&id, seq, &chunk).await,
      Frame::TransferEnd {
        id,
        total,
        checksum,
      } => self.transfers.end(&id, total, &checksum).await,
      Frame::StreamOpen { id, port } => self.streams.open(id, port).await,
      Frame::StreamData { id, seq, chunk } => self.streams.data(&id, seq, &chunk).await,
      Frame::StreamAck { id, bytes } => self.streams.ack(&id, bytes),
      Frame::StreamClose { id, .. } => self.streams.close(&id),
      Frame::Listen { id, port } => self.streams.listen(id, port).await,
      Frame::Unlisten { id } => self.streams.unlisten(&id).await,
      // The agent's own kinds, arriving from the hub, are not the agent's to act on.
      Frame::Hello { .. }
      | Frame::Stdout { .. }
      | Frame::Stderr { .. }
      | Frame::Exit { .. }
      | Frame::StreamOpened { .. }
      | Frame::Listening { .. }
      | Frame::StreamAccept { .. }
      | Frame::Pong { .. } => {}
    }
    None
  }

  async fn exec(&mut self, request: ExecRequest) {
    let id = request.id.clone();
    let limits = Limits {
      max_output_bytes: self.agent.config.exec_max_output_bytes,
      timeout: self.agent.config.exec_timeout,
    };
    match exec::start(request, limits, self.out.clone(), self.agent.log.clone()) {
      Ok(run) => {
        self.runs.retain(|_, run| !run.finished());
        self.runs.insert(id, run);
      }
      Err(message) => {
        self
          .send(Frame::Error {
            id,
            code: "spawn-failed".into(),
            message,
          })
          .await
      }
    }
  }
}

// A session dropped mid-flight — the agent told to stop — still ends every tree it started.
impl Drop for Session<'_> {
  fn drop(&mut self) {
    for (_, run) in self.runs.drain() {
      run.end_now();
    }
  }
}

/// Full jitter over an exponential window clamped to the cap, so retries neither fall into lockstep
/// nor drift toward hours apart; `draw` is the jitter, from zero up to one.
pub fn backoff(base: Duration, cap: Duration, attempt: u32, draw: f64) -> Duration {
  base.saturating_mul(2u32.saturating_pow(attempt)).min(cap).mul_f64(draw)
}

fn epoch_ms() -> u64 {
  std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map_or(0, |since| since.as_millis() as u64)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn the_redial_window_doubles_per_attempt_and_settles_at_the_cap() {
    let (base, cap) = (Duration::from_secs(1), Duration::from_secs(60));
    assert_eq!(backoff(base, cap, 0, 1.0), Duration::from_secs(1));
    assert_eq!(backoff(base, cap, 3, 1.0), Duration::from_secs(8));
    assert_eq!(backoff(base, cap, 30, 1.0), cap);
    assert_eq!(backoff(base, cap, 30, 0.5), Duration::from_secs(30));
    assert_eq!(backoff(base, cap, 2, 0.0), Duration::ZERO);
  }
}
