// The hub's core: every attached agent, the commands and transfers on each, and the traffic log.

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use bytes::{Bytes, BytesMut};
use futures_util::{Stream, StreamExt};
use indexmap::IndexMap;
use serde::Serialize;
use serde_json::{Map, Value, json};
use tokio::sync::{broadcast, mpsc};
use tokio::task::JoinHandle;
use tokio::time::{Instant, interval_at};

use crate::credential::{self, Reach};
use crate::link::{Link, SendOutcome};
use crate::protocol::{
  Checksum, Direction, EncodedBytes, Frame, ReceiveWindow, STREAM_CHUNK_BYTES, SUPERSEDED_REASON,
  SendWindow, TRANSFER_CHUNK_BYTES, decode_bytes, decode_frame,
};
use crate::timed_names::TimedNames;
use crate::update::{self, AgentBuild};

/// The version the hub names in its welcome.
const HUB_VERSION: &str = "0.1.0";
/// How many recent traffic entries are kept for a late console to replay.
const RING_SIZE: usize = 200;
/// How many live traffic entries a slow tail may fall behind before it skips ahead.
const TAIL_BACKLOG: usize = 1024;
/// The close code of a socket the hub drops on purpose, from the range kept for applications.
const CLOSE_HUB_INITIATED: u16 = 4000;
/// The close code of a socket whose hello named another name than its credential was made for.
const CLOSE_OTHER_NAME: u16 = 4003;
/// The reason a revoked name's departure is logged and its socket closed with.
const REVOKED_REASON: &str = "its name is revoked";
/// How much of an update order's output the hub's log keeps.
const UPDATE_REPORT_BYTES: usize = 4096;

pub struct HubOptions {
  pub secret: String,
  /// The key a credential of one agent name is made with; none admits the shared secret alone.
  pub agent_key: Option<String>,
  pub control_token: String,
  /// The key a control credential scoped to named agents is made with; none admits the control token alone.
  pub control_key: Option<String>,
  pub max_payload_bytes: usize,
  pub ping_interval: Duration,
  pub missed_pong_limit: u32,
  pub socket_backlog_bytes: usize,
  /// Where the departed agents are recorded; none keeps the record in memory alone.
  pub departed_path: Option<PathBuf>,
  /// Where the revoked agent names are recorded; none keeps the record in memory alone.
  pub revoked_path: Option<PathBuf>,
  /// The `host:port` targets a stream back from an agent may reach.
  pub reverse_targets: Vec<String>,
  /// The agent build attached agents are ordered onto; none orders no agent.
  pub agent_build: Option<AgentBuild>,
}

/// One event in a command's or a transfer's life, as its control caller receives it.
#[derive(Debug)]
pub struct Event {
  pub kind: &'static str,
  pub data: Value,
}

/// The events a control caller reads; the stream ends once its command or transfer has ended.
pub type Events = mpsc::UnboundedReceiver<Event>;

// The sending end of a caller's events. Dropping it ends the caller's stream; a caller that has
// gone away makes a push a no-op.
struct Listener(mpsc::UnboundedSender<Event>);

impl Listener {
  fn open() -> (Self, Events) {
    let (tx, rx) = mpsc::unbounded_channel();
    (Self(tx), rx)
  }

  fn push(&self, kind: &'static str, data: Value) {
    let _ = self.0.send(Event { kind, data });
  }
}

/// Why a request could not be given an agent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TargetRefusal {
  /// No agent is attached at all.
  NoAgent,
  /// The agent the request named is not attached.
  UnknownAgent,
  /// The request named none while several are attached.
  AgentRequired,
  /// The request named an agent its caller's credential does not reach.
  OutOfReach,
}

impl TargetRefusal {
  pub fn code(self) -> &'static str {
    match self {
      Self::NoAgent => "no-agent",
      Self::UnknownAgent => "unknown-agent",
      Self::AgentRequired => "agent-required",
      Self::OutOfReach => "agent-out-of-reach",
    }
  }

  /// The HTTP status the refusal answers with: a conflict with the hub's state, a name not found,
  /// a choice the caller must make, or a name the caller may not reach.
  pub fn status(self) -> u16 {
    match self {
      Self::NoAgent => 409,
      Self::UnknownAgent => 404,
      Self::AgentRequired => 400,
      Self::OutOfReach => 403,
    }
  }
}

#[derive(Debug)]
pub struct Refusal {
  pub kind: TargetRefusal,
  pub reason: String,
}

impl Refusal {
  /// A request naming an agent its caller's credential does not reach, refused alike whether or not
  /// that agent is attached.
  pub fn out_of_reach(name: &str) -> Self {
    Self {
      kind: TargetRefusal::OutOfReach,
      reason: format!("this credential does not reach agent {name}"),
    }
  }
}

/// A shell command a control caller starts.
pub struct ExecParams {
  pub shell: String,
  pub command: String,
  pub cwd: Option<String>,
  pub env: Map<String, Value>,
  pub distro: Option<String>,
}

/// An upload a control caller starts: where to write it, what it is declared to be, and its body,
/// read only as fast as the agent's socket takes it.
pub struct UploadParams<B> {
  pub path: String,
  pub total: u64,
  pub checksum: String,
  pub body: B,
}

/// What a stream's caller receives from the agent's side of it.
#[derive(Debug)]
pub enum StreamEvent {
  /// The agent has connected to the port; bytes may flow both ways.
  Opened,
  /// Bytes the port sent.
  Data(Vec<u8>),
  /// The agent closed the stream, its port having closed the connection or failed, and why.
  Closed(String),
  /// The stream could not be opened, or was cut off — the agent's connection lost, or a piece that
  /// broke the window — and why.
  Failed(String),
}

/// One frame that crossed the tunnel, reduced to its shape.
#[derive(Debug, Serialize)]
pub struct TrafficEntry {
  pub id: u64,
  pub at: i64,
  pub agent: Option<String>,
  pub dir: &'static str,
  #[serde(rename = "type")]
  pub kind: &'static str,
  pub summary: Value,
}

// One attached agent and everything that lives and dies with its connection.
struct Agent {
  link: Link,
  agent_version: String,
  capabilities: Vec<String>,
  connected_at: i64,
  last_pong_at: i64,
  probe: Option<JoinHandle<()>>,
  commands: IndexMap<String, Listener>,
  transfers: HashMap<String, Transfer>,
  streams: IndexMap<String, OpenStream>,
  // The ports the agent says it listens on now for streams back.
  listening: std::collections::BTreeSet<u16>,
}

impl Agent {
  // One chunk of a command's output, handed on to whoever started the command.
  fn output(&self, id: &str, stream: &'static str, seq: u64, chunk: &EncodedBytes) {
    if let Some(listener) = self.commands.get(id) {
      listener.push(stream, json!({ "seq": seq, "chunk": chunk.to_json() }));
    }
  }
}

// A transfer in flight. On a download the hub is the receiver and keeps a running count and hash
// to check against the agent's declared total and checksum.
struct Transfer {
  direction: Direction,
  listener: Listener,
  expected_seq: u64,
  received: u64,
  hash: Option<Checksum>,
}

// A byte stream in flight: its caller, the credit the hub holds toward the agent, and the account of
// what the agent has sent.
struct OpenStream {
  caller: mpsc::UnboundedSender<StreamEvent>,
  window: Arc<SendWindow>,
  inbound: ReceiveWindow,
}

impl OpenStream {
  fn end(self, event: StreamEvent) {
    self.window.close();
    let _ = self.caller.send(event);
  }
}

struct State {
  agents: HashMap<String, Agent>,
  by_socket: HashMap<u64, String>,
  traffic: VecDeque<Arc<TrafficEntry>>,
  traffic_seq: u64,
  traffic_tx: broadcast::Sender<Arc<TrafficEntry>>,
  id_seq: u64,
  departed: TimedNames,
  // The names whose credentials the hub no longer takes: a hello under one is answered with a leave.
  revoked: TimedNames,
  // What each agent is to listen on for streams back, by name and port, with the target each joins:
  // asked again on every connection the agent makes.
  listens: HashMap<String, std::collections::BTreeMap<u16, String>>,
  // When each agent was last ordered onto the release's agent build.
  updates_ordered: HashMap<String, i64>,
}

pub struct Hub {
  options: HubOptions,
  run: String,
  socket_seq: AtomicU64,
  state: Mutex<State>,
}

fn now_ms() -> i64 {
  SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |since| since.as_millis() as i64)
}

