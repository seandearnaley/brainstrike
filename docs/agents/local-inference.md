# Local Inference: Embeddings + Local LLM (CRITICAL)

> Extracted from AGENTS.md (2026-07-12). Renderer-only execution is mandatory. Read before touching embedding/llm hosts, workers, or local chat. Keep updated with the code.

## EMBEDDING ARCHITECTURE (CRITICAL)

Renderer-only execution is mandatory.

### Embedding telemetry diagnostics (BST-1101)

- The System Diagnostics embedding card presents aggregate transfer, residency,
  memory-estimate, device-count, and health-count data only. It must not render cache
  keys, model names, source ids, failure strings, user content, or vectors. An empty
  observation window is neutral (`No samples`), not a warning or degraded state. A
  desktop telemetry-provider failure renders a fixed unavailable message; its raw
  error text remains internal and must not reach the diagnostics DOM.
- `EmbeddingTelemetrySnapshot.peakVectorsInFlight` is a per-batch high-water mark.
  In streaming mode it is the largest batch waiting for acknowledgement; the worker
  waits for that acknowledgement before sending the next batch. In workerpool mode the
  adapter emits one synthetic batch for the complete task result, so the value is the
  largest vector count returned by one task, not the total concurrent vectors across
  the pool. Multi-source aggregation takes the maximum and never sums source peaks.
- `resetEmbeddingTelemetryForTests` is deliberately excluded from the production root
  API. Tests that need process-global telemetry isolation import the explicit
  `@brainstrike/embedding-worker/testing` subpath. Production code must never import it.
- App-shell tests use the production snapshot validator and empty-snapshot factory from
  `@brainstrike/embedding-worker`; a permissive shape-only mock would hide desktop host
  boundary failures.

Rules:
- Embedding worker MUST run in renderer (browser context).
- MUST NOT run in Electron main process.

Reasons:
- Transformers.js requires Web Workers (renderer only).
- In main/Node, it degrades to synchronous WASM → freezes UI.

Flow:
1. Hidden host renderer
   - Files:
     - apps/desktop/src/embedding-host-manager.ts
     - apps/desktop/src/hidden-preload.ts
     - apps/desktop/src/renderer/components/embedding-host-app.tsx
     - apps/desktop/src/renderer/components/embedding-host-runtime.tsx
   - Main creates a hidden BrowserWindow with `?mode=embedding-host`.
   - The window loads `hidden-preload.js` with the server-owned
     `embedding-host` role argument. That manifest exposes only the embedding
     report/request bridge, power snapshot/events, logging ingest, the database
     capabilities the current renderer-owned queue needs, and the scoped
     vector-preferences capability below. It never exposes provider secrets,
     assistant-server credentials, or the visible UI's unrestricted `storage`
     key-value bridge.

Vector device preference is ONE canonical record (BST-1380):
- The host resolves `devicePref`/`devicePrefConfigured` from the SAME
  `vector-preferences.v1` record the visible UI writes. The visible UI reaches it
  through `electronAPI.storage`; the hidden host reaches it through the scoped
  `electronAPI.vectorPreferences` capability (`vector-preferences:read` /
  `:write` / `:clear`), authorized to the `embedding-host` role only. Those
  channels accept NO key — `apps/desktop/src/platform/vector-preferences-storage-key.ts`
  pins it in main — so a hidden host can neither enumerate keys nor address
  another persisted store.
- `packages/app-state/src/stores/vector-preferences-store.ts` must NOT fall back
  to browser storage when an Electron renderer exposes neither capability; it
  throws. Zustand's persist middleware swallows storage rejections and resolves
  `rehydrate()` anyway, so `ensureVectorPreferencesHydrated` asserts the
  capability itself — a swallowed read would otherwise present as
  "unconfigured, use WebGPU".
- History: BST-1235 moved hidden hosts onto the narrow manifest, which silently
  dropped `electronAPI.storage`. The host then read an empty per-host
  localStorage, saw `devicePrefConfigured: false`, ran auto-detection, and
  fail-closed on every machine without a WebGPU adapter — ignoring the user's
  explicit setting. Do not "fix" a recurrence by relaxing the E2E assertion or
  by re-exposing the full storage bridge. Paired tests:
  `vector-preferences-store.hidden-host.test.ts`,
  `hidden-preload-runtime.test.ts`, `hidden-preload-contract.test.ts`,
  `storage-preferences-ipc.test.ts`,
  `vector-preferences-storage-key-contract.test.ts`.
   - The host renderer mounts `DbProvider` with `useElectronIPC=true`.
   - The host renderer uses `startEmbeddingWorker()` from `@brainstrike/embeddings`.
   - It pulls jobs from the PGlite-backed `job_queue`.
   - Local models still execute in browser/Web Worker context only.
2. Visible renderer
   - File: packages/vector-management/src/vector-status/use-embedding-worker-controls.ts
   - Does NOT start the embedding worker directly in desktop mode.
   - Talks to the hidden host over the preload bridge (`window.embeddingHost`).
   - Keeps UI controls/status in sync with host lifecycle.
3. Main
   - File: apps/desktop/src/main.ts
   - Does NOT run embeddings in-process.
   - Owns host-window lifecycle, IPC, DB init, and power lifecycle.
   - Visible window uses default background throttling; only the hidden host disables throttling.
   - On macOS, `powerSaveBlocker` is allowed only while the hidden host reports active embedding
     work. Non-Darwin platforms never start one.
