# @brainstrike/queue

Ephemeral workerpool queue primitives, task/result contracts and telemetry.
Durable PGlite `JobQueue` records belong to `@brainstrike/db`; desktop native
indexing and the host catalog have separate owners.

## Renderer integration

The browser factory is exported from `@brainstrike/queue/browser`, not the root.
It returns a `QueueAdapter` synchronously and loads its workerpool adapter lazily.
Web Workers, an explicit `worker.workerUrl` string and the renderer-owned telemetry
sink are required; missing capabilities refuse instead of selecting a Node adapter.

```ts
import { embeddingWorkerTelemetrySink } from '@brainstrike/embedding-worker';
import { resolveViteEmbeddingWorkerUrlHref } from '@brainstrike/embedding-worker/vite';
import { createBrowserEmbeddingQueue } from '@brainstrike/queue/browser';

const queue = createBrowserEmbeddingQueue({
  worker: {
    workerUrl: resolveViteEmbeddingWorkerUrlHref(),
    telemetry: embeddingWorkerTelemetrySink,
  },
});
```

The Vite app must install the existing ONNX WASM asset plugin described in the
[worker guide](../embedding-worker/README.md). Reuse the app's owned queue instead
of constructing another one at each call. The web composition root in
[`create-embedding-queue.ts`](../../apps/web/src/create-embedding-queue.ts) also
registers the queue and streaming worker URL with the embeddings runtime.

The `QueueAdapter` and task shapes live in [`types.ts`](src/types.ts); worker
options live in [`browser-workerpool-options.ts`](src/browser-workerpool-options.ts).
A request carries its admitted model/device/profile; construction does not choose
a different backend after a failure. Pause, resume, cancel, drain and dispose
have different lifetime effects. Cancellation is complete only when the existing
physical worker owner has joined its work or retirement.

## Telemetry

Root exports include local listeners/aggregation and
`initializeQueueTelemetrySink`. Remote reporting is an explicit sink with an
endpoint supplied by its caller; naming an environment variable alone does not
wire it into an app. Keep runtime telemetry source-scoped and separate from
canonical progress/publication facts. A transport report does not establish
that work stopped or vectors committed.

## Development

[`package.json`](package.json) owns exports and scripts. Use `pnpm build`,
`pnpm type-check` and `pnpm test` from this package. Local consumers declare
`"@brainstrike/queue": "workspace:*"`.
**CI is disabled due to cost; validation must run locally.** See
[validation guidance](../../docs/agents/ci-quality.md).
