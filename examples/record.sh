#!/usr/bin/env bash
# Runs an example's test suite with the runshape recorder: one trace per test, written to
# examples/<app>/.runshape/traces/. Open that folder in VS Code and run "Runshape: Open".
set -euo pipefail
cd "$(dirname "$0")"

case "${1:-}" in
  django)
    cd django-realworld
    .venv/bin/python -m pytest -p no:warnings --runshape "${@:2}"
    ;;
  fastapi)
    cd fastapi-realworld
    export DATABASE_URL="${DATABASE_URL:-postgresql://postgres:postgres@127.0.0.1:54329/postgres}"
    export SECRET_KEY="${SECRET_KEY:-secret}"
    .venv/bin/alembic upgrade head >/dev/null
    # Python 3.9 => settrace backend, which can't share the tracer with coverage (--no-cov)
    # and records one process at a time (-n0). The ini options live here, not in a patch,
    # so the FastAPI app stays byte-for-byte upstream.
    .venv/bin/python -m pytest -p no:cacheprovider -n0 --no-cov --runshape \
      -o runshape_source=app -o runshape_tests=tests -o runshape_app=app.main:app "${@:2}"
    ;;
  *) echo "usage: $0 django|fastapi [pytest args]" >&2; exit 2 ;;
esac
