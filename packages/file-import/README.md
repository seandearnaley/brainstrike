# @brainstrike/file-import

Canonical chunk publication helpers. Composes existing owners; chooses no storage engine and runs no inference in Electron main.

- Publication forwards the canonical producer's chunks unchanged: hashes, line/offset spans, token metadata, symbols and references.
- Keep source/input identity through atomic chunk/job publication; desktop native ingestion owns storage.
- Subpaths: `/canonical-index-publication`, `/canonical-symbol-inserts`.
- Contract: [indexer](../../docs/agents/indexer.md).
