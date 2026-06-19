# Fast, Reliable Workspace Indexing Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Workspace Index complete a real multi-root full embedding run quickly and reliably by using available background CPU, IO, DB, and accelerator capacity without silent degradation, forgotten work, DB-host timeouts, or unbounded memory growth.

**Architecture:** Keep and harden the existing durable chunking path first: background import calls the file-import chunking pipeline, chunking persists chunks and enqueues `embed_chunk` jobs through the atomic `insertChunksAndEnqueueEmbeddingJobs` DB path, and the embedding worker consumes those jobs. The main fixes are proof and enforcement of this path, lease-guarded atomic embedding completion, bounded overlap between accelerator inference and DB completion, adaptive capacity based on measured pressure, and a full-run verifier that fails unless the real app reaches terminal completion in reasonable time.

**Tech Stack:** TypeScript, React, Electron hidden renderer hosts, Chrome DevTools Protocol/MCP, PGlite/Postgres SQL, existing `job_queue`, existing `file_records`/`file_chunks`, `@brainstrike/embedding-worker`, Transformers.js, ONNX Runtime Web WebGPU.

---

## The Actual Acceptance Criterion

This work is only successful when the app completes a real full-root Workspace Index run in a reasonable amount of time. Reliability and speed are one product requirement:

- If the run crashes, it failed.
- If work is forgotten after chunking or embedding is interrupted, it failed.
- If the DB host times out and the worker stalls permanently, it failed.
- If it runs so slowly that a normal large workspace effectively takes all night without a measured resource reason, it failed.
- If the proof run used WASM while the acceptance target is WebGPU, the performance proof is invalid.

Unit tests and green CI are necessary but not sufficient. The final PR is not ready until the verifier completes the real multi-root run and records evidence.

## Current Evidence From Code Inspection

Three read-only subagents inspected the current branch and found:

1. **The existing chunking path already supports durable overlap.**
   - `packages/file-import/src/chunking.ts` uses bounded parallel chunking.
   - Per file, chunking waits for durable chunk insert plus embedding-job enqueue before marking the file chunked.
   - `packages/db/src/chunk-embedding-job-batch.ts` provides `insertChunksAndEnqueueEmbeddingJobs`, which inserts chunks and enqueues `embed_chunk` jobs in one DB transaction.
   - This means the first implementation should not invent a separate `chunk_file` queue/table. First harden, measure, and prove the existing atomic path.

2. **There is still meaningful serialization.**
   - `WorkspaceCollectionSyncService.runSyncPass()` scans all prepared changes before import.
   - `runRootFolderCacheImport()` processes import batches serially.
   - `runEnhancedImport()` awaits base import before chunking for that batch.
   - Desktop backfill drains existing scoped jobs before candidate scan and waits for queue capacity between enqueue windows.
   - Those may be acceptable only if evidence shows chunking and embedding are already overlapping sufficiently. They must be measured, not assumed.

3. **The highest-impact accelerator idle bug is embedding-side DB ACK serialization.**
   - `packages/embedding-worker/src/embedding.worker.ts` posts a stream batch, then waits for `stream-ack` before generating the next batch.
   - `packages/embedding-worker/src/streaming-worker-client.ts` sends ACK only after `onBatch` resolves.
   - `packages/embeddings/src/worker/embedding-worker.ts` makes `onBatch` await vector DB update, job completion, and stats bookkeeping.
   - Therefore DB completion latency directly idles inference.

4. **Small batches compound the idle problem.**
   - `TransformersBackend.createWorkerRequest()` sets `maxBatchSize` to `texts.length`.
   - If QoS returns `workerClaimBatchSize: 1`, each job becomes one inference followed by DB completion idle.
   - Raising concurrency blindly is not the fix because local streaming is serialized and extra loops can mostly increase leased jobs and memory.

5. **Current completion is not lease-atomic.**
   - `updateChunkEmbeddingBatch()` writes vectors.
   - `JobQueue.completeBatch()` completes jobs afterwards.
   - If a lease is lost between those two operations, a stale worker can write an embedding before job completion rejects or skips it.
   - The fix is a single lease-guarded DB completion statement.

