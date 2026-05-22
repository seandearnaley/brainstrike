# BST-368 Pipeline Cache Diagnostics Plan

## Scope

Expose observable pipeline cache telemetry from `packages/embedding-worker` without changing runtime ownership or moving local embedding execution out of the renderer worker.

## Current Validation

- `packages/embedding-worker/src/embedding.worker.ts` already tracks `createdAt`, `lastUsedAt`, `model`, `device`, and cache size in the private `pipelines` map.
- Cache hits, cache loads, resident-limit eviction, idle eviction, and device-loss invalidation are currently not emitted as structured diagnostics.
- Exact per-model heap or GPU bytes are not available from the browser worker runtime. The implementation must report that explicitly instead of guessing.

## Implementation

1. Add a typed `diagnostic` worker stream event for pipeline cache telemetry.
2. Emit diagnostics for cache hits, cache additions, load failures, disposals, idle eviction, resident-limit eviction, and WebGPU device-loss invalidation.
3. Include cache size, per-entry model/device/dtype/timestamps, event reason, and explicit memory measurement availability.
4. Forward diagnostics through `StreamingEmbeddingWorkerClient` with an `onDiagnostic` callback.
5. Cover behavior with red-green unit tests in `packages/embedding-worker`.

## Verification

- Targeted red-green Vitest for embedding-worker pipeline cache/eviction/client tests.
- Package type-check/build.
- Root `pnpm lint && pnpm type-check && pnpm build && pnpm test` before proof.