// Agent names in the order a person reads them: letters alike whatever their case, and of two names
// that differ only in case, the lowercase one first.
fn by_name(a: &str, b: &str) -> std::cmp::Ordering {
  let swapped = |name: &str| -> String {
    name
      .chars()
      .map(|c| if c.is_lowercase() { c.to_ascii_uppercase() } else { c.to_ascii_lowercase() })
      .collect()
  };
  a.to_lowercase().cmp(&b.to_lowercase()).then_with(|| swapped(a).cmp(&swapped(b)))
}

// A random tag for this process, so a console can tell a restarted hub from the one its cursor counts against.
fn run_tag() -> String {
  const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
  let mut seed: u64 = rand::random();
  let tag: String = (0..8)
    .map(|_| {
      let digit = DIGITS[(seed % 36) as usize] as char;
      seed /= 36;
      digit
    })
    .collect();
  format!("hub-{tag}")
}

impl State {
  fn record(&mut self, agent: Option<&str>, dir: &'static str, kind: &'static str, summary: Value) {
    self.traffic_seq += 1;
    let entry = Arc::new(TrafficEntry {
      id: self.traffic_seq,
      at: now_ms(),
      agent: agent.map(str::to_owned),
      dir,
      kind,
      summary,
    });
    self.traffic.push_back(Arc::clone(&entry));
    if self.traffic.len() > RING_SIZE {
      self.traffic.pop_front();
    }
    let _ = self.traffic_tx.send(entry);
  }

  fn send(&mut self, name: &str, frame: &Frame) -> SendOutcome {
    let Some(agent) = self.agents.get(name) else {
      return SendOutcome::Dropped;
    };
    let outcome = agent.link.send(frame.encode());
    self.record(Some(name), "out", frame.kind(), frame.summary());
    outcome
  }

  fn next_id(&mut self, prefix: char) -> String {
    self.id_seq += 1;
    format!("{prefix}{}", self.id_seq)
  }

  fn attached_on(&self, name: &str, socket_id: u64) -> bool {
    self.agents.get(name).is_some_and(|agent| agent.link.socket_id == socket_id)
  }

  fn owns_stream(&mut self, name: &str, socket_id: u64, id: &str) -> Option<&mut OpenStream> {
    self
      .agents
      .get_mut(name)
      .filter(|agent| agent.link.socket_id == socket_id)
      .and_then(|agent| agent.streams.get_mut(id))
  }

  fn owns_transfer(&self, name: &str, socket_id: u64, id: &str) -> bool {
    self
      .agents
      .get(name)
      .is_some_and(|agent| agent.link.socket_id == socket_id && agent.transfers.contains_key(id))
  }

  fn attach(
    &mut self,
    link: &Link,
    name: String,
    agent_version: String,
    capabilities: Vec<String>,
    summary: Value,
  ) {
    self.record(Some(&name), "in", "hello", summary);
    if self.departed.forget(&name) {
      eprintln!("jake hub: agent {name} said hello again and is no longer departed");
    }

    // A socket that already holds another name gives that name up; the socket itself carries on.
    if let Some(previous) = self.by_socket.get(&link.socket_id).cloned()
      && previous != name
    {
      self.detach(&previous, "the connection said hello under another name", false);
    }

    // One connection per name: whatever held this name on another socket is displaced and closed.
    if let Some(held) = self.agents.get(&name).map(|agent| agent.link.socket_id) {
      self.detach(&name, SUPERSEDED_REASON, held != link.socket_id);
    }

    let now = now_ms();
    let agent = Agent {
      link: link.clone(),
      agent_version,
      capabilities,
      connected_at: now,
      last_pong_at: now,
      probe: None,
      commands: IndexMap::new(),
      transfers: HashMap::new(),
      streams: IndexMap::new(),
      listening: std::collections::BTreeSet::new(),
    };
    self.agents.insert(name.clone(), agent);
    self.by_socket.insert(link.socket_id, name.clone());
    self.send(
      &name,
      &Frame::Welcome {
        hub_version: HUB_VERSION.into(),
      },
    );
    let ports: Vec<u16> = self
      .listens
      .get(&name)
      .map(|wanted| wanted.keys().copied().collect())
      .unwrap_or_default();
    for port in ports {
      self.send(
        &name,
        &Frame::Listen {
          id: listen_id(port),
          port,
        },
      );
    }
  }

  fn detach(&mut self, name: &str, reason: &str, close_socket: bool) {
    let Some(mut agent) = self.agents.remove(name) else {
      return;
    };
    self.by_socket.remove(&agent.link.socket_id);
    if let Some(probe) = agent.probe.take() {
      probe.abort();
    }
    if close_socket {
      agent.link.close(CLOSE_HUB_INITIATED, reason);
    }

    // Nothing in flight outlives the socket it streamed over.
    for (_, listener) in agent.commands.drain(..) {
      listener.push("ended", json!({ "reason": reason }));
    }
    for (_, transfer) in agent.transfers.drain() {
      transfer.listener.push("ended", json!({ "reason": reason }));
    }
    for (_, stream) in agent.streams.drain(..) {
      stream.end(StreamEvent::Failed(reason.to_owned()));
    }
  }

  // An agent that has left is dropped and recorded, so it reads as gone rather than disconnected.
  fn depart(&mut self, name: &str, how: &str) {
    self.detach(name, how, true);
    self.departed.record(name, now_ms());
    eprintln!("jake hub: agent {name} departed: {how}");
  }

  // A hello under a revoked name, made with that name's credential, attaches nothing: the leave goes
  // out in the welcome's place, ahead of the socket's close, and the attempt is a departure.
  fn answer_revoked(&mut self, link: &Link, name: &str, summary: Value) {
    self.record(Some(name), "in", "hello", summary);
    // Whatever name the socket held goes with the socket rather than staying attached to a closed link.
    if let Some(held) = self.by_socket.get(&link.socket_id).cloned() {
      self.detach(&held, "the connection said hello under a revoked name", false);
    }
    link.send(Frame::Leave.encode());
    self.record(Some(name), "out", Frame::Leave.kind(), Frame::Leave.summary());
    link.close(CLOSE_HUB_INITIATED, REVOKED_REASON);
    self.departed.record(name, now_ms());
    eprintln!("jake hub: agent {name} departed: {REVOKED_REASON}");
  }

  fn fail_transfer(&mut self, name: &str, id: &str, code: &str, message: &str) {
    if let Some(transfer) = self.agents.get_mut(name).and_then(|agent| agent.transfers.remove(id)) {
      transfer.listener.push("error", json!({ "code": code, "message": message }));
    }
  }

