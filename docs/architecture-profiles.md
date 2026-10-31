# Beyond the hexagon: architecture profiles

Runshape draws every app as an onion because that's the architecture it was built to check.
Most apps aren't one: Django is MVT, many FastAPI/Express apps are layered, React and Vue
apps have their own shapes. This is the plan for drawing each app in its own shape, and for
the rename that would come with it. Status: **ring → zone is done** (code, UI, docs, and
`runshape.json` version 2 with a `"style"` field, still reading version 1). **Profiles are
built** (2026-10-13): `packages/architecture/src/profiles.ts` defines hexagonal, layered, MVC, MVVM
and MVP; zones, rules, smells and violations come from the active profile. The viewer can
draw any style ("Draw as", never saved), lays layered out top to bottom in 2D and as
terraces in 3D, MVC/MVVM/MVP as a triangle, and "Detect the shape from this recording"
ranks the styles with their evidence; adopting one rewrites `runshape.json` (style plus
proposed rules, most specific first, `by: "detected"`) after the person confirms. Not yet:
the skill behind a model call in VS Code, frontend styles, the cycle (Flux) layout.

## What changes conceptually

| today | with profiles |
|---|---|
| "ring": inbound adapter / core / outbound adapter | **zone**, defined by the active profile |
| one rule for violations (calls against the onion) | each profile lists its **allowed calls between zones**; anything else is a finding |
| hexagon floor in 3D, ring-coloured columns in 2D | the profile's **layout**: hexagon, bands (layered, feature-sliced), triangle (MVC/MVVM/MVP), cycle (Flux) |
| `runshape.json` v1: `{ "rings": [{ match, ring, reason }] }` | v2 (done): `{ "style": "hexagonal", "zones": [{ match, zone, reason, by }] }`; layout to come from the style |
| inferred ring when no rule matches | inferred zone from the profile's vocabulary and runtime evidence |

Framework, test-double and external zones stay fixed: they're facts about the code, not
choices in a style.

## Composition roots

A rule may say `"role": "composition-root"`: code that builds the adapters and hands them in
(an app's main, FastAPI's dependency functions). Its calls are wiring, so they're never
findings, whatever zones they cross. Everyone else's calls are judged as before. Declared,
not detected: a handler that happens to build things is still a handler.

## Regions: a style per area (`runshape.json` v3)

A **region** is an area of the code with one style; a **zone** is a slot inside that style.
A region sits inside one zone of the area around it, whole, and may hold regions of its own:

```json
{
  "version": 3,
  "style": "hexagonal",
  "zones": [{ "match": "packages.cli.**", "zone": "inbound-adapter", "reason": "the command line" }],
  "regions": [
    {
      "name": "trace", "match": "packages.trace.**", "in": "core", "style": "layered",
      "reason": "diffs on top of the run model",
      "zones": [{ "match": "packages.trace.src.review", "zone": "presentation", "reason": "what a reviewer reads" }],
      "regions": []
    }
  ]
}
```

- A region's `match` is a subtree: a name, or a name and everything under it (`a.b.**`), so
  "inside" is checked when the file loads.
- The innermost region a name is in decides its zone; at each level above, it sits in the
  zone its region is `in`. A region beats every rule around it, whatever their order: a broad
  `**` rule listed first still doesn't reach inside a region.
- Load errors (every one reported): a rule above a region that only matches names inside it
  (it would split the region across zones), a region outside its parent, two regions that
  overlap, an `in` that isn't a zone of the parent's style, a region rule outside its region.
- A file without regions is still written as version 2.

## Detecting the shape

Three layers, cheapest and most explainable first, mirroring how rings work today:

1. **Deterministic scoring** (`packages/architecture/src/architecture.ts`). Scores each
   profile on module vocabulary *and* runtime behaviour, and proposes zone globs with the
   evidence for each. On the examples: FastAPI RealWorld → **layered** (0.96) over hexagonal
   (0.77) — the deciding evidence is behavioural: route handlers call repositories
   directly, normal for relaxed layering, a contradiction for a hexagon. Django RealWorld →
   **MVC/MVT** (1.0): `views` are controllers, models query for themselves (active record),
   serializers/renderers are the view.
2. **Judgement** — the `architecture-shape` skill (`.claude/skills/architecture-shape/`).
   Vocabulary is ambiguous (a Django app literally named `core`; `app.models` holding both
   ORM tables and domain models); a model with the code in front of it resolves that,
   names hybrids, lists contradictions, and suggests the few highest-leverage moves toward
   the style. The same skill text can back the VS Code "suggest" button the way ring advice
   does today (facts + prompt in core, model call in the extension).
3. **A person confirms**; the zones file is written only then — the same rule as rings.

**First trial of the skill** (a separate agent, read-only, on FastAPI RealWorld): it proposed
relaxed 3-tier layered with medium-high confidence, and — from imports, which the
recording-based scoring can't see — found an upward dependency the deterministic pass
missed: `app/models/domain/users.py` imports `app.services.security`. Its feedback shaped
the skill's second version: canonical zone ids, shared `cross-cutting` and `composition`
zones, a confidence rubric, "assume relaxed layering", where DTOs go, and a bundled
`scripts/import_matrix.py` that lists against-the-grain imports with file and line.

## Frontends (React, Vue)

The shape detection works from static evidence alone (imports, folders), so it applies to
frontends today. *Recording* them needs a JavaScript recorder; the realistic options:

- **Playwright + V8 coverage/CDP profiler**: end-to-end tests become scenarios (like pytest
  tests now); the CDP `Profiler` gives call trees with source positions. Lowest effort.
- **A Babel/SWC instrumentation plugin** in the dev build: exact component and hook
  calls, and render/prop flows, at the cost of a build-time step.
- React DevTools' profiler hooks for component renders only.

The trace format is language-neutral already (functions, spans, lines, boundaries); a JS
recorder would write the same files. Framework landmarks become router and store
(Redux/Pinia) instead of middleware.

## The rename

Renaming now is cheap and gets cheaper never: ~350 mentions in 77 files, almost all
mechanical (Python package, pytest options `--runshape`/`runshape_*`, `.runshape/`, `runshape.json`,
trace format name, VS Code ids, npm scope, docs). With the tests and the e2e run it's an hour
of work and a reviewable single commit. The trace format name would change too; fixtures
can be rewritten, since there are no outside users.

On the name: "arcview" is free on npm and PyPI, but **ArcView is a long-standing Esri GIS
product**, which risks confusion (and trademark trouble if this were ever published).
Worth picking something without that baggage before doing the mechanical part.

The bigger lift is conceptual, not textual: "ring" → "zone" across core, UI and docs, and
making layout and violation rules come from the profile. Suggested order:

1. Rename (mechanical, one commit) — waiting on the name.
2. ~~Ring → zone, zones v2 config~~ (done); profile-driven violations in core next, with
   hexagonal as the default profile (behaviour unchanged).
3. Layered "bands" layout in 2D and 3D; then the triangle.
4. The skill behind a "Detect architecture" command, proposing the v2 config.
