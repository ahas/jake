// The `up` verb: asks the running hub once whether both its ports answer as the hub does.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::time::Duration;

use bytes::Bytes;
use http_body_util::Empty;
use hyper::header::{AUTHORIZATION, HOST};
use hyper::{Request, StatusCode};
use hyper_util::rt::TokioIo;
use tokio::net::TcpStream;

use crate::config;

/// How long either port is waited on before its ask counts as unanswered.
const ASK_TIMEOUT: Duration = Duration::from_secs(10);

/// What the agent server answers a request carrying no credential.
const AGENT_ANSWER: StatusCode = StatusCode::UNAUTHORIZED;

/// What the control API's status answers the control credential.
const CONTROL_ANSWER: StatusCode = StatusCode::OK;

/// Ask both ports and say what each answered: 0 where both answered as the hub does, 1 otherwise.
pub async fn run() -> u8 {
  let config = match config::load_up() {
    Ok(config) => config,
    Err(message) => {
      eprintln!("jake-hub up: {message}");
      return 1;
    }
  };
  let agent_host = reachable(&config.host);
  let control_host = Ipv4Addr::LOCALHOST.to_string();
  let credential = format!("Bearer {}", config.control.credential);
  let (agent, control) = tokio::join!(
    ask(&agent_host, config.port, "/", None),
    ask(&control_host, config.control.port, "/status", Some(&credential)),
  );
  let account = format!(
    "agent server on {} {}, control API on {} {}",
    authority(&agent_host, config.port),
    said(&agent),
    authority(&control_host, config.control.port),
    said(&control),
  );
  if agent == Ok(AGENT_ANSWER) && control == Ok(CONTROL_ANSWER) {
    println!("jake-hub up: {account}");
    0
  } else {
    eprintln!("jake-hub up: not up: {account}");
    1
  }
}

// The address a client reaches a server bound to `host` at: the loopback address of its family where the
// server binds every address.
fn reachable(host: &str) -> String {
  match host.parse::<IpAddr>() {
    Ok(IpAddr::V4(address)) if address.is_unspecified() => Ipv4Addr::LOCALHOST.to_string(),
    Ok(IpAddr::V6(address)) if address.is_unspecified() => Ipv6Addr::LOCALHOST.to_string(),
    _ => host.to_owned(),
  }
}

fn authority(host: &str, port: u16) -> String {
  if host.contains(':') { format!("[{host}]:{port}") } else { format!("{host}:{port}") }
}

fn said(answer: &Result<StatusCode, String>) -> String {
  match answer {
    Ok(status) => format!("answered {}", status.as_u16()),
    Err(reason) => reason.clone(),
  }
}

async fn ask(host: &str, port: u16, path: &str, authorization: Option<&str>) -> Result<StatusCode, String> {
  tokio::time::timeout(ASK_TIMEOUT, send(host, port, path, authorization))
    .await
    .unwrap_or_else(|_| Err(format!("gave no answer within {} seconds", ASK_TIMEOUT.as_secs())))
}

// One GET over a connection of its own, answered by its status alone.
async fn send(
  host: &str,
  port: u16,
  path: &str,
  authorization: Option<&str>,
) -> Result<StatusCode, String> {
  let stream = TcpStream::connect((host, port))
    .await
    .map_err(|error| format!("could not be reached: {error}"))?;
  let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
    .await
    .map_err(|error| format!("could not be spoken to: {error}"))?;
  tokio::spawn(connection);
  let mut request = Request::get(path).header(HOST, authority(host, port));
  if let Some(authorization) = authorization {
    request = request.header(AUTHORIZATION, authorization);
  }
  let request = request
    .body(Empty::<Bytes>::new())
    .map_err(|_| "the control credential cannot be sent as a header".to_owned())?;
  sender
    .send_request(request)
    .await
    .map(|response| response.status())
    .map_err(|error| format!("gave no answer: {error}"))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn a_server_bound_to_every_address_is_reached_on_the_loopback_of_its_family() {
    assert_eq!(reachable("0.0.0.0"), "127.0.0.1");
    assert_eq!(reachable("::"), "::1");
    assert_eq!(reachable("192.0.2.84"), "192.0.2.84");
    assert_eq!(authority("::1", 8790), "[::1]:8790");
    assert_eq!(authority("127.0.0.1", 8790), "127.0.0.1:8790");
  }
}
