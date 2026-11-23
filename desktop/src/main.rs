// The desktop apps, two products of one crate: the remote controller, a BMO server's console in a window with
// a built-in jake agent (docs/desktop.md), and, built with the `all-in-one` feature, the all-in-one app, the whole
// BMO set installed and run on this machine with its console in a window (docs/all-in-one.md).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
// The all-in-one build takes only part of the shared modules; what the remote controller alone calls stands unused
// there, and the remote controller's build holds every module to the lints in full.
#![cfg_attr(feature = "all-in-one", allow(dead_code))]

mod channel;
mod navigation;
mod settings;
mod sign_in;

#[cfg(feature = "all-in-one")]
mod all_in_one;
#[cfg(not(feature = "all-in-one"))]
mod awake;
#[cfg(not(feature = "all-in-one"))]
mod bridge;
#[cfg(not(feature = "all-in-one"))]
mod controller;
#[cfg(not(feature = "all-in-one"))]
mod follow;
#[cfg(not(feature = "all-in-one"))]
mod pairing;
#[cfg(not(feature = "all-in-one"))]
mod pause;
#[cfg(not(feature = "all-in-one"))]
mod remote;
#[cfg(not(feature = "all-in-one"))]
mod server;
#[cfg(not(feature = "all-in-one"))]
mod session;
#[cfg(not(feature = "all-in-one"))]
mod status;
#[cfg(not(feature = "all-in-one"))]
mod supervisor;
#[cfg(not(feature = "all-in-one"))]
mod vault;

fn main() {
  #[cfg(not(feature = "all-in-one"))]
  remote::main();
  #[cfg(feature = "all-in-one")]
  all_in_one::main();
}