  fn route(&mut self, name: &str, frame: Frame, max_payload_bytes: usize) {
    let Some(agent) = self.agents.get_mut(name) else {
      return;
    };
    match frame {
      Frame::Pong { .. } => agent.last_pong_at = now_ms(),
      // An agent's own leave is its uninstaller saying it has been removed by hand.
      Frame::Leave => self.depart(name, "uninstalled on the machine"),
      Frame::Ping { ts } => {
        self.send(name, &Frame::Pong { ts });
      }
      Frame::Stdout { id, seq, chunk } => agent.output(&id, "stdout", seq, &chunk),
      Frame::Stderr { id, seq, chunk } => agent.output(&id, "stderr", seq, &chunk),
      Frame::Exit {
        id,
        code,
        signal,
        canceled,
      } => {
        if let Some(listener) = agent.commands.shift_remove(&id) {
          listener.push("exit", json!({ "code": code, "signal": signal, "canceled": canceled }));
        }
      }
      Frame::Listening { id } => {
        if let Some(port) = port_of_listen(&id) {
          agent.listening.insert(port);
        }
      }
      Frame::Error { id, code, message } => {
        // An error answers a command the agent refused before it could stream, a stream it could not
        // open, a listen it could not make, or a transfer that failed.
        if let Some(port) = port_of_listen(&id) {
          agent.listening.remove(&port);
          eprintln!("jake hub: agent {name} could not listen on port {port} [{code}]: {message}");
        } else if let Some(listener) = agent.commands.shift_remove(&id) {
          listener.push("error", json!({ "code": code, "message": message }));
        } else if let Some(stream) = agent.streams.shift_remove(&id) {
          stream
            .end(StreamEvent::Failed(format!("the agent could not open the stream [{code}]: {message}")));
        } else {
          self.fail_transfer(name, &id, &code, &message);
        }
      }
      Frame::TransferBegin {
        id,
        total: Some(total),
        checksum: Some(checksum),
        ..
      } => {
        // A download's begin from the agent: the size and checksum it is about to stream.
        if let Some(transfer) =
          agent.transfers.get(&id).filter(|transfer| transfer.direction == Direction::Download)
        {
          transfer.listener.push("begin", json!({ "total": total, "checksum": checksum }));
        }
      }
      Frame::TransferChunk { id, seq, chunk } => {
        let Some(transfer) = agent
          .transfers
          .get_mut(&id)
          .filter(|transfer| transfer.direction == Direction::Download)
        else {
          return;
        };
        if seq != transfer.expected_seq {
          let message = format!("expected chunk {}, got {seq}", transfer.expected_seq);
          self.fail_transfer(name, &id, "out-of-order", &message);
          return;
        }
        let data = match decode_bytes(&chunk, max_payload_bytes) {
          Ok(data) => data,
          Err(error) => {
            self.fail_transfer(name, &id, "bad-chunk", &error.message);
            return;
          }
        };
        transfer.expected_seq += 1;
        transfer.received += data.len() as u64;
        if let Some(hash) = transfer.hash.as_mut() {
          hash.update(&data);
        }
        transfer.listener.push("chunk", json!({ "seq": seq, "chunk": chunk.to_json() }));
      }
      Frame::TransferEnd {
        id,
        total,
        checksum,
      } => {
        let Some(transfer) = agent.transfers.remove(&id) else {
          return;
        };
        // An upload's end is the agent's acknowledgement of a verified write; a download's end
        // is accepted only if what the hub assembled matches what it declares.
        let verified = match (transfer.direction, transfer.hash) {
          (Direction::Upload, _) => true,
          (Direction::Download, Some(hash)) => transfer.received == total && hash.finish() == checksum,
          (Direction::Download, None) => false,
        };
        if verified {
          transfer.listener.push("completed", json!({ "total": total, "checksum": checksum }));
        } else {
          let message =
            format!("assembled {} bytes did not match the declared transfer", transfer.received);
          transfer.listener.push("error", json!({ "code": "integrity", "message": message }));
        }
      }
      Frame::StreamOpened { id } => {
        if let Some(stream) = agent.streams.get(&id) {
          let _ = stream.caller.send(StreamEvent::Opened);
        }
      }
      Frame::StreamData { id, seq, chunk } => {
        let Some(stream) = agent.streams.get_mut(&id) else {
          return;
        };
        let accepted = decode_bytes(&chunk, max_payload_bytes)
          .map_err(|error| error.message)
          .and_then(|data| stream.inbound.accept(seq, data.len() as u64).map(|()| data));
        match accepted {
          Ok(data) => {
            let _ = stream.caller.send(StreamEvent::Data(data));
          }
          Err(reason) => {
            if let Some(stream) = agent.streams.shift_remove(&id) {
              stream.end(StreamEvent::Failed(reason.clone()));
            }
            self.send(name, &Frame::StreamClose { id, reason });
          }
        }
      }
      Frame::StreamAck { id, bytes } => {
        if let Some(stream) = agent.streams.get(&id) {
          stream.window.grant(bytes);
        }
      }
      Frame::StreamClose { id, reason } => {
        if let Some(stream) = agent.streams.shift_remove(&id) {
          stream.end(StreamEvent::Closed(reason));
        }
      }
      // A handshake or hub-outbound frame arriving from the agent is not the hub's to act on.
      _ => {}
    }
  }

  // Start a shell command on an attached agent; its life arrives on the returned events.
  fn start_exec(&mut self, name: &str, params: ExecParams) -> Events {
    let id = self.next_id('c');
    let (listener, events) = Listener::open();
    listener.push("started", json!({ "id": id }));
    if let Some(agent) = self.agents.get_mut(name) {
      agent.commands.insert(id.clone(), listener);
    }
    let ExecParams {
      shell,
      command,
      cwd,
      env,
      distro,
    } = params;
    self.send(
      name,
      &Frame::Exec {
        id,
        shell,
        command,
        cwd,
        env,
        distro,
      },
    );
    events
  }

  // Order an agent onto the agent build where it runs another, nothing a caller started is running on
  // it, and it was not ordered within the retry window; the answer is what it ran, and the order.
  fn offer_update(&mut self, name: &str, build: &AgentBuild, now: i64) -> Option<(String, Events)> {
    let agent = self.agents.get(name)?;
    if !agent.commands.is_empty() || !agent.transfers.is_empty() {
      return None;
    }
    if self.updates_ordered.get(name).is_some_and(|at| now - at < update::RETRY_AFTER_MS) {
      return None;
    }
    let order = build.order(&agent.agent_version, &agent.capabilities)?;
    let running = agent.agent_version.clone();
    self.updates_ordered.insert(name.to_owned(), now);
    Some((running, self.start_exec(name, order)))
  }

  // The agent a request goes to among those its caller reaches: a named one must be reached and
  // attached, and no name picks the only one attached.
  fn find_target(&self, name: Option<&str>, reach: &Reach) -> Result<String, Refusal> {
    if let Some(name) = name
      && !reach.admits(name)
    {
      return Err(Refusal::out_of_reach(name));
    }
    let mut reachable: Vec<&str> = self
      .agents
      .keys()
      .map(String::as_str)
      .filter(|attached| reach.admits(attached))
      .collect();
    if reachable.is_empty() {
      return Err(Refusal {
        kind: TargetRefusal::NoAgent,
        reason: "no agent attached".into(),
      });
    }
    if let Some(name) = name {
      return if self.agents.contains_key(name) {
        Ok(name.to_owned())
      } else {
        Err(Refusal {
          kind: TargetRefusal::UnknownAgent,
          reason: format!("no agent named {name} is attached"),
        })
      };
    }
    if reachable.len() > 1 {
      reachable.sort_unstable();
      let reason = format!("{} agents are attached ({}); name one", reachable.len(), reachable.join(", "));
      return Err(Refusal {
        kind: TargetRefusal::AgentRequired,
        reason,
      });
    }
    Ok(reachable[0].to_owned())
  }
}

impl Hub {
  pub fn new(options: HubOptions) -> Arc<Self> {
    let (traffic_tx, _) = broadcast::channel(TAIL_BACKLOG);
    let state = State {
      agents: HashMap::new(),
      by_socket: HashMap::new(),
      traffic: VecDeque::new(),
      traffic_seq: 0,
      traffic_tx,
      id_seq: 0,
      departed: TimedNames::load(options.departed_path.clone(), "departedAt"),
      revoked: TimedNames::load(options.revoked_path.clone(), "revokedAt"),
      listens: HashMap::new(),
      updates_ordered: HashMap::new(),
    };
    Arc::new(Self {
      options,
      run: run_tag(),
      socket_seq: AtomicU64::new(0),
      state: Mutex::new(state),
    })
  }

