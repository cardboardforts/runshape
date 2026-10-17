# Ideas, parked

Ideas for where Runshape goes next, kept until they're evaluated or discarded. Nothing here is
decided. When an idea is taken up, link the work; when it's dropped, say why rather than deleting
it.

The question behind most of them (2026-10-14): how should the running shape of a diff be
visualized? The current abstractions may be too granular, or the tests being recorded may not be
the right ones: unit tests show how code behaves under a test harness, not how the program runs.

## 1. Record how a real run starts up, not just unit tests

Unit tests have their place, but the value is seeing how a program will run in production. That
points at end-to-end tests: start the program the way it really starts, drive it from outside, and
record that.

- **Already there:** the Python recorder records the FastAPI and Django examples' API tests, which
  go through the real app factory, middleware and routing ("Include setup" shows app startup).
  The Go example (examples/go-shop) has e2e tests that wire the app as main does and drive the
  real router in process, recorded by recorder-go. The TypeScript recorder records unit tests.
- **To decide:** what counts as the run (a process from `main` to shutdown, a request through a
  deployed stack?); whether recording attaches to a test harness or to the process itself; how a
  long-running process maps onto scenarios (one per request? per user journey?).
- **First evaluation (2026-10-14):** `npm run run-go -- <module> <main package>` builds a Go
  program instrumented, runs it, and records whatever traffic it's sent until Ctrl-C (fixture
  `go-shop-running`: go-shop's real binary and a curl session). What it showed:
  - Startup (main wiring the app) is a scenario of its own, and the clearest picture of the
    architecture there is: the composition root building every layer.
  - One scenario per request is a natural unit, the same shape an e2e test gives. Tests and
    production differ in what traffic drives the program, not in what a recording looks like.
  - Requests to one route take different paths (placed, refused by the rules, malformed), and
    that is the interesting part. Real traffic would mean hundreds of scenarios per route: the
    next abstraction is probably a route with its path variants, not a list of requests, which
    is the "too granular" question again and ties into idea 4.
  - Open: Python and TypeScript have no process mode; request paths carry ids (`/orders/ord-1`),
    so grouping needs the route pattern, and recording real traffic raises what's safe to keep
    (only method and path are recorded today).