6. **The setting contract was violated.**
   - Electron storage showed `devicePrefConfigured:false` and `devicePref:"wasm"`.
   - `EmbeddingHostRuntime.resolveHydratedVectorDevicePreference()` calls capability detection and persists `recommendedDevice` for unconfigured preferences.
   - Detection can recommend WASM. That silently downgraded the run and invalidated throughput observations.
   - This is a guardrail issue, not the whole project.

7. **The full-run verifier must count expected files through app code, not shell `find`.**
   - Full-root mode still uses shared ignore rules and `createBackgroundIndexingEntryPolicy`.
   - It skips `.git`, `node_modules`, `.pnpm-store`, `.next`, `dist`, `build`, `.DS_Store`, and applies file-size/binary rules.
   - Expected file counts must use `readFullTreeWithOptions` and the same policy path as the app.

## Non-Negotiable Final Gate

For one stable HEAD:

- real desktop app completes the target three-root full Workspace Index run,
- selected backend and actual worker metadata match the required backend,
- all expected app-counted files have `file_records`,
- all expected records are chunked,
- all chunks are embedded,
- `job_queue` has no active or failed `embed_chunk` work for the active set,
- Workspace Index status is not `blocked`, `error`, or silently paused,
- no DB host timeouts, uncaught exceptions, backend mismatch, retry storm, or repeated warnings occur during the run,
- memory reaches a plateau,
- integrated throughput is within 70% of the measured bottleneck stage after excluding warmup and explicit foreground-pressure windows.

## Throughput Contract

Do not use a guessed absolute chunks/sec threshold. Measure the machine:

```text
bottleneck_chunks_per_sec =
  min(
    embedding_ceiling_chunks_per_sec,
    db_completion_ceiling_chunks_per_sec,
    chunking_ceiling_chunks_per_sec,
    import_ceiling_equivalent_chunks_per_sec
  )
```

The integrated full-root run must satisfy:

```text
steady_state_integrated_chunks_per_sec >= 0.70 * bottleneck_chunks_per_sec
```

If it misses that threshold, the PR is not ready. The engineer must identify the queue, DB permit, write path, batch size, sleep, live query, foreground gate, or memory control causing the gap.

## Resource-Use Contract

When there is no foreground assistant query, no foreground DB pressure, AC/normal power state, and acceptable thermals:

- content read concurrency should not collapse to 1,
- chunking should keep bounded parallel work active,
- embedding claim size should stay high enough to feed the accelerator,
- active queue depth should stay within high/low watermarks while work remains,
- the accelerator should not be idle only because a prior vector write is pending,
- DB write latency should be measured and should govern backpressure,
- fixed sleeps must be reduced or justified by measured foreground/memory impact.

When foreground pressure appears:

- new background embedding claims pause at the permit boundary,
- active inference batch drains,
- DB writes respect scheduler pressure,
- indexing ramps back up after pressure clears.

Slow behavior without a visible QoS reason is a bug.

---

## Implementation Stack

Use one focused PR stack if review size gets too large. Preferred stack order:

1. **Instrumentation and full-run verifier.**
2. **Strict backend setting and actual-device evidence.**
3. **Durability hardening of existing chunk+enqueue path.**
4. **Lease-guarded atomic embedding completion.**
5. **Bounded inference/DB completion overlap and adaptive throughput.**
6. **Final full-root acceptance run and PR evidence.**

If the first four layers are small enough, they can share one PR. Do not merge any layer until its own tests and proof are clean.

---

## Task 1: Build the Full-Run Debug Harness First

**Purpose:** Make it impossible to claim completion, speed, or backend correctness without live evidence.

**Files:**
- Create: `packages/app-shell/src/background-indexing/workspace-index-debug-harness.ts`
- Modify: `packages/app-shell/src/background-indexing/workspace-collection-sync-provider.tsx`
- Modify: `apps/desktop/src/ipc-domains/file-system-ipc.ts`
- Modify: `apps/desktop/src/__tests__/ipc-domains/file-system-ipc.test.ts`
- Create: `apps/desktop/e2e/full-workspace-index.desktop.test.ts`
- Create: `docs/workspace-indexing-full-run-verification.md`

