# Embedding input hash relocation benchmark (BST-393) — evidence

Supports `docs/agents/local-inference.md` § "Embedding input hash relocation
benchmark". Read before changing the benchmark's historical arm, its fixtures,
or before reading its timings as a threshold. The harness is
`packages/embeddings/src/__tests__/embedding-input-hash-benchmark.integration.test.ts`.

## Original text


The relocation and queue-load integration suites explicitly set
`concurrent: false` under Vitest 5; their shared PGlite state remains serialized.

- `packages/embeddings/src/__tests__/embedding-input-hash-benchmark.integration.test.ts`
  compares the historical claim-path filter hash with the persisted-payload path from
  BST-391 for batch sizes 1, 8, and 32 and source contents of 128 and 4096 bytes.
- It reports median historical worker-hot-path, persisted worker-hot-path, producer
  hash, and relocated end-to-end durations. The relocated end-to-end value is a
  separately measured composed operation covering producer hashing followed by
  the persisted worker path; it is not the sum of independently sampled medians.
  This prevents the benchmark from pretending that moving work upstream makes
  its CPU cost disappear.
- Completion-path duplicate hashing is not benchmarked: BST-392 removed it
  before this harness existed. The remaining comparison is the still-relevant
  BST-391 claim-path filter relocation identified when BST-393 was re-groomed.
- Timing is diagnostic output, not a threshold gate. The deterministic checks
  seed both current and stale embedding hashes across the matrix and require the
  historical and persisted filters to classify the same exact chunk IDs. The
  two one-item scenarios split the branches: 128 bytes is current and 4096 bytes
  is stale; every multi-item scenario contains both. The historical path
  intentionally preserves its serial per-chunk hash awaits, verbatim pre-BST-391
  SHA-256 helper, and pre-BST-391 payload validator; its fixture payloads omit
  both new source-identity fields so the historical timing cannot silently absorb
  relocated validation work. It also reproduces the historical tagged-item
  construction/result shape and normalizes both arms to sorted chunk IDs only
  after timing. Stable per-scenario closures invoke both arms; their options and
  callbacks are constructed once outside warmup and measured samples. The
  historical options dispatch hashing through the snapshotted callback with a
  batch-level `jobModel.compositeKey` and preserve the original orphan
  `logWarn`/`failOrphanJobs` path. The timing therefore includes the scheduling
  behavior BST-391 removed. The persisted arm also includes BST-391's new
  current/stale partition and per-chunk `sourceContentHash` comparison, so
  historical-minus-persisted understates the hashing win rather than isolating pure
  hash cost. Each scenario deletes its queue, chunk, file, and embedding-set rows
  before the next scenario, so table growth does not confound comparisons across
  the content-length axis.
  Source length still varies because `loadChunksBatch` reads chunk content.
  Fixture chunk hashes must be production-shaped 64-character lowercase hex.
  SHA-256 reserves nine padding bytes, so the 64-byte hex hash plus separator
  already exceeds one block's 55-byte input limit; the 22-byte composite model
  key makes this fixture's `${contentHash}:${resolvedModelKey}` input 87 bytes,
  but does not cause the second compression block. Current and stale
  `embedding_hash` fixtures are
  distinct 64-hex digests so equality compares like-shaped identities instead
  of rejecting by length. The fixture uses an already-composite local model key
  supplied independently to the producer and historical batch job model;
  equivalence does not cover hosted-provider normalization or payload/job-model
  divergence. Historical `resolveJobModel` parsing is intentionally outside the
  claim-path filter timing, so historical-minus-persisted also excludes that
  once-per-batch cost.
- Focused run:
  `pnpm --filter @brainstrike/embeddings exec vitest run --config vitest.integration.config.mts --maxWorkers=1 --no-file-parallelism src/__tests__/embedding-input-hash-benchmark.integration.test.ts`.
