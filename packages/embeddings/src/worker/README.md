# Embedding Worker Runtime

## Ownership

Owns renderer-only embedding queue processing. The worker lifecycle module starts and stops queue polling, enforces one in-flight claim budget across every runtime loop, coordinates leases, loads chunks, writes vectors, and delegates focused responsibilities to worker-local modules.

Current owned modules:
- `embedding-worker.ts` - lifecycle and queue processing composition.
- `embedding-cache-types.ts` - cache contract types for embedding dedupe.
- `embedding-model-config.ts` - database-backed model metadata lookup and cache.
- `embedding-provider-runtime.ts` - model resolution, runtime gating, hosted-provider setup, dimension validation, and rate-limit errors.
- `embedding-worker-cache-io.ts` - embedding cache lookup, miss filtering, write scheduling, and result reconstruction.
- `embedding-worker-chunk-filter.ts` - chunk loading, orphan/stale-source handling, and up-to-date filtering for claimed jobs.
- `embedding-worker-db-io.ts` - file chunk loading, vector-column assertions, embedding writes, and embedding-set dimension lookup.
- `embedding-worker-failures.ts` - worker failure classification and job-processing error ownership.
- `embedding-worker-job-payload.ts` - embed job payload validation, including the required
  producer-owned `embeddingInputHash` and `sourceContentHash`, and model-key resolution.
- `embedding-worker-scheduler.ts` - claim-size and idle-backoff scheduling helpers.
- `embedding-stats-refresh-controller.ts` - collection indexing stats refresh scheduling.
- `embedding-cache-maintenance.ts` - cooperative cache eviction/maintenance after queue drains.

## Public surface

Use `@brainstrike/embeddings/worker` or the root `@brainstrike/embeddings` exports for application code. Existing compatibility re-exports from `embedding-worker.ts` are preserved while the monolith is split.

## Allowed dependencies

Allowed inward dependencies are db queue/repository APIs, queue provider metadata, embedding provider factories, shared embedding types, and shared utilities. This runtime must remain renderer-safe. Do not move local embedding execution into Electron main or Node-only runtime paths.

The indexing pipeline owns model-qualified input hashing before durable enqueue. The worker validates
and carries that payload value, and rejects a claimed job when its persisted `sourceContentHash` no
longer matches the loaded chunk. A compute-on-claim compatibility path would put CPU work back on the
hot path and is not allowed.

## Focused local test

```bash
pnpm --filter @brainstrike/embeddings exec vitest run src/__tests__/embedding-worker-architecture.test.ts src/__tests__/embedding-worker-batch.test.ts -t "stats refresh|embedding worker architecture"
```