4. Job Queue
   - File: packages/db/src/queue/job-queue.ts
   - Backed by job_queue table.
   - Lease-based locking, retries, dedupe, failure tracking.
   - `startEmbeddingWorker` applies one runtime-wide in-flight budget across all
     polling loops before `claimMany`. The default ceiling is `claimBatchSize`;
     `maxInFlightJobs` may override it with another positive value. Slots are
     released only after the corresponding completion/failure write, or during
     explicit cleanup after a lost lease or interrupted batch.
   - Every durable `embed_chunk` payload carries `sourceContentHash` plus
     `embeddingInputHash`, the lowercase SHA-256 of
     `${contentHash}:${resolvedModelKey}`. Every producer
     (pipeline, transactional chunk insert, desktop backfill, and vector queue
     backfill) computes batches through `buildEmbeddingJobInputHashes` before
     enqueue. That helper mirrors the worker's hosted-provider model resolution
     and hashes independent chunks concurrently. Before embedding, the worker
     requires the persisted source hash to match the loaded chunk; changed
     chunks are failed terminally so an old input hash can never label a new
     vector. The worker reuses the input hash for stale checks and completion
     writes, and the claim path must never recompute it. Migration 105 backfills
     provable queued/running jobs plus retryable failed jobs and visibly
     cancels/counts active jobs whose chunk/model identity cannot be proven; do
     not add a legacy hashing fallback to the worker.
   - Desktop backfill admission bounds queued/running jobs for the target
     `embedding_set_id`, not the entire embeddings queue. Workspace Index may
     legitimately fill its separate QoS depth with other embedding sets; those
     jobs must not starve a manual backfill. Same-set desktop backfills remain
     single-flight at the IPC boundary, while the worker's runtime-wide
     in-flight budget remains the global inference ceiling.
   - Admitted manual backfill jobs use the queue's earliest runnable ordering,
     so an older unrelated embedding-set backlog cannot strand them behind the
     backfill drain timeout.
   - A `source: 'background-indexing'` backfill is owned by the host runtime,
     never by the React tree that requested it (BST-1654). The renderer's
     `WorkspaceCollectionSyncService` exposes two distinct teardowns and callers
     must not conflate them: `cancel()` is a deliberate stop (manual pause,
     indexing disabled, restart-active) and cancels the host run; `detach()` is
     the requester going away and releases only local state — it aborts the
     renderer-side loop and drops the progress subscription while the durable
     run keeps going. The provider's teardown effect MUST call `detach()`: it
     re-runs on every `service` identity change, so cancelling there tied a
     host-owned run's lifetime to a React memo dependency list and silently
     killed a user's backfill on navigation. The next `sync()` re-attaches via
     `selectRecoverableBackgroundBackfill`; `useResyncOnReturnToVisibility`
     remains the recovery path for hard teardowns only.
   - The renderer loop and the backfill therefore need SEPARATE abort
     controllers, and the signal handed to `enqueueBackfill` is the backfill's.
     On desktop the signal dies at the IPC boundary, so sharing one controller
     looked harmless; on web there is no host process — `enqueueLocalBackfill`
     merges the caller's signal into the run and awaits it, so the promise IS
     the run and aborting that signal kills the backfill. While they shared a
     controller, `detach()` still destroyed the run on web: the original bug,
     unfixed on that path. `detach()` aborts only the renderer loop; `cancel()`
     and a superseding `sync()` abort both.
   - Detaching drops tracking, never cancellation authority. An explicit pause
     or disable cancels in-flight `background-indexing` runs regardless of which
     provider instance is mounted, so `cancel()` and the disabled `sync()` path
     both enumerate `getBackfillsInFlight()` and cancel every run whose request
     id carries the `background-indexing-backfill:` prefix — a detached run is
     in no instance's `activeBackfill`, and the instance that sees the stop is
     usually a fresh one tracking nothing. Runs the prefix does not claim are
     left alone, and an undeliverable stop rejects instead of reporting success.
     Never make `detach()` the answer to a deliberate stop: trading the
     navigation bug for "pause does not stop indexing" is the worse half.
   - That enumeration sweep MUST be failure-isolated. A `for … await` loop that
     lets the first rejection escape never attempts the cancels behind it, so
     one uncooperative run silently spares every later one — "pause did not stop
     indexing" reappearing through a different door. Attempt every enumerated
     run, then surface the failures together (`AggregateError`); isolation must
     not become silent success.
   - A stop that lands while an `enqueueBackfill` is in flight cannot be closed
     by the sweep alone: it enumerates a host that cannot report the run yet,
     and the cancel it fires for the speculative `pending:` tracking entry races
     ahead of the run's creation. `enqueueManagedBackfill` therefore re-checks
     the backfill signal once the enqueue resolves and cancels the freshly
     created run, so at least one cancel is ordered AFTER the run exists.
   - A backfill suspends the dimension HNSW index before enqueueing. Every
     interruption after that point, including producer faults and timeouts,
     must either restore the index immediately when the scoped set has drained
     or schedule the existing deferred recovery after that scoped drain.
     Non-cancellation failures must never intentionally leave the index
     suspended for an unrelated maintenance tick.
   - Renderer queue-health writes carry the wall-clock time of the completed
     database poll. The store keeps poll freshness separate from the deduped
     count snapshot so always-mounted queue subscribers do not rerender on an
     idle polling cadence. Diagnostics consume the stored poll timestamp; they
     must not synthesize queue freshness during React render.

### Embedding input hash relocation benchmark (BST-393)

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

