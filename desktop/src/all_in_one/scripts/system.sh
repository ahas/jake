# The system's packages of the index's INSTALL.md 「Install the prerequisites」, run as root, for the account named
# by the first word (docs/all-in-one.md, 「The first run」). Each line checks first, so a rerun does nothing more.
set -eu
account="$1"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q git build-essential pkg-config libssl-dev curl jq ca-certificates unzip tmux ffmpeg
command -v psql >/dev/null || apt-get install -y -q postgresql postgresql-contrib
command -v valkey-server >/dev/null || command -v redis-server >/dev/null \
  || apt-get install -y -q valkey-server || apt-get install -y -q redis-server
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
