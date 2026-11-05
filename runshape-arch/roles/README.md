# Roles

The job a type or module does in the design. Roles come in families called lenses, one family per
idea, and a piece of code holds at most one role per lens. Ids match
`packages/architecture/src/taxonomy.ts`; [docs/taxonomy.md](../../docs/taxonomy.md) has the
reasoning, and the vocabulary is borrowed from jMolecules (Apache-2.0).

A role says what a thing is. A zone says where it sits. A role is *expected* in some zones, and that
expectation is what a check reads.

| File | Lens |
|---|---|
| [ports-and-adapters.md](ports-and-adapters.md) | Hexagonal's ports and adapters |
| [tactical-ddd.md](tactical-ddd.md) | Domain-driven design's building blocks |
| [cqrs.md](cqrs.md) | Commands and queries |
| [application.md](application.md) | Use cases and sequencing |
| [boundary.md](boundary.md) | Things that cross a boundary |
| [mvc-family.md](mvc-family.md) | MVC, MVVM, MVP |
| [frontend.md](frontend.md) | Frontend pieces. Not in `taxonomy.ts` yet |
| [containers.md](containers.md) | Roles for folders and packages |
| [wirfs-brock.md](wirfs-brock.md) | The fallback when no style is chosen. Not in `taxonomy.ts` yet |
