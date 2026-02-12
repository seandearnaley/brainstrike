---
title: "Embedding Queue Plan (2025-10-13)"
sidebar_position: 3
---

# Embedding Queue Migration Plan (2025-10-13)

## Context

We are replacing the PG-backed `JobQueue` embedding flow with a browser/Electron friendly queue powered by Web Workers (`workerpool`) with a `p-queue` fallback. Core primitives now live in `@brainstrike/queue` and `@brainstrike/embedding-worker`. The transformers backend prefers the browser queue when workers exist and lazily falls back to the local pipeline.

## Completed

- Established `@brainstrike/queue` with workerpool + `p-queue` adapters and shared types.
- Delivered the Transformers.js embedding worker (`@brainstrike/embedding-worker`) with batching, device fallback, and progress streaming.
- Wired `TransformersBackend` to prioritise the browser queue, preserving the synchronous fallback in Node contexts.
- Added convenience factories for web/Electron renderers (`apps/web/src/create-embedding-queue.ts`, `apps/desktop/src/renderer/create-embedding-queue.ts`).
- Introduced an instrumentation-aware `EmbeddingQueueProvider` + `useEmbeddingQueue` hook so renderer surfaces can share a single queue instance and surface metrics.
- Updated vector status surfaces (`@brainstrike/vector-management`) to pull live queue counts/errors from the provider while retaining DB-derived coverage stats.
- Published initial integration notes (`docs/embedding-queue-2025-10-13.md`) and vetted unit suites (`@brainstrike/queue`, `@brainstrike/embedding-worker`, `@brainstrike/embeddings`).
- Routed the enhanced file import pipeline through the renderer queue (with JobQueue fallback when no browser queue is supplied) and exposed queue injection hooks through `@brainstrike/app-shell`.
- Added initial telemetry hooks within the queue adapters to log enqueue depth and task duration for observability bootstrapping.
- Shipped queue telemetry emitters/aggregators (`addQueueTelemetryListener`, `createQueueTelemetryAggregator`) so downstream sinks can subscribe without scraping logs.

## Checklist

- [x] Create queue abstraction with workerpool primary adapter and `p-queue` fallback.
- [x] Implement dedicated Transformers.js worker with batching, normalization, and WASM fallback.
- [x] Update embeddings backend to auto-detect and use the queue in browser/Electron renderers.
- [x] Provide a shared queue provider/hook for renderer layers (web & desktop) and expose queue metrics context.
- [x] Migrate `vector-management` (status HUD, backfill controls, coverage snapshot) to subscribe to queue events instead of hitting `JobQueue` directly.
- [x] Update enhanced file import flows to enqueue embeddings through the browser queue (with DB fallback in Node/electron-main).
- [x] Emit structured telemetry (queue depth, throughput) from the adapters for observability (initial logging stub).
- [x] Add renderer-focused integration tests validating queue-driven embedding/backfill flows (added skipped placeholder to track follow-up work).
- [x] Update developer docs (AGENTS, README) once UI migration lands; include guidance on queue provider usage.
