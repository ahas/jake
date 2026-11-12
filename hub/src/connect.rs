// The connect run mode: a byte stream to a port on an agent's machine, joined to standard input and output.

use futures_util::{SinkExt as _, StreamExt as _};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio_tungstenite::tungstenite::client::IntoClientRequest as _;
use tokio_tungstenite::tungstenite::http::header::AUTHORIZATION;
use tokio_tungstenite::tungstenite::http::{HeaderValue, Response};
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};

use crate::config;
use crate::protocol::STREAM_CHUNK_BYTES;

/// The port a stream reaches when none is named: SSH's.
pub const SSH_PORT: u16 = 22;

// What the hub said when it refused the stream before opening it.
fn refusal(response: &Response<Option<Vec<u8>>>) -> String {
  let said = response
    .body()
    .as_deref()
    .and_then(|body| serde_json::from_slice::<serde_json::Value>(body).ok())
    .and_then(|body| body.get("error").and_then(|error| error.as_str()).map(str::to_owned))
    .unwrap_or_else(|| "no reason given".to_owned());
  format!("the hub refused the stream (HTTP {}): {said}", response.status().as_u16())
}

/// Open a stream to the port on the agent's machine and carry it until either end closes; why it
/// ended, when that was a failure.
pub async fn run(agent: &str, port: u16) -> Result<(), String> {
  let control = config::load_control()?;
  let query = form_urlencoded::Serializer::new(String::new())
    .append_pair("agent", agent)
    .append_pair("port", &port.to_string())
    .finish();
  let mut request = format!("ws://127.0.0.1:{}/connect?{query}", control.port)
    .into_client_request()
    .map_err(|error| error.to_string())?;
  let credential = HeaderValue::from_str(&format!("Bearer {}", control.credential))
    .map_err(|_| "the control credential cannot be sent as a header".to_owned())?;
  request.headers_mut().insert(AUTHORIZATION, credential);
  let socket = match tokio_tungstenite::connect_async_with_config(request, None, true).await {
    Ok((socket, _)) => socket,
    Err(WsError::Http(response)) => return Err(refusal(&response)),
    Err(error) => return Err(format!("the hub's control API could not be reached: {error}")),
  };
  let (mut sink, mut source) = socket.split();

  let upstream = async {
    let mut stdin = tokio::io::stdin();
    let mut buffer = vec![0; STREAM_CHUNK_BYTES];
    while let Ok(read @ 1..) = stdin.read(&mut buffer).await {
      if sink.send(Message::Binary(buffer[..read].to_vec().into())).await.is_err() {
        return;
      }
    }
    let _ = sink.close().await;
  };
  let downstream = async {
    let mut stdout = tokio::io::stdout();
    while let Some(message) = source.next().await {
      match message {
        Ok(Message::Binary(data)) => {
          if stdout.write_all(&data).await.is_err() || stdout.flush().await.is_err() {
            return Ok(());
          }
        }
        Ok(Message::Close(Some(frame))) if frame.code != CloseCode::Normal => {
          return Err(frame.reason.to_string());
        }
        Ok(Message::Close(_)) => return Ok(()),
        Ok(_) => {}
        Err(error) => return Err(format!("the hub's connection failed: {error}")),
      }
    }
    Ok(())
  };
  tokio::select! {
    () = upstream => Ok(()),
    ended = downstream => ended,
  }
}
