#!/bin/sh
# npm run self-review [-- <base-ref> [<head-ref>]]   (default: main, and the working tree)
#
# Records packages/core's tests at <base-ref> and at <head-ref> (or the working tree) with the
# TypeScript recorder, as one before/after pair the webview demo opens:
#   npm run dev -w packages/webview, then /demo/index.html?app=self:<label>
# Both are recorded by this checkout's recorder, so only core's code differs between them.
set -eu

BASE_REF="${1:-main}"
HEAD_REF="${2:-}"
REPO="$(git rev-parse --show-toplevel)"
CONFIG="$REPO/recorder-ts/vitest.record.config.ts"
# Worktrees live inside the repository so their tests resolve vitest from its node_modules.
WORKTREES="$REPO/.runshape/worktrees"
LABEL="$(printf '%s..%s' "$BASE_REF" "${HEAD_REF:-working}" | tr -c 'A-Za-z0-9._-' '_')"
OUT="$REPO/.runshape/self/$LABEL"

cleanup() {
  for tree in "$WORKTREES/base" "$WORKTREES/head"; do
    [ -d "$tree" ] && git -C "$REPO" worktree remove --force "$tree" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT
cleanup
mkdir -p "$WORKTREES"
rm -rf "$OUT"
mkdir -p "$OUT"

record() { # <target directory> <run name> <ref, for messages>
  echo "self-review: recording $3"
  RUNSHAPE_TARGET="$1" RUNSHAPE_OUT="$OUT" RUNSHAPE_RUN="$2" \
    npx --prefix "$REPO" vitest run --config "$CONFIG" --reporter=default --reporter=json --outputFile.json="$OUT/$2.vitest.json" \
    >"$OUT/$2.log" 2>&1 || true
  # Failing tests are recorded like passing ones; a recording with no manifest is not.
  [ -f "$OUT/$2/manifest.json" ] || { echo "self-review: recording $3 failed:"; tail -30 "$OUT/$2.log"; exit 2; }
  [ -f "$OUT/$2.vitest.json" ] || { echo "self-review: vitest wrote no report for $3:"; tail -30 "$OUT/$2.log"; exit 2; }
  node "$REPO/recorder-ts/vitest-problems.mjs" "$OUT/$2/manifest.json" "$OUT/$2.vitest.json"
}

git -C "$REPO" worktree add --detach --quiet "$WORKTREES/base" "$BASE_REF"
record "$WORKTREES/base" base "$BASE_REF"
if [ -n "$HEAD_REF" ]; then
  git -C "$REPO" worktree add --detach --quiet "$WORKTREES/head" "$HEAD_REF"
  record "$WORKTREES/head" head "$HEAD_REF"
else
  record "$REPO" head "the working tree"
fi

echo '{"run": "base"}' >"$OUT/previous.json"
echo '{"run": "head"}' >"$OUT/latest.json"
echo "self-review: $(du -sh "$OUT" | cut -f1) in $OUT"
echo "self-review: open http://localhost:5173/demo/index.html?app=self:$LABEL"
echo "self-review: (restart the demo's dev server if it was running: it doesn't see new recordings)"
