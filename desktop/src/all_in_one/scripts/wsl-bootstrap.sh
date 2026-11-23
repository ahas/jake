# The BMO distribution laid out once, as root (docs/all-in-one.md, 「Windows through WSL 2」): the person's account,
# named by the first word, made and written as the default user; Windows' PATH kept out of the distribution's; and
# systemd left off, since the set runs under the testbed's supervisor. Every step checks first.
set -eu
account="$1"
id -u "$account" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$account"
cat > /etc/wsl.conf <<CONF
[user]
default=$account

[boot]
systemd=false

[interop]
appendWindowsPath=false
CONF
