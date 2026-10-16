# Runshape design

## What it's for

See an app the way it runs: a request comes in from the outside, passes the framework's
middleware and router, reaches a handler, flows through services, and leaves the process at a
database or another service. Each test is a named user behaviour, so each test is one
recorded **scenario**. Three views come out of the same recordings:

1. **Runtime map** — components (classes, modules, framework steps, external systems) and the
   calls between them, laid out left to right as a request travels and coloured by onion zone.
2. **Test wires** — a function's source with one wire per test; the bundle splits where tests
   take different branches, and lines no wire reaches are untested.
3. **Behavioural diff** — the recorder keeps the previous run; compare mode shows which
   journeys now behave differently: hops gained and lost, SQL that appeared or vanished,
   outcome changes, and an **execution diff** per test — calls aligned by their path of
   qualified names (re-parented calls marked), statements aligned by their recorded text —
   so moving a function or editing code above it isn't mistaken for a behaviour change.
   "Replay the change" plays both executions as one timeline.

## What exists (first vertical slice)

| piece | where | status |
|---|---|---|
| pytest recorder, `settrace` (3.9+) and `sys.monitoring` (3.12+) backends | `recorder/` | done, tested on 3.9 / 3.11 / 3.12 / 3.14 |
| Django and FastAPI introspection: middleware, router, routes, databases | `recorder/.../frameworks/` | done |
| trace format v1 | `docs/trace-format.md` | done |
| core: parse, system graph, zones, component and function views, replay | `packages/core` | done, tested on real recordings |
| webview: graph (React Flow + ELK), scenario list, replay pulses, drill-in, wires | `packages/webview` | done; checked in a browser via the demo |
| VS Code extension: open, reload on re-record, open source at line, logging | `packages/extension` | done; end-to-end test in a real VS Code |
| behavioural diff (compare with previous recording) | `packages/core/src/views/run-diff.ts` | done; tested on a real before/after fix of the Django routing bug |
| declared zones (`runshape.json`), provenance, onion violations, LLM zone proposals | `packages/core/src/zones.ts`, `zone-advice.ts` | done; the model call runs end to end against a fake model in the e2e test, and was checked by hand with a real model (Copilot) on the Django example on 2026-10-13 |
| 3D renderer (three.js): hexagon floor, tiles and objects, call arcs, replay packets | `packages/webview/src/three` | first version; layout tested, scene checked in a browser |

## Architecture

The same onion it's meant to show. Imports point inward only:

```
recorder:   pytest_plugin.py (composition root) -> adapters/ -> domain/
viewer:     packages/extension (composition root, VS Code adapter) ─┐
            packages/webview   (UI adapter, renders view models)  ─┼─> packages/core
            packages/webview/demo (browser host for development)  ─┘
```

- `packages/core` imports nothing outside itself: no `vscode`, no React, no Node `fs`. File
  access comes in through two ports, `TraceFiles` and `SourceReader`.
- `ViewerSession` (core) answers every request the webview can make. The extension forwards
  messages to it; the demo calls it directly. So the webview behaves identically in both.
- The trace format is the wire format between the Python and TypeScript halves. It is bent
  for size (tagged arrays); `parse.ts` maps it into named domain types at the boundary.

Check with: `grep -rn "from \"vscode\"\|from \"react\"\|node:" packages/core/src` (expect nothing).

## Decisions

