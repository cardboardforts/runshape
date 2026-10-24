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
| trace model and format; system graph and zones (arch); component and function views (visualizer); replay (trace module) | `packages/core` (trace/), `architecture`, `visualizer`, `trace` | done, tested on real recordings |
| webview: graph (React Flow + ELK), scenario list, replay pulses, drill-in, wires | `packages/webview` | done; checked in a browser via the demo |
| VS Code extension: open, reload on re-record, open source at line, logging | `packages/extension` | done; end-to-end test in a real VS Code |
| behavioural diff (compare with previous recording) | `packages/trace/src/run-diff.ts` | done; tested on a real before/after fix of the Django routing bug |
| declared zones (`runshape.json`), provenance, onion violations, LLM zone proposals | `packages/architecture/src/zones.ts`, `zone-advice.ts` | done; the model call runs end to end against a fake model in the e2e test, and was checked by hand with a real model (Copilot) on the Django example on 2026-10-13 |
| 3D renderer (three.js): hexagon floor, tiles and objects, call arcs, replay packets | `packages/webview/src/three` | first version; layout tested, scene checked in a browser |

## Architecture

The same onion it's meant to show. Imports point inward only:

```
recorders:  recorder/ (Python), recorder-go/, recorder-ts/: each writes the trace format
kernel:     packages/core: the trace model and format (trace/), shared words, ports, the UI
            protocol
modules:    packages/architecture (styles, zones, the system graph, advice), packages/trace
            (the trace module: diffs), packages/visualizer (views of one run), and
            packages/explainer: values in, values out
workflows:  packages/workflows (the recordings workflow, the review bundle, the viewer
            session): what the apps run, calling modules in order
adapters:   packages/library (recordings and reviews kept, git), packages/adapters
            (recorders' runners, gh, the project's files, hashing), packages/infra (files,
            folders, the lock, language models: no Runshape import), all pointing at core
hosts:      packages/cli (command line, composition root), packages/extension (VS Code),
            packages/webview (UI) and its demo and dev server
```

The target (GOALS.md, "Target architecture") is a kernel every module points at and modules
that never import each other; PLAN.md's Phase 0b gets there. Until then,
`package-boundaries.test.ts` lists what still crosses (`NOT_YET`): core's UI protocol uses
the modules' view models (architecture, views, visualizer) until Phase 3.

`packages/core/test/package-boundaries.test.ts` checks every arrow from the imports
themselves, and that only infra, the adapters and the hosts touch the disk. `runshape.json`
places each package in a zone; `npm run runshape -- readmes` writes a guide in each folder,
with what doesn't fit.

