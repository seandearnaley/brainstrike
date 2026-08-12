# Local Inference: Embeddings + Local LLM (CRITICAL)

> Extracted from AGENTS.md (2026-07-12). Renderer-only execution is mandatory. Read before touching embedding/llm hosts, workers, or local chat. Keep updated with the code.

## EMBEDDING ARCHITECTURE (CRITICAL)

Renderer-only execution is mandatory.

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
     - apps/desktop/src/renderer/components/embedding-host-app.tsx
     - apps/desktop/src/renderer/components/embedding-host-runtime.tsx
   - Main creates a hidden BrowserWindow with `?mode=embedding-host`.
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
   - `powerSaveBlocker` is allowed only while the hidden host reports active embedding work.
4. Job Queue
   - File: packages/db/src/queue/job-queue.ts
   - Backed by job_queue table.
   - Lease-based locking, retries, dedupe, failure tracking.
   - `startEmbeddingWorker` applies one runtime-wide in-flight budget across all
     polling loops before `claimMany`. The default ceiling is `claimBatchSize`;
     `maxInFlightJobs` may override it with another positive value. Slots are
     released only after the corresponding completion/failure write, or during
     explicit cleanup after a lost lease or interrupted batch.
   - Desktop backfill admission bounds queued/running jobs for the target
     `embedding_set_id`, not the entire embeddings queue. Workspace Index may
     legitimately fill its separate QoS depth with other embedding sets; those
     jobs must not starve a manual backfill. Same-set desktop backfills remain
     single-flight at the IPC boundary, while the worker's runtime-wide
     in-flight budget remains the global inference ceiling.
   - Admitted manual backfill jobs use the queue's earliest runnable ordering,
     so an older unrelated embedding-set backlog cannot strand them behind the
     backfill drain timeout.
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
- Wiring: `embedding-worker-config.ts` (`composeClaimPermit`) +
  `embedding-host-runtime.tsx` (gate per runtime, threaded to the worker config + query
  handler). Constants: FOREGROUND_GATE_REOPEN_MS (250), QUERY_DRAIN_TIMEOUT_MS (5000).

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
- `StreamingEmbeddingWorkerClient` and every worker in the non-streaming browser
  workerpool own source-scoped, in-memory telemetry records. The workerpool records the
  unique buffers transferred with each completed result and forwards pipeline-cache
  diagnostics emitted during `runEmbedding`. Worker-global diagnostics that occur after
  an RPC settles (notably the five-minute idle-cache eviction) travel over a pool-unique
  `BroadcastChannel`; its name is carried in the managed worker script fragment. The
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
  worker-lifetime error over its managed channel; the adapter terminates that pool, gates
  new executions on recovery, and creates the replacement before accepting another task.
  An idle direct worker instead re-reports an unhandled rejection through the browser's
  uncaught-worker-error channel so the existing client listener visibly fails and retires
  it. Active direct streams each also receive their own request-scoped device-loss message.
  A validated request-scoped worker error is
  terminal: the workerpool adapter emits it for diagnostics, cancels the RPC, and rejects
  the task even if the worker later tries to return vectors.
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
     - apps/desktop/src/ipc-llm-host.ts
     - apps/desktop/src/llm-host-shared.ts
     - apps/desktop/src/renderer/components/llm-host-app.tsx
     - apps/desktop/src/renderer/components/llm-host-runtime.tsx
   - Main creates a hidden BrowserWindow with `?mode=llm-host`.
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
     - apps/desktop/src/preload.ts
   - Does NOT execute Gemma inference in-process (the Mastra loop runs in
     main, but every generation is proxied to the hidden llm-host renderer).
   - Owns hidden-host lifecycle, IPC registration, and shutdown/reset coordination.
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
