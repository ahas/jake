// The server agents dial: the secret checked at the upgrade, then one socket per agent fed to the core.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{
  CloseFrame, Message, WebSocket, WebSocketUpgrade, rejection::WebSocketUpgradeRejection,
};
use axum::extract::{ConnectInfo, State};
use axum::http::HeaderMap;
use axum::http::header::{AUTHORIZATION, UPGRADE};
use axum::response::Response;
use futures_util::stream::SplitSink;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;

use crate::control::json;
use crate::core::Hub;
use crate::link::{Link, Outbound};

/// How long a socket the hub closed may wait for the agent's answering close before it is dropped.
const CLOSE_GRACE: Duration = Duration::from_secs(5);

// Where an agent's attempt came from: the address the proxy in front forwarded, else the peer's own.
fn peer_of(headers: &HeaderMap, address: SocketAddr) -> String {
  let header = |name: &str| headers.get(name).and_then(|value| value.to_str().ok()).map(str::to_owned);
  let forwarded = header("x-real-ip").or_else(|| {
    header("x-forwarded-for").and_then(|list| list.split(',').next().map(|first| first.trim().to_owned()))
  });
  forwarded.filter(|peer| !peer.is_empty()).unwrap_or_else(|| address.ip().to_string())
}

/// Every request to the agent server: refused without the secret, upgraded with it.
pub async fn entry(
  State(hub): State<Arc<Hub>>,
  ConnectInfo(address): ConnectInfo<SocketAddr>,
  headers: HeaderMap,
  upgrade: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
) -> Response {
  let credential = headers.get(AUTHORIZATION).map(|value| value.as_bytes());
  let Some(only) = hub.authorize_agent(credential) else {
    // Only an upgrade is an agent's attempt; the line says whether a credential came, never what it was.
    let is_upgrade = headers
      .get(UPGRADE)
      .is_some_and(|value| value.as_bytes().eq_ignore_ascii_case(b"websocket"));
    if is_upgrade {
      let what = if credential.is_none() { "no credential" } else { "a wrong credential" };
      eprintln!("jake hub: refused an agent connection from {} ({what})", peer_of(&headers, address));
    }
    return json(401, &serde_json::json!({ "error": "unauthorized" }));
  };
  let Ok(upgrade) = upgrade else {
    return json(426, &serde_json::json!({ "error": "expected a WebSocket upgrade" }));
  };
  // A frame carries at most one payload at the cap, grown by a third in base64, plus its envelope.
  let frame_limit = hub.max_payload_bytes() / 3 * 4 + 1024 * 1024;
  let socket_id = hub.next_socket_id();
  upgrade
    .max_message_size(frame_limit)
    .max_frame_size(frame_limit)
    .on_upgrade(move |socket| serve(hub, socket, socket_id, only))
}

async fn serve(hub: Arc<Hub>, socket: WebSocket, socket_id: u64, only: Option<String>) {
  let (sink, mut stream) = socket.split();
  let (link, queue) = Link::new(socket_id, hub.socket_backlog_bytes());
  let link = link.held_to(only);
  let writer = tokio::spawn(write(sink, queue, link.clone()));

  // Once the hub has closed this socket, the agent's answering close is waited for only so long.
  let closing = {
    let link = link.clone();
    async move {
      link.closed().await;
      tokio::time::sleep(CLOSE_GRACE).await;
    }
  };
  tokio::pin!(closing);

  loop {
    tokio::select! {
        message = stream.next() => match message {
            Some(Ok(Message::Text(text))) => hub.on_message(&link, text.as_str()),
            Some(Ok(Message::Binary(data))) => hub.on_message(&link, &String::from_utf8_lossy(&data)),
            Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
            Some(Ok(Message::Close(_)) | Err(_)) | None => break,
        },
        () = &mut closing => break,
    }
  }
  link.mark_closed();
  hub.on_close(&link);
  writer.abort();
}

// Put each queued frame on the wire in order, settling the link's backlog as it goes.
async fn write(
  mut sink: SplitSink<WebSocket, Message>,
  mut queue: mpsc::UnboundedReceiver<Outbound>,
  link: Link,
) {
  while let Some(outbound) = queue.recv().await {
    match outbound {
      Outbound::Text(text) => {
        let size = text.len();
        let written = sink.send(Message::Text(text.into())).await;
        link.wrote(size);
        if written.is_err() {
          break;
        }
      }
      Outbound::Close(code, reason) => {
        let _ = sink
          .send(Message::Close(Some(CloseFrame {
            code,
            reason: reason.into(),
          })))
          .await;
        break;
      }
    }
  }
  link.mark_closed();
}