- **Taken up (2026-10-14): the route view.** The sidebar's Routes tab groups requests by the
  route that served them (read from the handler they reached, so ids in paths don't matter),
  and a route's requests by the shape of the code they ran. Each variant is told against the
  route's main path by what it calls at all: go-shop's refused order "skips
  MemoryRepository.Save", the malformed one "skips Service.Place, Order.Problems,
  MemoryRepository.Save", Django's anonymous POST "never reached the handler". In compare mode
  a new shape that mostly follows a gone one is one variant changed (the slug refactor: "now
  calls ensure_slug_available, _normalize_title", marked in place as a diff hunk), which is
  idea 4's question answered at one level: change is shown per way through a route, not per
  test. What it showed:
  - Unit-test recordings group too (Django: 24 requests, 9 routes); what a route did differently
    is legible without opening a call tree. The main path reads best with real traffic, where
    "most taken" means something; with tests it's whichever path the tests repeat.
  - Without the response status, "refused" is inferred from what didn't run. Recording the
    status (and nothing else of the response) would name variants by their outcome.
  - Next questions: whether the graph should draw a route's variants as one picture (the main
    path solid, variants as branches off it); whether routes are the right first view for a
    program with real traffic, ahead of the test list.

## 2. A Kubernetes / Terraform view of how it runs in production

How it runs in production may also need the infrastructure: what is deployed where, and what can
reach what.

- **Already there:** nothing. External systems appear only as boxes the app calls (postgres, http).
- **To decide:** what it would look like; whether it comes from declared config (manifests, plan
  output) or from what's observed running; how it connects to the program-level views.

## 3. Zoom from containers down to functions

Microservices, and how programs connect to each other, threaten to explode the complexity of
something already close to too complex. It needs a good abstraction. A starting point is levels to
zoom through:

1. a fully running Docker container (and its neighbours),
2. the running program inside it,
3. its modules,
4. the classes and how they interact,
5. the functions inside the classes.

- **Already there:** levels 3–5 in part. The system graph shows modules and classes (with
  "collapse middleware" as one grouping knob), the component view lists a class's functions, and
  the function view shows lines. There is no level above one program.
- **To decide:** what links programs (traces across services need a shared request id, which is
  correlation-ID territory); whether each level is its own view or one zoomable canvas; which level
  a diff opens at.

## 4. Better ways to visualize change

How should change be highlighted? (First step taken: the route view, under idea 1.)

- **Already there:** compare mode marks boxes and edges added, removed or changed; replay merges
  both runs' hops; the review ranks tests (now failing, silently changed, …) and lists moved code;
  execution and statement diffs per test and function.
- **To decide:** what the first glance should answer (where did behaviour change? how much?);
  whether change is shown at the zoom level where it happened and summarised above it (idea 3).

## 5. Shapes beyond 3D boxes, by pattern

Organise by pattern: a factory could look like a little factory, a chain of responsibility like a
chain.

- **Already there:** architecture styles (hexagonal, layered, MVC, …) choose the floor's shape and
  zones; components are boxes.
- **To decide:** how patterns are recognised (names, the observed call shape: a chain is a
  sequence of handlers each calling the next; a factory constructs what it returns); which
  patterns earn a shape of their own; whether shapes help reading or only look good.

## 6. A README per folder, written from the architecture

When browsing a repo on GitHub, a folder's README.md says what the folder is for. Most of
Runshape's folders could have one: what the folder is for, what kinds of files, classes and
functions belong there, and how to think about what's going on in it. Contents:

- a listing of the files, the classes in each, and the public or important functions;
- the folder's role in plain terms, from its zone (style, rules, placements).

Generated by a skill in the LLM architecture module (module 5): it detects the
architecture, then documents it for people.

The bigger value may be what writing it exposes: "this file doesn't belong here", or "this
function doesn't fit the folder's theme". Those findings prompt refactoring decisions.

- **Already there:** placements (architecture.json: every recorded class and module, its
  zone and why), the architecture-shape skill, zone advice and explanations through the
  LanguageModel port (claude -p, the Anthropic API, VS Code's Language Model API).
- **To decide:**
  - Generated or hand-kept? Probably generated, marked as such, and committed with the code
    so reviews show it changing, like runshape.json.
  - How to stop it drifting: regenerate on compare and diff it.
  - Whether "doesn't fit here" findings become proposed zone rules or review questions (they
    look like the Architecture tab's "needs a decision" and "moved with behaviour" lists).
  - Which folders get one (packages and their src/, not every leaf).
- **Taken up (2026-10-16):** `npm run runshape -- readmes [--write]` keeps a guide in each source
  folder's README.md, between markers (a README without them is someone's own, left alone):
  the folder's main zone, each file's zone, classes and entry points (public names a call from
  another file reached: its interface as used, helpers left out), files
  with no functions of their own, and questions: a file in another zone than the folder, one
  holding two zones, calls against the style, code no test ran. Mechanical, from the working
  tree's recording (views/folder-guide.ts, core/folder-readme.ts); no model yet. On Runshape it
  found the one untested source file (cli's shell-recorder.ts); with every zone inferred (no
  runshape.json) it can't yet ask "does this belong here?" of Runshape's own code.
  Next: a runshape.json for Runshape (the zone-placement pass), and the folder prose from a model.
- **First evaluation (2026-10-16):** the skeleton (files, classes, zones and why) comes from
  placements with no model involved; only the plain-language prose needs one. Placements
  cover what the recorded tests ran, so a folder's untested files would be missing from its
  README: worth listing them as "not seen running" rather than leaving them out.
