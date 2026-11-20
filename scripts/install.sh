#!/usr/bin/env bash
# Install the jake agent (a bmo agent proxy) for the current user on Linux or WSL.

set -euo pipefail

BASE="https://ai.example.org/bmo/jake"
DATA_DIR="$HOME/.local/share/jake"
BIN="$DATA_DIR/jake"
PREVIOUS_BIN="$DATA_DIR/jake.previous"
ENV_FILE="$DATA_DIR/agent.env"
UNIT_NAME="jake-agent.service"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT="$UNIT_DIR/$UNIT_NAME"
DEFAULT_HUB_URL="wss://jake.example.org"

step() { printf '\033[36m· %s\033[0m\n' "$1"; }
ok()   { printf '\033[32m  %s\033[0m\n' "$1"; }
warn() { printf '\033[33m  ! %s\033[0m\n' "$1"; }
die()  { printf '\033[31mjake install failed: %s\033[0m\n' "$1" >&2; exit 1; }

usage() {
  cat <<EOF
Install the jake agent for the current user (Linux/WSL).

  curl -fsSL $BASE/install.sh | bash
  curl -fsSL $BASE/install.sh | bash -s -- --secret '<secret>' --agent-name '<name>'
  ./install.sh                 (from a build folder)

Options:
  --hub-url <url>       the hub to attach to (default: $DEFAULT_HUB_URL)
  --secret <secret>     the shared secret, matching the hub's JAKE_SECRET
  --agent-name <name>   this agent's name
  --stream-ports <list> the local ports a byte stream from the hub may reach, comma-separated, or
                        none (default: 22, this machine's sshd)
  --ssh-key <key>       a public key to add to ~/.ssh/authorized_keys, so ssh over the hub logs in
  --non-interactive     never prompt; the secret and name must be passed or already in agent.env
  --update              an unattended update: never prompt, and put the previous binary back where the
                        new one does not reach the hub
  --print-config        resolve the values, print the hub URL and agent name, and install nothing
  -h, --help            show this help
EOF
}

# --- arguments -----------------------------------------------------------------------------------

HUB_URL=""
SECRET=""
AGENT_NAME=""
STREAM_PORTS=""
SSH_KEY=""
NON_INTERACTIVE=0
UPDATE=0
PRINT_CONFIG=0
while [ $# -gt 0 ]; do
  case "$1" in
    --hub-url) HUB_URL="${2:-}"; shift 2 ;;
    --hub-url=*) HUB_URL="${1#*=}"; shift ;;
    --secret) SECRET="${2:-}"; shift 2 ;;
    --secret=*) SECRET="${1#*=}"; shift ;;
    --agent-name) AGENT_NAME="${2:-}"; shift 2 ;;
    --agent-name=*) AGENT_NAME="${1#*=}"; shift ;;
    --stream-ports) STREAM_PORTS="${2:-}"; shift 2 ;;
    --stream-ports=*) STREAM_PORTS="${1#*=}"; shift ;;
    --ssh-key) SSH_KEY="${2:-}"; shift 2 ;;
    --ssh-key=*) SSH_KEY="${1#*=}"; shift ;;
    --non-interactive) NON_INTERACTIVE=1; shift ;;
    --update) UPDATE=1; NON_INTERACTIVE=1; shift ;;
    --print-config) PRINT_CONFIG=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

if [ -n "$STREAM_PORTS" ] && ! [[ "$STREAM_PORTS" =~ ^(none|[0-9]{1,5}(,[0-9]{1,5})*)$ ]]; then
  die "--stream-ports takes port numbers separated by commas, or none (got $STREAM_PORTS)"
fi

# How long the agent is given to report reaching the hub: longer for an update, which puts the previous
# build back where the new one does not. JAKE_INSTALL_WAIT_SECONDS sets it outright.
if [ "$UPDATE" -eq 1 ]; then WAIT_SECONDS=30; else WAIT_SECONDS=15; fi
WAIT_SECONDS="${JAKE_INSTALL_WAIT_SECONDS:-$WAIT_SECONDS}"

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

