# AGENTS.md

## Checks

- The agent and the console are TypeScript run by bun; the hub is the Rust crate under `hub/`, and
  the wire protocol it speaks is the crate under `protocol/`, both members of the root workspace.
- `agent/` holds the Rust agent while it is written; it is outside the workspace until it builds.
- `bun run check` is the whole check: the TypeScript typecheck, clippy and rustfmt over the
  workspace, its own Rust tests, then the bun suite.
- The agent's contract tests start the agent as its own process against a stand-in hub, so they
  hold whatever the agent is written in to the tunnel it speaks.
- The hub's contract tests in the bun suite build the hub and start it as its own process, so they
  hold whatever the hub is written in to the control API and the tunnel the agent and BMO use.

## Comments

- A top-of-file comment is one concise line and does not go into detail.
