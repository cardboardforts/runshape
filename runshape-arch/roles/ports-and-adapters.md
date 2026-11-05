# Ports and adapters

### `primary-port`
What the outside may ask of the core: a use-case interface.
Expected in: `core`. Signals: an interface the inbound adapters call, implemented by a use case in
the core. Look-alike: `use-case` is the implementation; the port is the interface it implements.

### `secondary-port`
What the core needs from the outside: a store, a clock, a model.
Expected in: `core`. Signals: an interface the core calls and an outbound adapter implements.
Look-alike: `repository`: the core's collection-like port is both.

### `primary-adapter`
Turns an external request into a call on the core.
Expected in: `inbound-adapter`. Signals: the framework routes requests to it.
Look-alike: `secondary-adapter` is called by the core; this one calls the core.

### `secondary-adapter`
Implements a secondary port against a real system (database, HTTP API, filesystem, queue, model
provider). It knows the vendor's types and hides them from the core.
Expected in: `outbound-adapter`. Signals: calls a database, HTTP or filesystem client itself; handed
to another component at construction.
Look-alikes: `repository`: the interface is core, only the implementation is this. `primary-adapter`
calls the core; this one is called by it.