**Runtime traces, not static analysis.** Static analysis can't tell which of three
implementations a port resolved to, or which middleware actually ran. Recording tests gives
ground truth and, for free, a name for every flow (the test's name).

**Record project code line by line, framework code as landmarks, drivers as boundaries.**
A Django request is tens of thousands of interpreter events, nearly all inside Django.
`CodeScope` classifies each code object once: *source/test* code gets spans and line events;
*landmarks* (request entry, each middleware, the router — read from the framework at
startup) get spans only; *boundaries* record one event per call to an external system,
restricted to the operations that are actually traffic (`execute`, `fetch*`, HTTP verbs).
This is what makes a recording readable; the earlier "whole driver package is a boundary"
version recorded `quote_name()` as database traffic.

**Components are grouped by the receiving object's class.** `BaseRepository.connection`
called on a `UsersRepository` belongs to `UsersRepository`: the runtime picture, not the
inheritance tree.

**Zones: declared where you've decided, inferred where you haven't.** A rule in the
checked-in `runshape.json` (an ordered list of dotted-name globs, each with a required reason)
wins over inference, and every node says which applied and why. Declaring is the point:
inference can only describe behaviour, while a declaration can be *contradicted* by it. A
declared-core class that queries the database, a handler calling a repository directly, or
anything further in calling back into a handler is flagged. Constructor-only calls are
exempt (building an adapter is dependency injection). A language model can propose a zone
from the recorded facts and the component's source; nothing is written until the person
accepts it in a confirmation dialog, and the rule records `"by": "llm"`.

**Inference, when no rule applies, is labelled as such.** Inbound adapter: the framework
calls it inside the package that holds the route handlers. Outbound adapter: it calls an
external system. Core: neither. Inbound and also calling an external system is flagged
(`handler-touches-external`): the handler skips the core. On the Django example this flags
every view and puts ORM models in the outbound zone — which is accurate for an active-record
design, and is exactly the kind of thing the tool should surface. Explicit configuration (or
an LLM proposal you confirm) can override this later; inference is the floor, not the answer.

**Work handed to another thread keeps its parent.** FastAPI runs sync dependencies in a
thread pool. The recorder keeps the current span in a `ContextVar`, which `asyncio.to_thread`
and AnyIO copy into the worker, so the dependency nests under the request that needed it.
An earlier "most recently active span on another thread" heuristic raced and was replaced.

**Test doubles are their own zone.** Test code called *by* the app (FastAPI's
`FakeAsyncPGPool`) is a stand-in for an adapter, not the client.

**2D first, 3D as a second renderer.** The hard problem is aggregation, not rendering, so
every view is a view model in core and both renderers draw the same ones. The 3D scene
borrows its visual language from Heapscape (wireframe containers, glowing arcs, packets with
fading tails, bloom on the packets only) and gives it Runshape's meaning: the floor is the
hexagon, with each zone on its own side.

**Known bugs are scenarios too.** pytest `xfail` is recorded as `xfailed`, never as a skip
or a pass, so a known-broken flow can be replayed.

## Observability

The extension logs logfmt lines to the **Runshape** output channel (VS Code adds timestamp and
level):

- `extension.activated` (version), `projects.found`, `panel.opened` / `panel.closed`
- every webview request: `webview.request request=<id> type=<type>` on receipt and
  `webview.response ... durationMs=` on completion — the request id is the correlation id
- `run.loaded` with scenario count, backend, framework, problems and duration; one
  `run.problem` warning per unreadable scenario
- `webview.failed` with the full stack for any exception, and the message is also shown in
  the view — there is no silent blank panel
- `recording.changed` / `run.reload` when re-running tests rewrites the recording

The recorder reports in pytest's terminal summary (scenarios, events, backend, framework,
recorder errors, duration, manifest path) and writes every problem into the manifest so the
viewer shows it. A tracer must never break the program it observes: every callback catches
its own exceptions and counts them as `recorder_errors`.

Not logged: source code, SQL parameters, request headers or bodies.

## Threat model

What we're building: a pytest plugin that runs inside the test process, writes JSON into the
project, and a VS Code extension that reads that JSON and the project's source and renders it
in a webview.

