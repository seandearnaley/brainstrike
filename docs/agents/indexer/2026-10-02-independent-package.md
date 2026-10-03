# Independent SQLite indexer boundary (2026-10-02)

The independent package proves derived-index ownership, root-partition retrieval,
transactional file replacement and explicit profile/lifecycle failures. It does
not change the product persistence authority or inference host.

## Sources and scope

BST-1920's accepted Wave 1 plan (comment
`1d4358d8-c062-4073-b0b5-a4bcefdcb0f5`) requests the unwired package. The native
spike's `common.js`, `writer-worker.js` and `indexer.js` provided the writer/WAL,
FTS5 and binary-candidate/exact-rescore architecture. The spike's destructive
`fresh` deletion and 768-dimension placeholder are deliberately excluded.

Official SQLite FTS5 and sqlite-vec vec0/KNN documentation informed the schema.
The online sqlite-vec documentation describes a newer development release;
installed 0.1.9 partition keys and auxiliary Float32 blobs are therefore checked
with the actual native integration tests. No upstream change is required.

`symbol-corpus.json` is the historical `s-qs/hybrid/corpus-fixture.json`. The graph
check preserves its symbol names, caller edges, paths and sequences. That older
fixture lacks exported/offset fields; the test's synthetic source supplies those
additional typed fields and does not claim to have run the production parser.
Product integration must forward canonical parser output unchanged.

`fused-minilm-384.json` records a vector from the actual Electron hidden renderer
host at embedding branch commit `5e9ed9834`. Its source is the first 1,200 characters of
`packages/embedding-worker/src/embedding.worker.ts`, SHA256
`c62e9fe92b9adfdb61215ec93dd6f66b757c895c9e66f679416754cb5fb7f015`.
The profile is `onnx-community/all-MiniLM-L6-v2-ONNX` at immutable revision
`aff7a1dc4e8a1ea593e6ea21e95c22ef0a25966f`, fp16/WebGPU, 384 dimensions,
256 tokens including specials, mean pooling and L2 normalization. The fixture
also records the renderer's 8,192 padded-token batch budget and runtime adapter;
these execution details are provenance, not additional persistent-profile fields.
The integration check verifies source SHA, stored Float32 bytes and exact
self-query cosine distance. Node never computes an embedding.

## RED/GREEN and remaining acceptance

The initial empty implementation failed five public package integration cases.
A later graph negative control omitted symbol insertion and made the historical
caller fixture fail; restoring insertion makes it pass. Tests import the emitted
public package and actually fork Node plus a writer worker, load the native
extension, and exercise disk-backed SQLite WAL.

The suite covers root starvation by more than 100 foreign coarse candidates,
exact-rescore ordering, stale plans, profile mismatches for all five identity
fields, queued-write reset, unknown existing databases, interrupted processes,
independent WAL snapshots, invalid vector/schema inputs, renderer-vector
roundtrip, and atomic symbol/ref replacement/removal.

Product host wiring, renderer-host pipeline throughput, independently judged
retrieval quality, all five native packaging targets and full application
before/after responsiveness remain external acceptance gates. No hosted CI run,
new quarantine, fallback or changed canonical-state owner accompanies this package.

## Recorded local qualification

At the native prerequisite head `3c6fdf66b82046ddca6951a719ee2cfece15292f`,
Mac ARM64's forced Turbo build/unit/integration/type-check closure completed
7/7 tasks with zero cache hits: nine native integration cases, two pure chunk
checks, and zero strict TypeScript/Effect errors or warnings. The standalone
Ultracite check passed without suppressions.

Linux ARM64 ran the emitted public package on Node 26.8.2 in the existing local
`node:26.8.2-bookworm-slim` container, with an independent `/indexer-proof` source
copy and the already qualified pinned native dependency artifacts. All nine
native integration cases and both unit checks passed. The first source transfer
also copied macOS AppleDouble sidecar files, causing an additional malformed test
file to fail discovery; the transfer was corrected without changing the test
glob or quarantining anything. This run is a local package/platform proof, not a
clean reinstall or full product packaging qualification.
