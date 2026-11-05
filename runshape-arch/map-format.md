# The map format

A project's map is the `map` section of its `runshape.json`. This file is the contract between
the catalog (this folder), the [runshape-map skill](../.claude/skills/runshape-map/SKILL.md) that
writes the map, and the [later diff work](../docs/tagged-diffs.md) that reads it.

`check-map.mjs` in the skill validates all of this. Runshape keeps the section when it rewrites
`runshape.json`, but doesn't read it yet, so nothing drawn or checked by Runshape changes.

Nested regions in `runshape.json` can't hold this today. A region is a single subtree with a
required style, and needs a zone in its parent. "Backend" can span three folders and have no style,
and "Database" may have no code. When the viewer learns the map, regions become the bottom of this
tree.

```json
{
  "version": 2,
  "zones": [],
  "map": {
    "version": 1,
    "systems": [],
    "expects": [],
    "exceptions": [],
    "patterns": []
  }
}
```

`by` and `pathsBy` use Runshape's existing values: `user`, `llm` or `detected`. A person's own
words are `user`. A model's mapping of those words to folders is `llm`, and is approved in the
diff at merge like any other placement.

## Systems

```json
{
  "name": "Backend",
  "description": "Everything behind the portals",
  "by": "user",
  "state": "parts",
  "systems": [
    {
      "name": "Core",
      "description": "The lab's domain and its API",
      "by": "user",
      "paths": ["api/core/**", "api/config/**"],
      "pathsBy": "llm",
      "state": "shape",
      "style": "layered",
      "note": "layered, with routes reaching repositories directly",
      "zones": [{ "paths": ["api/core/api/**"], "zone": "presentation", "reason": "Ninja routers", "by": "user" }],
      "roles": [{ "role": "dto", "paths": ["api/core/schemas/**"], "reason": "wire shapes", "by": "llm" }]
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `name` | Unique among its siblings, with no `/`. A system's path is its names joined by `/`: `Backend/Core` |
| `description` | What it's for, in the person's words |
| `paths` | From the project root: a file, a folder, or a glob. `**` is any depth, `*` stays inside one segment. Empty or absent is allowed |
| `state` | See below |
| `style` | `shape` only: an id from [styles/](styles/) |
| `note` | The hybrid in words, when no style fits exactly |
| `zones`, `roles` | Optional detail inside a `shape` |
| `systems` | The parts |

A parent with no `paths` covers whatever its parts cover. Paths are file paths rather than
Runshape's dotted names because they work for any language with no recording. Turning them into
dotted names is part of the later work.

### States

Each level answers one question: **is this made of parts, does it have a shape, is it just a plain
box, or do you not know?**

| `state` | Meaning | Needs |
|---|---|---|
| `parts` | Made of smaller systems: go deeper | `systems`, once someone goes there |
| `shape` | Has a style: the recursion stops. It holds no `systems` | `style` |
| `plain` | Understood, with nothing inside worth breaking down: the recursion stops. No `style`, no `systems` | |
| `dragons` | Someone looked and can't tell | `marked` |
| `spaghetti` | Someone looked, and there's no structure | `marked` |

A missing `state` means the person hasn't been asked yet. `check-map` lists that, and `parts` with
nothing under it yet, as `undecided`. Neither is an error: the map is saved between questions, and
stopping is the person's call.

Code no system claims is **unmapped**: nobody has looked. That's different from `dragons`, which is
a person's recorded answer. `dragons` is a gap in understanding, and `spaghetti` is a verdict on the
code. Both count as claimed.

```json
{
  "name": "Billing",
  "description": "Invoices, somehow",
  "by": "user",
  "paths": ["billing/**"],
  "pathsBy": "user",
  "state": "dragons",
  "label": "thar be dragons",
  "marked": { "who": "Sam", "on": "2026-11-05" }
}
```

`label` is optional and free text.

## Expectations

What a person says should or shouldn't happen between systems. These become rules a change can
break, and the code can answer them today by reading imports.

```json
{ "from": "Frontend/Patient portal", "to": "Backend/FHIR", "talks": false, "reason": "portals only reach the API", "by": "user" }
```

## Exceptions

A shape claim that the code doesn't fully meet, kept on purpose. The alternatives are fixing the
code or changing the label.

```json
{ "claim": "Core imports the ORM", "where": "api/core/models.py", "reason": "Django models are the domain here", "by": "user", "on": "2026-11-05" }
```

## Pattern instances

```json
{
  "name": "Foo Sliding Window",
  "catalog": "dsa-sliding-window",
  "description": "The rolling rate over sensor readings",
  "by": "user",
  "parts": [
    { "part": "expand", "file": "foo/window.py", "symbol": "FooWindow.push" },
    { "part": "shrink", "file": "foo/window.py", "symbol": "FooWindow.advance", "lines": [40, 47], "commit": "<full sha>" }
  ]
}
```

| Field | Meaning |
|---|---|
| `name` | Free text: what people call this one |
| `catalog` | A pattern id from [patterns/](patterns/), or `null` for a name of your own |
| `parts[].part` | The catalog's part name, or your own |
| `parts[].file` | From the project root |
| `parts[].symbol` | The function or type, when there is one |
| `parts[].lines` | `[first, last]`, counting from 1. Optional, and needs `commit` |
| `parts[].commit` | The commit the range was tagged at, as a hex sha |

A single function can be a whole instance, or several parts of one, with line ranges inside it.

Line ranges are meaningful only at their commit. A range is only stale if those lines moved or
changed, and a diff can tell that, so this format stores what's needed and leaves following a range
forward to [docs/tagged-diffs.md](../docs/tagged-diffs.md). Tag a range only when the file is
committed and unchanged, so the numbers match the commit.