  fn lock(&self) -> MutexGuard<'_, State> {
    self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
  }

  pub fn run_tag(&self) -> &str {
    &self.run
  }

  pub fn max_payload_bytes(&self) -> usize {
    self.options.max_payload_bytes
  }

  pub fn socket_backlog_bytes(&self) -> usize {
    self.options.socket_backlog_bytes
  }

  /// Whom the header admits: none where it presents no credential the hub takes; any name for the shared
  /// secret; one name for a credential made for it with the agent key, `<name>.<hex mac>`.
  pub fn authorize_agent(&self, header: Option<&[u8]>) -> Option<Option<String>> {
    let presented = std::str::from_utf8(header?).ok()?.strip_prefix("Bearer ")?;
    if presented == self.options.secret {
      return Some(None);
    }
    let key = self.options.agent_key.as_deref()?;
    credential::subject(key, presented).map(|name| Some(name.to_owned()))
  }

  /// Whom a control request's header lets reach what: every agent for the control token; the named
  /// agents for a credential made for them with the control key, `<names>.<hex mac>`; none otherwise.
  pub fn authorize_control(&self, header: Option<&[u8]>) -> Option<Reach> {
    let presented = std::str::from_utf8(header?).ok()?.strip_prefix("Bearer ")?;
    if presented == self.options.control_token {
      return Some(Reach::All);
    }
    let key = self.options.control_key.as_deref()?;
    Reach::of_names(credential::subject(key, presented)?)
  }

  pub fn next_socket_id(&self) -> u64 {
    self.socket_seq.fetch_add(1, Ordering::Relaxed) + 1
  }

  // --- Agent sockets ---------------------------------------------------------------------------

  /// Feed one text frame received from an agent socket.
  pub fn on_message(self: &Arc<Self>, link: &Link, raw: &str) {
    let mut state = self.lock();
    let known = state.by_socket.get(&link.socket_id).cloned();
    let frame = match decode_frame(raw, self.options.max_payload_bytes) {
      Ok(frame) => frame,
      Err(error) => {
        state.record(
          known.as_deref(),
          "in",
          "invalid",
          json!({ "code": error.code, "message": error.message }),
        );
        return;
      }
    };

    if let Frame::Hello {
      agent,
      agent_version,
      capabilities,
    } = &frame
    {
      if let Some(only) = &link.only
        && **only != **agent
      {
        state.record(
          Some(agent),
          "in",
          "refused",
          json!({ "reason": "the credential is for another name" }),
        );
        link.close(CLOSE_OTHER_NAME, "the credential is for another name");
        return;
      }
      let summary = frame.summary();
      if link.only.is_some() && state.revoked.contains(agent) {
        state.answer_revoked(link, agent, summary);
        return;
      }
      state.attach(link, agent.clone(), agent_version.clone(), capabilities.clone(), summary);
      let probe = self.probe(agent.clone(), link.socket_id);
      if let Some(attached) = state.agents.get_mut(agent) {
        attached.probe = Some(probe);
      }
      self.update_if_behind(&mut state, agent);
      return;
    }

    // Only an attached socket may drive the hub; a frame from one that never said hello, or has
    // since been superseded, is dropped.
    let Some(name) = known else {
      return;
    };
    state.record(Some(&name), "in", frame.kind(), frame.summary());
    if let Frame::StreamAccept { id, listen } = frame {
      let target = port_of_listen(&listen).and_then(|port| state.listens.get(&name)?.get(&port).cloned());
      let Some(target) = target else {
        let reason = format!("no target stands for listen {listen}");
        state.send(&name, &Frame::StreamClose { id, reason });
        return;
      };
      let Some(agent) = state.agents.get_mut(&name) else {
        return;
      };
      let (caller, events) = mpsc::unbounded_channel();
      let window = Arc::new(SendWindow::default());
      agent.streams.insert(
        id.clone(),
        OpenStream {
          caller,
          window: Arc::clone(&window),
          inbound: ReceiveWindow::default(),
        },
      );
      let end = StreamEnd {
        hub: Arc::clone(self),
        name: name.clone(),
        socket_id: agent.link.socket_id,
        id,
        window,
      };
      drop(state);
      tokio::spawn(carry_back(end, events, target));
      return;
    }
    state.route(&name, frame, self.options.max_payload_bytes);
  }

  /// Note that an agent socket has closed; only a socket still holding its name detaches an agent.
  pub fn on_close(&self, link: &Link) {
    let mut state = self.lock();
    if let Some(name) = state.by_socket.get(&link.socket_id).cloned() {
      state.detach(&name, "agent connection closed", false);
    }
  }

  // The liveness probe of one connection: a ping each interval, and the connection declared dead
  // once a run of intervals passes without a pong.
  fn probe(self: &Arc<Self>, name: String, socket_id: u64) -> JoinHandle<()> {
    let hub = Arc::downgrade(self);
    let period = self.options.ping_interval;
    tokio::spawn(async move {
      let mut ticks = interval_at(Instant::now() + period, period);
      loop {
        ticks.tick().await;
        match hub.upgrade() {
          Some(hub) if hub.ping_tick(&name, socket_id) => {}
          _ => return,
        }
      }
    })
  }

  fn ping_tick(&self, name: &str, socket_id: u64) -> bool {
    let mut state = self.lock();
    if !state.attached_on(name, socket_id) {
      return false;
    }
    let dead_after =
      self.options.ping_interval.as_millis() as i64 * i64::from(self.options.missed_pong_limit);
    let now = now_ms();
    if state.agents.get(name).is_some_and(|agent| now - agent.last_pong_at > dead_after) {
      state.detach(name, "no pong within the liveness window", true);
      return false;
    }
    state.send(name, &Frame::Ping { ts: now.into() });
    self.update_if_behind(&mut state, name);
    true
  }

  // --- Control operations ----------------------------------------------------------------------

  /// Decide which agent a request goes to among those its caller reaches: a named one must be
  /// reached and attached, and no name picks the only one attached.
  pub fn resolve_target(&self, name: Option<&str>, reach: &Reach) -> Result<String, Refusal> {
    self.lock().find_target(name, reach)
  }

  /// Start a shell command on the target agent; its life arrives on the returned events.
  pub fn start_exec(&self, params: ExecParams, target: Option<&str>) -> Result<Events, String> {
    let mut state = self.lock();
    let name = state.find_target(target, &Reach::All).map_err(|refusal| refusal.reason)?;
    Ok(state.start_exec(&name, params))
  }

  // Order the agent onto the release's agent build where it is due, and log how the order ends.
  fn update_if_behind(&self, state: &mut State, name: &str) {
    let Some(build) = &self.options.agent_build else {
      return;
    };
    let Some((running, events)) = state.offer_update(name, build, now_ms()) else {
      return;
    };
    eprintln!("jake hub: agent {name} runs {running}; ordering it onto {}", build.version);
    tokio::spawn(report_update(name.to_owned(), events));
  }

  /// Ask the agent running a command to stop it; a command id is unique across the hub, and one on
  /// an agent the caller does not reach is unknown to it.
  pub fn cancel(&self, id: &str, reach: &Reach) -> Result<(), String> {
    let mut state = self.lock();
    if state.agents.is_empty() {
      return Err("no agent attached".into());
    }
    let Some(name) = state
      .agents
      .iter()
      .find(|(name, agent)| reach.admits(name) && agent.commands.contains_key(id))
      .map(|(name, _)| name.clone())
    else {
      return Err("unknown command".into());
    };
    state.send(&name, &Frame::Cancel { id: id.to_owned() });
    Ok(())
  }

  /// Write a file onto the machine: the declared begin, the body regrouped into fixed chunks paced
  /// to the socket, the end; it completes when the agent acknowledges the verified write.
  pub fn start_upload<B>(
    self: &Arc<Self>,
    params: UploadParams<B>,
    target: Option<&str>,
  ) -> Result<Events, String>
  where
    B: Stream<Item = Result<Bytes, String>> + Send + Unpin + 'static,
  {
    let mut state = self.lock();
    let name = state.find_target(target, &Reach::All).map_err(|refusal| refusal.reason)?;
    let id = state.next_id('u');
    let (listener, events) = Listener::open();
    listener.push("started", json!({ "id": id }));
    let Some(agent) = state.agents.get_mut(&name) else {
      return Err("no agent attached".into());
    };
    let transfer = Transfer {
      direction: Direction::Upload,
      listener,
      expected_seq: 0,
      received: 0,
      hash: None,
    };
    agent.transfers.insert(id.clone(), transfer);
    let link = agent.link.clone();
    drop(state);
    tokio::spawn(Arc::clone(self).pump_upload(name, link, id, params));
    Ok(events)
  }

  async fn pump_upload<B>(self: Arc<Self>, name: String, link: Link, id: String, params: UploadParams<B>)
  where
    B: Stream<Item = Result<Bytes, String>> + Unpin,
  {
    let UploadParams {
      path,
      total,
      checksum,
      mut body,
    } = params;
    let begin = Frame::TransferBegin {
      id: id.clone(),
      direction: Direction::Upload,
      path,
      total: Some(total),
      checksum: Some(checksum.clone()),
    };
    if !self.send_paced(&name, &link, &id, begin).await {
      return;
    }

    let mut pending = BytesMut::with_capacity(TRANSFER_CHUNK_BYTES);
    let mut seq = 0;
    let mut streamed = 0;
    loop {
      let piece = match body.next().await {
        None => break,
        Some(Ok(piece)) => piece,
        Some(Err(reason)) => {
          self.abandon_upload(
            &name,
            link.socket_id,
            &id,
            "body-broken",
            &format!("the upload's body broke off: {reason}"),
          );
          return;
        }
      };
      let mut rest = &piece[..];
      while !rest.is_empty() {
        let take = (TRANSFER_CHUNK_BYTES - pending.len()).min(rest.len());
        pending.extend_from_slice(&rest[..take]);
        rest = &rest[take..];
        if pending.len() == TRANSFER_CHUNK_BYTES
          && !self
            .send_chunk(&name, &link, &id, &mut seq, &mut streamed, total, &pending.split())
            .await
        {
          return;
        }
      }
    }
    if !pending.is_empty()
      && !self
        .send_chunk(&name, &link, &id, &mut seq, &mut streamed, total, &pending.split())
        .await
    {
      return;
    }
    if streamed != total {
      let message = format!("the upload's body ended after {streamed} of its declared {total} bytes");
      self.abandon_upload(&name, link.socket_id, &id, "size-mismatch", &message);
      return;
    }
    self
      .send_paced(
        &name,
        &link,
        &id,
        Frame::TransferEnd {
          id: id.clone(),
          total,
          checksum,
        },
      )
      .await;
  }

  #[allow(clippy::too_many_arguments)]
  async fn send_chunk(
    &self,
    name: &str,
    link: &Link,
    id: &str,
    seq: &mut u64,
    streamed: &mut u64,
    total: u64,
    data: &[u8],
  ) -> bool {
    *streamed += data.len() as u64;
    if *streamed > total {
      let message = format!("the upload's body ran past its declared {total} bytes");
      self.abandon_upload(name, link.socket_id, id, "size-mismatch", &message);
      return false;
    }
    let frame = Frame::TransferChunk {
      id: id.to_owned(),
      seq: *seq,
      chunk: EncodedBytes::of(data),
    };
    *seq += 1;
    self.send_paced(name, link, id, frame).await
  }

  // Hand the socket one frame of an upload that is still this agent's, and wait for a backlog to
  // drain before the next. False once the upload is over, for whatever reason.
  async fn send_paced(&self, name: &str, link: &Link, id: &str, frame: Frame) -> bool {
    let outcome = {
      let mut state = self.lock();
      if !state.owns_transfer(name, link.socket_id, id) {
        return false;
      }
      state.send(name, &frame)
    };
    match outcome {
      SendOutcome::Sent => true,
      SendOutcome::Queued => {
        link.drained().await;
        true
      }
      SendOutcome::Dropped => {
        let message = format!("the socket to the agent dropped the {} frame of this upload", frame.kind());
        self.abandon_upload(name, link.socket_id, id, "dropped", &message);
        false
      }
    }
  }

  // Fail an upload to its caller and tell the agent, so it drops the temporary file it was writing.
  fn abandon_upload(&self, name: &str, socket_id: u64, id: &str, code: &str, message: &str) {
    let mut state = self.lock();
    if !state.owns_transfer(name, socket_id, id) {
      return;
    }
    state.fail_transfer(name, id, code, message);
    let notice = Frame::Error {
      id: id.to_owned(),
      code: code.to_owned(),
      message: "the hub abandoned this upload".into(),
    };
    state.send(name, &notice);
  }

  /// Read a file back from the machine, verifying the assembled bytes against the agent's
  /// declared total and checksum when the transfer closes.
  pub fn start_download(&self, path: String, target: Option<&str>) -> Result<Events, String> {
    let mut state = self.lock();
    let name = state.find_target(target, &Reach::All).map_err(|refusal| refusal.reason)?;
    let id = state.next_id('d');
    let (listener, events) = Listener::open();
    listener.push("started", json!({ "id": id }));
    if let Some(agent) = state.agents.get_mut(&name) {
      let transfer = Transfer {
        direction: Direction::Download,
        listener,
        expected_seq: 0,
        received: 0,
        hash: Some(Checksum::default()),
      };
      agent.transfers.insert(id.clone(), transfer);
    }
    state.send(
      &name,
      &Frame::TransferBegin {
        id,
        direction: Direction::Download,
        path,
        total: None,
        checksum: None,
      },
    );
    Ok(events)
  }

  /// Whether the named agent's hello offered byte streams to `port`.
  pub fn offers_stream(&self, name: &str, port: u16) -> bool {
    let capability = format!("stream:{port}");
    self
      .lock()
      .agents
      .get(name)
      .is_some_and(|agent| agent.capabilities.contains(&capability))
  }

  /// Open a byte stream to `port` on the named agent's machine: the caller's end of it, and the
  /// events the agent's side sends, the first of which says whether it opened.
  pub fn open_stream(
    self: &Arc<Self>,
    name: &str,
    port: u16,
  ) -> Result<(StreamEnd, mpsc::UnboundedReceiver<StreamEvent>), String> {
    let mut state = self.lock();
    let id = state.next_id('s');
    let Some(agent) = state.agents.get_mut(name) else {
      return Err(format!("no agent named {name} is attached"));
    };
    let (caller, events) = mpsc::unbounded_channel();
    let window = Arc::new(SendWindow::default());
    let stream = OpenStream {
      caller,
      window: Arc::clone(&window),
      inbound: ReceiveWindow::default(),
    };
    agent.streams.insert(id.clone(), stream);
    let end = StreamEnd {
      hub: Arc::clone(self),
      name: name.to_owned(),
      socket_id: agent.link.socket_id,
      id: id.clone(),
      window,
    };
    state.send(name, &Frame::StreamOpen { id, port });
    Ok((end, events))
  }

  /// Have the named agent listen on `port` for streams back joined to `target`, now where it is attached
  /// and on every later connection; a target the hub's configuration does not allow is refused. A listen
  /// the agent already holds is kept as it stands, joined to `target` from now on.
  pub fn listen(&self, name: &str, port: u16, target: &str) -> Result<ListenOutcome, ListenRefusal> {
    if !self.options.reverse_targets.iter().any(|allowed| allowed == target) {
      return Err(ListenRefusal::TargetNotAllowed);
    }
    let mut state = self.lock();
    if let Some(agent) = state.agents.get(name)
      && !agent.capabilities.contains(&format!("listen:{port}"))
    {
      return Err(ListenRefusal::PortNotOffered);
    }
    state.listens.entry(name.to_owned()).or_default().insert(port, target.to_owned());
    if state.agents.get(name).is_some_and(|agent| agent.listening.contains(&port)) {
      return Ok(ListenOutcome::Standing);
    }
    state.send(
      name,
      &Frame::Listen {
        id: listen_id(port),
        port,
      },
    );
    Ok(ListenOutcome::Asked)
  }

  /// Stop the named agent listening on `port`; streams already accepted go on.
  pub fn unlisten(&self, name: &str, port: u16) {
    let mut state = self.lock();
    if let Some(wanted) = state.listens.get_mut(name) {
      wanted.remove(&port);
    }
    if let Some(agent) = state.agents.get_mut(name) {
      agent.listening.remove(&port);
    }
    state.send(
      name,
      &Frame::Unlisten {
        id: listen_id(port),
      },
    );
  }

  /// What the hub holds for the named agent to listen on: each port, its target, and whether the agent
  /// listens on it now.
  pub fn listens(&self, name: &str) -> Value {
    let state = self.lock();
    let listening = state.agents.get(name).map(|agent| agent.listening.clone()).unwrap_or_default();
    let items: Vec<Value> = state
      .listens
      .get(name)
      .map(|wanted| {
        wanted
          .iter()
          .map(|(port, target)| json!({ "port": port, "target": target, "listening": listening.contains(port) }))
          .collect()
      })
      .unwrap_or_default();
    json!({ "agent": name, "listens": items })
  }

  /// Tell the target agent to erase itself and depart; the name of the agent told. The leave is
  /// queued ahead of the socket's close, so the agent reads it before the connection ends.
  pub fn leave(&self, target: Option<&str>) -> Result<String, String> {
    let mut state = self.lock();
    let name = state.find_target(target, &Reach::All).map_err(|refusal| refusal.reason)?;
    state.send(&name, &Frame::Leave);
    state.depart(&name, "told to leave by the hub");
    Ok(name)
  }

  /// Record `name` as revoked, keeping the time of an earlier revocation, and send a leave to an
  /// agent attached under it; whether a leave was sent.
  pub fn revoke(&self, name: &str) -> bool {
    let mut state = self.lock();
    if !state.revoked.contains(name) {
      state.revoked.record(name, now_ms());
      eprintln!("jake hub: agent name {name} revoked");
    }
    if !state.agents.contains_key(name) {
      return false;
    }
    state.send(name, &Frame::Leave);
    state.depart(name, REVOKED_REASON);
    true
  }

  /// Every attached agent the caller reaches, ordered by name, every departed one and every revoked
  /// name it reaches, and this process's run tag.
  pub fn status(&self, reach: &Reach) -> Value {
    let state = self.lock();
    let mut agents: Vec<(&String, &Agent)> =
      state.agents.iter().filter(|(name, _)| reach.admits(name)).collect();
    agents.sort_by(|(a, _), (b, _)| by_name(a, b));
    let agents: Vec<Value> = agents
      .into_iter()
      .map(|(name, agent)| {
        json!({
            "name": name,
            "agentVersion": agent.agent_version,
            "capabilities": agent.capabilities,
            "connectedAt": agent.connected_at,
            "lastPongAt": agent.last_pong_at,
            "inFlight": agent.commands.keys().collect::<Vec<_>>(),
            "streams": agent.streams.keys().collect::<Vec<_>>(),
        })
      })
      .collect();
    let reached = |record: &TimedNames| -> Vec<Value> {
      record
        .list()
        .into_iter()
        .filter(|entry| entry["name"].as_str().is_some_and(|name| reach.admits(name)))
        .collect()
    };
    json!({
      "run": self.run,
      "attached": !agents.is_empty(),
      "agents": agents,
      "departed": reached(&state.departed),
      "revoked": reached(&state.revoked),
    })
  }

  /// The traffic recorded after `after_id`, and the live feed from the very next entry on.
  pub fn tail(&self, after_id: u64) -> (Vec<Arc<TrafficEntry>>, broadcast::Receiver<Arc<TrafficEntry>>) {
    let state = self.lock();
    let replay = state.traffic.iter().filter(|entry| entry.id > after_id).cloned().collect();
    (replay, state.traffic_tx.subscribe())
  }

  /// Close every agent socket and end everything in flight; the links, to wait on their closing.
  pub fn shutdown(&self) -> Vec<Link> {
    let mut state = self.lock();
    let names: Vec<String> = state.agents.keys().cloned().collect();
    let links = names
      .iter()
      .filter_map(|name| state.agents.get(name).map(|agent| agent.link.clone()))
      .collect();
    for name in names {
      state.detach(&name, "hub shutting down", true);
    }
    links
  }
}

