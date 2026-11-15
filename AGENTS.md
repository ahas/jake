# AGENTS.md

## Checks

- The console is TypeScript run by bun. The agent is the Rust crate under `agent/`, the hub the one
  under `hub/`, and the wire protocol both speak the crate under `protocol/`, all members of the root
  workspace.
- The agent is built for Windows as well as Linux; `cargo-zigbuild clippy --offline -p jake-agent
  --target x86_64-pc-windows-gnu --all-targets -- -D warnings` checks its Windows half, which the
  Linux check does not compile.
- The desktop app is the crate under `desktop/`, a Cargo workspace of its own that reads the agent by
  path; `bun run check:desktop` is its check (clippy, rustfmt and its tests), run apart because it
  needs WebKitGTK 4.1 and its development files on Linux.
- `bun run check` is the whole check of the root workspace and the console: the TypeScript
  typecheck, clippy and rustfmt over the workspace, a release build of the hub CLI whose documented
  paths are then verified, its own Rust tests, then the bun suite.
- The agent's contract tests build the agent and start it as its own process against a stand-in hub,
  so they hold whatever the agent is written in to the tunnel it speaks.
- The hub's contract tests in the bun suite build the hub and start it as its own process, so they
  hold whatever the hub is written in to the control API and the tunnel the agent and BMO use.

## Comments

- A top-of-file comment is one concise line and does not go into detail.
