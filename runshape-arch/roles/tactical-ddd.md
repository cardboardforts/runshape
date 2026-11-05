# Tactical domain-driven design

Roles marked core are expected in `core`, `business` or `model`.

### `aggregate-root`
The one entity outsiders may hold a reference to. Guards the invariants of everything inside it. Core.

### `entity`
Has an identity that outlives its attribute values. Core.
Look-alike: `dto`: a persistence or wire shape with an id field is not an entity.

### `value-object`
Defined only by its values. Immutable, replaceable. Core.

### `domain-service`
A domain operation that belongs to no single entity or value object. Core.
Look-alikes: `use-case` sequences a request end to end, and a domain service decides one domain rule.
`policy` is a swappable rule object.

### `factory`
Builds complex objects, aggregates especially, and hands back valid ones. Core. Names: `*Factory`.

### `repository`
Collection-like access to aggregates. The interface is core; an implementation is an adapter.
Signals: name ends in Repository; reads and writes one kind of record. Names: `*Repository`, `*Repo`.
Look-alike: `secondary-adapter`: an implementation against a real database is both.

### `domain-event`
Something that happened, named in the past tense. Core. Names: `*Event`.

### `policy`
A swappable rule object. Core. Names: `*Policy`.