/// What a listen the hub took came to.
#[derive(Debug, PartialEq, Eq)]
pub enum ListenOutcome {
  /// The agent is asked to listen, now where it is attached, else on its next connection.
  Asked,
  /// The agent already listens on the port; that listen is kept and nothing is asked of it.
  Standing,
}

/// Why a listen was refused.
#[derive(Debug, PartialEq, Eq)]
pub enum ListenRefusal {
  TargetNotAllowed,
  PortNotOffered,
}

// The id a listen on a port goes by on the wire.
fn listen_id(port: u16) -> String {
  format!("l{port}")
}

// The port a listen's id names, where it names one.
fn port_of_listen(id: &str) -> Option<u16> {
  id.strip_prefix('l').and_then(|port| port.parse().ok())
}

// Log how an order onto the agent build ended: what its command printed, and its exit.
async fn report_update(name: String, mut events: Events) {
  let mut printed = Vec::new();
  while let Some(event) = events.recv().await {
    match event.kind {
      "stdout" | "stderr" => {
        let chunk = &event.data["chunk"];
        if let (Some(bytes), Some(base64)) = (chunk["bytes"].as_u64(), chunk["base64"].as_str()) {
          let encoded = EncodedBytes {
            bytes,
            base64: base64.to_owned(),
          };
          printed.extend(decode_bytes(&encoded, UPDATE_REPORT_BYTES).unwrap_or_default());
        }
      }
      "started" => {}
      _ => {
        printed.truncate(UPDATE_REPORT_BYTES);
        let printed = String::from_utf8_lossy(&printed);
        eprintln!("jake hub: agent {name} update order {}: {} {}", event.kind, event.data, printed.trim());
        return;
      }
    }
  }
}