- The kernel and the modules import nothing from Node, VS Code or React. File access comes
  in through ports: `TraceFiles` (declared by the kernel's trace format, `core/src/trace/data`) and the
  session's `SourceReader`.
- Storage, format and translation have separate owners. `packages/infra` keeps files and
  knows no format: it imports no other Runshape package, and its stores fit the domain's ports
  by shape. The kernel owns the format (`core/src/trace`): `model/` is the run in memory and the
  `RunSource` port, `data/` the wire shape, its parsing and a traces directory's layout. Each
  recorder translates its language's own trace into the format before writing it, so nothing
  past the recorder sees a language's native trace.
- `ViewerSession` (workflows) answers every request the webview can make. The extension forwards
  messages to it; the demo calls it directly. So the webview behaves identically in both.
- The trace format is the wire format between the Python and TypeScript halves. It is bent
  for size (tagged arrays); `packages/core/src/trace/data/parse.ts` maps it into named domain types at the boundary.

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
| trace file → extension | **T/E**: a crafted trace (committed by anyone with repo access) names `../../.ssh/id_rsa` as a source file | `safeSegments` (packages/infra) refuses absolute paths and `..` for every path from traces or the webview, in the extension's reads and the CLI's (`NodeFiles`); unit-tested | the viewer reads, and a click opens, arbitrary files |
| trace file → webview | **T**: crafted strings become markup | React escapes all text; CSP allows scripts only with a per-load nonce, no inline or remote code; `localResourceRoots` limits the webview to the bundle | script injection into a webview with access to the extension's message API |
| trace file → log | **T/R**: a value with a newline forges a log line | logger escapes newlines and quotes (unit-tested) | misleading audit trail |
| recorder → disk | **I**: traces capture data from the test run | SQL text but never parameters; URLs without query strings (API keys); request method and path only, no headers or bodies; traces live under `.runshape/`, which projects should git-ignore | credentials and personal data from test fixtures land in files people commit or share |
| extension → language model | **I**: "Suggest a zone" sends the component's name, functions, recorded neighbours and its own source to whichever model VS Code provides (e.g. Copilot's) | only on an explicit click per component; VS Code asks the person to allow model access the first time; the log records prompt size, never content | code leaves the machine without the person deciding it should |
| model answer → runshape.json | **T**: a model's (or prompt-injected) answer rewrites the architecture rules | the answer is validated (known zone, non-empty reason) and shown as a proposal; writing requires a modal confirmation showing the exact rule as JSON and whether it replaces one; saving is refused while runshape.json is unreadable, so a broken file is never overwritten; the request itself is validated | the rules file changes silently |
| CLI → language model (`compare --explain`) | **I**: the review and commit messages leave the machine, to Anthropic through the person's own `claude` login or their API key | only when asked (`--explain`); what's sent is the review's Markdown (names only: no source, no query text, no request as sent) and the commit messages between the two sides; the key is read from the environment, sent only in a header, and never in an error or log | code details leave without anyone deciding they should |
| review and commit messages → language model | **T/E**: the change's authors (an agent, maybe) write "ignore your instructions" into a commit message, a test or class name, or a rule's reason, to steer the explanation or make the model act | the prompt frames everything after its line as data, never instructions; commits are read NUL-separated, so a message can't forge another commit; `claude -p` runs with `--safe-mode` (no CLAUDE.md, hooks, plugins, skills or MCP servers), no tools, no saved session, from a temporary directory, so a model can only answer with text and the person's hooks never see the prompt; the answer must be the asked-for JSON, checked field by field, and each reason must cite a commit of the change or the review | a prompt-injected model runs commands or reads files with the person's permissions; hooks run on every explanation |
| CLI → language model (`readmes --describe`) | **I/T**: a folder's guide (names, zones, questions) and its files' opening comments leave the machine; a comment (an agent's, maybe) says "ignore your instructions" | only when asked, only with `--write`, and only for READMEs still holding the line left for a person; no code beyond those comments (at most 8 lines each); framed as data (a comment can fake the prompt's own headings: accepted, since the model has no tools and its answer is checked); the same `claude -p` restrictions as `--explain`; only the project's own plain files are read, not links; the answer must be one plain paragraph (no line breaks, headings, lists or invisible characters) with no HTML (runshape's markers are HTML comments), links or images, 700 characters at most | a folder's code leaves without anyone asking; a model's text moves the guide's markers or plants a link |
| model answer → README.md | **T**: the draft is wrong, or written to mislead | it's marked as drafted by the named model, sits where a person's words go, and is committed and read in the diff like code; runshape never rewrites it | a model's guess reads as the authors' |
| model answer → explanation.md | **T**: the answer's text is wrong, or written to mislead | saved apart from the review, which it never changes; headed "model's account" with the model's name; every reason cites a commit of the change (checked) or the review; the Markdown ends with what it was based on, and an explanation of an older review is deleted when the review is rewritten | a model's guess reads as a finding |
| pull request code → this machine (`--sandbox`, `review-requests`) | **E/I**: someone else's or an agent's tests, run unattended, read `~/.ssh`, tokens in the environment or other checkouts, or send them out | commits are recorded in a container: the recorder image is built from HEAD as committed (`git archive`: nothing untracked or uncommitted); the PR's code is a fresh worktree mounted read-only at /target, the output folder at /out, nothing else (no home, no Docker socket, no host environment); its tests run with no network, as the host user (1000 when that's root), read-only root filesystem, no capabilities, no-new-privileges, memory, process, per-file size and time limits. Trust is decided per commit, for every one `record` or `compare` touches (base and head), after any fetch, on the commit that gets recorded: yours means merged, a commit your default branch holds (`main`, here or on origin, as origin's HEAD names it). Everything else (other branches, your own unmerged ones too; tags; other remotes; PR bases; bare hashes) is recorded in the sandbox without being asked, and can't be compared with the working tree; fetches never bring tags. The default branch is the one `git config runshape.trustedBranch` names, else origin's HEAD (read in full); with neither, nothing counts as merged, and the working tree can't be compared until one is set. The working tree, as base or head, is recorded here as your own code, except when it's a pull request runshape fetched (a `refs/runshape/pr/*` commit) or one `gh pr checkout` made from a fork (its upstream is `refs/pull/<n>/head`), which is refused. Sandboxed recordings have ids of their own (`<commit>-sandbox`), fork points included | a PR's test steals credentials or plants something with the person's permissions |
| dependencies → sandbox | **T/E**: a PR adds a malicious package, or npm settings (`.npmrc`: `git=` a script of its own) that run code at install, where there's network | the PR's `.npmrc` is deleted and npm's config pinned (user and global config files that don't exist, scripts off, `git` the real one: checked against the reproduced attack); a lockfile must be npm 7+'s (lockfileVersion 2 or 3, with `packages`), and every package in it must say it comes from the npm registry (`resolved`), or nothing is installed: npm would otherwise resolve the rest itself, from anywhere. The only entries that may say no source are a workspace's folder (linked to, no node_modules in its path) and a bundled package, and those only with a plain version: without a source npm fetches name@version, so a version that's a URL is a fetch from it. No npm-shrinkwrap.json (npm would install from it instead); an entry with no source must say a plain package name too (npm fetches name@version). Beneath those checks, whatever they miss: the install container sits on an internal Docker network whose only other member is a proxy (recorder-ts/sandbox/registry-proxy.mjs, from this checkout) that connects to registry.npmjs.org over HTTPS and nowhere else, so npm has nothing to fetch from but the registry. The network's bridge has no address of its own (`inhibit_ipv4`), so its gateway isn't this machine answering (on Linux, `--internal` alone leaves host services on that address reachable, and a `git://` dependency wouldn't use the proxy); and Docker's resolver doesn't resolve outside names for a container only on internal networks, so not even a DNS lookup leaves (checked: the registry answers through the proxy; another host is refused; direct connections, the gateway, host.docker.internal and outside DNS names don't). Containers and the network are removed after each run, and whatever a killed run left is swept before the next | the PR's code runs at install, with network |
| sandbox → host | **T/E**: the PR's tests leave links in /out so the host's next write (`runshape.json`, `recording.json`) lands on a script it later runs, or the dev server serves any file; or they fill the disk | after the container exits, every entry in /out must be a plain file or folder, totalling under 2 GB, or the recording is refused before the host reads or writes there (the reproduced attack is a test); the dev server resolves links and serves nothing outside the recordings; the worktree and the output are removed whatever the tests did to them (a broken `.git`, a folder made unreadable), so nothing they leave stops a later run | a sandboxed PR writes or reads any file the person can |
| `gh` → GitHub (`review-requests`) | **I**: the person's GitHub token | only `gh` holds it (its own login); runshape only reads PR lists and fetches PR refs, writes nothing to GitHub, and never passes the token to a container | a token in a recording, a log or a container |
| recorder → test process | **D**: tracing slows or breaks the suite | opt-in (`--runshape`); callbacks never raise; `sys.monitoring` disables uninteresting code after first sight | a broken or unusably slow test run |

Accepted risks:

- **Request paths are recorded** and can contain identifiers (e.g. `/api/profiles/alan`).
  Accepted: they come from test fixtures, which are not production data.
- **The trace keeps project objects alive until the scenario ends** (to keep `id()` stable),
  which delays their finalizers. Accepted for test runs; would matter if this ever traced
  production.
- **A working tree is trusted as yours.** Code checked out some other way and then compared
  (`compare main`) runs here, as it would with `npm test`. Only runshape's own PR refs and
  fork PRs `gh pr checkout` made are recognised and refused: a same-repo PR it checks out
  tracks `origin/<branch>`, like a branch of your own, and isn't told apart. A local default
  branch that merged or pulled a PR without pushing counts as merged. An `origin` that is
  itself someone else's repository is out of scope: everything in it is theirs. Comparing your own unmerged branch
  records it in the sandbox, so it needs Docker.
- **The sandbox's limits are per file during the run**: a PR's tests can still write many
  files up to the time limit before the 2 GB check refuses the recording, so a run can fill
  the disk for a while. The nightly job runs `npm run runshape` from the checkout it's
  installed in: install it in a clone kept for it, not in one where a colleague's PR may be
  checked out. Linux: containers run as the host user, so mounted folders stay writable.
- **`--explain` chooses its model before using a saved answer**, so `claude --version` runs
  each time and `--explain=api` needs its key even when the answer is saved. `claude -p` signs
  in however `claude` is signed in, an `ANTHROPIC_API_KEY` in the environment included. On
  Windows, npm's `claude.cmd` isn't found (point RUNSHAPE_CLAUDE at the executable).
- **explanation.md is the model's text, unescaped.** Accepted while it's a local file: before
  it's ever posted as a PR comment, its Markdown needs neutralising (mentions, links, HTML).
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
- Routes (`packages/trace/src/routes.ts`): a request belongs to the route whose handler ran
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
  commit) and, on compare, only the base. `compare` measures from the fork point (`git
  merge-base` of base and head), not the base's newest commit: main having moved on since the
  branch left it would otherwise show every merge since as the branch undoing it (`--tip`
  compares with the newest commit). Untracked files count as uncommitted changes (a new
  test file runs). Each recording keeps its commit's architecture: that commit's
  runshape.json as it was (the working tree's as on disk) and `architecture.json`, every
  project class and module the recorded tests ran, with its zone, the rule and who decided it (user, llm, detected)
  or the behaviour it was inferred from, over every phase. An invalid runshape.json is kept
  and reported; its recording is placed by inference. Inferred placements follow what the
  tests did (mock the database and a class can move), so comparing two snapshots must keep
  rule changes apart from observed ones; rules no recorded component matched are listed. Comparisons draw each side with its own
  commit's rules (a kept recording brings them; elsewhere, as in the VS Code extension's
  latest/previous pair, both sides use the current file and the view says so), and compare
  mode's Architecture tab lists rules added, removed or reworded, what they moved, new code no
  rule covers, inferred zones that moved with behaviour, and rules that place nothing. A style
  changed in the branch draws both sides in the new one (the base's rules for the old style
  place nothing in it). Nothing prunes old recordings yet (`forget` deletes one). The demo's dev
  server reads .runshape/recordings and runs `git` for the list (local only; vite's host check
  and CORS apply before its routes).
