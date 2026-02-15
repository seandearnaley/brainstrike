---
title: "20250214 Embedding Queue Next Session"
status: "cold-archive"
date: "2025-02-14"
superseded_by: "none"
---

# Handoff: Embedding Queue Follow-Up (2025-02-14)

## TL;DR
- Queue + embedding worker packages are live (`@brainstrike/queue`, `@brainstrike/embedding-worker`) and everything builds/tests headlessly.
- Renderers (web & desktop) now inject a shared queue via `EmbeddingQueueProvider`; vector-status HUD consumes live metrics (throughput, latency, error window).
- Remote telemetry sink is wired via `initializeQueueTelemetrySink`—set `VITE_QUEUE_TELEMETRY_ENDPOINT` (+ optional API key) to ship batched queue events.
- Import progress modal now listens for `brainstrike:queue-progress` events to surface queue pending/processed/failure counts inline.
- Local CLI/HTTP collector (`@brainstrike/queue-telemetry-collector`) receives queue batches and ships them to downstream stores.
- Vector management Vitest suite runs in full again after refactoring telemetry-heavy specs and restoring the default `vitest run` script.
- Vector status card now shows throughput/latency/error sparklines to highlight short-term trends, and settings E2E coverage asserts telemetry surfaces.
- This doc is the _only_ context the next agent should need—treat it as the system prompt.

## Current State Snapshot
- ✅ `pnpm build`, `pnpm type-check`, `pnpm test` (including `@brainstrike/file-import`, `@brainstrike/vector-management`, `@brainstrike/queue`, `@brainstrike/embedding-worker`) all pass.
- ✅ Docs updated (`AGENTS.md`, queue plan, migration handoffs).
- ✅ Browser & Electron renderers share a singleton queue (`apps/*/src/create-embedding-queue.ts`) and pipe it through `@brainstrike/app-shell`.
- ✅ `TransformersBackend` prefers the worker queue, with warm-up, dtype tracking, and fallback to local pipeline.
- ✅ Telemetry sink now initializes in web/desktop entry points; batched events post to `VITE_QUEUE_TELEMETRY_ENDPOINT` (API key optional) and remain silent while `NODE_ENV=test`.
- ✅ Vector HUD pulls throughput/latency/error window metrics from telemetry snapshots; import modal renders queue progress via `brainstrike:queue-progress` events.
- ⚠️ Local collector exists (`@brainstrike/queue-telemetry-collector`); production deployment, retention, and alerting still need to be designed.
- ⚠️ Import/UI telemetry still lacks end-to-end validation for queue churn—new telemetry Playwright smoke exists, but import completion scenarios remain TODO.

## Key Decisions & Constraints
1. **Single queue instance per renderer** – `EmbeddingQueueProvider` wraps UI. Don’t instantiate queues ad-hoc; use `registerEmbeddingQueueFactory`.
2. **Queue gating** – Embedding queue runs **only** when `embedding.enabled === true` _and_ a model key is resolved. Otherwise chunking continues and we log a warning.
3. **Telemetry-first** – Each adapter emits `enqueue/complete/error`, including latency + pending counts. Queue HUD and consumers should rely on `useEmbeddingQueue()` metrics to avoid DB polling.
4. **Fallback semantics** – If workers fail or model missing, we drop to `p-queue` or skip enqueue. Never crash import flows.
5. **Headless-only** – No `pnpm dev`; all verification via build/test commands.

## Outstanding Integration Points
| Area | Gap | Notes |
|------|-----|-------|
| Collector deployment | Local CLI collector runs, but no production endpoint/alerting/retention decisions yet. | Pick hosting target (Datadog, ClickHouse, serverless), wire secrets, and capture ops runbook. |
| Telemetry enrichment | Trendlines live in UI only; aggregated snapshots aren’t shipped upstream. | Emit periodic summaries (throughput/latency/error) or teach collector to aggregate for dashboards. |
| Import UI feedback | Modal shows queue totals, but per-file progress/errors aren’t surfaced outside the modal. | Bridge `brainstrike:queue-progress` into file list/toasts or emit per-file updates. |
| Playwright coverage | Telemetry smoke test exists; no end-to-end import/queue churn scenarios yet. | Mock queue telemetry + import flows to validate HUD/import updates. |
| Docs | Need deployment/operations guidance for the collector and dashboards. | Expand onboarding and runbooks once deployment decisions land. |

## Action Plan for Next Session
1. **Collector deployment**  
   - Choose hosting (Datadog HTTP intake, ClickHouse, serverless) for `@brainstrike/queue-telemetry-collector`.  
   - Wire secrets + env plumbing (`QUEUE_TELEMETRY_*`, `VITE_QUEUE_TELEMETRY_*`) and document retention/alerting.  
   - Stand up smoke tests against the deployed endpoint to prove batching/retry behaviour.
2. **Telemetry enrichment**  
   - Emit periodic aggregated snapshots from the renderer or collector (throughput/latency/error) for downstream dashboards.  
   - Evaluate adding sanitized import metadata so ops can slice per embedding set/file.
3. **Import UI follow-ups**  
   - Surface per-file queue progress (file list badges or toast updates) using `brainstrike:queue-progress`.  
   - Bubble last error details outside the modal so long imports surface failures promptly.
4. **Testing & docs**  
   - Expand Playwright coverage to simulate queue churn/import completion with mocked telemetry.  
   - Update onboarding/docs with deployment + dashboard instructions once collector work lands.

## Verification Checklist (Headless Only)
```bash
# Build & type-check
pnpm build
pnpm type-check

# Critical test suites
pnpm --filter @brainstrike/queue-telemetry-collector test
pnpm --filter @brainstrike/queue test
pnpm --filter @brainstrike/embedding-worker test
pnpm --filter @brainstrike/embeddings test
pnpm --filter @brainstrike/file-import test
pnpm --filter @brainstrike/vector-management test

# E2E smoke
pnpm --filter @brainstrike/web test:e2e -- --project=functional --grep "Embedding Worker Telemetry"

# Optional targeted lint
pnpm biome check packages/queue/src packages/file-import/src packages/vector-management/src
```

## Quick Reference
- Queue provider: `packages/vector-management/src/embedding-queue-provider.tsx`
- Renderer queue entry points: `apps/*/src/create-embedding-queue.ts`
- File import queue bridge: `packages/file-import/src/browser-queue-port.ts`
- Telemetry aggregator: `packages/queue/src/telemetry.ts`
- Remote telemetry sink + batching: `packages/queue/src/remote-telemetry-sink.ts`
- Collector CLI/server: `packages/queue-telemetry-collector/src`
- Renderer wiring for sink: `apps/web/src/main.tsx`, `apps/desktop/src/renderer/main.tsx`
- Transformers backend integration: `packages/embeddings/src/transformers-backend.ts`
- Import progress modal: `packages/db-explorer/src/components/import-progress-display.tsx`
- Queue progress listener: `packages/db-explorer/src/enhanced-file-import-service.ts`
- Current plan docs: `docs/embedding-queue-plan-2025-10-13.md`, `docs/handoffs/20251013-153615-embedding-queue-migration.md`

## Prompt for Next Agent / Contractor
> Telemetry sink, collector CLI, and HUD trendlines are in place. Deploy the collector, ship aggregated telemetry snapshots, polish import feedback, and deepen E2E coverage with simulated queue churn. Read `docs/embedding-queue-plan-2025-10-13.md` and this handoff. Stay headless (no `pnpm dev`). Follow the Action Plan above, update docs afterwards, and record any follow-ups. Use queue provider hooks instead of instantiating new queues. Keep tests green.

Good luck!
