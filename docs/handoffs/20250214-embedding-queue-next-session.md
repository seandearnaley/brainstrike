# Handoff: Embedding Queue Follow-Up (2025-02-14)

## TL;DR
- Queue + embedding worker packages are live (`@brainstrike/queue`, `@brainstrike/embedding-worker`) and everything builds/tests headlessly.
- Renderers (web & desktop) now inject a shared queue via `EmbeddingQueueProvider`; vector-status HUD reads live metrics.
- File-import only enqueues embeddings when a model is resolved, avoiding worker spam, but telemetry/UX polish is still pending.
- This doc is the _only_ context the next agent should need—treat it as the system prompt.

## Current State Snapshot
- ✅ `pnpm build`, `pnpm type-check`, `pnpm test` (including `@brainstrike/file-import`, `@brainstrike/vector-management`, `@brainstrike/queue`, `@brainstrike/embedding-worker`) all pass.
- ✅ Docs updated (`AGENTS.md`, queue plan, migration handoffs) and Codanna indexing is configured under `.codanna/`.
- ✅ Browser & Electron renderers share a singleton queue (`apps/*/src/create-embedding-queue.ts`) and pipe it through `@brainstrike/app-shell`.
- ✅ `TransformersBackend` prefers the worker queue, with warm-up, dtype tracking, and fallback to local pipeline.
- ✅ Telemetry emitter (`emitQueueTelemetry`, sliding window aggregator) exists and Queue HUD no longer polls during tests.
- ⚠️ Queue metrics stream into provider state, but we **haven’t** yet pushed telemetry to a remote sink or surfaced it in import UI.
- ⚠️ Enhanced import tests cover queue dispatch, but full-browser integration (Playwright) is still outstanding.

## Key Decisions & Constraints
1. **Single queue instance per renderer** – `EmbeddingQueueProvider` wraps UI. Don’t instantiate queues ad-hoc; use `registerEmbeddingQueueFactory`.
2. **Queue gating** – Embedding queue runs **only** when `embedding.enabled === true` _and_ a model key is resolved. Otherwise chunking continues and we log a warning.
3. **Telemetry-first** – Each adapter emits `enqueue/complete/error`, including latency + pending counts. Queue HUD and consumers should rely on `useEmbeddingQueue()` metrics to avoid DB polling.
4. **Fallback semantics** – If workers fail or model missing, we drop to `p-queue` or skip enqueue. Never crash import flows.
5. **Headless-only** – No `pnpm dev`; all verification via build/test commands.

## Outstanding Integration Points
| Area | Gap | Notes |
|------|-----|-------|
| Telemetry sink | Structured events exist locally but aren’t forwarded to an external logger/metrics backend. | Decide on target (Datadog/log stream) and wire listener. |
| Queue HUD UX | HUD shows counts but lacks throughput/latency display from telemetry aggregator. | Hook `metrics.throughputPerMinute` & latency stats into the panel. |
| Import UI feedback | Enhanced import checklist doesn’t surface per-file queue progress/errors. | Consider dispatching `brainstrike:queue-progress` events or updating import modal. |
| Integration tests | Only unit-level coverage today. Playwright scenario for end-to-end import + queue is still TODO. | Add once UI wiring is done. |
| Docs | AGENTS.md mentions queue, but developer onboarding for telemetry sink still pending. | Update after sink selection. |

## Action Plan for Next Session
1. **Telemetry sink (priority)**  
   - Pick logger (Datadog, Logflare, etc.).  
   - Add listener via `addQueueTelemetryListener` that batches events & ships JSON.  
   - Confirm sink works during `pnpm --filter @brainstrike/queue test` (wrap behind guard to avoid noisy logs).
2. **HUD Updates**  
   - Surface throughput/latency/error counts in `VectorStatusWithDb` + Queue HUD using `metrics` from provider.  
   - Ensure unit tests cover new labels, keeping `NODE_ENV=test` polling disabled.
3. **Import UI Enhancements**  
   - Decide how to surface embedding progress (toast? inline?).  
   - Follow queue metrics from provider or event emitter; avoid re-querying DB.  
   - Add Vitest coverage once wiring is in place.
4. **Docs & Clean-Up**  
   - Update `AGENTS.md` + new doc(s) once telemetry sink is live.  
   - Review TODOs in new packages (queue/embedding-worker) for follow-up tasks.

## Verification Checklist (Headless Only)
```bash
# Build & type-check
pnpm build
pnpm type-check

# Critical test suites
pnpm --filter @brainstrike/queue test
pnpm --filter @brainstrike/embedding-worker test
pnpm --filter @brainstrike/embeddings test
pnpm --filter @brainstrike/file-import test
pnpm --filter @brainstrike/vector-management test

# Optional targeted lint
pnpm biome check packages/queue/src packages/file-import/src packages/vector-management/src
```

## Quick Reference
- Queue provider: `packages/vector-management/src/embedding-queue-provider.tsx`
- Renderer queue entry points: `apps/*/src/create-embedding-queue.ts`
- File import queue bridge: `packages/file-import/src/browser-queue-port.ts`
- Telemetry aggregator: `packages/queue/src/telemetry.ts`
- Transformers backend integration: `packages/embeddings/src/transformers-backend.ts`
- Current plan docs: `docs/embedding-queue-plan-2025-10-13.md`, `docs/handoffs/20251013-153615-embedding-queue-migration.md`

## Prompt for Next Agent / Contractor
> You’re picking up the Brainstrike embedding queue migration. Telemetry is local-only; we need a remote sink plus basic UI polish. Read `docs/embedding-queue-plan-2025-10-13.md` and this handoff. Stay headless (no `pnpm dev`). Follow the Action Plan above, update docs afterwards, and record any follow-ups. Use queue provider hooks instead of instantiating new queues. Keep tests green.

Good luck!
