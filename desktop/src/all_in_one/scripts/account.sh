# The account's own programs, as the index's INSTALL.md 「Install the prerequisites」 and the preset's `needs:` lines
# name them (docs/all-in-one.md, 「The first run」): Rust, Bun, Zig for herdr's build, uv with LiteLLM's proxy, and
# Claude Code, each in the account's own folders. Each line checks first, so a rerun does nothing more.
set -eu
export PATH="$HOME/.cargo/bin:$HOME/.local/bin:$HOME/.bun/bin:$PATH"
mkdir -p "$HOME/.local/bin"
command -v cargo >/dev/null || curl -fsSL https://sh.rustup.rs | sh -s -- -y
test -x "$HOME/.bun/bin/bun" || curl -fsSL https://bun.sh/install | bash
# Zig at the version herdr's build names, checked against the download index's digest and linked into ~/.local/bin.
zig_version=0.16.0
if ! test -x "$HOME/.local/bin/zig"; then
  index="$(curl -fsSL https://ziglang.org/download/index.json)"
  target="$(uname -m)-linux"
  url="$(printf '%s' "$index" | jq -r --arg v "$zig_version" --arg t "$target" '.[$v][$t].tarball')"
  sum="$(printf '%s' "$index" | jq -r --arg v "$zig_version" --arg t "$target" '.[$v][$t].shasum')"
  zig="$(mktemp -d)"
  curl -fsSL -o "$zig/zig.tar.xz" "$url"
  echo "$sum  $zig/zig.tar.xz" | sha256sum -c --quiet -
  mkdir -p "$HOME/.local/share/zig"
  tar -xJf "$zig/zig.tar.xz" -C "$HOME/.local/share/zig"
  ln -sf "$HOME/.local/share/zig/$(basename "$url" .tar.xz)/zig" "$HOME/.local/bin/zig"
  rm -rf "$zig"
fi
test -x "$HOME/.local/bin/uv" || curl -fsSL https://astral.sh/uv/install.sh | env UV_NO_MODIFY_PATH=1 sh
test -x "$HOME/.local/bin/litellm" || "$HOME/.local/bin/uv" tool install 'litellm[proxy]'
# Claude Code; its sign-in in a browser is the person's own.
test -x "$HOME/.local/bin/claude" || curl -fsSL https://claude.ai/install.sh | bash
