# Local Inference: Embeddings + Local LLM (CRITICAL)

> Read before touching embedding or LLM hosts, hidden preloads, workers, or local
> chat. Local inference runs ONLY in hidden renderer hosts, never in Electron
> main. See ADR-0007. Rules here are true now; the record behind each is in
> `local-inference/<topic>.md`.

## EMBEDDING ARCHITECTURE (CRITICAL)

### Hidden host execution boundary

- Run the embedding worker in a renderer. Why: Transformers.js needs Web Workers;
  in main/Node it degrades to synchronous WASM and freezes the UI.
- Main owns host-window lifecycle, IPC, DB init and power lifecycle and runs no
  embeddings in-process. Do not reintroduce workers there.
- The hidden window is `?mode=embedding-host` on `hidden-preload.js` under the
  server-owned `embedding-host` role. That manifest carries the embedding bridge,
  power snapshot/events, logging ingest, the database capabilities the
  renderer-owned queue needs, the read-only database integrity state (BST-1870), and the scoped vector-preferences capability — never
  provider secrets, assistant-server credentials, or the visible UI's unrestricted
  `storage` bridge.
- The host mounts `DbProvider` with `useElectronIPC=true`, runs
  `startEmbeddingWorker()`, and pulls from the PGlite-backed `job_queue`. The
  visible renderer drives it over `window.embeddingHost` and starts no worker.
- Only the hidden host disables background throttling; a macOS `powerSaveBlocker`
  runs only while it reports active embedding work, never on other platforms.

Evidence: `local-inference/hidden-host-manifest.md`.
Guard: `hidden-preload-contract.test.ts`, `hidden-preload-runtime.test.ts`.

### Canonical profile and document adapter

- Resolve the actual authorized PGlite embedding-set metadata without writing
  preferences or enabling vectors. Preserve hosted provider/model identity;
  local execution requires explicit saved device, dtype and revision choices
  accepted by the public `@brainstrike/embeddings/inference-plan` resolver.
- Admit 1–64 ordered, unique, nonblank chunks. Reject missing own array entries
  before authority lookup or transport; validate complete profile identity,
  vector cardinality, dimensions and finite values before publication.
- Supply `NativeCanonicalInference` only with a document relay whose promise
  settles after physical hidden-renderer completion or joined host retirement
  on every outcome. Keep cancellation ownership until that settlement and
  preserve independent errors through generate/cancel/join/close.

Evidence: `local-inference/2026-10-03-canonical-profile-adapter.md`.
Guard: `native-canonical-profile.test.ts`,
`native-canonical-profile.integration.test.ts`, `inference-plan.test.ts`.

### Canonical VECTOR consumption

- Admit inference only through an explicit VECTOR canonical host with current authorized saved profile and native missing-chunk plan. Join generate/cancel/join and cancellation notices before publication/completion, preserving independent errors and failed cleanup ownership.

Evidence: `indexer/2026-10-03-canonical-vector-pipeline.md`.
Guard: `packages/canonical-ingestion/__tests__/vector-host.test.ts`.

### Vector device preference

- Host and visible UI resolve `devicePref`/`devicePrefConfigured` from the SAME
  `vector-preferences.v1` record: the UI via `electronAPI.storage`, the host via the
  scoped `electronAPI.vectorPreferences` capability, authorized to the
  `embedding-host` role only. Those channels accept no key —
  `apps/desktop/src/platform/vector-preferences-storage-key.ts` pins it in main.
- `vector-preferences-store.ts` throws when an Electron renderer exposes neither
  capability. Why: zustand's persist middleware swallows storage rejections and
  resolves `rehydrate()` anyway, so a swallowed read presents as "unconfigured, use
  WebGPU".

There is one canonical record; a recurrence is not fixed by relaxing the E2E
assertion or re-exposing the full storage bridge. Evidence:
`local-inference/vector-device-preference.md`.
Guard: `vector-preferences-store.hidden-host.test.ts`,
`vector-preferences-storage-key-contract.test.ts`, `storage-preferences-ipc.test.ts`.

