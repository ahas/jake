# AGENTS.md

## Checks

- The agent and the console are TypeScript run by bun; the hub is the Rust crate under `hub/`.
- `bun run check` is the whole check: the TypeScript typecheck, clippy and rustfmt over the hub, the
  hub's own Rust tests, then the bun suite.
- The hub's contract tests in the bun suite build the hub and start it as its own process, so they
  hold whatever the hub is written in to the control API and the tunnel the agent and BMO use.

## Comments

- A top-of-file comment is one concise line and does not go into detail.
