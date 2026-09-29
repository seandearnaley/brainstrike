# Streaming embedding payload-memory proof (BST-372) — evidence

Supports `docs/agents/local-inference.md` § "Streaming payload-memory proof".
Read before re-deriving the streaming retention bound or changing
`bst-372-current-retention.spec.ts`. The A/B harness and raw results live in
`docs/bench-embedding-streaming-memory-2026-08.md`.

## Original text

Streaming embedding payload-memory proof (BST-372):
- No contemporaneous pre-streaming process-memory capture exists, so the comparison boundary
  is a controlled replay of the exact source implementations. At parent commit
  `13541685dc1586efea302440041965efd807440a`, `runBatches` appended every output vector to
  one request-wide array and `processEmbeddings` transferred those buffers only after all
  batches completed. Uniform Float32 output therefore retained
  `totalInputs * dimensions * 4` payload bytes until request completion, in addition to
  model/runtime/input/transient memory. Streaming landed in
  `f983a0ed0ee0fc3581060f61c2f6fcb8bfed9d32`: `streamEmbeddings` transferred one batch and
  awaited the matching request-and-index acknowledgement before starting the next batch. That
  revision predates the `transferBytes` event field; the current runtime additionally reports
  the exact unique-buffer byte count there. Its transport-output retention bound is therefore
  `batchSize * dimensions * 4` bytes for uniform Float32 vectors. This is a payload bound, not a
  claim about total renderer RSS or heap.
- `embedding.worker.runtime.spec.ts` exercises the live maximum supported dimension across
  eight protocol batches. Before each acknowledgement, the test
  requires exactly one inference batch and one posted batch, eight current/peak vectors in
  flight, and an exact transfer-list byte sum. The message mock is cleared before each
  acknowledgement so the harness does not retain prior vector payloads. Removing the
  `await waitForBatchAck(...)` gate makes all eight inference batches start before the first
  acknowledgement and fails the assertion (`8` observed versus `1` allowed), proving the
  backpressure check has teeth.
- The normal unit suite also discovers `bst-372-current-retention.spec.ts`, which launches a
  fresh `--expose-gc` process against current production code. It observes physical
  `ArrayBuffer` retention across 4,096 maximum-dimension inputs and 512 acknowledged batches;
  the peak delta must remain at or below 512,000 bytes rather than the 32,768,000-byte request
  payload. The verified head measured 256,000 bytes. A temporary request-wide accumulator
  mutation raised the delta to 32,896,000 bytes and failed that bound, independently of the
  worker's self-reported in-flight telemetry.
- `docs/bench-embedding-streaming-memory-2026-08.md` records the reproducible A/B harness,
  environment, fail-closed runner, artifact hashes, source-blob verification, and every raw
  process result. The runner binds each variant to its exact revision plus the executed
  `embedding.worker.ts` and `shared.ts` blobs; the archived harness re-verifies those sources
  before import and derives result metadata from the binding. Five fresh processes per revision
  used the same deterministic 4,096-input, batch-8, 2,000-dimension fixture and produced exactly
  32,768,000 payload bytes. Pre-stream peak RSS growth was 34.781–35.250 MiB (35.047
  MiB median); streaming growth was 0.875–1.266 MiB (1.219 MiB median), an observed median
  difference of 33.828 MiB. This isolates idealized sender-side retention under prompt
  collection. It omits receiver lifetime and is not a conservative bound or a claim about total
  Electron RSS with a real model loaded.
- `apps/desktop/e2e/embedding-worker-renderer.memory.desktop.test.ts` remains the
  application-level proof for bounded heap/RSS across large and repeated real-host runs. Its
  model-backed measurements are complementary, not a historical pre-streaming baseline.
