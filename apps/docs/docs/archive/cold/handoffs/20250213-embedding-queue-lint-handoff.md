---
title: "20250213 Embedding Queue Lint Handoff"
status: "cold-archive"
date: "2025-02-13"
superseded_by: "none"
---

# Handoff: Embedding Queue Telemetry & Lint Fixes (2025-02-13)

## Why This Exists
We paused mid-lint pass while tightening the embedding queue pipeline. The repo is currently **dirty** (see summary). This doc is the authoritative prompt for the next agent—assume *no memory* of previous context besides what you read here plus repo state. We cannot “just checkout origin/main”; you must work with what is on disk, report or repair accordingly.

## Current State Snapshot
- Recent work:
  - Unified queue task/result metadata (dimensions, dtype) and telemetry emitters.
  - `TransformersBackend` now has device-aware dtype selection, queue warm-up, and a worker retry path.
  - `EmbeddingQueueProvider` exposes throughput/latency via queue telemetry and avoids worker initialization under Node/jsdom.
  - Vector-management tests now run sequentially (per-file) to avoid Node 22 heap OOM.
- Outstanding issues:
  - `packages/queue/src/adapters/browser-pqueue.ts` was partially rewritten and left in an inconsistent state (Queue tests currently fail because the function export is broken).
  - `packages/file-import/src/browser-queue-port.ts` refactor was started to address Biome complexity; logic must be verified to ensure behaviour matches original.
  - Lint complexity warnings remain (Biome reported them for queue port + adapters before we stopped).
- Tests:
  - `pnpm --filter @brainstrike/queue test` fails (“createPQueueAdapter is not a function”).
  - `pnpm --filter @brainstrike/vector-management test` passes via the sequential script.
  - `pnpm --filter @brainstrike/embeddings test` passes.
- `git status` shows multiple modified files across packages (queue, embeddings, vector-management, file-import, docs).

## Key Decisions & Context
1. **Telemetry-first approach**: We emit structured queue events so HUDs/services can subscribe (`addQueueTelemetryListener`, sliding-window aggregator). Adapters must emit enqueue/complete/error consistently.
2. **Device-aware dtype & warm-up**: Browser queue prefers `fp16` on WebGPU and quantized dtype on WASM; we added a warm-up request post-initialization for responsiveness.
3. **Avoid heap bump**: Instead of raising Node heap, vector-management tests now run serially to keep telemetry behaviour intact while avoiding OOM.
4. **Work-from-what-you-have**: There’s no pristine upstream snapshot inside this repo copy; fixes must be derived from the current files or by inspecting documentation/tests.

## Immediate To-Do (next agent)
1. **Repair queue adapters**
   - Inspect current `packages/queue/src/adapters/browser-pqueue.ts` and `browser-workerpool.ts`; restore missing exports and ensure telemetry logic is correct.
   - Run `pnpm --filter @brainstrike/queue test` after each small fix to confirm behaviour.
2. **Finalize browser queue port refactor**
   - Verify `packages/file-import/src/browser-queue-port.ts` still enqueues correctly (check warnings/logics we split out).
   - Ensure Biome complexity check passes without altering runtime flow.
3. **Rerun lint/tests**
   - `pnpm biome check packages/file-import/src/browser-queue-port.ts packages/queue/src/adapters/browser-pqueue.ts packages/queue/src/adapters/browser-workerpool.ts`
   - `pnpm --filter @brainstrike/queue test`
   - `pnpm --filter @brainstrike/vector-management test`
4. **Report/clean repo state**
   - Document any functionality you cannot restore.
   - Remove stray `dist/` or `node_modules/` from version control if accidentally added.

## Suggested Commands
```bash
# Queue adapter repair loop
pnpm --filter @brainstrike/queue test

# Lint focused files
pnpm biome check packages/queue/src/adapters/browser-pqueue.ts \
                 packages/queue/src/adapters/browser-workerpool.ts \
                 packages/file-import/src/browser-queue-port.ts

# Vector-management regression
pnpm --filter @brainstrike/vector-management test
```

## Reminder
Treat this document as the truth. Since the current source is our starting point, preserve telemetry/dtype improvements while fixing lint/test regressions. Document unresolved issues before ending your session. Good luck!
