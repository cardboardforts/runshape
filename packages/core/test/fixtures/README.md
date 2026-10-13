# Fixtures

Real recordings of the two example apps, used by the core tests and the webview demo.

- `<app>/run/` — a trace run exactly as `examples/record.sh <app>` wrote it (the FastAPI one
  is trimmed to five of its ninety scenarios to keep the repo small). Traces hold function
  names, line numbers and SQL text, not source code.
- `fastapi/source/` — a copy of fastapi-realworld-example-app's Python source at the recorded
  commit (MIT, see `fastapi/source/LICENSE`), so tests can show code without the examples
  being set up. There is deliberately no `django/source/`: that upstream repo has no license,
  so its source is not redistributed here; the demo reads it from `examples/` if present.

Regenerate after changing the recorder: run the example, then copy `.hexvis/traces/<run>/`
over `<app>/run/`. The inline snapshots in `test/*.test.ts` will show what changed.
