// Byte streams to the machine's own ports: one local TCP connection per stream, its bytes carried
// both ways in pieces the stream's window paces.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use jake_protocol::{EncodedBytes, Frame, ReceiveWindow, STREAM_CHUNK_BYTES, SendWindow, decode_bytes};
use serde_json::json;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::TcpStream;
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio::time::timeout;

use crate::log::Log;

/// How long the port may take to accept the connection before the open fails.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

// One stream as the connection holds it. Dropping it ends the stream: the task that owns the TCP
// connection is stopped, which closes the connection.
struct Open {
  task: JoinHandle<()>,
  inbound: mpsc::UnboundedSender<Vec<u8>>,
  receive: Arc<Mutex<ReceiveWindow>>,
  send: Arc<SendWindow>,
}

impl Drop for Open {
  fn drop(&mut self) {
    self.send.close();
    self.task.abort();
  }
}

/// Every stream open on one connection. The connection feeds it the stream frames in order.
pub struct Streams {
  out: mpsc::Sender<Frame>,
  allowed: Vec<u16>,
  max_payload_bytes: usize,
  log: Log,
  open: HashMap<String, Open>,
}

impl Streams {
  pub fn new(out: mpsc::Sender<Frame>, allowed: Vec<u16>, max_payload_bytes: usize, log: Log) -> Self {
    Self {
      out,
      allowed,
      max_payload_bytes,
      log,
      open: HashMap::new(),
    }
  }

  async fn refuse(&self, id: String, code: &str, message: String) {
    let frame = Frame::Error {
      id,
      code: code.into(),
      message,
    };
    let _ = self.out.send(frame).await;
  }

  /// Open a connection to `port` on this machine, if the machine's config lets a stream reach it.
  pub async fn open(&mut self, id: String, port: u16) {
    self.open.retain(|_, stream| !stream.task.is_finished());
    if self.open.contains_key(&id) {
      let message = "a stream with this id is already open".to_owned();
      return self.refuse(id, "duplicate", message).await;
    }
    if !self.allowed.contains(&port) {
      let message = format!("port {port} is not among this machine's stream ports");
      return self.refuse(id, "port-not-allowed", message).await;
    }
    let (inbound, inbound_rx) = mpsc::unbounded_channel();
    let receive = Arc::new(Mutex::new(ReceiveWindow::default()));
    let send = Arc::new(SendWindow::default());
    let carrier = Carrier {
      id: id.clone(),
      out: self.out.clone(),
      receive: Arc::clone(&receive),
      send: Arc::clone(&send),
      log: self.log.clone(),
    };
    let task = tokio::spawn(carrier.serve(port, inbound_rx));
    let stream = Open {
      task,
      inbound,
      receive,
      send,
    };
    self.open.insert(id, stream);
  }

  /// One piece of the hub's bytes for a stream's connection.
  pub async fn data(&mut self, id: &str, seq: u64, chunk: &EncodedBytes) {
    let Some(stream) = self.open.get(id) else { return };
    let accepted =
      decode_bytes(chunk, self.max_payload_bytes)
        .map_err(|error| error.message)
        .and_then(|data| {
          let mut receive = stream.receive.lock().unwrap_or_else(PoisonError::into_inner);
          receive.accept(seq, data.len() as u64).map(|()| data)
        });
    match accepted {
      Ok(data) => {
        let _ = stream.inbound.send(data);
      }
      Err(reason) => {
        self.open.remove(id);
        let frame = Frame::StreamClose {
          id: id.to_owned(),
          reason,
        };
        let _ = self.out.send(frame).await;
      }
    }
  }

  /// The hub has handed on `bytes` of a stream; its window reopens by that many.
  pub fn ack(&self, id: &str, bytes: u64) {
    if let Some(stream) = self.open.get(id) {
      stream.send.grant(bytes);
    }
  }

  /// The hub has closed a stream: its connection is dropped, and nothing is answered.
  pub fn close(&mut self, id: &str) {
    self.open.remove(id);
  }

  /// Drop every stream, the socket they belonged to being gone.
  pub fn abandon(&mut self) {
    self.open.clear();
  }
}

// The task that owns one stream's TCP connection and carries its bytes both ways.
struct Carrier {
  id: String,
  out: mpsc::Sender<Frame>,
  receive: Arc<Mutex<ReceiveWindow>>,
  send: Arc<SendWindow>,
  log: Log,
}

impl Carrier {
  async fn serve(self, port: u16, inbound: mpsc::UnboundedReceiver<Vec<u8>>) {
    let socket = match timeout(CONNECT_TIMEOUT, TcpStream::connect(("localhost", port))).await {
      Ok(Ok(socket)) => socket,
      Ok(Err(error)) => return self.refuse(format!("localhost:{port}: {error}")).await,
      Err(_) => {
        return self.refuse(format!("localhost:{port} did not accept within {CONNECT_TIMEOUT:?}")).await;
      }
    };
    let _ = socket.set_nodelay(true);
    if self
      .out
      .send(Frame::StreamOpened {
        id: self.id.clone(),
      })
      .await
      .is_err()
    {
      return;
    }
    self.log.info("stream-opened", json!({ "id": self.id, "port": port }));
    let (reader, writer) = socket.into_split();
    // Whichever way ends first ends the stream; the other is dropped with the connection.
    let reason = tokio::select! {
      reason = self.outward(reader) => reason,
      reason = self.inward(writer, inbound) => reason,
    };
    self.log.info("stream-closed", json!({ "id": self.id, "reason": reason }));
    let frame = Frame::StreamClose {
      id: self.id.clone(),
      reason,
    };
    let _ = self.out.send(frame).await;
  }

  async fn refuse(&self, message: String) {
    let frame = Frame::Error {
      id: self.id.clone(),
      code: "connect-failed".into(),
      message,
    };
    let _ = self.out.send(frame).await;
  }

  // The port's bytes to the hub, as fast as the window lets them go.
  async fn outward(&self, mut reader: OwnedReadHalf) -> String {
    let mut buffer = vec![0; STREAM_CHUNK_BYTES];
    let mut seq = 0;
    loop {
      let read = match reader.read(&mut buffer).await {
        Ok(0) => return "the port closed the connection".into(),
        Ok(read) => read,
        Err(error) => return format!("reading from the port failed: {error}"),
      };
      let mut sent = 0;
      while sent < read {
        let Some(room) = self.send.take(read - sent).await else {
          return "the stream was closed".into();
        };
        let frame = Frame::StreamData {
          id: self.id.clone(),
          seq,
          chunk: EncodedBytes::of(&buffer[sent..sent + room]),
        };
        seq += 1;
        sent += room;
        if self.out.send(frame).await.is_err() {
          return "the hub connection is gone".into();
        }
      }
    }
  }

  // The hub's bytes to the port, each batch acknowledged once written.
  async fn inward(
    &self,
    mut writer: OwnedWriteHalf,
    mut inbound: mpsc::UnboundedReceiver<Vec<u8>>,
  ) -> String {
    while let Some(data) = inbound.recv().await {
      if let Err(error) = writer.write_all(&data).await {
        return format!("writing to the port failed: {error}");
      }
      let ack = self.receive.lock().unwrap_or_else(PoisonError::into_inner).handed_on(data.len() as u64);
      if let Some(bytes) = ack {
        let frame = Frame::StreamAck {
          id: self.id.clone(),
          bytes,
        };
        if self.out.send(frame).await.is_err() {
          return "the hub connection is gone".into();
        }
      }
    }
    "the stream was closed".into()
  }
}