### Fused MiniLM input and batching

- An explicit model revision reaches the vendor loader, isolates pipeline caches,
  and must match the completion revision. Omitted revisions preserve existing behavior.
- Request the fused export by its explicit `FUSED_MINILM_MODEL_ID`; never substitute
  it for an existing model ID or reuse that model's derived vectors. Choose dtype
  explicitly from that export's available assets; a missing dtype fails visibly.
- Cap this export at 256 tokenizer tokens, including special tokens. Keep input
  order and each inference batch within both the caller's count ceiling and 8192
  padded tokens; stream completion reports the maximum observed batch size.

Evidence: `local-inference/fused-minilm-worker.md`.
Guard: `embedding-input-plan.spec.ts`, `streaming-worker-client-completion.spec.ts`,
`pipeline-cache-controller.spec.ts`, `embedding-worker-protocol.test.ts`,
`embedding-telemetry.spec.ts`, `transformers-backend.queue.test.ts`.

### Explicit native vector request plan

- Resolve a native vector identity only from an explicit renderer worker plan:
  model, immutable revision, device, dtype and dimensions. The pinned export
  resolver validates supported combinations and token caps; selected model
  ID/key/dimensions alone establish neither revision nor actual dtype.
- Native hidden-host query requests carry the full verified `inferencePlan`, matching
  payload model ID and dimensions. Preserve revision through preload and scalar
  queue projection; cache the full identity and initialize its explicit target
  dimensions without legacy catalog or device-preference resolution.
- Native document requests require the same verified plan and 1–64 unchanged
  texts; use document `generateEmbeddings` semantics and preserve output order.
  Query and document work share one FIFO, cache identity and physical inference
  owner; both public query and document promises and pending identities settle only after completion or joined retirement on every outcome.
- Preserve caller cancellation reasons; distinguish the host's exact cancel code from independent failures. Aggregate Stop and every failed destruction attempt in the shared retirement outcome before publishing inference rejection. Sending cancel never proves settlement.
- Restore a queue caller's abort reason only after settled worker-owned cancellation matches its exact task ID and discriminator; preserve independent errors, including unrelated `AbortError`s.
- Keep AbortSignal in the caller renderer. Visible query and document bridges carry
  a plain token; main authorizes the visible sender/frame and maps token cancellation
  to the exact hidden runtime/request, including host startup. Refuse an unavailable
  cancellation capability or failed delivery explicitly.
- Give each native semantic search its own inference signal; abort it on supersession,
  cancellation or consumer teardown. Join physical query settlement and cancellation
  delivery before discarding its result. Normalize only main's explicitly acknowledged
  owned cancellation; reject duplicate or replayed query tokens for that sender.
- Require actual completion model, immutable revision, device, dtype, dimensions
  and vector count to match pinned scalar requests, with no fallback. Missing or
  mismatched metadata fails before returning a vector.
- Forward the resolved worker plan unchanged to renderer inference. Refuse
  unresolved or unsupported vector selections visibly without model substitution.
  Text-only native store startup does not initialize or download an embedding model.

Evidence: `local-inference/native-vector-request-plan.md`,
`local-inference/native-hidden-query-plan.md`,
`local-inference/native-hidden-document-plan.md`, `local-inference/document-transport-settlement.md`, `local-inference/query-transport-settlement.md`, `local-inference/native-search-query-cancellation.md`.
Guard: `packages/embeddings/src/__tests__/inference-plan.test.ts`,
`transformers-backend.queue.test.ts`, `packages/queue/src/__tests__/types.test.ts`,
`embedding-host-shared.test.ts`, `embedding-host-runtime.test.tsx`,
`preload-contract-bridges.test.ts`, `embedding-host-document-runtime.test.tsx`, `embedding-host-document-settlement.test.ts`, `embedding-host-query-settlement.test.ts`,
`renderer/document-embeddings.test.ts`, `main/ipc-embedding-host.test.ts`,
`native-search-query-cancellation.test.ts`, `renderer/query-embeddings.test.ts`, `native-search-provider.test.tsx`,
`packages/queue/src/__tests__/browser-workerpool.test.ts`, `packages/queue/src/__tests__/browser-workerpool-cancellation-reason.test.ts`, `packages/embedding-worker/test/embedding.worker.runtime.spec.ts`,
`embedding-host-physical-stop-ownership.test.tsx`, `use-workspace-search-controller.test.tsx`,
`scripts/probe-pinned-query-embedding.mjs`, `scripts/probe-pinned-document-embeddings.mjs`.

