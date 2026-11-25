// The jake hub: the main-host side of the tunnel, an agent server and a loopback control API.

/// The hub's version: the one a deployment hands its build as `BMO_VERSION`, read off the git tags, else the
/// manifest's placeholder (bmo-chat's `docs/conventions.md`, 「Versions」).
const VERSION: &str = match option_env!("BMO_VERSION") {
  Some(version) => version,
  None => env!("CARGO_PKG_VERSION"),
};

mod agent_server;
mod config;
mod connect;
mod control;
mod control_client;
mod core;
mod credential;
mod exec;
mod link;
mod revoked;
mod timed_names;
mod up;
mod update;

use jake_protocol as protocol;

use std::net::SocketAddr;
use std::process::ExitCode;
use std::time::Duration;

use axum::Router;
use axum::serve::{Listener, ListenerExt, TapIo};
use clap::{Parser, Subcommand, value_parser};
use tokio::net::{TcpListener, TcpStream};
use tokio::signal::unix::{SignalKind, signal};

use crate::core::{Hub, HubOptions};
use crate::update::AgentBuild;

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
    agent_key: config.agent_key,
    control_token: config.control_token.clone(),
    control_key: config.control_key,
    max_payload_bytes: config.max_payload_bytes,
    ping_interval: config.ping_interval,
    missed_pong_limit: config.missed_pong_limit,
    socket_backlog_bytes: config.socket_backlog_bytes,
    departed_path: Some(config.departed_path),
    revoked_path: Some(config.revoked_path),
    reverse_targets: config.reverse_targets,
    agent_build: config.agent_update.and_then(|update| {
      match AgentBuild::read(&update.build_dir, &update.download_url) {
        Ok(build) => {
          eprintln!("jake hub: agents are ordered onto build {}", build.version);
          Some(build)
        }
        Err(error) => {
          eprintln!("jake hub: no agent build to order agents onto: {error}");
          None
        }
      }
    }),
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

/// The jake hub; given a verb, a client of the running hub instead.
#[derive(Parser)]
#[command(name = "jake-hub", version = VERSION)]
struct Cli {
  #[command(subcommand)]
  verb: Option<Verb>,
}

#[derive(Subcommand)]
enum Verb {
  /// Join standard input and output to a byte stream to a port on an agent's machine
  Connect {
    /// The agent whose machine the stream reaches
    agent: String,
    /// The port on that machine
    #[arg(default_value_t = connect::SSH_PORT, value_parser = value_parser!(u16).range(1..))]
    port: u16,
  },
  /// Run a command on an agent's machine, stream its output, and exit with its exit code
  Exec(exec::ExecArgs),
  /// Print a control credential that reaches the named agents alone, made with JAKE_CONTROL_KEY
  Credential {
    /// The agents the credential reaches
    #[arg(required = true)]
    agents: Vec<String>,
  },
  /// Ask the running hub once whether both its ports answer, and exit 0 only where they do
  Up,
  /// Print the agent names the running hub has revoked, one a line
  Revoked,
}

// A control credential for the named agents, from the hub's own control key.
fn scoped_credential(agents: &[String]) -> Result<String, String> {
  if let Some(name) = agents.iter().find(|name| name.is_empty() || name.contains(',')) {
    return Err(format!("{name:?} is not an agent name"));
  }
  Ok(credential::credential(&config::load_control_key()?, &agents.join(",")))
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
  match Cli::parse().verb {
    Some(Verb::Connect { agent, port }) => {
      let code = match connect::run(&agent, port).await {
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
    Some(Verb::Exec(args)) => ExitCode::from(exec::run(args).await as u8),
    Some(Verb::Credential { agents }) => match scoped_credential(&agents) {
      Ok(credential) => {
        println!("{credential}");
        ExitCode::SUCCESS
      }
      Err(message) => {
        eprintln!("jake-hub credential: {message}");
        ExitCode::FAILURE
      }
    },
    Some(Verb::Up) => ExitCode::from(up::run().await),
    Some(Verb::Revoked) => ExitCode::from(revoked::run().await),
    None => match run().await {
      Ok(()) => ExitCode::SUCCESS,
      Err(message) => {
        eprintln!("{message}");
        ExitCode::FAILURE
      }
    },
  }
}
