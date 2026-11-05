# Tagged diffs (parked)

Status: **not started**, on purpose. The first two steps come first: the
[catalog](../runshape-arch/README.md) and the [mapping skill](../.claude/skills/runshape-map/SKILL.md).
This records what was said in the design conversation of 2026-11-04 and 2026-11-05, so that work doesn't
close off this one.

## What it's for

A diff sometimes shows 2 or 3 lines of a rather large pattern, and it's hard to tell what that code is in
the larger context. If those lines carried tags (`FooSlidingWindow`, `FooDataAccess`,
`DatabaseSerializer`, `InfraLayer`), a person or a model would know right away how to read them.

- If an author implements an algorithm and tags it, reviewers who know that algorithm see the shape at
  once, without reading it three or four times waiting for the "aha".
- A reviewer who doesn't know it learns what words to look up, and how it should look.
- Anyone touching one part of `Foo Sliding Window` can see all its parts, and how the change affects them.

## What a reviewer would see

```
FooStore.advance  +3 -1
  Zone      outbound-adapter
  Role      serializer
  System    Foo data access
  Pattern   Foo Sliding Window (dsa-sliding-window), part: shrink
            claimed by the author, not verified
            Other parts, not in this diff: expand, aggregate, emit
            Common bugs: off-by-one on shrink
```

The last three lines are the gain: the rest of the pattern is on screen though the diff never touched it.

## Line ranges

Pattern parts can carry `lines` and the `commit` they were tagged at
([map-format.md](../runshape-arch/map-format.md#pattern-instances)). Ranges break easily, and they're
still wanted: they only break if the lines move, and a diff can detect that.

To build:

- Follow a range from its commit to head through `git diff`. Unchanged lines that moved just get new
  numbers.
- A range whose own lines changed needs a person: the tag may no longer be true.
- A deleted range is a question, not a silent removal.
- Decide whether updated numbers are rewritten into `runshape.json`, or worked out on read and left alone.

The skill only records ranges. `check-map` confirms a range was valid at its commit, and nothing more.

## Tags are claims

A tag can make a reviewer stop reading. The bug is exactly where the code doesn't do what the tag says,
and with AI authors tagging their own code, the claim and the bug can come from the same place.

- Every tag shows who claimed it, and whether anyone checked it. Unverified reads as a hypothesis.
- A model can test a tag against the catalog entry's **Invariants**. Phase 8's challenge pass fits here.
- A change that touches a tagged part should reconsider the tag.

## Questions at PR time

The interview continues in review, which is what keeps the map current: a map that drifts is worse than no
map.

- A new folder no system claims gets one question on the PR: "where does this go?"
- A change to a pattern's code asks whether the tag still holds.
- Patterns are mostly tagged here, by the author, rather than during onboarding.
- Answers commit with the branch, approved in the diff at merge like any other placement.

## Dragons in review

Unknown code must get louder in review, not quieter.

- A PR touching `dragons` or `spaghetti` gets a callout, because nobody can vouch for that code.
- There are no style violations inside, since there's no claimed shape to break.
- Calls across the boundary are still shown.
- A recording is how a dragon gets slain: a test through it gives you something to look at. Moving code
  from dragons to mapped shows in the diff as progress.
- Open: should new code be allowed into a dragon? Leaning warn, not block.
- Open: should a dragon's age show? Leaning show it, and never expire it.

## The workshop in review

How loud a change is shouldn't follow its size. A two-line change to a pipeline can matter more than a
large one to docs, because delivery holds secrets and is the path to production. The questions are in the
[catalog](../runshape-arch/README.md#product-and-workshop).

- Delivery changes get a callout, whatever their size: what does this now have access to?
- Docs changes are low risk, but a code change whose docs didn't change may leave them out of date.

## Checking expectations

`expects` entries in the map become rules a change can break. Import violations stay a separate rule,
warn-only by default, so a heuristic can't block a PR.

## Visualizing a pattern

The catalog's **See it** is the default. Start with a template diagram with the tagged parts highlighted.
Animating a window moving over data needs values, and whether the recorders can capture those hasn't been
checked. Related: [ideas.md](ideas.md) section 5.

## A static scan

Parked with this work. A scan would give new users a view with no tests, and evidence for the interview.

- Add a `CodeMap` value in the kernel rather than faking a `Run`: synthetic spans would claim tests and
  timings that never happened.
- Import lines aren't call lines: draw them differently, and keep them out of replays and cost.
- `diffArchitecture` needs no `Run`, so two scans can be diffed with no tests at all.
- **Comparing a scan to a recording gives false results.** Snapshots only list components the tests ran,
  so a scan base would show everything else as removed. Snapshots need a `basis` field, and diffs of
  observed placements should refuse mixed bases.
- Scan names must match recorder names exactly, or rules adopted from a scan won't match a recording. Test
  this on every app in `examples/`.
- With both a scan and a recording, untested code can be drawn as ghosts. That's the GOALS.md demo: "some
  handlers don't have any lines going to them."

## Depends on

- Runshape reading the `map` section at all. Today it only preserves it.
- Paths turned into dotted names, so the map can meet recordings.
- A file and line per function on the PR page (Phase 6 left this out; Phase 8's eval work needs it too).
- The catalog moved out and pinned: an update mustn't read as an architecture change.
