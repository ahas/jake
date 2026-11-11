// The loopback control API the console and 비모 drive the hub through, and its read-only page.

use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use axum::body::{Body, to_bytes};
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{FromRequestParts as _, Request, State};
use axum::http::header::{AUTHORIZATION, CACHE_CONTROL, CONNECTION, CONTENT_TYPE};
use axum::http::{Method, StatusCode};
use axum::response::Response;
use bytes::Bytes;
use futures_util::stream::{self, BoxStream, SplitSink};
use futures_util::{SinkExt as _, StreamExt};
use serde::Serialize;
use serde_json::{Map, Value, json};
use tokio::time::{Instant, interval_at};
use tokio_stream::wrappers::{BroadcastStream, UnboundedReceiverStream};

use crate::config::leading_int;
use crate::core::{
  Event, Events, ExecParams, Hub, ListenOutcome, ListenRefusal, Refusal, StreamEvent, UploadParams,
};
use crate::protocol::{checksum, is_shell_kind, shell_kinds};

/// A stream sends nothing between events, so a comment holds the connection open through a quiet stretch.
const KEEP_ALIVE: Duration = Duration::from_secs(15);
const PAGE: &str = include_str!("page.html");
const PAGE_TOKEN: &str = "\"__JAKE_CONTROL_TOKEN__\"";

pub struct Control {
  hub: Arc<Hub>,
  page: String,
}

impl Control {
  /// The control API over a hub, with the page's token embedded once.
  pub fn new(hub: Arc<Hub>, control_token: &str) -> Arc<Self> {
    let token = serde_json::to_string(control_token).unwrap_or_default();
    Arc::new(Self {
      hub,
      page: PAGE.replacen(PAGE_TOKEN, &token, 1),
    })
  }
}

pub fn json(status: u16, body: &impl Serialize) -> Response {
  let text = serde_json::to_string(body).unwrap_or_default();
  let mut response = Response::new(Body::from(text));
  *response.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
  response
    .headers_mut()
    .insert(CONTENT_TYPE, "application/json".parse().expect("static header"));
  response
}

fn error(status: u16, message: &str) -> Response {
  json(status, &json!({ "error": message }))
}

fn refusal(refused: &Refusal) -> Response {
  json(refused.kind.status(), &json!({ "error": refused.reason, "code": refused.kind.code() }))
}

fn sse_frame(event: &str, data: &impl Serialize, id: Option<u64>) -> Bytes {
  let head = id.map(|id| format!("id: {id}\n")).unwrap_or_default();
  let data = serde_json::to_string(data).unwrap_or_default();
  Bytes::from(format!("{head}event: {event}\ndata: {data}\n\n"))
}

fn event_frame(event: Event) -> Bytes {
  sse_frame(event.kind, &event.data, None)
}

// An SSE response over a stream of frames, with a keep-alive comment between them; it ends when the
// frames do.
fn sse(frames: BoxStream<'static, Bytes>) -> Response {
  let ticks = interval_at(Instant::now() + KEEP_ALIVE, KEEP_ALIVE);
  let body = stream::unfold((frames, ticks), |(mut frames, mut ticks)| async move {
    tokio::select! {
        frame = frames.next() => frame.map(|frame| (Ok::<_, Infallible>(frame), (frames, ticks))),
        _ = ticks.tick() => Some((Ok(Bytes::from_static(b": ping\n\n")), (frames, ticks))),
    }
  });
  let mut response = Response::new(Body::from_stream(body));
  let headers = response.headers_mut();
  headers.insert(CONTENT_TYPE, "text/event-stream".parse().expect("static header"));
  headers.insert(CACHE_CONTROL, "no-cache".parse().expect("static header"));
  headers.insert(CONNECTION, "keep-alive".parse().expect("static header"));
  response
}

// The stream of a command or transfer the hub started, or the one line saying why it could not.
fn started_stream(started: Result<Events, String>) -> Response {
  match started {
    Ok(events) => sse(UnboundedReceiverStream::new(events).map(event_frame).boxed()),
    Err(reason) => sse(stream::iter([sse_frame("ended", &json!({ "reason": reason }), None)]).boxed()),
  }
}

struct Query(Vec<(String, String)>);

impl Query {
  fn of(request: &Request) -> Self {
    Self(
      form_urlencoded::parse(request.uri().query().unwrap_or("").as_bytes())
        .into_owned()
        .collect(),
    )
  }

