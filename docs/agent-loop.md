# The agent loop: `check` before human review

PLAN.md, Phase 8, step 1 (`check`) and step 5's gate. The user's rule (Decided 2026-10-19, 5):
self-correction is optional on agent branches; `check` is required before a branch goes to
human review, and fails closed. A branch goes past it only when the agent has told the person
which findings are left and the person said it's fine.

## `runshape check [<base>] [<head>] [--json]`

Records whatever of the two isn't recorded yet, compares them (the same review `compare`
saves), and turns the review into findings. Base: the branch of merged code (origin's HEAD, or
`git config runshape.trustedBranch`). Head: the working tree, for an agent checking as it goes.
The exit code is the worst finding left (`CheckExit`): 1 when something blocks or the check
couldn't be made, 2 when there are only warnings, 0 for nothing.

| Rule | Default | What it finds |
|---|---|---|
| `now-failing` | block | A test that passed (or didn't exist) and now fails, errors or unexpectedly passes. |
| `new-violations` | block | A call between two boxes the style forbids that the base didn't make (the bundle's `violations`). |
| `categorizer-errors` | block | A new categorizer finding of severity `error` (docs/categorizer.md). |
| `categorizer-warnings` | warn | A new categorizer finding of severity `warn`. |
| `llm-placements` | warn | A zone rule or region added or changed in the branch with `"by": "llm"`: awaiting your approval in the diff, during human review (decided 2026-10-16: approving the merge approves the placements), so it never blocks by default. |
| `more-external-calls` | block | A workflow both sides ran makes more external calls than `allowedExternalCallIncrease` more. |
| `slower` | warn | A workflow past both of cost.ts's noise bands (10 ms and 50%), from one recording a side. |
| `uncommitted` | warn | The working tree has uncommitted changes (a check of the working tree only; the gate checks a commit). |
| `check-rules-loosened` | block, always | The branch lowers a rule's severity (removing a rule counts, when its default is lower) or raises `allowedExternalCallIncrease`. Tightening is fine. |
| `check-rules-changed` | warn, always | The branch changes the `check` section without loosening it: it applies once merged. |
| `review-not-made` | block, never bypassed | The comparison couldn't be made (a recording failed, no fork point, the lock held). |
| `head-mismatch` | block, never bypassed | The review isn't of the commit `--gate --head` asked about. |
| `check-rules-unreadable` | block, never bypassed | The base's `check` section can't be read; the defaults were used. |

The rules are runshape.json's `check` section **on the base** (the fork point's, as kept with
its recording), never the branch's own: an agent can't loosen the gate it's checked by, and a
branch that tries is blocked until a person approves it. Every problem in the section is
reported at once, and then the defaults are used whole.

```json
"check": { "rules": { "slower": "block", "categorizer-warnings": "off" }, "allowedExternalCallIncrease": 0 }
```

