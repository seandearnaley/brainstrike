# @brainstrike/embedding-worker

Transformers.js worker implementation that powers the Brainstrike embedding queue across browsers and Electron renderers. It loads Hugging Face models inside a dedicated worker, batches text inputs, and streams progress events with explicit device selection.

## Why This Package Exists

- **Isolate heavy GPU/WASM inference** – keep UI threads responsive while executing embedding workloads.
- **Share logic across platforms** – the same worker bundle runs in web and desktop renderer contexts.
- **Expose deterministic telemetry** – emits progress/error events that the queue uses for HUDs and automated recovery.

## Key Features

- Adaptive batching via `computeInitialBatchSize` tuned for workerpool usage.
- Explicit device enforcement (`webgpu` or `wasm`) with no automatic fallbacks.
- Vector normalization helpers (`l2Normalize`, `truncateVector`, `vectorsFromPipelineOutput`) shared with queue adapters.
- Progress streaming through `workerpool.workerEmit`, covering initialization, embedding progress, and completion states.

## Usage

```ts
import { resolveEmbeddingWorkerUrl } from '@brainstrike/embedding-worker';

const worker = new Worker(resolveEmbeddingWorkerUrl(), { type: 'module' });
// wire the worker into @brainstrike/queue createBrowserEmbeddingQueue or a manual workerpool
```

Queue adapters convert tasks into `EmbedWorkerRequest` objects:

```ts
{
  type: 'embed',
  id: 'job-123',
  model: 'bge-m3',
  texts: ['Hello world'],
  truncateDim: 1024,
  deviceHint: 'webgpu',
  maxBatchSize: 8,
}
```

Results arrive as `EmbedWorkerSuccess` instances containing Float32Array vectors and metadata (device, dtype, elapsed time, dimensions, and fallbackApplied).

## Developing

- `src/embedding.worker.ts` – worker runtime registered via `workerpool`.
- `src/shared.ts` – shared types and numeric helpers exported publicly.
- `test/embedding.worker.runtime.spec.ts` – Vitest coverage for device errors, batch sizing, and error propagation.

### Commands

```bash
pnpm --filter @brainstrike/embedding-worker test      # run Vitest suites
pnpm --filter @brainstrike/embedding-worker run build # clean + tsc + tsup bundle
```

`vitest.config.mts` aliases internal dependencies so tests reference source files directly without building `dist/`.

## Integration Notes

- Depends on `@huggingface/transformers` with remote models enabled for browser deployments (`env.allowRemoteModels`).
- Designed to be loaded through bundlers that respect `new URL('./embedding.worker.js', import.meta.url)` semantics (Vite, Rspack, Webpack 5).
- When running outside browsers (e.g., Node), ensure a compatible worker implementation that supports Web Workers and Transformers.js.
