// The jake agent as a library: the tunnel to the hub, served on the caller's own runtime.

mod command;
pub mod config;
mod connection;
pub mod console;
pub mod departure;
mod exec;
pub mod installed;
pub mod log;
pub mod pair;
pub mod platform;
mod stream;
mod transfer;

pub use config::AgentConfig;
pub use connection::{Agent, Ended, LeaveNotice, Link, WhenSuperseded, backoff};
pub use exec::{ExecRequest, Invocation, invocation};
pub use log::Log;

/// This build's version, announced in the hello; the build stamps it in through `JAKE_VERSION`.
pub const VERSION: &str = match option_env!("JAKE_VERSION") {
  Some(version) => version,
  None => env!("CARGO_PKG_VERSION"),
};

/// Serve the hub until `stop` resolves, the hub sends a leave, or the hub hands the agent's name to a
/// newer connection where the agent was told to give it up; the answer says which. Every command,
/// transfer and stream the agent carried has ended by the time it answers.
pub async fn run(agent: &Agent, stop: impl Future<Output = ()>) -> Ended {
  tokio::select! {
    ended = agent.run() => ended,
    () = stop => Ended::Stopped,
  }
}
