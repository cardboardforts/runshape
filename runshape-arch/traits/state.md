# State traits

Not in `taxonomy.ts` yet. Each axis is independent.

## Mutability

### `immutable`
Never changes after construction.

### `mutable`
Can change after construction.

## Scope

### `instance-state`
Belongs to one object.

### `static-state`
Shared by every instance of a type.

### `global-state`
Reachable from anywhere in the process.

### `constant`
A fixed, named value.

## Role

### `identity`
Identifies the object it's on.

### `association`
A reference to another aggregate.

### `cache`
A copy kept for speed. Losing it must lose nothing.

### `configuration-value`
Set at startup and read afterwards.
