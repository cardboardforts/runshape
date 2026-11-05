# runshape-arch

The out-of-the-box catalog: the words Runshape, a person or a model can use to say what a piece
of code is. Everything here is Markdown so a person can read it, argue with it and fork it, and
so a skill can load only the file it needs.

The folder lives in the Runshape repo for now and is meant to move to its own repo once the
format has settled. "runshape-arch" is a working name.

## Why it exists

Reviewing code means rebuilding a picture of it in your head, and doing that again on every pull
request. A catalog gives that picture words that outlast one review.

- **For the author:** naming an algorithm or pattern takes a moment, and it saves every reviewer
  from reading the code three or four times waiting for the "aha".
- **For a reviewer who knows the pattern:** the shape is visible immediately.
- **For a reviewer who doesn't:** they now know what words to look up, and what it should look
  like. The catalog doubles as a teaching tool for junior developers.
- **For a small diff:** a 2-3 line change in a large pattern is hard to read cold. Tags such as
  `FooSlidingWindow`, `FooDataAccess`, `DatabaseSerializer` and `InfraLayer` tell a person or a
  model how to read those lines.

## What's in it

| Folder | Kind | Answers | Prescriptive? |
|---|---|---|---|
| [styles/](styles/) | How an area is built | "This system is hexagonal" | The style's rules apply once you claim it |
| [roles/](roles/) | The job a type or module does | "This is a `secondary-adapter`" | Describes |
| [traits/](traits/) | What code does when it runs | "This `writes-state`" | Describes; mostly detected, not assigned |
| [patterns/](patterns/) | A named group of code that works together | "These five functions are a sliding window" | Describes, and each entry says what must hold |
| [standards/](standards/) | What must be true | "Unhandled exceptions are logged" | Yes |
| [frameworks.md](frameworks.md) | What a framework usually implies | "Django usually means MVT" | Starting hints only |

"Rules" was hiding a split between describing code and prescribing it, so they're kept apart. A
sliding window is a thing you recognise. "Log unhandled exceptions" is a thing you enforce.
Calling the whole catalog "engineering standards" would make sliding window sound mandatory.

Entries relate to each other, because rules apply in tandem: **With:** names entries that are
usually found together, and **Conflicts:** names ones that pull against each other.

## Three structures, kept apart

Tags that look alike on a diff are often different things. In the example above:

| Tag | What it is | Structure |
|---|---|---|
| `InfraLayer` | A zone | Shape |
| `DatabaseSerializer` | A role | Shape |
| `FooDataAccess` | A named system | Systems tree |
| `FooSlidingWindow` | A pattern instance | Pattern instances |

- **Systems tree:** every piece of code sits in exactly one place. How the people working on it
  divide it up. Naming and grouping are theirs and have no wrong answer.
- **Shapes:** how a system is built inside. A style with zones and roles. Architecture has rules,
  so a claimed shape can be checked against the code.
- **Pattern instances:** named groups that overlap and cut across the tree. A function can sit in
  several. An instance links to a catalog entry, or uses a name of its own: freeform naming is
  allowed, since a team's own patterns are often the valuable ones.

## Product and workshop

Some of a repo isn't the product. The test: **does it run as part of the product?** Infrastructure
such as a database runs with the product. The workshop acts on it, and the product doesn't know it
exists.

| Kind | Role | Job | Examples | When it changes, ask |
|---|---|---|---|---|
| Docs | `docs` | Explain the system | `docs/`, `README.md` | Is this still true? |
| Dev tooling | `dev-tooling` | Work on it locally | `justfile`, dev scripts, linter config | Does it still work on a clean machine? |
| Delivery | `delivery` | Ship it | GitHub Actions, Dockerfiles, deploy config | What does this now have access to? |
| Repo config | `repo-config` | Settings for the repo itself | `.gitignore`, `.editorconfig`, lockfiles | Usually nothing |

The workshop has an architecture of its own: a pipeline is the composition root for shipping, and a
justfile is one for local development. They know about everything, and nothing in the product
depends on them. That's one standard, `std-product-ignores-the-workshop`.

Tests stay with the system they test, because they change with that code.

## The format

The format for all three structures is in [map-format.md](map-format.md). That file is the contract the other
work builds on.

## Entry formats

**Styles** carry frontmatter (`id`, `drawn`, `layout`, `zones`). `drawn: true` means Runshape can
draw it today, and its zones must match `packages/architecture/src/profiles.ts`.

**Roles and traits** are `### `id`` entries with a definition, signals and look-alikes. Ids match
`packages/architecture/src/taxonomy.ts`.

**Patterns** are `### `family-name`` entries:

| Field | Holds |
|---|---|
| **What** | What it is, in a line or two |
| **Parts** | The named parts an instance's code plays, such as `expand` and `shrink` |
| **Invariants** | What must hold. A reviewer's and a model's checklist |
| **Bugs** | How this pattern usually goes wrong |
| **Look-alikes** | What it's confused with, and how to tell them apart (optional) |
| **See it** | The default way to visualize it |
| **With / Conflicts** | Related entries (optional) |

Families: `gof-` (the Gang of Four), `modern-` (what the original book doesn't cover), `dist-`
(distributed systems and resilience), `dsa-` (algorithms and data structures). The entry's title is
also the term to search for when learning it.

**Standards** are `### `std-name`` entries with **Rule**, **Why**, **Check** (how a skill assesses
it) and **Severity**.

Text here is original. Names of patterns are common vocabulary; nothing is copied from the books.

## Tagging is a claim

A tag can make a reviewer stop reading. "Sliding window" tells you what to expect, and the bug is
exactly where the code doesn't do that. With AI authors tagging their own code, the claim and the
bug can come from the same place.

So every tag records who made it (`by`), and a tag is a hypothesis until someone checks it. The
**Invariants** field exists for that check.

## How it's used

- **[.claude/skills/runshape-map](../.claude/skills/runshape-map/SKILL.md)** reads this catalog
  during the first mapping interview. It uses styles, roles, patterns and frameworks.
- **[docs/tagged-diffs.md](../docs/tagged-diffs.md)** is the later work: showing tags on a diff,
  following line ranges, verifying claims.
- **Runshape itself** doesn't read this folder yet. `profiles.ts` and `taxonomy.ts` are still the
  source for the viewer. `packages/architecture/test/runshape-arch.test.ts` compares zone ids and
  role and trait ids until the two can be merged. It doesn't compare the prose, so the allowed-call
  lists in [styles/](styles/) are kept in step by hand.
- **[.claude/skills/architecture-shape](../.claude/skills/architecture-shape/SKILL.md)** predates
  this folder and repeats part of [styles/](styles/) in its `profiles.md`. It should read the
  catalog instead.

## Layering (not built yet)

The plan is default → framework → company → repo: start from this catalog, fork or override it
per company, and make micro adjustments per repo with `runshape.json` and `<!-- runshape -->`
comments in READMEs. When this moves to its own repo, a project should pin a version: a catalog
update must not read as an architecture change, and catalog text reaches a model, so it's untrusted
input like any other dependency.

## Open

- **Organization.** This layout is a first guess. Expect real tags to reorganize it.
- **Name.** `runshape-arch` is a working name.
- **`standards/` is a seed.** A short list to prove the format, not a complete set.
