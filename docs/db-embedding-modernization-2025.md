# DB + Embeddings Modernization Plan

*Phased, checklist-driven, with clear cut-offs, outputs, and validation gates.*

> **Goal:** make the DB the source of truth, add a **local-first queue**, harden chunking/import, and support multiple embedding models **without** foot-guns (dimension drift, pgvector availability, etc.).

---

## Legend

* [ ] \= task; \[ ]◻ = subtask; \[ ]🧪 = test; \[ ]👤 = manual smoke
* **Outputs** → concrete artifacts (files, types, migrations, configs)
* **Gate** → what must pass before merging / moving on

---

## Phase 0 — Safety net & correctness hardening (small, high impact) ✅ COMPLETED

**What we're fixing now**

* Robust vector parsing on reads
* Capability probe (pgvector on/off)
* Batch inserts & basic constraints

### Tasks

* [x] Add **loose vector parser** for TEXT/pgvector/JSON forms

  * [x]◻ New helper `packages/db/src/repositories/_shared.ts` → `parseEmbeddingLoose(emb): number[]|undefined`
  * [x]◻ Use in `file-chunk-repository.ts` and `electron-file-chunk-repository.ts`
* [x] Expose **vector capability** in `DbProvider`

  * [x]◻ On init, probe: `SELECT 1 FROM pg_extension WHERE extname='vector'`
  * [x]◻ Put `vectorEnabled` on context; export a `useVectorEnabled()` hook
* [x] **Cast on SELECT** where needed

  * [x]◻ When reading embeddings, `SELECT ..., embedding::text AS embedding` (pgvector path)
* [x] **Batch insertMany** to avoid parameter blow-ups

  * [x]◻ Split `VALUES` into chunks (e.g., 250 rows/batch) with one transaction
* [x] Add **uniqueness guard**

  * [x]◻ Migration: `UNIQUE(file_record_id, chunk_index)` on `file_chunks` via migration 005-safe-indices.ts
  * [x]◻ **BONUS**: Added idempotent insertion with `ON CONFLICT DO UPDATE` to handle duplicates gracefully
  * [ ]◻ Consider `UNIQUE(file_record_id, content_hash)` if content-hash stable per chunk (deferred)

### Outputs

* `packages/db/src/repositories/_shared.ts` (new)
* Migration `005_safe_indices.ts` (or folded into Phase 2 migration if you prefer one pass)

### Validation

* [x]🧪 Unit: parser handles `"[...]"`, `"(…)"`, `"0.1,0.2"`, array; bad input → `undefined`
* [x]🧪 Unit: repository maps parsed vectors correctly
* [x]🧪 Unit: batched insertMany respects limits, same results as single call
* [x]🧪 Unit: idempotent insertion handles duplicates gracefully
* [x]🧪 Lint & build

  * [x]◻ `pnpm -w lint`
  * [x]◻ `pnpm -w build --filter=@brainstrike/db`
* [x]🧪 Unit & component tests (Vitest)

  * [x]◻ **169 tests passing** with real PGlite instances (no mocking)
* [x]👤 Smoke: Desktop and web apps both working, duplicate handling tested in production

**— Gate 0: ✅ COMPLETED - Phase 0 fully implemented and production-tested.**

> **🎯 Next Developer**: See [`PHASE_0_HANDOFF.md`](./PHASE_0_HANDOFF.md) for complete implementation details and Phase 1 preparation.

### Phase 0 Implementation Summary

**What was built:**
- ✅ **Robust embedding parser**: Handles 5+ input formats with comprehensive error handling
- ✅ **Batched operations**: 250-row chunks with proper transaction management  
- ✅ **Vector capability detection**: Runtime pgvector availability with React hook
- ✅ **Database compatibility**: Casting queries work with/without pgvector extension
- ✅ **Production safety**: Idempotent operations prevent duplicate key errors
- ✅ **Test infrastructure**: Real PGlite instances replace complex mocking

**Critical files modified:**
- `packages/db/src/repositories/_shared.ts` (new)
- `packages/db/src/repositories/file-chunk-repository.ts` 
- `packages/db/src/repositories/electron-file-chunk-repository.ts`
- `packages/db/src/db-provider.tsx`
- `packages/db/src/migrations/005-safe-indices.ts` (new)
- `packages/db/vitest.setup.ts` (simplified)
- `packages/db/__tests__/shared-helpers.test.ts` (new)
- `packages/db/__tests__/batch-insert.test.ts` (new)
- `packages/db/__tests__/idempotent-insert.test.ts` (new)

