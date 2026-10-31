# Plan: from where Runshape is to GOALS.md

Draft 3, 2026-10-23, for you to check. Phase 0 is almost done. Phase 0b (new) turns the
package arrows toward the target architecture in GOALS.md. Each phase is a stack of small
PRs: each one reviewable in under ~10 minutes, gated by `npm test`, `npm run typecheck`,
`view-diff` where it applies, and a second-model refute review.

## Where it stands, goal by goal

Checked against the code on `runshape-zones` (7ce69c5). 286 vitest tests and the Go tests pass.

| Goal (GOALS.md) | State | What's missing |
|---|---|---|
| Wake up to 8–10 PRs, dig into one, summary + why + callouts | **Mostly there**: `review-requests`, nightly `schedule`, the morning list, review bundle, `--explain` | Only the TypeScript recorder writes kept recordings. No one-PR page. Stacked PRs aren't grouped. |
| A list of threads: whose end-to-end workflows go through this change | **Partial**: the review ranks tests that run *differently*; the Routes tab | No path from a changed function to *every* test or route through it (the "light beams"). |
| A shape per area, seams, a module-level view that drills down | **Gap**: one `style` per repo; the graph opens at classes | No regions, no module view with dependency lines, no "this module glows". |
| Arrange the diagram and have it stick between diffs | **Gap**: layout is computed fresh each time (ELK, floor layouts) | No saved arrangement. |
| UI lag on big diagrams | **Gap**: the webview gets full graphs | No pre-visualization step that reduces what's drawn. |
| Performance impact up front | **Partial**: review.md, review.json and the PR page carry a cost diff (time, calls, external calls by route) | One recording each side; overhead not subtracted; no loop callout. |
| Complexity | **Partial**: distinct paths that ran, per changed function | Not per route. |
| The ticket story | **Mostly there** (Phase 5): the PR, its linked issues and mentioned GitHub issues, changed docs and comments; `--explain` says what it's for and what the tickets don't mention | No Jira or Confluence adapter; no meeting notes. |
| Categorizer: places new code, spots renames, and "now does another zone's job" | **Partial**: zone advice on click, `moves.ts` renames, architecture diff "moved with behaviour" | Not automatic for new or changed code in a branch. No callout for a function drifting into another zone. |
| Review module: comments, partial approval, approve, comments go somewhere | **Gap** | Nothing. |
| AI sees what the reviewer will see | **Partial**: `review.json` | No agent contract, gate or loop. |
| VS Code, 2D, Quest 3S (arrange with hands) | VS Code and 2D done; 3D in three.js | No WebXR, no arranging. |
| Python, JS/TS, Go, C#, C++; "test config in, universal trace out" | Python, TS (vitest), Go | No shared recorder contract (each takes its own config). C# missing. C++ parked (idea 7). |

## What GOALS.md's target architecture changes (2026-10-23)

