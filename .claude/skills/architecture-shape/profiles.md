# Architecture profiles

For each style: its zone ids (use these exact ids in proposals), the dependency directions it
allows (anything else between zones is a finding), the names it tends to use, and what
confirms or contradicts it.

**Shared zones, in every style:**
- `cross-cutting`: settings, logging, constants, utilities used everywhere. Anything may
  import it; it imports nothing project-specific.
- `composition`: the app factory / `main` / composition root that wires the others together.
  It may import everything; nothing imports it.

## Backend

### Hexagonal / ports and adapters / onion / clean
- **Zones**: `inbound-adapter` · `core` (domain + application) · `outbound-adapter`. Layout: hexagon. (These are the ids Runshape draws today.)
- **Allowed**: inbound → core; core → port interfaces (implemented by outbound adapters);
  outbound → core types. The core imports no framework, ORM or HTTP client.
- **Vocabulary**: `domain`, `core`, `ports`, `adapters`, `application`, `usecases`, `infrastructure`.
- **Confirms**: interfaces/ABCs/Protocols in the core implemented elsewhere; a composition
  root that wires adapters into the core; core tests that run with no database.
- **Contradicts**: core modules importing the ORM; handlers calling repositories directly.

### Layered / n-tier (3-tier is the common case)
- **Zones**: `presentation` · `business` · `data` (more tiers for n-tier). Layout: horizontal bands, top to bottom.
  Request/response schemas (DTOs) are `presentation`.
- **Allowed**: each layer calls the one below (strict) or any below (relaxed). Nothing calls up.
- **Vocabulary**: `api`, `routes`, `controllers`, `services`, `business`, `repositories`, `dal`, `dao`, `db`.
- **Confirms**: services between routes and repositories; repositories return model objects.
- **Contradicts**: lower layers importing upper ones; business logic in the route handlers.

### MVC (and Django's MVT)
- **Zones**: `controller` · `model` · `view`. Layout: triangle.
- **Allowed**: controller → model, controller → view, view → model (to read).
- **Vocabulary**: `controllers`, `models`, `views` (Django: *views are controllers*,
  templates/serializers/renderers are the view), `helpers`.
- **Confirms**: models that query for themselves (active record); per-request controllers.
- **Contradicts**: separate repository/service layers doing the work (it's layered with MVC names).

## Frontend

Recording frontends needs a JavaScript recorder, which Runshape doesn't have yet; static
evidence (imports, folder layout) still works for the shape.

### MVVM (Vue with Pinia/composables, Angular, Knockout, SwiftUI/WPF)
- **Zones**: `view` · `viewmodel` · `model`. Layout: triangle.
- **Allowed**: view → view model (bindings); view model → model/services. Views hold no logic.
- **Vocabulary**: `viewmodels`, `stores`, `composables`, `components`, `services`.
- **Contradicts**: components fetching data and holding business rules directly.

### MVP (classic Android, GWT, some test-driven UIs)
- **Zones**: `view` · `presenter` · `model`. Layout: triangle.
- **Allowed**: view ↔ presenter (through an interface); presenter → model. View is passive.

### Container / presentational (React)
- **Zones**: `container` (data and state) · `presentational` (props in, events out) · `services` (API clients).
- **Allowed**: containers → presentational, containers → services. Presentational components import no API clients or stores.
- **Contradicts**: `useEffect` data fetching inside leaf components.

### Feature-sliced design
- **Zones** (layers, top to bottom): `app` · `pages` · `widgets` · `features` · `entities` · `shared`. Layout: bands.
- **Allowed**: a layer imports only from layers below; slices on one layer don't import each other.
- **Vocabulary**: exactly those folder names, each split into per-feature slices.

### Flux / Redux (unidirectional data flow)
- **Zones**: `views` · `actions` · `store` (reducers) · `effects` (side effects). Layout: a cycle.
- **Allowed**: view → action → reducer → store → view; side effects only in middleware/thunks/sagas.
- **Contradicts**: components mutating shared state directly.