### Job queue and embedding input hash

- Reserve one runtime-wide in-flight budget before all `claimMany` loops (ceiling
  `claimBatchSize` or positive `maxInFlightJobs`). Release slots only after matching
  completion/failure writes, or cleanup after a lost lease or interrupted batch.
- Every durable `embed_chunk` payload carries `sourceContentHash` plus
  `embeddingInputHash` (lowercase SHA-256 of `${contentHash}:${resolvedModelKey}`),
  computed by every producer through `buildEmbeddingJobInputHashes` before enqueue.
  The worker requires the persisted source hash to match the loaded chunk, fails
  changed chunks terminally, and never recomputes the hash on the claim path. Add no
  legacy hashing fallback: migration 105 backfills provable jobs and visibly cancels
  those whose chunk/model identity cannot be proven.
- Desktop backfill admission bounds queued/running jobs by target `embedding_set_id`,
  takes earliest runnable jobs, and stays single-flight per set at IPC; the runtime budget is global.
- Settle each worker completion (at most 64 distinct chunks) before the next; count already embedded completions and failures only from
  rows returned by token-guarded `completeBatch`/`failBatch`, never stale leases.

Evidence: `local-inference/job-queue-input-hash.md`.
Guard: `packages/embeddings/src/__tests__/embedding-worker-already-completed-lease.integration.test.ts`.

### Background-indexing backfill ownership

- A `source: 'background-indexing'` backfill is owned by the host runtime, not the
  React tree that requested it. `cancel()` is a deliberate stop and cancels the host
  run; `detach()` is the requester going away and releases only local state. The
  provider's teardown effect MUST call `detach()`. Why: it re-runs on every `service`
  identity change, so cancelling there killed a backfill on navigation.
- The renderer loop and the backfill own SEPARATE abort controllers, and the signal
  passed to `enqueueBackfill` is the backfill's. Why: on web `enqueueLocalBackfill`
  merges the caller's signal into the run, so a shared controller let `detach()`
  destroy it.
- `cancel()` and the disabled `sync()` path enumerate `getBackfillsInFlight()` and
  cancel every run whose request id carries the `background-indexing-backfill:`
  prefix, leave unclaimed runs alone, and reject an undeliverable stop. Attempt every
  enumerated run and surface failures together as an `AggregateError`; isolation must
  not become silent success.
- `enqueueManagedBackfill` re-checks the backfill signal once the enqueue resolves, so
  at least one cancel is ordered after the run exists.
- Retain ready canonical HNSW indexes through bounded completions; never clear another maintenance owner. Missing/invalid indexes use scoped-drain recovery.
  Interruptions restore after drain or defer recovery; shutdown/integrity containment
  stops polling and leaves the durable suspension for maintenance (`database.md`).
- Renderer queue-health writes carry the completed poll's wall-clock time, kept apart
  from the deduped count snapshot; diagnostics read that timestamp rather than
  synthesizing freshness during render.

`detach()` is never the answer to a deliberate stop.
Evidence: `local-inference/backfill-ownership.md`.

### Renderer sync-loop coordinator

- Sync-loop ownership lives in the React-free `WorkspaceIndexingCoordinator`; the
  provider only updates current inputs and wires subscriptions.