- Folder guides (`readmes`): only folders some recorded code is in get a guide: a package no
  test touches at all isn't listed. "Used from other files" is the public names (exported,
  no leading underscore, capitalised in Go) that a call from another file reached in the
  recording; the TypeScript recorder can give a call the wrong parent across an `await`, which
  is why private names are left out rather than trusted. A source folder named `test` or
  `tests` is taken for tests. Zones are as good as runshape.json: with no rules, they're all
  inferred, and "does this belong here?" needs rules to mean much.
- 3D shows at most 16 object cubes per class; wiring to further objects isn't drawn (the
  component panel still lists it).
- The diff compares only against the immediately previous recording. Recordings made before
  source snapshots existed fall back to line numbers, and say so.
- From the second-model review, not yet fixed: webview responses carry no request id, so a
  slow response for old view options can still land after newer ones; asyncio tasks are
  parented to the frame that ran the event loop, not the code that created the task; a run
  interrupted before session end has scenario files but no manifest; symlinks inside the
  project are followed by the path guard (the project root is trusted).

## Next

[PLAN.md](../PLAN.md): phased, toward [GOALS.md](../GOALS.md). Smaller items still open from
before it: 3D flight controls; wiring for objects a framework built (DRF views, serializers);
recording across xdist workers; Celery tasks as their own entry landmark.
