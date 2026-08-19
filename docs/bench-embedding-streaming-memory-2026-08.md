# BST-372: controlled embedding streaming memory comparison

Measured 2026-08-19. This document records the isolated old-versus-new evidence for
BST-372. It compares the exact output-retention implementations, not two full application
releases, because the streaming landing commit also contains unrelated runtime changes.

## Comparison boundary

| Variant | Exact revision | Production path | `embedding.worker.ts` Git blob |
| --- | --- | --- | --- |
| Pre-stream | `13541685dc1586efea302440041965efd807440a` | workerpool `runEmbedding` → request-wide `runBatches` accumulation | `e0ed795e41428555de2c5b77e3d005b8beb398cf` |
| Stream | `f983a0ed0ee0fc3581060f61c2f6fcb8bfed9d32` | direct `stream-embed` → per-batch post + acknowledgement | `1ebfe5182583f2f8207a4bdc41654d212eb28d07` |

Both trees came from `git archive <revision>`. `git hash-object` on each extracted worker
matched `git rev-parse <revision>:packages/embedding-worker/src/embedding.worker.ts`
before measurement.

The checked-in harness and config are the byte-for-byte files used for the reported runs:

- `packages/embedding-worker/bench/bst-372-memory.measurement.spec.ts.fixture`
  (SHA-256 `6a24235df4629efc9ae4630384f6b1d650f7005cc59bda14a6b90b83ab35e6bf`)
- `packages/embedding-worker/bench/vitest.bst-372.config.mts`
  (SHA-256 `3360d76c7e7e01b9263c7682a955c8e1aa4d27921f79779c2fb21c638fa4f920`)

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
  request-and-index acknowledgement in a microtask. It does not simulate structured-clone
  detachment, so streamed buffers stay resident through the callback and the measurement is
  conservative relative to a real transfer.
- Five successful fresh processes were retained per variant. Execution order alternated. One
  additional pre-stream attempt emitted a complete measurement but exceeded Vitest's former
  5-second default while the machine was loaded; it was excluded, the config timeout was made
  explicit at 30 seconds, and a passing replacement was collected.

## Replay commands

Run from the repository root. `BST372_MEASURE_ROOT` and `BST372_REPO_ROOT` are
task-specific variables; the archived trees are disposable measurement inputs.

```bash
BST372_REPO_ROOT="$(pwd)"
BST372_MEASURE_ROOT="$(mktemp -d /tmp/bst372-memory.XXXXXX)"
mkdir -p "$BST372_MEASURE_ROOT/pre" "$BST372_MEASURE_ROOT/stream"

git archive 13541685dc1586efea302440041965efd807440a |
  tar -x -C "$BST372_MEASURE_ROOT/pre"
git archive f983a0ed0ee0fc3581060f61c2f6fcb8bfed9d32 |
  tar -x -C "$BST372_MEASURE_ROOT/stream"

ln -s "$BST372_REPO_ROOT/node_modules" "$BST372_MEASURE_ROOT/pre/node_modules"
ln -s "$BST372_REPO_ROOT/node_modules" "$BST372_MEASURE_ROOT/stream/node_modules"
ln -s "$BST372_REPO_ROOT/packages/embedding-worker/node_modules" "$BST372_MEASURE_ROOT/pre/packages/embedding-worker/node_modules"
ln -s "$BST372_REPO_ROOT/packages/embedding-worker/node_modules" "$BST372_MEASURE_ROOT/stream/packages/embedding-worker/node_modules"

cp packages/embedding-worker/bench/bst-372-memory.measurement.spec.ts.fixture "$BST372_MEASURE_ROOT/pre/packages/embedding-worker/test/bst-372-memory.measurement.spec.ts"
cp packages/embedding-worker/bench/bst-372-memory.measurement.spec.ts.fixture "$BST372_MEASURE_ROOT/stream/packages/embedding-worker/test/bst-372-memory.measurement.spec.ts"
cp packages/embedding-worker/bench/vitest.bst-372.config.mts "$BST372_MEASURE_ROOT/pre/packages/embedding-worker/vitest.bst372.config.mts"
cp packages/embedding-worker/bench/vitest.bst-372.config.mts "$BST372_MEASURE_ROOT/stream/packages/embedding-worker/vitest.bst372.config.mts"
```

Each pre-stream process used exactly:

