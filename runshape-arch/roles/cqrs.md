# CQRS

No style implies CQRS. A project turns it on for a container, and then the rule
`cqrs-no-mixed-callable` flags callables with the `both` trait.

### `command`
A request to change state. A value, not a behaviour. Core. Names: `*Command`.

### `command-handler`
Executes one command; may return the new id. Core. Names: `*CommandHandler`.

### `query-model`
A read-optimised projection that never takes writes. Names: `*ReadModel`, `*Projection`.
