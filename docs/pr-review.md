# Reviewing a pull request by its behaviour

A green test suite says every test still passes. It doesn't say which user journeys now
take a different route through the code. That's the signal this is for: record the tests on
the base and on the branch, and compare how each one *executed*.

## Locally

```sh
cd your-project
runshape-review --base origin/main -- -q          # anything after -- goes to pytest
```

The base is checked out into a temporary git worktree (your working tree is untouched), the
tests run there and then on your working tree, both with `--runshape`. Then, in VS Code:
**Runshape: Open Runtime View**, tick **Compare with previous recording**. Tests are ordered for
a reviewer:

1. **now failing**
2. **green, runs differently**: still passes, but calls new functions, stops calling
   others, moves calls under a new caller, makes different database/HTTP calls, or runs
   different lines in some function. Open one to see its execution diff and replay it.
3. now passing, new, removed, and (dimmed) unchanged.

Matching is by what ran — function names and statement text — not line numbers, so moving
code around doesn't show up as a change.

## In CI, as a PR comment

`runshape-review-md` (packages/cli) prints the same review as Markdown: test and function
names only, no SQL text or source.

```yaml
# Sketch: adapt the setup steps to your project.
- run: pip install -e path/to/runshape/recorder
- run: runshape-review --base origin/${{ github.base_ref }} -- -q
- run: node path/to/runshape/packages/cli/dist/runshape-review-md.mjs .runshape/traces > review.md
- run: gh pr comment ${{ github.event.number }} --body-file review.md
  env: { GH_TOKEN: "${{ github.token }}" }
```

Check out with full history (`fetch-depth: 0`) so the base commit exists.

## Caveats

- **Editable installs:** if the project itself is installed with `pip install -e .`, the base
  run may import the working tree's code instead of the worktree's. Run from the project
  directory without an editable install of it (`pythonpath` in pytest config is fine).
- Both runs share whatever the tests share (a database, a cache): tests that depend on state
  left by other tests can differ for that reason alone.
- On the settrace backend (Python < 3.12) recording needs `--no-cov` and no xdist (`-n0`).
