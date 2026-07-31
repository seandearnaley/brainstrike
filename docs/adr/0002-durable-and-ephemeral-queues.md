# ADR-0002: Two queues by design — durable SQL orchestration and ephemeral compute pooling

- **Status:** Accepted (retroactive — records decisions settled across BST-164/165/166 and
  re-affirmed with fresh evidence in BST-991, 2026-07-31)
- **Date:** 2026-07-31
- **Context source:** the BST-991 census and premise-check verdict (on the Linear ticket),
  which audited both packages file-by-file after an architecture-audit ticket proposed
  "reconciling" them into one abstraction.

## Context

Brainstrike has two things called "queue," and this ADR exists because that keeps
inviting consolidation proposals. `packages/queue/src/types.ts`, the worker-readiness
state machine, and `packages/queue/README.md` cite "ADR-0002" for their contracts;
this document makes those citations true and records why the split is deliberate.

- **`JobQueue`** (`packages/db/src/queue/job-queue.ts`) is the **durable** queue:
  PGlite-backed rows in `job_queue`, leases with heartbeats, retries with backoff,
  active-dedupe uniqueness (`idx_job_queue_dedupe_active`, migrations 007/078),
  monotonic lifetime outcome counters (`job_queue_metrics`, migrations 049/064), and a
  fused complete-plus-vector-write so a stale worker cannot persist an embedding after
  losing its lease.
- **`@brainstrike/queue`** is the **ephemeral** compute pool: a `workerpool` adapter for
  in-process embedding computation (`QueueAdapter` — add/pause/resume/cancel/drain),
  plus the shared telemetry and health **contracts** both sides emit into. It has no
  persistence, no job states, no SQL, no retries, no leases.

They are two stages of one pipeline: durable rows are claimed from `job_queue`, and the
actual embedding computation is dispatched to the ephemeral pool. The dependency edge
is one-directional — `packages/db` imports queue's telemetry
(`emitQueueTelemetry`, adapter tag `'job-queue'`); `packages/queue` never imports db.

## Decisions

1. **The split stays. "One queue abstraction" is a won't-do.** (BST-991.) Merging would
   invert a working dependency edge to unify two things with disjoint responsibilities.
   The unification that mattered shipped long ago as shared *contracts*, not shared
   *implementation*: the `QueueTelemetryAdapter` union `'job-queue' | 'workerpool'`
   (BST-165) and the composed `QueueHealthMetrics` diagnostics shape joining
   `DurableQueueStats` with `EphemeralQueueMetrics` (BST-164/166, consumed by
   `use-queue-health-metrics`).
2. **Standardized control semantics** for ephemeral adapters: pause/resume/cancel/drain
   with the worker-readiness state machine in `packages/queue/src/types.ts`. New
   adapters implement `QueueAdapter`; they do not grow bespoke lifecycles.
3. **The durable claim path keeps production's index set.** Migration 008's composite
   `idx_job_queue_claim (queue, state, run_at, id)` exists only on the numbered
   (test) migration path, and measurement says leave it there: an `EXPLAIN` probe on a
   Drizzle-migrated PGlite at 20k rows (95% terminal / 4% queued / 1% running) produced
   the **identical plan and cost with and without it** — the planner prefers the
   BitmapOr over `idx_job_queue_state_run_at` either way. Adding it to production would
   be write amplification with no read benefit. Do not add it without new EXPLAIN
   evidence at a real workload (the migration-063 discipline).
4. **`'expired'` is not a job state.** It sat in the `JobState` union, the Drizzle
   `$type`, and the CLI allow-list from birth, but nothing ever wrote it —
   lease expiry re-queues (`state = 'queued'`), and `claimMany` steals expired leases
   inline. The TS-level state is retired; migration 007's CHECK constraint still
   permits the value because numbered migrations are append-only history, and a value
   nothing writes is harmless there.

## Non-existence note

Historical documents reference a `@brainstrike/queue-telemetry-collector` package. It
was never created; the telemetry aggregation lives in `packages/queue/src/telemetry.ts`
(`createQueueTelemetryAggregator`) and the remote sink in
`remote-telemetry-sink.ts`. Those documents are point-in-time artifacts and are left
unedited.
