#!/usr/bin/env bash
# Fails unless the checkout the hub runs from stands at the release's commit, with no tracked file changed.

set -euo pipefail

# Run from a release: a worktree of the checkout at the commit being deployed. The hub's unit builds and
# runs the checkout itself, so the record names the code the hub runs only where the checkout stands at
# exactly that commit.
commit="$(git rev-parse HEAD)"
checkout="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
head="$(git -C "$checkout" rev-parse HEAD)"

if [[ "$head" != "$commit" ]]; then
  echo "the checkout $checkout stands at $head, not at $commit, and the hub runs the checkout," \
    "so bring it to the commit first" >&2
  exit 1
fi

if ! git -C "$checkout" diff --quiet HEAD --; then
  echo "the checkout $checkout has changed tracked files, which the hub would build and run unrecorded:" >&2
  git -C "$checkout" diff --name-only HEAD -- >&2
  exit 1
fi

echo "the checkout $checkout stands at $commit"
