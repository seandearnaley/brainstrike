# @brainstrike/queue

Core embedding queue primitives used across Brainstrike web and desktop runtimes. Provides a browser-first workerpool adapter plus shared telemetry, typing, and utilities for scheduling embedding tasks.

## Why This Package Exists

- **Unified queue abstraction** – expose a consistent `QueueAdapter` API regardless of runtime (browser workerpool, Electron renderer, server-side fallback).
- **Control semantics** – standardized pause/resume/cancel/drain lifecycle per ADR-0002.
- **Worker-friendly task model** – convert high-level embedding requests into `EmbedWorkerRequest` objects consumed by `@brainstrike/embedding-worker`.
- **Telemetry & instrumentation** – emit enqueue/progress/error events that power the HUD, analytics, and the standalone telemetry collector.

## Features

- `createBrowserEmbeddingQueue()` – wraps `workerpool` with batching, concurrency control, and adapter wiring for module workers.
- Type-safe task/result helpers (`toWorkerRequest`, `QueueAdapter`, `QueueResult`) shared with downstream packages.
- Telemetry utilities (`addQueueTelemetryListener`, `createQueueTelemetryAggregator`) for real-time monitoring.
- `WorkerClient` types for standardized worker lifecycle state.

## Installation

```bash
pnpm --filter @brainstrike/queue install
```

## Usage

```ts
import { createBrowserEmbeddingQueue } from '@brainstrike/queue';

const queue = await createBrowserEmbeddingQueue({
  workerUrl: new URL('@brainstrike/embedding-worker/dist/embedding.worker.js', import.meta.url),
});

const task = await queue.add({
  kind: 'embed',
  id: crypto.randomUUID(),
  model: 'bge-m3',
  texts: ['hello world'],
  truncateDim: 1024,
  deviceHint: 'webgpu',
});

console.log(task.metadata.device, task.vectors[0]);
```

### Telemetry

```ts
import { addQueueTelemetryListener } from '@brainstrike/queue';

const unsubscribe = addQueueTelemetryListener((event) => {
  console.info('queue event', event);
});

// Later
unsubscribe();
```

When running in the browser with `initializeQueueTelemetrySink`, events are batched and POSTed to the `endpoint` supplied in its options.

## Development

- `src/adapters/` – queue implementations (`browser-workerpool`).
- `src/telemetry.ts` – aggregator and listener plumbing.
- `src/types.ts` – shared embedding task primitives.
- Vitest suites in `test/` cover adapters, telemetry, and task conversion.

### Commands

```bash
pnpm --filter @brainstrike/queue test      # run unit tests
pnpm --filter @brainstrike/queue run build # clean + tsc + tsup bundle (esm + cjs)
```

`vitest.config.mts` aliases internal packages (`@brainstrike/embedding-worker`, `@brainstrike/utils`) to source paths so tests run without prebuilding.

## Integration Notes

- Browser queues assume module worker support (`new URL(..., import.meta.url)` pattern). Ensure bundlers keep the worker asset alongside your build output.
- Telemetry is opt-in: set `VITE_QUEUE_TELEMETRY_ENDPOINT` (and optional `VITE_QUEUE_TELEMETRY_API_KEY`) to enable batch uploads.
- In non-browser environments, construct a custom adapter by implementing the `QueueAdapter` interface if neither built-in option fits your runtime.
- Durable queue orchestration lives in `@brainstrike/db` (`JobQueue`); this package focuses on ephemeral workerpool queues.
