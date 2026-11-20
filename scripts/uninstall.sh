#!/usr/bin/env bash
# Remove the jake agent (a bmo agent proxy) and its systemd user service for the current user.

set -euo pipefail

DATA_DIR="$HOME/.local/share/jake"
BIN="$DATA_DIR/jake"
UNIT_NAME="jake-agent.service"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT="$UNIT_DIR/$UNIT_NAME"

step() { printf '\033[36m· %s\033[0m\n' "$1"; }
warn() { printf '\033[33m  ! %s\033[0m\n' "$1"; }
die()  { printf '\033[31mjake uninstall failed: %s\033[0m\n' "$1" >&2; exit 1; }

REMOVE_CONFIG=0
while [ $# -gt 0 ]; do
  case "$1" in
    --remove-config) REMOVE_CONFIG=1; shift ;;
    -h|--help)
      cat <<EOF
Remove the jake agent for the current user (Linux/WSL).

  ./uninstall.sh                  keep agent.env and the log for a later reinstall
  ./uninstall.sh --remove-config  delete the whole per-user tree, leaving nothing behind
EOF
      exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

echo "jake agent uninstaller"

# Disable and stop the unit so nothing restarts it, then remove it and have systemd forget it. Absence
# of the service is not an error — the point is that none remains afterwards.
step "stopping and disabling the user service"
systemctl --user disable --now "$UNIT_NAME" 2>/dev/null || true

# Tell the hub this agent is gone, so it is recorded as departed rather than shown as disconnected.
# The agent's unit is already stopped, so the notice's own hello displaces no live connection. A hub
# that cannot be reached does not stop the removal.
if [ -x "$BIN" ]; then
  step "telling the hub this agent has left"
  "$BIN" --leave || warn "the hub was not told; it will show this agent as disconnected"
fi

step "removing the unit"
rm -f "$UNIT"
systemctl --user daemon-reload 2>/dev/null || true

# On WSL, the Windows task the install registered to keep this distribution running goes too, with the
# hold's executable where the task needed one. It needs Windows interop, which a WSL shell has.
ps_quote() { # value → a PowerShell single-quoted literal
  printf "'%s'" "${1//\'/\'\'}"
}

windows_powershell() { # → the path of Windows PowerShell reached through interop, or nothing
  local path
  if path="$(command -v powershell.exe 2>/dev/null)"; then printf '%s' "$path"; return 0; fi
  path="$(wslpath -u 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' 2>/dev/null)" || return 0
  if [ -x "$path" ]; then printf '%s' "$path"; fi
}

wsl_task_name() { printf 'JakeWsl-%s' "$(printf '%s' "$1" | tr -c 'A-Za-z0-9.-' '-')"; }

remove_keep_alive() {
  local distribution="${WSL_DISTRO_NAME:-}" powershell name script encoded
  [ -n "$distribution" ] || return 0
  step "removing the Windows task that keeps $distribution running"
  powershell="$(windows_powershell)"
  if [ -z "$powershell" ]; then
    warn "Windows interop is not reachable from here, so the task $(wsl_task_name "$distribution") is left in Task Scheduler. Run the uninstall again from a WSL shell to remove it."
    return 0
  fi
  name="$(ps_quote "$(wsl_task_name "$distribution")")"
  script="\$name = $name
if (Get-ScheduledTask -TaskName \$name -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName \$name -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName \$name -Confirm:\$false
}
Remove-Item -LiteralPath (Join-Path \$env:LOCALAPPDATA ('Programs\\jake-wsl\\' + \$name)) -Recurse -Force -ErrorAction SilentlyContinue"
  encoded="$(printf '%s' "$script" | iconv -f UTF-8 -t UTF-16LE | base64 -w0)"
  "$powershell" -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand "$encoded" >/dev/null 2>&1 \
    || warn "the task $(wsl_task_name "$distribution") could not be removed; remove it in Task Scheduler"
}

remove_keep_alive

step "deleting the install layout"
if [ "$REMOVE_CONFIG" -eq 1 ]; then
  rm -rf "$DATA_DIR"
else
  # Keep agent.env and the log; drop only the binary and the uninstaller copy.
  rm -f "$BIN" "$DATA_DIR/jake.new" "$DATA_DIR/jake.previous" "$DATA_DIR/uninstall.sh"
fi

echo ""
if [ "$REMOVE_CONFIG" -eq 1 ]; then
  echo "Removed. Nothing is left behind."
else
  echo "Removed. Your config is kept at $DATA_DIR/agent.env and the log at $DATA_DIR/agent.log."
  echo "Pass --remove-config to delete those too."
fi
