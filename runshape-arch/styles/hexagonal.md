---
id: hexagonal
drawn: true
layout: hexagon
zones: inbound-adapter, core, outbound-adapter
---

# Hexagonal (ports and adapters, onion, clean)

The domain sits at the center with no outward dependencies. Everything else is an adapter pointing
in.

| Zone | Meaning |
|---|---|
| `inbound-adapter` | The framework hands it requests |
| `core` | Domain and application logic: no I/O, no framework |
| `outbound-adapter` | Talks to the outside world for the core |

**Allowed:** inbound → core, core → outbound (through a port the core owns), outbound → core.

**Forbidden:**
- inbound → outbound: a request handler using an adapter directly, with no core in between
- core → inbound, outbound → inbound: the dependency points outward

**External systems:** only `outbound-adapter`.

**Vocabulary:** inbound `api`, `routes`, `handlers`, `controllers`, `cli`, `consumers`. Core
`domain`, `core`, `usecases`, `use_cases`, `services`, `entities`, `ports`. Outbound `adapters`,
`infrastructure`, `infra`, `repositories`, `gateways`, `clients`, `db`.

**Confirms:** interfaces in the core implemented elsewhere; a composition root wiring adapters into
the core; core tests that run with no database.

**Contradicts:** core modules importing the ORM or an HTTP client; handlers calling repositories.
A package called `domain` that imports SQLAlchemy is not a hexagonal core.

**Roles:** `ports-and-adapters`, `tactical-ddd`, `cqrs`, `application`, `boundary`.