---

## Phase 1 — Similarity search that doesn't break (vector or not) ✅ COMPLETED

**What we're fixing now**

* `searchSimilar` works with **pgvector** *and* **no-vector** fallback (client-side cosine)

### Tasks

* [x] Update `searchSimilar` to **try SQL** path when `vectorEnabled`

  * [x]◻ Use `embedding <=> $query` with **cosine index** (when available)
  * [x]◻ Ensure `ORDER BY embedding <=> $query` + `threshold` semantics match cosine
* [x] Add **client-side fallback**

  * [x]◻ SELECT candidate rows (cast `embedding::text`), parse, compute cosine in JS, rank & threshold
  * [x]◻ Validate **dimensions match**; skip mismatches
* [x] Normalize similarity contract

  * [x]◻ Always return `{ chunk, similarity ∈ [0,1], rank }` (cosine)
  * [x]◻ Document `options: { limit, threshold, fileRecordId, chunkType }`

### Outputs

* `packages/db/src/repositories/_shared.ts` - Added `computeCosineSimilarity()` and `cosineToSearchSimilarity()`
* `packages/db/src/repositories/file-chunk-repository.ts` - Enhanced with dual-path searchSimilar
* `packages/db/src/repositories/electron-file-chunk-repository.ts` - Mirror implementation
* `packages/db/src/db-provider.tsx` - Updated to pass `vectorEnabled` flag to repositories
* `packages/db/__tests__/shared-helpers.test.ts` - Added comprehensive similarity function tests
* `packages/db/__tests__/search-similar.test.ts` - New comprehensive dual-path search tests

### Validation

* [x]🧪 Unit: SQL path returns sorted & thresholded results via searchSimilarPgVector method
* [x]🧪 Unit: Fallback path returns same ordering (within tolerance) via searchSimilarClientSide method
* [x]🧪 Unit: Dimension mismatch is handled gracefully - skips mismatched embeddings
* [x]🧪 Unit: Comprehensive cosine similarity tests with edge cases
* [x]🧪 Unit: Multi-format embedding parsing with client-side computation
* [x]🧪 Unit: Threshold and limit validation in both SQL and client-side paths
* [x]🧪 Build & TypeScript validation passes

### Phase 1 Implementation Summary

**What was built:**
- ✅ **Dual-path search**: `searchSimilar()` branches on `vectorEnabled` flag between SQL and client-side computation
- ✅ **SQL path**: Uses `embedding <=> $query` with proper cosine similarity when pgvector available
- ✅ **Client-side fallback**: Parses embeddings with `parseEmbeddingLoose()`, computes cosine similarity in JavaScript
- ✅ **Robust similarity computation**: Handles edge cases (NaN, infinite, dimension mismatches, zero vectors)
- ✅ **Consistent API**: Both paths return `{ chunk, similarity ∈ [0,1], rank }` format
- ✅ **Comprehensive testing**: 25+ test cases covering both paths, similarity functions, and edge cases
- ✅ **Production safety**: Graceful handling of unparseable embeddings and dimension mismatches

**Critical behavior changes:**
- Constructor signature: `new FileChunkRepository(db, vectorEnabled)` now takes vectorEnabled flag
- Similarity range: Now properly normalized to [0,1] where 1 = identical, 0 = opposite
- Error handling: Invalid embeddings are skipped rather than causing failures
- Performance: SQL path preferred when available, client-side as robust fallback

**— Gate 1: ✅ COMPLETED - search returns consistent results with/without vectors; comprehensive test coverage.**

---

## Phase 2 — **Embedding Sets** & anti-drift schema

**What we’re adding**

* Separate **embedding sets** (model\_key, dimensions, distance) to prevent schema drift and enable multi-model
* Add per-chunk `embedding_set_id` + `embedding_hash` (idempotency)

### Tasks

* [x] Migration **006\_embedding\_sets\_and\_columns.ts**

  * [x]◻ `embedding_sets(id, model_key, model_id, dimensions, distance, created_at)` + `UNIQUE(model_key, dimensions, distance)`
  * [x]◻ `file_chunks`: add `embedding_set_id` (nullable FK), `embedding_updated_at`, `embedding_hash`
  * [x]◻ Indexes: `idx_file_chunks_set`, `idx_file_chunks_embedhash`