// One stream back: the agent's accepted connection joined to a fresh connection to its target here, each
// direction on its own until either ends.
async fn carry_back(end: StreamEnd, mut events: mpsc::UnboundedReceiver<StreamEvent>, target: String) {
  use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

  let Ok(socket) = tokio::net::TcpStream::connect(&target).await else {
    return;
  };
  let _ = socket.set_nodelay(true);
  let (mut reader, mut writer) = socket.into_split();
  let upstream = async {
    let mut buffer = vec![0; STREAM_CHUNK_BYTES];
    let mut seq = 0;
    loop {
      match reader.read(&mut buffer).await {
        Ok(0) | Err(_) => return,
        Ok(read) => {
          if !end.send(&mut seq, &buffer[..read]).await {
            return;
          }
        }
      }
    }
  };
  let downstream = async {
    while let Some(event) = events.recv().await {
      match event {
        StreamEvent::Data(data) => {
          if writer.write_all(&data).await.is_err() {
            return;
          }
          end.delivered(data.len() as u64);
        }
        StreamEvent::Closed(_) | StreamEvent::Failed(_) => return,
        StreamEvent::Opened => {}
      }
    }
  };
  tokio::select! {
    () = upstream => {}
    () = downstream => {}
  }
}

/// The caller's end of a byte stream: its bytes go to the agent through it, and what the caller has
/// taken of the agent's bytes is acknowledged through it. Dropping it ends the stream, telling the
/// agent when the stream was still open.
pub struct StreamEnd {
  hub: Arc<Hub>,
  name: String,
  socket_id: u64,
  id: String,
  window: Arc<SendWindow>,
}

impl StreamEnd {
  /// Send the caller's bytes to the port in pieces the window lets out; false once the stream is over.
  pub async fn send(&self, seq: &mut u64, data: &[u8]) -> bool {
    let mut sent = 0;
    while sent < data.len() {
      let wanted = (data.len() - sent).min(STREAM_CHUNK_BYTES);
      let Some(room) = self.window.take(wanted).await else {
        return false;
      };
      let frame = Frame::StreamData {
        id: self.id.clone(),
        seq: *seq,
        chunk: EncodedBytes::of(&data[sent..sent + room]),
      };
      *seq += 1;
      sent += room;
      let mut state = self.hub.lock();
      if state.owns_stream(&self.name, self.socket_id, &self.id).is_none() {
        return false;
      }
      if state.send(&self.name, &frame) == SendOutcome::Dropped {
        return false;
      }
    }
    true
  }

  /// The caller has taken `bytes` of the agent's; the agent is acknowledged once a batch is due.
  pub fn delivered(&self, bytes: u64) {
    let mut state = self.hub.lock();
    let ack = state
      .owns_stream(&self.name, self.socket_id, &self.id)
      .and_then(|stream| stream.inbound.handed_on(bytes));
    if let Some(bytes) = ack {
      let frame = Frame::StreamAck {
        id: self.id.clone(),
        bytes,
      };
      state.send(&self.name, &frame);
    }
  }
}

impl Drop for StreamEnd {
  fn drop(&mut self) {
    let mut state = self.hub.lock();
    if state.owns_stream(&self.name, self.socket_id, &self.id).is_none() {
      return;
    }
    if let Some(stream) =
      state.agents.get_mut(&self.name).and_then(|agent| agent.streams.shift_remove(&self.id))
    {
      stream.window.close();
    }
    let frame = Frame::StreamClose {
      id: self.id.clone(),
      reason: "the caller closed the stream".into(),
    };
    state.send(&self.name, &frame);
  }
}

#[cfg(test)]
mod tests {
  use futures_util::stream::{self, Iter};

  use super::*;
  use crate::link::Outbound;
  use crate::protocol::checksum;

  const CAP: usize = 16 * 1024 * 1024;

  type TestBody = Iter<std::vec::IntoIter<Result<Bytes, String>>>;

  fn hub(socket_backlog_bytes: usize) -> Arc<Hub> {
    Hub::new(HubOptions {
      secret: "s".into(),
      agent_key: Some("k".into()),
      control_token: "c".into(),
      control_key: Some("ck".into()),
      max_payload_bytes: CAP,
      ping_interval: Duration::from_secs(3600),
      missed_pong_limit: 3,
      socket_backlog_bytes,
      departed_path: None,
      revoked_path: None,
      reverse_targets: Vec::new(),
      agent_build: None,
    })
  }

  // An agent attached over a link whose queue the test reads, and marks written, by hand.
  fn attach(hub: &Arc<Hub>) -> (Link, mpsc::UnboundedReceiver<Outbound>) {
    let (link, queue) = Link::new(hub.next_socket_id(), hub.socket_backlog_bytes());
    hub.on_message(
      &link,
      r#"{"type":"hello","v":1,"agent":"hass","agentVersion":"0.1.0","capabilities":["transfer"]}"#,
    );
    (link, queue)
  }