### Embedding queue load verification (BST-387)

- `packages/embeddings/src/__tests__/embedding-queue-load.integration.test.ts`
  runs a serialized real-PGlite matrix with 1, 2, 4, and 16 polling loops.
- All scenarios share ONE lazily created `memory://` PGlite closed in
  `afterAll`, with per-scenario state kept disjoint by scenario-prefixed ids
  and dedupe-key-scoped SQL. Do not return to a fresh instance per scenario:
  PGlite close leaves WASM teardown to GC, and the teardown-overlapping-
  instantiation churn was BST-1221's reproducible V8 fatal trigger on the
  PKU-enabled Linux x64 CI runners (see docs/agents/ci-quality.md).
- It records exact peak claimed jobs, vectors and UTF-8 input bytes in flight,
  effective claim limits and returned batch sizes, lease claim count, maximum
  attempts, and completion latency. Absolute latency
  is reported rather than threshold-gated because host load is not a product
  invariant. Claim/completion spies maintain an in-memory set of active claimed
  job IDs, so the observer adds no database query before heartbeat arming.
  Reported latency is not a product baseline. `peakClaimedJobs` is sampled
  post-claim and depends on the worker preserving reserve-before-claim
  ordering. The deterministic gates are
  a pre-claim permit rendezvous proving every requested polling loop starts,
  one claim per job, exact claim limit and returned batch size 1, and observed
  concurrency scaling from 1 to 2 to 4 before flattening at the four-job global
  working-set ceiling when sixteen loops poll. The first-wave rendezvous targets
  `min(concurrency, maxInFlightJobs)`, which makes the overlap proof structural
  without deadlocking loops parked on the in-flight budget.
- The adaptive scenario begins with a slow synthetic model (claim limit 1),
  then accelerates it (claim limit 4), proving the runtime consumes changing
  throughput policy without exceeding the same global budget.
- Focused run:
  `pnpm --filter @brainstrike/embeddings exec vitest run --config vitest.integration.config.mts --maxWorkers=1 --no-file-parallelism src/__tests__/embedding-queue-load.integration.test.ts`.

Foreground query coordination (desktop):
- The hidden host runs BOTH background indexing and assistant query embeddings; a
  foreground query must never share the GPU with background indexing.
- `createForegroundEmbeddingGate()` (packages/embeddings/src/worker/foreground-embedding-gate.ts),
  exposed via `@brainstrike/embeddings/worker`:
  - The worker's `waitForBackgroundPermit('embedding claim')` awaits the gate, so no NEW
    indexing batch starts while a query is in flight. Only the *claim* permit is gated
    (never completion) — this keeps draining deadlock-free.
  - The query handler drains the in-flight batch via `waitForWorkerIdle` (waits for the
    worker `active` flag, which is true only during inference) before generating, via
    `runCoordinatedQueryEmbedding`.
- The pure foreground-gate suite controls polling and reopen time with fake timers,
  restores timer state after every case, and checks release on success, failure and
  drain timeout. Never substitute a wall-clock sleep for a debounce assertion.
- Wiring: `embedding-worker-config.ts` (`composeClaimPermit`) +
  `embedding-host-runtime.tsx` (gate per runtime, threaded to the worker config + query
  handler). Constants: FOREGROUND_GATE_REOPEN_MS (250), QUERY_DRAIN_TIMEOUT_MS (5000).
- Foreground DB-pressure permits age scheduler quiet/latency windows from the
  scheduler's monotonic snapshot timestamps (the timestamp pair shares one
  clock origin even when snapshots cross IPC). The embedding claim path's
  bounded starvation bypass uses `performance.now()` in the hidden renderer.
  Wall-clock corrections must not extend either wait.

Workspace indexing QoS ownership:
- `@brainstrike/indexing-contract/workspace-indexing-qos` is the canonical,
  renderer-safe policy shared by app-shell scheduling and the desktop embedding
  host. `@brainstrike/indexing-contract/workspace-indexing-power-snapshot` owns
  the plain-data power snapshot contract and normalization.
- Keep these contracts in `indexing-contract`, not a general utilities package
  or a platform implementation. Desktop supplies capabilities and snapshots;
  the shared policy remains free of Electron imports.
- Invalid power snapshots throw through the shared normalization/validation
  contract. Do not add implicit environment defaults at an import boundary.
- QoS observers log initial observations and state transitions at info; a
  reason-only transition uses the distinct debug message `Workspace indexing
  QoS reason changed` (BST-1337). The observer retains the latest reason even
  with debug disabled. Each loop owns its observer; logging never controls
  scheduling. `accelerator-idle` can change pipeline overlap, stream capacity,
  and app-shell batch sizes while staying `balanced` (worker claim size stays
  16). This is capacity feedback, not a pause/resume edge; foreground, memory,
  battery, and thermal constraints still take precedence immediately. Do not
  add a telemetry debounce that delays those constraints. Coverage:
  `packages/indexing-contract/src/__tests__/workspace-indexing-qos.test.ts`.

