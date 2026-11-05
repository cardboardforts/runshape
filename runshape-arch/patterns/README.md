# Patterns

A pattern is a named group of code that works together. Tag an instance in a map when naming it
would save a reader from working it out. Field meanings are in the
[catalog README](../README.md#entry-formats), and instances in
[map-format.md](../map-format.md#pattern-instances).

| File | Family | Holds |
|---|---|---|
| [gof.md](gof.md) | `gof-` | The 23 Gang of Four patterns |
| [modern.md](modern.md) | `modern-` | What the book doesn't cover: injection, pipelines, async |
| [distributed.md](distributed.md) | `dist-` | Resilience and data across services |
| [dsa.md](dsa.md) | `dsa-` | Algorithms and data structures |

Worth tagging: something a reviewer would otherwise have to reassemble. Not worth tagging: a single
class that happens to fit a definition, or anything the language already spells out, such as a `for`
loop being an iterator.

A pattern's parts don't have to be separate functions. A sliding window is often one function, and
each part can be a line range inside it.

If nothing here fits, use your own name with `"catalog": null`.