- [ ] **Step 1: Write failing expected-count tests**

Add tests proving expected counts use app rules, not `find`.

Test shape:

```ts
expect(result.policyPreset).toBe('full-root');
expect(result.includedFiles).toContain('src/index.ts');
expect(result.includedFiles).not.toContain('node_modules/pkg/index.js');
expect(result.includedFiles).not.toContain('.git/config');
expect(result.skippedByReason.generatedOrIgnored).toBeGreaterThan(0);
```

Run:

```bash
pnpm --filter @brainstrike/app-shell exec vitest run src/background-indexing/__tests__/workspace-index-debug-harness.test.ts
```

Expected: fail because helper does not exist.

- [ ] **Step 2: Implement `countExpectedWorkspaceIndexFiles`**

Use:

- `createBackgroundIndexingEntryPolicy`,
- `readFullTreeWithOptions`,
- existing file-system adapter,
- exported `flattenFileNodes`.

Return:

```ts
{
  policyPreset,
  rootPath,
  expectedFileCount,
  includedFiles,
  skippedByReason
}
```

No shell `find`. No separate ignore implementation.

- [ ] **Step 3: Add gated app-shell debug API**

Expose from `WorkspaceCollectionSyncProvider`, only under automated/debug gating:

```ts
window.__BRAINSTRIKE_WORKSPACE_INDEX_DEBUG__ = {
  countExpected,
  snapshot,
  triggerFullSync,
  configure,
};
```

Snapshot must include:

- roots and root ids,
- expected counts,
- `file_records` by root,
- chunked records by root,
- chunks/embedded/pending by root and set,
- `job_queue` by type/state,
- sync status,
- chunking/embedding host status,
- selected device preference,
- actual worker metadata from recent completions,
- DB scheduler pressure snapshot,
- memory samples when available.

- [ ] **Step 4: Add real-root E2E injection**

Current desktop E2E root selection returns mock paths. Add an opt-in debug/env path such as:

```bash
BRAINSTRIKE_E2E_REAL_ROOT_PATH=/absolute/path
```

Validate through existing path resolution and persist through `rootsList`.

- [ ] **Step 5: Write the full-run E2E harness**

`apps/desktop/e2e/full-workspace-index.desktop.test.ts` must:

1. launch isolated profile,
2. inject one or more real roots,
3. set policy preset,
4. call exact expected-count helper,
5. trigger full sync,
6. poll snapshot every 5s,
7. fail immediately on blocked/error/backend mismatch/DB timeout/uncaught exception/no progress,
8. require terminal success stable for two polls,
9. emit a local JSON evidence artifact.

- [ ] **Step 6: Verification commands**

```bash
pnpm --filter @brainstrike/app-shell run type-check
pnpm --filter @brainstrike/desktop exec vitest run src/__tests__/ipc-domains/file-system-ipc.test.ts
pnpm --filter @brainstrike/desktop exec playwright test e2e/full-workspace-index.desktop.test.ts --workers=1 --reporter=line
```

Commit:

```bash
git add packages/app-shell apps/desktop docs/workspace-indexing-full-run-verification.md
git commit -m "test(indexing): add full-run workspace index verifier"
```

---

## Task 2: Enforce Strict Backend Setting and Runtime Evidence

**Purpose:** Prevent false performance proof. If the setting is WebGPU, run WebGPU or fail loudly. Do not auto-persist WASM from detection.

**Files:**
- Modify: `apps/desktop/src/renderer/components/embedding-host-runtime.tsx`
- Modify: `apps/desktop/src/__tests__/renderer/components/embedding-host-runtime.test.tsx`
- Modify: `packages/preferences/src/stores/vector-preferences-store.ts`
- Modify: `packages/preferences/src/__tests__/vector-preferences-store.test.ts`
- Modify: `packages/vector-management/src/vector-status.tsx`

