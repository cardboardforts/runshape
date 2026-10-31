# Review bundle (format 1)

One comparison of two recordings, saved as a file. `npm run runshape -- compare <base> [<head>]`
writes it to `.runshape/reviews/<base id>..<head id>/`:

- `review.json`: the bundle, for tools (a PR comment job, a morning page, a central store).
- `review.md`: the same as Markdown, to read or to post as a PR comment.
- `page.json`: the PR page's content (the kernel's `ReviewPage`), worked out from the bundle so the UI
  draws kernel types only: callouts, the tests grouped by cause, the threads, each test by its id,
  and the story. Rewritten when the review is explained, so its story carries the model's
  account (what the change is for, what the PR and tickets don't mention), labelled as the model's.
- `review-draft.json`: a review in progress, written by `review <name> check` and `comment`
  (see [Reviewing it](#reviewing-it)). Never written by `compare`, so comparing the working tree
  again keeps it.

Built by `buildReviewBundle` and `reviewBundleMarkdown` (packages/kernel/src/review-bundle.ts).
The bundle holds names only: test, function, class and route names (patterns, never a
request as sent), rule globs and reasons, and each external call as its system and kind
(`sqlite: SELECT`). It holds no query text and no source. Those stay in the recordings, on
the machine that made them, since a bundle may be stored centrally.

## Fields

| Field | What it is |
|---|---|
| `format`, `version` | `"runshape-review"`, `1`. A reader should refuse a format or version it doesn't know. |
| `createdAt` | When the bundle was made (ISO 8601, UTC). |
| `base`, `head` | Each side: `asked` (what the person named: `main`, `working`, a branch or commit), `recording` (the kept recording's id: 12 hex digits, or `working`), `commit`, `subject`, `dirty` (the working tree had changes `commit` doesn't hold), and `forkOf`. By default the base is where head's branch left it (`git merge-base`); then `forkOf` gives that branch's newest commit (`tip`) and `commitsSince`. It is null with `--tip`, or when the branch hadn't moved. |
| `options` | The views' options: `phases` (`["call"]`: test bodies) and `grouping` (middleware as one box). |
| `baseRulesKnown` | False when the base's own `runshape.json` wasn't known (its recording predates kept zones), in which case both sides used head's. |
| `review` | Tests by what a reviewer should look at first (`ReviewSummary`, packages/kernel/src/comparison-views.ts, built by packages/trace/src/review.ts). `counts` by category, `items` with each test's change, `moved` code, `caveats`. |
| `architecture` | How the architecture changed (`ArchitectureDiff`, packages/trace/src/architecture-diff.ts). Both sides are placed in head's style. The parts: `rules` added, removed or changed; `decided` (placements a rule made or unmade); `observed` (inferred zones that moved with the tests' behaviour); `unplaced` (code the base's tests never ran, which no rule places); `removed`; `unusedRules`; and `zones` (ids and names). |
| `routes` | The routes whose ways through the code changed, and a count of those that didn't (`unchanged`): copying unchanged routes would make the bundle as big as the suite. Each route has `ways`, each with `change`, request counts `before`/`after`, `skips`/`adds` against the route's main way, `nowCalls`/`noLongerCalls` for a changed way, the `tests` that took it, and its `path` (steps with `op`, `depth`, `label`). |
| `threads` | The threads to follow (`Threads`, packages/trace/src/threads.ts): each function the change touched (`functions`, the ones whose workflows changed first) with its `change` (`edited`, `added` or `removed` when both recordings keep their source, `basis: "source"`; `ran differently` when they don't, `basis: "behaviour"`), the `threads` through it (each scenario's `name` and `kind`: `same`, `different`, `new`, `gone`) and the `routes` whose requests pass through it (`on`: `both`, `head`, `base`). Names and route patterns only. Added after version 1's first release: readers treat it as optional. |
| `cost` | What the change costs at run time (`CostDiff`, packages/trace/src/cost.ts). `workflows`: every scenario (each test's last attempt, when retried) with `sides` (`both`, `new`, `gone`: only `both` are compared), `timeUs`, `calls` (project code), `externalCalls` (every boundary call: SQL, HTTP, whatever the recorder saw) and per-route `requests` and `externalCalls`, each a `{before, after}` (null on a side without the workflow), and a `time` verdict: `slower` or `faster` only past both `noiseFloorUs` and `noiseRatio`, else `within-noise`; `not-comparable` when the sides were recorded by a different recorder, backend or runtime release; `one-side`. `functions`: each changed function (the threads') with `calls`, `timeUs` (total, what it calls included), `timePerCallUs` (what the verdict is on, so more callers isn't slower), `selfTimePerCallUs`, `externalCalls` under it and `paths` (distinct paths that ran: sets of line-to-line steps, so loop iterations aren't paths); times are null on a side that never ran it. `recordingsPerSide` is 1 and `caveats` say what that means. Added after version 1's first release: readers treat it as optional. |
| `categories` | The categorizer on head (docs/categorizer.md). `items` are head's changed callables, the types holding them, and new unplaced code, each with its `kind`, `zone` and `tags`. Each tag is a claim: `id`, `lens`, `by`, `confidence`, `evidence`, with names, zones, route patterns and line numbers only. `newFindings` are findings head has that the base didn't, with renames recognised. `proposals` is a zone rule (`"by": "detected"`) for each new class or module no rule places: a suggestion for runshape.json, never applied. `missing` lists what the trace can't support. Added after version 1's first release: readers treat it as optional. |
| `story` | What the change is for, as the people asking for it said (`ReviewStory`, packages/workflows/src/story.ts). `pullRequest` (`number`, `title`, `url`; null for a comparison of branches), `tickets` (each `id` as the change mentions it, its `source`, `title`, `url` and `state`), `unread` (mentioned but not read: no such ticket, the source failed, past the limit of 8; or the PR itself, or the diff, couldn't be read; each with its `reason`) and `notes`: the docs (Markdown, reStructuredText, AsciiDoc) and the source files whose comment lines changed, each with `kind` (`doc`, `comments`) and how many lines were `added` and `removed`. Titles, links and counts only: PR bodies, ticket text and the changed lines go to the explainer, never into the bundle. Links are https, or null. Tickets come from GitHub Issues through `gh`: the PR's linked issues, and `#N` or `owner/repo#N` in its title, body and commit messages. Another tracker (Jira) is another `TicketSource` adapter, not written yet. Added after version 1's first release: readers treat it as optional. |

## Reviewing it

`npm run runshape -- review <base>..<head>` lists what there is to check off, worked out from
`page.json` by the review module (`@runshape/review`): each thread, the functions in it with the
tests through them, then each test whose behaviour changed, numbered. Then:

- `review <name> check <n>...` checks them off. Each is kept with a fingerprint of what the page
  showed of it, so after comparing the working tree again only what now looks different is
  un-checked (`[~]`).
- `review <name> comment <n|change> <text>` leaves a comment on one of them, or on the change.
- `review <name> send agent [--request-changes]` writes `.runshape/revisions/<name>.json`: the
  comments as a revision request for a local agent to act on (the Phase 8 loop reads it). It
  says which text is the reviewer's and which (function and test names) comes from the code.
- `review <name> send github [--pr=N] [--approve|--request-changes]` shows the PR review it
  would post and posts nothing. With `--post` it posts it, as one review, through `gh pr
  review`: only to the PR the review is of, and only if the PR's head is still the commit that
  was reviewed. Names from the code go out as plain text (no mentions, links or HTML).

The log records each send by its sink, verdict, comment count and destination, never the
comments' text.

## Making one in CI

The base is measured from the fork point, which needs history: check out with `fetch-depth: 0`
(or `git fetch --unshallow`). Without it, `compare` refuses rather than quietly comparing with
the base's newest commit. `.runshape/reviews/<base>..working` is replaced by each compare of
the working tree; a commit-to-commit review is replaced only by comparing the same two again.

## What a reader can rely on

- **Decisions are kept apart from observations.** Anything in `architecture.decided` or
  `architecture.rules` was decided by a person, a model or the detector (`decidedBy`), and
  approving the change approves it. `architecture.observed` was decided by nobody: an inferred
  zone moved because the tests behave differently.
- **Placements cover what the recorded tests ran.** Code no test reaches has no placement, so
  "unplaced" means the base's tests never ran it. It doesn't necessarily mean the code is new.
- **Fields are only added within a version.** Removing or renaming a field means a new version.

## Not in it yet

- The graph itself (boxes and edges). It depends on view options, and the recordings it's
  drawn from are kept alongside.
- An explanation of *why* the code changed. `compare --explain` asks a language model and
  saves its answer beside the bundle (`explanation.json`, `explanation.md`). The answer is
  marked with the model that gave it and what it was based on (the review's Markdown hash and
  the commits, a digest of the story), and the bundle itself is left unchanged. It reads the
  story's text too (the PR body, each ticket, the changed docs and comment lines), says what
  the change is for (`purpose`), and lists behaviour the PR and tickets don't mention
  (`notInStory`).
