# The all-in-one app's probe of the machine the set will run on (docs/all-in-one.md, 「The first run」): one
# `name=value` line for each fact, and nothing else on standard output.
printf 'os=%s\n' "$(uname -s)"
printf 'arch=%s\n' "$(uname -m)"
printf 'uid=%s\n' "$(id -u)"
printf 'user=%s\n' "$(id -un)"
printf 'home=%s\n' "$HOME"
printf 'memory_kib=%s\n' "$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo 2>/dev/null)"
printf 'disk_kib=%s\n' "$(df -Pk "$HOME" 2>/dev/null | awk 'NR == 2 { print $4 }')"
runtime="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
if test -S "$runtime/systemd/private"; then echo systemd=yes; else echo systemd=no; fi
if command -v git >/dev/null 2>&1; then echo git=yes; else echo git=no; fi
if command -v cargo >/dev/null 2>&1 || test -x "$HOME/.cargo/bin/cargo"; then echo cargo=yes; else echo cargo=no; fi
