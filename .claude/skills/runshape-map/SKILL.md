---
name: runshape-map
description: Interview a developer to map their codebase the way they see it - which systems it has, how each breaks down, what shape each has, what they don't know - and save that to runshape.json using the runshape-arch catalog. Use when asked to map a repo, do the initial Runshape catalog or setup, "how do I see this codebase", or to break a system down. Not for guessing an architecture without the person: that's architecture-shape.
---

# Runshape map

You are helping a developer write down how they see their software. **The answers are theirs.**
The point is capturing their mental model, so if you do the thinking, the result is worthless, however
good it looks.

Why it's built this way: [design.md](design.md). The format you write:
`<catalog>/map-format.md`.

## Before the first question

1. Find the catalog, and see what exists:

   ```sh
   node <this skill>/scripts/check-map.mjs where
   node <this skill>/scripts/check-map.mjs --project .
   ```

2. Read `<catalog>/map-format.md`. Read `styles/README.md` and the rest of the catalog only when a
   question needs it.
3. If `map.systems` already has entries, say what's there and ask where to continue. Don't start over.
4. If the person is learning rather than recording the team's view, use **Teaching mode** below.

Stop and say so if `check-map` reports `problems` you didn't cause, or if this isn't a git repository.

Your own reading (READMEs, the file tree) is fine. Don't share what you find until the person has
answered.

## The loop

Run this for the repo root, then for each system the person wants to go into. Each level:

### 1. Ask, with no suggestions

> How many systems are in `<this area>`, and what are they? Say what each one is for, in your own words.

Ask in plain text. Do **not** offer options here, list folders, or use `AskUserQuestion`. Once someone
sees three decompositions, they just pick one. There are many valid answers, and that's on purpose.

If they say they don't know where to start, then offer the file tree, not a decomposition.

### 2. Map their words to code

Propose `paths` for each system. Keep their names and their description, word for word. Show it as a short
list. This is your work and theirs to correct, so it's `"by": "user"` with `"pathsBy": "llm"`.

A system may span several folders, or have no code at all (a database, a vendor).

### 3. Ask about what's left

Save (see **Saving**), run `check-map`, and take its findings to the person:

- `unclaimed`: ask where each group belongs. Never place one yourself. A group under `within` is code
  a parent holds that none of its parts claim.
- `claimedTwice`: ask which system owns it. Shared code is often a system of its own.
- `noCode`: confirm it's meant to have none, or fix the path.

Leftovers are the most useful output of the first pass, so ask even when you could guess. Root files
such as `README.md` can go to a small system of their own (say "Repo plumbing"), without much ceremony.

### 4. Ask what each one is

For each system, ask with `AskUserQuestion`:

> Is `<system>` made of parts, does it have a shape, or do you not know?

| Answer | Do |
|---|---|
| **Parts** | `"state": "parts"`. Run the loop on it, when they're ready |
| **Shape** | Ask which style, then go to step 6. The recursion stops here |
| **Don't know** | Ask if it's unclear (`dragons`) or a mess (`spaghetti`). Record who and today's date. Stop |

"It's just a box to me" means the same as don't know, or as `shape` with no detail if they do
understand it. Ask which.

**"I don't know" ends that branch at once.** It's a complete, valid answer, and the larger the codebase
the more of them there'll be. Don't guess inside it, press them, or come back to it. Offer a `label` if
they want their own word for it ("thar be dragons").

### 5. Ask what they expect between systems

With two or more siblings:

> Which of these should talk to each other, and which should never?

Record each as an entry in `expects`, with their reason. Then answer from the code: read imports (see
**Reading imports**) and report what agrees and what doesn't, citing `file:line`. A surprise here is the
best moment in the interview. Don't soften it, and don't explain it away.

### 6. Examine a shape claim

Naming and grouping have no wrong answers. **Shapes do**: architecture has rules, and the code can
disagree. After the person names a style:

1. Read `<catalog>/styles/<style>.md`, and `frameworks.md` for a hint.
2. Check the **Forbidden** and **Contradicts** lists against the imports.
3. Report what holds and what doesn't, with `file:line`.

If the claim doesn't hold, there are three valid outcomes. The person picks:

- **The code drifted:** note it for them to fix. Nothing changes in the map.
- **The label is wrong:** change the `style`, or describe the hybrid in `note`.
- **It's a deliberate exception:** add it to `exceptions` with their reason.

Zones and roles are optional. Offer them once: "Do you want to say what's in each zone?" Here you may
suggest from the style's vocabulary and `roles/`, because these have right answers. Mark what you
suggested `"by": "llm"`, and what they said `"by": "user"`.

Traits (`traits/`) are detected from recordings. Don't ask about them.

### 7. Patterns, only if they want

Once a level is done, ask once:

> Is there anything here someone would need explained, such as an algorithm or a pattern? Give it a name
> if so.

Most code doesn't need this, so a "no" is fine. For each one:

1. They give the name, freeform: "Foo Sliding Window".
2. Search `patterns/` and suggest an entry, if one fits. Suggesting is fine here, because recognizing a
   pattern has right answers. `"catalog": null` is always allowed.
3. Propose which code plays which part, using the entry's **Parts**, and let them correct it.
4. For a line range, take the commit from `git rev-parse HEAD`, and first check the file is unchanged
   with `git diff --quiet HEAD -- <file>`. If it has changed, ask them to commit first, or tag the
   `symbol` with no lines.

Read the entry's **Invariants** against the code. If one looks broken, say so. A tag is a claim.

## Going deeper

After a level, ask which system to go into next, or whether to stop. They decide the depth and order.
Don't push on, and don't treat stopping as unfinished: a shallow map is still a map, and it can grow.

## Saving

Write to `runshape.json`'s `map` section after each step that changes it, so nothing is lost. Before the
first write in a session, show what will be added and get a yes. Then:

- Create the file as `{"version": 2, "zones": []}` plus `map`, if there isn't one. Leave out `style`:
  nobody has claimed one.
- Leave `state` out until step 4 has asked. `check-map` lists those systems as `undecided`.
- Change only `map`. Leave every other section as it is.
- Run `check-map` after every write, and fix any `problems` before going on.
- Don't commit. The person reviews and commits the map like code, which is how `"by": "llm"` paths
  get approved.

## Reading imports

```sh
python3 <catalog>/../.claude/skills/architecture-shape/scripts/import_matrix.py <package> --depth 2
```

That script handles Python. For other languages, search for import statements. If imports can't settle
something, say so, rather than guessing. Never run the project's own code to find out.

## Standards

Only if asked. Read `standards/` and assess the ones the person picks, as the entry's **Check** says.
`judgement` checks are your reading, so cite what you saw and don't call it a failure. Report the results
and don't write them to the map.

## Teaching mode

For someone learning the codebase, or architecture.

- Same interview, and they still answer first.
- Don't write to `runshape.json`. Save their map to `.runshape/map-practice.json` instead, and don't
  commit it. `check-map` doesn't read that file.
- After a shape claim, ask rather than tell: "What would the port be here? This import points the wrong
  way. What's your read?" Then explain with the style's **Forbidden** list.
- When they're done, compare their answers with the committed map, if there is one. Differences are the
  lesson, not a score.
- Use catalog entries' titles as words to look up.

## Finishing

Say what was mapped: the counts from `check-map`, what's still unclaimed or `undecided`, the dragons and spaghetti, and
every surprise from steps 5 and 6. Note that Runshape's viewer doesn't draw the map yet.
