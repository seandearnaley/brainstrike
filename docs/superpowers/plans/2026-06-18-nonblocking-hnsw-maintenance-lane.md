# Nonblocking HNSW Maintenance Lane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a durable, observable, idle-only HNSW maintenance lane so workspace embedding completion is never blocked by vector index rebuild work, while suspended indexes are eventually rebuilt or loudly reported.

**Architecture:** Treat embeddings and HNSW index maintenance as separate phases. The embedding pipeline remains responsible for durable chunk/job completion; completed background backfills enqueue durable dimension-index maintenance records instead of rebuilding inline. A desktop idle scheduler claims one pending dimension at a time, gates it behind DB-idle/job-queue-idle/power-idle checks, runs `CREATE INDEX USING hnsw` only through the explicit `maintenance:exec` DB-host channel, and resumes the dimension suspension only after the index exists.

**Tech Stack:** Electron main process, PGlite 0.5.1, pgvector HNSW/halfvec indexes, Brainstrike DB work scheduler, `job_queue`, Vitest, desktop `dev:agent-debug` Chrome DevTools verification.

---

## Evidence And Risk Position

This plan is based on current repo inspection plus the full live verification from the preceding branch:

- Fresh `dev:agent-debug` run completed all three roots: `17,477 files`, `124,574 chunks`, `124,574/124,574 embedded`.
- Runtime stayed WebGPU `fp16`, `fallbackApplied:false`, `backendMismatch:false`.
- Queue ended as `succeeded:124574` with no queued/running/failed embedding jobs.
- The fix currently on the parent branch prevents background indexing from rebuilding HNSW inline, so the large embedding run can complete.
- That same fix intentionally leaves `embedding_dimension_index_suspensions` in place for background-indexing completion, which means search can stay on sequential scan until a later index build resumes the dimension.

Primary-source constraints:

- PGlite documents that it has a single exclusive database connection. Its worker mode shares that single connection rather than making long statements preemptible.
- PGlite Socket can multiplex multiple client connections, but official docs explicitly warn that this is different from normal Postgres and not all use cases are guaranteed to work. This is not a release-grade escape hatch until measured in our exact Electron/PGlite host.
- PGlite options include `initialMemory` and `startParams`, so memory growth and Postgres runtime parameters can be configured at construction time. The implementation must record the current values before tuning and must not silently change durability, memory, or planner settings.
- PGlite loads pgvector as an extension at construction time; every direct PGlite construction site must keep the existing extension invariant.
- pgvector documents that HNSW has slower build times and higher memory use than IVFFlat, and that build time depends heavily on graph size and memory.
- pgvector recommends adding indexes after bulk load for best performance and creating indexes concurrently in production to avoid blocking writes.
- PostgreSQL documents that `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block, can leave invalid indexes on failure, and only one concurrent index build can run on a table at a time.
- PostgreSQL exposes `pg_stat_progress_create_index`, but whether the PGlite/pgvector combination exposes useful progress rows must be probed in our runtime before the UI promises phase-level progress.
- PostgreSQL `VACUUM` can still block on indexes even with skip-lock options, and pgvector documents that vacuuming HNSW indexes can take a while; HNSW vacuum/reindex work must be treated as maintenance too, not hidden in the normal cleanup pass.

Direct consequence: an idle lane can decide when not to start a long HNSW build, can persist/retry/report the work, and can keep it out of the embedding drain. It cannot assume a started `CREATE INDEX USING hnsw` is preemptible on PGlite's single connection. The implementation must probe whether `CREATE INDEX CONCURRENTLY` syntax works in this runtime, must select `regular` until full-size responsiveness is measured, and may select `concurrent` only after the full verification proves foreground DB health remains within the release threshold. If measured full-root maintenance still stalls foreground DB work for an unacceptable duration, this lane is necessary but not sufficient for release; the escalation is to move ANN build/search out of PGlite into a separate persisted vector-index runtime that can build off the DB connection and atomically swap search indexes.

## Confidence Position

This plan is intentionally conservative. It does not assume that PGlite behaves like server Postgres, and it does not treat `CREATE INDEX CONCURRENTLY` as available until the app proves it in the exact Electron/PGlite runtime.

Confidence comes from five independent proofs:

1. **Durability proof:** after embedding completes, a durable maintenance row exists for every suspended dimension.
2. **Nonblocking proof:** embedding completion never runs HNSW DDL inline and never reports an optimized index while a suspension remains.
3. **Capability proof:** HNSW, concurrent-index syntax, progress reporting, runtime memory settings, and invalid-index detection are measured and recorded.
4. **Responsiveness proof:** foreground DB health is sampled during full-size maintenance, not inferred from unit tests.
5. **Throughput proof:** the full three-root run must complete with comparable integrated throughput to the parent implementation; a slow all-night pipeline is not acceptable even if it eventually finishes.

The plan has three possible outcomes:

- `release-sufficient`: the current PGlite/HNSW architecture meets durability, responsiveness, throughput, and memory gates on the full data set.
- `implementation-correct-but-release-blocked`: the maintenance lane is durable and observable, but full-size HNSW maintenance still blocks foreground DB work or grows memory unacceptably.
- `implementation-failed`: embedding, maintenance, suspension drain, invalid-index cleanup, or diagnostics do not complete correctly.

Only `release-sufficient` is an acceptable product release result. The second outcome is useful engineering evidence, but it immediately triggers the external ANN architecture escalation in this plan.

## Official Documentation Pass

Primary docs checked on 2026-06-18:

- PGlite API docs:
  - `PGlite.create()` waits for database readiness.
  - `initialMemory` can reduce pauses from WASM memory growth.
  - `startParams` can pass Postgres runtime parameters at startup.
  - pgvector is loaded as an extension through the PGlite extension mechanism.
- PGlite Multi-tab Worker docs:
  - Worker mode is for avoiding main-thread blocking and sharing one PGlite instance between tabs.
  - A leader worker owns the PGlite instance; this does not create independent DB execution capacity.
- PGlite Socket docs:
  - Socket server multiplexing exists, but the docs warn it is not equivalent to normal Postgres multi-connection behavior.
  - Do not introduce it as a hidden fallback. It belongs in an explicit future architecture spike if the idle HNSW lane fails release health checks.
- pgvector docs:
  - HNSW has better query performance than IVFFlat but slower build time and higher memory use.
  - `m` and `ef_construction` trade recall against build time/insert speed.
  - HNSW builds are much faster when the graph fits in `maintenance_work_mem`.
  - Indexes should be added after initial bulk load.
  - Production environments should use concurrent index creation to avoid blocking writes.
  - `halfvec` supports indexing up to 4,000 dimensions and half-precision indexing can reduce index size.
  - HNSW vacuum can take a while; pgvector suggests reindexing before vacuuming in server Postgres.
- PostgreSQL docs:
  - `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block.
  - Concurrent build failures can leave invalid indexes that are ignored for reads but still consume update overhead.
  - Only one concurrent index build can run on a table at a time.
  - Progress reporting for index builds is available through `pg_stat_progress_create_index` in server Postgres, but this must be verified against PGlite.
  - `VACUUM` may still block while opening indexes; skipping locks does not make index maintenance free.

## Current Code Map

- `apps/desktop/src/embedding-backfill.ts`
  - Owns dimension suspension, index drop, queue enqueue/drain, final vacuum, and current inline-or-skip rebuild behavior.
  - Current background path can pass `rebuildDimensionIndexOnCompletion:false`.
- `apps/desktop/src/ipc-embedding-backfill.ts`
  - Wires desktop backfill to the embedding host and uses DB scheduler priority `background`.
  - Background-indexing backfills currently set long drain/capacity timeouts and disable completion rebuild.
- `apps/desktop/src/database-maintenance-scheduler.ts`
  - Existing periodic idle DB-maintenance scheduler.
  - Skips if DB work scheduler has queued/running work.
  - Runs through `runDesktopScheduledDatabaseWork` with priority `background`.
- `packages/db/src/services/scheduled-database-maintenance.ts`
  - Prunes old terminal `job_queue` rows and vacuums configured tables.
  - Skips if `job_queue` has active `queued` or `running` work.
- `packages/db/src/migrations/044-dimension-index-suspensions.ts`
  - Current durable suspension table: `embedding_dimension_index_suspensions(dimension, reason, suspended_at)`.
- `packages/db/src/migrations/dimension-index-helpers.ts`
  - Provides `createDimensionIndex`, `dropDimensionIndex`, `suspendDimensionIndexBuilds`, `resumeDimensionIndexBuilds`, `dimensionIndexExists`.
  - Existing deferred builder is best-effort/session-only and not sufficient for post-backfill durability.
- `apps/desktop/src/db-host-manager.ts`
  - Exposes `database.maintenance.exec(...)`.
  - Sends DB-host request kind `maintenance:exec` with separate maintenance timeout semantics.
- `apps/desktop/src/platform/desktop-power-snapshot.ts`
  - Reads Electron `powerMonitor` into idle/power/thermal state.

## Release Bar

This work is successful only if all of these hold on a fresh full-root run:

