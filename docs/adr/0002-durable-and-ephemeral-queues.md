# ADR-0002: Two queues by design — durable SQL orchestration and ephemeral compute pooling

- **Status:** Superseded. `packages/db` (with `JobQueue` and the PGlite `job_queue` table) and
  `packages/queue` no longer exist; desktop storage is SQLite
  ([ADR-0011](0011-run-log-and-state-store.md), [ADR-0018](0018-derived-sqlite-indexer.md)).
  Kept as history.
- **Date:** 2026-07-31 (retroactive; records BST-164/165/166, re-affirmed in BST-991)

## Context

Brainstrike had two things called "queue", which kept inviting proposals to merge them.

- **`JobQueue`** (`packages/db`): the durable queue.
  - PGlite rows in `job_queue`, leases with heartbeats, retries with backoff.
  - Active-dedupe uniqueness and monotonic outcome counters.
  - A fused complete-plus-vector-write so a stale worker could not persist an embedding after
    losing its lease.
- **`@brainstrike/queue`**: the ephemeral compute pool.
  - A `workerpool` adapter for in-process embedding (`QueueAdapter`: add, pause, resume, cancel,
    drain), plus shared telemetry and health contracts.
  - No persistence, states, SQL, retries or leases.
- They were two stages of one pipeline: durable rows were claimed, then computed in the pool.
  `packages/db` imported queue telemetry; never the reverse.

## Decisions

1. **The split stays; "one queue abstraction" is a won't-do** (BST-991). Unification happened
   through shared contracts (`QueueTelemetryAdapter`, `QueueHealthMetrics`), not shared code.
2. **Ephemeral adapters share control semantics:** pause/resume/cancel/drain and one
   worker-readiness state machine.
3. **No composite `idx_job_queue_claim` in production.** An `EXPLAIN` at 20k rows gave the same
   plan and cost with and without it. Add only with new evidence.
4. **`'expired'` is not a job state.** Nothing wrote it; lease expiry re-queues.

## Note

`@brainstrike/queue-telemetry-collector`, referenced by older documents, was never created.