- [ ] **Step 1: Red test for auto-WASM rejection**

Set `devicePrefConfigured:false`, detection result `recommendedDevice:'wasm'`, and assert:

- `startEmbeddingWorker` is not called with WASM,
- `setDetectedDevicePref('wasm')` is not called,
- host status reports error with WebGPU reason.

- [ ] **Step 2: Red test for stale auto-WASM migration**

Version 3 persisted state:

```ts
{ devicePrefConfigured: false, devicePref: 'wasm' }
```

must migrate to:

```ts
{ devicePrefConfigured: false, devicePref: 'webgpu' }
```

Explicit configured WASM may remain only if product policy still allows explicit slow/debug WASM.

- [ ] **Step 3: Implement strict resolver**

Rules:

- explicit user setting is honored,
- unconfigured automatic mode may validate WebGPU availability,
- unconfigured automatic mode may not persist or use WASM,
- detected WASM is a clear error, not fallback,
- stale unconfigured WASM is repaired.

- [ ] **Step 4: Show preference vs actual backend**

Vector status UI/debug snapshot must show both:

- selected preference,
- actual worker metadata (`device`, `dtype`, `fallbackApplied`).

If they differ, status is error.

- [ ] **Step 5: Verification commands**

```bash
pnpm --filter @brainstrike/desktop exec vitest run src/__tests__/renderer/components/embedding-host-runtime.test.tsx
pnpm --filter @brainstrike/preferences exec vitest run src/__tests__/vector-preferences-store.test.ts
pnpm --filter @brainstrike/vector-management run type-check
```

Commit:

```bash
git add apps/desktop/src/renderer/components/embedding-host-runtime.tsx apps/desktop/src/__tests__/renderer/components/embedding-host-runtime.test.tsx packages/preferences packages/vector-management
git commit -m "fix(indexing): prevent automatic local embedding backend downgrade"
```

---

## Task 3: Harden the Existing Durable Chunk+Embed Enqueue Path

**Purpose:** Use the durable path that already exists, prove it overlaps, and fail loudly if the atomic path is unavailable.

**Files:**
- Modify: `packages/app-shell/src/background-indexing/workspace-collection-sync-import.ts`
- Modify: `packages/app-shell/src/background-indexing/__tests__/workspace-collection-sync-import.test.ts`
- Modify: `packages/file-import/src/chunking.ts`
- Modify: `packages/file-import/src/__tests__/chunking.test.ts`
- Modify: `packages/app-shell/src/background-indexing/__tests__/workspace-collection-sync-service.test.ts`

- [ ] **Step 1: Red test that Workspace Index requires atomic chunk+enqueue support**

In app-shell import tests, pass a DB handle without `insertChunksAndEnqueueEmbeddingJobs` and without `transaction`.

Expected error:

```text
Workspace Index background import requires transactional chunk/job enqueue support.
```

This replaces the current warning-only behavior.

- [ ] **Step 2: Red test that chunking enqueues embed jobs before all chunking is complete**

In file-import chunking tests:

- create two files,
- make file A chunk quickly,
- block file B chunking,
- assert `insertChunksAndEnqueueEmbeddingJobs` is called for file A before file B resolves.

This proves current batch-level chunking can feed embedding before all chunking completes.

- [ ] **Step 3: Red service-order test**

Assert:

- `ensureEmbeddingRuntimeStarted()` is called before import/chunking starts,
- final reconciliation `enqueueBackfill()` only runs after import completes,
- `enqueueBackfill()` is reconciliation, not the primary producer for chunks generated during import.

- [ ] **Step 4: Implement hard failure**

Change the warning in `runRootFolderCacheImport()` into an error for Workspace Index if neither transaction path is present.

- [ ] **Step 5: Implement/log durable overlap telemetry**

Log when each import batch:

- starts content read,
- applies managed-cache records,
- starts chunking,
- first `embed_chunk` job is enqueued,
- batch chunking completes,
- reconciliation backfill is requested.

This should make overlap visible in logs and debug snapshot.

- [ ] **Step 6: Verification commands**