- A focus-only input update must not invalidate active work. A restart or stop
  increments the generation before the previous promise settles; a stale generation's
  finalizer must not clear work owned by its replacement; and target resolution
  re-checks the generation after each await before reconciling roots or publishing
  status. A restart waits for the cancellation sweep, reports aggregated failures, and
  still starts the replacement.
- Take pause authority from the live arbiter boolean, never from whether its
  human-readable reason list is empty.

Evidence: `local-inference/sync-loop-coordinator.md`.

### Embedding telemetry diagnostics

- The System Diagnostics embedding card presents aggregate transfer, residency,
  memory-estimate, device-count and health-count data only — never cache keys, model
  names, source ids, failure strings, user content or vectors. An empty window is
  neutral (`No samples`); a telemetry-provider failure renders a fixed unavailable
  message and keeps its raw error internal.
- `peakVectorsInFlight` is a per-batch high-water mark, and aggregation across sources
  takes the maximum rather than summing peaks.
- Import `resetEmbeddingTelemetryForTests` from `@brainstrike/embedding-worker/testing`;
  it is absent from the production root API. App-shell tests use the production
  snapshot validator and empty-snapshot factory. Why: a shape-only mock hides desktop
  host boundary failures.

Evidence: `local-inference/embedding-telemetry-diagnostics.md`.

### Embedding input hash relocation benchmark

- `embedding-input-hash-benchmark.integration.test.ts` reports timings as diagnostics,
  never as a threshold gate; its deterministic checks require the historical and
  persisted filters to classify the same chunk IDs.
- Keep the historical arm verbatim — serial per-chunk awaits, the pre-BST-391 SHA-256
  helper and payload validator, fixtures omitting the new source-identity fields, and
  production-shaped 64-character lowercase hex hashes. Why: otherwise it silently
  absorbs relocated validation work.
- This suite and the queue-load suite set `concurrent: false`; their shared PGlite
  state stays serialized.

Historical-minus-persisted understates the hashing win rather than isolating
pure hash cost. Evidence: `local-inference/embedding-input-hash-benchmark.md`.

### Embedding queue load verification

- `embedding-queue-load.integration.test.ts` shares ONE lazily created `memory://`
  PGlite across its 1/2/4/16-loop matrix, closed in `afterAll`, kept disjoint by
  scenario-prefixed ids and dedupe-key-scoped SQL. Do not return to a fresh instance
  per scenario. Why: PGlite close leaves WASM teardown to GC, and teardown-overlapping
  instantiation was BST-1221's V8 fatal on PKU-enabled Linux x64 runners
  (`docs/agents/ci-quality.md`).
- Latency is reported, not gated; host load is not a product invariant. The gates are
  the pre-claim permit rendezvous, one claim per job, exact claim limits, and observed
  concurrency scaling up to the global in-flight ceiling.

Evidence: `local-inference/embedding-queue-load-verification.md`.

### Foreground query coordination

- Never overlap indexing and foreground inference; FIFO generations own isolated service caches and serialize selection, initialization and generation.
  Gate only `waitForBackgroundPermit('embedding claim')`, never completion, with one host gate.
- Failed background drain rejects before generation; `createForegroundEmbeddingGate`, `runCoordinatedQueryEmbedding` and `composeClaimPermit` share that gate.
- Generation close fences admission, aborts the active query's public signal and joins actual inference and owned cached-service disposal before replacement.
  Never join stale model reads, preference hydration or lightweight service initialization just to stop inference.
  Retire non-cooperative hosts through main's existing Stop (10s), shutdown (3s) and reset (30s) deadlines; never extend them.
- Gate tests control polling/reopen with fake timers and restore timers after each case.
  Never substitute a wall-clock sleep for a debounce assertion.
- Foreground DB-pressure permits age scheduler quiet/latency windows from the
  scheduler's monotonic snapshots; the claim starvation bypass uses renderer
  `performance.now()`. Wall-clock corrections must not extend either wait.