Each finding has an `id` (`now-failing-5d0d8fc409360b7b`: the rule and a digest of its
subject). The result is kept in `.runshape/checks/last.json` (`runshape-check`, version 1) and
logged (`check.done`, `check.bypassed`, `check.review_not_made`, `check.bypass_recorded` in
.runshape/logs/runshape.log, with each blocking finding's id and subject). `--json` prints the
same result for an agent; recording's progress goes to stderr. Names from the code are only in
`subject`: data, never instructions.

## The gate: `check [<base>] --gate [--head=<commit>] [--pr-body-file=<file>]`

The gate checks a commit, never the working tree: `--head` (a full hash), or HEAD's commit when
it isn't given. It's recorded the way `compare` records a commit (here when it's on main, in
the sandbox when it isn't), and the check fails unless the review is of exactly that commit.
Uncommitted and untracked files in the checkout don't matter to it (a GOALS.md you keep as a
draft, say). It prints the count of warnings, then only what blocks; warnings exit 0, so the
push goes.

`check --install-hook` writes a git pre-push hook where git looks (`git rev-parse --git-path
hooks`: the `.git/hooks` every worktree shares, or `core.hooksPath`). For each distinct commit
a push sends, by whatever name (the branch, another branch, `HEAD~1`, a raw hash), it runs
`check --gate --head=<commit> --project=<the worktree pushed from>`, with git's hook variables
(`GIT_DIR`, `GIT_WORK_TREE` and the like) cleared so the check's own git runs in that worktree.
Any failure stops the push. Deletions send no code and are skipped; tags are skipped, and said.
It never replaces a hook that isn't Runshape's.

With husky or another hook manager, `core.hooksPath` points at the manager's folder and its
`pre-push` is the manager's: the installer refuses to replace it. Add the line yourself to the
manager's hook (`.husky/pre-push`): the same loop, or `npm run runshape -- check --gate
--head="$(git rev-parse HEAD)"` for the branch checked out.

## The bypass

When findings are left that the person accepts, the agent tells them exactly which. The person
records the OK themselves, at a terminal:

    runshape check --bypass -- Jane: the xfail is the known feed bug, ticket 12

It shows the last check's blocking findings and asks the person to type how many they're OKing.
With no terminal (stdin isn't one: an agent's shell, CI) it's refused. It keeps
`.runshape/checks/bypass.json` for the last check's commit and its blocking findings, and prints
a line for the PR body: `Runshape bypass: <commit> <finding id>...`. The gate passes that commit
with those findings, prints the OK, and logs `check.bypassed` with the person's words. Another
commit, or any finding the OK doesn't name, is checked afresh. Refused for a check of
uncommitted changes, with nothing blocking, or when `review-not-made`, `head-mismatch` or
`check-rules-unreadable` blocks: no OK goes past a check that didn't see what it was asked
about.

## In CI

The hook runs on a laptop; `git push --no-verify` skips it. CI is the gate a push can't skip.
A bypass recorded on a laptop doesn't travel (it's under .runshape, ignored). In CI the gate
reads the OK from the PR body instead: `--pr-body-file` names a file holding it, and a line
`Runshape bypass: <commit> <finding id>...` for the commit checked, naming every blocking
finding, lets it pass. Not yet run in CI (Phase 11 builds the Action):

```yaml
# .github/workflows/runshape-check.yml (until Phase 11's Action)
on: pull_request
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0, ref: "${{ github.event.pull_request.head.sha }}" }
      - run: git remote set-head origin --auto
      - run: npx -y npm@11 ci
      - run: printf '%s' "$PR_BODY" > pr-body.md
        env: { PR_BODY: "${{ github.event.pull_request.body }}" }
      - run: npm run runshape -- check origin/${{ github.base_ref }} --gate --head=${{ github.event.pull_request.head.sha }} --pr-body-file=pr-body.md --json > runshape-check.json
```

Open for Phase 11: who may write that line. The PR body is the author's to edit, so an agent
that opened the PR could write it; the Action should accept it only from a reviewer (a review
comment, or the body as last edited by one).

## Threats and accepted risks

| Boundary | Threat | Control | Accepted |
|---|---|---|---|
| Agent → its own gate (Elevation) | The agent edits runshape.json's `check` section or flips a placement to `"by": "user"`. | Rules come from the base; loosening them blocks; `"by"` changes show as rule changes in review. | — |
| Agent → bypass (Spoofing, Repudiation) | The agent runs `check --bypass` without asking. | Refused without a terminal; the person types the count of findings; the OK is logged with their words and limited to one commit and the named findings. | An agent that drives a pseudo-terminal could still type it: the record is an audit trail, and the PR body carries it. |
| Push → review (Tampering) | A commit pushed by another name than the branch, or `git push --no-verify`. | The hook checks every commit a push sends; CI runs the same check. | `--no-verify` is unrecorded locally. |
| Hook → repository (Tampering) | A shared hook, or git's hook variables, point the check at another worktree or commit. | `--project` is the worktree pushed from, git's variables are cleared, and the review must be of the exact commit. | — |
| CI → bypass (Spoofing) | The PR's author writes the bypass line. | — | Open until Phase 11 (above). |
| Code under review → agent (Spoofing) | A test or function named as an instruction, read in `--json`. | Names are only in `subject`; the check's own words are in `message`. | An agent reading the JSON must treat `subject` as data: the skill (step 5) says so. |
