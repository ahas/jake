// The jake hub: the main-host side of the tunnel, an agent server and a loopback control API.

mod agent_server;
mod config;
mod connect;
mod control;
mod core;
mod departed;
mod link;

use jake_protocol as protocol;

use std::net::SocketAddr;
use std::process::ExitCode;
use std::time::Duration;

use axum::Router;
use axum::serve::{Listener, ListenerExt, TapIo};
use tokio::net::{TcpListener, TcpStream};
use tokio::signal::unix::{SignalKind, signal};

use crate::core::{Hub, HubOptions};

/// How long a shutdown waits for the agents' sockets to carry their closing frames.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(1);

// A listener whose connections send each write at once: a frame or an event is a whole message, and
// holding it back for the peer's acknowledgement only adds a delayed-ACK wait to every exchange.
async fn bind(host: &str, port: u16) -> Result<TapIo<TcpListener, fn(&mut TcpStream)>, String> {
  let listener = TcpListener::bind((host, port))
    .await
    .map_err(|error| format!("jake hub: cannot listen on {host}:{port}: {error}"))?;
  Ok(listener.tap_io(send_at_once))
}

fn send_at_once(stream: &mut TcpStream) {
  let _ = stream.set_nodelay(true);
}

async fn run() -> Result<(), String> {
  let config = config::load()?;
  let hub = Hub::new(HubOptions {
    secret: config.secret,
    control_token: config.control_token.clone(),
    max_payload_bytes: config.max_payload_bytes,
    ping_interval: config.ping_interval,
    missed_pong_limit: config.missed_pong_limit,
    socket_backlog_bytes: config.socket_backlog_bytes,
    departed_path: Some(config.departed_path),
  });

  let agent_listener = bind(&config.host, config.port).await?;
  let control_listener = bind("127.0.0.1", config.control_port).await?;
  let agent_port = agent_listener.local_addr().map_err(|error| error.to_string())?.port();
  let control_port = control_listener.local_addr().map_err(|error| error.to_string())?.port();

  let agents = Router::new().fallback(agent_server::entry).with_state(hub.clone());
  let control = Router::new()
    .fallback(control::entry)
    .with_state(control::Control::new(hub.clone(), &config.control_token));
  tokio::spawn(async move {
    let _ = axum::serve(agent_listener, agents.into_make_service_with_connect_info::<SocketAddr>()).await;
  });
  tokio::spawn(async move {
    let _ = axum::serve(control_listener, control).await;
  });

  println!(
    "jake hub: agent server on {}:{agent_port}, control API on 127.0.0.1:{control_port}",
    config.host
  );

  let mut interrupt = signal(SignalKind::interrupt()).map_err(|error| error.to_string())?;
  let mut terminate = signal(SignalKind::terminate()).map_err(|error| error.to_string())?;
  tokio::select! {
      _ = interrupt.recv() => {}
      _ = terminate.recv() => {}
  }

  let links = hub.shutdown();
  let _ = tokio::time::timeout(SHUTDOWN_GRACE, async {
    for link in links {
      link.closed().await;
    }
  })
  .await;
  Ok(())
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
  let args: Vec<String> = std::env::args().skip(1).collect();
  if args.first().map(String::as_str) == Some(connect::MODE) {
    let code = match connect::run(&args[1..]).await {
      Ok(()) => 0,
      Err(message) => {
        eprintln!("jake-hub connect: {message}");
        1
      }
    };
    // A read of standard input cannot be cancelled, so the process ends here rather than waiting on
    // one at the runtime's shutdown.
    std::process::exit(code);
  }
  match run().await {
    Ok(()) => ExitCode::SUCCESS,
    Err(message) => {
      eprintln!("{message}");
      ExitCode::FAILURE
    }
  }
}