resolve() { # current key prompt secret fallback  → prints the resolved value
  local current="$1" key="$2" prompt="$3" secret="${4:-0}" fallback="${5:-}" def answer label
  if [ -n "$current" ]; then printf '%s' "$current"; return 0; fi
  def="$(env_value "$ENV_FILE" "$key")"
  if [ "$NON_INTERACTIVE" -eq 1 ] || [ ! -r /dev/tty ]; then
    if [ -n "$def" ]; then printf '%s' "$def"; return 0; fi
    if [ -n "$fallback" ]; then printf '%s' "$fallback"; return 0; fi
    die "$key was not provided and no terminal is available to prompt. Re-run with the values, e.g. curl -fsSL $BASE/install.sh | bash -s -- --secret '<secret>' --agent-name '<name>'"
  fi
  if [ -n "$def" ]; then label="$prompt [Enter to keep the current one]: "
  elif [ -n "$fallback" ]; then label="$prompt [default: $fallback]: "
  else label="$prompt: "; fi
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
  if [ -n "$fallback" ]; then printf '%s' "$fallback"; return 0; fi
  die "$key is required."
}

HUB_URL="$(resolve "$HUB_URL" JAKE_HUB_URL 'Hub URL' 0 "$DEFAULT_HUB_URL")"
SECRET="$(resolve "$SECRET" JAKE_SECRET 'Shared secret' 1)"
AGENT_NAME="$(resolve "$AGENT_NAME" JAKE_AGENT_NAME 'Agent name' 0)"

if [ "$PRINT_CONFIG" -eq 1 ]; then
  printf 'JAKE_HUB_URL=%s\nJAKE_AGENT_NAME=%s\n' "$HUB_URL" "$AGENT_NAME"
  [ -z "$STREAM_PORTS" ] || printf 'JAKE_STREAM_PORTS=%s\n' "$STREAM_PORTS"
  exit 0
fi

# --- stage the payload while the agent still runs --------------------------------------------------
# Everything is fetched before the unit is stopped, so a failed download changes nothing. The new
# binary is written beside the target and later moved into place, so a still-open old inode never
# blocks the write. curl and cp do not carry an exec bit reliably, so it is set explicitly.

step "installing to $DATA_DIR"
mkdir -p "$DATA_DIR"
stage="$(mktemp -d)"
new_bin="$DATA_DIR/jake.new"
unit_stopped=0

# Once the unit is stopped, an install that ends early still leaves a binary in place and the unit
# started again: the previous binary is put back where none is left.
finish() {
  local code=$?
  [ -z "$stage" ] || rm -rf "$stage"
  if [ "$unit_stopped" -eq 1 ]; then
    warn "the install ended before it started the agent again, so it starts the agent now"
    if [ ! -f "$BIN" ] && [ -f "$PREVIOUS_BIN" ]; then
      cp -f "$PREVIOUS_BIN" "$BIN" && chmod +x "$BIN" || warn "no binary could be put in place"
    fi
    systemctl --user daemon-reload 2>/dev/null || true
    systemctl --user start "$UNIT_NAME" || warn "the agent could not be started"
  fi
  exit "$code"
}
trap finish EXIT

if [ -n "$src_dir" ]; then cp "$src_dir/jake" "$new_bin"; else fetch "$BASE/jake" "$new_bin"; fi
chmod +x "$new_bin"
place_from_payload "jake-agent.service" "$stage/jake-agent.service"
place_from_payload "uninstall.sh" "$stage/uninstall.sh"
if [ "$UPDATE" -eq 1 ] && [ -f "$BIN" ]; then
  cp -f "$BIN" "$PREVIOUS_BIN"
fi

# --- stop any running unit and put the binary in place ----------------------------------------------

step "stopping any running agent"
unit_stopped=1
systemctl --user stop "$UNIT_NAME" 2>/dev/null || true
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
[ -z "$STREAM_PORTS" ] || set_env_key "$tmp_env" JAKE_STREAM_PORTS "$STREAM_PORTS"
mv -f "$tmp_env" "$ENV_FILE"
chmod 600 "$ENV_FILE"
ok "config written (the secret stays on this machine only)"

# --- the SSH side of a byte stream: the key it logs in with, and an sshd to answer -----------------

