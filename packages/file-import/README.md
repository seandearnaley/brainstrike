# @brainstrike/file-import

Chunking-worker port and context, chunking-strategy resolution and canonical
chunk publication helpers. The package composes existing owners; it does not
choose a new storage engine or run inference in Electron main.

## Chunking

Strategy names come from the shared text-splitter contract. Runtime chunking
uses the injected worker/host port, preserving the producer's original chunks,
hashes, line/offset spans, token metadata, symbols and references.

Keep source/input identity through atomic chunk/job publication. Desktop native
ingestion owns storage. See the [indexer contract](../../docs/agents/indexer.md).

## Public surface and development

[`package.json`](package.json) owns root and narrow subpath exports, including
canonical publication helpers. Declare local dependencies with `workspace:*` and
use the existing package scripts. Follow `pnpm check`.