```bash
pnpm --filter @brainstrike/file-import exec vitest run src/__tests__/chunking.test.ts
pnpm --filter @brainstrike/app-shell exec vitest run src/background-indexing/__tests__/workspace-collection-sync-import.test.ts src/background-indexing/__tests__/workspace-collection-sync-service.test.ts
pnpm --filter @brainstrike/file-import run type-check
pnpm --filter @brainstrike/app-shell run type-check
```

Commit:

```bash
git add packages/file-import packages/app-shell
git commit -m "fix(indexing): require and prove durable chunk enqueue overlap"
```

---

## Task 4: Make Embedding Completion Lease-Guarded and Atomic

**Purpose:** Prevent stale workers from writing vectors outside their lease and reduce DB round trips.

**Files:**
- Modify: `packages/embeddings/src/worker/embedding-worker-db-io.ts`
- Modify: `packages/embeddings/src/worker/embedding-worker.ts`
- Create or modify: `packages/embeddings/src/__tests__/embedding-worker-db-completion.test.ts`

- [ ] **Step 1: Red test for stale lease**

Claim a job, then steal/expire the lease before completion.

Assert:

- no vector is written,
- job is not marked succeeded,
- completion result excludes the stale job.

Expected: fail today because vector write can happen before `completeBatch()` rejects/skips the job.

- [ ] **Step 2: Add `completeEmbeddingChunkJobsBatch`**

Create one DB function that:

- takes `{ jobId, leaseToken, chunkId, embeddingSetId, embeddingHash, embedding }[]`,
- joins `job_queue` on `job_id + lease_token + state='running'`,
- updates only owned chunks,
- marks jobs succeeded,
- marks stats dirty or records completions,
- returns completed job ids.

Use one SQL CTE. Do not write chunk embeddings outside the lease guard.

- [ ] **Step 3: Replace update+complete sequence**

In `completeBatch()`, replace:

```ts
updateChunkEmbeddingBatch(...)
jq.completeBatch(...)
```

with the new lease-guarded completion helper.

- [ ] **Step 4: Verification commands**

```bash
pnpm --filter @brainstrike/embeddings exec vitest run src/__tests__/embedding-worker-db-completion.test.ts src/__tests__/embedding-worker-batch.test.ts
pnpm --filter @brainstrike/embeddings run type-check
```

Commit:

```bash
git add packages/embeddings/src/worker packages/embeddings/src/__tests__
git commit -m "fix(indexing): complete embedding batches under job lease"
```

---

## Task 5: Overlap Inference With Bounded DB Completion

**Purpose:** Stop idling the accelerator on every DB vector write while preserving durability and bounded memory.

**Files:**
- Modify: `packages/embeddings/src/worker/embedding-worker.ts`
- Modify: `packages/embeddings/src/types.ts`
- Modify: `packages/embeddings/src/bge-m3-service.ts`
- Modify: `packages/embeddings/src/transformers-backend.ts`
- Modify: `apps/desktop/src/renderer/components/embedding-worker-config.ts`
- Modify: `apps/desktop/src/__tests__/renderer/components/embedding-worker-config.test.ts`
- Create or modify: `packages/embeddings/src/__tests__/embedding-worker-throughput-overlap.test.ts`
- Create or modify: `packages/embeddings/src/__tests__/embedding-worker-activity.test.ts`

- [ ] **Step 1: Red test: next stream batch starts before prior DB completion resolves**

Use:

- `claimBatchSize: 2`,
- fake streaming batch size `1`,
- block first DB completion,
- assert second stream batch starts before first completion resolves.

Expected: fail today.

- [ ] **Step 2: Red test: overlap is bounded**

Use:

- 3 jobs,
- stream batch size `1`,
- `maxPendingCompletionBatches: 1`,
- block first completion,
- assert batch 1 can start, batch 2 cannot start until capacity frees.

- [ ] **Step 3: Red test: deferred completion failure does not lose jobs**

Fail first deferred completion after later inference has started.

Assert:

- no claimed job remains stuck running,
- succeeded jobs are exactly completed lease-guarded writes,
- remaining jobs requeue or fail through existing retry policy.

