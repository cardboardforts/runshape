---
id: feature-sliced
drawn: false
layout: bands
zones: app, pages, widgets, features, entities, shared
---

# Feature-sliced design

Layers, top to bottom, each split into per-feature slices.

**Allowed:** a layer imports only from layers below it.

**Forbidden:** importing upward; slices on one layer importing each other.

**Vocabulary:** exactly the zone names, as folders.

**Roles:** `frontend`, `boundary`.