* [x] `packages/db/src/repositories/embedding-sets-repository.ts` (new)

  * [x]◻ `getOrCreateSet(modelKey, modelId, dimensions, distance): set`
  * [x]◻ `getById(id)` / `getByModelKey(modelKey)`
* [x] Update **write paths** to set:

  * [x]◻ `embedding_set_id`
  * [x]◻ `embedding_hash` (future: `sha256(content_hash + ':' + model_key)`)
* [x] Update **search API** to accept `embeddingSetId` (optional)

  * \[ ]◻ Prefer set-scoped search; default to active set if none provided

### Outputs

* Migration file with SQL (matching existing style: TS object with `up/down`)
* New repository module + unit tests
* Updated types in `packages/embeddings/src/types.ts` (if needed): include `dimensions`, `distance` in `ModelConfig`

### Validation

* [x]🧪 Migration up/down on clean DB (via bootstrap) for PGlite
* [x]🧪 Unit: `getOrCreateSet` returns stable IDs, unique across model/dimension/distance
* [x]🧪 Unit: `searchSimilar` honors `embeddingSetId` filtering (client-side path validated)
* [ ]🧪 Unit: `embedding_hash` change semantics (will be fully covered in Phase 4 when worker writes embeddings)
* \[ ]👤 Smoke: import → chunk → (temp) inline embed once (Phase 3 not merged yet) → sets populated

**— Gate 2: schema stable, sets created and referenced; all tests pass.**

---

## Phase 3 — **DB-backed queue** (local-first, resilient)

**What we’re adding**

* A **job\_queue** table, leasing, retries, backoff, dedupe
* Producer on chunk completion (enqueue `embed_chunk` jobs)

### Tasks

* [ ] Migration **007\_job\_queue.ts**

  * \[ ]◻ `job_queue(id, queue, job_type, payload JSONB, state, run_at, attempts, max_attempts, backoff_ms, lease_token, leased_until, worker_id, dedupe_key, error, created_at, updated_at)`
  * \[ ]◻ Unique partial index on `dedupe_key`
  * \[ ]◻ Pick indexes: `(queue, state, run_at)`, `(state, leased_until)`
* [ ] `packages/db/src/queue/job-queue.ts` (new, DB-agnostic)

  * \[ ]◻ `enqueue({queue, job_type, payload, dedupe_key, run_at?})`
  * \[ ]◻ `claim({queue, leaseMs}): Job | null` (atomic UPDATE … RETURNING)
  * \[ ]◻ `heartbeat(id, lease_token, extendMs)`
  * \[ ]◻ `complete(id, lease_token)` / `fail(id, lease_token, error)` with backoff
  * \[ ]◻ `retryPolicy(attempts)` (exp backoff, jitter)
* [ ] Wire **producer**:

  * \[ ]◻ In `packages/file-import/src/chunking.ts` AFTER `insertMany`, enqueue for each chunk (or per file micro-batch)
  * \[ ]◻ `dedupe_key = chunk_id + ':' + embedding_set_id + ':' + content_hash`

### Outputs

* Migration 007, job queue module, thin producers in import pipeline
* Feature flag: `EMBED_QUEUE_ENABLED=true` (disable falls back to current inline path)

### Validation

* \[ ]🧪 Unit: enqueue/claim/lease/complete/fail/backoff
* \[ ]🧪 Unit: dedupe honored
* \[ ]🧪 Unit: producer enqueues N jobs for N chunks (assert by query)
* \[ ]🧪 Concurrency test: two claimers never get same job
* \[ ]👤 Smoke: run import → see jobs appear; no worker yet, just queue depth increments

**— Gate 3: queue schema and semantics correct under tests; producers stable.**

---

## Phase 4 — **Local-first worker** (Electron/Web Worker)

**What we’re adding**

* A worker that claims jobs, initializes embeddings once, processes with leases & heartbeats, writes results idempotently.

### Tasks

* [ ] Worker module `packages/embeddings/src/worker/embedding-worker.ts`

  * \[ ]◻ `startEmbeddingWorker({concurrency, leaseMs})`
  * \[ ]◻ On boot: resolve **active embedding set** and init transformer backend (WebGPU/CPU)
  * \[ ]◻ Loop: claim → process `embed_chunk` → heartbeat every 10s → complete/fail
  * \[ ]◻ On processing:

    * \[ ]◻ Load chunk by `chunk_id`
    * \[ ]◻ Recompute `embedding_hash` → if matches row & `embedding` present → **no-op**
    * \[ ]◻ Generate embedding; write `embedding` + `embedding_updated_at`
