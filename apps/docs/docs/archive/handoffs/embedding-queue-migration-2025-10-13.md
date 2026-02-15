---
title: "Embedding Queue Migration 2025 10 13"
---

# Handoff: Embedding Queue Migration (2025-10-13)

## TL;DR
We replaced the PG-backed embedding queue with a browser/Electron-friendly worker queue (`@brainstrike/queue`) and partially migrated the renderer surfaces to the new provider. This doc summarises current state, key decisions, and next steps so the next agent can continue without re-deriving context.

## What’s Done
- **Queue primitives**: `@brainstrike/queue` provides workerpool + `p-queue` adapters, with CJS/ESM entry points aligned for web/desktop bundlers.
- **Embedding worker**: `@brainstrike/embedding-worker` hosts the Transformers.js pipeline (batching, normalization, device fallback). Exported as ESM-only (browser workers) with build warnings resolved.
- **Transformers backend**: `TransformersBackend` now prefers the browser queue, with registration helpers (`registerEmbeddingQueueFactory`, `resetEmbeddingQueueFactory`) to inject renderer-owned queue instances.
- **Renderer wiring**: `EmbeddingQueueProvider` + `useEmbeddingQueue` live in `@brainstrike/vector-management`. Vector Status now wraps itself in the provider, uses queue metrics for counts/errors, and falls back to a noop adapter when the queue is disabled.
- **Docs**: `docs/embedding-queue-plan-2025-10-13.md` is the live roadmap; the new provider milestone is checked off.
- **Build/Test baseline**: `pnpm build` passes; unit suites for queue/embedding/vector-management succeed.
- **File import hand-off**: Enhanced import flows now accept an injected browser queue, default to the JobQueue in Node contexts, and dispatch `brainstrike:queue-drained` when renderer-side batches settle.
- **Telemetry stub**: Workerpool and p-queue adapters log enqueue depth, active counts, and latency to the shared logger so downstream sinks can start scraping metrics.
- **Integration harness**: Added a Vitest integration (`packages/vector-management/src/__tests__/embedding-queue.integration.test.tsx`) that exercises queue metrics end-to-end inside the renderer provider.
- **Telemetry emitter**: `@brainstrike/queue` now exposes `addQueueTelemetryListener` and a sliding-window aggregator for structured metrics so downstream sinks can subscribe directly instead of parsing logs.

## Key Decisions & Considerations
- **Queue ownership**: Renderers create at most one queue via the provider; embeddings backend uses the registered factory instead of instantiating its own queue each call. Avoid multiple worker pools per tab.
- **No DB refactor (yet)**: Import flows still rely on `JobQueue` for transactional consistency. We only offload CPU-heavy work to the browser queue.
- **Fallback semantics**: Provider tracks active/completed/failed counts via instrumentation. Failures are deduped by job id; progress maps are pruned when a job completes/fails.
- **Testing strategy**: Provider is mocked in vector-management tests via `setup-mock-queue.tsx` to keep unit suites isolated.

## Remaining Work (from plan)
1. **Telemetry sinks**: Wire the new adapter logs into structured metrics (Datadog/Logflare) and decide on retention/aggregation so Queue HUD can show rates instead of raw counters.
2. **Renderer verification**: Flesh out the skipped queue integration spec (and eventual Playwright flow) to assert that enhanced imports surface progress and resolve embeddings as jobs drain.
3. **Docs**: Update `AGENTS.md`, onboarding docs, and package READMEs with queue injection guidance once the UI polish lands.
4. **UX polish**: Decide how/where to surface the richer queue telemetry (QueueHud vs. dedicated panel) and whether to expose per-file progress maps/errors in the import panel.

## Immediate To-Do for Next Session
1. **Promote telemetry**
   - Hook the telemetry emitter into the chosen sink (Datadog/log stream) and map fields (`adapter`, `event`, `elapsedMs`, `pending`).
   - Feed the sliding-window aggregator output into Queue HUD once the sink produces rollups (avoid double-counting with provider metrics).

2. **Integration coverage**
   - Convert the skipped Vitest placeholder into a real integration when the renderer queue flow solidifies.
   - Follow-up with a Playwright scenario once browser import surfaces queue progress in the UI.

3. **Documentation**
   - Draft queue injection notes for `AGENTS.md` and `packages/app-shell` README.
   - Capture follow-on steps for instrumentation consumption once telemetry sink is defined.

## References
- `docs/embedding-queue-plan-2025-10-13.md` — authoritative checklist.
- `packages/vector-management/src/embedding-queue-provider.tsx` — provider + instrumentation.
- `packages/embeddings/src/transformers-backend.ts` — queue factory registration and fallback logic.
- `packages/file-import/src/enhanced-import.ts` — next integration target (currently uses DB `JobQueue`).
- `packages/vector-management/src/vector-status.tsx` — sample usage of provider with fallback adapter.

## How to Resume
1. Pull latest (`pnpm install` already up-to-date).
2. Run baseline tests: `pnpm --filter @brainstrike/vector-management test`, `pnpm --filter @brainstrike/embeddings test`.
3. Follow the “Immediate To-Do” list above, updating the plan doc as milestones are reached.
4. Keep an eye on `pnpm build` after each major step.

Good luck! EOF
