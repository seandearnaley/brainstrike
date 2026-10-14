# @brainstrike/pipeline

`@brainstrike/pipeline` owns indexing orchestration contracts that sit above
file import and below durable background execution.

## Ownership

- File to chunk orchestration belongs here when it coordinates multiple
  indexing stages.
- Chunk to embedding queue ownership belongs here when the app persists
  `embed_chunk` jobs into the durable queue.
- Runtime execution remains outside this package: embedding workers run in
  renderer context through `@brainstrike/embeddings`; the surviving database-backed
  queue path persists through `@brainstrike/db`. Desktop canonical state and native
  indexing have separate host/index owners.

## Public Surfaces

- `createEmbeddingJobQueuePort()` converts indexing-owned chunk contracts into
  durable `job_queue` payloads.
- `PipelineController`, streaming stages, schema-health helpers, and progress
  aggregation remain available for higher-level orchestration.

## Database-backed consumer

`packages/db-explorer/src/enhanced-file-import-service.ts` imports
`createEmbeddingJobQueuePort()` and uses it when `EMBED_QUEUE_ENABLED=true` to
enqueue durable embedding jobs through `JobQueue`.

This import identifies an existing consumer; it does not prove that desktop
uses the PGlite queue. The desktop native ingestion boundary is described in the
[indexer contract](../../docs/agents/indexer.md).

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

CI is disabled due to cost; validation must run locally. See
[validation guidance](../../docs/agents/ci-quality.md).
