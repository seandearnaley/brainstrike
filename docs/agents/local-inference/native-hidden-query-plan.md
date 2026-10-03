# Native hidden query plan transport

Native query inference retains an explicit verified plan through the visible
preload, main IPC, hidden renderer cache selection, scalar queue projection and
actual worker completion. Unpinned legacy query requests keep their catalog and
hydrated preference behavior. The native path uses the explicit model identity
and target dimensions without reading or changing that catalog.

## Local reproduction, 2026-10-03

The initial desktop RED run had 16 failures and 30 passes: the shared payload
projection discarded the plan, and the hidden service used the legacy model
lookup/initialization. Seven scalar backend mismatch controls failed with ten
existing passes. The real built-app probe then exposed two additional transport
failures that mocks of the hidden renderer did not cover:

- The actual visible preload independently projected legacy fields. A WASM q8
  pinned request produced unpinned WebGPU fp16 vectors; telemetry contained
  `Xenova/all-MiniLM-L6-v2|webgpu|fp16` without a revision. The failed status proof
  is `/tmp/brainstrike-native-plan-real-query-observation.log`.
- After preserving the preload plan, the queue DTO/projection still dropped
  revision. The actual completion reported WASM q8, 384 dimensions and the correct
  model, but omitted revision. Strict completion validation rejected it. Expected
  and actual metadata are in
  `/tmp/brainstrike-native-plan-completion-observation.log`.

Paired preload RED had two failures/41 passes; queue projection RED had two
failures/35 passes. The fixes preserve every pin rather than accepting either
observed degradation. One intermediate queue build failed on new test fixtures
missing required id/model/text fields; those fixtures were corrected without
weakening production validation.

## Focused qualification

Run from the repository root after `pnpm install --frozen-lockfile --ignore-scripts`:

- `pnpm exec turbo run build --filter '@brainstrike/desktop^...'`: 54 tasks passed.
- `pnpm exec turbo run build --filter '@brainstrike/embeddings...'`: 15 tasks passed
  after the fixture correction.
- `pnpm --filter @brainstrike/desktop build`: actual renderer and main build passed;
  later source changes rebuilt the affected renderer/main entry.
- `pnpm --filter @brainstrike/desktop exec vitest run src/__tests__/embedding-host-shared.test.ts src/__tests__/embedding-host-manager.test.ts src/__tests__/embedding-host-manager-cancellation.test.ts src/__tests__/preload-sandbox-imports.test.ts src/__tests__/preload-contract-bridges.test.ts src/__tests__/renderer/components/embedding-host-runtime.test.tsx src/__tests__/renderer/components/embedding-host-foreground-ownership.test.tsx src/__tests__/renderer/components/embedding-host-physical-stop-ownership.test.tsx src/__tests__/renderer/components/embedding-host-reinitialization-readiness.test.tsx src/__tests__/renderer/components/embedding-host-query-listener.test.ts`: 180 tests/10 files passed.
- `pnpm --filter @brainstrike/embeddings exec vitest run src/__tests__/inference-plan.test.ts src/__tests__/transformers-backend.queue.test.ts src/__tests__/service-lifecycle.test.ts src/worker/__tests__/foreground-drain-ownership.test.ts src/__tests__/simple-service.test.ts`: 46 tests/5 files passed.
- `pnpm --filter @brainstrike/queue exec vitest run src/__tests__/types.test.ts src/__tests__/browser.test.ts src/__tests__/queue-adapter-semantics.test.ts`: 64 tests/3 files passed.
- `pnpm --filter @brainstrike/desktop type-check`: main, 641 selected tests, E2E
  and strict Effect diagnostics (647 files, zero diagnostics) passed.
- `pnpm --filter @brainstrike/embeddings type-check`: production/test TypeScript
  and strict Effect diagnostics (96 files, zero diagnostics) passed.
- `pnpm --filter @brainstrike/queue type-check`: passed.

The opt-in proof launches a fresh `test-built` Electron 44.4.5 profile and calls
`window.embeddingHost.queryEmbedding` from the visible preload. Inference runs in
the real hidden renderer's production worker, never Electron main. Each profile
executes two identical queries, verifies finite nonzero 384-dimensional vectors,
matching actual device/dtype/no fallback and zero repeated-vector difference.
An unsupported `main` revision and an omitted revision must reject with a
revision-specific error. The existing 60-second public request deadline remains.

- `pnpm exec node apps/desktop/scripts/probe-pinned-query-embedding.mjs`: Xenova
  immutable revision `751bff37182d3f1213fa05d7196b954e230abad9`, WASM q8 and fp32.
- `PINNED_QUERY_PROBE_DEVICE=webgpu pnpm exec node apps/desktop/scripts/probe-pinned-query-embedding.mjs`:
  fused MiniLM immutable revision `aff7a1dc4e8a1ea593e6ea21e95c22ef0a25966f`,
  WebGPU fp16.

This proof is local Mac query transport/worker qualification. It does not measure
M2 throughput or foreground latency under the historical corpus, qualify
packaged Windows/Linux inference, implement a document backfill/vector selection
surface, or establish production vector-write/search acceptance. Those remain
composition work and platform/performance qualification. Hosted CI stays off.
