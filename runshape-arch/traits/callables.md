# Callable traits

## Effect

### `pure`
No recorded effect: no boundary call, no write to a field, itself or through anything it calls.
In-memory reads aren't recorded, so this is never proof.

### `reads-state`
Reads stored state: a database query, itself or through a callee.

### `writes-state`
Changes stored or in-memory state.

### `external-io`
Talks to an external system other than a database: HTTP, files, a queue.

## I/O

### `direct-io`
Makes a boundary call itself, not through a callee.

## CQS

### `query`
Returns a value and changes no state.

### `command`
Changes state and returns nothing. Not the same as the [CQRS role](../roles/cqrs.md) of that name.

### `both`
Changes state and returns a value: what CQS forbids, and what a command handler returning the new id
is allowed.

## Failure

### `can-fail`
Raises, throws, panics or makes an error.

## Intent

Only this axis needs a model.

### `decision`
Branches on domain facts.
Look-alike: `orchestration` branches only on whether a call worked.

### `orchestration`
Sequences other callables without deciding anything itself.

### `mixed`
Decides and orchestrates at once: mixed levels of abstraction.
