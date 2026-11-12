#!/usr/bin/env bash
# Builds the hub CLI and installs it where the deploy path and ssh expect it.

set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo"

cargo build --release --frozen --manifest-path hub/Cargo.toml --bin jake-hub
install -D -m 0755 target/release/jake-hub "$HOME/.local/bin/jake-hub"