1. Embedding completion still reaches `embedded_chunk_count === chunk_count` without DB host query timeouts.
2. Background indexing completion creates a durable pending dimension-maintenance record.
3. No HNSW rebuild starts while embedding jobs are queued/running, while DB scheduler has foreground/normal/background work, while the machine is on battery, or while thermal state is `serious`/`critical`.
4. Once the machine is idle on AC and the embedding queue is empty, exactly one dimension maintenance run starts.
5. The run uses the DB host `maintenance:exec` path, not `db:query`.
6. The implementation records whether it chose `regular` or `concurrent` index DDL, why that strategy was selected, and the result of the startup capability probe.
7. On success, the HNSW index exists and the matching `embedding_dimension_index_suspensions` row is removed.
8. On failure, the suspension remains, the maintenance row records a retryable failure with visible diagnostics, any invalid index left by a concurrent attempt is detected/recovered, and no code reports the workspace index as fully optimized.
9. If the measured `CREATE INDEX` phase stalls foreground DB work beyond the release threshold below, stop and escalate to the out-of-PGlite ANN architecture before release.

Proposed release thresholds for the first implementation:

- Full-root embedding must still complete the same verified data set: `17,477 files`, `124,574 chunks`.
- Full-root HNSW maintenance may not produce `DB host request timed out`.
- Foreground DB health checks during maintenance should not exceed `5s` p95 and must never hit the configured DB host timeout. If PGlite cannot satisfy this because the single connection is occupied by index DDL, classify the result as `implementation-correct-but-release-blocked`.
- HNSW maintenance memory growth must plateau. If Electron renderer/DB-host RSS grows monotonically after maintenance completes or exceeds machine-safe limits in repeated runs, treat it as release-blocking.
- The implementation must document current `maintenance_work_mem`, `max_parallel_maintenance_workers`, PGlite `initialMemory`, and whether `pg_stat_progress_create_index` produces rows during our build. Unknown values are not acceptable in the verification record.
- Integrated full-root throughput must not materially regress from the parent indexing pipeline. Use the existing measured-bottleneck framing: after excluding model warmup and logged QoS pauses, `steady_state_integrated_chunks_per_sec >= 0.70 * measured_bottleneck_chunks_per_sec`. If the parent branch lacks a comparable measurement artifact, capture one before implementing this plan.
- The warning pass is separate from success checks. Every warning/error in the full run must be classified as existing, introduced, or externally caused. Any introduced warning/error from indexing, embedding, PGlite, WebGPU, worker lifecycle, or DB host code is release-blocking.

The release bar is intentionally stricter than "the job eventually finished." Any timeout, hidden backend fallback, incomplete durable obligation, unbounded memory growth, full-run throughput regression, or unclassified warning/error prevents `release-sufficient`.

## Implementation Stop Rule

Do not call this branch fixed, PR-ready, or merge-ready until the real Electron app completes the full three-root Workspace Index run end to end under Chrome DevTools observation.

The active proof must include all of the following on the same commit SHA:

- the full expected three-root candidate set is counted through the app's own indexing policy, not shell `find`;
- every expected record is present by durable `root_id`/relative path accounting;
- every expected chunk is embedded, with `embedded_chunk_count === chunk_count`;
- `job_queue` has no queued, running, failed, or abandoned `embed_chunk` jobs for the active workspace index;
- no stuck "2 running" or lease-expired-but-visible-running state remains;
- the hidden embedding host reports the configured backend, actual runtime backend, precision, and `fallbackApplied:false`;
- WebGPU is used for the WebGPU acceptance run; WASM is not an acceptable substitute and is a hard failure when WebGPU is configured;
- no `DB host request timed out: query`, `Local embedding execution failed`, renderer crash, GPU crash, host restart loop, or silent pause occurs;
- DB-host, visible-renderer, and embedding-host memory are sampled through completion and post-completion plateau;
- HNSW suspension and durable maintenance rows are reconciled after embedding completion;
- every warning/error emitted during the proof run is classified before the PR is declared ready.

If the proof run fails any item above, stop claiming progress and classify the failure as either:

- `indexing-pipeline-failure`: durable work was lost, stuck, or incorrectly marked complete;
- `backend-contract-failure`: configured backend was not honored or actual runtime degraded;
- `db-host-failure`: DB work timed out, wedged, or starved the pipeline;
- `throughput-failure`: the pipeline completes only at an unacceptable rate without a measured resource constraint;
- `maintenance-lane-failure`: embedding completes but HNSW suspension/maintenance does not reconcile safely;
- `observability-failure`: logs/DevTools/diagnostics cannot prove what happened.

The next engineering action must target the classified failure directly. Do not compensate by loosening tests, lowering the throughput bar, switching backend, hiding warnings, or describing retry behavior as the root fix.

## Non-Negotiable End-To-End Proof Gate

Unit tests and static checks are necessary but not sufficient for this work. The branch is not ready for PR, and must not be described as fixed, until a real Electron renderer run proves the complete workspace indexing loop on the full three-root data set.

The proof gate is:

1. Start the real desktop app through the agent-debug entrypoint:

```bash
pnpm --filter @brainstrike/desktop dev:agent-debug
```

2. Attach Chrome DevTools to the running Electron renderer. Use DevTools to inspect runtime state, not just logs:
   - Console must have no new indexing, embedding, WebGPU, worker lifecycle, IPC, or DB-host warnings/errors.
   - Network/IPC-visible failures must be absent for `db:query`, `maintenance:exec`, embedding-host progress, and background-indexing backfill.
   - Renderer runtime must report WebGPU execution for local embeddings. WASM execution or backend mismatch is a hard failure.

3. Use the full real three-root workspace, not a toy fixture:
   - Count candidate text files per root before trusting UI totals.
   - Confirm each root contributes indexed files.
   - Confirm custom filters are not accidentally excluding text files.
   - Confirm `file_count`, `chunk_count`, `embedded_chunk_count`, and root-scoped counts agree with DB queries.

4. Let the run finish:
   - `embedded_chunk_count === chunk_count`.
   - `job_queue` has `queued = 0`, `running = 0`, `failed = 0` for `queue = 'embeddings'`.
   - No stuck two-running-job state remains.
   - No `DB host request timed out: query`.
   - No `Local embedding execution failed`.
   - No renderer crash, GPU process crash, host restart loop, or hidden-host silent restart.

5. Confirm nonblocking HNSW maintenance after embeddings complete:
   - Background backfill must request durable dimension maintenance.
   - The durable maintenance row must exist while `embedding_dimension_index_suspensions` exists.
   - HNSW `CREATE INDEX` must not run inline during embedding drain.
   - Idle maintenance must run through `maintenance:exec`, not `db:query`.
   - After successful maintenance, the matching suspension must be removed.

6. Capture performance and memory evidence:
   - Record start/end timestamps, model key, backend, precision, files, chunks, embedded chunks, and total duration.
   - Record steady-state integrated chunks/sec after model warmup.
   - Record DB-host process memory and embedding-host renderer memory at start, mid-run, completion, and 10 minutes after completion.
   - Memory growth after completion must plateau. Monotonic growth after completion is release-blocking.

7. Run a separate warning pass:
   - Export logs after the full run.
   - Classify every warning/error as existing, introduced, or external.
   - Any introduced indexing, embedding, WebGPU, PGlite, worker lifecycle, or DB-host warning/error blocks release.

8. Save the verification record in the PR body, not as a generated artifact committed to the repo:

```text
Electron full-root proof:
- Date:
- Branch:
- Commit:
- Roots:
- Candidate text-file counts by root:
- UI file count:
- DB file count:
- DB chunk count:
- DB embedded chunk count:
- Queue terminal counts:
- Model key:
- Runtime backend:
- Precision:
- Fallback applied:
- Start:
- Finish:
- Duration:
- Steady-state chunks/sec:
- DB-host memory start/mid/end/post-10m:
- Embedding-host memory start/mid/end/post-10m:
- DevTools console warnings/errors:
- Log warning/error classification:
- HNSW maintenance rows:
- HNSW suspension rows:
- HNSW index exists:
- maintenance:exec observed:
- db:query timeout observed:
- Release result: release-sufficient | implementation-correct-but-release-blocked | implementation-failed
```

If this proof gate fails, stop implementation claims immediately and classify the failure. Do not compensate by weakening tests, lowering throughput expectations, switching to WASM, hiding warnings, or calling the issue a retry problem.

## Architecture Decision

Use a new persistent table instead of overloading `job_queue`.

Reasons:

- `job_queue` currently has `JobType = 'embed_chunk'` and is consumed by embedding workers. Adding maintenance jobs there would either require widening the worker contract or adding special-case filtering.
- Existing scheduled DB maintenance skips when `job_queue` is active. That is the right invariant for HNSW maintenance; HNSW should be downstream of embedding, not peers with embedding jobs.
- A dedicated table can model dimension-level idempotency, attempts, last error, timestamps, and stale-running recovery without making embedding workers aware of index maintenance.

The new invariant:

```text
embedding_dimension_index_suspensions row exists
  => HNSW index for that dimension is intentionally unavailable
  => either active embedding/backfill work owns the suspension, or a durable maintenance row must exist
```

The scheduler reconciles this invariant on startup and every maintenance pass, so a crash between backfill completion and maintenance enqueue cannot permanently leave search degraded.

