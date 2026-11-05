---
id: layered
drawn: true
layout: bands
zones: presentation, business, data
---

# Layered (n-tier)

Stacked layers, top to bottom. Runshape assumes relaxed layering: any layer may call any layer
below it.

| Zone | Meaning |
|---|---|
| `presentation` | Routes, views, request and response schemas |
| `business` | Services, rules, workflows |
| `data` | Repositories, queries, persistence |

**Allowed:** presentation → business, business → data, presentation → data.

**Forbidden:** any call upward (business → presentation, data → presentation, data → business).

**External systems:** only `data`.

**Vocabulary:** presentation `api`, `routes`, `views`, `controllers`, `schemas`, `serializers`,
`web`, `dependencies`. Business `services`, `business`, `logic`, `domain`, `managers`. Data `db`,
`repositories`, `dal`, `dao`, `queries`, `persistence`, `models`.

**Confirms:** services between routes and repositories; repositories returning model objects.

**Contradicts:** lower layers importing upper ones; business logic living in route handlers. Skipping
a layer is an observation in relaxed layering, not a violation. Note it, and ask whether the person
wanted strict layers.

**Roles:** `tactical-ddd`, `cqrs`, `application`, `boundary`.
