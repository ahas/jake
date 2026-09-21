# jake

jake is a **bmo agent proxy**: the proxy through which BMO manages 하스's own remote machines. It
runs on one of 하스's machines — a Windows box or a Linux/WSL box — and dials outward to a hub on
main-host, so BMO can reach a machine 비모's own network cannot connect into. Over that one tunnel
BMO runs shell commands and moves files, in both directions.

- **Run modes** — PowerShell and WSL on a Windows host, and a Linux shell on a Linux or WSL host.
- **File transfer** — upload and download over the tunnel's own frames, so a file crosses the tunnel
  without scp.
- **One-line install** — from base `ai.example.org/bmo/jake/`:
  - Linux/WSL: `curl -fsSL https://ai.example.org/bmo/jake/install.sh | bash`
  - Windows: `powershell -c "irm https://ai.example.org/bmo/jake/install.ps1 | iex"`

See docs/architecture.md for how the pieces fit, docs/protocol.md for the tunnel frames,
docs/install.md to install it, docs/deploy.md to bring up the hub, and docs/recipes.md for shell
recipes.