- [ ] **Step 4: Red test: foreground drain watches inference, not DB completion**

Block DB completion after fake inference returns.

Assert foreground query drain sees inference inactive while DB completion is still pending. If the UI needs a broader busy flag, add a separate one.

- [ ] **Step 5: Implement bounded completion pipeline**

Add a local-streaming completion writer:

- completion concurrency `1` by default,
- bounded by pending batches, chunks, and estimated vector bytes,
- holds minimal payloads only,
- ACKs worker batch after completion payload is accepted into the bounded writer,
- flushes before group completion and worker shutdown,
- propagates first failure into uncompleted jobs.

- [ ] **Step 6: Add stream batch control**

Extend local stream generation options so worker stream batch size is not always `texts.length`.

Pass through:

- `EmbeddingService.generateEmbeddingsStream(texts, onBatch, options)`,
- `SimpleEmbeddingService`,
- `TransformersBackend`,
- `EmbedWorkerRequest.maxBatchSize`.

- [ ] **Step 7: Add strict config knobs**

In desktop config:

- `VITE_EMBED_COMPLETION_OVERLAP_BATCHES`,
- `VITE_EMBED_MAX_PENDING_COMPLETION_CHUNKS`,
- `VITE_EMBED_MAX_PENDING_COMPLETION_BYTES`,
- `VITE_EMBED_STREAM_BATCH_SIZE`.

All parsing is strict. Malformed values throw.

- [ ] **Step 8: Add telemetry**

Log per completion/inference window:

```ts
{
  event: 'embedding_pipeline_timing',
  streamBatchSize,
  pendingCompletionBatches,
  pendingCompletionChunks,
  inferenceMs,
  completionWaitMs,
  dbWriteMs,
  completeJobsMs,
  schedulerWaitMs,
  device,
  dtype
}
```

No content is logged.

- [ ] **Step 9: Verification commands**

```bash
pnpm --filter @brainstrike/embeddings exec vitest run src/__tests__/embedding-worker-throughput-overlap.test.ts src/__tests__/embedding-worker-activity.test.ts src/__tests__/embedding-worker-batch.test.ts
pnpm --filter @brainstrike/desktop exec vitest run src/__tests__/renderer/components/embedding-worker-config.test.ts
pnpm --filter @brainstrike/embeddings run type-check
pnpm --filter @brainstrike/desktop run type-check
```

Commit:

```bash
git add packages/embeddings apps/desktop/src/renderer/components/embedding-worker-config.ts apps/desktop/src/__tests__/renderer/components/embedding-worker-config.test.ts
git commit -m "perf(indexing): overlap embedding inference with bounded DB completion"
```

---

## Task 6: Adaptive Pipeline Capacity

**Purpose:** Use available background resources instead of fixed slow constants.

**Files:**
- Modify: `packages/utils/src/workspace-indexing-qos.ts`
- Modify: `packages/utils/src/__tests__/workspace-indexing-qos.test.ts`
- Modify: `apps/desktop/src/renderer/components/embedding-worker-config.ts`
- Modify: `packages/app-shell/src/background-indexing/workspace-collection-sync-provider.tsx`
- Modify: `packages/app-shell/src/background-indexing/workspace-collection-sync-service.ts`

- [ ] **Step 1: Red tests for idle/unpressured capacity**

Assert balanced/idle-ac policies keep:

- content read concurrency high enough,
- import batch size high enough,
- worker claim size high enough,
- backfill queue depth high enough.

- [ ] **Step 2: Red tests for pressure recovery**

Simulate:

- foreground query active,
- foreground DB pressure,
- pressure clears.

Assert capacity drops for pressure and ramps back up after pressure clears.

- [ ] **Step 3: Implement adaptive capacity controller**

Inputs:

- DB scheduler p95/p99 wait/service times,
- foreground query gate,
- power/thermal,
- memory,
- queue depth,
- accelerator idle ratio,
- stalled-progress window.

Outputs:

