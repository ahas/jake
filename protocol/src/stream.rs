// The window that paces a byte stream, as docs/protocol.md states it: the sender's credit and the receiver's account.

use std::sync::{Mutex, PoisonError};

use tokio::sync::Notify;

/// The most bytes one stream-data frame carries.
pub const STREAM_CHUNK_BYTES: usize = 64 * 1024;
/// The most bytes of a stream a sender may have sent and not yet seen acknowledged.
pub const STREAM_WINDOW_BYTES: u64 = 1024 * 1024;
/// How many bytes a receiver hands on before it acknowledges them in one stream-ack.
pub const STREAM_ACK_BYTES: u64 = STREAM_WINDOW_BYTES / 4;

struct Credit {
  available: u64,
  closed: bool,
}

/// What a stream's sender may still send: the window less what is out unacknowledged.
pub struct SendWindow {
  credit: Mutex<Credit>,
  wake: Notify,
}

impl Default for SendWindow {
  fn default() -> Self {
    Self {
      credit: Mutex::new(Credit {
        available: STREAM_WINDOW_BYTES,
        closed: false,
      }),
      wake: Notify::new(),
    }
  }
}

impl SendWindow {
  /// Wait until the window has room, then take as much of `wanted` as it holds; none once the
  /// stream is over.
  pub async fn take(&self, wanted: usize) -> Option<usize> {
    loop {
      {
        let mut credit = self.credit.lock().unwrap_or_else(PoisonError::into_inner);
        if credit.closed {
          return None;
        }
        if credit.available > 0 {
          let taken = credit.available.min(wanted as u64);
          credit.available -= taken;
          return Some(taken as usize);
        }
      }
      self.wake.notified().await;
    }
  }

  /// The receiver acknowledged `bytes`; the window reopens by that many, never past its size.
  pub fn grant(&self, bytes: u64) {
    let mut credit = self.credit.lock().unwrap_or_else(PoisonError::into_inner);
    credit.available = credit.available.saturating_add(bytes).min(STREAM_WINDOW_BYTES);
    drop(credit);
    self.wake.notify_one();
  }

  /// The stream is over: a sender waiting for room stops waiting.
  pub fn close(&self) {
    self.credit.lock().unwrap_or_else(PoisonError::into_inner).closed = true;
    self.wake.notify_one();
  }
}

/// A stream's receiving side: the pieces it takes in, and the acknowledgements it owes for them.
#[derive(Default)]
pub struct ReceiveWindow {
  expected_seq: u64,
  /// Received and not yet acknowledged.
  held: u64,
  /// Handed on since the last acknowledgement.
  handed: u64,
}

impl ReceiveWindow {
  /// Take in one piece, in sequence and within the window, or name the fault that ends the stream.
  pub fn accept(&mut self, seq: u64, bytes: u64) -> Result<(), String> {
    if seq != self.expected_seq {
      return Err(format!("expected stream piece {}, got {seq}", self.expected_seq));
    }
    if self.held + bytes > STREAM_WINDOW_BYTES {
      return Err(format!("the sender went past the {STREAM_WINDOW_BYTES}-byte window"));
    }
    self.expected_seq += 1;
    self.held += bytes;
    Ok(())
  }

  /// Note `bytes` handed on to this side's own end; the count to acknowledge once a batch is due.
  pub fn handed_on(&mut self, bytes: u64) -> Option<u64> {
    self.handed += bytes;
    if self.handed < STREAM_ACK_BYTES {
      return None;
    }
    let acknowledged = std::mem::take(&mut self.handed);
    self.held = self.held.saturating_sub(acknowledged);
    Some(acknowledged)
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[tokio::test]
  async fn a_sender_takes_what_the_window_holds_and_waits_for_an_ack() {
    let window = SendWindow::default();
    assert_eq!(window.take(usize::MAX).await, Some(STREAM_WINDOW_BYTES as usize));
    let waiting = tokio::time::timeout(std::time::Duration::from_millis(20), window.take(10));
    assert!(waiting.await.is_err(), "a full window holds the sender");
    window.grant(4);
    assert_eq!(window.take(10).await, Some(4));
    window.close();
    assert_eq!(window.take(10).await, None);
  }

  #[test]
  fn a_receiver_acknowledges_in_batches_and_refuses_a_gap_or_an_overrun() {
    let mut window = ReceiveWindow::default();
    window.accept(0, STREAM_ACK_BYTES - 1).expect("in sequence");
    assert_eq!(window.handed_on(STREAM_ACK_BYTES - 1), None);
    window.accept(1, 1).expect("in sequence");
    assert_eq!(window.handed_on(1), Some(STREAM_ACK_BYTES));
    assert!(window.accept(3, 1).is_err(), "a gap is a fault");
    window.accept(2, STREAM_WINDOW_BYTES).expect("the whole window");
    assert!(window.accept(3, 1).is_err(), "past the window is a fault");
  }
}
