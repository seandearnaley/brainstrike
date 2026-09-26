# Job queue and embedding input-hash identity — evidence

Supports `docs/agents/local-inference.md` § "Job queue and embedding input
hash". Read before changing `embed_chunk` payload identity, the in-flight
budget, or the desktop backfill admission bound. Migration 105 is
`packages/db/src/migrations/105-embedding-job-input-hash.ts`.

## Already embedded completion ownership (2026-09-26)

The worker's already embedded path called `completeBatch` under lease tokens but
counted every input as processed, even when ownership had changed and the queue
returned no updated row. Its completion callback also released in-flight slots
for those stale inputs. A real PGlite test replaces one of two lease tokens at
the completion statement; only the valid row may enter processed counts and
the completed-ID callback. The queue remains the authority for settlement.

## Original text

4. Job Queue
   - File: packages/db/src/queue/job-queue.ts
   - Backed by job_queue table.
   - Lease-based locking, retries, dedupe, failure tracking.
   - `startEmbeddingWorker` applies one runtime-wide in-flight budget across all
     polling loops before `claimMany`. The default ceiling is `claimBatchSize`;
     `maxInFlightJobs` may override it with another positive value. Slots are
     released only after the corresponding completion/failure write, or during
     explicit cleanup after a lost lease or interrupted batch.
   - Every durable `embed_chunk` payload carries `sourceContentHash` plus
     `embeddingInputHash`, the lowercase SHA-256 of
     `${contentHash}:${resolvedModelKey}`. Every producer
     (pipeline, transactional chunk insert, desktop backfill, and vector queue
     backfill) computes batches through `buildEmbeddingJobInputHashes` before
     enqueue. That helper mirrors the worker's hosted-provider model resolution
     and hashes independent chunks concurrently. Before embedding, the worker
     requires the persisted source hash to match the loaded chunk; changed
     chunks are failed terminally so an old input hash can never label a new
     vector. The worker reuses the input hash for stale checks and completion
     writes, and the claim path must never recompute it. Migration 105 backfills
     provable queued/running jobs plus retryable failed jobs and visibly
     cancels/counts active jobs whose chunk/model identity cannot be proven; do
     not add a legacy hashing fallback to the worker.
   - Desktop backfill admission bounds queued/running jobs for the target
     `embedding_set_id`, not the entire embeddings queue. Workspace Index may
     legitimately fill its separate QoS depth with other embedding sets; those
     jobs must not starve a manual backfill. Same-set desktop backfills remain
     single-flight at the IPC boundary, while the worker's runtime-wide
     in-flight budget remains the global inference ceiling.
   - Admitted manual backfill jobs use the queue's earliest runnable ordering,
     so an older unrelated embedding-set backlog cannot strand them behind the
     backfill drain timeout.
   - A `source: 'background-indexing'` backfill is owned by the host runtime,