## Files To Create Or Modify

Create:

- `apps/desktop/src/dimension-index-maintenance-capabilities.ts`
  - Probes PGlite/pgvector index-maintenance capabilities without mutating production tables.
- `apps/desktop/src/__tests__/dimension-index-maintenance-capabilities.test.ts`
  - Tests capability parsing, no-silent-fallback strategy selection, and invalid-index recovery decisions.
- `packages/db/src/migrations/045-dimension-index-maintenance.ts`
  - Adds durable dimension maintenance table.
- `packages/db/src/services/dimension-index-maintenance.ts`
  - Pure DB service for request/reconcile/claim/run/status.
- `packages/db/__tests__/dimension-index-maintenance.test.ts`
  - PGlite-backed tests for durable maintenance behavior.
- `apps/desktop/src/dimension-index-maintenance-scheduler.ts`
  - Desktop idle scheduler that gates and calls the DB service.
- `apps/desktop/src/__tests__/dimension-index-maintenance-scheduler.test.ts`
  - Scheduler gating and non-overlap tests.

Modify:

- `packages/db/src/migrations/index.ts`
  - Register migration 045 in numbered migration runner.
- `packages/db/src/drizzle/migrate.ts`
  - Register `custom-045-dimension-index-maintenance` in the custom ledger.
- `packages/db/src/index.ts`
  - Export the new service types/functions.
- `packages/db/scripts/test-lanes.mjs`
  - Register `packages/db/__tests__/dimension-index-maintenance.test.ts`.
- `packages/db/scripts/coverage-lanes.mjs`
  - Register the same DB test for nightly coverage.
- `apps/desktop/src/embedding-backfill.ts`
  - Replace the current “background skip rebuild” terminal state with durable maintenance request.
- `apps/desktop/src/ipc-embedding-backfill.ts`
  - Keep background rebuild nonblocking and wire any new option names.
- `apps/desktop/src/main.ts`
  - Construct/start/stop the dimension maintenance scheduler next to existing DB maintenance.
- `packages/app-shell/src/background-indexing/workspace-index-debug-harness.ts`
  - Include dimension maintenance/suspension diagnostics in the debug snapshot.
- `packages/app-shell/src/diagnostics/system-diagnostics-panel.tsx`
  - Surface pending/running/failed HNSW maintenance state.
- Existing tests:
  - `apps/desktop/src/__tests__/main/embedding-backfill.test.ts`
  - `apps/desktop/src/__tests__/main/ipc-handlers-db-embedding-backfill.test.ts`
  - `apps/desktop/src/__tests__/database-maintenance-scheduler.test.ts` if shared scheduler helpers move.

Do not modify:

- Embedding worker execution location.
- WebGPU/WASM backend selection.
- Retry mechanics for embedding jobs except where tests need maintenance state setup.
- Query ranking/search SQL until the maintenance lane is measured. Search may remain sequential while suspended.

---

### Task 0: PGlite/HNSW Capability Probe

**Files:**
- Create: `apps/desktop/src/dimension-index-maintenance-capabilities.ts`
- Create: `apps/desktop/src/__tests__/dimension-index-maintenance-capabilities.test.ts`

- [ ] **Step 1: Write failing capability tests**

The tests must prove strategy selection is explicit, not silent fallback.

```ts
it('selects concurrent strategy only when the runtime probe proves it usable', async () => {
  const result = selectDimensionIndexStrategy({
    concurrentIndexBuild: {
      error: null,
      foregroundProbeP95Ms: 85,
      supported: true,
    },
    foregroundHealthThresholdMs: 5_000,
  });

  expect(result).toEqual({
    reason: 'concurrent-index-build-supported-and-responsive',
    strategy: 'concurrent',
  });
});

it('selects regular idle-only strategy when concurrent build is unsupported and reports why', async () => {
  const result = selectDimensionIndexStrategy({
    concurrentIndexBuild: {
      error: 'CREATE INDEX CONCURRENTLY is not supported in this PGlite runtime',
      foregroundProbeP95Ms: null,
      supported: false,
    },
    foregroundHealthThresholdMs: 5_000,
  });

  expect(result).toEqual({
    reason: 'concurrent-index-build-unsupported',
    strategy: 'regular',
  });
});

it('marks concurrent strategy unusable when foreground health is worse than the release threshold', async () => {
  const result = selectDimensionIndexStrategy({
    concurrentIndexBuild: {
      error: null,
      foregroundProbeP95Ms: 7_500,
      supported: true,
    },
    foregroundHealthThresholdMs: 5_000,
  });

  expect(result).toEqual({
    reason: 'concurrent-index-build-blocks-foreground-db',
    strategy: 'regular',
  });
});

it('does not choose concurrent when support exists but responsiveness has not been measured', async () => {
  const result = selectDimensionIndexStrategy({
    concurrentIndexBuild: {
      error: null,
      foregroundProbeP95Ms: null,
      supported: true,
    },
    foregroundHealthThresholdMs: 5_000,
  });

  expect(result).toEqual({
    reason: 'concurrent-index-build-unmeasured',
    strategy: 'regular',
  });
});
```

- [ ] **Step 2: Run tests and confirm red**

Run:

```bash
pnpm --filter @brainstrike/desktop exec vitest run src/__tests__/dimension-index-maintenance-capabilities.test.ts
```

Expected: fail because the capability module does not exist.

- [ ] **Step 3: Implement probe result types**

Create:

```ts
export type DimensionIndexBuildStrategy = 'concurrent' | 'regular';

export interface DimensionIndexRuntimeCapabilities {
  readonly concurrentIndexBuild: {
    readonly error: string | null;
    readonly foregroundProbeP95Ms: number | null;
    readonly supported: boolean;
  };
  readonly hnswIndexBuild: {
    readonly error: string | null;
    readonly supported: boolean;
  };
  readonly maintenanceSettings: {
    readonly initialMemoryBytes: number | null;
    readonly maintenanceWorkMem: string | null;
    readonly maxParallelMaintenanceWorkers: string | null;
    readonly maxParallelWorkers: string | null;
  };
  readonly progressReporting: {
    readonly error: string | null;
    readonly pgStatProgressCreateIndexReadable: boolean;
  };
}

export interface DimensionIndexStrategySelection {
  readonly reason:
    | 'concurrent-index-build-blocks-foreground-db'
    | 'concurrent-index-build-supported-and-responsive'
    | 'concurrent-index-build-unmeasured'
    | 'concurrent-index-build-unsupported';
  readonly strategy: DimensionIndexBuildStrategy;
}
```

- [ ] **Step 4: Implement strategy selection**

Implement:

```ts
export function selectDimensionIndexStrategy(input: {
  readonly concurrentIndexBuild: DimensionIndexRuntimeCapabilities['concurrentIndexBuild'];
  readonly foregroundHealthThresholdMs: number;
}): DimensionIndexStrategySelection
```

Rules:

- If concurrent is unsupported, select `regular` with `concurrent-index-build-unsupported`.
- If concurrent is supported but `foregroundProbeP95Ms` is `null`, select `regular` with `concurrent-index-build-unmeasured`.
- If concurrent p95 exceeds threshold, select `regular` with `concurrent-index-build-blocks-foreground-db`.
- Only select `concurrent` when supported and p95 is within threshold.
- This is not a silent fallback: the selected strategy and reason are logged, exposed in diagnostics, persisted in maintenance rows, and verified in the full-run evidence.

- [ ] **Step 5: Implement non-production table probes**

Implement a function that runs only against a scratch table name generated by the caller:

```ts
export async function probeDimensionIndexRuntimeCapabilities(params: {
  readonly db: {
    readonly maintenance?: { exec: (sql: string, params?: readonly unknown[]) => Promise<unknown> };
    readonly query: <TRecord = unknown>(
      sql: string,
      params?: readonly unknown[]
    ) => Promise<{ rows: readonly TRecord[] }>;
  };
  readonly foregroundHealthProbe: () => Promise<{ p95Ms: number }>;
  readonly initialMemoryBytes: number | null;
  readonly now: () => Date;
  readonly scratchTableName: string;
}): Promise<DimensionIndexRuntimeCapabilities>
```

Probe sequence:

1. Validate `scratchTableName` with `/^brainstrike_hnsw_probe_[a-z0-9_]+$/`.
2. Use `maintenance.exec`, not `query`, for DDL.
3. Create a scratch table with a `vector(3)` column.
4. Insert a tiny set of rows.
5. Run a regular HNSW halfvec index build against the scratch table.
6. Drop that index.
7. Try `CREATE INDEX CONCURRENTLY` against the scratch table outside any transaction.
8. If concurrent syntax succeeds, record `supported:true` and `foregroundProbeP95Ms:null`. Startup probes must not run a large active index build. Production must select `regular` with `concurrent-index-build-unmeasured` until Task 6 proves concurrent responsiveness on the full-size run.
9. Query `SHOW maintenance_work_mem`, `SHOW max_parallel_maintenance_workers`, `SHOW max_parallel_workers`.
10. Query `SELECT COUNT(*)::int FROM pg_stat_progress_create_index` and record whether the view is readable.
11. Drop the scratch table with `DROP TABLE IF EXISTS`.

Never run this probe on `file_chunks`.

