# Embedding Worker Runtime

## Ownership

Owns renderer-only embedding queue processing. The worker lifecycle module starts and stops queue polling, coordinates leases, loads chunks, writes vectors, and delegates focused responsibilities to worker-local modules.

Current owned modules:
- `embedding-worker.ts` - lifecycle and queue processing composition.
- `embedding-cache-types.ts` - cache contract types for embedding dedupe.
- `embedding-model-config.ts` - database-backed model metadata lookup and cache.
- `embedding-stats-refresh-controller.ts` - collection indexing stats refresh scheduling.
- `embedding-cache-maintenance.ts` - cooperative cache eviction/maintenance after queue drains.

## Public surface

Use `@brainstrike/embeddings/worker` or the root `@brainstrike/embeddings` exports for application code. Existing compatibility re-exports from `embedding-worker.ts` are preserved while the monolith is split.

## Allowed dependencies

Allowed inward dependencies are db queue/repository APIs, queue provider metadata, embedding provider factories, shared embedding types, and shared utilities. This runtime must remain renderer-safe. Do not move local embedding execution into Electron main or Node-only runtime paths.

## Focused local test

```bash
pnpm --filter @brainstrike/embeddings exec vitest run src/__tests__/embedding-worker-architecture.test.ts src/__tests__/embedding-worker-batch.test.ts -t "stats refresh|embedding worker architecture"
```
