# Styles

How an area of code is built. A style has zones, and says how calls may flow between them. Claiming
a style is checkable: the **Forbidden** lists below are facts the code can contradict.

Answering "this system has a shape" stops the drill-down, and everything inside uses that style's
zones. Files with `drawn: true` are the styles Runshape can draw today, matching
`packages/architecture/src/profiles.ts`. The others can be claimed in a map, but not drawn yet.

Most real code is a hybrid ("Django MVT with a services layer bolted on"). Pick the closest style
and put the hybrid in the map's `note`. Don't force a pure style.

These two zones apply in every style:

shared_zones: cross-cutting, composition

- `cross-cutting`: settings, logging, constants, utilities used everywhere. Anything may import it,
  and it imports nothing project-specific.
- `composition`: the app factory, `main`, or composition root that wires the others. It may import
  everything, and nothing imports it.

In a map, both are accepted as zones. In `runshape.json`'s own `zones` they aren't: there, mark a
composition root with `"role": "composition-root"` on a rule.

| Style | Drawn | Layout | Use for |
|---|---|---|---|
| [hexagonal](hexagonal.md) | yes | hexagon | Backends with the domain at the center |
| [layered](layered.md) | yes | bands | Backends stacked top to bottom |
| [mvc](mvc.md) | yes | triangle | Controllers, models and views, including Django MVT |
| [mvvm](mvvm.md) | yes | triangle | UIs with bindings to a view model |
| [mvp](mvp.md) | yes | triangle | UIs with a passive view |
| [container-presentational](container-presentational.md) | no | bands | React apps split by data and display |
| [feature-sliced](feature-sliced.md) | no | bands | Frontends sliced by feature |
| [flux](flux.md) | no | cycle | One-way data flow, such as Redux |
