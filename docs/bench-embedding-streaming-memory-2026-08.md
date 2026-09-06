# BST-372: controlled embedding streaming memory comparison

Measured 2026-08-19. This document records the isolated old-versus-new evidence for
BST-372. It compares the exact output-retention implementations, not two full application
releases, because the streaming landing commit also contains unrelated runtime changes.

## Comparison boundary

| Variant | Exact revision | Production path | Worker Git blob | Shared Git blob |
| --- | --- | --- | --- | --- |
| Pre-stream | `13541685dc1586efea302440041965efd807440a` | workerpool `runEmbedding` → request-wide `runBatches` accumulation | `e0ed795e41428555de2c5b77e3d005b8beb398cf` | `0970779a73f979e32d4833afcaded232ceb01961` |
| Stream | `f983a0ed0ee0fc3581060f61c2f6fcb8bfed9d32` | direct `stream-embed` → per-batch post + acknowledgement | `1ebfe5182583f2f8207a4bdc41654d212eb28d07` | `c62a34673eca59dbe14102f2e7101a4d255ada9e` |

`packages/embedding-worker/bench/bst-372-source-binding.mjs` is the single source of
revision metadata. The runner first requires each configured blob to equal
`git rev-parse <revision>:<path>`, then archives that complete revision. The copied harness
independently computes the Git blob IDs of the extracted `embedding.worker.ts` and
`shared.ts` before importing production code. The result's revision and blob metadata come
from that verified binding; there is no caller-supplied commit label.

The checked-in harness and config are the byte-for-byte files used for the reported runs:

- `packages/embedding-worker/bench/bst-372-memory.measurement.spec.ts.fixture`
  (SHA-256 `6439709d366767b14837d0495a4cb2c90bc446c46f2e11d050f2089a2d075d1a`)
- `packages/embedding-worker/bench/vitest.bst-372.config.mts`
  (SHA-256 `3360d76c7e7e01b9263c7682a955c8e1aa4d27921f79779c2fb21c638fa4f920`)
- `packages/embedding-worker/bench/bst-372-source-binding.mjs`
  (SHA-256 `b363c4d8530a69267d631fc9eacf6199e78222de3bee3943a4a7903634a60a0a`)
- `packages/embedding-worker/bench/run-bst-372-memory.mjs`
  (SHA-256 `85a160a39244c2df404d356cee5d511c443195ff2ee60b0c569f281835918d55`)

## Controlled environment and fixture

- Apple M4 Max, 128 GiB RAM, `darwin-arm64`
- Node `v24.16.0`, V8 `13.6.233.17-node.49`, Vitest `4.1.10`
- Both archived trees used the same current workspace `node_modules`; historical lockfile
  differences were deliberately excluded. Transformers and workerpool were fully mocked.
  The `@brainstrike/types` embedding-constants blob is identical at both revisions and the
  measurement head: `b1eb64d1d5353b17cbeaf9a50093d07dfd2df659`.
- Deterministic extractor returning uniform `Float32Array` vectors; no model load, network,
  database, Electron, or GPU variability.
- 4,096 inputs, batch size 8, 2,000 dimensions (the live supported maximum): 512 batches,
  64,000 payload bytes per batch, and 32,768,000 payload bytes per request.
- Each variant ran in a fresh single-worker fork with `--expose-gc`. The harness forced two
  collections before the baseline, before every extractor call, and before the final retained
  result/completion sample. It sampled `process.memoryUsage()` at baseline, before and after
  each deterministic extractor allocation, at every streamed batch, and at final
  result/completion. Reported peaks are maxima over those samples; deltas subtract that
  process's own post-import baseline.
- The streaming post-message stub does not retain calls or vectors. It sends the matching
  request-and-index acknowledgement in a microtask, and the next extractor call forces
  collection. This deliberately measures sender-side reachability after acknowledgement under
  prompt collection. It does not model structured-clone detachment, receiver processing, or
  receiver retention. Because a real Web Worker transfer moves ownership to a receiver in the
  same renderer process, these process-RSS values are not conservative bounds for Electron.
- The fail-closed runner collected five fresh processes per variant and alternated which variant
  ran first. All ten source-bound processes completed successfully and are retained below.

## Replay commands

Run from a full-history checkout at the repository root. The runner refuses to measure if
either historical revision is unavailable, any configured Git object differs, an extracted
source differs, or a child result reports metadata different from the verified tree.

```bash
node packages/embedding-worker/bench/run-bst-372-memory.mjs --runs 5
```

The runner creates disposable full-revision archives, links the same current workspace
dependencies into both, copies the hashed harness artifacts, and launches each measurement in
a fresh single-worker fork with `--expose-gc`. It alternates order automatically. The verified
per-run record is `BST372_VERIFIED_MEMORY_RESULT`; the final record includes all results and
artifact hashes under `BST372_MEMORY_RUNNER_SUMMARY`.

