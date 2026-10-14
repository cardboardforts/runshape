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

How should change be highlighted?

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
