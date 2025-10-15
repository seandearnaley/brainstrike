# Handoff: Embedding Queue Follow-Up (2025-02-14)

## TL;DR
- Queue + embedding worker packages are live (`@brainstrike/queue`, `@brainstrike/embedding-worker`) and everything builds/tests headlessly.
- Renderers (web & desktop) now inject a shared queue via `EmbeddingQueueProvider`; vector-status HUD consumes live metrics (throughput, latency, error window).
- Remote telemetry sink is wired via `initializeQueueTelemetrySink`—set `VITE_QUEUE_TELEMETRY_ENDPOINT` (+ optional API key) to ship batched queue events.
- Import progress modal now listens for `brainstrike:queue-progress` events to surface queue pending/processed/failure counts inline.
- This doc is the _only_ context the next agent should need—treat it as the system prompt.

## Current State Snapshot
- ✅ `pnpm build`, `pnpm type-check`, `pnpm test` (including `@brainstrike/file-import`, `@brainstrike/vector-management`, `@brainstrike/queue`, `@brainstrike/embedding-worker`) all pass.
- ✅ Docs updated (`AGENTS.md`, queue plan, migration handoffs) and Codanna indexing is configured under `.codanna/`.
- ✅ Browser & Electron renderers share a singleton queue (`apps/*/src/create-embedding-queue.ts`) and pipe it through `@brainstrike/app-shell`.
- ✅ `TransformersBackend` prefers the worker queue, with warm-up, dtype tracking, and fallback to local pipeline.
- ✅ Telemetry sink now initializes in web/desktop entry points; batched events post to `VITE_QUEUE_TELEMETRY_ENDPOINT` (API key optional) and remain silent while `NODE_ENV=test`.
- ✅ Vector HUD pulls throughput/latency/error window metrics from telemetry snapshots; import modal renders queue progress via `brainstrike:queue-progress` events.
- ⚠️ Remote collector still TBD—decide on backend target (Datadog/log stream/etc.), secrets wiring, and retention before flipping the endpoint live.
- ⚠️ Enhanced import tests cover queue dispatch/unit flows; full-browser integration (Playwright) remains outstanding once UI wiring stabilizes.

## Key Decisions & Constraints
1. **Single queue instance per renderer** – `EmbeddingQueueProvider` wraps UI. Don’t instantiate queues ad-hoc; use `registerEmbeddingQueueFactory`.
2. **Queue gating** – Embedding queue runs **only** when `embedding.enabled === true` _and_ a model key is resolved. Otherwise chunking continues and we log a warning.
3. **Telemetry-first** – Each adapter emits `enqueue/complete/error`, including latency + pending counts. Queue HUD and consumers should rely on `useEmbeddingQueue()` metrics to avoid DB polling.
4. **Fallback semantics** – If workers fail or model missing, we drop to `p-queue` or skip enqueue. Never crash import flows.
5. **Headless-only** – No `pnpm dev`; all verification via build/test commands.

## Outstanding Integration Points
| Area | Gap | Notes |
|------|-----|-------|
| Telemetry collector | Remote sink posts JSON, but no production endpoint or secrets wiring yet. | Stand up ingestion target (Datadog/log stream/serverless), store API key securely, and document payload contract. |
| HUD analytics | Throughput/latency/error window render in HUD; still need trend aggregation + remote dashboards. | Once collector exists, pipe snapshots to observability and consider sparklines/averages in UI. |
| Import UI feedback | Modal shows queue totals, but per-file progress/errors aren’t surfaced outside the modal. | Bridge `brainstrike:queue-progress` into file list/toasts or emit per-file updates. |
| Integration tests | Only unit-level coverage today. Playwright scenario for end-to-end import + queue is still TODO. | Add once UI wiring is done; listen for `brainstrike:queue-progress` to assert completion. |
| Docs | Need onboarding for telemetry env vars and collector rollout. | Update runbooks after endpoint + alerting decisions. |

## Action Plan for Next Session
1. **Telemetry collector rollout**  
   - Pick the remote ingestion target (Datadog stream, Logflare, serverless worker).  
   - Define auth/secret plumbing (`VITE_QUEUE_TELEMETRY_API_KEY` or IPC bridge) and capture sample payloads for ops.  
   - Add smoke tests to verify retries/backpressure once endpoint exists.
2. **HUD analytics polish**  
   - Layer simple trend indicators/sparklines on the Vector HUD using rolling telemetry snapshots.  
   - Pipe the same metrics to the new collector so dashboards can chart throughput/latency/error windows.
3. **Import UI follow-ups**  
   - Surface per-file queue progress (file list badges or toast updates) using `brainstrike:queue-progress`.  
   - Bubble last error details outside the modal so long imports surface failures promptly.
4. **Testing & docs**  
   - Add Playwright coverage for import -> queue -> completion (listen for queue events).  
   - Update onboarding/docs once collector + UI polish ship; record config steps in this handoff.

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
- Remote telemetry sink + batching: `packages/queue/src/remote-telemetry-sink.ts`
- Renderer wiring for sink: `apps/web/src/main.tsx`, `apps/desktop/src/renderer/main.tsx`
- Transformers backend integration: `packages/embeddings/src/transformers-backend.ts`
- Import progress modal: `packages/db-explorer/src/components/import-progress-display.tsx`
- Queue progress listener: `packages/db-explorer/src/enhanced-file-import-service.ts`
- Current plan docs: `docs/embedding-queue-plan-2025-10-13.md`, `docs/handoffs/20251013-153615-embedding-queue-migration.md`

## Prompt for Next Agent / Contractor
> Telemetry sink now emits batched queue events; your turn is to stand up the remote collector, wire polished HUD/import UX, and land the missing integration tests. Read `docs/embedding-queue-plan-2025-10-13.md` and this handoff. Stay headless (no `pnpm dev`). Follow the Action Plan above, update docs afterwards, and record any follow-ups. Use queue provider hooks instead of instantiating new queues. Keep tests green.

Good luck!
