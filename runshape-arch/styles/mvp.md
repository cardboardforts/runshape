---
id: mvp
drawn: true
layout: triangle
zones: view, presenter, model
---

# Model-View-Presenter

Classic Android, GWT, some test-driven UIs.

| Zone | Meaning |
|---|---|
| `view` | Passive; forwards events to the presenter |
| `presenter` | Decides what the view shows |
| `model` | Data and services |

**Allowed:** view → presenter, presenter → view (through an interface), presenter → model.

**Forbidden:** every other direction between zones. A view that reaches the model isn't passive.

**External systems:** only `model`.

**Vocabulary:** view `views`, `screens`. Presenter `presenters`, `presenter`. Model `models`,
`services`, `repositories`.

**Roles:** `mvc-family`, `boundary`.