- [ ] **Step 6: Implement explicit concurrent health measurement for verification**

Add a verification-only helper, exported from the same module but not called during normal startup:

```ts
export async function measureConcurrentIndexForegroundHealth(params: {
  readonly createConcurrentIndex: () => Promise<void>;
  readonly foregroundHealthProbe: () => Promise<{
    readonly maxMs: number;
    readonly p50Ms: number;
    readonly p95Ms: number;
    readonly samples: number;
  }>;
}): Promise<{
  readonly createIndexCompleted: boolean;
  readonly foregroundProbeMaxMs: number;
  readonly foregroundProbeP50Ms: number;
  readonly foregroundProbeP95Ms: number;
  readonly foregroundProbeSamples: number;
}>
```

Rules:

- The helper starts the supplied concurrent index build and samples foreground DB health while the build is active.
- It returns measured values only after the index build completes successfully.
- If the build fails, propagate the failure and do not return partial success.
- Normal app startup must not call this helper.
- The full verification task uses this helper or an equivalent DevTools-driven measurement against the real full-size maintenance build.

- [ ] **Step 7: Add invalid-index inspection helper**

Because PostgreSQL documents that failed concurrent builds can leave invalid indexes, add:

```ts
export async function listInvalidDimensionIndexes(db: {
  readonly query: <TRecord = unknown>(
    sql: string,
    params?: readonly unknown[]
  ) => Promise<{ rows: readonly TRecord[] }>;
}): Promise<readonly { indexName: string; isValid: boolean; isReady: boolean }[]>
```

Use `pg_index` and `pg_class` to find indexes named `idx_file_chunks_emb_hnsw_%` where `indisvalid = false OR indisready = false`.

- [ ] **Step 8: Run focused tests**

Run:

```bash
pnpm --filter @brainstrike/desktop exec vitest run src/__tests__/dimension-index-maintenance-capabilities.test.ts
pnpm --filter @brainstrike/desktop run type-check
```

Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src/dimension-index-maintenance-capabilities.ts \
  apps/desktop/src/__tests__/dimension-index-maintenance-capabilities.test.ts
git commit -m "Probe dimension index maintenance capabilities"
```

---

### Task 1: Persist Dimension Maintenance State

**Files:**
- Create: `packages/db/src/migrations/045-dimension-index-maintenance.ts`
- Create: `packages/db/__tests__/dimension-index-maintenance.test.ts`
- Modify: `packages/db/src/migrations/index.ts`
- Modify: `packages/db/src/drizzle/migrate.ts`
- Modify: `packages/db/scripts/test-lanes.mjs`
- Modify: `packages/db/scripts/coverage-lanes.mjs`

- [ ] **Step 1: Write the failing migration test**

Add a test that runs migrations and verifies the table shape and idempotent upsert behavior through SQL, before adding the migration.

```ts
it('creates durable dimension index maintenance rows keyed by dimension', async () => {
  await db.query(
    `INSERT INTO embedding_dimension_index_maintenance
       (dimension, state, reason, strategy, requested_at, next_run_at, attempts)
     VALUES (384, 'pending', 'background-indexing-backfill-complete', 'regular', $1, $1, 0)
     ON CONFLICT (dimension) DO UPDATE
       SET state = EXCLUDED.state,
           reason = EXCLUDED.reason,
           strategy = EXCLUDED.strategy,
           requested_at = EXCLUDED.requested_at,
           next_run_at = EXCLUDED.next_run_at`,
    [NOW_ISO]
  );

  const result = await db.query<{
    attempts: number;
    dimension: number;
    state: string;
    strategy: string;
  }>(
    `SELECT dimension, state, strategy, attempts
       FROM embedding_dimension_index_maintenance
      WHERE dimension = 384`
  );

  expect(result.rows).toEqual([
    { attempts: 0, dimension: 384, state: 'pending', strategy: 'regular' },
  ]);
});
```

- [ ] **Step 2: Run the test and confirm red**

Run:

```bash
pnpm --filter @brainstrike/db exec vitest run packages/db/__tests__/dimension-index-maintenance.test.ts
```

Expected: fail with `relation "embedding_dimension_index_maintenance" does not exist`.

- [ ] **Step 3: Add migration 045**

Create `packages/db/src/migrations/045-dimension-index-maintenance.ts` with:

```ts
import type { Migration } from './migration-runner';

export const migration045DimensionIndexMaintenance: Migration = {
  version: 45,
  name: 'dimension_index_maintenance',
  up: `
    CREATE TABLE IF NOT EXISTS embedding_dimension_index_maintenance (
      dimension INTEGER PRIMARY KEY,
      state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'succeeded', 'failed')),
      reason TEXT NOT NULL,
      strategy TEXT NOT NULL DEFAULT 'regular' CHECK (strategy IN ('regular', 'concurrent')),
      requested_at TEXT NOT NULL,
      next_run_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      last_duration_ms INTEGER CHECK (last_duration_ms IS NULL OR last_duration_ms >= 0),
      last_foreground_probe_p95_ms INTEGER
        CHECK (last_foreground_probe_p95_ms IS NULL OR last_foreground_probe_p95_ms >= 0),
      last_foreground_probe_max_ms INTEGER
        CHECK (last_foreground_probe_max_ms IS NULL OR last_foreground_probe_max_ms >= 0),
      last_invalid_index_name TEXT,
      last_error TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_embedding_dimension_index_maintenance_due
      ON embedding_dimension_index_maintenance (state, next_run_at, requested_at);
  `,
  down: `
    DROP TABLE IF EXISTS embedding_dimension_index_maintenance;
  `,
};
```

- [ ] **Step 4: Register migration in both migration runners**

In `packages/db/src/migrations/index.ts`, import and append `migration045DimensionIndexMaintenance` after migration 044.

In `packages/db/src/drizzle/migrate.ts`, import it and append:

```ts
customMigration('custom-045-dimension-index-maintenance', migration045DimensionIndexMaintenance),
```

- [ ] **Step 5: Register the new DB test in both lane manifests**

Add `packages/db/__tests__/dimension-index-maintenance.test.ts` to both:

```text
packages/db/scripts/test-lanes.mjs
packages/db/scripts/coverage-lanes.mjs
```

- [ ] **Step 6: Run green checks for migration registration**

Run:

```bash
pnpm --filter @brainstrike/db exec vitest run packages/db/__tests__/dimension-index-maintenance.test.ts
pnpm --filter @brainstrike/db run test:db:check-lanes
pnpm --filter @brainstrike/db run test:coverage:db:check-lanes
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/migrations/045-dimension-index-maintenance.ts \
  packages/db/src/migrations/index.ts \
  packages/db/src/drizzle/migrate.ts \
  packages/db/__tests__/dimension-index-maintenance.test.ts \
  packages/db/scripts/test-lanes.mjs \
  packages/db/scripts/coverage-lanes.mjs
git commit -m "Add durable dimension index maintenance state"
```

---

### Task 2: Build Pure DB Maintenance Service

**Files:**
- Create: `packages/db/src/services/dimension-index-maintenance.ts`
- Modify: `packages/db/src/index.ts`
- Modify: `packages/db/__tests__/dimension-index-maintenance.test.ts`

- [ ] **Step 1: Write failing service tests**

Add tests for these behaviors:

```ts
it('requests maintenance idempotently and keeps a pending retry visible', async () => {
  await requestDimensionIndexMaintenance(db, {
    dimension: 384,
    now: () => new Date(NOW_ISO),
    reason: 'background-indexing-backfill-complete',
  });
  await db.query(
    `UPDATE embedding_dimension_index_maintenance
        SET state = 'failed',
            attempts = 1,
            last_error = 'previous failure'
      WHERE dimension = 384`
  );

  await requestDimensionIndexMaintenance(db, {
    dimension: 384,
    now: () => new Date(RECENT_ISO),
    reason: 'background-indexing-backfill-complete',
  });

  const rows = await listDimensionIndexMaintenance(db);
  expect(rows).toMatchObject([
    {
      attempts: 1,
      dimension: 384,
      lastError: 'previous failure',
      state: 'pending',
    },
  ]);
});

it('reconciles orphaned suspensions into pending maintenance rows', async () => {
  await db.query(
    `INSERT INTO embedding_dimension_index_suspensions (dimension, reason, suspended_at)
     VALUES (384, 'embedding-backfill:set-a', $1)`,
    [NOW_ISO]
  );

  const count = await reconcileSuspendedDimensionIndexMaintenance(db, {
    now: () => new Date(RECENT_ISO),
  });

  expect(count).toBe(1);
  await expectMaintenanceRow(384, 'pending');
});

it('skips maintenance while embedding jobs are active', async () => {
  await requestDimensionIndexMaintenance(db, {
    dimension: 384,
    now: () => new Date(NOW_ISO),
    reason: 'background-indexing-backfill-complete',
  });
  await queue.enqueue({
    jobType: 'embed_chunk',
    payload: { chunkId: crypto.randomUUID(), embeddingSetId: 'set-a' },
    queue: 'embeddings',
  });

  const result = await runNextDimensionIndexMaintenance(db, {
    createIndex: vi.fn(),
    now: () => new Date(RECENT_ISO),
    strategy: 'regular',
  });

  expect(result).toMatchObject({ reason: 'active-job-queue', status: 'skipped' });
});