  // Every frame queued so far, each with its size for marking it written.
  fn queued(queue: &mut mpsc::UnboundedReceiver<Outbound>) -> Vec<(Frame, usize)> {
    let mut frames = Vec::new();
    while let Ok(Outbound::Text(text)) = queue.try_recv() {
      frames.push((decode_frame(&text, CAP).expect("a valid frame"), text.len()));
    }
    frames
  }

  fn kinds(frames: &[(Frame, usize)]) -> Vec<&'static str> {
    frames.iter().map(|(frame, _)| frame.kind()).collect()
  }

  fn written(link: &Link, frames: &[(Frame, usize)]) {
    link.wrote(frames.iter().map(|(_, size)| size).sum());
  }

  fn upload(data: &[u8]) -> UploadParams<TestBody> {
    let body = stream::iter(vec![Ok(Bytes::copy_from_slice(data))]);
    UploadParams {
      path: "/out.bin".into(),
      total: data.len() as u64,
      checksum: checksum(data),
      body,
    }
  }

  // Let the spawned pump run as far as it can.
  async fn settle() {
    for _ in 0..20 {
      tokio::task::yield_now().await;
    }
  }

  fn received(events: &mut Events) -> Vec<Event> {
    std::iter::from_fn(|| events.try_recv().ok()).collect()
  }

  fn attached_names(hub: &Arc<Hub>) -> Vec<String> {
    hub.status(&Reach::All)["agents"]
      .as_array()
      .map(|agents| agents.iter().filter_map(|agent| agent["name"].as_str().map(str::to_owned)).collect())
      .unwrap_or_default()
  }

  #[tokio::test]
  async fn a_credential_of_one_name_admits_that_name_alone() {
    let hub = hub(CAP);
    let credential = credential::credential("k", "u7");
    let bearer = format!("Bearer {credential}");
    assert_eq!(hub.authorize_agent(Some(bearer.as_bytes())), Some(Some("u7".to_owned())));
    assert_eq!(hub.authorize_agent(Some(b"Bearer s")), Some(None));
    assert_eq!(hub.authorize_agent(Some(b"Bearer u7.00")), None);
    assert_eq!(
      hub.authorize_agent(Some(format!("Bearer {}", credential::credential("other", "u7")).as_bytes())),
      None
    );
    assert_eq!(hub.authorize_agent(None), None);

    // A hello under its own name attaches; one under another closes the socket and attaches nothing.
    let (own, _queue) = Link::new(hub.next_socket_id(), hub.socket_backlog_bytes());
    let own = own.held_to(Some("u7".into()));
    hub.on_message(&own, r#"{"type":"hello","v":1,"agent":"u7","agentVersion":"0.1.0","capabilities":[]}"#);
    assert!(attached_names(&hub).contains(&"u7".to_owned()));
    let (other, mut other_queue) = Link::new(hub.next_socket_id(), hub.socket_backlog_bytes());
    let other = other.held_to(Some("u7".into()));
    hub.on_message(
      &other,
      r#"{"type":"hello","v":1,"agent":"hass","agentVersion":"0.1.0","capabilities":[]}"#,
    );
    assert!(matches!(other_queue.try_recv(), Ok(Outbound::Close(4003, _))));
    assert!(!attached_names(&hub).contains(&"hass".to_owned()));
  }

  #[tokio::test]
  async fn a_revoked_hello_on_an_attached_socket_takes_the_name_it_held_down_with_it() {
    let hub = hub(CAP);
    let hello = r#"{"type":"hello","v":1,"agent":"u7","agentVersion":"0.1.0","capabilities":[]}"#;
    let (link, mut queue) = Link::new(hub.next_socket_id(), hub.socket_backlog_bytes());
    let link = link.held_to(Some("u7".into()));
    hub.on_message(&link, hello);
    assert_eq!(attached_names(&hub), ["u7"]);
    while queue.try_recv().is_ok() {}

    // Revoked under the socket's feet, the name's next hello is answered with a leave and a close.
    hub.lock().revoked.record("u7", 1);
    hub.on_message(&link, hello);
    assert!(matches!(queue.try_recv(), Ok(Outbound::Text(text)) if text.contains(r#""type":"leave""#)));
    assert!(matches!(queue.try_recv(), Ok(Outbound::Close(CLOSE_HUB_INITIATED, _))));
    assert!(attached_names(&hub).is_empty());
    assert!(hub.lock().by_socket.is_empty());
  }

  #[tokio::test]
  async fn a_scoped_control_credential_reaches_its_own_agents_alone() {
    let hub = hub(CAP);
    let bearer = |credential: String| format!("Bearer {credential}");
    assert_eq!(hub.authorize_control(Some(b"Bearer c")), Some(Reach::All));
    let scoped = hub.authorize_control(Some(bearer(credential::credential("ck", "u4")).as_bytes()));
    assert_eq!(scoped, Reach::of_names("u4"));
    // The credential an agent dials with is made with the agent key, and reaches nothing here.
    assert_eq!(hub.authorize_control(Some(bearer(credential::credential("k", "u4")).as_bytes())), None);
    let scoped = scoped.expect("a scoped reach");

    let mut links = Vec::new();
    for name in ["u4", "u7", "hass"] {
      let (link, queue) = Link::new(hub.next_socket_id(), hub.socket_backlog_bytes());
      hub.on_message(
        &link,
        &format!(r#"{{"type":"hello","v":1,"agent":"{name}","agentVersion":"0.1.0","capabilities":[]}}"#),
      );
      links.push((link, queue));
    }

    // With three attached, a request naming none goes to the one the credential reaches.
    assert_eq!(hub.resolve_target(None, &scoped).expect("its own agent"), "u4");
    for other in ["u7", "ghost"] {
      let refused = hub.resolve_target(Some(other), &scoped).expect_err("out of reach");
      assert_eq!((refused.kind.status(), refused.kind.code()), (403, "agent-out-of-reach"));
    }
    let status = hub.status(&scoped);
    let names: Vec<&str> = status["agents"]
      .as_array()
      .expect("agents")
      .iter()
      .filter_map(|a| a["name"].as_str())
      .collect();
    assert_eq!(names, ["u4"]);

    // A command on another agent is unknown to the scoped caller, and still the administrator's to cancel.
    let mut events = hub
      .start_exec(
        ExecParams {
          shell: "linux".into(),
          command: "sleep 60".into(),
          cwd: None,
          env: Map::new(),
          distro: None,
        },
        Some("u7"),
      )
      .expect("started");
    let started = received(&mut events);
    let id = started[0].data["id"].as_str().expect("an id").to_owned();
    assert_eq!(hub.cancel(&id, &scoped), Err("unknown command".to_owned()));
    assert_eq!(hub.cancel(&id, &Reach::All), Ok(()));
  }

  #[tokio::test]
  async fn an_agent_is_ordered_onto_the_build_only_while_idle_and_once_within_the_retry_window() {
    let hub = hub(CAP);
    let build = AgentBuild {
      version: "0.1.0+gnew0000".into(),
      download_url: "https://example.test/jake".into(),
    };
    let (link, mut queue) = Link::new(hub.next_socket_id(), hub.socket_backlog_bytes());
    hub.on_message(
      &link,
      r#"{"type":"hello","v":1,"agent":"n2","agentVersion":"0.1.0+gold0000","capabilities":["exec:linux"]}"#,
    );
    let params = ExecParams {
      shell: "linux".into(),
      command: "sleep 1".into(),
      cwd: None,
      env: Map::new(),
      distro: None,
    };
    let _running = hub.start_exec(params, Some("n2")).expect("started");
    assert!(hub.lock().offer_update("n2", &build, 0).is_none(), "a caller's command holds it back");

    hub.on_message(&link, r#"{"type":"exit","v":1,"id":"c1","code":0,"signal":null,"canceled":false}"#);
    let (running, _order) = hub.lock().offer_update("n2", &build, 0).expect("ordered once idle");
    assert_eq!(running, "0.1.0+gold0000");
    let sent = queued(&mut queue);
    assert_eq!(kinds(&sent).last(), Some(&"exec"));

    hub.on_message(&link, r#"{"type":"exit","v":1,"id":"c2","code":0,"signal":null,"canceled":false}"#);
    assert!(hub.lock().offer_update("n2", &build, update::RETRY_AFTER_MS - 1).is_none());
    assert!(hub.lock().offer_update("n2", &build, update::RETRY_AFTER_MS).is_some());
  }

  #[test]
  fn without_an_agent_key_only_the_shared_secret_admits() {
    let hub = Hub::new(HubOptions {
      secret: "s".into(),
      agent_key: None,
      control_token: "c".into(),
      control_key: None,
      max_payload_bytes: CAP,
      ping_interval: Duration::from_secs(3600),
      missed_pong_limit: 3,
      socket_backlog_bytes: CAP,
      departed_path: None,
      revoked_path: None,
      reverse_targets: Vec::new(),
      agent_build: None,
    });
    let bearer = format!("Bearer {}", credential::credential("k", "u7"));
    assert_eq!(hub.authorize_agent(Some(bearer.as_bytes())), None);
    assert_eq!(hub.authorize_agent(Some(b"Bearer s")), Some(None));
  }

  #[tokio::test]
  async fn a_connection_the_agent_accepts_is_carried_back_to_the_listens_target() {
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

    let target = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("a target");
    let address = target.local_addr().expect("its address").to_string();
    let hub = Hub::new(HubOptions {
      secret: "s".into(),
      agent_key: None,
      control_token: "c".into(),
      control_key: None,
      max_payload_bytes: CAP,
      ping_interval: Duration::from_secs(3600),
      missed_pong_limit: 3,
      socket_backlog_bytes: CAP,
      departed_path: None,
      revoked_path: None,
      reverse_targets: vec![address.clone(), "127.0.0.1:4555".into()],
      agent_build: None,
    });

    // A target the hub does not allow is refused; so is a port an attached agent does not offer.
    assert_eq!(hub.listen("pc", 4100, "127.0.0.1:1"), Err(ListenRefusal::TargetNotAllowed));
    let (link, mut queue) = Link::new(hub.next_socket_id(), hub.socket_backlog_bytes());
    hub.on_message(
      &link,
      r#"{"type":"hello","v":1,"agent":"pc","agentVersion":"0.1.0","capabilities":["listen:4100"]}"#,
    );
    assert_eq!(hub.listen("pc", 4200, &address), Err(ListenRefusal::PortNotOffered));

    // A listen asked of an attached agent goes out at once, and is asked again on its next connection.
    assert_eq!(hub.listen("pc", 4100, "127.0.0.1:4555"), Ok(ListenOutcome::Asked));
    let frames = queued(&mut queue);
    assert_eq!(kinds(&frames), ["welcome", "listen"]);
    hub.on_message(&link, r#"{"type":"listening","v":1,"id":"l4100"}"#);
    assert_eq!(hub.listens("pc")["listens"][0]["listening"], json!(true));

    // Asked again while it stands, the listen is kept: nothing goes to the agent, and the new target holds.
    assert_eq!(hub.listen("pc", 4100, &address), Ok(ListenOutcome::Standing));
    assert!(queued(&mut queue).is_empty());
    assert_eq!(
      hub.listens("pc")["listens"][0],
      json!({ "port": 4100, "target": address, "listening": true })
    );
    let (again, mut again_queue) = Link::new(hub.next_socket_id(), hub.socket_backlog_bytes());
    hub.on_message(
      &again,
      r#"{"type":"hello","v":1,"agent":"pc","agentVersion":"0.1.0","capabilities":["listen:4100"]}"#,
    );
    assert_eq!(kinds(&queued(&mut again_queue)), ["welcome", "listen"]);

    // A connection the agent accepted reaches the target, and the target's answer goes back to the agent.
    hub.on_message(&again, r#"{"type":"stream-accept","v":1,"id":"l4100.1","listen":"l4100"}"#);
    let (mut accepted, _) = target.accept().await.expect("the hub's connection");
    let piece = Frame::StreamData {
      id: "l4100.1".into(),
      seq: 0,
      chunk: EncodedBytes::of(b"ping"),
    };
    hub.on_message(&again, &piece.encode());
    let mut heard = [0u8; 4];
    accepted.read_exact(&mut heard).await.expect("the agent's bytes");
    assert_eq!(&heard, b"ping");
    accepted.write_all(b"pong").await.expect("the answer");
    let mut back = Vec::new();
    for _ in 0..200 {
      settle().await;
      back.extend(queued(&mut again_queue));
      if back.iter().any(|(frame, _)| matches!(frame, Frame::StreamData { .. })) {
        break;
      }
      tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let answered = back.iter().find_map(|(frame, _)| match frame {
      Frame::StreamData { id, chunk, .. } if id == "l4100.1" => decode_bytes(chunk, CAP).ok(),
      _ => None,
    });
    assert_eq!(answered.as_deref(), Some(&b"pong"[..]));

    // Stopping a listen tells the agent and drops it from what the hub holds.
    hub.unlisten("pc", 4100);
    assert!(kinds(&queued(&mut again_queue)).contains(&"unlisten"));
    assert_eq!(hub.listens("pc")["listens"], json!([]));
  }

  #[test]
  fn agents_are_listed_by_name_lowercase_first_among_case_variants() {
    let mut names = vec!["node2", "AB", "ab", "jake_wsl", "aB", "Ab"];
    names.sort_by(|a, b| by_name(a, b));
    assert_eq!(names, ["ab", "aB", "Ab", "AB", "jake_wsl", "node2"]);
  }

  #[tokio::test]
  async fn an_upload_hands_a_backed_up_socket_nothing_more_until_it_drains() {
    let hub = hub(1);
    let (link, mut queue) = attach(&hub);
    let data = vec![7u8; TRANSFER_CHUNK_BYTES * 3 + 10];
    let _events = hub.start_upload(upload(&data), None).expect("started");
    settle().await;
    let opening = queued(&mut queue);
    assert_eq!(kinds(&opening), ["welcome", "transfer-begin"]);
    settle().await;
    assert!(queued(&mut queue).is_empty(), "nothing more is handed over before the backlog drains");

    written(&link, &opening);
    let mut seqs = Vec::new();
    loop {
      settle().await;
      let frames = queued(&mut queue);
      assert_eq!(frames.len(), 1, "one frame per drain");
      match &frames[0].0 {
        Frame::TransferChunk { seq, .. } => seqs.push(*seq),
        Frame::TransferEnd { total, .. } => {
          assert_eq!(*total, data.len() as u64);
          break;
        }
        other => panic!("unexpected {}", other.kind()),
      }
      written(&link, &frames);
    }
    assert_eq!(seqs, [0, 1, 2, 3]);
  }

  #[tokio::test]
  async fn an_upload_the_agent_has_failed_is_sent_no_further() {
    let hub = hub(1);
    let (link, mut queue) = attach(&hub);
    let data = vec![7u8; TRANSFER_CHUNK_BYTES * 3];
    let mut events = hub.start_upload(upload(&data), None).expect("started");
    settle().await;
    written(&link, &queued(&mut queue));
    settle().await;
    let chunk = queued(&mut queue);
    assert_eq!(kinds(&chunk), ["transfer-chunk"]);

    hub.on_message(
      &link,
      r#"{"type":"error","v":1,"id":"u1","code":"disk-full","message":"no space left on device"}"#,
    );
    written(&link, &chunk);
    settle().await;
    assert!(queued(&mut queue).is_empty());
    let events = received(&mut events);
    assert_eq!(events.iter().map(|event| event.kind).collect::<Vec<_>>(), ["started", "error"]);
    assert_eq!(events[1].data["code"], "disk-full");
  }

  #[tokio::test]
  async fn a_body_that_breaks_off_fails_the_upload_and_tells_the_agent_to_discard_it() {
    let hub = hub(CAP);
    let (_link, mut queue) = attach(&hub);
    let body = stream::iter(vec![Ok(Bytes::from(vec![0u8; 100])), Err("the caller hung up".to_owned())]);
    let params = UploadParams {
      path: "/out.bin".into(),
      total: 1000,
      checksum: "0".repeat(64),
      body,
    };
    let mut events = hub.start_upload(params, None).expect("started");
    settle().await;
    let frames = queued(&mut queue);
    assert_eq!(kinds(&frames), ["welcome", "transfer-begin", "error"]);
    assert!(matches!(&frames[2].0, Frame::Error { code, .. } if code == "body-broken"));
    let events = received(&mut events);
    assert_eq!(events[1].data["code"], "body-broken");
    assert_eq!(events[1].data["message"], "the upload's body broke off: the caller hung up");
  }
}
