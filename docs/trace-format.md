# Runshape trace format, version 1

The contract between the Python recorder (`recorder/`) and the viewer (`packages/core`). The
recorder writes it; `packages/core/src/trace/parse.ts` is the only code that reads it.
Changing anything here means bumping `version` in both places.

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
