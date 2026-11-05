---
id: container-presentational
drawn: false
layout: bands
zones: container, presentational, services
---

# Container / presentational

React apps split between components that own data and components that only display it.

| Zone | Meaning |
|---|---|
| `container` | Data and state: pages, route components, components that fetch |
| `presentational` | Props in, events out |
| `services` | API clients |

**Allowed:** container → presentational, container → services.

**Forbidden:** presentational components importing API clients or stores.

**Contradicts:** data fetching in a `useEffect` inside a leaf component.

**Roles:** `frontend`, `boundary`.