| boundary | threat | control | gap if absent |
|---|---|---|---|
| trace file → extension | **T/E**: a crafted trace (committed by anyone with repo access) names `../../.ssh/id_rsa` as a source file | `safeSegments` refuses absolute paths and `..` for every path from traces or the webview (unit-tested) | the viewer reads, and a click opens, arbitrary files |
| trace file → webview | **T**: crafted strings become markup | React escapes all text; CSP allows scripts only with a per-load nonce, no inline or remote code; `localResourceRoots` limits the webview to the bundle | script injection into a webview with access to the extension's message API |
| trace file → log | **T/R**: a value with a newline forges a log line | logger escapes newlines and quotes (unit-tested) | misleading audit trail |
| recorder → disk | **I**: traces capture data from the test run | SQL text but never parameters; URLs without query strings (API keys); request method and path only, no headers or bodies; traces live under `.runshape/`, which projects should git-ignore | credentials and personal data from test fixtures land in files people commit or share |
| extension → language model | **I**: "Suggest a zone" sends the component's name, functions, recorded neighbours and its own source to whichever model VS Code provides (e.g. Copilot's) | only on an explicit click per component; VS Code asks the person to allow model access the first time; the log records prompt size, never content | code leaves the machine without the person deciding it should |
| model answer → runshape.json | **T**: a model's (or prompt-injected) answer rewrites the architecture rules | the answer is validated (known zone, non-empty reason) and shown as a proposal; writing requires a modal confirmation showing the exact rule as JSON and whether it replaces one; saving is refused while runshape.json is unreadable, so a broken file is never overwritten; the request itself is validated | the rules file changes silently |
| recorder → test process | **D**: tracing slows or breaks the suite | opt-in (`--runshape`); callbacks never raise; `sys.monitoring` disables uninteresting code after first sight | a broken or unusably slow test run |

Accepted risks:

- **Request paths are recorded** and can contain identifiers (e.g. `/api/profiles/alan`).
  Accepted: they come from test fixtures, which are not production data.
- **The trace keeps project objects alive until the scenario ends** (to keep `id()` stable),
  which delays their finalizers. Accepted for test runs; would matter if this ever traced
  production.
- **No integrity check on trace files.** Anyone who can write to the repo can already change
  the code being visualised.

## Limits today

