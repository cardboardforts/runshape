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
  stopped running, outcomes that flipped. Each side is drawn with its own commit's zones, and the
  Architecture tab lists what the change decided (rules, and what they moved), new code no
  rule covers yet, and zones that only moved with behaviour.
- **Routes.** The sidebar's Routes tab groups requests by the route that served them, and a
  route's requests by the way they went through the code: `POST /orders` placed, refused
  ("skips MemoryRepository.Save"), malformed. In compare mode a route's ways read as new,
  gone, or changed ("now calls ensure_slug_available"), the changed steps marked in place.

Status: first vertical slice, Python (Django, FastAPI) only. See [docs/design.md](docs/design.md)
for decisions, limits, the threat model and what's next.

## Quick look (no VS Code needed)

```sh
npm install                    # npm 11 (see packageManager); `npx npm@11 install` with older npm
npm run dev -w packages/webview
# open http://localhost:5173/demo/index.html: what there is to look at and compare
#   ?app=django-feed-fix has two recordings (before/after a routing fix): tick "Compare"
#   ?app=go-shop-running is a Go program's real traffic: open the Routes tab
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

### Go

```sh
npm run record-go -- path/to/module            # needs the go command; writes <module>/.runshape/traces
```

Each top-level `TestXxx` becomes one scenario. Routes registered with `HandleFunc`/`Handle` are
read from the source, and each request is recorded on the handler that received it. The module is copied and the copy instrumented,
so your source is untouched; each run becomes `latest`, the one before it `previous`. Tests
that couldn't be recorded (a package that doesn't build, a panic that stops a test binary) are
listed as problems; a run that records nothing fails and leaves the last good run in place.
What it can't record yet is listed in docs/design.md.

To record the program itself running rather than its tests:

```sh
npm run run-go -- path/to/module ./cmd/server   # builds and starts it; send traffic, then Ctrl-C
```

Startup (everything before the first request) is one scenario and each HTTP request another.

### TypeScript (vitest): Runshape on its own changes

Recordings are kept per commit in `.runshape/recordings`, so each commit is recorded once and
any two can be compared:

```sh
npm run runshape -- list                    # what's recorded, which branch tips aren't yet
npm run runshape -- compare main --fetch    # fetch main, record where your branch left it and your working tree
                                            # (--tip: main's newest commit instead of the fork point)
# each compare also saves .runshape/reviews/<base>..<head>/review.md (and review.json, docs/review-bundle.md)
npm run runshape -- compare main --explain  # and asks a model why it changed, from the commit messages:
                                            # explanation.md beside the review (--explain=claude: claude -p,
                                            # --explain=api: ANTHROPIC_API_KEY; plain --explain picks;
                                            # --explain-again asks again without recording again)
npm run runshape -- record <branch|commit|working> [--fetch] [--again] [--sandbox]
# --sandbox records commits in a Docker container: no network, non-root, only the commit and
# the output mounted (for code you didn't write: someone's PR, an agent's branch). Needs Docker.
npm run runshape -- forget <id>             # each recording is ~100 MB
```

Each recording also keeps its commit's `runshape.json` and `architecture.json`: where every
class and module the recorded tests ran sits, and whether a rule (and who made it) or its recorded behaviour put it
there. `/demo/index.html` (no `?app`) lists the same and compares any two recordings in the browser,
read live: no dev-server restart after recording. `--fetch` records origin's tip without
touching local branches. `npm run self-review` is `compare main`. See
`recorder-ts/vitest.record.config.ts` to point the recorder at another project.

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
