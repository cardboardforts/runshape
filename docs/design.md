# HexVis design

## What it's for

See an app the way it runs: a request comes in from the outside, passes the framework's
middleware and router, reaches a handler, flows through services, and leaves the process at a
database or another service. Each test is a named user behaviour, so each test is one
recorded **scenario**. Three views come out of the same recordings:

1. **Runtime map** — components (classes, modules, framework steps, external systems) and the
   calls between them, laid out left to right as a request travels and coloured by onion ring.
2. **Test wires** — a function's source with one wire per test; the bundle splits where tests
   take different branches, and lines no wire reaches are untested.
3. **Behavioural diff** — the recorder keeps the previous run; compare mode shows which
   journeys now behave differently: hops gained and lost, SQL that appeared or vanished,
   functions whose reached lines changed, outcome changes.

## What exists (first vertical slice)

| piece | where | status |
|---|---|---|
| pytest recorder, `settrace` (3.9+) and `sys.monitoring` (3.12+) backends | `recorder/` | done, tested on 3.9 / 3.11 / 3.12 / 3.14 |
| Django and FastAPI introspection: middleware, router, routes, databases | `recorder/.../frameworks/` | done |
| trace format v1 | `docs/trace-format.md` | done |
| core: parse, system graph, rings, component and function views, replay | `packages/core` | done, tested on real recordings |
| webview: graph (React Flow + ELK), scenario list, replay pulses, drill-in, wires | `packages/webview` | done; checked in a browser via the demo |
| VS Code extension: open, reload on re-record, open source at line, logging | `packages/extension` | done; end-to-end test in a real VS Code |
| behavioural diff (compare with previous recording) | `packages/core/src/views/run-diff.ts` | done; tested on a real before/after fix of the Django routing bug |
| 3D renderer, ring overrides, LLM layer advice | — | not started |

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

**Rings are inferred from behaviour, and labelled as such.** Inbound adapter: the framework
calls it inside the package that holds the route handlers. Outbound adapter: it calls an
external system. Core: neither. Inbound and also calling an external system is flagged
(`handler-touches-external`): the handler skips the core. On the Django example this flags
every view and puts ORM models in the outbound ring — which is accurate for an active-record
design, and is exactly the kind of thing the tool should surface. Explicit configuration (or
an LLM proposal you confirm) can override this later; inference is the floor, not the answer.

**Work handed to another thread keeps its parent.** FastAPI runs sync dependencies in a
thread pool. The recorder keeps the current span in a `ContextVar`, which `asyncio.to_thread`
and AnyIO copy into the worker, so the dependency nests under the request that needed it.
An earlier "most recently active span on another thread" heuristic raced and was replaced.

**Test doubles are their own ring.** Test code called *by* the app (FastAPI's
`FakeAsyncPGPool`) is a stand-in for an adapter, not the client.

**2D first.** The hard problem is aggregation, not rendering. The graph, function and replay
views are view models in core; a 3D renderer is another adapter over the same models. The
"classes on the floor, instances above them" idea needs the object/wiring data the recorder
already captures (`O` and `W` events).

**Known bugs are scenarios too.** pytest `xfail` is recorded as `xfailed`, never as a skip
or a pass, so a known-broken flow can be replayed.

## Observability

The extension logs logfmt lines to the **HexVis** output channel (VS Code adds timestamp and
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
| recorder → disk | **I**: traces capture data from the test run | SQL text but never parameters; URLs without query strings (API keys); request method and path only, no headers or bodies; traces live under `.hexvis/`, which projects should git-ignore | credentials and personal data from test fixtures land in files people commit or share |
| recorder → test process | **D**: tracing slows or breaks the suite | opt-in (`--hexvis`); callbacks never raise; `sys.monitoring` disables uninteresting code after first sight | a broken or unusably slow test run |

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
- Rings are heuristics (see above); there is no way to correct them yet.
- The diff compares reached lines by number (see Next), and only against the immediately
  previous recording.
- From the second-model review, not yet fixed: webview responses carry no request id, so a
  slow response for old view options can still land after newer ones; asyncio tasks are
  parented to the frame that ran the event loop, not the code that created the task; a run
  interrupted before session end has scenario files but no manifest; a graph node whose ring
  changed but whose call count didn't reads as unchanged in the diff; symlinks inside the
  project are followed by the path guard (the project root is trusted).

## Next

1. **Diff inside the function view**: before/after wires side by side. Today the diff lists
   lines by number, which is only meaningful when the function's own lines didn't move;
   matching lines by content (via the two source versions) fixes that.
2. **Ring overrides**: a checked-in `.hexvis/layers.json` mapping module patterns to rings,
   applied before inference; then LLM-proposed entries you confirm.
3. **3D renderer** over the same view models: classes on the floor, instances above, wires
   between them from the `W` events.
4. Recording across xdist workers; Celery tasks as their own entry landmark.
