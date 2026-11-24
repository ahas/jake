#!/usr/bin/env bash
# Remove the jake agent for the current user (Linux/WSL) through its own executable's uninstall command.

set -euo pipefail

BIN="$HOME/.local/share/jake/jake"

case "${1:-}" in
  -h|--help)
    cat <<HELP
Remove the jake agent for the current user (Linux/WSL); it runs $BIN uninstall.

  ./uninstall.sh                  say which agent is installed, ask, then remove it; keep agent.env and the log
  ./uninstall.sh --name <agent>   remove it only where the install is that agent's; refuse otherwise
  ./uninstall.sh --yes            remove without asking
  ./uninstall.sh --remove-config  delete the whole per-user tree, leaving nothing behind
HELP
    exit 0 ;;
esac

if [ ! -x "$BIN" ]; then
  printf '\033[31mjake uninstall failed: no jake is installed at %s\033[0m\n' "$BIN" >&2
  exit 1
fi
exec "$BIN" uninstall "$@"
