# Canonical provided chunks — 2026-10-03

Independent preparation/persistence boundary atop utility98ea2ef41. Product
producer/main/IPC/reset wiring is a following layer; no full-app cutover or
throughput/quality acceptance is implied. Hosted CI remains disabled.

The `providedChunks` input carries the unchanged PortableChunk DTO. It is a
strict union with foundation chunkLines input; malformed or mixed inputs reject
rather than choosing a fallback. Source/hash/line/index validation reuses the
chunker matcher via a pure entry without parser/tokenizer/worker initialization.
It validates only the claimed span, never relocates it. Canonical CRLF and
elided-line whitespace matching stays the same as the chunker's resolver.

Stable IDs hash ['provided-file-chunk-v1', rootId, fileId, chunkIndex, startOffset,
endOffset]. Embedding identity hashes [completeProfileHash, exactContentSHA].
Schema2 adds nullable chunk_index/chunk_size/chunk_type/start_offset/end_offset/
token_count to file_chunks, with a complete-or-null SQL constraint; old line
chunks explicitly carry nulls. Hits also expose contentHash and all producer
metadata. Metadata-only replacement retains vector blobs; stale or tampered
plans remain rejected transactionally. Schema1 raises rebuild-required without
migration/deletion.

A real canonical capture from sourcecommit ed97957 is tracked in
packages/indexer/__tests__/fixtures/canonical-provided-chunks.json. Its source
hash is checked and its two actual parser-produced chunks are persisted through
reopen; no reconstructed line segmentation is used. Three actual process tests
first failed on the unsupported provided input, then passed. They cover malformed
hash/span/line/type/indices, mixed policies and tampered plans, plus persistence
and metadata-only vector reuse. Pure helper tests preserve existing normalization
and reject shifted/empty/out-of-bounds claimed ranges. All176 chunking-worker
tests pass including existing parser/source-range behavior.

Durable evidence/commands and final check counts:
/Users/seandearnaley/Documents/brainstrike-indexer-provided-chunks-2026-10-03/.
Node26.8.2 is the pinned pnpm runtime; utility qualification uses Electron44.4.5.
No protective-bound mutation, suppression, new quarantine, remote push or merge.
