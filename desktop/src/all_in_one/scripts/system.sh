# The system's packages of the index's INSTALL.md 「Install the prerequisites」, and the system programs the preset's
# `needs:` lines name, run as root, for the account named by the first word (docs/all-in-one.md, 「The first run」).
# Each line checks first, so a rerun does nothing more.
set -eu
account="$1"
home="$(getent passwd "$account" | cut -d: -f6)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q git build-essential pkg-config libssl-dev curl jq ca-certificates unzip xz-utils tmux ffmpeg \
  rsync xvfb poppler-utils gnome-remote-desktop
command -v psql >/dev/null || apt-get install -y -q postgresql postgresql-contrib
command -v valkey-server >/dev/null || command -v redis-server >/dev/null \
  || apt-get install -y -q valkey-server || apt-get install -y -q redis-server
# A real browser for the web tools: Google Chrome, unless the Firefox snap stands opened once.
if ! test -x /usr/bin/google-chrome && ! { test -x /snap/bin/firefox \
  && test -f "$home/snap/firefox/common/.mozilla/firefox/profiles.ini"; } && test "$(uname -m)" = x86_64; then
  chrome="$(mktemp -d)"
  curl -fsSL -o "$chrome/chrome.deb" https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  apt-get install -y -q "$chrome/chrome.deb"
  rm -rf "$chrome"
fi
# Without systemd the servers are started by their own service scripts.
if ! test -d /run/systemd/system; then
  service postgresql start || true
  service valkey-server start 2>/dev/null || service redis-server start 2>/dev/null || true
fi
su postgres -c "psql --tuples-only --command=\"select 1 from pg_roles where rolname = '$account'\"" | grep -q 1 \
  || su postgres -c "createuser --createdb '$account'"
su postgres -c "psql --tuples-only --command=\"select 1 from pg_database where datname = '$account'\"" | grep -q 1 \
  || su postgres -c "createdb --owner='$account' '$account'"
if test -d /run/systemd/system; then
  test "$(loginctl show-user "$account" --property=Linger --value 2>/dev/null)" = yes || loginctl enable-linger "$account"
fi
