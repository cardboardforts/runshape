# Container roles

Roles for folders and packages rather than types. Only `composition-root` is in `taxonomy.ts`, as a
zone rule's `"role"`. The others are from [docs/taxonomy.md](../../docs/taxonomy.md).

### `bounded-context`
A part of the system where the domain's words have one meaning.

### `ddd-module`
A cohesive group of domain concepts inside a context.

### `feature`
Code grouped by what the user can do with it.

### `layer`
Code grouped by its technical level.

### `adapter-group`
Several adapters kept together.

### `shared-kernel`
Code shared by systems that have agreed to change it together.

### `composition-root`
Builds the adapters and hands them in. Its calls wire, so they don't break the style.

### `test`
Tests, fixtures and test harnesses.

### `generated`
Produced by a tool. Not reviewed by hand.