it('creates the index then resumes the suspension on success', async () => {
  await db.query(
    `INSERT INTO embedding_dimension_index_suspensions (dimension, reason, suspended_at)
     VALUES (384, 'embedding-backfill:set-a', $1)`,
    [NOW_ISO]
  );
  await requestDimensionIndexMaintenance(db, {
    dimension: 384,
    now: () => new Date(NOW_ISO),
    reason: 'background-indexing-backfill-complete',
  });
  const createIndex = vi.fn(async () => undefined);

  const result = await runNextDimensionIndexMaintenance(db, {
    createIndex,
    now: () => new Date(RECENT_ISO),
    strategy: 'regular',
  });

  expect(result).toMatchObject({ dimension: 384, status: 'completed' });
  expect(createIndex).toHaveBeenCalledWith({ dimension: 384, strategy: 'regular' });
  await expectSuspensionMissing(384);
  await expectMaintenanceRow(384, 'succeeded', {
    strategy: 'regular',
  });
});

it('records retryable failure and keeps the suspension when index creation fails', async () => {
  await db.query(
    `INSERT INTO embedding_dimension_index_suspensions (dimension, reason, suspended_at)
     VALUES (384, 'embedding-backfill:set-a', $1)`,
    [NOW_ISO]
  );
  await requestDimensionIndexMaintenance(db, {
    dimension: 384,
    now: () => new Date(NOW_ISO),
    reason: 'background-indexing-backfill-complete',
  });

  const result = await runNextDimensionIndexMaintenance(db, {
    createIndex: vi.fn(async () => {
      throw new Error('hnsw build failed');
    }),
    now: () => new Date(RECENT_ISO),
    retryBackoffMs: 60_000,
    strategy: 'regular',
  });

  expect(result).toMatchObject({
    dimension: 384,
    error: 'hnsw build failed',
    status: 'failed',
  });
  await expectSuspensionPresent(384);
  await expectMaintenanceRow(384, 'pending', {
    attempts: 1,
    lastError: 'hnsw build failed',
  });
});
```

- [ ] **Step 2: Run tests and confirm red**

Run:

```bash
pnpm --filter @brainstrike/db exec vitest run packages/db/__tests__/dimension-index-maintenance.test.ts
```

Expected: fail because the service functions are not exported.

- [ ] **Step 3: Implement service types and validators**

In `packages/db/src/services/dimension-index-maintenance.ts`, define:

```ts
export type DimensionIndexMaintenanceState = 'failed' | 'pending' | 'running' | 'succeeded';
export type DimensionIndexMaintenanceSkipReason =
  | 'active-job-queue'
  | 'max-attempts'
  | 'no-pending-maintenance';
export type DimensionIndexMaintenanceStatus = 'completed' | 'failed' | 'skipped';

export interface DimensionIndexMaintenanceRow {
  readonly attempts: number;
  readonly completedAt: string | null;
  readonly dimension: number;
  readonly lastDurationMs: number | null;
  readonly lastError: string | null;
  readonly lastForegroundProbeMaxMs: number | null;
  readonly lastForegroundProbeP95Ms: number | null;
  readonly lastInvalidIndexName: string | null;
  readonly nextRunAt: string;
  readonly reason: string;
  readonly requestedAt: string;
  readonly startedAt: string | null;
  readonly state: DimensionIndexMaintenanceState;
  readonly strategy: 'concurrent' | 'regular';
}

export interface RunDimensionIndexMaintenanceOptions {
  readonly createIndex: (request: {
    readonly dimension: number;
    readonly strategy: 'concurrent' | 'regular';
  }) => Promise<void>;
  readonly foregroundProbeMaxMs?: number | null;
  readonly foregroundProbeP95Ms?: number | null;
  readonly listInvalidIndexes?: () => Promise<
    readonly { readonly indexName: string; readonly isReady: boolean; readonly isValid: boolean }[]
  >;
  readonly maxAttempts?: number;
  readonly now?: () => Date;
  readonly retryBackoffMs?: number;
  readonly strategy: 'concurrent' | 'regular';
}
```

Validation rules:

- `dimension` must be a positive safe integer.
- `reason` must be non-empty.
- `now()` must return a valid Date.
- `retryBackoffMs` must be non-negative.
- `maxAttempts` must be a positive integer.
- `strategy` must be `'regular'` or `'concurrent'`.
- Foreground probe metrics, when supplied, must be finite non-negative numbers.

- [ ] **Step 4: Implement idempotent request and reconciliation**

Implement:

```ts
export async function requestDimensionIndexMaintenance(
  db: DimensionIndexMaintenanceDb,
  request: RequestDimensionIndexMaintenanceInput
): Promise<void>

export async function reconcileSuspendedDimensionIndexMaintenance(
  db: DimensionIndexMaintenanceDb,
  options?: DimensionIndexMaintenanceClockOptions
): Promise<number>
```

Contract:

- `requestDimensionIndexMaintenance` upserts by `dimension`.
- The requested strategy is persisted. Strategy changes are allowed only when a new capability probe justifies them.
- Existing `running` rows are left running.
- Existing `succeeded` rows can be moved back to `pending` if a new suspension exists.
- Existing `failed` rows become `pending` but keep `attempts` and `last_error`.
- Reconciliation inserts a pending row for every suspension dimension without a pending/running row.

- [ ] **Step 5: Implement claim/run/failure behavior**

Implement `runNextDimensionIndexMaintenance`.

Important order:

1. Reconcile orphaned suspensions.
2. Count active `job_queue` rows where state is `queued` or `running`; skip if any exist.
3. Claim the oldest due `pending` row by setting it to `running`, incrementing `attempts`, setting `started_at`, and clearing no suspension yet.
4. Call `options.createIndex({ dimension, strategy })`.
5. If `strategy === 'concurrent'` and the call fails, inspect invalid indexes before returning. Record the invalid index name in `last_invalid_index_name` and keep the suspension.
6. On success: delete `embedding_dimension_index_suspensions` row for the dimension, set maintenance row `succeeded`, set `completed_at`, set `last_duration_ms`, record foreground probe metrics if supplied, clear `last_error`, clear `last_invalid_index_name`.
7. On failure below max attempts: set row back to `pending`, set `next_run_at = now + retryBackoffMs`, preserve suspension, record `last_error`, record `last_invalid_index_name` when present.
8. On failure at max attempts: set row `failed`, preserve suspension, record `last_error`, return failed.

Do not delete the maintenance row on success. Keeping a short success history makes diagnostics and support logs explain why a suspension disappeared.

- [ ] **Step 6: Export service**

In `packages/db/src/index.ts`, export the new service functions and types.

- [ ] **Step 7: Run DB tests**

Run:

```bash
pnpm --filter @brainstrike/db exec vitest run packages/db/__tests__/dimension-index-maintenance.test.ts packages/db/__tests__/scheduled-database-maintenance.test.ts
pnpm --filter @brainstrike/db run type-check
```

Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add packages/db/src/services/dimension-index-maintenance.ts \
  packages/db/src/index.ts \
  packages/db/__tests__/dimension-index-maintenance.test.ts
git commit -m "Add dimension index maintenance service"
```

---

### Task 3: Add Desktop Idle Scheduler

**Files:**
- Create: `apps/desktop/src/dimension-index-maintenance-scheduler.ts`
- Create: `apps/desktop/src/__tests__/dimension-index-maintenance-scheduler.test.ts`
- Modify: `apps/desktop/src/main.ts`

- [ ] **Step 1: Write failing scheduler tests**

Tests must cover:

