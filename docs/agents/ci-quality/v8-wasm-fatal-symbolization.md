# V8 WASM fatal symbolization, Node 24.20.0 — evidence checkpoint, 2026-09-05

Supports `docs/agents/ci-quality.md` § "A test file with no verdict fails the
lane" (BST-1221). The record of how the fatal's native boundary was located on
Node 24.20.0 Linux x64, and which causal claims that evidence did and did not
support. The later runtime correction (the V8 dying-wrapper fix and the Node
26.8.2 pin) is recorded in `ci-quality/lost-test-file-reporter.md`.

Status: unresolved. This checkpoint corrects the causal account; it does not
implement or validate a native crash fix. Repository baseline:
`a4fa79cc878d5b975510d7e3182048466611dcd4`.

## Current CI evidence

Both exact job logs were retrieved through the GitHub job-log API, rather than
the successful retry logs:

- [PR #2962, assistant-data, job 101217638229](https://github.com/seandearnaley/brainstrike/actions/runs/33933667974/job/101217638229):
  head `72b4df6b08c3bfe12b6c82a699de7fd2539630e1`, Node 24.20.0, Linux x64;
  exact allocation assertion, `V8_Fatal`, and
  `ThreadIsolation::UnregisterWasmAllocation`; exit 132 before file verdicts.
- [PR #2973, embeddings, job 101233285816](https://github.com/seandearnaley/brainstrike/actions/runs/33938868608/job/101233285816):
  the same three native markers are present. The lost-file reporter names
  `embedding-worker-model-resolution.integration.test.ts`; the summary is
  13/14 files and 73/79 tests. This is a confirmed native-fatal occurrence,
  beyond the generic worker-loss description in the initial Linear comment.

## Symbolized responsible boundary

The official `node-v24.20.0-linux-x64.tar.xz` archive was verified against
[Node's published SHA-256 sums](https://nodejs.org/dist/v24.20.0/SHASUMS256.txt):

```text
2f2c0da162318f0de47665410c7c8c2ed3d36c8f3105de4bbc61176c70a7cbf2  node-v24.20.0-linux-x64.tar.xz
```

Offline `addr2line -C -f` against that archive's `bin/node` resolves the
following shared frames in both logs. The binary has function symbols but
does not provide source line information for these addresses.

| Address | Function |
| --- | --- |
| `0x18ca4b3` | `WasmCodeAllocator::FreeCode` |
| `0x1904f0f` | `WasmImportWrapperCache::Free` |
| `0x18e9dee` | `WasmEngine::FreeDeadCodeLocked` |
| `0x18e9fa1` | `WasmEngine::FreeDeadCode` |
| `0x18c1dff` | `WasmCode::DecrementRefCount` |
| `0x18c4bfc` | `WasmCodeRefScope::~WasmCodeRefScope` |
| `0x1759d2f` | `Runtime_TierUpWasmToJSWrapper` |

This identifies reclamation of WASM import wrappers during wrapper tier-up.
It does not demonstrate which event invalidated the allocation registry.
The earlier inference that the fatal proves a whole PGlite instance is being
finalized is too strong.

Pinned Node 24.20.0 sources show the relevant ownership and assertion paths:

- [UnregisterAllocation, lines 338–341](https://github.com/nodejs/node/blob/v24.20.0/deps/v8/src/common/code-memory-access.cc#L338-L341)
  and [UnregisterWasmAllocation, lines 530–532](https://github.com/nodejs/node/blob/v24.20.0/deps/v8/src/common/code-memory-access.cc#L530-L532)
  have no `Enabled()` guard. The assertion is not PKU-exclusive.
- [WasmImportWrapperCache::Free](https://github.com/nodejs/node/blob/v24.20.0/deps/v8/src/wasm/wasm-import-wrapper-cache.cc)
  invokes the code allocator after removing wrapper cache entries.

## Upstream evidence and limits

[An independent exact-CHECK report](https://github.com/nodejs/node/issues/64500#issuecomment-5140717306)
describes Linux x64 Intel Xeon without PKU and sequential PGlite instance
creation in one Node process. Its
[follow-up](https://github.com/nodejs/node/issues/64500#issuecomment-5440040468)
reports 74 fatal builds out of 1,669 with `--no-wasm-tier-up` (about 4.4%),
compared with 3/64 before it (about 4.7%). The small baseline limits any
rate comparison; these observations establish continued failures, not
statistical equality or an unchanged rate. These are the reporter's
measurements, not Brainstrike validation. That issue also contains a distinct
SIGSEGV investigation attributed to a specific machine's hardware; its
conclusion must not be transferred to Brainstrike's CHECK failure.

The current session has a macOS ARM host and an ARM Linux Docker engine, and
no native Linux x64 test venue. Offline symbolization does not execute the
affected binary. No new crash experiment, runtime mitigation, or fixture
change was executed. Native RED/GREEN evidence remains outstanding.

Existing focused commands, unchanged, are:

```sh
pnpm --filter @brainstrike/assistant-data test:integration
pnpm --filter @brainstrike/embeddings exec vitest run --config vitest.integration.config.mts --maxWorkers=1 --no-file-parallelism src/__tests__/embedding-worker-model-resolution.integration.test.ts
```

Keep correct fixture ownership and `close()` discipline, prevent cross-test
state bleed, and preserve complete test discovery and fatal/lost-file
reporting. This does not mandate a fresh PGlite per test: preserve the
queue-load spec's existing shared instance and scenario isolation. A
successful run is non-reproduction. Closing BST-1221 still requires evidence
tying a supported change to the responsible native boundary on the affected
platform.

## Later (2026-09-11)

This checkpoint's "unresolved" status was superseded: PR #3137's stack resolved
through the same `WasmImportWrapperCache::Free` / `Runtime_TierUpWasmToJSWrapper`
boundary, V8's dying-wrapper reference fix was identified, and the repository
pinned Node 26.8.2. See § "Runtime correction and qualification" in
`ci-quality/lost-test-file-reporter.md` for the qualification rule that governs
that pin.
