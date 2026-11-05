---
id: flux
drawn: false
layout: cycle
zones: views, actions, store, effects
---

# Flux / Redux

One-way data flow: view → action → reducer → store → view.

| Zone | Meaning |
|---|---|
| `views` | Render state, dispatch actions |
| `actions` | Plain descriptions of what happened |
| `store` | Reducers: new state from old state and an action |
| `effects` | Side effects: thunks, sagas, middleware |

**Allowed:** the cycle above. Side effects only in `effects`.

**Forbidden:** components mutating shared state directly; side effects in a reducer.

**Roles:** `frontend`, `boundary`.
