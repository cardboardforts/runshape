#!/bin/sh
# npm run view-diff [-- <base-ref>]   (default base: main)
#
# What a change to core does to the viewer: dumps every view for every fixture from <base-ref>
# and from the working tree, then compares them. A refactor should print "identical".
# When the UI protocol itself changes, the two dumps no longer line up; say so in the PR.
set -eu

BASE_REF="${1:-main}"
REPO="$(git rev-parse --show-toplevel)"
HERE="$REPO/tools/view-diff"
WORK="$(mktemp -d)"
trap 'git -C "$REPO" worktree remove --force "$WORK/base" >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT

git -C "$REPO" worktree add --detach --quiet "$WORK/base" "$BASE_REF"

dump() {
  CORE_SRC="$1" FIXTURES="$REPO/packages/kernel/test/fixtures" DUMP_OUT="$2" \
    npx --prefix "$REPO" vitest run --config "$HERE/vitest.config.mjs" >"$2.log" 2>&1 \
    || { echo "view-diff: dumping $3 failed:"; cat "$2.log"; exit 2; }
}

# The kernel's source in a checkout: packages/kernel, or packages/core before Phase 0b renamed it.
kernel_src() { if [ -d "$1/packages/kernel/src" ]; then echo "$1/packages/kernel/src"; else echo "$1/packages/core/src"; fi; }

dump "$(kernel_src "$WORK/base")" "$WORK/before.json" "$BASE_REF"
dump "$(kernel_src "$REPO")" "$WORK/after.json" "the working tree"
echo "view-diff: $BASE_REF ($(git -C "$REPO" rev-parse --short "$BASE_REF")) -> working tree"
node "$HERE/compare.mjs" "$WORK/before.json" "$WORK/after.json"
