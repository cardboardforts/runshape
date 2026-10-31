# The categorizer

What each piece of recorded code is, what job it does in its region's style, and what it does
when it runs. It implements the vocabulary in docs/taxonomy.md, as far as recordings support it.
Code: `packages/architecture/src/` (`taxonomy.ts`, `categorizer.ts`, `tag-rules.ts`,
`role-advice.ts`). The tests in `packages/architecture/test/categorizer.test.ts` print every
claim for go-shop, the FastAPI slug refactor and Django.

## Kinds come from the trace

| Kind | Where it comes from | Subkinds |
|---|---|---|
| Container | a module the recorded code ran in (a placement) | `module`, `package` (Go) |
| Type | a class whose methods ran, or an object of it the recorder saw | `class`, or `type` for Go (the trace doesn't say struct or interface) |
| Callable | a function that ran as project code (`CodeSymbol.kind`) | `function`, `method`, `constructor`, `initializer`, `closure` |
| State | an object reference set while constructing (a wire) | `field` |
| Metadata | nothing: decorators and annotations aren't recorded | — |

Each categorization lists what the trace can't support in `missing`, so a missing tag isn't read
as "no":

- Interfaces never run, so `primary-port` and `secondary-port` are only judged or declared.
- Plain fields, constants and globals aren't recorded, so State carries no traits.
- Metadata isn't recorded, so it's neither categorized nor used as evidence.
- Exceptions aren't recorded per call. `can-fail` comes from source lines, and `total` is never
  claimed.
- Clocks, randomness and in-memory reads aren't recorded, so `pure` means "no recorded effect".
- Intent (decision, orchestration) needs a model.
- If a recording keeps no source, CQS, field writes and `can-fail` aren't detected either.

## Every tag is a claim

```
{ id: "secondary-adapter", lens: "ports-and-adapters", by: "detected", confidence: 0.95,
  evidence: ["calls postgres: SELECT itself", "inferred outbound-adapter: calls postgres directly",
             "handed to ArticlesRepository as _profiles_repo"] }
```

`by` takes one of four values:

- `confirmed`: a person, through a runshape.json role or rule with `"by": "user"`.
- `judged`: a model, or a model's proposal committed to runshape.json with `"by": "llm"`.
- `detected`: this categorizer.
- `declared`: the code says it itself, through annotations. Nothing records those yet.

Evidence holds names, zones, route patterns, line numbers and counts. It never holds source text
or query text, because a review bundle may be stored centrally. Every confidence is a named
constant in `categorizer.ts`.

**Roles** come from the lenses of the item's innermost region's style (`STYLE_LENSES`):

| Style | Lenses |
|---|---|
| hexagonal | ports-and-adapters, tactical-ddd, cqrs, application, boundary |
| layered | tactical-ddd, cqrs, application, boundary. Its layers are zones, not roles. |
| mvc, mvvm, mvp | mvc-family, boundary |

A type gets roles from these signals:

- Its zone. Inbound-adapter gives primary-adapter; controller gives controller; and so on.
- Routes the framework registered to it or to its methods.
- Boundary calls its own code made. Those make it a secondary-adapter.
- Being handed to another object at construction. This only supports a role it already has.
- A definition's `names` globs, such as `*Repository`.
- Roles declared in runshape.json.

Each lens keeps one role. Declared and confirmed claims beat detected ones. When several signals
point to the same role they merge, and each extra signal adds 0.1, up to 0.95. A role that lost
is named in the winner's evidence ("also looked like …").

**Callable traits** come from the call tree:

| Lens | How it's found |
|---|---|
| `effect` | `reads-state` (SELECT), `writes-state` (INSERT, UPDATE, DELETE, …, or an executed line assigning `self.x`, `this.x` or a Go receiver's field outside a constructor), `external-io` (a boundary call with no statement). Its own calls and everything under it. A callable can hold several of these, or `pure` if nothing was recorded. |
| `io` | `direct-io`: a boundary call on its own span |
| `cqs` | `query`, `command` or `both`, from an executed `return` with a value plus `writes-state`. Needs source. |
| `failure` | `can-fail`: `raise`, `throw`, `panic(`, `errors.New`, `fmt.Errorf` in its own lines, ran or not. Needs source. |

Transaction bookkeeping (SAVEPOINT, RELEASE, BEGIN, …) isn't an effect.

## Definitions and rules are data

`BUILT_IN_DEFINITIONS` holds every role and trait. Each entry has `definition`, `signals`,
`look_alikes`, `expected_in` and `names`. `BUILT_IN_RULES` holds three rules:

| Rule | Applies | Flags |
|---|---|---|
| `role-outside-expected-zone` | every style | a role whose `expected_in` names zones of this style, but not the zone the item is in |
| `io-outside-allowed-zones` | every style | a callable with `direct-io` in a zone the style's `externalAccess` excludes |
| `cqrs-no-mixed-callable` | where a project sets `match` | `cqs=both`, unless `role=command-handler` |

A condition is written `axis=a|b` or `axis!=a`. The axes are `kind`, `style`, `zone`, `role`
(any role lens), `zone-expected`, `zone-io`, and any lens name. An axis with no value for an item
satisfies neither `=` nor `!=`.

A project overrides any of this in runshape.json's top-level `taxonomy` section. It's validated
with the rest of the file, and every problem is reported at once. Saving zones keeps the section.

```json
"taxonomy": {
  "definitions": [{ "id": "dto", "expected_in": ["presentation"] }],
  "roles": [{ "match": "app.billing.Ledger", "role": "aggregate-root", "reason": "guards the balance", "by": "user" }],
  "rules": [
    { "id": "cqrs-no-mixed-callable", "match": "app.services.**", "severity": "error", "off_in": ["legacy"] },
    { "id": "services-compute-only", "message": "a service helper that queries", "match": "app.services.**",
      "when": ["kind=callable"], "flag": ["effect=reads-state"], "severity": "info" }
  ]
}
```

Definitions and rules are overridden by id. When two lenses share an id, as `command` does in
`cqrs` and `cqs`, the override also needs `lens`. A new definition needs `lens`, `definition` and
`on`. A new rule needs `flag` and `message`. Severities are `error`, `warn`, `info` and `off`.
`off_in` names regions.

## The model is optional

`leftovers(categorization)` returns the types that have no role in any lens their style uses.
`roleAdvicePrompt` gives a model the project's definitions (`Taxonomy.blurb`), along with what
the detector found and the source. `parseRoleAdvice` validates the answer against those
definitions, allowing one role per lens and reporting every problem. It returns `judged` claims
and `taxonomy.roles` entries with `"by": "llm"`. A host writes those with `ZoneRules.withRoles`,
and a person approves them in the diff. Nothing calls a model unless a host asks, and no host
asks yet.

## In review

`buildReviewBundle` adds `categories` to review.json:

- `items`: head's changed callables, the types holding them, and new unplaced code.
- `newFindings`: findings head has that the base didn't. Renames are recognised through `moves`.
- `proposals`: a zone for each new class or module no rule places. It's the zone its strongest
  role expects, or else where its behaviour put it, marked `"by": "detected"`.
- `missing`: what the trace can't support (see above).

review.md shows all of this under "What the changed code is", with the proposals as JSON to
paste into runshape.json. They're never applied. page.json gets `categories` and a "new
architecture findings" callout, which turns red when any of them is an error.

## Not yet

- Ports, entities and value objects aren't detected. They need interface declarations or
  field data from the parsers.
- State traits and metadata aren't recorded by any recorder.
- `can-fail` doesn't follow callees, because try/except isn't visible.
- The Wirfs-Brock fallback lens and the frontend lens aren't built.
- No host asks the model yet.
- The viewer doesn't draw tags yet. page.json carries them.
