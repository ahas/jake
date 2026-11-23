# Rust and Bun for the account, as the index's INSTALL.md 「Install the prerequisites」 installs them
# (docs/all-in-one.md, 「The first run」).
set -eu
command -v cargo >/dev/null || test -x "$HOME/.cargo/bin/cargo" || curl -fsSL https://sh.rustup.rs | sh -s -- -y
test -x "$HOME/.bun/bin/bun" || curl -fsSL https://bun.sh/install | bash
