---
id: mvc
drawn: true
layout: triangle
zones: controller, model, view
---

# Model-View-Controller (including Django's MVT)

| Zone | Meaning |
|---|---|
| `controller` | Receives the request, picks the model and the view |
| `model` | Data and the rules on it, often active record |
| `view` | Renders the response |

In Django, *views are controllers*. Templates, serializers and renderers are the view.

**Allowed:** controller → model, controller → view, view → model.

**Forbidden:** model → controller, model → view (a model rendering itself), view → controller.

**External systems:** only `model`.

**Vocabulary:** controller `views`, `controllers`, `viewsets`, `handlers`. Model `models`,
`managers`, `signals`. View `templates`, `renderers`, `serializers`, `presenters`.

**Confirms:** models that query for themselves; per-request controllers.

**Contradicts:** separate repository and service layers doing the work: that's layered with MVC
names.

**Roles:** `mvc-family`, `boundary`.
