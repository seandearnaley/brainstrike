---
title: "Queue Coverage Followup 2025 10 15"
---

# Handoff — Coverage Remediation & Telemetry Collector Hardening (2025-10-15)

## Snapshot
- `@brainstrike/queue-telemetry-collector` now has a local CLI/HTTP collector, refactored request pipeline, and Vitest/BIOME coverage. Build succeeds (`pnpm --filter @brainstrike/queue-telemetry-collector run build`).
- Vector HUD gained telemetry trendlines sourced from `useVectorQueueState`, and the Vite aliases were updated so app-shell tests resolve agent and preference modules without dist builds.
- File-system tests were hardened to comply with `exactOptionalPropertyTypes` and strict index-signature access.
- CI currently blocks on coverage gates for three packages:
  - `@brainstrike/embedding-worker`: **L19.81 F88.89 B73.33 S19.81** (target ≥ **L70 F60 B60 S70**)
  - `@brainstrike/embeddings`: **L23.79 F44.05 B58.89 S23.79** (target ≥ **L24 F50 B60 S24**)
  - `@brainstrike/queue-telemetry-collector`: **L54.23 F83.87 B41.38 S54.23** (target ≥ **L70 F60 B60 S70**)
- Follow previous summaries in `docs/handoffs/20250214-embedding-queue-handoff-summary.md` and the migration plan `docs/embedding-queue-plan-2025-10-13.md` for architectural context.

## Key Decisions & Notes
1. **Strict TypeScript compliance** — all new queue telemetry code avoids optional chains/`!`. Future tests must respect `exactOptionalPropertyTypes`.
2. **Alias-first testing** — prefer Vitest `resolve.alias` to point at source (`../agent/src/client.ts`, `../preferences/src/index.ts`) so tests never depend on `dist/`.
3. **Telemetry batching contract** — collector expects JSON `{ runtime, sentAt, events[], metadata }` and enforces strict validation; reuse helpers (`decodePayloadBuffer`, `extractRuntime`, etc.) when expanding logic.
4. **Playwright coverage** — `apps/web/e2e/embedding-worker-telemetry.test.ts` asserts HUD telemetry surfaces. Extend instead of duplicating.
5. **CI baseline** — `pnpm check` runs lint/build/test plus coverage thresholds. Any new scripts must not require `pnpm dev` or electron e2e (desktop e2e is still manual/offline).

## Outstanding Work (Next Agent)

### 1. Lift Coverage for `@brainstrike/queue-telemetry-collector`
- Add unit tests around:
  - Validation helpers (`resolveRequestPath`, `validateMethod`, `validateApiKey`, `decodePayloadBuffer`, etc.).
  - Error scenarios (invalid runtime, malformed events, unauthorized key).
  - `isRunning()/nextBatch()` behaviour with empty queue.
- Consider splitting the collector into smaller pure functions for easier testing (current helpers are already exposed). Target line coverage ≥70% and branch ≥60%.

### 2. Backfill `@brainstrike/embedding-worker` Tests
- Focus on hot paths in `src/worker.ts` & `src/pipeline/*`. Current coverage misses:
  - Model resolution and WASM/WebGPU fallback logic.
  - Error propagation and retry/backoff behaviour.
  - Message routing between main thread and worker (mock worker context or use `vitest-worker` utilities).
- Keep tests deterministic; prefer mocking transformers I/O via the provided stubs in `packages/embedding-worker/test-utils`.

### 3. Improve `@brainstrike/embeddings` Coverage
- Target CLI (`src/cli/embed-code.ts`) and `TransformersBackend` device resolution logic.
- Add integration-style tests that invoke `createEmbeddingQueue` with mocked adapters (ensure worker preference + fallback).
- Reuse existing mocks from `packages/vector-management` where possible to avoid drift.

### 4. Re-run Quality Gates
- After adding tests, run:
  ```bash
  pnpm --filter @brainstrike/queue-telemetry-collector test
  pnpm --filter @brainstrike/embedding-worker test
  pnpm --filter @brainstrike/embeddings test
  pnpm check
  ```
- Keep Playwright tests headless only. Skip `test:e2e:desktop` unless running locally with Electron.

## Suggested Prompt for Next Agent
> You are continuing queue telemetry + embeddings coverage work. Read `docs/embedding-queue-plan-2025-10-13.md`, `docs/handoffs/20250214-embedding-queue-handoff-summary.md`, and this handoff. Goal: raise coverage above thresholds for `@brainstrike/queue-telemetry-collector`, `@brainstrike/embedding-worker`, and `@brainstrike/embeddings` (see exact gaps above). Add focused unit/integration tests without loosening thresholds. Re-run `pnpm check` and ensure all packages build. Stay headless (no `pnpm dev`), respect strict TypeScript + BIOME rules, and keep electron e2e optional. Document new tests or findings before finishing. 

Good luck!
