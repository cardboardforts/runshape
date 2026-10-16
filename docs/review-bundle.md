# Review bundle (format 1)

One comparison of two recordings, saved as a file. `npm run runshape -- compare <base> [<head>]`
writes it to `.runshape/reviews/<base id>..<head id>/`:

- `review.json`: the bundle, for tools (a PR comment job, a morning page, a central store).
- `review.md`: the same as Markdown, to read or to post as a PR comment.

Built by `buildReviewBundle` and `reviewBundleMarkdown` (packages/core/src/review-bundle.ts).
The bundle holds names only: test, function, class and route names, rule globs and reasons.
It holds no SQL text and no source.

## Fields

| Field | What it is |
|---|---|
| `format`, `version` | `"runshape-review"`, `1`. A reader should refuse a format or version it doesn't know. |
| `createdAt` | When the bundle was made (ISO 8601, UTC). |
| `base`, `head` | Each side: `asked` (what the person named: `main`, `working`, a branch or commit), `recording` (the kept recording's id: 12 hex digits, or `working`), `commit`, `subject`. By default the base is where head's branch left it (`git merge-base`), not the branch's newest commit. |
| `options` | The views' options: `phases` (`["call"]`: test bodies) and `grouping` (middleware as one box). |
| `baseRulesKnown` | False when the base's own `runshape.json` wasn't known (its recording predates kept zones), in which case both sides used head's. |
| `review` | Tests by what a reviewer should look at first (`ReviewSummary`, packages/views/src/review.ts). `counts` by category, `items` with each test's change, `moved` code, `caveats`. |
| `architecture` | How the architecture changed (`ArchitectureDiff`, packages/views/src/architecture-diff.ts). Both sides are placed in head's style. The parts: `rules` added, removed or changed; `decided` (placements a rule made or unmade); `observed` (inferred zones that moved with the tests' behaviour); `unplaced` (code the base's tests never ran, which no rule places); `removed`; `unusedRules`; and `zones` (ids and names). |
| `routes` | Requests by route, and how each route's ways through the code changed (`RouteMapDiff`, packages/views/src/routes.ts). A changed way lists `nowCalls` and `noLongerCalls`. |

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
- An explanation of *why* the code changed (from commits, the PR description or tickets).
  That comes from a separate step, annotating the bundle without changing it.