```ts
it('skips when DB scheduler is busy', async () => {
  const runScheduledWork = vi.fn();
  const scheduler = createDesktopDimensionIndexMaintenanceScheduler({
    getDatabase: vi.fn(async () => db),
    getPowerSnapshot: () => idleAcSnapshot(),
    getSchedulerSnapshot: () => ({
      queued: { background: 0, foreground: 1, normal: 0 },
      runningPriority: null,
    }),
    logger,
    runDimensionMaintenance,
    runScheduledWork,
  });

  await expect(scheduler.runOnce()).resolves.toMatchObject({
    reason: 'database-scheduler-busy',
    status: 'skipped',
  });
  expect(runScheduledWork).not.toHaveBeenCalled();
});

it('skips when the machine is not idle on AC', async () => {
  const scheduler = createDesktopDimensionIndexMaintenanceScheduler({
    getDatabase: vi.fn(async () => db),
    getPowerSnapshot: () => ({
      idleState: 'active',
      idleTimeMs: 1_000,
      powerSource: 'ac',
      thermalState: 'nominal',
    }),
    getSchedulerSnapshot: idleSchedulerSnapshot,
    logger,
    runDimensionMaintenance,
    runScheduledWork,
  });

  await expect(scheduler.runOnce()).resolves.toMatchObject({
    reason: 'power-not-idle',
    status: 'skipped',
  });
});

it('runs one maintenance unit through the background DB lane using maintenance exec', async () => {
  let capturedOptions: DatabaseWorkRunOptions | null = null;
  const maintenanceExec = vi.fn(async () => undefined);
  const runScheduledWork = vi.fn(async (options, work) => {
    capturedOptions = options;
    return await work();
  });
  const runDimensionMaintenance = vi.fn(async (_db, options) => {
    await options.createIndex({ dimension: 384, strategy: 'regular' });
    return { dimension: 384, durationMs: 123, status: 'completed', strategy: 'regular' };
  });

  const scheduler = createDesktopDimensionIndexMaintenanceScheduler({
    getDatabase: vi.fn(async () => ({ ...db, maintenance: { exec: maintenanceExec } })),
    getPowerSnapshot: idleAcSnapshot,
    getSchedulerSnapshot: idleSchedulerSnapshot,
    logger,
    runDimensionMaintenance,
    runScheduledWork,
  });

  await expect(scheduler.runOnce()).resolves.toMatchObject({
    dimension: 384,
    status: 'completed',
  });
  expect(capturedOptions).toEqual({
    label: 'dimension-index-maintenance',
    priority: 'background',
  });
  expect(maintenanceExec).toHaveBeenCalledWith(expect.stringContaining('CREATE INDEX'), []);
});

it('passes concurrent strategy only when capability selection chose concurrent', async () => {
  const maintenanceExec = vi.fn(async () => undefined);
  const runDimensionMaintenance = vi.fn(async (_db, options) => {
    await options.createIndex({ dimension: 384, strategy: options.strategy });
    return { dimension: 384, durationMs: 123, status: 'completed', strategy: options.strategy };
  });

  const scheduler = createDesktopDimensionIndexMaintenanceScheduler({
    getDatabase: vi.fn(async () => ({ ...db, maintenance: { exec: maintenanceExec } })),
    getDimensionIndexStrategy: () => ({
      reason: 'concurrent-index-build-supported-and-responsive',
      strategy: 'concurrent',
    }),
    getPowerSnapshot: idleAcSnapshot,
    getSchedulerSnapshot: idleSchedulerSnapshot,
    logger,
    runDimensionMaintenance,
    runScheduledWork,
  });

  await expect(scheduler.runOnce()).resolves.toMatchObject({
    dimension: 384,
    status: 'completed',
    strategy: 'concurrent',
  });
  expect(maintenanceExec).toHaveBeenCalledWith(
    expect.stringContaining('CREATE INDEX CONCURRENTLY'),
    []
  );
});
```

- [ ] **Step 2: Run test and confirm red**

Run:

```bash
pnpm --filter @brainstrike/desktop exec vitest run src/__tests__/dimension-index-maintenance-scheduler.test.ts
```

Expected: fail because scheduler file does not exist.

- [ ] **Step 3: Implement scheduler skip reasons and gates**

Create `apps/desktop/src/dimension-index-maintenance-scheduler.ts`.

Skip reasons:

```ts
export type DesktopDimensionIndexMaintenanceSkipReason =
  | 'already-running'
  | 'database-scheduler-busy'
  | 'power-not-ac'
  | 'power-not-idle'
  | 'thermal-pressure';
```

Power gates:

- Require `powerSource === 'ac'`.
- Require `idleState === 'idle' || idleState === 'locked'`.
- Require `idleTimeMs >= 120_000`.
- Require `thermalState !== 'serious' && thermalState !== 'critical'`.
- Unknown values are not accepted silently. `powerSource:'unknown'`, `idleState:'unknown'`, and `thermalState:'unknown'` skip with explicit reason and log context.

- [ ] **Step 4: Implement HNSW creation adapter through maintenance exec**

The scheduler's `createIndex` callback must use validated SQL construction equivalent to `createDimensionIndex`, but routed through `db.maintenance.exec`.

Do not run HNSW `CREATE INDEX` via normal `db.query`.

Strategy rules:

- `regular` emits `CREATE INDEX IF NOT EXISTS ... USING hnsw ...`.
- `concurrent` emits `CREATE INDEX CONCURRENTLY IF NOT EXISTS ... USING hnsw ...`.
- `concurrent` may only be used when `getDimensionIndexStrategy()` returns `strategy:'concurrent'`; this must come from Task 0 capability selection.
- If the strategy provider is unavailable or returns an invalid result, throw. Do not default silently.
- If `concurrent` fails, the service must inspect invalid indexes before retry scheduling.

If the DB handle lacks `maintenance.exec`, throw:

```text
Dimension index maintenance requires DB maintenance exec support.
```

This is intentional because silent downgrade to `db:query` reintroduces the timeout class from the crash.

- [ ] **Step 5: Wire scheduler lifecycle in `main.ts`**

Add a new module-level scheduler:

```ts
let desktopDimensionIndexMaintenanceScheduler: DesktopDimensionIndexMaintenanceScheduler | null =
  null;
```

Construct it near `desktopDatabaseMaintenanceScheduler`:

```ts
desktopDimensionIndexMaintenanceScheduler = createDesktopDimensionIndexMaintenanceScheduler({
  getDatabase,
  getDimensionIndexStrategy: getDesktopDimensionIndexStrategy,
  getPowerSnapshot: () => readDesktopPowerSnapshot(powerMonitor),
  getSchedulerSnapshot: getDesktopDatabaseWorkSchedulerSnapshot,
  logger,
  runScheduledWork: runDesktopScheduledDatabaseWork,
});
```

`getDesktopDimensionIndexStrategy` must be initialized from the Task 0 capability probe. If that probe has not completed, it returns a loud unavailable state and the scheduler skips without starting HNSW DDL.

Start it when the app starts the existing DB maintenance scheduler and stop it during shutdown/factory reset next to the existing scheduler.

- [ ] **Step 6: Run desktop scheduler tests**

Run:

```bash
pnpm --filter @brainstrike/desktop exec vitest run src/__tests__/dimension-index-maintenance-scheduler.test.ts src/__tests__/database-maintenance-scheduler.test.ts
pnpm --filter @brainstrike/desktop run type-check
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/dimension-index-maintenance-scheduler.ts \
  apps/desktop/src/__tests__/dimension-index-maintenance-scheduler.test.ts \
  apps/desktop/src/main.ts
git commit -m "Schedule dimension index maintenance during idle"
```

---

### Task 4: Request Maintenance At Background Backfill Completion

**Files:**
- Modify: `apps/desktop/src/embedding-backfill.ts`
- Modify: `apps/desktop/src/ipc-embedding-backfill.ts`
- Modify: `apps/desktop/src/__tests__/main/embedding-backfill.test.ts`
- Modify: `apps/desktop/src/__tests__/main/ipc-handlers-db-embedding-backfill.test.ts`

- [ ] **Step 1: Write failing backfill tests**

Update the current background-skip tests so they assert durable maintenance request, not only “does not call maintenance exec.”

Example:

```ts
it('requests deferred HNSW maintenance after a successful background indexing drain', async () => {
  const requestedMaintenance: Array<{ dimension: number; reason: string; strategy: string }> = [];

  await enqueueEmbeddingBackfill(db, jobQueue, 'set-123', onProgress, {
    rebuildDimensionIndexOnCompletion: false,
    requestDimensionIndexMaintenance: async (_db, request) => {
      requestedMaintenance.push({
        dimension: request.dimension,
        reason: request.reason,
        strategy: request.strategy,
      });
    },
    selectDimensionIndexStrategy: () => ({
      reason: 'concurrent-index-build-unsupported',
      strategy: 'regular',
    }),
  });

  expect(requestedMaintenance).toEqual([
    {
      dimension: 384,
      reason: 'background-indexing-backfill-complete',
      strategy: 'regular',
    },
  ]);
  expect(maintenanceDb.maintenance.exec).not.toHaveBeenCalledWith(
    expect.stringContaining('CREATE INDEX'),
    expect.anything()
  );
});
```

Also add:

```ts
it('does not report success if deferred maintenance request fails', async () => {
  await expect(
    enqueueEmbeddingBackfill(db, jobQueue, 'set-123', onProgress, {
      rebuildDimensionIndexOnCompletion: false,
      requestDimensionIndexMaintenance: async () => {
        throw new Error('maintenance request failed');
      },
    })
  ).rejects.toThrow('maintenance request failed');
});
```

- [ ] **Step 2: Run tests and confirm red**

Run:

```bash
pnpm --filter @brainstrike/desktop exec vitest run src/__tests__/main/embedding-backfill.test.ts
```

Expected: fail because no durable maintenance request is made.

- [ ] **Step 3: Extend backfill options with explicit dependency injection**

Add:

```ts
requestDimensionIndexMaintenance?: (
  db: EmbeddingBackfillDatabase,
  request: {
    readonly dimension: number;
    readonly now: () => Date;
    readonly reason: string;
    readonly strategy: 'concurrent' | 'regular';
  }
) => Promise<void>;

selectDimensionIndexStrategy?: () => {
  readonly reason: string;
  readonly strategy: 'concurrent' | 'regular';
};
```

Use a dependency-injected function in tests and default to the DB service in production. Do not make this optional for the deferred path: if deferred maintenance cannot be persisted, the backfill should fail loudly instead of pretending the index is recoverable.

The strategy selector is also required in the deferred path. If unavailable, throw:

```text
Background HNSW maintenance requires a completed dimension index capability probe.
```

- [ ] **Step 4: Change completion behavior**

