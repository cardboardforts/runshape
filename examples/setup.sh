#!/usr/bin/env bash
# Clones the two example apps at pinned commits, applies runshape's patches, and builds a
# venv for each with the recorder installed in editable mode. Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")"
HERE="$PWD"

DJANGO_REPO=https://github.com/gothinkster/django-realworld-example-app
DJANGO_SHA=29c9d42831fa0cfc5a4aa7561f674396eacf20a2
FASTAPI_REPO=https://github.com/nsidnev/fastapi-realworld-example-app
FASTAPI_SHA=029eb7781c60d5f563ee8990a0cbfb79b244538c

checkout() {  # name repo sha
  if [ ! -d "$1/.git" ]; then git clone --quiet "$2" "$1"; fi
  git -C "$1" fetch --quiet origin "$3" 2>/dev/null || true
  git -C "$1" checkout --quiet "$3"
  # Keep the example's own `git status` about code: venvs, recordings and caches are local.
  for pattern in .venv/ .runshape/ .pytest_cache/ db.sqlite3 .requirements.lock.txt; do
    grep -qxF "$pattern" "$1/.git/info/exclude" || echo "$pattern" >> "$1/.git/info/exclude"
  done
}

echo "== django-realworld (ported to Django 5.2 / Python 3.12, see README.md)"
checkout django-realworld "$DJANGO_REPO" "$DJANGO_SHA"
if git -C django-realworld apply --check "$HERE/patches/django-realworld.patch" 2>/dev/null; then
  git -C django-realworld apply "$HERE/patches/django-realworld.patch"
fi
uv venv --quiet --allow-existing --python 3.12 django-realworld/.venv
uv pip install --quiet --python django-realworld/.venv/bin/python -r django-realworld/requirements.txt -e ../recorder

echo "== fastapi-realworld (unchanged, Python 3.9 from its poetry.lock)"
checkout fastapi-realworld "$FASTAPI_REPO" "$FASTAPI_SHA"
uvx --quiet --from 'poetry<1.9' poetry export --directory fastapi-realworld --with dev -f requirements.txt --without-hashes -o fastapi-realworld/.requirements.lock.txt
uv venv --quiet --allow-existing --python 3.9 fastapi-realworld/.venv
# setuptools: aiosql 6.2 imports pkg_resources; pinned to 2022 so it doesn't warn (the suite runs -W error).
uv pip install --quiet --python fastapi-realworld/.venv/bin/python -r fastapi-realworld/.requirements.lock.txt "setuptools==65.5.0" -e ../recorder

echo "done. Next: ./postgres.sh start && ./record.sh django && ./record.sh fastapi"
