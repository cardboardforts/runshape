# Why the interview works this way

From the design conversation of 2026-11-04 and 2026-11-05: how to drill down, and how to assign things
from the catalog. Showing tags on a diff is parked in
[docs/tagged-diffs.md](../../../docs/tagged-diffs.md). The vocabulary is in
[runshape-arch](../../../runshape-arch/README.md).

## The idea

Ask how many systems are in an area, starting at the repo root, then recursively ask the same thing of
each system. It's an interview because the goal is understanding how the developer thinks of their
software. If the LLM does all the thinking at this point, that defeats the purpose. The person has to
describe how they see it on the first pass.

## Many answers are right

Taking `cardboard-genome`, all of these are valid:

- Six systems: auth, core, patient portal, practitioner portal, FHIR, shared design.
- Two: frontend (portals and shared design), backend (core, auth, FHIR).
- Three: include a database, and put it with auth and FHIR in an infra section.

This is non-deterministic on purpose. These answers are mostly groupings over the same leaves, so one
tree is stored for now, because later diffs need a stable one.

That example is also why `paths` is a list and `style` is optional. "Backend" spans `api/`, `auth/` and
`fhir/`, and has no style of its own. A database may have no code. Regions in `runshape.json` can't say
any of that yet, so the map is its own section.

Six names also left out `lab/`, `fhirloader/` and `docs/`. Either those belong to a named system, or the
person forgot them. Only they can say, and a script can ask.

## Four answers at each level

The recursion is two questions in one: **is this made of parts, or does it have a shape?** Parts go
deeper. A shape stops the recursion and hands over to styles and zones. Asking that gives the skill a
natural stopping point.

Trying it on `cardboard-genome` added a third answer, **plain**: understood, with nothing inside worth
breaking down. A `docs` folder isn't a mystery and has no zones, so neither "shape" nor "don't know" was
true of it.

The fourth answer is **I don't know**. The larger the codebase, the more likely you'll look at something
and say "I have no idea", and label it "thar be dragons" or "spaghetti". That's a valid answer, not a
gap to fill.

- `dragons` is a gap in understanding, and `spaghetti` is a verdict on the code.
- Neither is the same as unmapped code, which nobody has looked at.
- Both count as claimed, so three systems and one giant dragon is an honest, complete map of a big repo.
- The skill stops there. It doesn't guess inside or press for more.

## The workshop

Docs, a justfile and GitHub Actions had no good description. The test is whether something runs as part
of the product. Infrastructure runs with the product, and the workshop acts on it. The word and its kinds
are in the [catalog](../../../runshape-arch/README.md#product-and-workshop). It's a known category, so the
skill may suggest it for leftovers.

## Who answers first

Offering options conflicts with the goal: once someone sees a model's three decompositions, they pick
one. So the person always goes first on how to divide things up, and what the model does next depends on
the kind of answer.

That doesn't mean a blank question. On the first run, asking raw felt like too little to go on, so each
level opens with a summary of what's there. The line is between an inventory, which says what exists,
and a decomposition, which says how to group it. The skill gives the first and never the second.

| Answer | Example | Model's role |
|---|---|---|
| **Naming and grouping** | "Portals and design are the frontend" | Summarizes what exists, then maps the words to folders. No wrong answers |
| **Shape claims** | "Core is hexagonal" | Examines the claim, because architecture has rules and isn't pure imagination |
| **Zones and roles** | "That's a DTO" | Can suggest from the catalog |
| **Patterns** | "This is a sliding window" | Can suggest from the catalog, since recognizing one has right answers |

A failed shape claim has three valid outcomes: the code drifted, the label is wrong, or it's a deliberate
exception that gets a recorded reason.

Expectations between systems are the other half of the value. "Does the patient portal talk to FHIR
directly?" is answered by the person first, then by the code. Surprises there are what makes this worth
doing.

## It isn't a chore

This work isn't new. Senior engineers already run this mental exercise over every file touched by every
AI-generated pull request, and redo it each time. The map keeps the answer. So the interview goes as deep
as the person wants in one sitting, and on a small repo such as `cardboard-genome`, which is mostly
scaffolding, it's quick. The map then grows with the code.

## Learning

Because architecture has rules, this can also be a learning exercise for junior developers. It's the same
interview, with the model asking follow-up questions instead of giving verdicts. Comparing their map with
the team's shows where they differ, and that difference is the lesson. Catalog titles give them the words
to look up.

## Pattern tags

Instances live in `runshape.json` for now. Names are freeform, with or without a catalog entry. Line
ranges are wanted even though they can go stale: they only break if the lines move, a diff can detect
that, and recording the commit a range was tagged at makes that possible. This skill records the range
and the commit. Following it forward is [later work](../../../docs/tagged-diffs.md#line-ranges).

## Where it runs

The skill runs the conversation, and `check-map.mjs` does the checks, so a claim about coverage comes from
a script rather than a model. Next steps, not built: a button that opens this skill in a terminal while the
panel redraws from the file, then a no-model path in the panel for naming boxes and dragging folders into
them.