  fn get(&self, name: &str) -> Option<&str> {
    self.0.iter().find(|(key, _)| key == name).map(|(_, value)| value.as_str())
  }

  /// The agent a request names, or none.
  fn agent(&self) -> Option<&str> {
    self.get("agent").filter(|name| !name.is_empty())
  }
}

async fn body_json(body: Body) -> Value {
  match to_bytes(body, usize::MAX).await {
    Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    Err(_) => Value::Null,
  }
}

fn parse_exec(body: &Value) -> Result<ExecParams, String> {
  let empty = Map::new();
  let fields = match body {
    Value::Object(fields) => fields,
    Value::Array(_) => &empty,
    _ => return Err("body must be an object".into()),
  };
  let shell = match fields.get("shell") {
    Some(Value::String(shell)) if is_shell_kind(shell) => shell.clone(),
    _ => return Err(format!("shell must be one of {}", shell_kinds())),
  };
  let Some(Value::String(command)) = fields.get("command") else {
    return Err("command must be a string".into());
  };
  let cwd = match fields.get("cwd") {
    None | Some(Value::Null) => None,
    Some(Value::String(cwd)) => Some(cwd.clone()),
    Some(_) => return Err("cwd must be a string or null".into()),
  };
  let mut env = Map::new();
  match fields.get("env") {
    None | Some(Value::Null) => {}
    Some(Value::Object(given)) => {
      for (key, value) in given {
        let Value::String(value) = value else {
          return Err(format!("env.{key} must be a string"));
        };
        env.insert(key.clone(), value.clone().into());
      }
    }
    Some(_) => return Err("env must be a string map".into()),
  }
  let distro = match fields.get("distro") {
    None | Some(Value::Null) => None,
    Some(Value::String(distro)) => Some(distro.clone()),
    Some(_) => return Err("distro must be a string or null".into()),
  };
  Ok(ExecParams {
    shell,
    command: command.clone(),
    cwd,
    env,
    distro,
  })
}