if [ -n "$SSH_KEY" ]; then
  step "adding the SSH key to ~/.ssh/authorized_keys"
  mkdir -p "$HOME/.ssh"
  chmod 700 "$HOME/.ssh"
  touch "$HOME/.ssh/authorized_keys"
  chmod 600 "$HOME/.ssh/authorized_keys"
  if grep -qxF -- "$SSH_KEY" "$HOME/.ssh/authorized_keys"; then
    ok "the key was already there"
  else
    printf '%s\n' "$SSH_KEY" >> "$HOME/.ssh/authorized_keys"
    ok "key added"
  fi
fi

ports="$(env_value "$ENV_FILE" JAKE_STREAM_PORTS)"
ports="${ports:-22}"
if [ "$ports" != "none" ]; then
  for port in ${ports//,/ }; do
    if ! (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
      warn "nothing answers on port $port here, so a stream to it will fail. For ssh, install and start an sshd (on Debian or Ubuntu: sudo apt install openssh-server && sudo systemctl enable --now ssh)."
    fi
  done
fi

# --- register the systemd user service and the uninstaller ---------------------------------------

step "registering the systemd user service"
mkdir -p "$UNIT_DIR"
cp "$stage/jake-agent.service" "$UNIT"
cp "$stage/uninstall.sh" "$DATA_DIR/uninstall.sh"
chmod +x "$DATA_DIR/uninstall.sh"

systemctl --user daemon-reload
if ! loginctl enable-linger "$(id -un)" 2>/dev/null; then
  warn "could not enable linger; the agent starts at login but may not at boot. Run: loginctl enable-linger $(id -un)"
fi
log_file="$DATA_DIR/agent.log"

# The size of the agent's log now, so a wait reads only what the log gains after it.
log_size() { if [ -f "$log_file" ]; then wc -c < "$log_file"; else echo 0; fi; }

# Read what the log gained since the mark for up to WAIT_SECONDS: sets reached, or failure with why not.
wait_for_hub() { # mark
  local mark="$1" log_tail elapsed=0
  reached=0
  failure=""
  while :; do
    if [ -f "$log_file" ]; then
      [ "$(wc -c < "$log_file")" -ge "$mark" ] || mark=0
      log_tail="$(tail -c +"$((mark + 1))" "$log_file" 2>/dev/null || true)"
      case "$log_tail" in
        *'"event":"welcomed"'*) reached=1; return 0 ;;
        *'"event":"rejected"'*) failure="the hub rejected the agent (the shared secret or the agent name is wrong)"; return 0 ;;
        *'"event":"dial-failed"'*) failure="the agent could not reach the hub (check the hub URL and that the hub is running)" ;;
      esac
    fi
    [ "$elapsed" -lt "$WAIT_SECONDS" ] || return 0
    sleep 1
    elapsed=$((elapsed + 1))
  done
}

log_mark="$(log_size)"
systemctl --user enable --now "$UNIT_NAME"
unit_stopped=0
ok "service enabled and started"

# --- wait briefly for the agent to reach the hub ---------------------------------------------------

step "waiting for the agent to reach the hub"
wait_for_hub "$log_mark"

# An update must leave the machine attached: a new build that does not reach the hub gives way to the
# previous one, and the update fails.
if [ "$UPDATE" -eq 1 ] && [ -f "$PREVIOUS_BIN" ]; then
  if [ "$reached" -eq 1 ]; then
    rm -f "$PREVIOUS_BIN"
  else
    warn "the new build did not reach the hub${failure:+: $failure}"
    step "putting the previous build back"
    unit_stopped=1
    systemctl --user stop "$UNIT_NAME" 2>/dev/null || true
    mv -f "$PREVIOUS_BIN" "$BIN" || die "the update did not take, and the previous build could not be put back"
    log_mark="$(log_size)"
    systemctl --user start "$UNIT_NAME"
    unit_stopped=0
    wait_for_hub "$log_mark"
    if [ "$reached" -eq 1 ]; then
      die "the update did not take; the previous build is back and connected to the hub."
    fi
    die "the update did not take; the previous build is back but has not connected yet${failure:+: $failure}."
  fi
fi

# --- WSL: a Windows task that keeps this distribution running -------------------------------------
# WSL stops a distribution once no Windows process holds a session into it, and its systemd services,
# the agent among them, stop with it. So the install registers a per-user scheduled task on the Windows
# side that holds a windowless session open: from boot, whether or not the user is logged on and with
# no password stored (S4U), where Windows lets this account register that, and otherwise from logon
# through the Windows jake executable's windowless hold. It needs Windows interop, which a WSL shell
# has and the systemd service an unattended update runs in does not; without it the task is left as
# it is.