- claim batch size,
- stream batch size,
- completion overlap window,
- import batch size,
- content read concurrency,
- backfill queue depth,
- inter-batch delay.

Rules:

- ramp up only when DB/memory/foreground pressure is clear,
- ramp down immediately on pressure,
- never hide the reason,
- no permanent slow mode after pressure clears.

- [ ] **Step 4: Verification commands**

```bash
pnpm --filter @brainstrike/utils exec vitest run src/__tests__/workspace-indexing-qos.test.ts
pnpm --filter @brainstrike/desktop exec vitest run src/__tests__/renderer/components/embedding-worker-config.test.ts
pnpm --filter @brainstrike/app-shell exec vitest run src/background-indexing/__tests__/workspace-collection-sync-provider.test.tsx src/background-indexing/__tests__/workspace-collection-sync-service.test.ts
```

Commit:

```bash
git add packages/utils apps/desktop/src/renderer/components/embedding-worker-config.ts packages/app-shell
git commit -m "perf(indexing): adapt background indexing capacity to measured pressure"
```

---

## Task 7: Benchmark Stage Ceilings and Integrated Throughput

**Purpose:** Prove the final pipeline is near the actual bottleneck, not just faster than before.

**Files:**
- Create: `apps/desktop/scripts/benchmark-workspace-index-pipeline.mjs`
- Create: `docs/workspace-indexing-performance-methodology.md`

- [ ] **Step 1: Implement benchmark modes**

Modes:

- `embedding-ceiling`: WebGPU inference over representative chunk texts, no DB writes.
- `db-completion-ceiling`: synthetic vector writes/job completions at active dimension, no inference.
- `chunking-ceiling`: chunk representative files and write chunks, no embedding drain wait.
- `import-ceiling`: scan/content-read/managed-cache apply.
- `integrated`: full pipeline on a representative subset.

- [ ] **Step 2: Fail on invalid evidence**

Benchmark must fail if:

- actual backend is wrong,
- `fallbackApplied` is true,
- DB timeouts occur,
- memory threshold is exceeded,
- no-progress window is exceeded.

- [ ] **Step 3: Compute and report ratio**

Report:

```json
{
  "embeddingCeilingChunksPerSecond": 0,
  "dbCompletionCeilingChunksPerSecond": 0,
  "chunkingCeilingChunksPerSecond": 0,
  "importCeilingEquivalentChunksPerSecond": 0,
  "bottleneckChunksPerSecond": 0,
  "integratedChunksPerSecond": 0,
  "integratedToBottleneckRatio": 0
}
```

- [ ] **Step 4: Verification command**

```bash
node apps/desktop/scripts/benchmark-workspace-index-pipeline.mjs --profile isolated --require-device webgpu
```

Commit:

```bash
git add apps/desktop/scripts/benchmark-workspace-index-pipeline.mjs docs/workspace-indexing-performance-methodology.md
git commit -m "test(indexing): benchmark workspace indexing pipeline ceilings"
```

---

## Task 8: Full Multi-Root Acceptance Run

**Purpose:** Prove the actual app completes the real job.

- [ ] **Step 1: Focused verification**

```bash
pnpm --filter @brainstrike/preferences run type-check
pnpm --filter @brainstrike/desktop run type-check
pnpm --filter @brainstrike/db run type-check
pnpm --filter @brainstrike/file-import run type-check
pnpm --filter @brainstrike/app-shell run type-check
pnpm --filter @brainstrike/embeddings run type-check
```

- [ ] **Step 2: Run benchmark**

```bash
node apps/desktop/scripts/benchmark-workspace-index-pipeline.mjs --profile isolated --require-device webgpu
```

- [ ] **Step 3: Run full-root verifier**

Use the real target roots:

