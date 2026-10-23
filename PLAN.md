# Plan: from where Runshape is to GOALS.md

Draft 2, 2026-10-19, for you to check. Nothing here is started. Each phase is a stack of small
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
| Performance impact up front | **Gap**: spans carry `startUs`/`endUs` | Compare never diffs cost. Tracing overhead makes raw timings lie. |
| Complexity | **Gap** | Not computed. |
| The ticket story | **Partial**: commit messages only | No PR body, linked issues, docs or Jira. |
| Categorizer: places new code, spots renames, and "now does another zone's job" | **Partial**: zone advice on click, `moves.ts` renames, architecture diff "moved with behaviour" | Not automatic for new or changed code in a branch. No callout for a function drifting into another zone. |
| Review module: comments, partial approval, approve, comments go somewhere | **Gap** | Nothing. |
| AI sees what the reviewer will see | **Partial**: `review.json` | No agent contract, gate or loop. |
| VS Code, 2D, Quest 3S (arrange with hands) | VS Code and 2D done; 3D in three.js | No WebXR, no arranging. |
| Python, JS/TS, Go, C#, C++; "test config in, universal trace out" | Python, TS (vitest), Go | No shared recorder contract (each takes its own config). C# missing. C++ parked (idea 7). |

## What the updated GOALS.md changes

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
   "Next".
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

**From the READMEs you're writing (2026-10-23), for later:**
- Infra holds comment sinks too (post to GitHub, or collect for a local LLM): Phase 6's
  comments port lands there.
- Core is meant as a light glossary of the shared domain objects, with each module
  self-contained. The recordings workflow (PR 7) now sits in core and is 600 lines of
  workflow, not glossary. A follow-up could give it a module of its own (for example
  `@runshape/recordings`, importing core) and leave core its types and ports. Not done:
  it's your call.

**Done when:** `grep node:fs` finds only infra and the hosts (done: the boundary test holds it). The demo has no fake pointer
files. `runshape readmes` shows no "doesn't fit" questions you haven't decided.

### Phase 1: The PR page and threads to follow (3–4 PRs)

1. **Threads:** for each changed function or class, the scenarios and routes that run
   through it, on base and head. Grouped as same / different / new / gone, and written into
   `review.json` and `review.md`.
2. **One PR page:** summary, threads, callouts, and a way into each thread's graph and wires.
   Opened from the morning list, where stacked PRs are grouped and ordered bottom-up.
3. **Group by cause:** Runshape's review of its own PR 3a listed 66 "run differently" tests,
   every one because calls now go through `ReviewStore`. Threads with the same change
   collapse into one row ("66 tests: now save reviews through ReviewStore"), expandable.
   A test whose title changed pairs with its old self, as moved tests do (PR 3b's renamed
   test read as one removed and one new).
4. **Structured CLI logging:** logfmt, with a run ID and PR number on every line, duration
   per PR, and the full error for each PR that fails.

**Done when:** morning list → a PR → "these 6 workflows run through `Service.place`; 2
behave differently" works on a real Runshape PR.

### Phase 2: Nested regions, seams, the module view (5–6 PRs)

1. **runshape.json v3, nested regions:** a region is an area with one style. A zone is a slot
   inside that style. A child region sits inside one of its parent's zones, the innermost
   match wins, and a child spanning two parent zones is a load error. Still reads v1 and v2.
2. **Seams:** a call that crosses a region boundary. Going in through the parent's zone is
   expected; reaching past it is a violation. Mixing styles inside one region is a smell.
3. **Event-driven profile**, recognised from the recorded call pattern.
4. **Module view:** the default view is modules with dependency lines, changed ones marked.
   Click to open a region's shape, its sub-modules, its classes, then a function's diff.
5. **Categorizer on the branch:** new or changed code that no rule covers gets a proposed
   placement, committed to the branch for approval in the diff. A function now doing another
   zone's work is called out, with renames recognised (`moves.ts`) so a rename isn't mistaken
   for a new function.
6. **Two misreadings Runshape's own folder guides showed (Phase 0, PR 5):** a composition
   root wiring adapters is not a handler skipping the core, and calling a function you were
   handed (a callback) is not a dependency pointing outward.

**Done when:** Runshape opens at its modules (recorders, trace, infra, architecture, …), a
changed module is marked, and clicking down reaches a function's diff.

### Phase 3: Pre-visualization and arrangement (3–4 PRs)

1. **A visual model:** each zoom level reduced to what's drawn (aggregated edges, collapsed
   regions, capped detail), computed once and shared by 2D and 3D. Measured: render time on
   the largest fixture before and after.
2. **The same model for agents:** `runshape view --json`, what a human would see at each level.
3. **Saved arrangements:** moving a module in 2D or 3D is saved, keyed by region and module
   names so it survives between diffs. New things get a computed spot near their neighbours.

### Phase 4: Performance and complexity, honestly (3–4 PRs)

1. **Cost diff per thread:** call counts, queries per request (N+1), a DB or network call
   newly inside a loop. Example: "`POST /orders` now makes 12 queries, up from 3".
2. **Time diff:** self-time with the recorder's overhead subtracted, and reported only above a
   noise band measured by recording twice. Each one is labelled with who waits.
3. **Complexity:** distinct paths that ran, per function and per route, before vs after.

**Done when:** a seeded N+1 and a seeded network call in a loop are called out with the route
that pays. A no-op change has no time callout.

### Phase 5: The story (2–3 PRs)

1. The PR title, body and linked issues through `gh`, as untrusted data. The threat model gets
   a new row.
2. A `TicketSource` port with GitHub Issues first. Jira when you need it.
3. Changed code comments and docs as context. The explainer says what the change is *for*,
   and flags behaviour the ticket doesn't mention.

### Phase 6: The review module (4–5 PRs)

1. **Beams:** from a function, the unit, integration and e2e tests through it. Pick one to
   walk its execution backwards with timing deltas.
2. **Review progress:** check off threads, functions and regions as reviewed. Saved per PR
   and head commit, so a new push un-checks only what changed.
3. **Comments port:** a comment pinned to a function, test or region. Sinks:
   - GitHub review comments (posting asks you first),
   - a local agent task list,
   - a new ticket.
4. **Finish:** approve, send to a local agent, or post. Voice input (whisper) later.

### Phase 7: Every recorder in the pipeline (3–4 PRs)

1. A shared recorder contract: `TestConfig` in, universal trace out. `TestConfig` is designed
   here with the recorders (Phase 0 kept `RecordTarget` rather than name it early).
2. Python, then Go, write kept recordings and run in the sandbox.
3. One sandbox image per language, built only when needed.
4. Verify plain JS and jest, or list them as limits.
5. `TraceDirectory`'s "no recording found" hint says `pytest --runshape` whatever the language:
   each recorder says how it's run.

### Phase 8: The agent loop (3–4 PRs)

1. `runshape check [base]`: JSON findings and an exit code per severity.
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

The pipeline in CI, with findings as PR review comments.

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
