# Standards

What must be true, as opposed to what code is. A seed list to prove the format.

**Severity** is the default a project can change: `error` should stop a merge, `warn` is worth a look,
`info` is a note. **Check** says how a skill assesses it today:

- `imports`: read import statements
- `search`: search the code for a named construct
- `trace`: needs a Runshape recording
- `judgement`: a model reads the code and cites what it found. Never a hard failure on its own

A standard is checked only where someone chose it. Nothing here applies itself to a project.

| File | Covers |
|---|---|
| [architecture.md](architecture.md) | Layering and dependencies |
| [errors.md](errors.md) | Failure handling |
| [observability.md](observability.md) | Logs, health, correlation |
| [security.md](security.md) | Recurring security controls |
| [frontend.md](frontend.md) | UI correctness |