Embedding queue factory registration (visible renderer):
- `TransformersBackend.initialize` (local-model semantic search, prompt-library
  embedding, …) requires a queue factory registered in
  `@brainstrike/embeddings/runtime-config` — there is deliberately NO implicit
  bootstrap in `getBrowserQueue()` (it throws "Embedding queue factory is not
  registered"). The owning platform must register explicitly at startup:
  - Web: `registerWebEmbeddingRuntimeConfig()` (apps/web/src/create-embedding-queue.ts),
    called from the web root layout's mount effect.
  - Desktop: `registerDesktopEmbeddingRuntimeConfig()`
    (apps/desktop/src/renderer/create-embedding-queue.ts), called from the
    desktop root layout's mount effect.
  Both register the streaming worker URL plus a LAZY factory — the workerpool is
  only constructed on first use.
- `DatabaseDemoPanel` scopes its own queue factory over the app-level one while
  mounted and RESTORES the previous factory on unmount (never resets to null
  over an app-level registration — that was the "semantic search breaks after
  visiting the Database tab" regression). Proof: database-demo-panel.test.tsx +
  create-embedding-queue.test.ts (web + desktop) + root-layout-content.test.tsx.

Environment variables:
- VITE_EMBED_CONCURRENCY (default 1)
- VITE_EMBED_LEASE_MS (default 60000)
- VITE_EMBED_MODEL_KEY (e.g. local:Xenova/bge-m3, openai:text-embedding-3-small)

Do not move or reintroduce workers in Electron main. Desktop local embeddings must stay in the hidden renderer host.

Embedding runtime telemetry (BST-402):
- The streaming worker reports exact bytes for the unique `ArrayBuffer`s transferred in
  each batch, current/peak vectors in flight, and pipeline-cache residency diagnostics.
  The client validates the complete batch before telemetry, callbacks, or acknowledgement:
  index/count fields are safe integers, vector counts and shapes agree, current vectors do
  not exceed the peak, and transfer bytes equal the unique received buffers. A malformed
  batch is a terminal worker failure. Stream completion is equally strict: metadata must
  match the request model, dtype, deterministic batch size, and a coherent direct-device or
  WebGPU-to-WASM fallback pair; batch size and dimensions must also agree with observed
  batches before the client resolves.
- Cache memory is an estimate from the model registry's declared `size`, parsed strictly
  into binary bytes. WebGPU entries attribute that estimate to GPU memory and WASM
  entries to heap memory. Missing registry metadata remains explicitly unavailable; it
  is never presented as a measured browser-memory value.
- Pipeline-cache residency policy has one implementation:
  `packages/embedding-worker/src/pipeline-cache-controller.ts`. The production worker
  injects the real Transformers.js loader; the controller owns the 1-WebGPU/3-WASM
  limits, LRU/idle eviction, disposal, and diagnostic snapshots. A miss reserves its
  logical cache slot synchronously. Request and cache-clock validation finish before any
  eviction or loader call, so a rejected request cannot orphan a physical allocation. The
  replacement loader cannot allocate until the evicted resource's possibly asynchronous
  `.dispose()` completes. Concurrent misses
  therefore remain deduplicated and physically bounded. Pending entries are reservations,
  never resident-limit or idle-timeout eviction victims: if every device-class slot is
  pending, a distinct miss fails immediately with a request-scoped load-failure diagnostic
  and can be retried once capacity becomes available. This prevents a pending caller from
  receiving a resource that a concurrent miss already disposed. A resident-limit disposal
  rejection blocks the pending replacement and emits its request-scoped load-failure
  diagnostic. Every disposer rejection latches the controller against future loads, remains
  visible to `wait` and `close`, and asks workerpool to replace the failed worker through its
  managed lifetime-error channel. A direct worker has no such channel, so an idle disposer
  failure is re-reported immediately through the owner-visible uncaught-worker-error path;
  the streaming client then fails and retires that worker. BST-369's deterministic
  browser proof now routes ordinary queue tasks through a private
  `createBrowserEmbeddingQueue` (`minWorkers = maxWorkers = 1`), workerpool's
  `runEmbedding` RPC, and the actual `embedding.worker.ts` module. A wrapper installs a
  one-shot, fixed synthetic Transformers runtime before dynamically importing that
  production worker. Its allowlisted pipelines retain page-touched 8 MiB WASM or 16 MiB
  GPU-class `Uint8Array` stores until the production controller awaits their deliberately
  asynchronous `.dispose()` method. The physical ledger sums each live allocation's actual
  `store.byteLength`, not declared model metadata. Every cross-origin HTTP(S) request and
  the same-origin `/api/hf/` proxy are aborted and asserted absent; malformed, duplicate,
  or late runtime bootstrap attempts throw rather than falling back.
- The probe is lazy: normal app startup does not import its page module or worker. The
  native page `navigator.webdriver === true` signal plus an explicit pre-bootstrap init
  flag control exposure. Chromium's `WorkerNavigator` does not expose `webdriver`, so the
  worker uses the wrapper's fixed one-shot attestation as defense in depth rather than
  claiming a second native webdriver signal. Inputs, model IDs, sizes, and switch counts
  are fixed and bounded; the external hook accepts no arguments.
- BST-369's physical assertion is intentionally scoped. It proves browser-worker JS
  backing-store residency and reclamation for both WASM and a **logical GPU-class proxy**;
  it does not claim to measure GPU VRAM or real model inference. The test also asserts the
  production telemetry estimate (three WASM plus one GPU-class resident), 23 transferred
  result buffers, 18 exact resident-limit disposals, no runtime failure telemetry, and
  telemetry-source removal on queue teardown.
- Browser memory sampling uses only cross-origin-isolated
  `performance.measureUserAgentSpecificMemory()`. The performance project pins Chromium
  with `ForceEagerMeasureMemory`; missing capability, malformed totals, missing dedicated
  worker attribution, mixed page/worker attribution that cannot isolate the probe, or
  surviving attribution after teardown all fail. Two animation
  frames separate `Worker.terminate()` from the final sample because invoking Chromium's
  API in the termination task can remain pending before the agent teardown commits.
  There is no `performance.memory` fallback. Paired tests:
  `test-runtime-bootstrap.spec.ts`, `pipeline-cache-controller.spec.ts`,
  `pipeline-cache.spec.ts`,
  `pipeline-cache-controller.browser.test.ts`,
  `embedding-model-switch-memory-probe-contract.test.ts`,
  `apps/web/src/__tests__/web-e2e-test-hooks.test.tsx`, and
  `apps/web/e2e/performance/embedding-model-switch-memory.test.ts`.
- `StreamingEmbeddingWorkerClient` and every worker in the non-streaming browser
  workerpool own source-scoped, in-memory telemetry records. The workerpool records the
  unique buffers transferred with each completed result and forwards pipeline-cache
  diagnostics emitted during `runEmbedding`. Worker-global diagnostics that occur after
  an RPC settles (notably the five-minute idle-cache eviction) travel over a pool-unique
  `BroadcastChannel`; its name is carried in the managed worker script fragment. Request-scoped
  cancellation travels over a separate adapter-to-worker channel derived from that identity,
  so sibling workers never consume one another's telemetry as control traffic. Abort signals stop
  `runEmbedding` between inference batches and reject with `AbortError` without calling
  workerpool's destructive `Promise.cancel()`, so the loaded pipeline remains reusable. The
  adapter clears request-control state on settlement and removes every signal listener during
  cleanup; malformed control messages fail the worker lifetime visibly instead of being
  ignored. The
  device-loss path announces its source identity on that channel before self-closing, so
  the adapter removes the source immediately; the termination callback remains an
  idempotent cleanup seam. Active workerpool device-loss, uncaught-error, and
  unhandled-rejection events carry the affected request ID (never a global sentinel),
  preserving strict task correlation and the recoverable failure message. Active direct
  streams receive the same request-scoped global-failure message before the worker closes.
  A worker self-terminates after a global failure only when it has notified at least one
  active owning transport, so workerpool cannot reuse an invocation still running inference
  and a direct stream cannot remain pending. Idle global failures retain the explicit
  `global` sentinel and do not silently self-close. An idle pool worker sends a validated
  worker-lifetime error over its managed channel and synchronously quarantines itself before
  publishing, so channel-delivery latency cannot admit another RPC. The adapter terminates
  that pool, gates new executions on recovery, and creates the replacement before accepting
  another task. It retains retired pool identities until adapter teardown so already-queued,
  validated lifetime events from an old generation are ignored without weakening rejection
  of identities that were never assigned to the adapter.
  An idle direct worker instead re-reports an unhandled rejection through the browser's
  uncaught-worker-error channel so the existing client listener visibly fails and retires
  it. Active direct streams each also receive their own request-scoped device-loss message.
  A validated request-scoped worker error is
  terminal: the workerpool adapter emits it for diagnostics, cancels the RPC, and rejects
  the task even if the worker later tries to return vectors.
  Embedding-host Stop joins any pending startup before acknowledging `stopped`.
  A startup that finishes during Stop yields its controller to that stop owner;
  startup failures remain logged but cannot publish a competing terminal status
  for an operation Stop is still draining. New starts await the tracked stop, and
  no stop acknowledgement leaves a late-starting worker behind.
  A database-owner change joins the previous worker's Stop. A failed join reports
  an error and does not start the replacement worker. Effect disposal logs its
  rejection, and reset reports its failure; neither leaves a detached rejected
  lifecycle promise.
  Stop terminal reports echo the existing control request ID. Main matches that
  ID, so a queued startup error or prior stop cannot settle another command;
  an actual stop failure reports the same identity and fails visibly.
  Reset drain failures also echo their exact request ID under the original runtime
  ID: main accepts that owned failure while awaiting the proposed next runtime,
  preserves the original error, and destroys the failed owner before any new start.
  An unrelated old-runtime error cannot settle reset. Closing or destroying an
  owned host rejects its pending lifecycle waits immediately with an explicit
  window-closed error; disappearance is not a fabricated successful Stop ack.
  The shared vector UI projects out only the host's `commandId` acknowledgement
  when storing desktop status (initial read, subscription, start/reset/stop).
  Host acknowledgement matching retains the field; unknown UI status extensions
  still fail canonical validation, and embedding metadata remains intact.
  A trusted status report also proves the renderer registered its control listener.
  Disposal cooperatively drains that renderer even while worker startup is pending;
  only a startup that has never reported readiness is destroyed without an ack.
  Controlled host restarts publish a metadata-free `starting`
  transition and retain the latest valid snapshot, while terminal `stopped` and `error`
  states clear it. The
  adapter requires that capability, validates the complete discriminated cache diagnostic
  and every cache-entry/memory field, requires subject entries for hit/load/removal events,
  and requires every non-hit event to carry a unique full snapshot whose entry count matches
  `cacheSize`. The streaming client uses that same indexing-contract validator for both
  request-scoped and id-less diagnostics and terminally tears down malformed workers. The
  workerpool adapter requires worker-lifetime channel traffic to be id-less,
  terminates the affected pool on malformed traffic, and closes the channel during pool
  teardown. Streaming workers without that fragment deliver worker-global diagnostics over
  their direct worker message transport. Each pool worker receives a unique
  `WorkerOptions.name`; that identity is emitted with cache diagnostics. The same UUID is
  carried in a fragment on that worker's script URL because workerpool 10.0.3 omits
  `workerOpts` from its runtime termination callback despite declaring it in the public
  type. The callback-preserved script identifies and clears only the terminated worker's
  source. Full pool shutdown clears any remaining observed sources. Streaming workers
  likewise clear their own source during explicit shutdown. The workerpool option type
  requires its renderer-owned telemetry sink, matching the runtime guard; composition roots
  pass `embeddingWorkerTelemetrySink` explicitly and there is no telemetry-free compatibility
  mode. A missing workerpool cache
  diagnostic latches a session-level telemetry-health failure and logs the task identifier,
  but it never converts otherwise valid vectors into a failed embedding result. The bounded,
  code-authored failure reason remains visible until the renderer session ends; it contains
  no task payload or user data. Malformed diagnostics remain terminal because their identity
  cannot be trusted. A rejected streaming batch
  callback terminally fails and terminates its worker so the unacknowledged stream and its
  telemetry source cannot remain alive. Every malformed streaming request receives a
  request-scoped terminal error event, including failures detected while building or
  validating its context. Cross-process telemetry snapshot validation derives the expected
  cache residency, unavailable-memory count, and byte totals from the validated entries and
  rejects mismatched aggregates rather than normalizing them. No model weights, vector
  values, input text, paths, or content are retained by the telemetry store.
- On desktop, the hidden embedding-host renderer remains the source of truth. It reports
  a validated snapshot through the existing typed host-status bridge; Electron main
  stores/relays that snapshot but never observes or runs inference. Stopped host reports
  retain the current renderer-session snapshot so a latched telemetry-health failure
  remains visible after an explicit worker stop. A terminal repeated-device-loss report
  likewise awaits controller teardown and captures a fresh post-teardown snapshot, so it
  cannot advertise stale worker residency. While desktop System Diagnostics is open, it
  reads the full platform snapshot only on mount or explicit refresh; embedding-host status
  events carry a complete telemetry snapshot that the panel validates and applies directly.
  This avoids turning the host's frequent status cadence into overlapping full diagnostics
  reads. An explicit refresh clears the prior status override before accepting the refreshed
  platform snapshot, so stopped-host residency cannot remain stale. Invalid status telemetry
  is surfaced visibly without clearing an independent platform-snapshot collection error.
  A terminal `stopped` or `error` host status that lacks runtime metadata replaces the
  displayed telemetry with an empty snapshot, preventing a crashed or closed renderer's
  cache residency from remaining visible. Transitional metadata-free statuses retain the
  latest snapshot. Web diagnostics read the same renderer-local store directly.
- This telemetry is intentionally session-only and must not be persisted. A future
  persistence or export path requires the diagnostics privacy and factory-reset contracts
  to be revisited explicitly.

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

---


## LOCAL LLM ARCHITECTURE (CRITICAL)

Renderer-only execution is mandatory for the built-in local LLM path.

Rules:
- Local Gemma inference MUST run in renderer (browser context).
- MUST NOT run in Electron main process.
- Desktop MUST use the hidden `llm-host` renderer for built-in local LLM work.
- Web MUST use the browser-safe `@brainstrike/agent/local-llm` entrypoint.

Reasons:
- Transformers.js Gemma runtime depends on browser/WebGPU surfaces that are renderer-only.
- Running model load/generation in Electron main would degrade to the wrong runtime surface and risks UI/process instability.
- Hidden-host execution avoids visible-renderer throttling and keeps the UI responsive during model warmup/generation.

Flow:
1. Hidden host renderer (desktop)
   - Files:
     - apps/desktop/src/llm-host-manager.ts
     - apps/desktop/src/hidden-preload.ts
     - apps/desktop/src/ipc-llm-host.ts
     - apps/desktop/src/llm-host-shared.ts
     - apps/desktop/src/renderer/components/llm-host-app.tsx
     - apps/desktop/src/renderer/components/llm-host-runtime.tsx
   - Main creates a hidden BrowserWindow with `?mode=llm-host`.
   - The window loads the `llm-host` capability manifest from
     `hidden-preload.js`; the manifest exposes only host request/report and
     logging capabilities, never the visible UI's secrets, assistant auth, or
     database bridges.
   - The host renderer owns `LocalLlmBackend` initialization, warmup, generation, and progress events.
   - The host renderer reports status/progress/response back to main over dedicated IPC channels.
2. Desktop chat path — local THROUGH the Mastra loop (data-stream)
   - `AssistantUiPanel` prop `localChatTransport` ('data-stream' on desktop,
     'local-runtime' otherwise) — set by the app-shell wrapper when the
     assistant backend AND `window.llmHost` bridge exist. Desktop local chat
     POSTs to the assistant server like hosted providers, gaining Mastra
     memory persistence, run events, tool guards, and the stream watchdog.
   - The renderer pre-warms the model (existing download-progress badge UX,
     `warmDesktopLocalModel` in local-runtime-adapter.ts) before the request;
     the server also warms as a safety net. Llm-host request timeouts are
     INACTIVITY windows (generate 5 min, warmup 20 min): every progress
     report extends the deadline by the full window, so long generations
     that stream progress survive while a silent/wedged host still times out.
   - `LocalLlmBackend.generate` SERIALIZES generations (single engine, single
     WebGPU session — overlapping model.generate calls corrupt it). The Mastra
     loop's chat steps and a local observational-memory observation can
     legitimately overlap; the backend queue is the chokepoint for every
     consumer (`dispose` takes a queue turn too). Do not rely on caller-side locks.
   - Engine-fault recovery (llm-host-runtime.tsx): a generate-stage GPU fault
     (narrow `ENGINE_FAULT_PATTERN` — high-signal substrings only) disposes the
     engine and RETRIES the generation ONCE, announced via a 'stage' progress
     report + logs (never silent). A fault that survives the retry reports the
     visible "engine was reset" error. Aborts never trigger recovery.
     `ENGINE_FAULT_PATTERN` also matches the ONNX-Runtime GPU-memory-exhaustion
     markers that carry NO "gpu" substring (`ortrun`/`bad_alloc`/`safeint`/
     `integer overflow`): prefilling a prompt larger than the device's WebGPU
     memory aborts ORT with one of those, and without matching them a single
     overflowed tool turn poisons local chat for the whole session.
   - Device-wedge escalation (engineReset flag): disposing the ORT session is
     NOT enough for a GPU-memory fault — it wedges the whole WebGPU DEVICE, and a
     transformers.js tensor-disposal leak (huggingface/transformers.js#860)
     keeps the leaked buffers alive, so the next generation reloads into a dead
     device. The renderer sets `LlmHostErrorDetails.engineReset` on the recovery
     error report; `LlmHostManager` escalates to a debounced host-window
     `reset()` (a fresh device) so the NEXT message recovers automatically. Only
     persistent faults (dispose+retry already failed) flag it, so it is not
     over-aggressive. Proof: llm-host-runtime.test.tsx + llm-host-manager.test.ts.
   - GPU prompt ceiling: the q4f16 Gemma 4 E2B WebGPU runtime OOMs at prompts in
     the low thousands of tokens (≈3-4K on a typical device — far below the
     architectural ~128K). Gemma 4 E2B is therefore declared at the RUNTIME
     budget `contextWindow: 8192` / `maxOutputTokens: 2048` in
     packages/assistant-contract/src/provider-registry.ts (NOT the architectural
     window) so the context-budget machinery + meter keep assembled prompts in
     the working zone; the engineReset escalation handles the residual
     device-dependent overflow. A leaner local system-prompt/tool-schema
     footprint is the deeper follow-up for reliable local tool-calling.
   - Loading badge smoothing (use-local-model-loading.ts): parallel per-file
     progress reports are folded into a mean aggregate with a stable
     "(completed/total)" message and the laggard file as the label, throttled
     to one update per 250ms (stage changes apply immediately). Unkeyed
     reports keep the monotonic floor instead.
   - Server side: `LlmHostManager.generateForMain/warmupForMain` (main-process
     client API with progress callbacks + AbortSignal cancel) →
     `createMainLlmHostClient` (packages/assistant-service/src/ports.ts — the
     service package's InferenceHostPort, moved from the desktop in BST-972 B1)
     is injected as `RuntimeData.localLlmHostClient`; provider-factory's
     'local' case resolves it to `LlmHostChatModel`
     (packages/agent/src/providers/local/llm-host-chat-model.ts) — a real
     LanguageModelV2 that converts cumulative host text/reasoning snapshots
     into incremental deltas. Before it emits any structured tool-call part, it
     revalidates the host result's arguments as a root JSON object. Malformed
     arguments fail as `local_tool_call_arguments_invalid`; they never reach
     Mastra approval or execution. NEVER serialized over IPC/HTTP.
   - The Mastra inactivity watchdog owns a run-scoped AbortController for every
     initial/resumed stream. On a stall it preserves the visible
     `stream_inactivity_timeout`, aborts the exact `generateForMain` signal,
     removes that manager request, and sends the matching cancel id to the
     hidden renderer. The renderer aborts only that generation, returns its
     active status to idle when cleanup settles, and keeps the warmed host
     reusable for the next send. Late progress/results have no pending manager
     owner and are ignored; a watchdog timeout never requires a manual
     `llmHost.stop()` or an engine reset.
   - Local memory models ride the same seam: 'local/<model>' observational
     memory targets resolve keyless to the proxy model; 'local/<model>'
     semantic-recall targets resolve to `createLocalHostEmbeddingModel`
     (queries proxied to the embedding host; dimensions from the models
     catalog). Both throw clear errors if their host manager is missing.
   - Live-loop proofs (no agent mocks): packages/agent/src/__tests__/
     mastra-local-host-execution.spec.ts (chat + tools through the real
     provider factory) and the local-OM test in mastra-memory-persistence.integration.spec.ts.
3. Visible renderer (web local chat, and desktop status/warmup UX)
   - Files:
     - packages/assistant-ui/src/local-runtime-adapter.ts
     - packages/assistant-ui/src/use-local-model-loading.ts
     - packages/app-shell/src/assistant-ui-panel-wrapper.tsx
   - Does NOT run the built-in local LLM directly in desktop mode.
   - Talks to the hidden host over the preload bridge (`window.llmHost`).
   - WEB still uses the in-renderer `LocalRuntimeChat` (assistant-ui local
     runtime; session-only, no Mastra loop) — there is no assistant server in
     the browser.
4. Main
   - Files:
     - apps/desktop/src/main.ts
     - apps/desktop/src/preload.ts (visible UI only)
     - apps/desktop/src/hidden-preload.ts (role-selected hidden hosts)
   - Does NOT execute Gemma inference in-process (the Mastra loop runs in
     main, but every generation is proxied to the hidden llm-host renderer).
   - Owns hidden-host lifecycle, IPC registration, and shutdown/reset coordination.
   - `RendererHostLifecycle` assigns the server-owned window role before load,
     pins every hidden window to `hidden-preload.js`, and passes exactly one
     matching role argument. Missing, duplicate, and unknown manifest roles
     fail closed. Sensitive main-process IPC remains independently
     sender-authorized, so a future preload packaging regression cannot restore
     secret or assistant-auth access.
5. Shared local runtime
   - Files:
     - packages/agent/src/local-llm.ts
     - packages/agent/src/providers/local/local-llm-backend.ts
     - packages/agent/src/providers/local/gemma4-engine.ts
     - packages/agent/src/providers/local/local-model-specs.ts
     - packages/agent/src/providers/local/local-artifact-store.ts
     - packages/agent/src/providers/local/local-message-conversion.ts (shared
       AI-SDK v2 ↔ local dialect: preserves assistant tool calls, parses V2
       tool-result `output` envelopes, and normalizes JSON Schema nullable
       unions into the Gemma template's `type` + `nullable` dialect)
   - `local-llm.ts` is the browser-safe entrypoint for renderer usage.
   - `LocalLlmBackend` is a thin orchestrator over the Gemma engine/spec/artifact layers.
   - On web, tool calls are executed through the UI/runtime tool bridge; on
     desktop they run through the Mastra agent loop like hosted providers.
6. Web Hugging Face proxy contract
   - Files:
     - packages/assistant-contract/src/local-llm.ts
     - packages/assistant-contract/src/local-llm-model-specs.ts
     - apps/web/src/hf-proxy-contract.ts
     - apps/web/src/hf-dev-proxy.ts
     - apps/web/src/app/api/hf/[...path]/route.ts
   - `GEMMA4_E2B_MODEL_ID` and `GEMMA4_E2B_REVISION` are the canonical built-in
     model identity. `hf-proxy-contract.ts` derives `ALLOWED_MODEL_ID` and
     `ALLOWED_MODEL_REVISION` from those exports and exclusively owns the web
     proxies' Hugging Face base URL and header allowlists.
   - Both proxy consumers import that shared contract. The production route
     pins `ALLOWED_MODEL_REVISION`; the development proxy intentionally accepts
     any revision below the allowed model's resolve path. Do not duplicate the
     model, revision, URL, or header values in either consumer.
   - Verification: `node --test scripts/__tests__/hf-proxy-contract-ownership.test.mjs`
     plus the web proxy unit tests (`pnpm --filter @brainstrike/web test`).

Constraints:
- Built-in local model downloads are manifest-based, not single-file heuristics.
- Thinking/reasoning output must be kept separate from the final visible answer.
- Control tokens (`<turn|>`, EOS markers, tool-call wrappers, etc.) must be stripped from visible output.
- Cumulative Gemma snapshots and the authoritative decoded result use the same
  protocol projection in `gemma4-engine.ts`: incomplete tool-call protocol is
  withheld while streaming and fails visibly if still incomplete in the final
  decode; complete tool-call blocks become structured calls only, and known
  response/quoting markers are removed. A completed unknown protocol token
  throws visibly. For the built-in Gemma model, `LlmHostChatModel`
  independently rejects known unprojected protocol markers in a host snapshot
  before emitting a text/reasoning delta; ordinary XML-like prose remains
  visible.
- Complete local tool calls require arguments that parse as a root JSON object.
  `gemma4-engine.ts` rejects malformed output during normalization, and the
  shared provider projection revalidates hidden-host results before emitting a
  callable part. Both paths use the bounded typed
  `local_tool_call_arguments_invalid` failure without retaining or guessing
  executable text. Desktop preserves that code across the hidden renderer/main
  boundary; the Mastra stream surfaces it as visible text plus typed
  `run.failed` metadata. Valid calls are canonicalized once so the provider
  part, durable approval snapshot, resume, and execution observe the same
  arguments.
- Local Mastra generations inherit `maxOutputTokens` from the selected model's
  static provider-registry definition unless the run explicitly overrides it.
  A missing local output budget is an initialization error; never fall back to
  the proxy model's generic token cap.
- Gemma tool schemas are validated before templating. The converter accepts a
  no-argument empty schema as an object, or a single schema plus `null`
  expressed through `anyOf` or a type array and rewrites it explicitly;
  unsupported unions throw with the tool/property path instead of reaching the
  template or silently weakening the contract.
- If you change the local host lifecycle, preload bridge, or availability gating, update this section and the relevant tests.

---

Disposing an embedding host during `starting` cancels its lifecycle directly:
the renderer may still be awaiting DB setup and have no command listener yet.
Do not send Stop and wait for its acknowledgement in that state. The existing
lifecycle disposal destroys the owned window and rejects startup/status waiters;
a running host still uses its normal worker Stop protocol with a 3s acknowledgement
bound inside the application's unchanged 5s shutdown deadline. Missing acknowledgement
or an explicit renderer error destroys the owned renderer and remains a reported
stop failure. Manager/lifecycle
unit tests and the delegated worker's real restart test cover this boundary;
the latter requires both Electron processes to exit cleanly with code zero.

Desktop test teardown requests application quit while hidden host windows still
exist. Do not pre-close every Playwright window: removing hidden renderer command
listeners before the main shutdown coordinator drains owners races Stop acknowledgements.
Foreground child decision coverage asserts actual process exit zero as well as UI success.
