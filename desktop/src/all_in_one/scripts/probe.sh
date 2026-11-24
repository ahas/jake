# The all-in-one app's probe of the machine the set will run on (docs/all-in-one.md, 「The first run」): one
# `name=value` line for each fact, and nothing else on standard output.
printf 'os=%s\n' "$(uname -s)"
printf 'arch=%s\n' "$(uname -m)"
printf 'uid=%s\n' "$(id -u)"
printf 'user=%s\n' "$(id -un)"
printf 'home=%s\n' "$HOME"
memory_kib="$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo 2>/dev/null)"
# A container's memory ceiling, where one is set below the machine's, is the memory the builds have.
limit="$(cat /sys/fs/cgroup/memory.max 2>/dev/null)"
case "$limit" in
  '' | *[!0-9]*) ;;
  *) test -z "$memory_kib" || test $((limit / 1024)) -ge "$memory_kib" || memory_kib=$((limit / 1024)) ;;
esac
printf 'memory_kib=%s\n' "$memory_kib"
printf 'disk_kib=%s\n' "$(df -Pk "$HOME" 2>/dev/null | awk 'NR == 2 { print $4 }')"
runtime="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
if test -S "$runtime/systemd/private"; then echo systemd=yes; else echo systemd=no; fi
if command -v git >/dev/null 2>&1; then echo git=yes; else echo git=no; fi
if command -v cargo >/dev/null 2>&1 || test -x "$HOME/.cargo/bin/cargo"; then echo cargo=yes; else echo cargo=no; fi
if command -v cc >/dev/null 2>&1; then echo cc=yes; else echo cc=no; fi
# Whatever already listens on the console's port, and whether it runs from one of the set's own releases.
console_port=3210
listener="$(ss -ltnpH "sport = :$console_port" 2>/dev/null | head -n 1)"
if test -z "$listener" && ! command -v ss >/dev/null 2>&1; then
  # Without ss the kernel's own table says whether the port listens, though not who holds it.
  hex="$(printf '%04X' "$console_port")"
  if awk -v port=":$hex" '$2 ~ port"$" && $4 == "0A" { found = 1 } END { exit !found }' /proc/net/tcp /proc/net/tcp6 2>/dev/null; then
    listener="held"
  fi
fi
if test -n "$listener"; then
  echo console_port=held
  pid="$(printf '%s\n' "$listener" | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p')"
  printf 'console_port_holder=%s\n' "$(printf '%s\n' "$listener" | sed -n 's/.*users:(("\([^"]*\)".*/\1/p')"
  own=no
  if test -n "$pid"; then
    for path in "$(readlink "/proc/$pid/exe" 2>/dev/null)" "$(readlink "/proc/$pid/cwd" 2>/dev/null)"; do
      case "$path" in "$HOME"/.local/share/bmo-*) own=yes ;; esac
    done
  fi
  printf 'console_port_own=%s\n' "$own"
else
  echo console_port=free
fi
# A jake agent installed for this account: its agent.env naming an agent, with its user unit registered.
jake_env="$HOME/.local/share/jake/agent.env"
jake_unit="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/jake-agent.service"
if test -f "$jake_env" && test -f "$jake_unit"; then
  printf 'jake=%s\n' "$(sed -n 's/^[[:space:]]*JAKE_AGENT_NAME=//p' "$jake_env" | head -n 1 | tr -d "\"'")"
fi