```bash
PROFILE="$(mktemp -d /tmp/brainstrike-full-index.XXXXXX)"
BRAINSTRIKE_E2E_ALLOW_GPU=1 \
BRAINSTRIKE_E2E_USER_DATA_DIR="$PROFILE" \
BRAINSTRIKE_DB_ROOT_PATH="$PROFILE" \
BRAINSTRIKE_FULL_INDEX_POLICY=full-root \
BRAINSTRIKE_FULL_INDEX_TIMEOUT_MS=21600000 \
BRAINSTRIKE_FULL_INDEX_MAX_IDLE_MS=600000 \
BRAINSTRIKE_FULL_INDEX_MAX_RETAINED_HEAP_MB=512 \
BRAINSTRIKE_FULL_INDEX_ROOTS="/Users/seandearnaley/Documents/GitHub/3dmol-react:/Users/seandearnaley/Documents/GitHub/brainstrike:/Users/seandearnaley/Documents/health-wiki" \
pnpm --filter @brainstrike/desktop exec playwright test e2e/full-workspace-index.desktop.test.ts --workers=1 --reporter=line
```

- [ ] **Step 4: Analyze logs**

Run warning/error pass from the verifier artifact time window.

Fail on:

- DB host timeout,
- uncaught exception,
- backend mismatch,
- repeated warnings,
- retry storm,
- memory threshold breach,
- progress stall.

- [ ] **Step 5: Full repo gate**

```bash
pnpm lint:ci
pnpm type-check
pnpm build
pnpm test
```

- [ ] **Step 6: PR evidence**

PR body must include:

- commit SHA tested,
- roots and expected counts,
- final file/chunk/embedding counts,
- actual backend metadata,
- benchmark ceiling table,
- integrated throughput ratio,
- memory table,
- queue terminal state,
- warning/error pass result,
- remaining risks.

Commit any docs/test updates only:

```bash
git add docs/workspace-indexing-full-run-verification.md docs/workspace-indexing-performance-methodology.md
git commit -m "docs(indexing): record full-run verification evidence"
```

---

## Subagent Execution Split

Use `superpowers:subagent-driven-development`.

1. **Verifier harness agent**
   - Owns app-shell debug harness, real-root E2E injection, full-run Playwright test, docs.
   - Must not edit embedding worker internals.

2. **Device contract agent**
   - Owns vector preference migration, embedding-host device resolver, vector status evidence.
   - Must not edit throughput or DB completion.

3. **Durable chunk enqueue agent**
   - Owns app-shell import tests, file-import chunking overlap tests, hard transaction support check.
   - Must not create a new chunk-file queue unless the controller approves after evidence.

4. **Embedding completion agent**
   - Owns lease-guarded atomic completion and bounded completion overlap.
   - Must not change device fallback semantics.

5. **Adaptive throughput agent**
   - Owns QoS/capacity policy and benchmark script.
   - Must not weaken foreground pressure behavior.

6. **Final verifier/reviewer**
   - Runs benchmark, full-root verifier, warning pass, and final full repo gate.
   - Reviews all diffs for hidden fallback, unbounded buffers, broad live queries, and root/path ambiguity.

## Review Checklist

Before PR is called ready:

- [ ] No automatic backend downgrade.
- [ ] Existing atomic chunk+enqueue path is required and tested.
- [ ] Embedding completion is lease-guarded in one DB operation.
- [ ] Stream ACK no longer waits for every DB completion when bounded capacity exists.
- [ ] Completion overlap is bounded by batches, chunks, and bytes.
- [ ] Foreground query drain tracks inference, not arbitrary DB writes.
- [ ] QoS backs off with explicit reason and ramps up after pressure clears.
- [ ] Expected counts use the app walker/policy.
- [ ] Full-root verifier completed the real roots.
- [ ] Logs contain no fatal errors, DB timeouts, backend mismatches, or repeated warnings.
- [ ] Memory plateau is documented.
- [ ] Integrated throughput meets the 70% bottleneck-ratio target or the PR documents a measured, reviewed exception.

## Explicit Non-Goals For The First Implementation

- Do not create a new `chunk_file` queue/table unless hardening the existing atomic path plus bounded embedding completion still cannot meet the full-run target.
- Do not treat WASM performance as acceptance evidence.
- Do not fix this by just increasing concurrency.
- Do not remove foreground backpressure.
- Do not use shell `find` for expected file counts.
- Do not call a run complete from unit tests alone.

