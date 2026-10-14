# @brainstrike/embedding-worker

Transformers.js inference in managed Web Workers, shared by browser and desktop
hidden-renderer owners. This is the low-level local embedding runtime; it neither
owns the canonical catalog/index nor processes durable database jobs.

## Placement and assets

Local inference runs only in renderer workers. Electron main has no opt-in
exception. Use [the inference contract](../../docs/agents/local-inference.md)
for admitted model/device identity and physical retirement.

Vite consumers import `resolveViteEmbeddingWorkerUrlHref` and
`resolveViteOnnxWasmPaths` from `@brainstrike/embedding-worker/vite`. This source-only
entry needs Vite's worker transformation and the existing
`transformersOnnxRuntimeWasmUrlsPlugin` from `@brainstrike/build-utils` in the
consuming app's Vite config. It emits the installed ONNX Runtime module/binary
assets and carries their absolute URLs to the worker. It is not a Node entry or
an implicit CDN/runtime-file fallback.

Use the managed queue integration in [the queue guide](../queue/README.md).
A raw `new Worker` does not supply the workerpool protocol, managed instance
identity or required lifetime telemetry. Web runtime composition is implemented in
[`create-embedding-queue.ts`](../../apps/web/src/create-embedding-queue.ts).

## Requests and results

Request/result types are owned by `@brainstrike/indexing-contract`, re-exported
through [`shared.ts`](src/shared.ts). Preserve model, optional revision, explicit
device, dtype, pooling, request identity and expected dimensions. Local workers
consume no provider credentials. Hosted providers belong to the embeddings
provider boundary.

The worker reports progress, vector batches, completion and typed failures.
Validate cardinality and finite dimensions before committing results; a progress
message is not a publication acknowledgement. Do not use old abbreviated request
examples as a substitute for the current admitted execution plan.

Cancellation retains its exact owner until physical work or joined retirement
settles. Genuine GPU device loss retires the worker rather than replaying the
request or selecting another backend. Healthy model switches reuse the device.
A failed cleanup cannot release a replacement generation's resources.

## Development

[`package.json`](package.json) owns exports/builds and opt-in probes.
`pnpm test` runs the unit project; `pnpm test:browser` runs the deterministic
browser suite. `pnpm test:webgpu-memory` is a separate hardware probe.
`pnpm build` emits the declared worker bundle and types; the Vite source entry
still belongs to the consuming renderer build.

**CI is disabled due to cost; validation must run locally.** Select checks with
[validation guidance](../../docs/agents/ci-quality.md).