```bash
cd "$BST372_MEASURE_ROOT/pre/packages/embedding-worker"
env BST372_VARIANT=pre-stream BST372_COMMIT=13541685dc1586efea302440041965efd807440a NODE_OPTIONS=--expose-gc "$BST372_REPO_ROOT/node_modules/.bin/vitest" run --config vitest.bst372.config.mts --pool=forks --maxWorkers=1 --no-file-parallelism --reporter=verbose
```

Each streaming process used the same invocation shape:

```bash
cd "$BST372_MEASURE_ROOT/stream/packages/embedding-worker"
env BST372_VARIANT=stream BST372_COMMIT=f983a0ed0ee0fc3581060f61c2f6fcb8bfed9d32 NODE_OPTIONS=--expose-gc "$BST372_REPO_ROOT/node_modules/.bin/vitest" run --config vitest.bst372.config.mts --pool=forks --maxWorkers=1 --no-file-parallelism --reporter=verbose
```

Repeat those fresh-process invocations five times, alternating which variant runs first.
The machine-readable record is the `BST372_MEMORY_RESULT` JSON line.

## Raw successful results

All values are bytes. `heapUsed` excludes external `ArrayBuffer` backing stores, so both
heap and resident/ArrayBuffer measurements are retained rather than substituting one for the
other.

| Variant | Run | Baseline RSS | Peak RSS | RSS delta | Baseline heapUsed | Peak heapUsed | Heap delta | Payload bytes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Pre-stream | 1 | 77,479,936 | 114,360,320 | 36,880,384 | 10,550,344 | 11,878,328 | 1,327,984 | 32,768,000 |
| Pre-stream | 2 | 77,889,536 | 114,802,688 | 36,913,152 | 10,550,088 | 11,878,144 | 1,328,056 | 32,768,000 |
| Pre-stream | 3 | 77,496,320 | 114,540,544 | 37,044,224 | 10,550,192 | 11,878,248 | 1,328,056 | 32,768,000 |
| Pre-stream | 4 | 78,970,880 | 115,113,984 | 36,143,104 | 10,550,064 | 11,878,120 | 1,328,056 | 32,768,000 |
| Pre-stream | 5 | 78,725,120 | 114,933,760 | 36,208,640 | 10,550,016 | 11,877,920 | 1,327,904 | 32,768,000 |
| Stream | 1 | 77,987,840 | 79,200,256 | 1,212,416 | 10,604,912 | 11,868,592 | 1,263,680 | 32,768,000 |
| Stream | 2 | 79,036,416 | 79,691,776 | 655,360 | 10,604,568 | 11,457,184 | 852,616 | 32,768,000 |
| Stream | 3 | 78,381,056 | 79,216,640 | 835,584 | 10,604,592 | 11,562,776 | 958,184 | 32,768,000 |
| Stream | 4 | 77,905,920 | 79,183,872 | 1,277,952 | 10,604,736 | 11,740,064 | 1,135,328 | 32,768,000 |
| Stream | 5 | 78,348,288 | 79,003,648 | 655,360 | 10,604,680 | 11,936,976 | 1,332,296 | 32,768,000 |

The external-memory counters were stable across all five runs:

| Variant | Peak ArrayBuffer delta | Peak external-memory delta |
| --- | ---: | ---: |
| Pre-stream | 32,832,000 | 32,832,040 |
| Stream | 256,000 | 256,040 |

## Observed comparison

- Pre-stream RSS delta: 34.469–35.328 MiB; median 35.172 MiB.
- Streaming RSS delta: 0.625–1.219 MiB; median 0.797 MiB.
- Observed median RSS-delta difference: 34.375 MiB for the same 31.25 MiB payload.
- Pre-stream heap delta: 1.266–1.267 MiB; median 1.267 MiB.
- Streaming heap delta: 0.813–1.271 MiB; median 1.083 MiB.
- Both variants produced and validated exactly 32,768,000 payload bytes. The streaming landing
  revision predates the later `transferBytes` event field, so the harness summed its actual
  transfer list. If that field exists, the same harness requires it to equal the transfer list.
  The pre-stream harness summed the unique buffers in the retained production result.

These are measured values, not a reconstruction of a missing historical run. They demonstrate
the resident-memory effect of the exact accumulator and streaming/ack implementations under one
controlled synthetic extractor. They do not represent total Electron renderer RSS with a real
model loaded, and they do not replace
`apps/desktop/e2e/embedding-worker-renderer.memory.desktop.test.ts`, which remains the
application-level regression boundary.
