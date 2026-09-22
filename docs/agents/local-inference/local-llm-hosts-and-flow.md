# Local LLM hosts, flow, and constraints — evidence

Supports `docs/agents/local-inference.md` § "LOCAL LLM ARCHITECTURE". Read
before changing the llm-host window role, the desktop chat transport, the
main-process client seam, the shared local runtime, or the web Hugging Face
proxy. The contract keeps the numbered flow and the constraints an agent must
obey; this file is the original prose for the parts that were condensed.

## Rules, reasons, and hidden-host flow (original text)

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

## Server seam, watchdog, local memory models, visible renderer, main, shared runtime, web proxy

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


## Constraints (original text)

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