When `rebuildDimensionIndexOnCompletion === false`:

1. Keep the suspension row.
2. Read the capability-selected strategy.
3. Insert/update a pending dimension maintenance row including `strategy`.
4. Log `Dimension HNSW index rebuild deferred after embedding backfill` with `dimension`, `embeddingSetId`, `strategy`, and `strategyReason`.
5. Return `true` for `dimensionIndexSuspended`.

Do not call `createDimensionIndex`.

- [ ] **Step 5: Update IPC expectations**

In `apps/desktop/src/__tests__/main/ipc-handlers-db-embedding-backfill.test.ts`, keep the expectation that background indexing passes nonblocking completion options, and include any new option name if the API is renamed.

- [ ] **Step 6: Run focused tests**

Run:

```bash
pnpm --filter @brainstrike/desktop exec vitest run src/__tests__/main/embedding-backfill.test.ts src/__tests__/main/ipc-handlers-db-embedding-backfill.test.ts
pnpm --filter @brainstrike/desktop run type-check
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/embedding-backfill.ts \
  apps/desktop/src/ipc-embedding-backfill.ts \
  apps/desktop/src/__tests__/main/embedding-backfill.test.ts \
  apps/desktop/src/__tests__/main/ipc-handlers-db-embedding-backfill.test.ts
git commit -m "Defer background HNSW rebuilds durably"
```

---

### Task 5: Add Diagnostics And User-Visible State

**Files:**
- Modify: `packages/app-shell/src/background-indexing/workspace-index-debug-harness.ts`
- Modify: `packages/app-shell/src/background-indexing/__tests__/workspace-index-debug-harness.test.ts`
- Modify: `packages/app-shell/src/diagnostics/system-diagnostics-panel.tsx`
- Modify: `packages/app-shell/src/diagnostics/__tests__` if a colocated diagnostics test exists; otherwise use the existing app-shell diagnostics test location.

- [ ] **Step 1: Write failing diagnostics test**

Add test coverage that a pending maintenance row appears in the debug snapshot:

```ts
expect(snapshot.indexMaintenance).toEqual({
  capability: {
    concurrentIndexSupported: false,
    pgStatProgressCreateIndexReadable: true,
    selectedStrategy: 'regular',
    strategyReason: 'concurrent-index-build-unsupported',
  },
  dimensions: [
    {
      attempts: 0,
      dimension: 384,
      lastError: null,
      lastForegroundProbeP95Ms: null,
      lastInvalidIndexName: null,
      state: 'pending',
      strategy: 'regular',
    },
  ],
  invalidIndexes: [],
  suspendedDimensions: [
    {
      dimension: 384,
      reason: 'embedding-backfill:set-123',
    },
  ],
});
```

- [ ] **Step 2: Run test and confirm red**

Run:

```bash
pnpm --filter @brainstrike/app-shell exec vitest run src/background-indexing/__tests__/workspace-index-debug-harness.test.ts
```

Expected: fail because the snapshot lacks maintenance state.

- [ ] **Step 3: Expose maintenance state in debug harness**

Add bounded queries for:

```sql
SELECT dimension, reason, suspended_at
  FROM embedding_dimension_index_suspensions
 ORDER BY dimension
 LIMIT 20
```

and:

```sql
SELECT dimension,
       state,
       strategy,
       attempts,
       last_error,
       last_invalid_index_name,
       last_foreground_probe_p95_ms,
       last_foreground_probe_max_ms,
       next_run_at,
       started_at,
       completed_at
  FROM embedding_dimension_index_maintenance
 ORDER BY dimension
 LIMIT 20
```

Also expose invalid indexes:

```sql
SELECT c.relname AS index_name,
       i.indisvalid AS is_valid,
       i.indisready AS is_ready
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid
 WHERE c.relname LIKE 'idx_file_chunks_emb_hnsw_%'
   AND (i.indisvalid = false OR i.indisready = false)
 ORDER BY c.relname
 LIMIT 20
```

If the table is absent in old dev profiles before migration, do not hide it silently. The debug harness should report an access issue such as:

```ts
indexMaintenance: {
  accessIssue: 'dimension-index-maintenance-table-missing',
  capability: null,
  dimensions: [],
  invalidIndexes: [],
  suspendedDimensions: [],
}
```

Normal migrated profiles must not hit this path.

- [ ] **Step 4: Show diagnostics in system panel**

Add a compact diagnostics row:

```text
HNSW Maintenance: pending 1 / running 0 / failed 0
```

Show:

- selected strategy and reason,
- whether `CREATE INDEX CONCURRENTLY` is supported,
- whether progress reporting is readable,
- failed dimensions with last error,
- invalid index names,
- whether workspace search is currently exact/sequential because a dimension is suspended.

Avoid calling the workspace index fully optimized when any suspension, invalid index, or pending/running/failed maintenance row exists.

- [ ] **Step 5: Run app-shell tests**

Run:

```bash
pnpm --filter @brainstrike/app-shell exec vitest run src/background-indexing/__tests__/workspace-index-debug-harness.test.ts
pnpm --filter @brainstrike/app-shell run type-check
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/app-shell/src/background-indexing/workspace-index-debug-harness.ts \
  packages/app-shell/src/background-indexing/__tests__/workspace-index-debug-harness.test.ts \
  packages/app-shell/src/diagnostics/system-diagnostics-panel.tsx
git commit -m "Expose HNSW maintenance diagnostics"
```

---

### Task 6: Full Verification Harness And Release Decision

**Files:**
- Create or modify only test/docs files if a reusable manual verification script is needed.
- Prefer no production code changes in this task unless verification exposes a bug.

- [ ] **Step 1: Run focused automated suites**

Run:

```bash
pnpm --filter @brainstrike/db exec vitest run packages/db/__tests__/dimension-index-maintenance.test.ts packages/db/__tests__/scheduled-database-maintenance.test.ts
pnpm --filter @brainstrike/db run test:db:check-lanes
pnpm --filter @brainstrike/db run test:coverage:db:check-lanes
pnpm --filter @brainstrike/desktop exec vitest run src/__tests__/dimension-index-maintenance-capabilities.test.ts src/__tests__/dimension-index-maintenance-scheduler.test.ts src/__tests__/database-maintenance-scheduler.test.ts src/__tests__/main/embedding-backfill.test.ts src/__tests__/main/ipc-handlers-db-embedding-backfill.test.ts
pnpm --filter @brainstrike/app-shell exec vitest run src/background-indexing/__tests__/workspace-index-debug-harness.test.ts
pnpm --filter @brainstrike/db run type-check
pnpm --filter @brainstrike/desktop run type-check
pnpm --filter @brainstrike/app-shell run type-check
```

Expected: all pass.

- [ ] **Step 2: Run full local gates before manual app verification**

Run:

```bash
pnpm lint:ci
pnpm type-check
pnpm build
pnpm test
```

Expected: all pass. Build warnings from existing third-party bundles must be listed in the PR if still present; new warnings introduced by this work are not acceptable.

- [ ] **Step 3: Launch with DevTools**

Run:

```bash
pnpm --filter @brainstrike/desktop dev:agent-debug
```

Attach via Chrome DevTools MCP/CDP to:

- visible renderer
- embedding host renderer
- chunking host renderer
- embedding worker target

- [ ] **Step 4: Verify capability probe and runtime settings**

Before starting the full root run, capture the capability snapshot:

```json
{
  "concurrentIndexBuild": {
    "supported": false,
    "error": "captured error or null",
    "foregroundProbeP95Ms": null
  },
  "hnswIndexBuild": {
    "supported": true,
    "error": null
  },
  "maintenanceSettings": {
    "initialMemoryBytes": 123456789,
    "maintenanceWorkMem": "64MB",
    "maxParallelMaintenanceWorkers": "2",
    "maxParallelWorkers": "8"
  },
  "progressReporting": {
    "pgStatProgressCreateIndexReadable": true,
    "error": null
  },
  "selectedStrategy": {
    "strategy": "regular",
    "reason": "concurrent-index-build-unsupported"
  }
}
```

Rules:

- `hnswIndexBuild.supported` must be `true`.
- `selectedStrategy.strategy` must be either `regular` or `concurrent` and must match the documented reason.
- Unknown `maintenanceWorkMem`, worker settings, or `initialMemoryBytes` are a verification failure unless the capability probe records a specific unsupported-setting error.
- If `concurrentIndexBuild.supported === true` but `foregroundProbeP95Ms === null`, production must select `regular` until the full maintenance health probe proves concurrent responsiveness.
- If `pg_stat_progress_create_index` is unreadable, diagnostics may show coarse progress only; this must be explicit.

- [ ] **Step 5: Verify full embedding completion**

Use the same three-root profile or a fresh profile with the same roots:

- `/Users/seandearnaley/Documents/GitHub/3dmol-react`
- `/Users/seandearnaley/Documents/GitHub/brainstrike`
- `/Users/seandearnaley/Documents/health-wiki`

Required evidence:

```json
{
  "file_count": 17477,
  "chunk_count": 124574,
  "embedded_chunk_count": 124574,
  "pending_chunk_count": 0,
  "queueRows": [{ "state": "succeeded", "count": 124574 }],
  "embeddingRuntime": {
    "selectedDevicePreference": "webgpu",
    "actualWorkerMetadata": {
      "device": "webgpu",
      "dtype": "fp16",
      "fallbackApplied": false
    },
    "backendMismatch": false
  }
}
```