- Keep one mounted-host query listener; retrieval/hybrid signals reach both embedding transports.
  DB-unavailable requests fail explicitly; DB/run generations own query service/activity; stale completions cannot decrement current activity.
  Request abort/timeout cancels the exact runtime/request; missing capability or notice delivery rejects explicitly. Canceled FIFO work skips preparation; active inference stays owned until settlement.
  Timeout/interruption logs include provider, stage, elapsed time; never query text, endpoints, credentials, or vectors.

Evidence: `local-inference/foreground-query-coordination.md`, `local-inference/query-listener-readiness.md`, `local-inference/foreground-query-lifecycle-ownership.md`; guards: `embedding-host-foreground-ownership.test.tsx`, `embedding-host-physical-stop-ownership.test.tsx`, `embedding-host-reinitialization-readiness.test.tsx`.

### Embedding queue task yielding

- After a nonempty claimed batch settles, yield an abortable zero-delay task
  turn before claiming again. Do not add fixed inter-batch pacing; foreground
  admission remains owned by the claim permit, and idle/failure backoff remains separate.
- Stop cancels the pending yield and joins the worker before service disposal;
  completion settlement retains its admission ownership until it finishes.

Evidence: `local-inference/embedding-queue-task-yielding.md`.
Guard: `packages/embeddings/src/__tests__/embedding-worker-pacing.test.ts`.

### Workspace indexing QoS ownership

- `@brainstrike/indexing-contract/workspace-indexing-qos` is the canonical,
  renderer-safe policy shared by app-shell scheduling and the desktop host;
  `.../workspace-indexing-power-snapshot` owns the plain-data snapshot contract and
  normalization. Keep both in `indexing-contract`, free of Electron imports, and let
  invalid snapshots throw rather than adding environment defaults at an import boundary.
- Each loop owns its observer and logging never controls scheduling; a reason-only
  transition uses the debug message `Workspace indexing QoS reason changed`, and the
  observer retains the latest reason even with debug disabled.
- Treat `accelerator-idle` as capacity feedback, not a pause/resume edge: it may change
  pipeline overlap, stream capacity and app-shell batch sizes while staying `balanced`.
  Foreground, memory, battery and thermal constraints take precedence immediately — add
  no telemetry debounce that delays them.

Evidence: `local-inference/workspace-indexing-qos.md`.
Guard: `packages/indexing-contract/src/__tests__/workspace-indexing-qos.test.ts`.

### Embedding queue factory registration

- `TransformersBackend.initialize` requires a queue factory registered in
  `@brainstrike/embeddings/runtime-config`. `getBrowserQueue()` has deliberately no
  implicit bootstrap and throws "Embedding queue factory is not registered"; the owning
  platform registers explicitly from its root layout's mount effect, passing the
  streaming worker URL plus a LAZY factory.
- `DatabaseDemoPanel` scopes its own factory while mounted and RESTORES the previous
  one on unmount, never resetting to null over an app-level registration. Why: that was
  the "semantic search breaks after visiting the Database tab" regression.

Evidence: `local-inference/embedding-queue-factory.md`.
Guard: `database-demo-panel.test.tsx`, `create-embedding-queue.test.ts` (web +
desktop), `root-layout-content.test.tsx`.

Environment variables: `VITE_EMBED_CONCURRENCY` (default 1), `VITE_EMBED_LEASE_MS`
(default 60000), `VITE_EMBED_MODEL_KEY` (e.g. `local:Xenova/bge-m3`).

### Embedding runtime telemetry

- Validate a complete batch before telemetry, callbacks or acknowledgement, and
  validate stream completion as strictly; a malformed batch, stream, control message or
  lifetime event is a terminal worker failure, never something to ignore.
- Cache memory is an estimate parsed strictly from the registry's declared `size`;
  missing registry metadata stays explicitly unavailable, never a measured value.
