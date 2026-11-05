# Modern patterns

Patterns that became everyday after the Gang of Four book.

### `modern-dependency-injection`: Dependency Injection
**What:** A component receives what it needs rather than finding or building it.  
**Parts:** `composition-root`, `dependency`, `consumer`  
**Invariants:** Consumers depend on interfaces. One place wires everything.  
**Bugs:** Wiring scattered through the code; a service locator passed around.  
**See it:** The composition root with arrows into each consumer.  
**With:** `std-constructor-injection`, `composition-root`  

### `modern-repository`: Repository
**What:** Collection-like access to stored objects, hiding the query language.  
**Parts:** `repository-port`, `repository-adapter`, `aggregate`  
**Invariants:** Callers see domain objects, never rows or query builders.  
**Bugs:** Queries in a loop (N+1); a repository method per screen.  
**See it:** The core calling the port, and the adapter reaching the database.  
**With:** `repository`, `secondary-port`, `secondary-adapter`  

### `modern-unit-of-work`: Unit of Work
**What:** Tracks changes in one business operation and commits them together.  
**Parts:** `unit-of-work`, `transaction`, `change-set`  
**Invariants:** All of it commits or none of it does.  
**Bugs:** External calls inside a transaction; nested units that commit early.  
**See it:** The changes collected, then the single commit.  

### `modern-pipeline`: Pipeline
**What:** Data flows through a series of steps, each taking the last one's output.  
**Parts:** `source`, `stage`, `sink`  
**Invariants:** Stages don't share hidden state. Each one's output fits the next one's input.  
**Bugs:** Failures in the middle leaving half the work done; order dependence.  
**See it:** The stages left to right, with counts at each.  

### `modern-middleware`: Middleware
**What:** Wrappers around a request, each doing something before and after the next.  
**Parts:** `middleware`, `next`, `handler`  
**Invariants:** Every path through calls next or answers. The order is deliberate.  
**Bugs:** Security middleware ordered after what it protects.  
**See it:** Nested layers around the handler.  
**With:** `gof-chain-of-responsibility`, `gof-decorator`  

### `modern-functional-core`: Functional Core, Imperative Shell
**What:** Decisions live in pure functions, and effects sit in a thin outer shell.  
**Parts:** `core`, `shell`  
**Invariants:** The core performs no I/O.  
**Bugs:** An I/O call slipping into the core; the shell growing decisions.  
**See it:** The inner functions colored pure, and effects only on the rim.  

### `modern-event-loop`: Event Loop
**What:** One thread takes turns on many tasks by never blocking.  
**Parts:** `loop`, `task`, `await-point`  
**Invariants:** Nothing blocks the loop.  
**Bugs:** A blocking call stalling every task; shared state changing across an `await`.  
**See it:** Tasks on a timeline with their await points.  

### `modern-optimistic-ui`: Optimistic UI
**What:** The UI shows the expected result first and reconciles when the server answers.  
**Parts:** `optimistic-update`, `request`, `rollback`  
**Invariants:** Every failure rolls back. The server's answer wins.  
**Bugs:** Responses arriving out of order; a rollback that loses later edits.  
**See it:** The UI state and the server state on two timelines.  