Also capture:

- buffered log scan for `DB host request timed out`
- buffered log scan for `Local embedding execution failed`
- buffered log scan for `WebGPU device lost`
- buffered log scan for warning/error levels
- integrated chunks/sec after excluding warmup and logged QoS pauses
- measured bottleneck chunks/sec used for the `0.70 * bottleneck` acceptance threshold

- [ ] **Step 6: Verify maintenance request after completion**

Immediately after embedding completion, confirm:

```sql
SELECT dimension, state, strategy, attempts, last_error
  FROM embedding_dimension_index_maintenance
 ORDER BY dimension;
```

Expected before idle gate opens:

```text
384 | pending | <selected strategy> | 0 | null
```

and:

```sql
SELECT dimension, reason
  FROM embedding_dimension_index_suspensions
 ORDER BY dimension;
```

Expected:

```text
384 | embedding-backfill:<workspace-index-set-id>
```

- [ ] **Step 7: Force idle conditions only in a controlled debug run**

For development verification only, configure the scheduler with a short idle threshold if the implementation exposes a strict test-only override. Do not ship a silent override. If no override exists, leave the machine idle on AC until Electron reports `idle` or `locked`.

Required: log line showing scheduler gate opened with:

```json
{
  "powerSource": "ac",
  "idleState": "idle",
  "thermalState": "nominal",
  "runningPriority": null,
  "queued": { "foreground": 0, "normal": 0, "background": 0 }
}
```

- [ ] **Step 8: Verify HNSW maintenance execution path**

During maintenance, logs must show:

```text
Dimension index maintenance started
requestKind: maintenance:exec
strategy: <selected strategy>
```

Logs must not show:

```text
requestKind: query
sqlPreview: CREATE INDEX
DB host request timed out: query
```

If selected strategy is `concurrent`, logs must show `CREATE INDEX CONCURRENTLY`. If selected strategy is `regular`, logs must not contain `CREATE INDEX CONCURRENTLY`.

- [ ] **Step 9: Verify progress and invalid-index state during maintenance**

If `pg_stat_progress_create_index` is readable, sample it every second during maintenance:

```sql
SELECT phase,
       blocks_done,
       blocks_total,
       tuples_done,
       tuples_total
  FROM pg_stat_progress_create_index;
```

Expected:

- During a visible build, either rows appear with phase data or the capability snapshot explicitly says PGlite exposes the view but pgvector does not populate access-method-specific progress for this build.
- After maintenance, the view is empty.

Always check invalid indexes after any failed or canceled maintenance attempt:

```sql
SELECT c.relname AS index_name,
       i.indisvalid AS is_valid,
       i.indisready AS is_ready
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid
 WHERE c.relname LIKE 'idx_file_chunks_emb_hnsw_%'
   AND (i.indisvalid = false OR i.indisready = false);
```

Expected after successful maintenance: zero rows.

- [ ] **Step 10: Verify success state**

After maintenance completes:

```sql
SELECT COUNT(*)::int AS count
  FROM pg_indexes
 WHERE indexname = 'idx_file_chunks_emb_hnsw_384';
```

Expected: `1`.

```sql
SELECT COUNT(*)::int AS count
  FROM embedding_dimension_index_suspensions
 WHERE dimension = 384;
```

Expected: `0`.

```sql
SELECT state,
       strategy,
       attempts,
       last_error,
       last_duration_ms,
       last_foreground_probe_p95_ms,
       last_foreground_probe_max_ms,
       last_invalid_index_name
  FROM embedding_dimension_index_maintenance
 WHERE dimension = 384;
```

Expected:

```text
succeeded | <selected strategy> | 1 | null | <positive duration> | <measured or null> | <measured or null> | null
```

- [ ] **Step 11: Measure foreground DB health during maintenance**

While HNSW maintenance is running, issue a lightweight foreground health query every second from the visible renderer:

```sql
SELECT 1;
```

Record p50/p95/max latency. Decision:

- If p95 <= `5s` and no timeout occurs, the PGlite idle lane is release-viable for this data size.
- If p95 > `5s` but no timeout occurs, classify the result as `implementation-correct-but-release-blocked`.
- If any health query times out, classify the result as `implementation-failed`.

- [ ] **Step 12: Verify integrated throughput**

Compute the full-run throughput summary from logs or a verification script:

```json
{
  "warmupExcludedMs": 12345,
  "qosPauseExcludedMs": 6789,
  "measuredBottleneckChunksPerSec": 42.5,
  "steadyStateIntegratedChunksPerSec": 35.1,
  "thresholdChunksPerSec": 29.75,
  "passes": true
}
```

Rules:

- `thresholdChunksPerSec = measuredBottleneckChunksPerSec * 0.70`.
- `steadyStateIntegratedChunksPerSec` must be greater than or equal to `thresholdChunksPerSec`.
- If the measurement script cannot identify warmup or QoS pause intervals, do not guess. Record the missing interval source and classify the result as `implementation-failed`.
- If throughput fails, do not treat a completed embedding run as release-sufficient.

- [ ] **Step 13: Run the separate warning/error pass**

Export the app logs after full embedding and HNSW maintenance finish. Classify every warning/error row:

```json
{
  "introducedByThisWork": [],
  "existingKnown": [
    {
      "message": "exact warning text",
      "owner": "existing-third-party-bundle",
      "evidence": "seen on parent branch before this implementation"
    }
  ],
  "external": []
}
```

Rules:

- `introducedByThisWork` must be empty for `release-sufficient`.
- Any `DB host request timed out`, `Local embedding execution failed`, `WebGPU device lost`, `fallbackApplied:true`, `backendMismatch:true`, invalid HNSW index, stuck running maintenance row, or stuck running embedding job is release-blocking.
- Do not suppress warnings to pass this step. Fix the cause or classify the release as blocked.

- [ ] **Step 14: Measure memory**

Capture `ps` RSS snapshots before maintenance, during maintenance, after maintenance, and 2 minutes after maintenance.

Decision:

- RSS may rise during HNSW build.
- RSS must stabilize or fall after completion.
- Monotonic post-completion growth is release-blocking.

- [ ] **Step 15: Record release decision**

Write the PR summary using one of these exact classifications:

```text
release-sufficient: embedding and HNSW maintenance completed, foreground DB p95 <= 5s, no timeouts, memory plateaued, throughput passed, warning pass clean
implementation-correct-but-release-blocked: embedding completed and HNSW maintenance is durable, but foreground DB p95 > 5s, throughput failed, memory did not plateau, or introduced warnings/errors remain
implementation-failed: embedding or HNSW maintenance produced a timeout, invalid index leak, unbounded memory growth, incomplete queue/suspension drain, hidden backend fallback, or incomplete proof artifact
```

Do not merge or recommend release if the result is `implementation-correct-but-release-blocked` or `implementation-failed`.

- [ ] **Step 16: Commit verification-only docs if created**

If a verification note or script was added:

```bash
git add <verification-doc-or-script>
git commit -m "Document HNSW maintenance verification"
```

If no files were added, do not create a meaningless commit.

---

## If This Does Not Solve Release Risk

The idle maintenance lane is the correct next fix because it makes the current architecture durable and observable. It prevents the known failure class where embedding completion tries to rebuild HNSW inline and collides with DB host query timeouts.

It may not be enough for release because PGlite's single connection makes a started HNSW `CREATE INDEX` effectively non-preemptible from the app's point of view. If foreground DB health fails during the full verification task, do not keep tuning timers. Move to a vector-index architecture change.

Recommended escalation:

1. Keep PGlite as the source of truth for files, chunks, embeddings, and metadata.
2. Build ANN indexes in a separate renderer worker or native sidecar that reads completed embeddings in bounded batches.
3. Persist the ANN artifact outside the PGlite connection.
4. Atomically swap a ready index artifact into the search path.
5. Keep a fallback exact/seq-scan path for correctness, but make degraded search state explicit in diagnostics and UI.
6. Gate release on full-root embedding plus ANN artifact build completing without DB-host timeouts and without foreground DB stalls.

This is larger than the HNSW lane, but it is the correct architecture if PGlite cannot meet responsiveness requirements while building HNSW.

## Self-Review

- Spec coverage: The plan covers the official-docs constraints, PGlite/pgvector capability probing, durable maintenance state, idle scheduling, nonblocking background backfill completion, diagnostics, throughput proof, warning/error classification, full live verification, and an explicit release-risk escalation.
- Placeholder scan: No task uses placeholder language. Every implementation task has concrete file paths, commands, and expected outcomes.
- Type consistency: The plan consistently uses `selectDimensionIndexStrategy`, `probeDimensionIndexRuntimeCapabilities`, `requestDimensionIndexMaintenance`, `reconcileSuspendedDimensionIndexMaintenance`, `runNextDimensionIndexMaintenance`, `createDesktopDimensionIndexMaintenanceScheduler`, and the `embedding_dimension_index_maintenance` table.
- No code implementation has been performed in this branch; this file is the only intended change.