- Pipeline-cache residency has ONE implementation,
  `packages/embedding-worker/src/pipeline-cache-controller.ts`, owning the
  1-WebGPU/3-WASM limits, LRU/idle eviction, disposal and diagnostics. Finish request
  and cache-clock validation before any eviction or loader call; let a replacement
  loader allocate only after the evicted resource's `.dispose()` settles; keep pending
  entries as reservations that are never eviction victims. Any disposer rejection
  latches the controller against future loads, stays visible to `wait` and `close`, and
  replaces a pool worker through workerpool's managed lifetime-error channel — a direct
  worker re-reports through the owner-visible uncaught-worker-error path instead.
- Keep worker-global diagnostics on the pool-unique `BroadcastChannel` and
  request-scoped cancellation on the separate derived channel, so siblings never consume
  one another's telemetry as control traffic. Abort between inference batches with
  `AbortError`, never workerpool's destructive `Promise.cancel()`, so the loaded
  pipeline stays reusable. Failures keep their request identity — only an idle global
  failure uses the `global` sentinel — and a worker self-terminates after a global
  failure only once it has notified an active owning transport.
- Browser memory sampling uses only cross-origin-isolated
  `performance.measureUserAgentSpecificMemory()`; there is no `performance.memory`
  fallback.
- Host Stop joins any pending startup before acknowledging `stopped` and echoes the
  existing control request ID (reset drain failures echo theirs under the original
  runtime ID). A failed join reports an error and does not start the replacement, and
  closing or destroying an owned host rejects its pending lifecycle waits with an
  explicit window-closed error — disappearance is never a successful Stop ack.
- On desktop the hidden renderer is the source of truth: main stores or relays its
  validated snapshot without observing or running inference. A terminal
  `stopped`/`error` status lacking runtime metadata replaces displayed telemetry with an
  empty snapshot; transitional metadata-free statuses retain the latest one.
- This telemetry is session-only and must not be persisted, and retains no model
  weights, vectors, input text, paths or content; a persistence or export path reopens
  the diagnostics privacy and factory-reset contracts.

BST-369's physical assertion proves browser-worker backing-store residency and
reclamation for WASM and a logical GPU-class proxy — it measures neither GPU VRAM nor
real model inference. Evidence: `local-inference/embedding-runtime-telemetry.md`.
Guard: `pipeline-cache-controller.spec.ts`, `pipeline-cache-controller.browser.test.ts`,
`test-runtime-bootstrap.spec.ts`, `embedding-model-switch-memory-probe-contract.test.ts`,
`apps/web/e2e/performance/embedding-model-switch-memory.test.ts`.

### Streaming payload-memory proof

- The transport's output-retention bound is `batchSize * dimensions * 4` bytes for
  uniform Float32 vectors: `streamEmbeddings` transfers one batch and awaits the
  matching request-and-index acknowledgement before the next. It bounds payload, not
  renderer RSS or heap.
- Keep the backpressure gate proved: `embedding.worker.runtime.spec.ts` (fails without
  `await waitForBatchAck(...)`) and `bst-372-current-retention.spec.ts` (peak delta bound).

The comparison boundary is a controlled replay of the exact source
implementations. Evidence: `local-inference/streaming-payload-memory-proof.md`.

### Embedding host lifecycle and shutdown

- During `starting`, cancel host lifecycle directly; DB setup may lack a Stop listener.
- A running host uses the worker Stop protocol with a 3s acknowledgement bound inside
  the 5s app shutdown deadline. A missing acknowledgement or renderer error destroys
  the owned renderer and remains a reported stop failure.
- Stop aborts hosted requests/local streams; never start another group after abort.
- A queued abort terminates the client and settles all streams with its exact reason.
- Only the exact Stop reason leaves unfinished jobs leased; independent errors still fail/retry, and reclaim adds an attempt.
- Desktop test teardown quits with hidden host windows open; pre-closing them removes
  command listeners and races the shutdown coordinator's Stop acknowledgement.