`test/bst-372-source-binding.spec.ts` is the normal-suite negative proof. It presents streaming
source blobs under a pre-stream label and requires the verifier to reject the first mismatched
production source with `Refusing to measure`. This closes the previous seam where an arbitrary
`BST372_COMMIT` environment string could mislabel a successful run.

## Raw successful results

All values are bytes. `heapUsed` excludes external `ArrayBuffer` backing stores, so both
heap and resident/ArrayBuffer measurements are retained rather than substituting one for the
other.

| Variant | Run | Baseline RSS | Peak RSS | RSS delta | Baseline heapUsed | Peak heapUsed | Heap delta | Payload bytes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Pre-stream | 1 | 78,692,352 | 115,245,056 | 36,552,704 | 11,013,856 | 12,342,776 | 1,328,920 | 32,768,000 |
| Pre-stream | 2 | 78,446,592 | 115,195,904 | 36,749,312 | 11,013,920 | 12,342,840 | 1,328,920 | 32,768,000 |
| Pre-stream | 3 | 79,380,480 | 115,851,264 | 36,470,784 | 11,013,648 | 12,342,592 | 1,328,944 | 32,768,000 |
| Pre-stream | 4 | 78,888,960 | 115,851,264 | 36,962,304 | 11,013,824 | 12,342,744 | 1,328,920 | 32,768,000 |
| Pre-stream | 5 | 79,806,464 | 116,637,696 | 36,831,232 | 11,013,600 | 12,342,448 | 1,328,848 | 32,768,000 |
| Stream | 1 | 78,987,264 | 80,265,216 | 1,277,952 | 11,067,776 | 12,034,072 | 966,296 | 32,768,000 |
| Stream | 2 | 79,003,648 | 79,921,152 | 917,504 | 11,068,008 | 12,032,800 | 964,792 | 32,768,000 |
| Stream | 3 | 78,512,128 | 79,691,776 | 1,179,648 | 11,068,008 | 12,029,344 | 961,336 | 32,768,000 |
| Stream | 4 | 79,052,800 | 80,379,904 | 1,327,104 | 11,068,248 | 12,033,552 | 965,304 | 32,768,000 |
| Stream | 5 | 79,446,016 | 80,723,968 | 1,277,952 | 11,067,752 | 11,921,216 | 853,464 | 32,768,000 |

The external-memory counters were stable across all five runs:

| Variant | Peak ArrayBuffer delta | Peak external-memory delta |
| --- | ---: | ---: |
| Pre-stream | 32,832,000 | 32,832,040 |
| Stream | 256,000 | 256,040 |

## Current-production regression

The normal package unit suite discovers `test/bst-372-current-retention.spec.ts`. That test
launches a fresh `--expose-gc` Vitest process containing only the current-production retention
fixture. The fixture streams 4,096 maximum-dimension inputs as 512 acknowledged batches,
drops each sender-side message immediately, and samples `process.memoryUsage().arrayBuffers`
before each deterministic extractor allocation and while each batch is posted. Its bound is
512,000 bytes—eight times the 64,000-byte batch payload, and far below the 32,768,000-byte
request payload. The verified current head peaked at 256,000 bytes.

Mutation proof: adding a request-scoped array and pushing every `vectorsFromBatch` into it left
the protocol and acknowledgement assertions intact but raised the observed delta to 32,896,000
bytes. The normal-suite wrapper failed on `expected 32896000 to be less than or equal to
512000`. Removing the temporary accumulator restored the 256,000-byte green result. This
regression therefore observes physical `ArrayBuffer` retention independently of the worker's
self-reported in-flight counters.

## Observed comparison

- Pre-stream RSS delta: 34.781–35.250 MiB; median 35.047 MiB.
- Streaming RSS delta: 0.875–1.266 MiB; median 1.219 MiB.
- Observed median RSS-delta difference: 33.828 MiB for the same 31.25 MiB payload.
- Pre-stream heap delta: 1.267–1.267 MiB; median 1.267 MiB.
- Streaming heap delta: 0.814–0.922 MiB; median 0.920 MiB.
- Both variants produced and validated exactly 32,768,000 payload bytes. The streaming landing
  revision predates the later `transferBytes` event field, so the harness summed its actual
  transfer list. If that field exists, the same harness requires it to equal the transfer list.
  The pre-stream harness summed the unique buffers in the retained production result.

These are measured values, not a reconstruction of a missing historical run. They demonstrate
the sender-side resident-memory effect of the exact accumulator and streaming/ack
implementations under one controlled synthetic extractor and prompt collection. They omit the
receiver and do not represent total Electron renderer RSS with a real model loaded. They do not
replace
`apps/desktop/e2e/embedding-worker-renderer.memory.desktop.test.ts`, which remains the
application-level regression boundary.
