// The hub's handle on one agent socket: an outbound queue that reports its backlog, and its close.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use tokio::sync::{Notify, mpsc};

/// What the socket's writer is handed: a text frame, or the close that ends the socket.
#[derive(Debug)]
pub enum Outbound {
  Text(String),
  Close(u16, String),
}

/// What became of one frame handed to a link.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SendOutcome {
  /// Queued within the backlog limit.
  Sent,
  /// Queued past the backlog limit: a paced sender waits for `drained` before handing it more.
  Queued,
  /// Not queued, because the socket is closed or closing.
  Dropped,
}

struct Shared {
  tx: mpsc::UnboundedSender<Outbound>,
  backlog: AtomicUsize,
  backlog_limit: usize,
  closed: AtomicBool,
  wake: Notify,
}

/// One agent socket as the core sees it. `socket_id` tells a superseded socket from the one now
/// holding its agent's name.
#[derive(Clone)]
pub struct Link {
  pub socket_id: u64,
  /// The one name this connection may take, where its credential was made for one; none takes any.
  pub only: Option<Arc<str>>,
  shared: Arc<Shared>,
}

impl Link {
  /// The link held to the one name its credential was made for.
  pub fn held_to(mut self, name: Option<String>) -> Self {
    self.only = name.map(Arc::from);
    self
  }

  /// A link and the receiving end its socket's writer drains.
  pub fn new(socket_id: u64, backlog_limit: usize) -> (Self, mpsc::UnboundedReceiver<Outbound>) {
    let (tx, rx) = mpsc::unbounded_channel();
    let shared = Shared {
      tx,
      backlog: AtomicUsize::new(0),
      backlog_limit,
      closed: AtomicBool::new(false),
      wake: Notify::new(),
    };
    (
      Self {
        socket_id,
        only: None,
        shared: Arc::new(shared),
      },
      rx,
    )
  }

  pub fn send(&self, text: String) -> SendOutcome {
    if self.is_closed() {
      return SendOutcome::Dropped;
    }
    let size = text.len();
    let backlog = self.shared.backlog.fetch_add(size, Ordering::AcqRel) + size;
    if self.shared.tx.send(Outbound::Text(text)).is_err() {
      self.wrote(size);
      return SendOutcome::Dropped;
    }
    if backlog > self.shared.backlog_limit {
      SendOutcome::Queued
    } else {
      SendOutcome::Sent
    }
  }

  pub fn close(&self, code: u16, reason: &str) {
    let _ = self.shared.tx.send(Outbound::Close(code, reason.to_owned()));
  }

  /// The writer has put `size` bytes of a queued frame on the wire.
  pub fn wrote(&self, size: usize) {
    let left = self.shared.backlog.fetch_sub(size, Ordering::AcqRel) - size;
    if left <= self.low_water() {
      self.shared.wake.notify_waiters();
    }
  }

  /// The socket can carry nothing more.
  pub fn mark_closed(&self) {
    self.shared.closed.store(true, Ordering::Release);
    self.shared.wake.notify_waiters();
  }

  pub fn is_closed(&self) -> bool {
    self.shared.closed.load(Ordering::Acquire)
  }

  /// Settles once the backlog has fallen to half its limit, or once the socket has closed.
  pub async fn drained(&self) {
    self
      .wait_until(|link| link.shared.backlog.load(Ordering::Acquire) <= link.low_water())
      .await;
  }

  /// Settles once the socket has closed.
  pub async fn closed(&self) {
    self.wait_until(|_| false).await;
  }

  async fn wait_until(&self, ready: impl Fn(&Self) -> bool) {
    loop {
      let woken = self.shared.wake.notified();
      tokio::pin!(woken);
      woken.as_mut().enable();
      if self.is_closed() || ready(self) {
        return;
      }
      woken.await;
    }
  }

  fn low_water(&self) -> usize {
    self.shared.backlog_limit / 2
  }
}
