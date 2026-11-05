# Application

### `use-case`
An application service: runs one request end to end through the domain and the ports. Core.
Names: `*UseCase`, `*Interactor`.
Look-alikes: `domain-service` decides, and a use case sequences. `orchestrator` sequences calls
without deciding anything.

### `orchestrator`
Sequences calls across services and ports without deciding anything. Core.
Names: `*Orchestrator`, `*Coordinator`.
