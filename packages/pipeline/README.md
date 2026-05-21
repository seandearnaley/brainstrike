# @brainstrike/pipeline

`@brainstrike/pipeline` owns indexing orchestration contracts that sit above
file import and below durable background execution.

## Ownership

- File to chunk orchestration belongs here when it coordinates multiple
  indexing stages.
- Chunk to embedding queue ownership belongs here when the app persists
  `embed_chunk` jobs into the durable queue.
- Runtime execution remains outside this package: embedding workers run in
  renderer context through `@brainstrike/embeddings`, and durable persistence
  remains in `@brainstrike/db`.

## Public Surfaces

- `createEmbeddingJobQueuePort()` converts indexing-owned chunk contracts into
  durable `job_queue` payloads.
- `PipelineController`, streaming stages, schema-health helpers, and progress
  aggregation remain available for higher-level orchestration.

## Current Production Consumer

`packages/db-explorer/src/enhanced-file-import-service.ts` imports
`createEmbeddingJobQueuePort()` and uses it when `EMBED_QUEUE_ENABLED=true` to
enqueue durable embedding jobs through `JobQueue`.

That production import means this package is no longer classified as dormant.
If the product later replaces this path with a different indexing owner, remove
the package from the workspace graph instead of leaving it built but unused.

## Allowed Dependencies

- `@brainstrike/indexing-contract`
- `@brainstrike/text-splitter`
- `@brainstrike/utils`

Do not import Electron main, renderer host, React UI, or provider runtime
modules here. Pipeline code should describe orchestration and queue payloads;
runtime execution belongs to the embedding and desktop host packages.

## Focused Test Command

```sh
pnpm --filter @brainstrike/pipeline test
```
