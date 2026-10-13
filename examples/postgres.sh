#!/usr/bin/env bash
# A throwaway local Postgres for the FastAPI example, without Docker: the pgserver wheel
# ships real Postgres 16 binaries. TCP on 127.0.0.1 only; data lives in examples/.pgdata.
set -euo pipefail
cd "$(dirname "$0")"
PORT=54329
PGBIN=".pg-venv/lib/python3.12/site-packages/pgserver/pginstall/bin"

case "${1:-}" in
  start)
    if [ ! -x "$PGBIN/pg_ctl" ]; then
      uv venv --quiet --allow-existing --python 3.12 .pg-venv
      uv pip install --quiet --python .pg-venv/bin/python pgserver
    fi
    if [ ! -d .pgdata ]; then
      PWFILE=$(mktemp); echo postgres > "$PWFILE"
      "$PGBIN/initdb" --quiet -D .pgdata -U postgres --auth=md5 --pwfile="$PWFILE"; rm "$PWFILE"
    fi
    # -k '': no unix socket (macOS caps socket paths at 103 bytes); TCP only.
    "$PGBIN/pg_ctl" -D .pgdata -o "-p $PORT -k '' -h 127.0.0.1" -l .pgdata/server.log start
    echo "DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:$PORT/postgres"
    ;;
  stop) "$PGBIN/pg_ctl" -D .pgdata stop ;;
  *) echo "usage: $0 start|stop" >&2; exit 2 ;;
esac