ps_quote() { # value → a PowerShell single-quoted literal
  printf "'%s'" "${1//\'/\'\'}"
}

windows_powershell() { # → the path of Windows PowerShell reached through interop, or nothing
  local path
  if path="$(command -v powershell.exe 2>/dev/null)"; then printf '%s' "$path"; return 0; fi
  path="$(wslpath -u 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' 2>/dev/null)" || return 0
  if [ -x "$path" ]; then printf '%s' "$path"; fi
}

run_powershell() { # powershell script → what the script printed, line ends made plain
  local encoded
  encoded="$(printf '%s' "$2" | iconv -f UTF-8 -t UTF-16LE | base64 -w0)"
  "$1" -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand "$encoded" 2>&1 | tr -d '\r'
}

# The task's name for one distribution: its name with anything but letters, digits, dots and dashes
# made a dash. The hold's executable, where one is needed, has a folder of the same name.
wsl_task_name() { printf 'JakeWsl-%s' "$(printf '%s' "$1" | tr -c 'A-Za-z0-9.-' '-')"; }

keep_alive_script() { # distribution → the script that registers and starts the task, printing the road
  local distribution="$1"
  cat <<SCRIPT
\$ErrorActionPreference = 'Stop'
\$name = $(ps_quote "$(wsl_task_name "$distribution")")
\$distribution = $(ps_quote "$distribution")
\$launcher = Join-Path \$env:LOCALAPPDATA ('Programs\\jake-wsl\\' + \$name + '\\jake.exe')
\$user = "\$env:USERDOMAIN\\\$env:USERNAME"
\$triggers = @(
  (New-ScheduledTaskTrigger -AtLogOn -User \$user),
  (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5))
)
\$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
try {
  \$action = New-ScheduledTaskAction -Execute 'wsl.exe' -Argument ('-d "' + \$distribution + '" --exec sleep infinity')
  \$principal = New-ScheduledTaskPrincipal -UserId \$user -LogonType S4U -RunLevel Limited
  Register-ScheduledTask -TaskName \$name -Action \$action -Trigger \$triggers -Settings \$settings -Principal \$principal -Force | Out-Null
  \$road = 'unattended'
} catch {
  \$refusal = \$_.Exception.Message
  if (-not (Test-Path -LiteralPath \$launcher)) { "needs-launcher \$launcher"; exit 0 }
  \$action = New-ScheduledTaskAction -Execute \$launcher -Argument ('--hold-wsl "' + \$distribution + '"')
  \$principal = New-ScheduledTaskPrincipal -UserId \$user -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName \$name -Action \$action -Trigger \$triggers -Settings \$settings -Principal \$principal -Force | Out-Null
  \$road = 'at-logon ' + \$refusal
}
Start-ScheduledTask -TaskName \$name -ErrorAction SilentlyContinue
\$road
SCRIPT
}

keep_distribution_running() {
  local distribution="${WSL_DISTRO_NAME:-}" powershell answer launcher
  [ -n "$distribution" ] || return 0
  step "registering the Windows task that keeps $distribution running"
  powershell="$(windows_powershell)"
  if [ -z "$powershell" ]; then
    warn "Windows interop is not reachable from here, so the task is left as it is. Run the install again from a WSL shell to register it."
    return 0
  fi
  answer="$(run_powershell "$powershell" "$(keep_alive_script "$distribution")")" || {
    warn "the task could not be registered: $answer"
    return 0
  }
  if [ "${answer%% *}" = "needs-launcher" ]; then
    launcher="$(wslpath -u "${answer#needs-launcher }")"
    mkdir -p "$(dirname "$launcher")"
    place_from_payload "jake.exe" "$launcher"
    answer="$(run_powershell "$powershell" "$(keep_alive_script "$distribution")")" || {
      warn "the task could not be registered: $answer"
      return 0
    }
  fi
  case "$answer" in
    unattended) ok "registered: it holds $distribution from boot, whether or not you are logged on" ;;
    at-logon*) warn "registered to hold $distribution from your logon only, since Windows refused a task that runs without it: ${answer#at-logon }" ;;
    *) warn "the task registration answered: $answer" ;;
  esac
}

keep_distribution_running

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
