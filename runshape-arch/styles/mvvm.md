---
id: mvvm
drawn: true
layout: triangle
zones: view, viewmodel, model
---

# Model-View-ViewModel

Vue with Pinia or composables, Angular, Knockout, SwiftUI, WPF.

| Zone | Meaning |
|---|---|
| `view` | Binds to the view model; no logic |
| `viewmodel` | State and commands for one view |
| `model` | Data and services |

**Allowed:** view → viewmodel, viewmodel → model.

**Forbidden:** every other direction between zones.

**External systems:** only `model`.

**Vocabulary:** view `views`, `components`, `pages`. View model `viewmodels`, `viewmodel`, `stores`,
`composables`. Model `models`, `services`, `api`.

**Contradicts:** components fetching data and holding business rules directly.

**Roles:** `mvc-family`, `boundary`.
