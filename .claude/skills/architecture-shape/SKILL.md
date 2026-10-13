---
name: architecture-shape
description: Work out which architecture a codebase is shaped like (hexagonal, layered/n-tier, MVC/MVT, MVVM, MVP, or a frontend style such as container/presentational or feature-sliced), map its modules onto that style's zones with evidence, and propose a zones file for the HexVis viewer. Use when asked "what architecture is this?", "how is this organised?", to set up HexVis zones/zones for a project, or to suggest how to reorganise code toward a style.
---

# Architecture shape

You are deciding how to *draw* a codebase: which architectural style it follows (or is
closest to), and which of its modules belong in each of that style's zones. The output is a
proposal a person confirms; never write config files without their go-ahead.

Be honest about mixed shapes. Most real codebases are a hybrid ("Django MVT with a services
layer bolted on", "layered, except the handlers reach straight into the repositories"). Name
the hybrid; don't force a pure style.

## 1. Gather evidence (cheap first)

1. **Framework and language**: manifest files (`pyproject.toml`, `package.json`, `go.mod`, …)
   and entry points. Frameworks imply defaults: Django → MVT, Rails → MVC, Angular → MVVM-ish
   components + services, FastAPI/Express → whatever the authors built.
2. **Module vocabulary**: list packages and modules 3–4 levels deep. Note role words
   (`views`, `models`, `controllers`, `routes`, `services`, `domain`, `ports`, `adapters`,
   `repositories`, `viewmodels`, `presenters`, `stores`, `components`, `features`).
3. **Dependency direction** from imports. For Python, run the bundled script (stdlib only,
   parses with `ast`, imports nothing):

   ```sh
   python3 <this skill>/scripts/import_matrix.py app --depth 2   # depth 3-4 for Django apps
   ```

   It prints a package-to-package import count and every import that runs against the
   dominant direction between two packages, with file and line — cite those directly. Who
   imports whom is the strongest static evidence: in a hexagon the core imports no adapter;
   in layers, lower layers import nothing above them. For other languages, approximate with
   `grep` on import statements.
4. **Runtime evidence, only if it would settle something**: when imports are ambiguous
   (e.g. dependency injection hides who calls whom) and a HexVis recording exists
   (`.hexvis/traces/latest.json`), the scenario files show what receives requests and what
   talks to the database. Skip it otherwise; static evidence is usually enough for the shape.

Stop gathering once the picture is clear; this is a judgement, not an audit.

## 2. Compare against the catalogue

See [profiles.md](profiles.md) for each style's zones, allowed dependency directions,
vocabulary, tell-tale signs and counter-signs. For the top two or three candidates, list
the evidence for and against. A counter-sign outweighs vocabulary: a package called
`domain` that imports SQLAlchemy is not a hexagonal core.

## 3. Decide

- **Confidence**: *high* when vocabulary, import direction and (if used) runtime evidence
  agree and there are at most a couple of contradictions; *medium* when they agree on the
  style but contradictions are systematic (a whole layer skipped); *low* when the evidence
  splits between styles.
- **Name a hybrid** when the best style fits most of the code but a contradiction is a
  pattern rather than an exception (e.g. "layered, routes call repositories directly").
- **Layered: assume relaxed** (any layer may call any lower one) unless the user says
  strict; report layer-skipping as an observation, not a violation. Calls *upward* are
  always contradictions.
- **Cross-cutting and composition code** (settings, logging, constants, the app factory /
  `main`, the composition root) goes in the shared zones below, not forced into a layer.
- **DTOs / wire schemas** (request and response models) belong with the presentation /
  inbound zone: they exist for the wire format, not the domain.

## 4. Propose

Reply with:

- **Style** (or hybrid), the **layout** to draw it with (`hexagon`, `bands`, `triangle`), and
  a confidence (low / medium / high) with one sentence of why.
- **Zone rules**, most specific first, each with a reason, using the zone ids listed for the
  style in profiles.md plus the shared zones `cross-cutting` and `composition`. Use
  dotted-name globs (`*` within one segment, `**` any number). The example is abbreviated;
  a real proposal covers every top-level package:

  ```json
  {
    "version": 2,
    "style": "layered",
    "layout": "bands",
    "zones": [
      { "match": "app.models.domain.**", "zone": "business", "reason": "pydantic domain models used by services" },
      { "match": "app.api.**", "zone": "presentation", "reason": "FastAPI routes and dependencies" },
      { "match": "app.services.**", "zone": "business", "reason": "workflow logic called by routes" },
      { "match": "app.db.**", "zone": "data", "reason": "repositories and SQL" }
    ]
  }
  ```

- **Contradictions**: dependencies that break the proposed style (e.g. "4 route handlers call
  repositories directly"), each with where to look.
- **If they want to move toward the style**: the two or three highest-leverage moves, small
  enough to review one at a time (e.g. "introduce a `UsersPort` in the domain and make
  `UsersRepository` implement it; then routes depend on the port").
- **Questions** you couldn't settle from the code.

Ask before writing anything. When confirmed, write the zones file the project uses. Today
HexVis reads `hexvis.json` version 2 (`{"version": 2, "style": "hexagonal", "zones": [...]}`)
and draws only the hexagonal style, with zone ids `inbound-adapter`, `core`,
`outbound-adapter`; for any other style, give the proposal in the format above and say it
can't be drawn yet (see `docs/architecture-profiles.md`).
