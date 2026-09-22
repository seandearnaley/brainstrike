# Embedding runtime telemetry (BST-402), pipeline cache, and worker lifetime — evidence

Supports `docs/agents/local-inference.md` § "Embedding runtime telemetry". Read
before changing batch validation, the pipeline-cache controller's residency
limits or disposal ordering, worker-lifetime and device-loss channels, the
BST-369 browser probe, or the host Stop/reset protocol. This is the longest
record in the area and the contract keeps only its rules.

## Original text

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
  A reported replacement-start failure also retires that renderer. A later Start
  creates a fresh host; an unsuccessful Stop never authorizes reusing uncertain work.
  The renderer's command subscription survives database-worker Effect replacement.
  Stop joins the last worker's drain even while no DB is mounted, and an explicit
  Stop fences later DB-driven starts until an authorized reset or a fresh renderer.
  Reset requires a current DB owner; it never restarts through a retired DB Effect.
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
