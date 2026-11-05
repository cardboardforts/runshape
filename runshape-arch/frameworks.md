# Frameworks

What a framework usually implies. These are hints for asking better questions, never answers: a
Django repo can be hexagonal, and the person's own view wins.

| Framework | Language | Usual style | Where things usually are |
|---|---|---|---|
| Django | Python | [mvc](styles/mvc.md) (MVT) | `models.py` model, `views.py` controller, `templates/` and `serializers.py` view |
| Django REST Framework, Django Ninja | Python | [mvc](styles/mvc.md) or [layered](styles/layered.md) | Routers or viewsets as the controller; schemas are DTOs; a `services.py` suggests layered |
| FastAPI, Flask | Python | Whatever the authors built | `routers/` or `api/`, then look for `services/` and `db/` |
| Express, Fastify, NestJS | TypeScript | [layered](styles/layered.md) | `routes/` or `controllers/`, `services/`, `repositories/` |
| `net/http`, chi, gin | Go | [layered](styles/layered.md) or [hexagonal](styles/hexagonal.md) | `cmd/` composition, `internal/` packages by feature; interfaces defined by the consumer suggest hexagonal |
| ASP.NET Core | C# | [layered](styles/layered.md), [mvc](styles/mvc.md) or [hexagonal](styles/hexagonal.md) | `Controllers/`; projects named `Domain`, `Application` and `Infrastructure` suggest hexagonal |
| Rails | Ruby | [mvc](styles/mvc.md) | `app/models`, `app/controllers`, `app/views` |
| React | TypeScript | [container-presentational](styles/container-presentational.md), [feature-sliced](styles/feature-sliced.md) or [flux](styles/flux.md) | `pages/`, `components/`, `features/`, `store/`, `hooks/` |
| Vue, Angular | TypeScript | [mvvm](styles/mvvm.md) | `components/`, `stores/`, `composables/`, `services/` |

A monorepo folder that a package manager treats as a workspace (`pnpm-workspace.yaml`, `go.work`, a
`.sln`) is often a system boundary. It's still a question for the person.
