#!/bin/sh
# sh recorder-ts/record-tree.sh <commit|--working> <out directory>   (run from the project)
#
# Records a project's tests at a commit (checked out into a worktree of its own; the working
# tree is untouched) or in the working tree as it is, with the TypeScript recorder. The project
# is the repository this runs in; the recorder and its vitest are this script's checkout (the
# same one when Runshape records itself). RUNSHAPE_INCLUDE and RUNSHAPE_TESTS pass through to
# vitest.record.config.ts. Leaves <out>/latest.json and <out>/run, a traces directory any
# Runshape viewer opens. `npm run runshape -- record` calls this; it keeps the recordings
# (.runshape/recordings).
set -eu

TARGET="$1"
OUT="$2"
RECORDER="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(git rev-parse --show-toplevel)"
CONFIG="$RECORDER/recorder-ts/vitest.record.config.ts"
# Inside the repository, so the worktree's tests resolve vitest from its node_modules.
WORKTREE="$REPO/.runshape/worktrees/$(basename "$OUT")"

cleanup() {
  [ -d "$WORKTREE" ] && git -C "$REPO" worktree remove --force "$WORKTREE" >/dev/null 2>&1 || true
  # A run killed outright leaves git a worktree whose folder may be gone since: forget it, or
  # adding it again fails ("missing but already registered worktree").
  git -C "$REPO" worktree prune >/dev/null 2>&1 || true
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
  npx --prefix "$RECORDER" vitest run --config "$CONFIG" --reporter=default --reporter=json --outputFile.json="$OUT/run.vitest.json" \
  >"$OUT/run.log" 2>&1 || true
# Failing tests are recorded like passing ones; a recording with no manifest is not.
[ -f "$OUT/run/manifest.json" ] || { echo "no recording was written; the end of $OUT/run.log:" >&2; tail -30 "$OUT/run.log" >&2; exit 2; }
[ -f "$OUT/run.vitest.json" ] || { echo "vitest wrote no report; the end of $OUT/run.log:" >&2; tail -30 "$OUT/run.log" >&2; exit 2; }
node "$RECORDER/recorder-ts/vitest-problems.mjs" "$OUT/run/manifest.json" "$OUT/run.vitest.json"
echo '{"run":"run"}' >"$OUT/latest.json"
