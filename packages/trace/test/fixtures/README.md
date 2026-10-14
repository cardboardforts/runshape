# Fixtures

Real recordings of the example apps, used by the tests and the webview demo.

- `<app>/run/` — a trace run exactly as `examples/record.sh <app>` wrote it (the FastAPI one
  is trimmed to five of its ninety scenarios to keep the repo small). Older
  recordings (django, fastapi, django-feed-fix) hold names, line numbers and SQL text only;
  newer ones (fastapi-slug-refactor) also carry the source they ran (see below).
- `fastapi/source/` — a copy of fastapi-realworld-example-app's Python source at the recorded
  commit (MIT, see `fastapi/source/LICENSE`), so tests can show code without the examples
  being set up. There is deliberately no `django/source/`: that upstream repo has no license,
  so its source is not redistributed here; the demo reads it from `examples/` if present.

- `django-feed-fix/` — before and after fixing the Django feed routing bug (compare mode).
- `fastapi-slug-refactor/` — before and after a refactor of the FastAPI example's slug check
  (execution diff). The change itself is described in `test/execution-diff.test.ts`.

Recordings now include the source they ran (`sources` in the manifest). Never commit a new
Django recording as a fixture without stripping `sources`: that upstream has no license.

Regenerate after changing the recorder: run the example, then copy `.hexvis/traces/<run>/`
over `<app>/run/`. The inline snapshots in `test/*.test.ts` will show what changed.

- `go-shop/` — examples/go-shop recorded by recorder-go (trace format version 2, with source):
  `npm run record-go -- -out packages/trace/test/fixtures/go-shop -run run examples/go-shop`.
