// A client of the running hub's loopback control API, for the executable's client verbs.

use bytes::Bytes;
use http_body_util::Full;
use hyper::body::Incoming;
use hyper::header::{AUTHORIZATION, CONTENT_TYPE, HOST};
use hyper::{Method, Request, Response};
use hyper_util::rt::TokioIo;
use serde_json::Value;
use tokio::net::TcpStream;

use crate::config;

pub struct ControlClient {
  port: u16,
  /// The `Bearer` header every request carries: the control token, or a scoped credential.
  authorization: String,
}

impl ControlClient {
  /// A client of the hub its own configuration names.
  pub fn load() -> Result<Self, String> {
    let control = config::load_control()?;
    Ok(Self {
      port: control.port,
      authorization: format!("Bearer {}", control.credential),
    })
  }

  /// Send one request with an optional JSON body, over a connection of its own; the response's body
  /// streams as the hub writes it.
  pub async fn request(
    &self,
    method: Method,
    target: &str,
    body: Option<&Value>,
  ) -> Result<Response<Incoming>, String> {
    let stream = TcpStream::connect(("127.0.0.1", self.port)).await.map_err(|error| {
      format!("the hub's control API on port {} could not be reached: {error}", self.port)
    })?;
    let _ = stream.set_nodelay(true);
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
      .await
      .map_err(|error| error.to_string())?;
    tokio::spawn(connection);
    let content = body.map(Value::to_string).unwrap_or_default();
    let request = Request::builder()
      .method(method)
      .uri(target)
      .header(HOST, format!("127.0.0.1:{}", self.port))
      .header(AUTHORIZATION, &self.authorization)
      .header(CONTENT_TYPE, "application/json")
      .body(Full::new(Bytes::from(content)))
      .map_err(|_| "the control credential cannot be sent as a header".to_owned())?;
    sender.send_request(request).await.map_err(|error| error.to_string())
  }
}