* [ ] Wire in **Electron main** (desktop) and **web worker** (web)

  * \[ ]◻ Desktop: start worker on app ready; stop on quit
  * \[ ]◻ Web: feature-flagged (off by default), start on user action
* [ ] Error handling

  * \[ ]◻ Model init failure → exponential retry with cap
  * \[ ]◻ GPU unavailable → auto-fallback to CPU
  * \[ ]◻ Catch transient errors; do **fail → backoff**; poison-pill after `max_attempts`

### Outputs

* Worker module + bootstrap hooks in apps
* Config: `EMBED_CONCURRENCY`, `EMBED_LEASE_MS`, `EMBED_MODEL_KEY`

### Validation

* \[ ]🧪 Unit: idempotency (same job twice → one write)
* \[ ]🧪 Worker integration: N jobs → all completed; attempts/backoff observed on forced failures
* \[ ]🧪 Performance sanity: embed 100 short chunks under CPU and WebGPU paths
* \[ ]🧪 E2E: import → embeddings populated → `searchSimilar` returns sensible results
* \[ ]👤 Smoke: run desktop, import a medium folder (code & md), watch queue drain; search UI feels instant

**— Gate 4: end-to-end import→queue→embed→search works; perf acceptable.**

---

## Phase 5 — Chunking upgrades (content-aware & streaming)

**What we’re improving**

* Better chunk quality, less memory, fewer edge cases

### Tasks

* [ ] **Markdown splitter** pre-pass (headings, lists, code fences) → then recursive
* [ ] **Code-aware boundaries**: reinforce current separators (functions/classes/imports/blocks)
* [ ] **Streaming chunk production** (generator) to avoid huge arrays
* [ ] Expand **skip rules**: `node_modules`, `dist`, `build`, `coverage`, `*.min.js`, `*.map`, binaries (`\0` in first N KB), `.gitignore` patterns
* [ ] Optional: **token-true sizing** for chosen model (simple tokenizer or heuristic upgrade)

### Outputs

* `ChunkingService` refinements; config bumps in `CHUNKING_CONFIG`
* Doc: rules & examples in `docs/test-suite-modernization-2025.md` (appendix)

### Validation

* \[ ]🧪 Unit: chunk counts & avg tokens within bands for fixtures
* \[ ]🧪 Memory: streaming keeps peak memory < X for 5 MB file (measure)
* \[ ]🧪 E2E: end user flow unchanged, overall chunks not exploding
* \[ ]👤 Smoke: import a mixed repo; spot-check chunk boundaries (functions/sections)

**— Gate 5: chunk quality up; memory down; tests green.**

---

## Phase 6 — UI/API integration & developer affordances

**What we’re adding**

* UI surfaces for embedding sets & queue visibility; clean API shapes

### Tasks

* [ ] **Expose active embedding set** & device in UI (both apps)

  * \[ ]◻ Selector: model key → shows `dimensions`, `distance`, device (WebGPU/CPU)
* [ ] **Queue HUD**: pending / running / failed counts; retry button for last 20 failed
* [ ] API contracts documented:

  * \[ ]◻ `ChunkSearchOptions` + result shape
  * \[ ]◻ `EmbeddingSet` DTO shape
  * \[ ]◻ `Job` DTO shape (redacted payload)

### Outputs

* UI components (badges, toasts, settings page additions)
* `README` and `docs/review-response.md` update for new flows

### Validation

* \[ ]🧪 UI tests for selectors & HUD
* \[ ]👤 Smoke: user flows — pick model, import, see queue drain, search works

**— Gate 6: UX clear; devs can debug with HUD quickly.**

---

## Phase 7 — Performance & observability pass

**What we’re adding**

* Metrics & knobs for sustained use

### Tasks

* [ ] Lightweight **metrics** counters (log or simple in-app): queue depth, job latency, embedding/sec
* [ ] **Playwright perf** scenario: import medium project → TTI for search
* [ ] **Stryker** (mutation) on utils-heavy packages (already configured in some pkgs)
* [ ] **Turbo** task graph updates to cache tests/builds where safe

### Outputs

* Perf script(s): `scripts/performance-benchmark.sh` hooks queue/worker
* Docs: troubleshooting & perf tuning checklist

