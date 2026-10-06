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

use crate::departed::Departed;
use crate::link::{Link, SendOutcome};
use crate::protocol::{
  Checksum, Direction, EncodedBytes, Frame, TRANSFER_CHUNK_BYTES, decode_bytes, decode_frame,
};

/// The version the hub names in its welcome.
const HUB_VERSION: &str = "0.1.0";
/// How many recent traffic entries are kept for a late console to replay.
const RING_SIZE: usize = 200;
/// How many live traffic entries a slow tail may fall behind before it skips ahead.
const TAIL_BACKLOG: usize = 1024;
/// The close code of a socket the hub drops on purpose, from the range kept for applications.
const CLOSE_HUB_INITIATED: u16 = 4000;

pub struct HubOptions {
  pub secret: String,
  pub control_token: String,
  pub max_payload_bytes: usize,
  pub ping_interval: Duration,
  pub missed_pong_limit: u32,
  pub socket_backlog_bytes: usize,
  /// Where the departed agents are recorded; none keeps the record in memory alone.
  pub departed_path: Option<PathBuf>,
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
}

impl TargetRefusal {
  pub fn code(self) -> &'static str {
    match self {
      Self::NoAgent => "no-agent",
      Self::UnknownAgent => "unknown-agent",
      Self::AgentRequired => "agent-required",
    }
  }

  /// The HTTP status the refusal answers with: a conflict with the hub's state, a name not found,
  /// or a choice the caller must make.
  pub fn status(self) -> u16 {
    match self {
      Self::NoAgent => 409,
      Self::UnknownAgent => 404,
      Self::AgentRequired => 400,
    }
  }
}

#[derive(Debug)]
pub struct Refusal {
  pub kind: TargetRefusal,
  pub reason: String,
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

struct State {
  agents: HashMap<String, Agent>,
  by_socket: HashMap<u64, String>,
  traffic: VecDeque<Arc<TrafficEntry>>,
  traffic_seq: u64,
  traffic_tx: broadcast::Sender<Arc<TrafficEntry>>,
  id_seq: u64,
  departed: Departed,
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
      self.detach(&name, "superseded by a new connection", held != link.socket_id);
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
    };
    self.agents.insert(name.clone(), agent);
    self.by_socket.insert(link.socket_id, name.clone());
    self.send(
      &name,
      &Frame::Welcome {
        hub_version: HUB_VERSION.into(),
      },
    );
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
  }

  // An agent that has left is dropped and recorded, so it reads as gone rather than disconnected.
  fn depart(&mut self, name: &str, how: &str) {
    self.detach(name, how, true);
    self.departed.record(name, now_ms());
    eprintln!("jake hub: agent {name} departed: {how}");
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
      Frame::Error { id, code, message } => {
        // An error answers a command the agent refused before it could stream, or a transfer that failed.
        if let Some(listener) = agent.commands.shift_remove(&id) {
          listener.push("error", json!({ "code": code, "message": message }));
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
      // A handshake or hub-outbound frame arriving from the agent is not the hub's to act on.
      _ => {}
    }
  }

  fn find_target(&self, name: Option<&str>) -> Result<String, Refusal> {
    if self.agents.is_empty() {
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
    if self.agents.len() > 1 {
      let mut names: Vec<&str> = self.agents.keys().map(String::as_str).collect();
      names.sort_unstable();
      let reason = format!("{} agents are attached ({}); name one", names.len(), names.join(", "));
      return Err(Refusal {
        kind: TargetRefusal::AgentRequired,
        reason,
      });
    }
    Ok(self.agents.keys().next().cloned().unwrap_or_default())
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
      departed: Departed::load(options.departed_path.clone()),
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

  /// True when the header presents the agent secret.
  pub fn authorize_agent(&self, header: Option<&[u8]>) -> bool {
    header == Some(format!("Bearer {}", self.options.secret).as_bytes())
  }

  /// True when the header presents the control token.
  pub fn authorize_control(&self, header: Option<&[u8]>) -> bool {
    header == Some(format!("Bearer {}", self.options.control_token).as_bytes())
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
      let summary = frame.summary();
      state.attach(link, agent.clone(), agent_version.clone(), capabilities.clone(), summary);
      let probe = self.probe(agent.clone(), link.socket_id);
      if let Some(attached) = state.agents.get_mut(agent) {
        attached.probe = Some(probe);
      }
      return;
    }

    // Only an attached socket may drive the hub; a frame from one that never said hello, or has
    // since been superseded, is dropped.
    let Some(name) = known else {
      return;
    };
    state.record(Some(&name), "in", frame.kind(), frame.summary());
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
    true
  }

  // --- Control operations ----------------------------------------------------------------------

  /// Decide which agent a request goes to: a named one must be attached, and no name picks the
  /// only one attached.
  pub fn resolve_target(&self, name: Option<&str>) -> Result<String, Refusal> {
    self.lock().find_target(name)
  }

  /// Start a shell command on the target agent; its life arrives on the returned events.
  pub fn start_exec(&self, params: ExecParams, target: Option<&str>) -> Result<Events, String> {
    let mut state = self.lock();
    let name = state.find_target(target).map_err(|refusal| refusal.reason)?;
    let id = state.next_id('c');
    let (listener, events) = Listener::open();
    listener.push("started", json!({ "id": id }));
    if let Some(agent) = state.agents.get_mut(&name) {
      agent.commands.insert(id.clone(), listener);
    }
    let ExecParams {
      shell,
      command,
      cwd,
      env,
      distro,
    } = params;
    state.send(
      &name,
      &Frame::Exec {
        id,
        shell,
        command,
        cwd,
        env,
        distro,
      },
    );
    Ok(events)
  }

  /// Ask the agent running a command to stop it; a command id is unique across the hub.
  pub fn cancel(&self, id: &str) -> Result<(), String> {
    let mut state = self.lock();
    if state.agents.is_empty() {
      return Err("no agent attached".into());
    }
    let Some(name) = state
      .agents
      .iter()
      .find(|(_, agent)| agent.commands.contains_key(id))
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
    let name = state.find_target(target).map_err(|refusal| refusal.reason)?;
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
    let name = state.find_target(target).map_err(|refusal| refusal.reason)?;
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

  /// Tell the target agent to erase itself and depart; the name of the agent told. The leave is
  /// queued ahead of the socket's close, so the agent reads it before the connection ends.
  pub fn leave(&self, target: Option<&str>) -> Result<String, String> {
    let mut state = self.lock();
    let name = state.find_target(target).map_err(|refusal| refusal.reason)?;
    state.send(&name, &Frame::Leave);
    state.depart(&name, "told to leave by the hub");
    Ok(name)
  }

  /// Every attached agent, ordered by name, every departed one, and this process's run tag.
  pub fn status(&self) -> Value {
    let state = self.lock();
    let mut agents: Vec<(&String, &Agent)> = state.agents.iter().collect();
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
        })
      })
      .collect();
    json!({ "run": self.run, "attached": !agents.is_empty(), "agents": agents, "departed": state.departed.list() })
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
      control_token: "c".into(),
      max_payload_bytes: CAP,
      ping_interval: Duration::from_secs(3600),
      missed_pong_limit: 3,
      socket_backlog_bytes,
      departed_path: None,
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
