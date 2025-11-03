# @brainstrike/file-import

Import pipeline utilities used by the desktop and web apps to enqueue files, chunk content, and generate embeddings.

## Purpose
- Bridge user-selected files into the embedding queue shared by [`@brainstrike/db`](../db/README.md).
- Handle chunking strategies and embedding orchestration for both browser and worker contexts.
- Provide browser-specific queue ports that cooperate with the renderer worker pool (see [`@brainstrike/workers`](../workers/README.md)).

## Key exports
- `createBrowserEmbeddingQueuePort` – connects the renderer to the embeddings worker queue with structured progress events.
- Chunking helpers (`splitIntoChunks`, `estimateChunkTokenCount`, etc.) from `chunking.ts` to standardise how documents are tokenised.
- Embedding orchestration helpers (`createEmbeddingJob`, `enqueueEmbeddingJobs`) from `embedding.ts`.
- Enhanced import flow from `enhanced-import.ts`, which combines chunking, metadata extraction, and job submission.
- Shared TypeScript contracts (`ImportJob`, `QueueProgressEventDetail`, etc.) from `types.ts`.

## Common commands
- `pnpm run build` – builds the package via `tsc -b`, emitting declaration files consumed by the apps.
- `pnpm run test` – runs Vitest with DOM support via `jsdom`.
- `pnpm run type-check` – validates both runtime and test TypeScript projects to keep the queue contracts safe.
- `pnpm run lint` – reuses the workspace lint script for formatting and style checks.

## Setup notes
- Requires Node.js 22+ and access to the shared workspace dependencies (`@brainstrike/agent`, `@brainstrike/embeddings`, etc.).
- Tests expect a mockable PGlite environment; ensure `@electric-sql/pglite` is installed at the workspace root.
- Pair this package with the storage adapters documented in [`@brainstrike/storage`](../storage/README.md) when wiring imports to persistent state.