- One process: xdist workers aren't recorded (the recorder refuses `-n` > 0 and says so).
- Threads that existed before recording started aren't traced on the settrace backend.
- Celery, background tasks and multiple event loops are not followed.
- A function's view ends at its last executable line, so a closing bracket after it is cut.
- Inferred zones are heuristics; declare the ones that matter in `runshape.json`. A leading
  `**.` in a rule needs at least one segment (`**.models` doesn't match `models`); a
  trailing or inner `.**` may match none. A dot inside a segment is written `\.` (a Go
  module path: `example\.com.shop.**`), and a backslash `\\`; Python names never need it.
- The TypeScript recorder (recorder-ts/): a derived class's constructor is a span from its
  `super(...)` statement on, so its base constructor's span sits beside it rather than inside
  (one whose super() isn't a statement of its own isn't recorded, and its object is credited to
  the last recorded constructor); vitest fixtures (`test.extend`) are set up inside the test's
  function, so they record as the call, not setup; concurrent tests (`describe.concurrent`)
  share one scenario slot and aren't recorded reliably;
  each line is recorded once per call, and a caller's first 50 calls of a function are kept
  (recorderErrors says what was left out).
- Recording a running Go program (`runshape-go run`, not on Windows): a request is a scenario
  from its outermost net/http handler's entry to its return; work it hands to a goroutine is
  the request's while the call that started it is open, and background after (so is a loop
  started at startup). Handlers that aren't `(http.ResponseWriter, *http.Request)` (some
  frameworks') never start a request scenario: everything lands in startup and background.
  Background is capped like any caller (50 calls of a function between flushes) and is written
  when the recorder stops the program (SIGUSR1, which conflicts with a program's own use of it)
  or when main returns; work during shutdown after that, and everything after an os.Exit, is
  lost. Each request writes a file: heavy traffic means many files (no cap yet).
- The Go recorder (recorder-go/): a goroutine's first call hangs off what its creator was
  running, read from the "created by" line of its stack, so one created by code that isn't
  recorded (an HTTP server's connection goroutine) hangs off the test, and a call that
  continues work an earlier test started isn't recorded; routes are read from
  `HandleFunc`/`Handle` calls whose pattern is a string literal and whose handler is a named
  function or method (closures, handlers built by a call, chi/echo/gorilla methods aren't), a
  pattern's host stays in its path, and a request is labelled on the outermost handler (a
  middleware's ServeHTTP, when there is one); t.Parallel tests and parallel subtests aren't recorded (one scenario at a time);
  a closure that outlives the function that wrote it (a returned handler) records nothing once
  that function returns; Fuzz and Example functions run but aren't scenarios; a recorded call
  costs about 3 µs (a mutex and a stack read), so hot loops slow down a lot even past the
  per-caller limit.
- Routes (`packages/views/src/routes.ts`): a request belongs to the route whose handler ran
  under it: the registered function itself, or for a registered class (Django REST) a method
  named for a verb or viewset action (`post`, `create`, …), else the first of its methods that
  ran, so a class whose only methods to run were hooks (`get_permissions`) still counts as
  reached. One that reached no handler joins the route whose pattern matches its path
  (placeholders match one segment, a trailing `{rest...}` any; the most literal segments win,
  then the first listed; a regex that spans segments won't match), else it's grouped by its
  literal path. The method isn't matched: a route's group is per method. A class registered
  for several patterns picks the one with as many segments as the path, the first on a tie. A
  pattern renamed between recordings (`{id}` to `{slug}`) is one route gone and one new.
  A variant is the shape of the project code the whole request ran, authentication and
  renderers included (framework code is see-through; consecutive identical calls are one
  step, so a loop's length doesn't matter); two requests that took one shape but answered
  differently (the response status isn't recorded) are one variant. A changed variant is a
  new shape paired with a gone one that both reached, or both missed, the handler and share
  at least half the longer path in order (`CHANGED_VARIANT_MIN_SHARED`).
- Recordings kept per commit (`npm run runshape`, packages/library): only the TypeScript
  recorder (Runshape's own tests) records into them so far; Python's `runshape-review` and Go's
  recorder still keep their own latest/previous pair. Each recording stores a hash of the
  recorder's source; `compare` records the base again when it was made by another version, so
  only the code under test differs (`record` alone keeps what's there; `--again` forces).
  One run at a time: a second one refuses while `.runshape/recordings/.lock` names a live
  process. A recording is written beside the library and moved into place when complete; an
  interrupted one is cleared by the next run. `--fetch` fetches a branch (not a tag or a
  commit) and, on compare, only the base. Untracked files count as uncommitted changes (a new
  test file runs). Each recording keeps its commit's architecture: that commit's
  runshape.json as it was (the working tree's as on disk) and `architecture.json`, every
  project class and module with its zone, the rule and who decided it (user, llm, detected)
  or the behaviour it was inferred from, over every phase. An invalid runshape.json is kept
  and reported; its recording is placed by inference. Comparisons don't use it yet: both
  sides are still drawn with the current rules. Nothing prunes old recordings yet (`forget` deletes one). The demo's dev
  server reads .runshape/recordings and runs `git` for the list (local only; vite's host check
  and CORS apply before its routes).
- 3D shows at most 16 object cubes per class; wiring to further objects isn't drawn (the
  component panel still lists it).
- The diff compares only against the immediately previous recording. Recordings made before
  source snapshots existed fall back to line numbers, and say so.
- From the second-model review, not yet fixed: webview responses carry no request id, so a
  slow response for old view options can still land after newer ones; asyncio tasks are
  parented to the frame that ran the event loop, not the code that created the task; a run
  interrupted before session end has scenario files but no manifest; a graph node whose zone
  changed but whose call count didn't reads as unchanged in the diff; symlinks inside the
  project are followed by the path guard (the project root is trusted).

## Next

1. **3D, next steps**: flight controls; wiring for objects the framework built (DRF views,
   serializers) needs those objects' attributes scanned too, not only at the end of a
   project `__init__`.
2. Recording across xdist workers; Celery tasks as their own entry landmark.