### Validation

* \[ ]🧪 Bench: CPU vs WebGPU numbers recorded; regression budget set
* \[ ]🧪 Mutation score stays above agreed threshold (or documented gaps)

**— Gate 7: perf budgets met; basic telemetry available.**

---

## Output Formats (contracts devs can rely on)

### 1) `ChunkSearchResult` (unchanged, documented)

```ts
type ChunkSearchResult = {
  chunk: {
    id: string;
    fileRecordId: string;
    chunkIndex: number;
    content: string;
    contentHash: string;
    tokenCount: number;
    chunkType: 'text' | 'code' | 'sentence' | 'recursive';
    chunkSize: number;
    embedding?: number[]; // may be omitted in vector-enabled fast path
    createdAt: string;
    updatedAt: string;
  };
  similarity: number; // 0..1 cosine
  rank: number;       // 1..N
};
```

### 2) `EmbeddingSet`

```ts
type EmbeddingSet = {
  id: string;
  modelKey: string;   // registry key
  modelId: string;    // HF or provider id
  dimensions: number;
  distance: 'cosine' | 'l2' | 'ip';
  createdAt: string;
};
```

### 3) `Job` (public shape)

```ts
type Job = {
  id: string;
  queue: 'embeddings';
  jobType: 'embed_chunk';
  state: 'queued'|'running'|'succeeded'|'failed'|'canceled'|'expired';
  runAt: string;
  attempts: number;
  maxAttempts: number;
  leasedUntil?: string;
  workerId?: string;
  // payload is internal; expose only minimal data in UI
};
```

---

## Validation Checkpoints (repeat each Gate)

* \[ ]🧪 **Repo-wide checks**

  * \[ ]◻ `pnpm -w lint`
  * \[ ]◻ `pnpm -w typecheck` *(add if missing)*
  * \[ ]◻ `pnpm -w build`
  * \[ ]◻ `pnpm -w test -- --run`
* \[ ]🧪 **E2E**

  * \[ ]◻ Web: `pnpm --filter ./apps/web test:e2e` *(or project script)*
  * \[ ]◻ Desktop: `pnpm --filter ./apps/desktop test:e2e`
* \[ ]👤 **User smoke** (5 minutes)

  * \[ ]◻ Import small folder (mix code/md)
  * \[ ]◻ See chunks count > 0; if queue enabled, see jobs drain
  * \[ ]◻ Run a search; verify top result sanity
  * \[ ]◻ Toggle `DISABLE_VECTOR_EXTENSION=true`; repeat (fallback still works)

> *Note:* adjust filter names/commands if your package names differ. Keep these **as checklists in MRs**.

---

## Good Cut-offs (merge boundaries)

* **Gate 0:** Parser + capability + batching + indices (no behavior changes yet)
* **Gate 1:** Resilient search (users can’t break it anymore)
* **Gate 2:** Embedding sets in schema (ready for multi-model)
* **Gate 3:** Queue in place, producers enqueuing (no worker yet)
* **Gate 4:** Worker live; E2E pipeline complete
* **Gate 5:** Better chunking; quality/memory stable
* **Gate 6/7:** UX & perf polish

---

## Developer Pointers (keep the chain moving)

* **Branching:** `feat/embeds-phase-0`, `feat/embeds-phase-1`, … one MR per Gate.
* **MR Template:** include this plan’s section, checked items, and **Gate** results.
* **Config flags:**

  * `EMBED_QUEUE_ENABLED` (default false until Phase 4)
  * `EMBED_MODEL_KEY` (defaults to registry default)
  * `DISABLE_VECTOR_EXTENSION` (already present for tests)
* **Test data:** add 3 small fixtures (md, ts, json) under `packages/db/__fixtures__`.
* **Rollbacks:** each phase is additive; migrations have `down` defined; if worker misbehaves, flip `EMBED_QUEUE_ENABLED=false` and ship fallback.
* **Docs:** append deltas to `docs/review-response.md` and `docs/test-suite-modernization-2025.md`.

---

## Known Risks & Mitigations

* **Model dimension drift** → *EmbeddingSets* w/ per-set scoping (Phase 2).
* **Worker stalls** → leases + heartbeat + backoff + retries (Phase 4).
* **Vector ext missing** → client-side cosine fallback (Phase 1).
* **Param limits** → batched insertMany (Phase 0).
* **Chunk explosion** → improved rules + streaming (Phase 5).
