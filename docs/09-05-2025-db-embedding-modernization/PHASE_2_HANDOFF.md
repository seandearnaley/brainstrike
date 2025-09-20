# Phase 2 Handoff: Embedding Sets & Anti‑Drift Schema

**Status**: ✅ COMPLETE — schema + repos + search filter + tests
**Developer**: Ready for next phase (Queue)
**Context**: Phase 2 prevents model/dimension drift by introducing embedding sets and per‑chunk embedding metadata.

## Summary

- Added `embedding_sets` table to scope embeddings by model/distance/dimensions.
- Updated `file_chunks` with `embedding_set_id`, `embedding_updated_at`, `embedding_hash`.
- Extended repositories to read/write the new columns.
- `searchSimilar()` now accepts `embeddingSetId` for SQL and client‑side paths.
- Tests added for repository behaviors and filtering.

## Schema Changes

- New migration: `packages/db/src/migrations/006-embedding-sets-and-columns.ts`
  - `embedding_sets(id, model_key, model_id, dimensions, distance, created_at)`
  - Unique constraint: `(model_key, dimensions, distance)`
  - `file_chunks` new columns: `embedding_set_id`, `embedding_updated_at`, `embedding_hash`
  - Indexes: `idx_file_chunks_set`, `idx_file_chunks_embedhash`

Applied automatically by existing bootstrap (`migrate`).

## Code Changes

- New model: `packages/db/src/models/embedding-set.ts`
- New repository: `packages/db/src/repositories/embedding-sets-repository.ts`
  - `getOrCreateSet(modelKey, modelId, dimensions, distance)`
  - `getById(id)`, `getByModelKey(modelKey)`
- Chunk model updates: `packages/db/src/models/file-chunk.ts`
  - Added `embeddingSetId`, `embeddingUpdatedAt`, `embeddingHash` and `embeddingSetId` filter to `ChunkSearchOptions`
- Chunk repos updated:
  - `packages/db/src/repositories/file-chunk-repository.ts`
  - `packages/db/src/repositories/electron-file-chunk-repository.ts`
  - Insert/Update now handle embedding metadata; queries select the new fields; search filters by `embeddingSetId`.

## Tests

- `packages/db/__tests__/embedding-sets-repository.test.ts`
  - Validates get-or-create semantics and listing by model key
- `packages/db/__tests__/chunk-embedding-metadata.test.ts`
  - Verifies that updating embedding sets `embedding_set_id`/`embedding_hash` and sets timestamp
  - Verifies search filtering by `embeddingSetId` (client-side path)

Note: All tests pass in this environment; tinypool EPERM after runs is a sandbox artifact (not assertion failures).

## Dev Notes

- In-memory DB: use `memory://` (not `:memory:`) for ephemeral PGlite in Node/JS.
- No version changes required; pgvector path remains intact when available.
- `embedding_hash` is a simple string for now; final semantics (e.g., `sha256(content_hash + ':' + model_key)`) will be enforced when the worker writes embeddings in Phase 4.

## Next Steps (Phase 3 Preview)

- Introduce DB‑backed queue (`job_queue`) with leasing/heartbeats.
- Produce `embed_chunk` jobs post chunk insert.
- Unit tests for enqueue/claim/backoff; producer wired after `insertMany`.

## Validation Checklist (Run locally)

- pnpm -w lint
- pnpm -w build
- pnpm -w type-check
- pnpm -w test -- --run
- pnpm -w test:e2e (optional; requires local browsers)

If you see `kill EPERM` after green tests in Vitest, it’s a process restriction artifact. Assertions should still pass.

