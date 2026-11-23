# The index laid down and the installer built, as the index's INSTALL.md 「Lay down the index and build the
# installer」 states (docs/all-in-one.md, 「The first run」). The index is the first word; every step is idempotent.
set -eu
index="$1"
export PATH="$HOME/.cargo/bin:$HOME/.local/bin:$HOME/.bun/bin:$PATH"
test -d "$index/.git" || git clone https://github.com/ahas/bmo.git "$index"
git -C "$index" pull --ff-only
cd "$index"
for pair in base/text:bmo-text base/chat:bmo-chat base/ui:bmo-ui services/testbed:bmo-testbed; do
  folder=${pair%%:*}
  name=${pair##*:}
  test -d "$folder/.git" || git clone "https://github.com/ahas/$name.git" "$folder"
done
cargo build --release --manifest-path services/testbed/Cargo.toml -p bmo-testbed-cli
