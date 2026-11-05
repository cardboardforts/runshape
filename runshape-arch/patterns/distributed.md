# Distributed systems and resilience

### `dist-retry-with-backoff`: Retry with Backoff
**What:** Retries a failed call, waiting longer each time, with jitter.  
**Parts:** `attempt`, `backoff`, `give-up`  
**Invariants:** The operation is safe to repeat. There's a limit. Only retryable failures retry.  
**Bugs:** Retrying non-idempotent writes; no jitter, so callers stampede; retries multiplying across layers.  
**See it:** Attempts on a timeline with growing gaps.  
**With:** `dist-idempotency-key`, `dist-circuit-breaker`  

### `dist-circuit-breaker`: Circuit Breaker
**What:** Stops calling something that keeps failing, and tries again later.  
**Parts:** `closed`, `open`, `half-open`, `threshold`  
**Invariants:** When open, calls fail fast. One probe decides whether it closes.  
**Bugs:** A threshold that never trips; half-open letting everything through.  
**See it:** The three states, with the failure count.  
**With:** `gof-state`  

### `dist-bulkhead`: Bulkhead
**What:** Separate resource pools, so one slow dependency can't take everything down.  
**Parts:** `pool`, `limit`  
**Invariants:** One pool's exhaustion doesn't touch the others.  
**Bugs:** A shared pool hiding behind the separate ones.  
**See it:** Pools with their usage.  

### `dist-rate-limiter`: Rate Limiter
**What:** Bounds how often something may happen, usually by token bucket or sliding window.  
**Parts:** `key`, `counter`, `limit`, `reject`  
**Invariants:** Counts are atomic. The key says who is limited.  
**Bugs:** A race on the counter; a key an attacker controls.  
**See it:** The bucket level over time.  
**With:** `dsa-sliding-window`  

### `dist-idempotency-key`: Idempotency Key
**What:** A client-chosen key makes repeating a request safe.  
**Parts:** `key`, `result-store`, `replay`  
**Invariants:** Same key, same effect, once. Storing the key and doing the work are atomic.  
**Bugs:** A gap between the check and the write; the same key reused with a different body.  
**See it:** Two requests, with the second answered from the store.  

### `dist-outbox`: Transactional Outbox
**What:** Writes an event in the same transaction as the data, and a relay publishes it.  
**Parts:** `outbox-table`, `relay`, `publish`  
**Invariants:** No event is lost, and consumers tolerate duplicates.  
**Bugs:** Publishing outside the transaction; a relay that reorders.  
**See it:** The transaction, then the relay, then the consumer.  
**With:** `dist-idempotency-key`  

### `dist-saga`: Saga
**What:** A multi-step operation across services, each step with a compensating action.  
**Parts:** `step`, `compensation`, `coordinator`  
**Invariants:** Every step that can fail after another has a compensation.  
**Bugs:** A compensation that can itself fail; readers seeing the half-done state.  
**See it:** The steps forward and the compensations back.  

### `dist-cache-aside`: Cache-Aside
**What:** The caller checks the cache, then the source, then fills the cache.  
**Parts:** `lookup`, `fill`, `invalidate`  
**Invariants:** A stale read is bounded. Losing the cache loses nothing.  
**Bugs:** Missing invalidation; a stampede when a hot key expires; caching one user's data for another.  
**See it:** Hits and misses over time.  

### `dist-event-sourcing`: Event Sourcing
**What:** State is derived by replaying an append-only log of events.  
**Parts:** `event-log`, `apply`, `projection`  
**Invariants:** Events are immutable. Replaying gives the same state.  
**Bugs:** Non-deterministic apply; changing an event's meaning.  
**See it:** The log, with state building up.  
**With:** `query-model`  

### `dist-leader-election`: Leader Election
**What:** Nodes agree that one of them does the work.  
**Parts:** `lease`, `leader`, `fencing-token`  
**Invariants:** Two leaders can't both act. A paused old leader is fenced off.  
**Bugs:** A lease with no fencing; clocks trusted across machines.  
**See it:** Leases on a timeline per node.  