GOALS.md now ends with a target architecture: a shared kernel (today's `core`, renamed `kernel` in Phase 0b) that everything points at
and that knows nobody, feature modules that take values and return values and never import each
other, infra adapters injected by the apps, and apps (extension, CLI, GitHub Action) as the only
composition roots.

Today the arrows run the other way: `trace ← architecture ← views ← core ← hosts`. Core imports
`views` and `architecture` in 10 files and is mostly workflow (2,480 lines), so it sits at the
top of the stack, not the middle. `views` imports `architecture`, which is one module importing
another. Phase 0b fixes this before Phase 1 builds on it. Where today's code goes:

| Today | Target home |
|---|---|
| `trace` model and format (imports nothing) | **kernel**: folded in as its trace types and format |
| `views/run-diff`, `execution-diff`, `routes` | **trace module**: `Trace + Trace → TraceDiff` |
| `architecture/*`, `views/architecture-diff`, `placements`, `moves`, `folder-guide`; core's `zone-advice`, `architecture-advice`, `folder-readme`, `folder-description` | **arch module**, with its LLM skills |
| core's `explainer`, `review-bundle`; `views/review` | **explainer module** |
| `views/system-graph`, `component-view`, `object-graph`, `timeline`, `replay` | **visualizer module** |
| core's `Recordings`, `ViewerSession` | **workflows** |
| core's ports (`recordings-ports`, `language-model`), `ui-protocol`, `recordings-model` | stay in the **kernel** |
| `infra`, `library`, `adapters` | **infra / adapters**, grouped by external system |

## What the updated GOALS.md changed (2026-10-19)

The "Secondary goals" and the C++ review scenario add five things to the plan:

1. **Step 0 has a target shape.** A recorder points at *core* (the in-memory universal trace
   and the test config) and at *infra* (how files are saved and loaded). Parsing sits in
   core's own data layer, behind an interface. That's the refactor below.
2. **A module-level default view.** Modules as boxes with dependency lines. Changed modules
   glow. Internals stay hidden until you click in, then sub-modules, then classes, then a
   function's diff. That's nested regions (Phase 2) plus a drill-down view.
3. **A pre-visualization module (new Phase 3).** Reduce regions and nested zones to a smaller
   shape before rendering. It fixes the lag, and the same shape is "what the human will look
   at" for agents. Saved arrangements belong here too.
4. **A review module (new Phase 6).** Tests as beams from a function, an execution walked
   backwards with its timings, checking off parts of a review, comments to a port (GitHub
   review comments, a local agent's task list, new tickets), then approve.
5. **Smaller additions:** the morning list groups stacked PRs. The categorizer runs on a
   branch's new or changed code by itself and calls out drift into another zone. The explainer
   reads code comments and docs as well as tickets. Recorders share one contract: a test
   config in, a universal trace out.

## The plan

### Phase 0: Infra refactor, then Runshape's own zones (4–5 PRs)

**Today.** `@runshape/trace` declares `TraceFiles { readText(relativePath) }`, a filesystem
verb, inside the domain package. `load.ts` mixes three jobs: the domain asking for a run, the
on-disk layout of the old recorders (`latest.json`/`previous.json` pointers, `manifest.json`,
scenario files), and JSON parsing. Every host re-implements the port inline:

- `cli/main.ts` passes a lambda.
- `extension/workspace-files.ts` uses VS Code's fs.
- `demo.tsx` uses a vite glob and `fetch`, and fakes `latest.json` and `previous.json` to fit
  the port ([demo.tsx:56](packages/webview/demo/demo.tsx#L56)).
- `library` skips the port and calls `node:fs` directly.

`SourceReader` is a second file port, in `core/session.ts`. runshape.json is read and written
separately by the extension and by `cli/recordings.ts`.

**Target** (decided 2026-10-19: option B, with storage and format split apart):

| Role | Shape | Owner |
|---|---|---|
| Storage | path → text, (path, text) → done | `@runshape/infra`: imports no `@runshape` package |
| Model | `Run` and its scenarios, spans, symbols; `RunSource` (where runs come from) | `@runshape/trace` `model/`: imports nothing |
| Codec | text ↔ `Run`, v1 and v2, the run directory layout | `@runshape/trace` `data/`: declares the narrow read port it needs |
| Native → universal | `PythonTrace` → universal format | each recorder, in its own language, before any bytes are written |

```
 [python recorder]   [go recorder]   [ts recorder]     native trace → universal format (own language)
          ▼                ▼               ▼
    .runshape/…  in the published format (docs/trace-format.md)
                           │
   ┌──────────── trace ────┼─────────────────────┐
   │  data/  codec + layout; declares TraceFiles ◄──── infra's NodeFiles fits it structurally
   │  model/ Run, RunSource (imports nothing)    │     (the compiler checks the fit where they're wired)
   └─────────────────────────────────────────────┘
                           ▲
          views, architecture, core: see only Run
```

- Hosts build a store from infra (or their own: the extension's stays in the extension),
  hand it to `TraceDirectory`, and use the `RunSource` they get back. The demo stops faking
  pointer files: a pair of kept recordings is a `RunSource` of its own.
- Text, not bytes: every format Runshape reads is JSON or Markdown. Bytes when a binary format
  arrives.
- `SourceReader`, library reads and writes, and runshape.json go through infra's stores.
- The package-boundaries test enforces it: `trace` imports nothing, `infra` imports no
  `@runshape` package, and only `infra` and the hosts touch `node:fs`.
- The `latest`/`previous` layout stays as `TraceDirectory` until Phase 7. The VS Code store
  stays in the extension.

**PRs:**

1. **Done (10fb440 and its review fixes).** `trace` split into `model/` and `data/`. `RunSource` with `TraceDirectory` replaces
   `loadLatestRun`/`loadPreviousRun`. `@runshape/infra` with `NodeFiles` and the path guard
   (moved from the extension). The CLI uses it. `view-diff`: no viewer response changes.
2. **Done.** The demo's kept recordings as a `RunSource` (no fake pointer files). The extension
   moved to `RunSource` in PR 1. `SourceReader` stays as it is: its three implementations are
   the extension's (VS Code's fs, a host's own), the demo's (vite globs, and sources kept in a
   recording) and view-diff's. View-diff's does read `node:fs` directly, and could use
   `NodeFiles`; it's a tool that loads core from a path per revision, so it's left alone until
   it needs to change.
3. Named stores (decided 2026-10-20), not a general `FileStore`: the CLI's ~45 file
   operations are mostly the library's housekeeping (a lock, an atomic swap into place,
   removing without following links), not "text at a path". The library becomes the storage
   adapter for its own domain, built on a small infra (`NodeFiles`: read, write, list,
   remove; then a directory swap and an exclusive lock). The CLI asks for "commit this
   recording", not "rename this folder".
   - **3a. Done.** `ReviewStore`: review bundles, explanations, the requested-reviews index, and
     forgetting a recording's reviews.
   - **3b. Done.** `RecordingStore`: the lock, a recording begun and committed atomically, its
     metadata, rules and architecture, forgetting it, clearing interrupted ones. Infra holds
     the folder operations (swap into place, pid lock, remove anyway, plain-files check).
     What's left in `recordings.ts` on `node:fs` is the project's own working tree (README
     guides, the recorder's source hash, the working tree's runshape.json): PR 4.
4. **Done.** The `Recorder`, `RecordTarget` and `PullRequests` ports moved to `cli/ports.ts`.
   `GitCli` and `RecordingLibrary` are built by the composition root and passed in. The
   library touches the disk only through infra (`RecordingStore` and the dev server's file
   serving), and the boundary test now fails any package other than infra and the hosts that
   imports `fs`. Two calls made along the way:
   - **`TestConfig` waits for Phase 7.** Today a recorder needs only "this commit" or "the
     working tree" (`RecordTarget`). Calling that `TestConfig` in core would be a name with no
     contract behind it. Phase 7 designs the real one (language, how to run, where the code
     is) with the recorders that need it.
   - **The CLI's reads of the project's own working tree stay in the CLI.** It's a host, and
     those reads carry their own checks (plain files inside the project, raw bytes hashed).
   - Found on the way: since PR 3a, `npm run dev` and `npm run build` failed to start (Vite's
     config loader). Fixed, and a test now loads the config the way each script does.
5. Redo Runshape's own `runshape.json` for the new shape. Close `runshape-zones` without
   merging it. You approve the new placements in the diff. Refresh README and `design.md`
   "Next" (**done** 2026-10-23).
   - **Drafted** on branch `runshape-zones-2` (2026-10-20), waiting on your approval. With
     the rules in force, the folder guides ask 21 questions:
     1. `recordings.ts` (inbound) calls the stores, git and recorders directly: the CLI's
        workflow is application logic inside the inbound adapter (9 questions).
     2. `serve.ts` (inbound, the demo dev server's routes) calls the stores directly and
        sits in the library's outbound folder (5).
     3. `cli/src` holds outbound adapters (docker, shell, models, pull-requests) beside the
        inbound code (3).
     4. Runshape misreadings: `main.ts` is a composition root wiring an adapter; `explainer.ts`
        and `folders.ts` only call back what they were handed (a hash function, the locked
        work) (3). See Phase 2.
     5. `shell-recorder.ts` never runs in a test (1).
   - **Done (2026-10-20):** trace's data layer is an outbound adapter, and you approved the
     placements ("about right, good enough for now"): every rule's `by` is `user`.
     `runshape-zones` closed unmerged.
6. **Done.** **`serve.ts` moves to the webview demo** (decided 2026-10-20): only the demo's dev server
   uses it, so it joins that host, and the library is outbound only. Its rule goes with it.
7. **The recordings workflow moves into core** (decided 2026-10-20; steps and layering
   decided the same day: 7a (**done**) a git interface named for meaning, `Repository`,
   replaces the raw command lines; 7b (**done**) the project's files and hashing behind an interface; 7c (**done**) the types
   the workflow speaks move from the library into core, and the library imports core to
   implement core's interfaces (with them: `GitError` and the lock's `LibraryBusy` are core's,
   a recording's and a review's names are core's, and the sandbox's check on what it left is
   handed to the workflow, which core can't import); 7d (**done**) `Recordings` moves into core, the CLI keeping the command line, `list`'s text,
   the demo link and the sandbox image's version; folder guides then ask 7 questions, down
   from 21): `Recordings` becomes an
   application service behind ports (`RecordingStore`, `ReviewStore`, git, `Recorder`,
   `PullRequests`). The CLI keeps argument parsing, printing and its composition root. Split
   into reviewable steps; Phase 1's PR page builds on it. After it, the CLI's outbound
   adapters leave `cli/src`: the recorders for Phase 7's recorder modules, and models and gh
   for an adapters package. That move is not made earlier, so nothing moves twice.

8. **Done (2026-10-23): the CLI's outbound adapters left `cli/src`.** The recorders (here and
   the Docker sandbox), GitHub's pull requests (gh), the project's working tree and hashing are
   `@runshape/adapters`. The language models (`claude -p`, the Anthropic API) are infra's, as
   infra's README says (File IO, LLM access, comments: low-level IO without domain words), and
   fit core's `LanguageModel` by shape; choosing among them stays in the CLI. The CLI is the
   command line and the composition root. Folder guides ask 3 questions, all wiring code
   read as handlers (Phase 2).
   - **Superseded in part (2026-10-23):** infra's README is being rewritten. Under the target
     architecture, adapters implement core's ports and import core directly, so they no longer
     fit them by shape without importing. Which package the model clients end up in follows
     the "grouped by external system" rule in Phase 0b.

**From the READMEs you're writing (2026-10-23), for later** (updated for the target
architecture the same day):
- Comment sinks (post to GitHub, or collect for a local LLM): the `CommentSink` port is
  the kernel's, and the sinks are adapters. Phase 6 builds them.
- Logs: the `Logger` port is the kernel's, and each app (CLI, extension, a GitHub Action)
  wires a sink that pipes it where it needs to go. Phase 1 builds the CLI's.
- The kernel (today's core) is a light glossary of the shared domain objects, with each
  module self-contained.
  The recordings workflow (PR 7) is 600 lines of workflow, not glossary, so it moves to
  `workflows` in Phase 0b.

**Done when:** `grep node:fs` finds only infra and the hosts (done: the boundary test holds it). The demo has no fake pointer
files. `runshape readmes` shows no "doesn't fit" questions you haven't decided.

### Phase 0b: Turn the arrows around (6–8 PRs)

The target architecture in GOALS.md, applied to the packages (see the table above). This comes
before Phase 1: Phase 1 builds the PR page on `Recordings` in core and adds threads to `views`,
so everything that lands first is code that would have to move afterwards. The order below
moves each file once.

1. **Boundary test first.** `package-boundaries.test.ts` states the target rules:
   - core imports no Runshape package,
   - a module imports only core,
   - infra and adapters import only core,
   - only apps and `workflows` import more than one.

   Today's violations go on an explicit allowlist in the test. Each PR below removes its entries,
   and the phase is done when the list is empty. A new violation fails the build.
2. **Core's orchestration moves out.** `Recordings` and `ViewerSession` go to `workflows`. The
   explainer and review bundle go to an explainer module. Zone and architecture advice and the
   folder guides go to the arch module, with their prompts. Core then imports neither `views`
   nor `architecture`. This can be split into one PR per destination.
   - **Done (2026-10-23):** `Recordings`, `ViewerSession` and the review bundle are
     `@runshape/workflows` (the bundle assembles several modules' outputs, so it's a workflow's
     job). The explainer is `@runshape/explainer`, and takes the review's Markdown as a value
     instead of the bundle; its test reads a real review kept as a fixture. The kernel's
     `LanguageModel` and `CommitMessage` stand on their own.
   - **Decided (2026-10-23): the UI protocol waits for Phase 3.** `ui-protocol` is typed in
     ~40 view-model types from `views` and `architecture`, and the webview draws with profile
     helpers. They stay where they are, recorded in `NOT_YET`, until Phase 3's `Layout` (the
     visualizer's one output) replaces them.
   - **Left for step 3:** zone and architecture advice and the folder guides import `views`
     (`FolderGuide`, `SystemGraph`, `ComponentView`), so moving them into the arch module
     now would make one module import another. They move when step 3 decides where those
     types go.
3. **`views` splits** into the trace module (run and execution diffs, routes), the arch module
   (architecture diff, placements, moves, folder guide) and the visualizer module (system,
   component and object graphs, timeline, replay). After this no module imports another.
   - **Proposal (2026-10-23), for your decision.** Split as written, the modules would import
     each other. `run-diff` (trace) calls `buildSystemGraph` (visualizer) and reads zones (arch);
     `architecture-diff` and `folder-guide` (arch) call `buildSystemGraph` and `moves`; and
     11 of `views`' 16 files take their component identity from `architecture`
     (`componentOf`, `Grouping`, `FINE_GROUPING`, `classComponentId`, `renamedComponentId`).
     What `views` takes from `architecture` is two different things:
     1. **Which box a span belongs to** (`components.ts`: component identity and grouping,
        ~150 lines) and a function's identity (`function-ref.ts`). Every module needs these
        to talk about the same boxes. *Proposal: kernel.*
     2. **Zones and styles** (`profiles.ts`, `zones.ts`): the arch module proper.

     And `SystemGraph` (components, calls between them, each one's zone) is the trace seen
     through the architecture: GOALS.md's `ArchTrace`, by another name. *Proposal: its type
     goes to the kernel, and building it is the arch module's (`enhance`).* Then:
     - **trace module:** `moves`, `align`, `run-diff`, `execution-diff`, `replay`, `routes`,
       `review`. `diffRuns` takes the two `SystemGraph`s as values instead of building them,
       and the workflow builds them through the arch module, as GOALS.md's
       "modules don't call each other" says.
     - **arch module:** profiles, zones, `buildSystemGraph`, placements, architecture diff,
       folder guide, and (from the kernel) zone and architecture advice and the folder
       READMEs with their prompts.
     - **visualizer module:** component, function and object views, the timeline. Phase 3's
       `layout` lands here.
     - **Cost:** `diffRuns` and its callers change signature (one PR), plus the moves. The
       kernel grows by component identity, function identity and the `SystemGraph` type,
       about 250 lines, all of which are shared vocabulary today.
4. **Trace folds into core** (decided 2026-10-23). Trace's `model/` and `data/` become
   core's trace types and format, with `TraceFiles` as one of core's ports. The `trace`
   package keeps the name for the trace module (diffs). This touches every
   `@runshape/trace` import, so it's a mechanical PR on its own.
5. **`core` is renamed `kernel`** (decided 2026-10-23). This is a mechanical rename and nothing
   else: the package, its folder, every `@runshape/core` import, the boundary test's rules and
   allowlist, runshape.json's rules, and the READMEs. "Core" was also the name of the hexagonal
   zone Runshape draws, and every module will have one of those, so the package needs a name
   that doesn't clash. "Kernel" says what it is: the small shared center. From here on this
   plan says kernel.
6. **Adapters grouped by external system.** `infra` keeps the generic Node toolkit (paths, locks,
   folder swaps, `NodeFiles`). `library` and `adapters` are regrouped by what they talk to
   (git, GitHub, the recorders, the language models). A system gets its own package only when
   it brings in a dependency other apps shouldn't carry. The READMEs follow (yours to write).
   - **Done (2026-10-24).** No system here brings an npm dependency another app shouldn't
     carry (git, gh, Docker and claude are commands; the rest is Node's own), so none gets a
     package of its own: `@runshape/adapters` has a folder per system (`git/`, `github/`,
     `recorders/`, `models/`, `library/` for the recordings and reviews kept under
     `.runshape`, `project/` for the working tree), and `library` merged into it. `infra` is the
     generic Node toolkit (paths, `NodeFiles`, folders, the lock, hashing) and imports no
     Runshape package. My reading of "infra imports only the kernel": the adapters may use that
     toolkit (the boundary test says so).
7. **runshape.json placements redone** for the new packages. You approve them in the diff.
   - **Drafted (2026-10-24), for your approval in the diff.** One rule per package, and per
     adapters folder. A rule keeps `"by": "user"` where its placement and wording are the ones
     you approved; new rules and rewritten reasons say `"llm"`. The folder guides then ask 3
     questions, all decided: the CLI's composition root and `chooseModel` wiring adapters (a
     Runshape misreading, Phase 2) and `list` reading the library's overview.
   - **Phase 0b's state:** `NOT_YET` holds only the UI protocol's deferral to Phase 3 (the
     kernel names the modules' view-model types, type-only, and the webview draws them). Found
     along the way, for later: `readmes` leaves a stale guide in a folder whose code moved away
     (removed by hand for `adapters/src`).

**Done when:** the boundary test's allowlist is empty, `npm test`, `npm run typecheck` and
`view-diff` show no viewer response changes, and the folder guides ask only questions you've
decided.

### Phase 1: The PR page and threads to follow (3–4 PRs)

1. **Threads:** for each changed function or class, the scenarios and routes that run
   through it, on base and head. Grouped as same / different / new / gone, and written into
   `review.json` and `review.md`.
   - **Done (2026-10-26).** `buildThreads` (trace module): changed means a function's own
     source text changed, or it was added or removed, read from the source each recording
     keeps; moved code is paired with itself, not counted. Recordings without source fall back
     to "some workflow ran it differently". In `review.json` (`threads`) and `review.md`
     ("Threads to follow"). On Runshape's own branch it showed the next step's problem: five
     functions listing the same 26-31 workflows.
2. **One PR page:** summary, threads, callouts, and a way into each thread's graph and wires.
   Opened from the morning list, where stacked PRs are grouped and ordered bottom-up.
   - **Stacks done (2026-10-26).** `review-requests` reviews a stack bottom first (`stackOrder`:
     a PR is on another when its base is that one's branch, ours, not a fork's) and writes
     `stackedOn` into `requested.json`; the morning list shows "on #7", indented under it.
   - **Page done (2026-10-31).** `buildReviewPage` (workflows) saves `page.json` beside each review:
     the kernel's `ReviewPage`, so the UI draws kernel types only, not the trace module's. The demo
     opens it at `?review=<base>..<head>` ("Open" in the morning list): callouts, threads, the
     tests grouped by cause, each test a link into the compared graph opened at it
     (`&scenario=<id>`). Long lists show 6, the rest behind a disclosure.
3. **Group by cause:** Runshape's review of its own PR 3a listed 66 "run differently" tests,
   every one because calls now go through `ReviewStore`. Threads with the same change
   collapse into one row ("66 tests: now save reviews through ReviewStore"), expandable.
   A test whose title changed pairs with its old self, as moved tests do (PR 3b's renamed
   test read as one removed and one new).
   - **Done (2026-10-26).** `groupThreads`: changed functions with the same workflows, the same
     way, are one thread in `review.md`. `reviewRows`: tests that changed through the same
     changed functions are one row ("2 tests: ... all through what changed: ..."). A test gone
     from a file that still has tests pairs with the one new test there that ran exactly its
     project code (`a.py: test_x -> test_y (renamed)`); one whose code changed too stays
     removed + new.
4. **Structured CLI logging:** logfmt, with a run ID and PR number on every line, duration
   per PR, and the full error for each PR that fails. Workflows log through the kernel's `Logger`
   port, and the CLI wires a logfmt sink for it.
   - **Done (2026-10-26).** Kernel `Logger` port; infra's `LogfmtLogger` fits it by shape
     (newlines escaped, so an error can't forge a line). The CLI appends to
     `.runshape/logs/runshape.log`, not the terminal, with `service` and a `run` id on every
     line: `command.start`, `command.end` (exit, duration), `command.refused` (why), and
     `command.failed` (message and stack) before an unexpected error is rethrown.
     `review-requests` logs `pr.reviewed` / `pr.failed` per PR with `pr`, head, duration and,
     for a failure, the whole error.

**Done when:** morning list → a PR → "these 6 workflows run through `Service.place`; 2
behave differently" works on a real Runshape PR.

### Phase 2: Nested regions, seams, the module view (5–6 PRs)

1. **runshape.json v3, nested regions:** a region is an area with one style. A zone is a slot
   inside that style. A child region sits inside one of its parent's zones, the innermost
   match wins, and a child spanning two parent zones is a load error. Still reads v1 and v2.
   - **Done (2026-10-31).** `ZoneRules` holds `regions`, each with its own rules in its own
     style; `placementsOf(name)` gives a name's zone at every level, outermost first, and
     `matchFor` at a level says the region's `in`. Every load error is reported with its path
     (docs/architecture-profiles.md). The viewer still draws the top level only: setting a
     zone for a name inside a region is refused until the module view (step 4) can show it.
2. **Seams:** a call that crosses a region boundary. Going in through the parent's zone is
   expected; reaching past it is a violation. Mixing styles inside one region is a smell.
   - **Checks done (2026-10-31).** `regionCalls(graph, rules)`: each call that enters or leaves
     a region, and why it breaks a style. Entering must land on the region's way in (its style's
     first zone); below the top, the deepest region both ends share judges the call by its
     style, so calls inside a region are checked too (nothing did before). Not yet: leaving a
     region, mixing styles, and showing any of it (the module view, step 4).
3. **Event-driven profile**, recognised from the recorded call pattern.
4. **Module view:** the default view is modules with dependency lines, changed ones marked.
   Click to open a region's shape, its sub-modules, its classes, then a function's diff.
   - **First cut done (2026-10-31).** `Grouping.modules` draws all the project's code under a
     prefix as one box, so the graph, compare (changed modules marked), replay and findings work
     at module level unchanged. `moduleRoots` picks the modules: top-level regions, then each
     package (down while there's one way down). The viewer opens there ("By module"); clicking
     a module opens its classes and what they call ("← all modules" goes back). A module no rule
     names sits where its own code's rules put most of it. Not yet: a region drawn in its own
     style when opened, sub-modules between a module and its classes, and a moved package in
     compare at module level (moves pair namespaces, not prefixes: it reads as gone + new).
5. **Categorizer on the branch:** new or changed code that no rule covers gets a proposed
   placement, committed to the branch for approval in the diff. A function now doing another
   zone's work is called out, with renames recognised (`moves.ts`) so a rename isn't mistaken
   for a new function.
   - **Done (2026-10-31), deterministic first** (docs/categorizer.md). The categorizer tags
     recorded code with its kind, its roles by lens (from zones, routes, its own boundary
     calls, name globs and declared roles) and traits (effect, direct I/O, CQS, can-fail, from
     boundary calls through the call tree and executed source lines). Each tag is a claim with
     evidence. Definitions and rules are data, overridable by id in runshape.json's `taxonomy`.
     The review bundle shows the changed code's tags, findings the branch adds (renames
     recognised) and a proposed zone for new code (`"by": "detected"`, never applied). A model
     step for leftovers (`role-advice.ts`) is built but no host calls it yet. Not yet: ports,
     entities and value objects (interfaces aren't recorded), state traits and metadata.
6. **Two misreadings Runshape's own folder guides showed (Phase 0, PR 5):** a composition
   root wiring adapters is not a handler skipping the core, and calling a function you were
   handed (a callback) is not a dependency pointing outward.
   - **Done (2026-10-31).** A rule may declare `"role": "composition-root"`: its calls wire,
     so they're never findings. Runshape's CLI declares three (`"by": "llm"`, for your approval
     in the diff); FastAPI's `app.api.dependencies` is the same pattern. Callbacks: not seen
     since Phase 0b's restructuring (the TypeScript recorder records no closures, and Python's
     are comprehensions inside their own function), so no rule was added for them.

**Done when:** Runshape opens at its modules (recorders, trace, infra, architecture, …), a
changed module is marked, and clicking down reaches a function's diff.

### Phase 3: Pre-visualization and arrangement (3–4 PRs)

1. **A visual model:** each zoom level reduced to what's drawn (aggregated edges, collapsed
   regions, capped detail), computed once and shared by 2D and 3D. Measured: render time on
   the largest fixture before and after.
   - **Done (2026-10-31).** The kernel's `Layout` (per zoom level: classes, modules, one module
     opened) is the visualizer's `layout(graph, view)`: each box with its 2D position (ELK) and
     its 3D tile (the style's floor), compare marks, what a module box opens, and what the cap
     left out (`MAX_BOXES` = 100, the quietest first; the request path and changed boxes never).
     The session answers `graph` and `diff` with it; the webview draws it as is (no layout code
     left in it, nor elkjs: its bundle went from 2.5 MB to 1.1 MB). An opened module is now its
     classes with every other module still one box (`groupingAt`), so the calls leaving it land
     on whole modules. Measured on Runshape's own recording 1fe496dc6399 (265 tests, 200 MB) and
     the largest fixture (fastapi-slug-refactor), Node, warm: the graph plus ELK took
     2.0 s + 0.1 s (classes, 80 boxes) and 2.0 s + 0.015 s (modules) before; the layout response
     takes 2.0 s and 2.0 s after, so placing is not where the time goes: building the system
     graph from the 200 MB recording is (Phase 4). Fixture: 2 ms + 30 ms before, 35 ms after. In
     headless Chromium (demo, same recording): first canvas 5.0 s before and after; opening a
     module 0.75 s before, 1.0 s after (it now regroups in the session instead of filtering in
     the browser); back to every class 1.2 s before, 0.9 s after. The response is still 2.2 MB
     at class level, nearly all of it every box's and call's test ids: sending them once, by
     index, is the next saving. Not yet: the `LanguageModel` parameter (nothing to ask it yet).
   - **UI protocol, Phase 0b's deferral (2026-10-31).** The webview now draws kernel types for
     everything but the trace module's: the visualizer's views (function, timeline, objects,
     wiring) and the arch module's answers (rules, placements, architecture diff, candidates,
     zone advice) are kernel DTOs, built by their modules as before, and "Draw as" lists the
     styles the summary sends. The kernel imports no module but trace. `NOT_YET` keeps
     `trace` for both (RunDiff, ExecutionDiff, replays, routes, the review summary, ~20 types,
     and the replay pacing the webview calls): the review module (Phase 6) reshapes those into a
     kernel DTO, as the PR page did, rather than moving today's shapes only to change them.
2. **The same model for agents:** `runshape view --json`, what a human would see at each level.
   - **Done (2026-10-31).** `runshape view [<recording>] [--module=<module>] [--json]`: the newest
     kept recording unless one is named, drawn as the viewer first draws it (its modules, the
     tests' own calls, its commit's runshape.json), then with `--module` that module opened.
     The visualizer's `layoutForAgents` gives each box by name in reading order (zone and why,
     calls, how many tests, what `--module` opens it, its canvas spot, whether a person placed
     it) and each call by name with its violation. Without `--json`, the same as text.
3. **Saved arrangements:** moving a module in 2D or 3D is saved, keyed by region and module
   names so it survives between diffs. New things get a computed spot near their neighbours.
   - **Done (2026-10-31).** Drag a box in 2D, or a tile across the 3D floor (at its own
     elevation: a terrace stays a terrace), and the session saves it (`arrange`). The format and
     its serializer are the visualizer's (`arrangement.ts`): per zoom level and style
     (`modules@hexagonal`, `module:packages.trace@layered`), then per box name (the code's name,
     or the id for the client and externals), sorted and rounded so the file diffs. A move writes
     down every box drawn at that level where it stands (the person arranged against them),
     keeping spots already saved. `layout` puts them back; a box new since goes to the middle of
     the arranged boxes it calls or is called by, or the nearest free spot around it. Kept in
     `.runshape/arrangement.json` (not committed: a reading aid, not a decision): VS Code's file
     API in the extension, `ArrangementFile` (adapters) for `runshape view`, this browser's
     storage in the demo. A file that can't be read is drawn around, never saved over. Checked
     in headless Chromium (drag, reload, still there); the 3D drag needs WebGL, which headless
     Chromium here doesn't have, so it's unchecked in a browser.

All of this is the visualizer module: `layout(ArchTrace, PreviousLayout | null, LanguageModel)
→ Layout`. The arrangement file format and its serializer belong to the visualizer, not the kernel,
because only the visualizer reads it. The app loads and saves the file.

### Phase 4: Performance and complexity, honestly (3–4 PRs)

1. **Cost diff per thread:** call counts, queries per request (N+1), a DB or network call
   newly inside a loop. Example: "`POST /orders` now makes 12 queries, up from 3".
2. **Time diff:** self-time with the recorder's overhead subtracted, and reported only above a
   noise band measured by recording twice. Each one is labelled with who waits.
3. **Complexity:** distinct paths that ran, per function and per route, before vs after.

**Done when:** a seeded N+1 and a seeded network call in a loop are called out with the route
that pays. A no-op change has no time callout.

- **Done (2026-10-31), first cut.** `diffCost` (packages/trace/src/cost.ts) compares, per
  workflow, call-phase time, project calls, external calls and each route's external calls;
  per changed function (the threads'), calls, time with and without what it calls, external calls
  under it, and the distinct paths that ran (sets of line-to-line steps, so loop iterations
  aren't paths). review.md has a Cost section after the comparison line (routes whose external calls
  changed first: "`GET /api/articles/feed` newly requested: makes 10 external calls"), review.json
  keeps `cost`, and the PR page draws it with two callouts (more external calls: warn; slower: info).
  Time, honestly: one recording each side, recorder overhead included and not subtracted, said
  in the caveats. A time is named slower or faster only past both 10 ms and 50%
  (`TIME_NOISE_FLOOR_US`, `TIME_NOISE_RATIO`), and never across recordings made by another
  recorder, backend or runtime. On the real fixtures: the Django feed fix has no time callout
  (one change is 10.9 ms but 3%, another doubles but by 2.3 ms); the slug refactor's one callout
  is a database wait inside unchanged code, and own-lines time shows it isn't the edit.
  Second-model review fixes (2026-10-31): new and gone workflows are reported apart, not as
  "the same", and a new one's external calls are a callout; a function's verdict is on time per
  call, and a side that never ran it has no time (one-sided, not slower); "queries" became
  "external calls" (a boundary call may be HTTP); path lines are named by offset in the
  function, plus text only when both sides kept source; retries count the last attempt
  everywhere; a runtime's patch release doesn't make times incomparable, and the caveats say the
  recordings don't name their machine. Known limits: own-lines time for a coroutine subtracts
  children that may overlap its own waits (clamped at zero, so it can read low); finding the
  functions above each span and external call walks its ancestors every time (0.2 to 0.6 s on
  Runshape's own 1.88M-span recordings, so not worth caching yet).
  Not yet: the noise band measured by recording twice (needs a second recording per side);
  overhead subtraction (needs the recorder to measure its own per-event cost); "a query newly
  inside a loop" as its own callout (today it shows as the route's query count going up);
  seeded N+1 and network-in-a-loop fixtures; paths per route (the route diff's ways stand in);
  "who waits" beyond the route and the tests (which callers are in a loop).

### Phase 5: The story (2–3 PRs)

1. The PR title, body and linked issues through `gh`, as untrusted data. The threat model gets
   a new row.
2. A `TicketSource` port with GitHub Issues first. Jira when you need it. The explainer
   module takes ticket context as a value. Fetching it is the workflow's job, so the port
   lives with `workflows`.
3. Changed code comments and docs as context. The explainer says what the change is *for*,
   and flags behaviour the ticket doesn't mention.

- **Done (2026-10-31), first cut.** The workflow gathers the story (packages/workflows/src/story.ts)
  for every review: for a PR, its title, body and the issues it closes (`gh pr view`); every
  ticket the PR's text and the commit messages mention, from each `TicketSource` (the kernel's
  port, beside the workflow's other ports in recordings-ports.ts, since adapters see only the
  kernel); and the docs (Markdown, rST, AsciiDoc) and comment lines the diff changed
  (`Repository.changedLines`, `git diff -U0`). GitHub Issues through gh (`GhIssues`: `#N`,
  `owner/repo#N`) is the adapter written; Jira is a port away, shown by a fake Jira in
  story.test.ts. review.json keeps `story` (titles, https links, counts: never bodies, ticket
  text or changed lines, since a bundle may be posted or stored centrally), review.md has a
  "The story" section after the comparison line (every title escaped to one line of plain
  text), and the PR page draws it. The explainer takes the story as a value (prompt v2): the
  PR body, tickets (each cut at 4,000 characters) and doc and comment lines (20 files, 40 lines
  a side) under their own headings below the data line; it answers `purpose` and `notInStory`,
  a reason may cite the PR, a ticket or doc it was given, and the page shows the account
  labelled as the model's, with an info callout for what the tickets don't mention. A ticket
  or PR gh can't read is listed with gh's reason and logged (`story.unread`, ids and reasons,
  never text), never fatal; at most 8 tickets are read. Threat model: three rows new or widened
  (mentions → gh, story → review.md/page, story → model).
  Not yet: a Jira (or Confluence) adapter, which needs credentials and a decision on which
  project keys count as mentions ("UTF-8" isn't a ticket); `compare` outside a PR doesn't look
  up the branch's PR (only `review-requests` knows the number); comment detection is by line
  prefix (`//`, `#`, `/*`, `*`, docstring quotes), so a comment after code on the same line,
  or a docstring's middle lines, aren't read; the second-model review of this phase.

### Phase 6: The review module (4–5 PRs)

1. **Beams:** from a function, the unit, integration and e2e tests through it. Pick one to
   walk its execution backwards with timing deltas.
2. **Review progress:** check off threads, functions and regions as reviewed. Saved per PR
   and head commit, so a new push un-checks only what changed.
3. **Comments port:** a comment pinned to a function, test or region. `Comment`, `Review` and
   the `CommentSink` port are the kernel's. The sinks are adapters (GitHub's in the github adapter).
   Sinks:
   - GitHub review comments (posting asks you first),
   - a local agent task list,
   - a new ticket.
4. **Finish:** approve, send to a local agent, or post. Voice input (whisper) later.

### Phase 7: Every recorder in the pipeline (3–4 PRs)

1. A shared recorder contract: `TestConfig` in, universal trace out. `TestConfig` is designed
   here with the recorders (Phase 0 kept `RecordTarget` rather than name it early). Both are
   kernel types: the recorders are separate processes in their own languages, and the kernel's trace
   format is the contract they write to.
2. Python, then Go, write kept recordings and run in the sandbox.
3. One sandbox image per language, built only when needed.
4. Verify plain JS and jest, or list them as limits.
5. `TraceDirectory`'s "no recording found" hint says `pytest --runshape` whatever the language:
   each recorder says how it's run.

### Phase 8: The agent loop (3–4 PRs)

1. `runshape check [base]`: JSON findings and an exit code per severity. `check` is a
   workflow in `workflows`, and the CLI and the GitHub Action (Phase 11) both run it.
2. A Claude Code skill and an optional Stop hook. The loop is optional on agent branches.
3. **Gate before human review:** `check --gate` must pass on the head commit. A check that
   didn't run, or ran on an older commit, fails. A bypass is allowed only when the agent tells
   you which findings remain and you say it's fine. The PR body records your OK.
4. Nightly self-correction on your own branches, pushed to a side branch.

### Phase 9: C# recorder

A Roslyn source rewrite, the same approach as Go and TS. Spike first. C++ is idea 7.

### Phase 10: Quest 3S

WebXR on the 3D scene, with hand-tracked grab-and-move writing to Phase 3's saved
arrangements. Needs your headset at every step.

### Phase 11: GitHub Action

The pipeline in CI, with findings as PR review comments. The action is the third app, a
composition root of its own: it reads its inputs and `GITHUB_TOKEN`, wires the API model and
GitHub comment sink, and runs the same workflows as the CLI.

## Decided (2026-10-19)

1. The data model comes first. Performance after.
2. Runshape (TypeScript) is the main codebase. No reordering for language.
3. Regions nest. A region is not a zone.
4. Complexity means paths that actually ran.
5. Self-correction is optional on agent branches. The check is required before human review.
   A bypass needs the findings told to you and your OK.
6. C++ is parked as idea 7.
7. Step 0: the VS Code adapter stays in the extension. The `latest`/`previous` layout stays
   as one `RunSource` adapter until Phase 7.
8. Step 0 uses option B: `trace` declares the ports it needs, and infra fits them without
   importing trace. Storage (infra), format (trace's data layer) and native → universal
   translation (each recorder) are three separate owners.

## Decided (2026-10-23)

1. The target architecture is the one at the end of GOALS.md. Phase 0b applies it before
   Phase 1.
2. Trace folds into core. The `trace` name passes to the trace module (diffs).
3. Decision 8 above is superseded in part. Storage, format and native → universal translation
   still have three separate owners, but the format is the kernel's and adapters import the kernel to
   implement its ports, rather than fitting them by shape without importing.
4. `core` is renamed `kernel` (Phase 0b, step 5), as a mechanical PR right after the trace fold.
   "Core" clashes with the hexagonal zone of the same name, which every module will have.
