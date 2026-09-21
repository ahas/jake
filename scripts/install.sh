#!/usr/bin/env bash
# Install the jake agent (a bmo agent proxy) for the current user on Linux or WSL.

set -euo pipefail

BASE="https://ai.example.org/bmo/jake"
DATA_DIR="$HOME/.local/share/jake"
BIN="$DATA_DIR/jake"
ENV_FILE="$DATA_DIR/agent.env"
UNIT_NAME="jake-agent.service"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT="$UNIT_DIR/$UNIT_NAME"

step() { printf '\033[36m· %s\033[0m\n' "$1"; }
ok()   { printf '\033[32m  %s\033[0m\n' "$1"; }
warn() { printf '\033[33m  ! %s\033[0m\n' "$1"; }
die()  { printf '\033[31mjake install failed: %s\033[0m\n' "$1" >&2; exit 1; }

usage() {
  cat <<EOF
Install the jake agent for the current user (Linux/WSL).

  curl -fsSL $BASE/install.sh | bash
  curl -fsSL $BASE/install.sh | bash -s -- --hub-url wss://jake.example.org --secret '<secret>' --agent-name '<name>'
  ./install.sh                 (from a build folder)

Options:
  --hub-url <url>       the hub to attach to, e.g. wss://jake.example.org
  --secret <secret>     the shared secret, matching the hub's JAKE_SECRET
  --agent-name <name>   this agent's name
  --non-interactive     never prompt; the three values above must be passed or already in agent.env
  -h, --help            show this help
EOF
}

# --- arguments -----------------------------------------------------------------------------------

HUB_URL=""
SECRET=""
AGENT_NAME=""
NON_INTERACTIVE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --hub-url) HUB_URL="${2:-}"; shift 2 ;;
    --hub-url=*) HUB_URL="${1#*=}"; shift ;;
    --secret) SECRET="${2:-}"; shift 2 ;;
    --secret=*) SECRET="${1#*=}"; shift ;;
    --agent-name) AGENT_NAME="${2:-}"; shift 2 ;;
    --agent-name=*) AGENT_NAME="${1#*=}"; shift ;;
    --non-interactive) NON_INTERACTIVE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

# --- host checks ---------------------------------------------------------------------------------

os="$(uname -s)"
[ "$os" = "Linux" ] || die "this installer runs on Linux, including WSL; detected $os. On Windows use install.ps1."

arch="$(uname -m)"
case "$arch" in
  x86_64|amd64) : ;;
  *) die "the Linux agent is built for x86_64; detected $arch, for which no binary is served." ;;
esac

# WSL is Linux only when systemd runs as its init. Without it there is no per-user service manager, so
# a unit would never run — fail loudly with the same reason the agent's own availability check gives.
if [ ! -d /run/systemd/system ]; then
  die "systemd is not running as this system's init, so \`systemctl --user\` cannot supervise the agent. On WSL, enable systemd (set \`[boot] systemd=true\` in /etc/wsl.conf, then run \`wsl.exe --shutdown\` from Windows) and try again."
fi

# --- payload: the build folder beside this script, or a download from the base -------------------

fetch() { # url dest
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$2" "$1"
  else
    die "need curl or wget to download from $BASE"
  fi
}

src_dir=""
if [ -n "${BASH_SOURCE:-}" ] && [ -f "${BASH_SOURCE[0]:-/nonexistent}" ]; then
  d="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  [ -f "$d/jake" ] && src_dir="$d"
fi

place_from_payload() { # relative-name dest  — from the build folder if present, else the base
  local name="$1" dest="$2"
  if [ -n "$src_dir" ] && [ -f "$src_dir/$name" ]; then
    cp "$src_dir/$name" "$dest"
  else
    fetch "$BASE/$name" "$dest"
  fi
}

echo "jake agent installer"

# --- resolve config values, offering an existing agent.env's value as the default ----------------

