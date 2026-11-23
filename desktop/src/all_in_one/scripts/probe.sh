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
