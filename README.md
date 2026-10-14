# Runshape

See how a Python web app actually runs: record its tests, then watch each request travel from
the client through middleware, router, handlers and services to the database — laid out as
the onion it is (or isn't).

- **Runtime map.** Every component that ran, the calls between them, coloured by zone
  (inbound adapter, core, outbound adapter, external), inferred from what each one was seen
  doing. Handlers that query the database directly are flagged.
- **Replay.** Pick a test and watch its calls pulse along the graph, hop by hop.
- **Test wires.** Open a function: one wire per test runs down its source and splits where
  tests branch. Lines with no wire are untested; tests that take identical paths are grouped
  as candidates for consolidation.
- **Declared zones.** Say where a component is *meant* to sit — by hand, or by accepting a
  language model's proposal — and it's saved as a rule with its reason in a checked-in
  `runshape.json`. Where behaviour contradicts a declaration (core code querying the database,
  a request handler calling a repository directly), the graph flags it.
- **3D.** The same views on a literal hexagon floor: core in the middle, inbound adapters on
  the three sides facing the incoming traffic, outbound adapters on the three facing the
  outside world, external systems beyond. Components are tiles with their live objects as
  cubes above them, dashed lines joining objects that hold one another (per object once you
  pick a test); calls between zones run along shared trunks; replay steps are packets of
  light travelling them.
- **Review a PR by behaviour.** `runshape-review --base origin/main` records the tests on the
  base and on your branch; the viewer then leads with the tests that are *still green but
  now run differently*. Also as a Markdown PR comment. See [docs/pr-review.md](docs/pr-review.md).
- **Compare.** Re-record after a change (yours or an AI agent's) and see which journeys now
  behave differently: new and lost hops, SQL that appeared or vanished, lines that started or
  stopped running, outcomes that flipped.

Status: first vertical slice, Python (Django, FastAPI) only. See [docs/design.md](docs/design.md)
for decisions, limits, the threat model and what's next.

## Quick look (no VS Code needed)

```sh
npm install                    # npm 11 (see packageManager); `npx npm@11 install` with older npm
npm run dev -w packages/webview
# open http://localhost:5173/demo/index.html?app=django   (or ?app=fastapi)
#   ?app=django-feed-fix has two recordings (before/after a routing fix): tick "Compare"
```

The demo renders real recordings of the two example apps, checked in under
`packages/trace/test/fixtures`.

## Recording your own app

```sh
pip install -e path/to/runshape/recorder      # a pytest plugin; Python 3.9+
```

```ini
# pytest.ini (or [tool.pytest.ini_options])
runshape_source = app          # your code: traced line by line
runshape_tests = tests         # your tests: each test becomes one scenario
runshape_app = app.main:app    # FastAPI only; Django is detected from its settings
```

```sh
pytest --runshape              # writes .runshape/traces/ — add .runshape/ to .gitignore
```

On Python < 3.12 add `--no-cov` (the recorder and coverage can't share `sys.settrace`), and
record without xdist (`-n0`). The recorder checks for both and tells you.

Then in VS Code: **Runshape: Open Runtime View**. Re-running the tests updates the view.

## Example apps

`examples/` records two RealWorld backends — FastAPI unchanged, Django ported to 5.2 with a
journey test suite added. See [examples/README.md](examples/README.md).

```sh
examples/setup.sh && examples/postgres.sh start
examples/record.sh django && examples/record.sh fastapi
```

## Development

```sh
npm test                       # core + extension unit tests (vitest)
npm run typecheck
npm run test:e2e               # builds, then drives a real, isolated VS Code (downloads ~300MB once)
cd recorder && uv run pytest   # recorder; add --python 3.9 to check the settrace backend
```

| path | what | may import |
|---|---|---|
| `recorder/src/runshape_recorder/domain` | scopes, spans, recording | stdlib only |
| `recorder/src/runshape_recorder/adapters` | tracing backends, JSON store, catalog, framework introspection | domain |
| `recorder/src/runshape_recorder/pytest_plugin.py` | composition root | everything |
| `packages/core` | trace parsing and every view model | nothing outside itself |
| `packages/webview` | React renderer of core's view models | core |
| `packages/extension` | VS Code host, composition root | core, vscode |

Trace format: [docs/trace-format.md](docs/trace-format.md).
