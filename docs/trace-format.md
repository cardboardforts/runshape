# Runshape trace format, versions 1 and 2

The contract between the recorders and the viewer. The recorders write it;
`packages/trace/src/data/` is the only code that reads it, and it reads both versions.
The Python recorder (`recorder/`) writes version 1, below; recorders for other languages write
version 2 (at the end), which names code by segments instead of Python's dotted names.
Changing anything here means bumping `version` in the recorder and the reader.

## Layout

```
<project>/.runshape/traces/
  latest.json                 {"run": "<run directory name>"}
  <run>/                      one directory per pytest session, named by start time
    manifest.json
    scenarios/0001.json       one file per test, in execution order
```

`latest.json` is replaced atomically after the manifest is written, so a reader never sees a
half-written run.

## manifest.json

| field | meaning |
|---|---|
| `format`, `version` | `"runshape-trace"`, `1`. A reader must refuse anything else. |
| `createdAt`, `python`, `backend` | when, which interpreter, `settrace` or `monitoring` |
| `recorder` | runshape-recorder version (optional; absent in the earliest recordings). Runs from different recorder versions or backends may differ for reasons other than the code |
| `root` | absolute path the recording was made in (informational; file paths below are relative to it) |
| `framework` | `null`, or `{framework, entry, middleware[], router, routes[{methods, path, handler}], externals[{name, kind}]}` read from the app at startup |
| `catalog[]` | every function in the source and test directories: `{file, module, qualname, firstLine, lastLine, lines[]}`; `lines` are the executable lines. Built by compiling, never importing, the source. |
| `sources` | optional `{file: [line, ...]}`: the text of every catalogued file when recorded, so runs can be compared by what the code said rather than by line numbers. Present from recorder 0.1.0 on; treat a trace like the source it contains |
| `catalogProblems[]`, `sessionProblems[]` | what the recorder couldn't do, in words |
| `scenarios[]` | `{nodeid, file, outcome, durationUs, eventCount, recorderErrors}` |

`outcome` is one of `passed`, `failed`, `error`, `skipped`, `xfailed`, `xpassed`, `unknown`.

## scenarios/NNNN.json

```json
{ "nodeid": "...", "outcome": "passed", "durationUs": 1234,
  "functions": [ {"key", "role", "module", "qualname", "file", "firstLine", "landmarkKind"} ],
  "events": [ ["P", 0, "setup"], ["S", 12, 0, 3, null, 0, null], ... ],
  "recorderErrors": [] }
```

`role` is `source`, `test` or `landmark`; `landmarkKind` (landmarks only) is `request-entry`,
`middleware` or `router`.

Events are tagged arrays, in the order they happened. Arrays instead of objects because a
scenario holds tens of thousands of line events and key names would dominate the file.

| tag | fields | meaning |
|---|---|---|
| `P` | t, phase | pytest phase started: `setup`, `call`, `teardown` |
| `S` | t, span, function, parent, thread, object | a call began. `function` indexes `functions`; `parent` is the calling span (or the span that handed work to this thread), `null` at a root; `object` is the receiving project object, if any |
| `R` | t, span, thread | a suspended coroutine/generator span resumed |
| `X` | t, span | a span stopped running: returned, raised, or suspended. The last `X` of a span is its end |
| `L` | span, line | a line of project code executed (no timestamp, to keep these small) |
| `O` | t, object, class, span | a project object was first seen. `span` is the `__init__` span that built it, or `null` if it existed before recording or was built by framework code |
| `W` | t, object, attribute, target | when `object`'s `__init__` finished, `object.attribute` referred to `target` — the wiring |
| `B` | t, span, system, operation, statement | the app called an external system (`postgres`, `http`, ...). `statement` is SQL text or a URL without its query string; never bound parameters |
| `Q` | t, span, method, path | the request-entry span received this HTTP request (no headers, no body) |

`t` is microseconds since the scenario started. A span's `S` is written before the `O` it
causes, so readers resolve objects in a first pass.

## Version 2

Everything above, with these differences:

| where | version 1 | version 2 |
|---|---|---|
| manifest | `python` | `language` (`"typescript"`, `"go"`, ...) and `runtime` (`"node 23.11.0"`) |
| `catalog[]`, `functions[]` | `module`, `qualname` | `symbol` (below) |
| `functions[]` | `key` | absent: events refer to functions by index |
| `framework.routes[].handler` | dotted name | segments, e.g. `["app", "api", "users", "get_user"]` |
| `O` event, `class` | dotted name | segments, the namespace then the type |

A `symbol` is `{namespace, container, name, kind, ownerType}`:

- `namespace`: segments of the module, package or file (`["packages", "core", "src", "zones"]`).
- `container`: segments between the namespace and the name: a class, an enclosing function.
- `kind`: `function`, `method`, `constructor`, `initializer` (module or static init) or
  `nested` (closures, lambdas, callbacks).
- `ownerType`: the type whose box the code is drawn in (a method's class), or `null`.

The TypeScript and Go recorders catalog the project's source, not its tests: a test appears as
the root span of its scenario, with role `test`.

The manifest's `version` decides how every entry is read: a version 2 entry naming code by
`module`/`qualname` is refused, as is a version 2 manifest without `language` and `runtime`.
A malformed catalog entry or scenario is skipped and reported; a malformed manifest is fatal.

Segments are sent already split, so no reader parses a language's separators. Two functions are
the same function when all three name parts match, so they must be stable across commits: no
line numbers or addresses in them.
