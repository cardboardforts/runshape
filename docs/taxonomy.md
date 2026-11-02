# Taxonomy: what Runshape tags code with

Draft, 2026-10-26. Answers the "Each item should be enhanced with metadata that determines its
exact type" section of GOALS.md. The role vocabulary is borrowed from
[jMolecules](https://github.com/xmolecules/jmolecules) (Apache-2.0), checked against its source,
and extended where it has nothing to say (callables, DTOs, MVC-family styles, frontends).

## Three layers, never mixed

| Layer | Question | Who decides | Example |
|---|---|---|---|
| **Kind** | What syntactic thing is this? | The parser. Never a model. | `class`, `method`, `field` |
| **Role** | What job does it do in the design? | Declared, detected, or judged. Needs a style. | `aggregate-root`, `secondary-adapter` |
| **Traits** | What does it do when it runs? | Mostly deterministic; a model for the leftovers. | `effectful`, `command`, `can-fail` |

Kind is a fact. Role and traits are claims, and every claim carries where it came from:

```
tag:        { id: "secondary-adapter", lens: "ports-and-adapters" }
by:         declared | detected | judged | confirmed     # same idea as the existing zones file's `by`
confidence: 0..1
evidence:   ["imports pg", "implements UserStore", "file under adapters/"]
```

`confirmed` means a person approved it in the diff, the same rule as zone placements.

## Kinds

Container, Type, Callable, State, Metadata, exactly as in GOALS.md. Subkinds are parser facts:

| Kind | Subkinds |
|---|---|
| Container | directory, file, package, module, namespace. They nest. |
| Type | class, struct, interface, trait, enum, type alias |
| Callable | function, method, constructor, closure |
| State | field, property, constant, global, static |
| Metadata | decorator, attribute, annotation |

A *meta-container* ("all the controllers") is a saved query over roles, not a new kind of container.

## Roles for Types, grouped by lens

jMolecules gets one thing right that GOALS.md cares about: its stereotypes come in separate
families, one family per style, and a type can hold one tag per family. It models this with
`@Stereotype(groups=…, priority=…)`. We copy that. A **lens** is a family. A region has one style,
so a role from a lens that style doesn't use is a smell ("crossing the streams"), not a second
valid answer.

### `tactical-ddd` (jMolecules `ddd`)

| Role | Meaning | jMolecules |
|---|---|---|
| `aggregate-root` | The one entity outsiders may hold a reference to. Guards the invariants of everything inside it. | `@AggregateRoot` |
| `entity` | Has an identity that outlives its attribute values. | `@Entity` |
| `value-object` | Defined only by its values. Immutable, replaceable. | `@ValueObject` |
| `domain-service` | A domain operation that belongs to no single entity or value object. | `@Service` |
| `factory` | Builds complex objects, aggregates especially, and hands back valid ones. | `@Factory` |
| `repository` | Collection-like access to aggregates. The *interface* is core; an implementation is an adapter. | `@Repository` |
| `domain-event` | Something that happened, named in the past tense. | `@DomainEvent` |
| `domain-event-handler` | Reacts to a domain event. | `@DomainEventHandler` |
| `domain-event-publisher` | Emits domain events. | `@DomainEventPublisher` |
| `bounded-context`, `ddd-module` | These are containers, not types. See "Container roles". | `@BoundedContext`, `@Module` |

### `ports-and-adapters` (jMolecules `hexagonal`)

| Role | Meaning | Zone (hexagonal) |
|---|---|---|
| `primary-port` | What the outside may ask of the core: a use-case interface. | `core` |
| `secondary-port` | What the core needs from the outside: a store, a clock, a model. | `core` |
| `primary-adapter` | Turns an external request into a call on a primary port. | `inbound-adapter` |
| `secondary-adapter` | Implements a secondary port against a real system. | `outbound-adapter` |

### `cqrs` (jMolecules `cqrs`)

| Role | Meaning |
|---|---|
| `command` | A request to change state. A value, not a behaviour. |
| `command-handler` | Executes one command. |
| `command-dispatcher` | Routes a command to its handler. |
| `query-model` | A read-optimised projection that never takes writes. |

### `layered` and `onion`

jMolecules reduces these to a placement label (`@DomainLayer`, `@ApplicationLayer`,
`@InfrastructureLayer`, `@InterfaceLayer`, plus onion rings). Runshape already models that as a
**zone** (`presentation / business / data`, `inbound-adapter / core / outbound-adapter`), so
these are not roles. Roles say what a type is. Zones say where it sits. A role is *expected* in
some zones for a given style; that expectation is what the rules check.

### Not in jMolecules: add these

| Role | Lens | Why it's missing from jMolecules |
|---|---|---|
| `use-case` (application service) | `application` | jMolecules marks the *region* (`@Application`), not the class. You asked for it by name. |
| `dto` | `boundary` | jMolecules ignores wire formats. Maps to your "bend the wire format, not the domain" rule. |
| `mapper` | `boundary` | The thing that converts between a DTO and a domain type. |
| `config` | `boundary` | Typed settings read once at startup. |
| `policy` | `tactical-ddd` | A swappable rule object. `domain-service` covers it until you need to tell them apart. |
| `orchestrator` | `application` | Sequences calls across services and ports without deciding anything. |
| `controller`, `view`, `view-model`, `presenter` | `mvc-family` | The shapes `profiles.ts` already draws for MVC, MVVM, MVP. |
| `component`, `store`, `hook` | `frontend` | Placeholder lens. Revisit when frontend styles land. |

### Fallback lens: Wirfs-Brock

When no style has been chosen for a region, tag with the older stereotypes so the code still gets a
role: `information-holder`, `structurer`, `service-provider`, `coordinator`, `controller`,
`interfacer`. Everything above is a refinement of one of these, so a rule can say "any
`coordinator` holding state is suspect" without knowing the style.

## Container roles

Containers take a role from a small set, set per project: `bounded-context`, `ddd-module`,
`feature`, `layer`, `adapter-group`, `shared-kernel`, `composition-root`, `test`, `generated`.
This is where `runshape.json`'s nested regions already live. A region carries one style, which picks
the lens its contents are tagged with.

## Traits for Callables

jMolecules has nothing here beyond `command-handler` and `factory`. These come from your Functional
Core / Imperative Shell and CQS notes. Each is an independent axis.

| Axis | Values | How to find it |
|---|---|---|
| **Effect** | `pure`, `reads-state`, `writes-state`, `external-io` | Deterministic first: imports and calls into known IO, DB, HTTP, filesystem, clock and random libraries; writes to a field or global. Transitive through the call graph. |
| **CQS** | `query`, `command`, `both` | A return value plus a state write is `both`. The one-line check behind the CQRS example in GOALS.md. |
| **Failure** | `total`, `can-fail` | `throw`, `raise`, `panic`, unchecked errors, or a callee that can fail. |
| **Intent** | `decision`, `orchestration`, `mixed` | Model-judged. A decision branches on domain facts. Orchestration sequences other callables. Mixed is the smell TrueCourse's `mixed-abstraction-levels` rule looks for. |

Effect, CQS and Failure should be computable without a model. Only Intent really needs one.

## Traits for State

| Axis | Values |
|---|---|
| **Mutability** | `immutable`, `mutable` |
| **Scope** | `instance`, `static`, `global`, `constant` |
| **Role** | `identity` (jMolecules `@Identity`), `association` (reference to another aggregate, `@Association`), `cache`, `config` |

## Metadata (decorators, attributes, annotations)

You asked for ideas. A decorator is **evidence**, not a thing to display. Classify each by what it
tells you about the thing it sits on, then feed that into the role and trait detection above:

| Metadata class | Examples | Feeds |
|---|---|---|
| `routing` | `@app.get`, `[HttpGet]`, `@Controller` | role `primary-adapter` / `controller` |
| `persistence-mapping` | `@Entity`, `@Table`, Django `models.Model` | role `entity` or `dto`, depending on style |
| `transaction-boundary` | `@Transactional`, `atomic()` | callable trait `writes-state`, and marks a use-case edge |
| `authorization` | `@PreAuthorize`, `[Authorize]`, `@login_required` | a rule: every `primary-adapter` needs one |
| `wiring` | `@Injectable`, `@Autowired`, `@Bean` | marks a `composition-root` |
| `serialization` | `@JsonProperty`, pydantic `Field` | role `dto` |
| `validation` | `@Valid`, `@NotNull` | callable trait `total` at the boundary |
| `observability` | `@Timed`, log decorators | nothing; filter them out of the view |
| `lifecycle` | `@Deprecated`, `[Obsolete]` | a review callout when touched |
| `declares-role` | jMolecules, Spring stereotypes | a `declared` tag, the strongest evidence |

## A definition is a blurb a model can read

For the "load up the definitions and see a blurb a cheap model can use" goal, every role and trait
is one entry that carries both the machine part and the prose part:

```yaml
id: secondary-adapter
lens: ports-and-adapters
definition: >
  Implements a secondary port against a real external system (database, HTTP API, filesystem,
  queue, model provider). It knows the vendor's types and hides them from the core.
signals:                       # cheap, deterministic hints, feed `detected`
  - implements a type tagged secondary-port
  - imports a database, HTTP or filesystem client
look_alikes:                   # what a model confuses it with
  - repository: the interface is core, only the implementation is this
  - primary-adapter: this one is called by the core, it does not call the core
expected_in: [outbound-adapter]
```

A project overrides any entry by id. `definition` and `look_alikes` are what get pasted into the
model prompt. `expected_in` is what the rules read. Concatenating the entries for the active lenses
gives the single "blurb" per project.

## Rules read tags

```
rule:  cqrs-no-mixed-callable
when:  callable in region(style = cqrs)
flag:  cqs = both
unless: role = command-handler          # relaxation: a handler may return the new id
severity: warn
```

Every rule has a named severity, an `unless`, and a per-region off switch. That gives you the
"not dogmatic" requirement without a separate mechanism.

## Open questions

1. **How strict is "one tag per lens"?** jMolecules lets a type carry several. Stricter is easier to
   read; looser is closer to real code. I'd start strict and warn.
2. **Is `use-case` a role or a trait of a `primary-port` implementation?** Teams disagree. Keep both
   until your code shows which one reads better.
3. **Where does `policy` end and `domain-service` start?** Probably a project-level call.
4. **Callable `Effect` through the call graph** needs the symbol-identity work in the multi-language
   plan. Without it, effects only see direct calls.
5. **Frontend lens** is a placeholder. Container/presentational and feature-sliced need their own
   pass.
