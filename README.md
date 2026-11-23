**English** | [한국어](README.ko.md) | [日本語](README.ja.md) | [简体中文](README.zh-CN.md)

# jake

jake is a **bmo agent proxy**: the proxy through which BMO manages its owner's own remote machines. It
runs on one of the owner's machines — a Windows box or a Linux/WSL box — and dials outward to a hub on
main-host, so BMO can reach a machine BMO's own network cannot connect into. Over that one tunnel
BMO runs shell commands and moves files, in both directions. The hub holds the agents of any number
of machines at once, each known by its own agent name, and every command names the machine it goes
to.

- **Run modes** — PowerShell and WSL on a Windows host, and a Linux shell on a Linux or WSL host.
- **File transfer** — upload and download over the tunnel's own frames, so a file crosses the tunnel
  without scp.
- **One-line install** — from base `ai.example.org/bmo/jake/`:
  - Linux/WSL: `curl -fsSL https://ai.example.org/bmo/jake/install.sh | bash`
  - Windows: `powershell -c "irm https://ai.example.org/bmo/jake/install.ps1 | iex"`
- **Desktop app** — BMO's web console as an app of its own that carries the agent inside it, joined
  by approving it in the console rather than by a secret typed at install.

See docs/architecture.md for how the pieces fit, docs/protocol.md for the tunnel frames,
docs/install.md to install it, docs/desktop.md for the desktop app, docs/deploy.md to bring up the
hub, and docs/recipes.md for shell recipes.