env_value() { # file key  → prints the value, or nothing
  local file="$1" key="$2" line t v
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    t="${line#"${line%%[![:space:]]*}"}"
    case "$t" in ''|'#'*) continue ;; esac
    case "$t" in "$key="*) : ;; *) continue ;; esac
    v="${t#*=}"
    v="${v#"${v%%[![:space:]]*}"}"
    v="${v%"${v##*[![:space:]]}"}"
    case "$v" in
      \"*\") v="${v#\"}"; v="${v%\"}" ;;
      \'*\') v="${v#\'}"; v="${v%\'}" ;;
    esac
    printf '%s' "$v"
    return 0
  done < "$file"
  return 0
}

resolve() { # current key prompt secret  → prints the resolved value
  local current="$1" key="$2" prompt="$3" secret="${4:-0}" def answer label
  if [ -n "$current" ]; then printf '%s' "$current"; return 0; fi
  def="$(env_value "$ENV_FILE" "$key")"
  if [ "$NON_INTERACTIVE" -eq 1 ] || [ ! -r /dev/tty ]; then
    if [ -n "$def" ]; then printf '%s' "$def"; return 0; fi
    die "$key was not provided and no terminal is available to prompt. Re-run with the three values, e.g. curl -fsSL $BASE/install.sh | bash -s -- --hub-url wss://jake.example.org --secret '<secret>' --agent-name '<name>'"
  fi
  if [ -n "$def" ]; then label="$prompt [Enter to keep the current one]: "; else label="$prompt: "; fi
  if [ "$secret" -eq 1 ]; then
    printf '%s' "$label" > /dev/tty
    read -rs answer < /dev/tty
    printf '\n' > /dev/tty
  else
    printf '%s' "$label" > /dev/tty
    read -r answer < /dev/tty
  fi
  if [ -n "$answer" ]; then printf '%s' "$answer"; return 0; fi
  if [ -n "$def" ]; then printf '%s' "$def"; return 0; fi
  die "$key is required."
}

HUB_URL="$(resolve "$HUB_URL" JAKE_HUB_URL 'Hub URL (e.g. wss://jake.example.org)' 0)"
SECRET="$(resolve "$SECRET" JAKE_SECRET 'Shared secret' 1)"
AGENT_NAME="$(resolve "$AGENT_NAME" JAKE_AGENT_NAME 'Agent name' 0)"

# --- stop any running unit so its binary can be replaced -----------------------------------------

step "stopping any running agent"
systemctl --user stop "$UNIT_NAME" 2>/dev/null || true

# --- place the binary ----------------------------------------------------------------------------
# The new binary is written beside the target and moved into place, so a still-open old inode never
# blocks the write. curl and cp do not carry an exec bit reliably, so it is set explicitly.

step "installing to $DATA_DIR"
mkdir -p "$DATA_DIR"
new_bin="$DATA_DIR/jake.new"
if [ -n "$src_dir" ]; then cp "$src_dir/jake" "$new_bin"; else fetch "$BASE/jake" "$new_bin"; fi
chmod +x "$new_bin"
mv -f "$new_bin" "$BIN"
ok "binary in place"

# --- write agent.env, preserving any hand-edited tuning keys -------------------------------------

set_env_key() { # file key value
  local file="$1" key="$2" value="$3" found=0 out line t
  out="$(mktemp)"
  while IFS= read -r line || [ -n "$line" ]; do
    t="${line#"${line%%[![:space:]]*}"}"
    if [ "$found" -eq 0 ] && [ "$t" != "${t#*=}" ] && [ "${t%%=*}" = "$key" ]; then
      printf '%s=%s\n' "$key" "$value" >> "$out"
      found=1
    else
      printf '%s\n' "$line" >> "$out"
    fi
  done < "$file"
  [ "$found" -eq 1 ] || printf '%s=%s\n' "$key" "$value" >> "$out"
  mv -f "$out" "$file"
}

step "writing agent.env"
tmp_env="$(mktemp)"
if [ -f "$ENV_FILE" ]; then
  cp "$ENV_FILE" "$tmp_env"
else
  printf '# jake agent configuration, written by the installer. The three required keys below are set;\n' > "$tmp_env"
  printf '# every other key falls back to its built-in default. See agent.env.example for the full list.\n' >> "$tmp_env"
fi
set_env_key "$tmp_env" JAKE_HUB_URL "$HUB_URL"
set_env_key "$tmp_env" JAKE_SECRET "$SECRET"
set_env_key "$tmp_env" JAKE_AGENT_NAME "$AGENT_NAME"
mv -f "$tmp_env" "$ENV_FILE"
chmod 600 "$ENV_FILE"
ok "config written (the secret stays on this machine only)"

# --- register the systemd user service and the uninstaller ---------------------------------------

step "registering the systemd user service"
mkdir -p "$UNIT_DIR"
place_from_payload "jake-agent.service" "$UNIT"
place_from_payload "uninstall.sh" "$DATA_DIR/uninstall.sh"
chmod +x "$DATA_DIR/uninstall.sh"

systemctl --user daemon-reload
if ! loginctl enable-linger "$(id -un)" 2>/dev/null; then
  warn "could not enable linger; the agent starts at login but may not at boot. Run: loginctl enable-linger $(id -un)"
fi
systemctl --user enable --now "$UNIT_NAME"
ok "service enabled and started"

# --- wait briefly for the agent to reach the hub, reading its own local log ----------------------

step "waiting for the agent to reach the hub"
reached=0
failure=""
for _ in $(seq 1 15); do
  sleep 1
  [ -f "$DATA_DIR/agent.log" ] || continue
  log_tail="$(tail -n 50 "$DATA_DIR/agent.log" 2>/dev/null || true)"
  case "$log_tail" in
    *'"event":"welcomed"'*) reached=1; break ;;
    *'"event":"rejected"'*) failure="the hub rejected the agent (check the shared secret and agent name)"; break ;;
    *'"event":"dial-failed"'*) failure="the agent could not reach the hub (check the hub URL and that the hub is running)" ;;
  esac
done

echo ""
if [ "$reached" -eq 1 ]; then
  ok "Installed. The agent is connected to the hub."
elif [ -n "$failure" ]; then
  warn "Installed, but the agent has not connected: $failure"
  warn "It keeps retrying. See: journalctl --user -u jake-agent -n 20, or $DATA_DIR/agent.log"
else
  warn "Installed. The agent has not reported a connection yet; it keeps retrying on its own."
  warn "See: journalctl --user -u jake-agent -n 20, or $DATA_DIR/agent.log"
fi
echo "To remove it later, run $DATA_DIR/uninstall.sh"
