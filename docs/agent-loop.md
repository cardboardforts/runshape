# The agent loop: `check` before human review

PLAN.md, Phase 8, step 1 (`check`) and step 5's gate. The user's rule (Decided 2026-10-19, 5): self-correction is optional on agent
branches; `check` is required before a branch goes to human review, and fails closed. A branch
goes past it only when the agent has told the person which findings are left and the person
said it's fine.

## `runshape check [<base>] [<head>] [--gate] [--json]`

Records whatever of the two isn't recorded yet, compares them (the same review `compare`
saves), and turns the review into findings. Base: the branch of merged code (origin's HEAD, or
`git config runshape.trustedBranch`). Head: the working tree. The exit code is the worst
finding left (`CheckExit`): 1 when something blocks or the check couldn't be made, 2 when there
are only warnings, 0 for nothing. Under `--gate` warnings exit 0, so a push goes.

| Rule | Default | What it finds |
|---|---|---|
| `now-failing` | block | A test that passed (or didn't exist) and now fails, errors or unexpectedly passes. |
| `new-violations` | block | A call between two boxes the style forbids that the base didn't make (the bundle's `violations`). |
| `categorizer-errors` | block | A new categorizer finding of severity `error` (docs/categorizer.md). |
| `categorizer-warnings` | warn | A new categorizer finding of severity `warn`. |
| `llm-placements` | warn | A zone rule or region added or changed in the branch with `"by": "llm"`: awaiting your approval in the diff, during human review (decided 2026-10-16: approving the merge approves the placements), so it never blocks by default. |
| `more-external-calls` | block | A workflow both sides ran makes more external calls than `allowedExternalCallIncrease` more. |
| `slower` | warn | A workflow past both of cost.ts's noise bands (10 ms and 50%), from one recording a side. |
| `uncommitted` | warn | The working tree has uncommitted changes. Always blocks under `--gate`. |
| `review-not-made` | block, always | The comparison couldn't be made (a recording failed, no fork point, the lock held). |
| `check-rules-unreadable` | block, always | The base's `check` section can't be read; the defaults were used. |
| `check-rules-changed` | warn, always | The branch changes the `check` section: it applies once merged. |

The rules are runshape.json's `check` section **on the base** (the fork point's, as kept with
its recording), never the branch's own: an agent can't loosen the gate it's checked by. Every
problem in the section is reported at once, and then the defaults are used whole.

```json
"check": { "rules": { "slower": "block", "categorizer-warnings": "off" }, "allowedExternalCallIncrease": 0 }
```

The result is kept in `.runshape/checks/last.json` (`runshape-check`, version 1) and logged
(`check.done`, `check.bypassed`, `check.review_not_made`, `check.bypass_recorded` in
.runshape/logs/runshape.log, with each blocking finding's rule and subject). `--json` prints
the same result for an agent; recording's progress goes to stderr.

## The gate and the bypass

`check --install-hook` writes a git pre-push hook (where git looks: core.hooksPath, or the
`.git/hooks` worktrees share) that runs `check --gate` on the branch checked out. A failing
check stops the push. It refuses to push a branch that isn't checked out (the check records the
working tree, which is yours; a commit would record in the sandbox), and never replaces a hook
that isn't Runshape's.

When findings are left that the person accepts, the agent tells them exactly which, and records
their words:

    runshape check --bypass -- Jane: the xfail is the known feed bug, ticket 12

That keeps `.runshape/checks/bypass.json` for the commit checked out and the blocking findings
of the last check. The gate passes that commit with those findings, prints the OK and a line
for the PR body, and logs `check.bypassed`. Another commit, or any finding the OK doesn't name,
is checked afresh. A bypass is refused for a check that isn't of the commit checked out, with
uncommitted changes, or with nothing blocking.

## In CI

The hook runs on a laptop; `git push --no-verify` skips it. CI is the gate a push can't skip.
The job needs the full history (the fork point) and the recorder's toolchain:

```yaml
# .github/workflows/runshape-check.yml (until Phase 11's Action)
on: pull_request
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - run: git remote set-head origin --auto
      - run: npx -y npm@11 ci
      - run: npm run runshape -- check origin/${{ github.base_ref }} --gate --json > runshape-check.json
      - if: always()
        uses: actions/upload-artifact@v4
        with: { name: runshape-check, path: runshape-check.json }
```

Not yet run in CI (Phase 11 proves the pipeline there). In CI the head is the checked-out PR merge commit, recorded as the working tree: that's the
job's own checkout, and `check` exits 1 on anything blocking. A bypass recorded on a laptop
doesn't travel (it's under .runshape, ignored): the PR body carries the OK line instead, for
the reviewer to see.

## Threats and accepted risks

| Boundary | Threat | Control | Accepted |
|---|---|---|---|
| Agent → its own gate (Elevation) | The agent edits runshape.json's `check` section or flips a placement to `"by": "user"`. | Rules come from the base; a changed section is reported; `"by"` changes show as rule changes in review. | — |
| Agent → bypass (Repudiation) | The agent runs `check --bypass` without asking. | The OK is recorded with its words, logged, printed for the PR body, and limited to one commit and the named findings. | The CLI can't tell a person from an agent at the terminal: the record is an audit trail, not authentication. |
| Push → review (Tampering) | `git push --no-verify` skips the hook. | CI runs the same check. | Unrecorded locally. |
| Code under review → agent (Spoofing) | A test or function named as an instruction, read in `--json`. | Names are only in `subject`; the check's own words are in `message`. | An agent reading the JSON must treat `subject` as data: the skill (step 5) says so. |