Evidence: `local-inference/host-lifecycle-and-shutdown.md`.

## LOCAL LLM ARCHITECTURE (CRITICAL)

- Run local Gemma inference in a renderer, never in Electron main: desktop through the
  hidden `llm-host` renderer, web through the browser-safe
  `@brainstrike/agent/local-llm` entrypoint. Why: the Transformers.js Gemma runtime
  depends on renderer-only browser/WebGPU surfaces, and hidden-host execution avoids
  visible-renderer throttling during warmup and generation. See ADR-0007.

Flow:
1. Hidden host renderer (desktop)
   - The `?mode=llm-host` window's manifest exposes only host request/report and
     logging — never secrets, assistant auth, or database bridges. The host owns
     `LocalLlmBackend` init, warmup, generation and progress, and reports over dedicated
     IPC channels.
2. Desktop chat path — local THROUGH the Mastra loop (data-stream)
   - `localChatTransport` is `'data-stream'` on desktop (set by the app-shell wrapper
     when the assistant backend and `window.llmHost` both exist), so local chat POSTs to
     the assistant server like hosted providers and gains memory persistence, run
     events, tool guards and the watchdog.
   - The renderer pre-warms via `warmDesktopLocalModel`; the server warms as a safety
     net. Llm-host timeouts are INACTIVITY windows (generate 5 min, warmup 20 min):
     every progress report extends the deadline by the full window.
   - `LocalLlmBackend.generate` SERIALIZES generations — one engine, one WebGPU session,
     and overlapping `model.generate` calls corrupt it. That queue is the chokepoint for
     every consumer (`dispose` takes a turn too); do not rely on caller-side locks.
   - A generate-stage fault matching the narrow `ENGINE_FAULT_PATTERN` disposes the
     engine and retries ONCE, announced through a 'stage' progress report and logs, never
     silently; a fault surviving the retry reports the visible "engine was reset" error,
     and aborts never trigger recovery. Only a persistent fault sets
     `LlmHostErrorDetails.engineReset`, escalating to a debounced host-window `reset()`.
   - Gemma 4 E2B is declared at the RUNTIME budget `contextWindow: 8192` /
     `maxOutputTokens: 2048` in the built-in `local` provider's entry in
     `packages/assistant-contract/src/provider-catalog.json` — not the architectural
     window — so the context-budget machinery and meter keep prompts in the working zone.
   - Server seam: `LlmHostManager.generateForMain/warmupForMain` →
     `createMainLlmHostClient` (`packages/assistant-service/src/ports.ts`) →
     `RuntimeData.localLlmHostClient` → provider-factory's 'local' case →
     `LlmHostChatModel`, which turns cumulative host snapshots into incremental deltas.
     NEVER serialized over IPC/HTTP.
   - On a stall the Mastra inactivity watchdog preserves `stream_inactivity_timeout`,
     aborts that run's exact `generateForMain` signal, removes the manager request, and
     sends the matching cancel id to the renderer, which aborts only that generation and
     keeps the warmed host reusable — never a manual `llmHost.stop()` or engine reset.
   - Local memory models ride the same seam: 'local/<model>' observational-memory targets
     resolve keyless to the proxy model, semantic-recall targets to
     `createLocalHostEmbeddingModel`; both throw clearly without their host manager.
3. Visible renderer (web local chat, and desktop status/warmup UX)
   - It never runs the built-in local LLM directly on desktop; it talks to the host over
     `window.llmHost`. WEB keeps the in-renderer `LocalRuntimeChat` (session-only, no
     Mastra loop) because the browser has no assistant server.
   - Every mounted `LocalRuntimeChat` holds a lease (`useLocalBackendLease`) on the ONE
     module-level web backend; it is disposed only after the LAST lease releases AND the
     generation queue drains, with the disposal flags raised only after that drain. Why:
     raised earlier, the run holding its slot awaits a disposal awaiting that slot (a wedge).
