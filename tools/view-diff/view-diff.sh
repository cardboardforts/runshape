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
  CORE_SRC="$1" FIXTURES="$REPO/packages/core/test/fixtures" DUMP_OUT="$2" \
    npx --prefix "$REPO" vitest run --config "$HERE/vitest.config.mjs" >"$2.log" 2>&1 \
    || { echo "view-diff: dumping $3 failed:"; cat "$2.log"; exit 2; }
}

dump "$WORK/base/packages/core/src" "$WORK/before.json" "$BASE_REF"
dump "$REPO/packages/core/src" "$WORK/after.json" "the working tree"
echo "view-diff: $BASE_REF ($(git -C "$REPO" rev-parse --short "$BASE_REF")) -> working tree"
node "$HERE/compare.mjs" "$WORK/before.json" "$WORK/after.json"