fn is_checksum(value: &str) -> bool {
  value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// An upload's body as the pump reads it.
type UploadBody = BoxStream<'static, Result<Bytes, String>>;

// What an upload carries: a body declared by `total` and `checksum` streams through unread; one
// declaring neither is read whole first, so the hub can learn both for the opening frame.
async fn upload_content(
  query: &Query,
  body: Body,
  path: String,
) -> Result<UploadParams<UploadBody>, String> {
  let (total, sum) = (query.get("total"), query.get("checksum"));
  if total.is_none() && sum.is_none() {
    let data = to_bytes(body, usize::MAX).await.map_err(|error| error.to_string())?;
    let (total, checksum) = (data.len() as u64, checksum(&data));
    return Ok(UploadParams {
      path,
      total,
      checksum,
      body: stream::iter([Ok(data)]).boxed(),
    });
  }
  const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;
  let total = total
    .filter(|total| !total.is_empty() && total.bytes().all(|byte| byte.is_ascii_digit()))
    .and_then(|total| total.parse::<u64>().ok())
    .filter(|total| *total <= MAX_SAFE_INTEGER)
    .ok_or("the total query parameter must be the body's byte length")?;
  let checksum = sum
    .filter(|sum| is_checksum(sum))
    .ok_or("the checksum query parameter must be the body's sha256 in lowercase hex")?
    .to_owned();
  let body = body.into_data_stream().map(|piece| piece.map_err(|error| error.to_string())).boxed();
  Ok(UploadParams {
    path,
    total,
    checksum,
    body,
  })
}

/// The close code a stream's caller receives when the stream failed rather than ended.
const CLOSE_STREAM_FAILED: u16 = 4000;
/// The longest reason a WebSocket close frame carries, in bytes.
const CLOSE_REASON_BYTES: usize = 123;

// Close a stream's WebSocket, saying why in as much of the reason as a close frame carries.
async fn close_stream(sink: &mut SplitSink<WebSocket, Message>, code: u16, reason: &str) {
  let mut cut = reason.len().min(CLOSE_REASON_BYTES);
  while !reason.is_char_boundary(cut) {
    cut -= 1;
  }
  let frame = CloseFrame {
    code,
    reason: reason[..cut].into(),
  };
  let _ = sink.send(Message::Close(Some(frame))).await;
}

// One caller's byte stream: its WebSocket's binary messages go to the port, the port's bytes come
// back as binary messages, each direction on its own so neither waits on the other, until either end
// closes. The close the caller receives says why when the agent's side ended it.
async fn carry_stream(hub: Arc<Hub>, socket: WebSocket, name: String, port: u16) {
  let (mut sink, mut source) = socket.split();
  let (end, mut events) = match hub.open_stream(&name, port) {
    Ok(opened) => opened,
    Err(reason) => return close_stream(&mut sink, CLOSE_STREAM_FAILED, &reason).await,
  };
  match events.recv().await {
    Some(StreamEvent::Opened) => {}
    Some(StreamEvent::Closed(reason) | StreamEvent::Failed(reason)) => {
      return close_stream(&mut sink, CLOSE_STREAM_FAILED, &reason).await;
    }
    Some(StreamEvent::Data(_)) | None => {
      return close_stream(&mut sink, CLOSE_STREAM_FAILED, "the stream ended before it opened").await;
    }
  }

  let upstream = async {
    let mut seq = 0;
    while let Some(Ok(message)) = source.next().await {
      let data = match message {
        Message::Binary(data) => data,
        Message::Text(text) => Bytes::from(text.as_str().to_owned()),
        Message::Close(_) => break,
        Message::Ping(_) | Message::Pong(_) => continue,
      };
      if !end.send(&mut seq, &data).await {
        break;
      }
    }
  };
  let downstream = async {
    while let Some(event) = events.recv().await {
      match event {
        StreamEvent::Data(data) => {
          let bytes = data.len() as u64;
          if sink.send(Message::Binary(data.into())).await.is_err() {
            return None;
          }
          end.delivered(bytes);
        }
        StreamEvent::Closed(reason) => return Some((1000, reason)),
        StreamEvent::Failed(reason) => return Some((CLOSE_STREAM_FAILED, reason)),
        StreamEvent::Opened => {}
      }
    }
    None
  };
  let ended = tokio::select! {
    () = upstream => None,
    ended = downstream => ended,
  };
  // The caller's end is dropped first, so an agent whose stream is still open is told it is over.
  drop(end);
  let ended = ended.or_else(|| {
    std::iter::from_fn(|| events.try_recv().ok()).find_map(|event| match event {
      StreamEvent::Closed(reason) => Some((1000, reason)),
      StreamEvent::Failed(reason) => Some((CLOSE_STREAM_FAILED, reason)),
      StreamEvent::Opened | StreamEvent::Data(_) => None,
    })
  });
  if let Some((code, reason)) = ended {
    close_stream(&mut sink, code, &reason).await;
  }
}

/// Every request to the control API.
pub async fn entry(State(control): State<Arc<Control>>, request: Request) -> Response {
  let method = request.method().clone();
  let path = request.uri().path().to_owned();

  // The page is the one route served without the token: a browser navigation cannot carry a
  // bearer header, and the server answers on loopback alone.
  if method == Method::GET && path == "/" {
    let mut response = Response::new(Body::from(control.page.clone()));
    response
      .headers_mut()
      .insert(CONTENT_TYPE, "text/html; charset=utf-8".parse().expect("static header"));
    return response;
  }
  let hub = &control.hub;
  if !hub.authorize_control(request.headers().get(AUTHORIZATION).map(|value| value.as_bytes())) {
    return error(401, "unauthorized");
  }
  let query = Query::of(&request);
  let (mut parts, body) = request.into_parts();

  match (method.clone(), path.as_str()) {
    (Method::GET, "/status") => json(200, &hub.status()),
    (Method::GET, "/events") => {
      let after = query.get("after").and_then(leading_int).unwrap_or(0).max(0) as u64;
      let (replay, live) = hub.tail(after);
      let run = sse_frame("run", &json!({ "run": hub.run_tag() }), None);
      let replay = replay.into_iter().map(|entry| sse_frame("traffic", &*entry, Some(entry.id)));
      let live = BroadcastStream::new(live).filter_map(|entry| async move {
        entry.ok().map(|entry| sse_frame("traffic", &*entry, Some(entry.id)))
      });
      sse(stream::iter(std::iter::once(run).chain(replay)).chain(live).boxed())
    }
    (Method::POST, "/exec") => {
      let params = match parse_exec(&body_json(body).await) {
        Ok(params) => params,
        Err(message) => return error(400, &message),
      };
      match hub.resolve_target(query.agent()) {
        Ok(name) => started_stream(hub.start_exec(params, Some(&name))),
        Err(refused) => refusal(&refused),
      }
    }
    (Method::POST, "/upload" | "/download") => {
      let Some(remote) = query.get("path").filter(|remote| !remote.is_empty()).map(str::to_owned) else {
        return error(400, "the path query parameter is required");
      };
      let name = match hub.resolve_target(query.agent()) {
        Ok(name) => name,
        Err(refused) => return refusal(&refused),
      };
      if path == "/download" {
        return started_stream(hub.start_download(remote, Some(&name)));
      }
      match upload_content(&query, body, remote).await {
        Ok(params) => started_stream(hub.start_upload(params, Some(&name))),
        Err(message) => error(400, &message),
      }
    }
    (Method::POST, "/cancel") => {
      let Some(id) = body_json(body).await.get("id").and_then(Value::as_str).map(str::to_owned) else {
        return error(400, "id must be a string");
      };
      match hub.cancel(&id) {
        Ok(()) => json(200, &json!({ "ok": true })),
        Err(reason) => json(409, &json!({ "ok": false, "reason": reason })),
      }
    }
    (Method::POST, "/leave") => match hub.resolve_target(query.agent()) {
      Err(refused) => json(
        refused.kind.status(),
        &json!({ "ok": false, "reason": refused.reason, "code": refused.kind.code() }),
      ),
      Ok(name) => match hub.leave(Some(&name)) {
        Ok(agent) => json(200, &json!({ "ok": true, "agent": agent })),
        Err(reason) => json(409, &json!({ "ok": false, "reason": reason })),
      },
    },
    (Method::POST | Method::DELETE, "/listen") => {
      let Some(name) = query.agent().filter(|name| !name.is_empty()).map(str::to_owned) else {
        return error(400, "the agent query parameter is required");
      };
      let Some(port) = query.get("port").and_then(|port| port.parse::<u16>().ok()).filter(|port| *port > 0)
      else {
        return error(400, "the port query parameter must be a port number");
      };
      if method == Method::DELETE {
        hub.unlisten(&name, port);
        return json(200, &json!({ "ok": true }));
      }
      let Some(target) = body_json(body).await.get("target").and_then(Value::as_str).map(str::to_owned)
      else {
        return error(400, "target must be a host:port string");
      };
      match hub.listen(&name, port, &target) {
        Ok(outcome) => json(200, &json!({ "ok": true, "standing": outcome == ListenOutcome::Standing })),
        Err(ListenRefusal::TargetNotAllowed) => json(
          403,
          &json!({ "error": format!("{target} is not among the hub's JAKE_REVERSE_TARGETS"), "code": "target-not-allowed" }),
        ),
        Err(ListenRefusal::PortNotOffered) => json(
          403,
          &json!({ "error": format!("agent {name} does not offer to listen on port {port}: its JAKE_LISTEN_PORTS must list it"), "code": "port-not-offered" }),
        ),
      }
    }
    (Method::GET, "/listens") => {
      let Some(name) = query.agent().filter(|name| !name.is_empty()) else {
        return error(400, "the agent query parameter is required");
      };
      json(200, &hub.listens(name))
    }
    (Method::GET, "/connect") => {
      let Some(port) = query.get("port").and_then(|port| port.parse::<u16>().ok()).filter(|port| *port > 0)
      else {
        return error(400, "the port query parameter must be a port number");
      };
      let name = match hub.resolve_target(query.agent()) {
        Ok(name) => name,
        Err(refused) => return refusal(&refused),
      };
      if !hub.offers_stream(&name, port) {
        let message = format!(
          "agent {name} does not offer port {port}: its JAKE_STREAM_PORTS must list the port, and an agent built before streams must be updated"
        );
        return json(403, &json!({ "error": message, "code": "port-not-offered" }));
      }
      let Ok(upgrade) = WebSocketUpgrade::from_request_parts(&mut parts, &()).await else {
        return error(426, "expected a WebSocket upgrade");
      };
      let hub = Arc::clone(hub);
      upgrade.on_upgrade(move |socket| carry_stream(hub, socket, name, port))
    }
    _ => error(404, "not found"),
  }
}
