# @brainstrike/embeddings

Provider adapters, catalog-qualified inference plans, worker orchestration and
vector validation. Desktop local inference runs in hidden renderer hosts; web
uses its browser worker runtime. Electron main coordinates capabilities and
lifetime, never local inference. See the
[local inference contract](../../docs/agents/local-inference.md).

## Use the right boundary

[`package.json`](package.json) owns the export map:

| Subpath | Responsibility |
| --- | --- |
| `/inference-plan` | Validate catalog-qualified execution identity |
| `/provider-core` | Provider/model metadata contracts |
| `/runtime-config` | Register the owned queue and streaming worker URL |
| `/backend`, `/factory`, `/service` | Backend, provider factory and service adapters |
| `/worker` | Durable queue worker/controller and foreground coordination |

App model metadata comes from the existing provider catalog and authorized model
choices. The legacy service registry and CLI helpers are not the current desktop
catalog, default-model policy or a promise of Node-local inference support. Consult
installed metadata rather than copying model-size/version tables.

## Runtime setup

The renderer composition root registers an explicit queue factory and streaming
worker URL before local backend initialization. `TransformersBackend` refuses
when Web Workers or that factory are unavailable; it does not bootstrap a second
queue or silently run inference in Node. Web setup lives in
[`create-embedding-queue.ts`](../../apps/web/src/create-embedding-queue.ts); desktop
setup belongs to the hidden embedding-host adapters.

Use [`inference-plan.ts`](src/inference-plan.ts) to preserve the selected model,
optional revision, device, dtype, pooling, prompts and actual dimensions. Inference
results must validate before publication. An unavailable selected device does not
authorize a fallback. Genuine GPU device loss retires the existing worker; the
next explicit request acquires a fresh runtime.

## Durable jobs and native ingestion

`startEmbeddingWorker` processes the surviving database-backed `JobQueue` path;
its options/controller live in
[`embedding-worker.ts`](src/worker/embedding-worker.ts). Producer-owned
`embeddingInputHash` and `sourceContentHash` travel in job payloads and fence stale
chunk publication. Cache reuse requires matching content/model identity. See the
[worker runtime guide](src/worker/README.md).

Desktop native ingestion uses its canonical producer, scoped index and hidden
inference owner. A shared queue/service import does not make PGlite its persistence
owner. Stop, reset and disposal must join the actual owned work. Detaching a
subscriber does not stop work owned by a longer-lived host. Hosted embeddings use
their provider adapters and resolved credential boundary, keeping secrets outside
local worker payloads.

## Development

Use this package's `build`, `type-check`, `test` and `test:integration` scripts.
Model/hardware probes are explicit work and have different prerequisites from
unit checks. **CI is disabled due to cost; validation must run locally.** Follow
[validation guidance](../../docs/agents/ci-quality.md).
