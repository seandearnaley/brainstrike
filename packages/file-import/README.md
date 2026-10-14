# @brainstrike/file-import

Shared import orchestration, repository ports, canonical chunk publication and
embedding-queue adapters. The package composes existing owners; it does not
choose a new storage engine or run inference in Electron main.

## Import through current ports

The exported orchestration function is `runEnhancedImport`, with injected base
import runner, repositories/ports, chunking/embedding configuration, progress
handlers and cancellation. It is not `enhancedFileImport({ db, file })`.
The current request/result shapes live in
[`enhanced-import.ts`](src/enhanced-import.ts) and [`types.ts`](src/types.ts).

`processFileChunking`/`processChunking` and `processEmbeddings` handle their
respective stages. Strategy names come from the shared text-splitter contract;
old `semantic`/`fixed` examples do not define supported values. Runtime chunking
uses the injected worker/host port, preserving the producer's original chunks,
hashes, line/offset spans, token metadata, symbols and references.

Keep source/input identity through atomic chunk/job publication. Cancellation,
backfill and retry retain the current request/owner fences; progress is not proof
that vectors committed. Desktop native ingestion and the surviving database-backed
import path have different storage owners. See the
[indexer contract](../../docs/agents/indexer.md).

## Browser queue integration

`createBrowserEmbeddingQueuePort` takes an existing `QueueAdapter`, chunk
repository, explicit device hint and optional progress/drain dispatchers. Its
`enqueueBatch` surface comes from the indexing contract; it is not a worker with
`start()`/`stop()` methods.

Acquire the actual workerpool queue through `@brainstrike/queue/browser` with its
owned URL and required telemetry sink; see the [queue guide](../queue/README.md).
The import port does not bootstrap another queue or own a longer-lived host.
Hosted credentials stay at the provider boundary, outside local worker payloads.

## Public surface and development

[`package.json`](package.json) owns root and narrow subpath exports, including
canonical publication helpers. Declare local dependencies with `workspace:*` and
use the existing package scripts. A database-shaped port does not imply direct
renderer SQL authority.
Follow
[validation guidance](../../docs/agents/ci-quality.md).