4. Main
   - Main runs the Mastra loop but executes no Gemma inference in-process: every
     generation is proxied to the hidden llm-host renderer. It owns hidden-host
     lifecycle, IPC registration and shutdown/reset coordination.
   - `RendererHostLifecycle` assigns the server-owned window role before load, pins every
     hidden window to `hidden-preload.js`, and passes exactly one matching role argument;
     missing, duplicate and unknown roles fail closed. Sensitive main-process IPC stays
     independently sender-authorized.
5. Shared local runtime
   - `packages/agent/src/local-llm.ts` is the browser-safe entrypoint over
     `providers/local/`, and `LocalLlmBackend` stays a thin orchestrator over the Gemma
     engine/spec/artifact layers. Web executes tool calls through the UI/runtime tool
     bridge, desktop through the Mastra loop.
6. Web Hugging Face proxy contract
   - Files:
     - packages/assistant-contract/src/local-llm.ts
     - packages/assistant-contract/src/local-llm-model-specs.ts
     - apps/web/src/hf-proxy-contract.ts
     - apps/web/src/hf-dev-proxy.ts
     - apps/web/src/app/api/hf/[...path]/route.ts
   - `GEMMA4_E2B_MODEL_ID` and `GEMMA4_E2B_REVISION` are the canonical built-in model
     identity. `hf-proxy-contract.ts` derives `ALLOWED_MODEL_ID` and
     `ALLOWED_MODEL_REVISION` from those exports and exclusively owns the web proxies'
     Hugging Face base URL and header allowlists.
   - Both proxy consumers import that shared contract. The production route pins
     `ALLOWED_MODEL_REVISION`; the development proxy intentionally accepts any revision
     below the allowed model's resolve path. Do not duplicate the model, revision, URL,
     or header values in either consumer.
   - Verification: the web proxy unit tests (`pnpm --filter @brainstrike/web test`).

Constraints:
- Built-in local model downloads are manifest-based, not single-file heuristics.
- Keep thinking/reasoning output separate from the final visible answer, and strip
  control tokens (`<turn|>`, EOS markers, tool-call wrappers) from visible output.
- Cumulative snapshots and the authoritative decoded result use the same protocol
  projection in `gemma4-engine.ts`: incomplete tool-call protocol is withheld while
  streaming and fails visibly if still incomplete in the final decode, complete blocks
  become structured calls only, and a completed unknown protocol token throws visibly.
  `LlmHostChatModel` independently rejects known unprojected markers before emitting a
  delta; ordinary XML-like prose stays visible.
- Complete local tool calls require arguments parsing as a root JSON object; the engine
  and the shared provider projection both fail them as the bounded typed
  `local_tool_call_arguments_invalid` without retaining or guessing executable text,
  desktop preserves that code across the renderer/main boundary, and Mastra surfaces it
  as visible text plus typed `run.failed` metadata. Valid calls are canonicalized once,
  so the provider part, approval snapshot, resume and execution see the same arguments.
- Local Mastra generations inherit `maxOutputTokens` from the selected model's static
  provider-registry definition unless the run overrides it. A missing local output budget
  is an initialization error; never fall back to the proxy model's generic cap.
- Validate Gemma tool schemas before templating: accept a no-argument empty schema as an
  object, or a single schema plus `null` via `anyOf` or a type array and rewrite it
  explicitly; unsupported unions throw with the tool/property path.

Evidence for the GPU prompt ceiling and the engineReset escalation, including the
ONNX-Runtime markers that carry no "gpu" substring:
`local-inference/local-llm-hosts-and-flow.md`,
`local-inference/engine-fault-recovery.md`, `local-inference/gemma-runtime-budget.md`.
Guard: `llm-host-runtime.test.tsx`, `llm-host-manager.test.ts`,
`local-runtime-adapter-backend-lifetime.test.ts`,
`packages/agent/src/__tests__/mastra-local-host-execution.spec.ts`.
