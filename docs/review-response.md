# Review Response — Phase 3 Queue Hardening (2025)

This document summarizes the review feedback addressed prior to Phase 4 and the concrete changes applied across the codebase.

## What changed

- Claiming semantics
  - `claim()` now considers expired `running` jobs in addition to `queued` jobs.
  - Attempts are incremented on claim (single source of truth) and jobs with `attempts >= max_attempts` are excluded from selection.

- Idempotent enqueue
  - `enqueue()` uses `INSERT ... ON CONFLICT (dedupe_key) DO UPDATE`, preserving the earliest `run_at` and refreshing `updated_at`. This avoids re‑select races and ensures deterministic behavior under retries.

- Backoff discipline
  - `fail()` no longer increments attempts; it computes backoff based on the attempts value already incremented by `claim()`.

- Transactional producer
  - Chunk inserts and job enqueues can now be performed within a single DB transaction via injected `runInTransaction` and `enqueueJobsForChunksTx` hooks.
  - Both chunk repositories expose `insertManyWithTx(tx, chunks)` to prevent nested transactions in the transactional path.

- Admin & retention
  - Added `expireLeases()` and `prune(states, olderThan)` helpers.
  - CLI gained a `prune` command: `pnpm queue -- prune --olderThan <ISO> --states succeeded failed`.

- Indexing
  - New deterministic claim index: `idx_job_queue_claim(queue, state, run_at, id)`.

## Files touched

- `packages/db/src/queue/job-queue.ts` — claim, enqueue, fail, expireLeases, prune
- `packages/db/src/migrations/008-job-queue-claim-index.ts` — new migration
- `packages/db/src/repositories/file-chunk-repository.ts` — `insertManyWithTx`
- `packages/db/src/repositories/electron-file-chunk-repository.ts` — `insertManyWithTx`
- `packages/file-import/src/chunking.ts` — transactional insert+enqueue path
- `packages/app-shell/src/enhanced-file-import-service.ts` — wires transactional path
- CLI: `packages/db/src/cli/queue-cli.ts` — adds `prune`
- Tests:
  - `packages/db/__tests__/job-queue-expired-lease.test.ts`
  - `packages/db/__tests__/job-queue-dedup-upsert.test.ts`
  - `packages/db/__tests__/job-queue-transactional-enqueue.test.ts`

## Validation

- Unit tests extended for expired lease claim, dedupe upsert semantics, and transactional rollback behavior.
- Existing job queue tests remain green under the new attempt semantics (attempts increment happens at claim; fail requeues without double‑counting).

## Next steps (Phase 4)

- Implement the embedding worker using the updated `claim()`/`fail()` discipline and heartbeat model.
- Use the transactional enqueue path when chunking to ensure crash‑safe hand‑offs between chunk insert and job creation.

## Phase 6 — UI/API Integration (progress)

- Added Vector Status panel (App Shell) with:
  - pgvector/worker badges, device, active embedding set selector, coverage x/y, throughput (60s), and last error.
  - Safe fallback rendering without DbProvider for tests and shallow mounts.
- Active embedding set selection persists to localStorage and is used as the default `embeddingSetId` for search.
- Search hook now scopes queries by the selected set when available and surfaces a targeted error toast if a set is required.

Files:
- packages/app-shell/src/vector-status.tsx
- packages/app-shell/src/vector-preferences.ts
- packages/app-shell/src/database-demo/hooks/use-search-functionality.ts
- packages/db/src/repositories/file-chunk-repository.ts (coverage helper)
- packages/db/src/index.ts (DTO exports)

Validation:
- App Shell tests: 164/164 passing
- Web unit tests: passing; Vector Status uses safe fallback in settings

Next:
- Wire active set into all search entry points in the web/desktop UIs
- Optional: model selector + web worker bootstrap binding

## Phase 6 — API Contracts (completed)

- Added canonical contracts doc with stable DTO shapes and examples:
  - `docs/arch_logs/09-05-2025-db-embedding-modernization/api-contracts.md` (search options/results, `EmbeddingSet`, public `Job`)
- Verified `@brainstrike/db` exports for: `ChunkSearchOptions`, `ChunkSearchResult`, `FileChunk`, `EmbeddingSet`, `Job`.
- Vector Status enhancements:
  - Retry control: “Retry last 20 failed” button
  - Lightweight metrics: latency p50/p95 (60s window) alongside throughput

Files:
- docs/arch_logs/09-05-2025-db-embedding-modernization/api-contracts.md
- packages/app-shell/src/vector-status.tsx

Notes:
- SQL path still requires `embeddingSetId` when pgvector is enabled.
- Latency stats use recent succeeded jobs (60s) based on ISO timestamps; portable across PGlite.

## Phase 6 — Web UX consolidation (2025‑08‑31)
- Settings no longer contains separate worker controls on Web to avoid divergence from Desktop. Start/Stop Worker, Embedding Set selection, Backfill, coverage/throughput/latency are all consolidated in Right Panel → DB → Vector Status.
- On Web, worker badge shows `disabled` until explicitly started; transitions to `running` with active jobs.
