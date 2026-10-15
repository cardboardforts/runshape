#!/bin/sh
# sh recorder-ts/record-tree.sh <commit|--working> <out directory>
#
# Records the core packages' tests at a commit (checked out into a worktree of its own; the
# working tree is untouched) or in the working tree as it is, with the TypeScript recorder.
# Leaves <out>/latest.json and <out>/run, a traces directory any Runshape viewer opens.
# `npm run runshape -- record` calls this; it keeps the recordings (.runshape/recordings).
set -eu

TARGET="$1"
OUT="$2"
REPO="$(git rev-parse --show-toplevel)"
CONFIG="$REPO/recorder-ts/vitest.record.config.ts"
# Inside the repository, so the worktree's tests resolve vitest from its node_modules.
WORKTREE="$REPO/.runshape/worktrees/$(basename "$OUT")"

cleanup() {
  [ -d "$WORKTREE" ] && git -C "$REPO" worktree remove --force "$WORKTREE" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup
mkdir -p "$OUT" "$(dirname "$WORKTREE")"

if [ "$TARGET" = "--working" ]; then
  TREE="$REPO"
else
  git -C "$REPO" worktree add --detach --quiet "$WORKTREE" "$TARGET"
  TREE="$WORKTREE"
fi

RUNSHAPE_TARGET="$TREE" RUNSHAPE_OUT="$OUT" RUNSHAPE_RUN=run \
  npx --prefix "$REPO" vitest run --config "$CONFIG" --reporter=default --reporter=json --outputFile.json="$OUT/run.vitest.json" \
  >"$OUT/run.log" 2>&1 || true
# Failing tests are recorded like passing ones; a recording with no manifest is not.
[ -f "$OUT/run/manifest.json" ] || { echo "no recording was written; the end of $OUT/run.log:" >&2; tail -30 "$OUT/run.log" >&2; exit 2; }
[ -f "$OUT/run.vitest.json" ] || { echo "vitest wrote no report; the end of $OUT/run.log:" >&2; tail -30 "$OUT/run.log" >&2; exit 2; }
node "$REPO/recorder-ts/vitest-problems.mjs" "$OUT/run/manifest.json" "$OUT/run.vitest.json"
echo '{"run":"run"}' >"$OUT/latest.json"
