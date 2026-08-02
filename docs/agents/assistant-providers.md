# Assistant Providers, MCP Transports, Native Tools

> Extracted from AGENTS.md (2026-07-12). Read before changing provider config, MCP transport selection, or assistant native tools/registries. Keep updated with the code.

## AI ASSISTANT INTEGRATION

- Supports hosted providers OpenAI, Anthropic, Google, and OpenRouter, plus the
  Ollama and LM Studio local servers.
- Ollama and LM Studio chat use Mastra's first-class OpenAI-compatible model
  config (`{ id: "provider/model", url, apiKey }`). The configured origin is
  normalized to a `/v1` base URL and Mastra owns the chat-completions adapter.
  Do not route these providers through `@ai-sdk/openai`: its default callable
  selects OpenAI's provider-specific Responses model instead of Mastra's
  generic compatible-provider path. Brainstrike passes an explicit dummy key
  when local auth is disabled so `OPENAI_API_KEY` is never inherited and sent
  to a local or LAN server. Optional runtime tokens still come from the desktop
  secrets bridge. The `providerOptions.ollama` and `.lmstudio` namespaces are
  Brainstrike transport configuration, not generation options; strip both at
  every Mastra stream/resume boundary so `baseUrl` and `apiToken` can never be
  serialized into a chat request body.
- **Local-runtime HTTP goes through `fetchJsonWithTimeout`, and its `fetchImpl`
  MUST NOT be invoked as a property of the options bag.** `options.fetchImpl(...)`
  makes `this` the options object, and the browser's native `fetch` rejects any
  receiver that is not the global object with
  `Failed to execute 'fetch' on 'Window': Illegal invocation` — the request
  never leaves the browser, so a probe fails identically whether or not a daemon
  is listening. That shipped once (BST-964): Ollama and LM Studio reported
  `Unavailable` even while running. Read the impl into a local first, and bind
  the ambient default at capture (`globalThis.fetch?.bind(globalThis)`) in
  `LocalRuntimeDiscoveryService` and `LocalRuntimeModelCatalogService`.
  Measured: a BARE call on an unbound reference is fine (`this` is `undefined`
  and the engine tolerates it) — only a PROPERTY call breaks, which is why the
  bare-call `fetch` captures elsewhere in the repo are unaffected.
  A `vi.fn()` mock can never catch this: a plain function is indifferent to its
  receiver. Regression cover must be receiver-aware — see
  `packages/assistant-contract/src/__tests__/local-runtime-fetch-receiver.test.ts`,
  which uses both a receiver-sensitive and a receiver-recording fetch (the
  latter is what pins the bind; the former cannot, since it tolerates
  `undefined`).
- Ollama `/api/tags` is a mixed catalog: completion, embedding, and image-only
  models can all appear. Catalog hydration MUST resolve every candidate through
  authoritative `POST /api/show` capabilities before exposing it. A failed
  capability lookup fails the catalog visibly; never infer chat support from a
  model name after Ollama is reachable. Only `completion` models enter the
  Assistant picker, while `embedding` remains available to embedding settings.
  Preserve native-first catalog endpoint order even when the availability probe
  succeeded through `/v1/models`. When `/api/tags` itself is unsupported, the
  OpenAI-compatible `/v1/models` fallback remains valid and MUST NOT be followed
  by a native `/api/show` request; its capability source stays `inferred`.
  A forced catalog refresh MUST also force every native `/api/show` lookup so
  `Probe now` cannot reuse stale per-model capabilities after a pull or model
  replacement.
- Per-model vision: `LocalRuntimeNormalizedModel.capabilities.vision` is
  tri-state ('supported' | 'unsupported' | 'unknown'). Ollama `/api/show`
  capabilities and LM Studio's native `type` discriminant ('vlm' vs 'llm')
  resolve it authoritatively; the name-inferred OpenAI-compat path stays
  'unknown' — never coerce unknown to unsupported. It rides through
  `toRuntimeProviderModels` into the picker metadata and the composer
  attachment gate (see docs/agents/assistant-persistence.md, image
  attachments).
- Built-in local provider:
  - Desktop/web local inference targets `onnx-community/gemma-4-E2B-it-ONNX` only.
  - No silent fallback to WASM. If WebGPU is unavailable, the built-in local provider is unavailable.
  - DESKTOP runs local chat through the assistant server's real Mastra loop
    (persistence, run events, tool guards); inference is proxied to the hidden
    llm-host. The built-in local model is also selectable as the observational
    memory model and local embedders as the semantic recall embedder — all
    keyless. See LOCAL LLM ARCHITECTURE.
  - Local tool-call arguments must parse as a root JSON object before a
    provider tool-call part is emitted. Gemma normalization and the hidden-host
    provider projection share the same validator. A malformed call terminates
    generation with `local_tool_call_arguments_invalid`, bounded diagnostics,
    and no approval snapshot; it is never repaired from raw text or coerced to
    `{}`. Valid arguments are canonicalized before Mastra sees them.
  - The broad `@brainstrike/agent` entrypoint explicitly registers the
    browser-only in-process local language-model factory. Server-safe subpaths,
    especially `@brainstrike/agent/hosted-web`, must never import or register
    that Transformers/Hugging Face graph. Selecting the in-process `local`
    provider without first importing the broad root entrypoint fails visibly;
    the Desktop hidden-host client path remains available without that browser
    factory. Do not make local-provider behavior depend on an undocumented
    narrow-entrypoint import order.
  - API keys:
  - Managed via Settings.
  - Desktop: encrypted keychain.
    Desktop also loads provider credentials from environment files before any
    provider/key inspection runs. `src/main-bootstrap.ts` is the packaged main
    entry: it completes this load before dynamically importing the full
    `src/main.ts` runtime graph, so eager module-level environment reads cannot
    observe a partially initialized process. Unpackaged launches read
    `apps/desktop/.env.local` before `apps/desktop/.env`; packaged launches may
    read only `<userData>/.env`. The inherited process environment is authoritative
    even when an existing value is empty. Every candidate file is read and
    validated before any value is applied, so an unreadable or malformed file
    applies nothing and surfaces through both the assistant status probe and
    Settings. Files may set only the credential names documented in
    `apps/desktop/.env.example`; arbitrary process variables are rejected so a
    packaged user-data file cannot alter child-process execution. Assignment
    boundary whitespace is rejected rather than silently trimming a credential
    value. Missing files are valid. `NODE_ENV=test`,
    `ELECTRON_IS_E2E_TEST=true`, and `--test-mode` disable environment-file
    loading entirely; directly injected launch variables retain their existing
    runtime semantics.
    Chat and model-metadata environment credentials remain authoritative when
    present. A stored-key `SecretReadError` must otherwise propagate as the typed
    `api_key_unreadable` chat/model-metadata failure (or the original typed
    embedding failure); it must never be coerced into `missing_api_key`.
    Embeddings may continue with a valid environment credential after a stored
    read failure, but must rethrow that failure when no environment key exists.
    `SecretReadErrorCode` and its runtime guard live in the shared assistant
    contract; desktop producers and renderer status parsing must use that single
    definition. Malformed provider-error payloads fail the status probe visibly
    rather than being dropped, so a protocol violation can never masquerade as
    healthy provider availability. Saving, replacing, or deleting a provider
    secret must re-probe assistant status so an unreadable-key error cannot
    remain latched after the credential is repaired.
    Provider-backed memory follows the same authority chain. Observational
    memory and semantic recall distinguish `disabled`, request-key `resolved`,
    and `needs_async_resolution` states; the latter performs the env/keychain
    lookup before constructing Mastra memory. A completed lookup with no key
    returns HTTP 400 `memory_credential_missing` with the bounded provider and
    `observational_memory` or `semantic_recall` feature. A `SecretReadError`
    remains `api_key_unreadable`. Renderer memory gates must prefer the matching
    validated `providerErrors` repair message over generic missing-key guidance;
    another healthy provider must never mask an unreadable memory credential.
    The renderer and Settings consume the validated configured-provider signal
    from assistant status. A hosted observer or embedder without a configured
    key is excluded from selectable memory models, prevents its feature toggle,
    and blocks the next run with actionable guidance; built-in local models
    remain keyless. The serialized model target is never sufficient evidence
    that a credential exists. An omitted `providerKeySources` field means the
    host does not expose credential provenance; it is not equivalent to a
    validated empty list. Hosted Web therefore retains its server-owned model
    surface and reports the host capability boundary before desktop-only
    credential guidance.
    Built-in local observational memory additionally requires the desktop
    assistant-server bridge. Web's in-renderer local chat does not construct
    PGlite/Mastra observational memory, so Settings excludes the local observer
    unless that capability is positively present and the runtime blocks a
    persisted local observer with an explicit desktop-backend reason.
    Hosted-provider chat likewise requires a positively available Mastra memory
    backend before request preparation. The composer gate and request-data
    builder consume one shared capability predicate; do not duplicate the
    provider/backend rule. Core PGlite readiness, memory-load failures, and
    selected-thread availability also apply when no workspace root is open.
    Only root-scoped observational-memory and semantic-recall checks may be
    bypassed in that state; request-memory failures must disable the composer
    instead of reaching the strict request-memory assertion.
  - Hosted Web: local Vite and protected Vercel Preview may read server-only
    OpenAI, Anthropic, Google, and OpenRouter environment keys using each
    provider registry entry's canonical precedence. Whitespace-only values are
    unconfigured. Status advertises configured provider IDs and exact safe
    environment-key sources, never values; each advertised provider is fixed to
    its registry default model in the renderer. A request may select only one of
    that configured set. Unknown, non-Hosted-Web, and credential-less providers
    fail as `invalid_runtime_data` / HTTP 400 rather than falling back to another
    key. The server injects the selected provider's key and ignores client
    model/key/base-URL attempts. Because the Vite process holds developer
    credentials, its assistant
    middleware has an explicit LOCAL request boundary before status, body
    parsing, or stream dispatch: the TCP peer must be IPv4/IPv6 loopback, the
    `Host` must be exactly `localhost` or a loopback IP authority, and browser
    `Origin` / Fetch Metadata must be same-origin. A loopback CLI request with no
    `Origin` remains supported. Assistant POSTs additionally require
    `Content-Type: application/json`; remote clients, DNS-rebinding hosts,
    cross-origin browsers, and non-JSON media types receive stable typed
    403/415 errors while their request stream is drained. Do not weaken that
    application boundary merely because Vite also has listener/allowed-host
    controls. The deployable Vercel entrypoints enable that key only when
    `VERCEL_ENV=preview`; missing, development, production, and unknown values
    fail closed as `production_auth_required`. Production enablement requires
    application authentication plus distributed quota/cost controls. Never
    expose a key through a `VITE_`-prefixed variable. The shared renderer's
    model, generation, loop, MCP, and enabled-tool fields are wire-compatibility
    hints only and are never copied into that trusted runtime. The provider field
    is the sole exception: it is copied only after exact membership validation
    against the server-configured Hosted Web provider set — and since the
    BST-973-2 convergence it is REQUIRED on assistant turns. Both Hosted Web
    transports (the Vercel function and the Vite dev/preview middleware) run one
    converged decision core (`runWebAssistantPost` in
    `apps/web/src/server/web-assistant-post.ts`, which passes the allow-list
    `filterWebAssistantPayload` as the SHARED `prepareAssistantPostRequest`'s
    `filterPayload` hook — BST-1030). The hook's ORDERING is a contract, pinned
    by tests in `packages/assistant-service/src/__tests__/request.test.ts`: it
    runs on the parsed envelope AFTER `parseAssistantRequestPayloadText` and
    BEFORE tool-continuation extraction and native-tool-id validation, so what
    the filter strips can never reach validation, and the hook's own typed
    errors propagate OUT of preparation to the transport-owned mapping (they
    are never mapped inside the package). A refactor that moves or bypasses
    this hook moves web's trust boundary — update the tests and this section
    together. With the hook in place, a
    request that names no `data.provider` is rejected `missing_provider` /
    HTTP 400 exactly like desktop — the old web-only default-provider fallback
    is gone, and the 503 server-config gate precedes request validation. Do not
    reintroduce a fallback in either transport; the shared renderer always
    names its provider.
    `resolveWebAssistantRuntime` (still the chat endpoint's boundary) and the
    assistant pre-filter copy an explicit allowlist of non-privileged
    request metadata only after strict runtime validation of every value,
    including bounded strings, arrays, numbers, and strict nested objects.
    Malformed known fields and server-only, capability-inapplicable, or unknown
    fields (including `apiKey`, `mcpConfig`, `mastraTools`, `permissionPolicy`,
    and `permissionPolicyRequest`) fail with
    `invalid_runtime_data` / HTTP 400. TypeScript types alone are not a request
    trust boundary. The Web request therefore cannot create tools, launch stdio
    MCP, replace provider credentials, or set server cost policy through
    serialized runtime data. Hosted Web has an explicit 4 MiB serialized
    request-body capability, below Vercel Functions' non-configurable 4.5 MB
    ingress ceiling. App-shell passes that capability only when the desktop
    assistant bridge is absent, and the shared renderer measures the exact
    UTF-8 JSON body before `fetch`, so normal Web UI turns fail visibly before
    the platform can substitute its generic `FUNCTION_PAYLOAD_TOO_LARGE`
    response. The Vercel Function handler and Vite dev/preview middleware
    enforce the same 4 MiB maximum before JSON parsing;
    `BRAINSTRIKE_ASSISTANT_REQUEST_BODY_LIMIT_BYTES` accepts only a positive
    safe integer and may lower that server cap but never raise it. Declared and
    streamed/chunked overflow is byte-counted
    and fails with `request_body_too_large` / HTTP 413 while the Node stream
    drains. A direct Vercel request above the platform's 4.5 MB limit can still
    be rejected before Brainstrike code runs. Desktop retains the canonical
    16 MiB server limit. Restoring larger inline-image turns on deployable Web
    requires direct blob/object-storage uploads instead of routing base64
    through the Function. Malformed JSON fails without logging its value as
    `invalid_json` / HTTP 400; an empty or whitespace-only body is malformed
    JSON rather than an implicit empty request. The canonical assistant request
    envelope has exactly four possible top-level fields: required `messages`
    plus optional `data`, `runConfig`, and `unstable_assistantMessageId`.
    `messages` must be an own array (an empty array is valid for approval and
    suspend/resume action legs), while present `data` and `runConfig` must be
    objects. Missing `messages`, non-object roots, invalid optional objects, and
    every unknown top-level field fail as `invalid_request_payload` / HTTP 400
    on Vercel Preview, Vite dev/preview, and Desktop. The renderer constructs that exact
    shape through the shared assistant-contract helper. It omits assistant-ui
    thread/parent bookkeeping because the message graph and `data.memory` own
    topology, and rejects non-empty client `callSettings`, `config`, `system`,
    `tools`, or message state before fetch because the custom server consumes
    none of them. In particular, provider API keys/base URLs and per-call
    headers can never leak through assistant-ui's generic model-context bags.
    `runConfig` is bounded by the active transport cap (4 MiB Web, 16 MiB
    Desktop); only the shared approval/suspend action readers consume it, and a
    suspend action's `resumeData` is then validated by the tool's Mastra resume
    schema. Do not
    forward any other `runConfig` subtree: expanding that contract first
    requires shared graph, identifier, and UI-input bounds.
    This envelope reduces and secures HTTP transport bytes; model-context
    savings remain the separate memory/projection/compaction contracts below.
    Before recursive assistant-ui compatibility normalization, the shared
    iterative message boundary caps message and part counts, graph nodes/depth,
    object fields, and string sizes. It rejects
    cycles, non-plain objects, and non-JSON scalars (including bigint and
    non-finite numbers) while permitting `undefined` for optional in-memory
    fields. Violations fail as `invalid_messages` / HTTP 400. Message conversion
    is role-, part-, and path-aware: it reads only root compatibility text and
    direct `content`/`parts` text fields, and recognizes attachments only as
    direct file parts on user messages. Tool calls, tool results, data parts, and
    their nested domain payloads remain opaque, so a workspace entry such as
    `{type:"file",path:"README.md"}` can never collide with the attachment
    discriminator or be flattened into prompt text. The elevated data-URL string
    allowance likewise applies only at those exact user-file positions; every
    other string remains under the normal graph budget. An image attachment is
    prompt content in its own right, so validated
    image-only user turns are accepted consistently by Vercel Preview, local
    Vite, and Desktop.
    Blank text-only turns and turns ending in assistant/system history remain
    invalid. Prompt validity is checked against the FINAL raw wire entry before
    lossy compatibility normalization, never against the last surviving history
    message; a dropped blank/tool-only tail therefore cannot replay an earlier
    user prompt. Attachment limits count wire occurrences rather than object
    identity. File parts require canonical
    base64 alphabet, length, and padding, and the data-URL media type must equal
    the declared allowlisted image media type. An empty base64 body is invalid
    (`invalid-base64`), never a canonical zero-byte image. Malformed direct file
    parts and attachment validation failures return a safe `invalid_attachment`
    / HTTP 400 response across Vercel Preview, Vite dev/preview, and Desktop.
    Approval resume actions
    likewise cross a strict shared boundary: only the exact `action`, `runId`,
    `toolCallId`, and optional
    `toolName` own keys are accepted; identifiers must be non-empty and stay
    within the documented 512-character transport ceilings. Extra keys and
    oversized identifiers return `invalid_tool_approval_action` / HTTP 400 on
    both Vercel Preview and Vite dev/preview routes. Suspend-resume actions use
    the same exact-own-key and 512-character identifier bounds; extra keys,
    inherited fields, blank tool names, and oversized identifiers return
    `invalid_tool_resume_action` / HTTP 400. After normalization, chat requests
    require at least one effective message and normal assistant turns require a
    non-empty prompt on both Vercel Preview and Vite dev/preview routes. Hosted
    Web has no durable workflow or stream-replay store. Both Vercel Preview and
    Vite dev/preview therefore reject valid approval and suspend-resume
    actions with typed HTTP 409 responses, and reject every non-empty
    `Last-Event-ID` as `stream_resume_unavailable` instead of depending on lucky
    process affinity. These requests still consume the bounded body first, so a
    reconnect cannot bypass the cap. Normal turns call the shared stateless Web
    stream builder without a Mastra storage argument and create a single
    non-registering data-stream response. They never enter the desktop
    process-local replay map or retain encoded output for its two-minute replay
    window.
    Wire-compatible provider/model/tool hints are strictly bounded and validated
    before they are discarded, including iterative
    depth/cardinality/string/number limits for arbitrary provider options. The
    UI's `transportImageElision` observability metadata follows the same rule:
    Web accepts only the bounded, strict shared-contract shape and discards it
    before building the trusted model runtime.
    The Vite deployment declares real root `api/assistant.ts` and
    `api/assistant/status.ts` Vercel Function entrypoints; `src/app/api/**`
    alone is not discoverable in a static Vite project. Those wrappers enforce
    the protected-preview-only deployment boundary before delegating. The
    legacy `/api/chat` handler remains dev-only because its process-local rate
    limiter cannot enforce a production limit across function instances.
- Config:
  - packages/agent/src/providers/registry.ts
  - packages/agent/src/providers/key-resolver.ts
  - packages/agent/src/providers/provider-factory.ts
  - User setup: docs/local-model-servers.md
- OpenRouter is configured through Mastra's `openrouter/<provider>/<model>`
  model-router IDs, not a generic `createOpenAI({ baseURL })` client. The
  official OpenRouter adapter preserves `providerMetadata.openrouter.usage.cost`;
  that exact billed amount is aggregated across `step-finish` parts and carried
  on the terminal message. Mastra emits approval/tool-suspension parts before it
  exposes that model step's `step-finish`, so a pause finish cannot claim an exact
  cost. On resume Mastra emits the deferred pre-pause `step-finish` before later
  model steps; the fresh resumed lifecycle aggregates all of them on the final
  message without double-counting. An abandoned pause therefore has no billed
  cost available through the observer stream. Mastra's terminal token usage is
  cumulative, but its terminal provider metadata repeats only the final step, so
  every observed step must report cost; a missing or malformed reported cost
  fails visibly rather than silently undercounting.
- Reasoning has two INDEPENDENT dimensions, and they must not be re-conflated
  (BST-840). DEPTH is a budget concern (`reasoningEffort`, `anthropicEffort`,
  `googleThinkingLevel`, the OpenRouter auto profile). VISIBILITY is a UX
  concern — whether the provider returns the reasoning at all — and is owned by
  the single cross-provider `reasoningVisible` setting, resolved by
  `packages/assistant-contract/src/reasoning-visibility.ts` (defaults to
  visible). Each provider projects it onto its own wire field:
  `openai.reasoningSummary`, `anthropic.thinking.display`,
  `google.thinkingConfig.includeThoughts`, `openrouter.reasoning.exclude`.
  Three hard rules: visibility only ever MODIFIES a reasoning request that is
  already being made (cleared settings must still produce NO provider options);
  output is never suppressed/summarized for reasoning that is switched off; and
  the OpenRouter VISIBLE path adds NO field at all, because OpenRouter already
  returns reasoning and `provider.require_parameters` narrows routing to
  endpoints supporting every supplied parameter — an unconditional extra field
  would shrink the eligible upstream pool on every request. Only the OpenRouter
  opt-out adds `exclude: true`. Do NOT reintroduce a default
  `openrouter.reasoning.summary`: it is not part of OpenRouter's documented
  reasoning object (`effort`, `max_tokens`, `exclude`, `enabled`).
  Provider-specific keys remain valid escape hatches and win when explicitly
  set — and each one's control must render the RESOLVED value, not the raw key,
  or it reports stale state (the Google include-thoughts switch and the
  OpenAI/OpenRouter summary select both do this).
- The Anthropic Thinking toggle is AUTHORITATIVE for "is Claude thinking".
  Because a bare `anthropicEffort` now implies the adaptive thinking form,
  switching the toggle off clears the effort as well as the budget; otherwise
  the runtime keeps requesting thinking while the switch reads unchecked.
- Anthropic thinking mirrors the installed `@ai-sdk/anthropic` discriminated
  union: `adaptive` (carries `display`, whose provider-side default is
  `omitted`), legacy `enabled` + `budgetTokens`, and `disabled`. An explicit
  budget pins the legacy form; otherwise a chosen effort emits `adaptive`.
  The `AnthropicEffort` TYPE spans `low|medium|high|xhigh|max`, in step with
  the SDK enum, and is declared identically in BOTH
  `packages/assistant-contract/src/runtime-data.ts` and
  `packages/agent/src/types.ts` (the latter is what actually hands
  `providerOptions` to the SDK, and the boundary is structural — a narrower
  type there diverges SILENTLY). `ANTHROPIC_REASONING_EFFORTS`, the OFFERED
  list, stays deliberately narrower at `low|medium|high`:
  `resolveReasoningControlsAvailability` returns it for every Anthropic model
  with no per-model lookup, so widening it would offer efforts a given model
  may reject. Widen only once the registry carries per-model
  `reasoning.supportedEfforts` for Anthropic.
- OpenRouter request options use the native `providerOptions.openrouter`
  namespace. The shared reasoning controls map to
  `{openrouter:{reasoning:{effort,summary},provider:{require_parameters:true}}}`.
  Strict parameter routing is mandatory so OpenRouter cannot silently select an
  upstream route that ignores requested reasoning or tool parameters. Optional reasoning models map the
  explicit Off choice to `{openrouter:{reasoning:{enabled:false}}}`; `none` is
  never sent as a guessed effort. Never reuse the OpenAI camel-case
  `{openai:{reasoningEffort,reasoningSummary}}` shape, which Mastra's OpenRouter
  adapter ignores.
- OpenRouter `Auto` is a zero-configuration coding profile, not an implicit
  provider-wide 4,096-token cap. The shared contract resolves its output limit
  as `min(model max completion, 32,000)` when live/static model metadata
  publishes a maximum, and 32,000 otherwise, matching OpenCode's coding
  ceiling. When reasoning metadata says reasoning is enabled by default, the
  Auto effort is DECLARED, never inferred (BST-833): `reasoning.autoEffort`
  from our catalog if recorded, else the vendor's `defaultEffort`. With neither
  declared, Auto sends NO effort and the provider applies its own default —
  inventing one would be a silent fallback.
  Do NOT reintroduce the old rule, which scanned `supportedEfforts` for a
  "completion-biased" effort (`minimal`/`low`) and substituted `none` when it
  found none. That discarded the model's own declared default invisibly:
  GLM-5.2 declares `defaultEffort: 'high'` and advertises no low tier, so it
  lost reasoning entirely — for a reason unrelated to any measured budget risk,
  and with nothing surfaced to the user.
  A model that must reason less under Auto records `autoEffort` in the catalog
  (`'none'` switches it off deliberately and greppably) — `moonshotai/kimi-k3`
  does exactly this, because its `max` vendor default spends the whole output
  budget reasoning. Recording a fact we cannot get from OpenRouter is preferred
  over deriving it. The answer budget is protected by the output ceiling above,
  which is independent of effort. OpenRouter effort is a provider
  hint, not a deterministic reservation. The resolved output value drives both
  Mastra `modelSettings` and the input-context reservation. Explicit reasoning
  choices remain authoritative, and output values above a known model maximum
  are surfaced rather than silently clamped.
  The model menu and the per-thread provider-options builder must use the same
  resolved live metadata snapshot. It is invalid for the menu to offer an
  effort from live OpenRouter metadata and then validate that selection against
  a stale static catalog while composing the thread draft.
- A newly readable OpenRouter configuration must be usable without visiting
  model settings. When the DB-backed OpenRouter catalog is untouched, app-shell
  enables the small `OPENROUTER_RECOMMENDED_CODING_MODEL_IDS` set (balanced
  GPT-5.6 Terra, long-horizon Kimi K3, Qwen3.7 Max, GLM 5.2, and MiniMax M3) in
  one durable write. GLM 5.2 exposes only OpenRouter's documented `high` and
  `xhigh` reasoning efforts. MiniMax M3 is multimodal, so its static and
  persisted catalog declarations both enable image input.
  The database model registry remains the picker source of truth. Any existing
  enabled model, or any row whose `updated_at` is later than `created_at`, is an
  explicit prior choice—including an intentional all-disabled choice—and must
  be preserved exactly. Catalog migrations therefore continue preserving both
  `is_enabled` and the timestamps on existing rows. Key replacement, reload,
  and catalog refresh never reapply defaults; an unreadable key never triggers
  initialization. Missing recommended catalog rows or failed persistence are
  surfaced visibly rather than enabling a partial set or falling back to the
  whole OpenRouter catalog. Hosted fixed-provider runtimes do not run this
  desktop/local configuration initializer.
- OpenAI hosted `tool_search` response history has a temporary, provider-boundary
  compatibility seam in `openai-tool-search-history-compat.ts`. AI SDK 4.0.8
  preserves a hosted search output's distinct `tso_...` ID in
  `providerMetadata.openai.itemId` but reads only
  `providerOptions.openai.itemId` when serializing that assistant tool result.
  The OpenAI-only `processLLMRequest` processor copies the preserved ID into the
  supported option on the transient provider prompt, fails on conflicts or a
  missing hosted output ID, and never mutates durable history. Remove the seam
  after consuming an AI SDK release containing vercel/ai#17667; do not replace
  it with `patchedDependencies` or a lossy history filter.
- OpenRouter reasoning controls are model-capability-aware when the Models API
  publishes its `reasoning` object. Selected-model metadata validates and
  preserves `mandatory`, `default_enabled`, `supported_efforts`,
  `default_effort`, and `supports_max_tokens`; absence is never guessed as
  support. Declare those efforts on the static
  model definition; `resolveReasoningControlsAvailability` in
  packages/assistant-contract/src/model-reasoning.ts is the single resolver
  that filters the UI controls (the composer ComposerEffortControl slider) to
  the declared set, and the request boundary rejects incompatible settings at
  construction. Matching live metadata overrides the static entry for both
  controls and request construction. Optional models expose Off even when
  `none` is not an advertised effort, using `reasoning.enabled=false`. Its
  sibling `resolveModelReasoningSupport` is deliberately
  separate: an UNDECLARED OpenRouter model keeps the full effort list for the
  controls (the request boundary accepts `openrouter.reasoning` for any model)
  while its capability badge resolves to a visible `unknown` ("unverified") —
  never a silent yes/no. On an explicit model switch, clear an incompatible
  provider-wide effort override so the newly selected model uses its documented
  default; do not map it to a guessed nearest level.
- Reasoning-control placement: effort/level selection and the primary Thinking
  toggle live in the always-visible ComposerEffortControl chip beside the
  model picker in the composer control dock (packages/ui/src/
  assistant-ui-panel/composer-effort-control.tsx, backed by
  reasoning-effort-controls.tsx). The chip's trigger doubles as the readout
  ("Effort High" / "Thinking Off") so the active reasoning config is legible
  without opening anything (BST-948); the model menu itself is selection-only.
  The Controls menu's provider section is now "Output & Limits" (formerly
  "Reasoning & Output") and keeps only agent runtime limits, max output,
  the shared "Reasoning output" summary control, the Anthropic numeric thinking budget, and the
  Google include-thoughts debug toggle. Moved controls must emit
  byte-identical settings updates to the old panel sections (pinned by
  write-through tests in composer-effort-control.test.tsx).
- Static OpenRouter prices are estimates for pre-existing/unreported usage.
  Exact provider-reported cost is authoritative because routing, caching, BYOK,
  and provider tiers can make the catalog rate differ from the billed amount.
  Run-step metadata may additionally retain the bounded selected upstream
  provider name and reasoning-token count exposed by Mastra's official
  `providerMetadata.openrouter` shape, plus the non-negative first-text latency.
  Never log or persist reasoning content.
- The OpenRouter `Auto` output profile is sent explicitly because Mastra's
  provider otherwise expands an omitted limit to the model's full output
  ceiling, which can make OpenRouter reject even a tiny prompt during credit
  preflight. The automatic input-token budget MUST reserve the same resolved
  coding default (or the explicit configured output limit), not the model's
  full output ceiling. The Output & Limits panel
  shows the selected model's context/output metadata, the effective reservation,
  and the resulting input budget. Desktop selected models install a validated
  live OpenRouter snapshot for budgeting and label its `live`, `fresh-cache`, or
  `stale-cache` provenance; loading and failed lookups keep the built-in catalog
  visibly labeled, with the failure shown instead of silently falling back. An
  unknown OpenRouter model surfaces unavailable limits instead of guessing. An
  explicit model switch clears a provider-wide output
  override that exceeds the newly selected model's declared maximum; it never
  carries a hidden incompatible limit or silently clamps it. Explicit compatible
  user limits remain authoritative. While editing the numeric output field, an
  empty, fractional, below-minimum, or above-maximum value remains visible as an
  uncommitted draft with an inline error and disables send until corrected; it
  is never clamped or persisted. The range slider remains bounded to the known
  model limits.
- OpenRouter's canonical token-limit errors (`context_length_exceeded`,
  `max_tokens_exceeded`, and `token_limit_exceeded`) remain typed through the
  stream boundary. The visible bounded failure includes the canonical type.
  Every provider shares the adjacent forensic envelope:
  `run.failed.metadata.runError` contains only stable `code`, bounded `message`
  and `causeChain`, validated `httpStatus`, bounded `providerRequestId`, and a
  literal allowlist of rate-limit / retry-after / request-id response headers.
  Header extraction reads only the AI SDK `responseHeaders` field or an
  explicitly nested `response.headers` object; an unqualified top-level
  `headers` bag is treated as request metadata and ignored.
  Unknown or provider-private codes resolve to
  `mastra_agent_stream_provider_error`; an arbitrary upstream `provider_code`
  is never persisted. Request/response bodies, request headers, URLs, secrets,
  generic provider metadata, and retry-attempt data are excluded rather than
  sanitized after the fact. Consumers use the exported
  `readProviderRunError`/`isProviderRunError` boundary instead of shape-guessing
  event metadata.
- Desktop exposes `GET /assistant/openrouter-model?model=<provider/model>` for
  selected-model metadata. It resolves the stored OpenRouter key in main,
  requests the official single-model endpoint, validates exact model identity,
  positive context/output limits, bounded supported parameters, and the full
  published reasoning-capability object, and keeps a bounded five-minute
  in-memory cache. A refresh failure may return a prior
  snapshot only as explicit `stale-cache` data with a warning; a first failure
  is a visible 502. The renderer validates the assistant-server snapshot before
  using it for the selected model's context meter, derived input budget, and
  output control maximum. A configured output limit above the live maximum, or
  an input limit above the derived live effective budget, disables send with an
  explicit correction message. Validation uses the effective request setting,
  including a Prompt Workbench draft `modelSettings.maxOutputTokens` override.
  An impossible persisted output reservation keeps the settings panel available
  for repair instead of throwing during render; the endpoint never silently
  mutates the registry.
- State:
  - packages/app-state/src/stores/assistant-preferences-store.ts
  - packages/app-shell/src/assistant-thread-store.ts
  - Assistant preferences persist the most recently selected model as the default for the next
    new thread, plus a capped `recentModels` list (composite keys, newest first) that feeds the
    composer model menu's top-level rows. The thread store persists each existing thread's model and provider settings so
    switching chats or restarting the app restores that thread-specific runtime.

Assistant status endpoint resolution (in order):
1. window.assistant.getUrl()  (async)
2. window.assistant.url       (static)
3. /api/assistant/status      (fallback)

An enabled Hosted Web status response advertises its trusted primary runtime
pair plus every configured provider:
`{enabled:true,provider:<first configured>,model:<registry default>,providers:[...],providerKeySources:[...]}`.
The stable provider priority is OpenAI, Anthropic, Google, then OpenRouter. The
server and app shell consume the same provider registry: the shell validates the
primary pair, provider list, and environment provenance, skips renderer-side key
discovery, and derives each secondary provider's fixed registry-default model.
The primary pair remains atomic; a provider without a registry default, or any
incomplete, unknown, duplicate, or inconsistent metadata, fails visibly.
Desktop status may omit the pair, in which case its encrypted-key discovery
remains authoritative.

Desktop's non-fixed `providers` list is a validated seed, not an exhaustive
renderer catalog. The app shell must merge it with renderer provider discovery
so settings-owned, reachable or force-enabled Ollama and LM Studio runtimes
remain selectable. Hosted Web's fixed provider/default-model set stays
authoritative and must continue to skip renderer discovery.
`AssistantProviderSource`, provided at the `AssistantChatPanel` composition root,
is the required explicit boundary: a missing provider throws. `authoritative`
is derived synchronously during render, while `discovery` subscribes one shared
external resource to the secrets-store revision and assistant provider-settings state.
The first Desktop subscriber starts discovery and the last subscriber tears it
down, so multiple mounted thread tabs never fan out duplicate runtime probes.
Every refresh carries a monotonically increasing generation; a superseded or
unsubscribed request cannot publish late. Unexpected key or runtime discovery
failures remain visible as a disabled-reason diagnostic while explicit Desktop
seeds stay rendered; they are never converted to an empty successful result.
Keep the authority, refresh, ordering, teardown, and failure controls in
`use-configured-assistant-providers.test.tsx` when this boundary changes.

Desktop status also reports each unreadable stored credential as a validated
`providerErrors` entry (`provider`, `api_key_unreadable`, typed error code, and
the safe repair message). One unreadable credential never hides other working
providers. The shared shell preserves these entries and disables only the
selected affected provider with the re-entry guidance; malformed or duplicate
entries fail the availability probe instead of being guessed at. An environment
credential remains authoritative and suppresses a stale stored-key read failure
for that provider.

Desktop status keeps keyless runtime availability in `providers` and reports
credential provenance separately in `providerKeySources`. Each entry is exactly
either `{provider,source:"stored"}` or
`{provider,source:"env",envVar:<declared name>}`; values never cross HTTP or IPC.
The renderer rejects duplicate providers, unknown sources, extra fields, and an
environment-variable name not declared for that provider. `secrets:list`
returns the same source metadata (including Tavily), while
`secrets:listStored` remains the keychain-only string list. Test-mode Secrets
IPC remains environment-blind. Settings merges status provenance with IPC
metadata so an injected test/launch credential is visible without weakening
that hermetic IPC boundary, and disables an inert Save action while an
environment key is authoritative.

An invalid desktop environment file leaves the assistant server reachable but
makes `/assistant/status` return the typed
`assistant_configuration_invalid` state with only safe logical-file failure
metadata and no partial provider availability. The shared status validator
maps that payload to a visible error state; it never falls back to stored keys.

Implementation:
- packages/app-shell/src/hooks/use-assistant-availability.ts

When changing this flow, update this doc.

---

## MCP TRANSPORT SELECTION (CRITICAL)

Every MCP server chooses its transport explicitly. The authoritative config
discriminator is one of `stdio`, `streamable-http`, or legacy `sse`; it is never
omitted, inferred from a URL path, or changed after a failed connection.

Remote transport rules:
- `stdio` constructs only the official SDK's `StdioClientTransport`. The SDK
  inherits its documented safe environment allowlist and overlays only the
  explicitly configured `env`; spawn/connect failures remain visible. An
  unexpected child exit invalidates only that owned connection: the interrupted
  request fails without replay, and the next operation may start a fresh child.
- `streamable-http` is the modern MCP transport and normally targets one `/mcp`
  endpoint. It constructs only the official SDK's
  `StreamableHTTPClientTransport`.
- `sse` is the deprecated HTTP+SSE compatibility transport. It constructs only
  `SSEClientTransport`, even when its URL ends in `/mcp`.
- There is NO automatic Streamable HTTP → SSE fallback. The MCP specification
  describes that fallback as an OPTIONAL compatibility strategy for ambiguous
  URLs; Brainstrike removes the ambiguity by requiring the user to select the
  transport. A 400/404/405 initialization failure therefore remains visible.
- Both HTTP variants share strict HTTP(S)-URL, no-embedded-credentials, header,
  secret-decryption, cancellation, progress, and lifecycle behavior.

Ownership and flow:
1. Config — `apps/desktop/src/mcp-loader.ts` is the strict JSONC/Zod desktop
   boundary; `packages/agent/src/mcp/config.ts` is the serializable agent
   contract. Public renderer status exposes only server name + transport.
2. Official clients — `packages/agent/src/mcp/explicit-stdio-client.ts` and
   `explicit-http-client.ts`, exported only from
   `@brainstrike/agent/mcp-client`, own the SDK 1.29 transports,
   lazy/concurrency-safe connection, request forwarding, and idempotent close.
   The HTTP client additionally owns header composition and Streamable HTTP
   session termination. Keep the SDK package external in the agent build; do
   not pull this edge into browser-safe/root exports.
3. Desktop — `apps/desktop/src/mcp/http-client.ts` adapts that shared client to
   the desktop `McpClient` discovery/call contract. `sse-client.ts` is only a
   compatibility factory delegating to the canonical adapter; no bespoke SSE
   framing, endpoint rewriting, or environment-selected call path remains.
4. Agent runtime — `packages/agent/src/mastra/mcp-runtime-client.ts` constructs
   the selected official-SDK client for every server and converts every
   discovered tool through one shared Mastra-tool adapter. This preserves the
   complete `CallToolResult` until the adapter deliberately selects
   structured-only output or retains mixed structured+media output; upstream
   wrappers may not collapse either transport first. All tools then use the
   existing pipeline: discovery → namespace/sanitize → output bound → guard →
   hooks → permission. Remote progress uses the distinct transient
   `brainstrike.mcp-progress.chunk` `writer.custom` part and maps back to a
   `tool-event`; progress-channel failure is warning-only and never replaces a
   completed tool result or the remote tool's primary error.

Primary references:
- https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
- https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/docs/client.md

When changing this flow, update this section and the focused agent + desktop
real-protocol integration tests.

---


## ASSISTANT SEARCH TOOLS

The assistant's search verbs, in the order the default instructions present them:
1. `brainstrike.grepSearch` — FIRST for exact strings, identifiers, error messages. Two-phase: trigram-indexed ILIKE/regex-literal prefilter (`FileChunkRepository.findGrepCandidates`) + authoritative JS line matcher (`GrepSearchService` in packages/db/src/search/). Regex patterns with no extractable ≥3-char literal fall back to a bounded unfiltered scan; `scanLimited` reports true only when that scan hit its candidate cap (under the cap the scan was exhaustive — BST-951 ruled that over-reporting is as wrong as silence). The tool's hint builders MUST emit guidance whenever any of `truncated`/`scanLimited`/`candidatesTruncated` is set — the model projection enforces this and fails the run on a limited result without a hint. Truncation semantics are IDENTICAL in both output modes: `truncated` = items dropped by paging/budget OR either pass hit its own cap (index match cap, live candidate/walk/prefilter caps — live-capped matches are unreached on disk and never counted in `totalMatches`, so pagination alone cannot detect them). Desktop-only wiring in apps/desktop/src/assistant-server/grep-search-tool.ts. Progressive disclosure: default `outputMode: 'files'` returns per-path match counts (cheap survey); `outputMode: 'content'` returns line matches with context; both support `offset` paging.

    **`filePaths` scope contract (BST-764).** One resolver — `apps/desktop/src/assistant-server/grep-file-paths.ts` — interprets the allowlist, and BOTH passes consume its output. Do not normalize paths in `live-grep.ts` or in the tool; a second, different transform is exactly how the two passes diverged (`runLiveGrep` used to do `p.replace(/^\/+/, '')`, turning an absolute path into a never-matching relative one and reporting a clean zero-match for a file that plainly matched). Rules:

    - **Workspace-relative** entries pass through normalized (`./`, `//`, and inner `.` segments collapsed) and pin no root.
    - **Absolute** entries inside exactly one open folder resolve to root-relative AND carry that folder's `rootId`. The tool passes those ids as `rootIds` to the indexed pass and narrows the live roots to the same set — without that, `/work/A/proof.html` flattened to `proof.html` also matched a sibling root's `proof.html`.
    - **Rejected with a model-actionable error, never coerced to an empty result:** a path outside every open folder (the message names the path and lists the open folders), `..` traversal that escapes a root (rejected, not clamped — clamping would silently search a file the caller did not ask for), a path inside more than one open folder (ambiguous; set `root` to disambiguate), an absolute path when no folder is open, the open folder itself, and a blank entry. On Windows this includes UNC (`\\server\share\…`) and drive-relative (`\foo`) shapes, which must reject rather than fall through to relative handling; drive/segment comparison is case-insensitive on win32 only.
    - **`filePaths: []` means "nothing allowed"** in both passes — `undefined` is the only spelling of "no filter". The two used to disagree, with `[]` scoping the index to nothing while the live pass walked everything.
    - Scope errors are on `runGrepSearch`'s known-safe passthrough list (`/^filePaths /`), so they reach the model instead of becoming the generic "Try again."

2. `brainstrike.queryEmbeddingSpace` — semantic search when exact wording is unknown.
3. `brainstrike.hybridSearch` — vector + full-text keyword RRF fusion for the assistant, reusing the
   SAME `HybridSearchService` as the UI (desktop wiring in
   apps/desktop/src/assistant-server/hybrid-search-tool.ts, which reuses the retrieval
   tool's exported embedding-set/embedding helpers so scoping — explicit
   `embeddingSetId` or Workspace Index, optional `root` → `rootIds`, explicit input
   `filePaths` (max 500, matching the repos' inline cap) — matches
   `queryEmbeddingSpace`'s explicit-input semantics: like that tool, it does NOT
   inherit the implicit UI selection (`omitImplicitContextRuntimeData` parity), and
   it takes no selectionSnapshotId input. The keyword arm is embedding-set-scoped in
   the repos (coverage-identity predicate: chunk set, or NULL chunk set + file-record
   set), so fusion can never surface keyword-only chunks from another embedding space;
   both source pools grow with the requested limit (min 50), mirroring the UI
   executor). Best default when a query mixes conceptual
   intent with distinctive exact terms. NO SILENT FALLBACK: a failing keyword arm
   fails the call visibly, never degrades to vector-only.
   Gated by the hybrid RRF eval (packages/db/src/evaluation/hybrid-eval-runner.ts +
   hybrid-golden.ts, wired into `pnpm eval:retrieval` and
   packages/db/__tests__/search-hybrid-eval.test.ts): the golden set is designed so
   NEITHER pure arm ranks every target first but the fusion does (precision@1 = 1,
   MRR = 1 strict), and the runner fails if either pure arm reaches precision@1 = 1
   (the set would no longer separate the arms).
4. Hybrid FTS+vector RRF fusion (`HybridSearchService`) backs UI search paths. The
   lexical arm matches and ranks with built-in PostgreSQL FTS over migration 034's
   generated tsvector + GIN index. Ordering uses `ts_rank` plus an `id` tiebreaker;
   the caller's language, query mode, and `rankNormalization` remain authoritative.
   Migration 065 quarantines pg_textsearch after observed persisted BM25-index
   corruption. RRF fuses rank positions, so the fusion layer is unchanged.
5. Web retrieval pair (external service — Tavily via the shared `'tavily'`
   secrets-store key, env `BRAINSTRIKE_TAVILY_API_KEY`/`TAVILY_API_KEY` first):
   `brainstrike.webSearch` (snippets; provider-native search swapped in on
   Anthropic/OpenAI for fresh allowed turns) and `brainstrike.webExtract`
   (report R5 — reads up to 5
   PUBLIC pages behind results/user URLs as markdown, Tavily `/extract`; it has
   NO provider-native swap and must stay Tavily-backed). Both are keyless-
   HONEST (`available:false` + actionable message, never a throw) and
   non-fatal on network errors. webExtract additionally validates every
   model-supplied URL BEFORE anything is sent (http/https only, no embedded
   credentials, no private/loopback/link-local hosts — IPv4 literal ranges +
   IPv6 `::1`/`fe80::/10`/`fc00::/7`; public hostnames are NOT DNS-resolved
   locally since the fetch runs on Tavily's servers, the guard keeps clearly
   internal URLs from leaving the machine) and reports every refusal per-URL
   in `failed` — never a silent drop. Its producer preserves complete page
   content, URL identity, and failure reasons; it never clips a page or asks the
   model to re-fetch a changed source. Inline results receive a purpose-built
   complete projection. Results above 2400 serialized characters use the
   central artifact settlement path before projection, which retains exact
   UTF-8 JSON and gives the model an opaque `brainstrike.readToolOutputArtifact`
   cursor only when unread bytes remain. A one-page settlement stays complete
   without an EOF cursor. Without durable settlement, an oversized result
   surfaces an explicit model-output-unavailable state while its raw application
   result remains intact. Hermetic tests:
   `apps/desktop/src/__tests__/assistant-server/web-extract-tool.test.ts` and
   `web-extract-model-projection.test.ts`.

   Approval resume is the deliberate exception to that fresh-turn swap only
   when Mastra's durable suspended-call snapshot identifies the exact resumed
   tool as `webSearch`. If a read grant changes that call from ask to allow, the
   rebuilt immutable runtime keeps its execute-backed Tavily implementation;
   replacing it with the provider-native definition would orphan the durable
   function invocation and complete without executing or continuing. Resuming a
   different tool keeps provider-native search available, and the next fresh
   turn observes the grant normally.

Vector search adaptive routing (selective-filter recall fix): `searchSimilar`
in ALL THREE chunk repositories — `FileChunkRepository`,
`ElectronFileChunkRepository`, and `DrizzleFileChunkRepository` (the web/
DbProvider path) — routes NARROWED
searches (any filter beyond `embedding_set_id` — rootId/rootIds, filePaths,
selectionSnapshotId, fileRecordId, chunkType) via bounded selectivity counts
(`resolveFilteredVectorSearchRoute` in packages/db/src/repositories/_shared.ts):
a filter matching ≤20k rows AND ≤15% of its set bypasses the partial halfvec
HNSW index with an exact full-precision `embedding <=> $1::vector(N)` scan
(the expression cannot match the index, so the planner exact-scans — 100%
recall). Benchmarked: the ANN path returns 39.8% recall@10 at 100k chunks with
a ~10% filter AT THE SAME latency as the exact scan; `hnsw.max_scan_tuples`
and per-root partial indexes were measured and rejected
(docs/binary-quantization-two-stage-benchmark-2026-07-11.md). Un-narrowed
whole-set searches never run the counts. Do not "optimize" selective filtered
searches back onto the ANN index without re-running that benchmark.

Tool output budget (anti-thrash contract): budgets are token-denominated and
enforced deterministically on serialized chars at 4 chars/token (mirrors
`countTokensHeuristic`). Native producers self-bound result lists via
`fitItemsToCharBudget`; `readWorkspaceFile` emits 1-based line-numbered pages
and self-bounds its purpose-built JSON projection to the 6000-character domain
budget before returning, so page metadata and `nextCursor` never fall into the
generic prefix preview.
If the requested page exceeds the envelope, it shortens the page and returns a
26-character random `nextCursor` handle that resumes at the exact source line
and column, including within a long generated/minified line. The authoritative
root id, path, requested range, byte size, mtime, and source position remain in
the main-process registry and are never echoed through the model. Handles are
bound to the originating assistant resource/thread, expire after one hour,
survive renderer reload while the desktop main process remains alive, and are
cleared by factory reset or process restart. A handle is released only after its
continuation page has been validated and built successfully, before the next
handle is issued, so failed reads remain retryable while completed pages do not
occupy registry capacity for the rest of the TTL. Malformed, unknown, expired,
released, cross-thread, cross-root, and stale-file continuations fail visibly;
there is no legacy-cursor decode or fresh-read fallback. `omittedChars` counts
exact unread source characters; when a page ends after a complete line, that
includes the source newline before the next line.
Desktop reads each page from one containment-checked file handle: the same
handle is statted before and after the read, binary-probed, and decoded as fatal
UTF-8 in 64 KiB chunks. It retains only page-sized source fragments plus line
and character counters; it still scans to EOF because `totalLines` and
`omittedChars` are exact public metadata, never estimates. Full-file allocation
remains reserved for consumers that require the complete source, such as symbol,
LSP, and tapestry-range processing.
Pass `nextCursor` back unchanged as `cursor` with optional `maxChars` and no
other fields. `path` and `root` are initial-read inputs only and non-null
continuation overrides are rejected. A provider-emitted replay of the original
`startLine` or `endLine` is tolerated only when it exactly matches the
registry-bound range; a changed range fails visibly.
Optional
cursor, range, root, and character-cap fields accept provider-emitted `null` as
omission; invalid non-null values still fail schema validation. Both fit
`NATIVE_TOOL_RESULT_TOKEN_BUDGET` (2750) before settlement. The Mastra
runtime then adds or composes `toModelOutput` on every execute-backed
native/MCP tool. PostToolUse context travels only in an internal execution
carrier: Mastra's `transform.display` and `transform.transcript` channels
restore the exact domain result before live UI or durable persistence, while
`toModelOutput` alone consumes the context. Generated/default projections are
bounded to `MAX_MODEL_TOOL_RESULT_TOKENS` (2000) / 8000 serialized characters.
Purpose-built domain projections have the stricter
`MAX_DOMAIN_MODEL_TOOL_RESULT_TOKENS` (1500) / 6000-character contract so the
remaining envelope can carry PostToolUse guidance. Domain projectors MUST
self-fit a complete page; central code throws on overflow instead of
prefix-truncating a page whose continuation/provenance it cannot understand.
Only generated/default projections may use the generic truncation path.
The file-read staleness tracker is updated only after cursor validation and
page construction succeed inside the per-file lock; a rejected stale cursor
must not mark externally changed bytes as fresh for a later write.

Guarded failures (`tool_timeout`, `tool_failed`, `tool_input_invalid`,
`tool_blocked_by_hook`) bypass domain projectors and retain the bounded
structured failure. Generic throws remain redacted as `tool_failed`; trusted
application-owned `ToolInputError` validation failures preserve their safe,
model-correctable message. Multi-root resolution uses that path when a
root-qualified tool misnames or ambiguously names `root`. An omitted selector
uses `boundWorkspaceRootId` only when request preparation has durably bound the
thread to a live DB root; without that binding, ordinary single-target tools
retain the visible ambiguity error. Search tools whose legacy omission meant
"all roots" narrow to the binding when one exists and retain all-root behavior
only for genuinely unbound requests. Their provider schemas state that omission
rule and direct a bound thread to call once per root id when it needs every
folder. An explicit selector for another live mounted root is an observable
cross-root call. A stale/disconnected binding returns the explicit
`bound_workspace_root_unavailable` HTTP 409 initialization failure and never
falls back to Main. Successful resolution logs the mode and
safe root id/name, and native results surface `rootName` in the tool card. The
default multi-root instruction includes
deferred `lspInspect`, so a newly activated semantic tool receives the same
root-qualification rule as reads and searches. Correctable multi-root errors
list complete `displayName (id rootId)` choices within an 800-character budget;
if the inventory exceeds that budget, they direct the model to
`listWorkspaceContext` rather than truncating an identifier.
`lspInspect` also brands its identifier/marker, line-range, missing-fragment, and
ambiguous-fragment rejections as trusted input errors. A markerless single
JavaScript/TypeScript identifier is the preferred model input and anchors the
cursor at its unique occurrence on the requested line; a repeated occurrence
still requires the exact `<<<` fragment form. A wrong-line markerless identifier
returns bounded candidate line numbers for an explicit retry and never silently
moves the request. Its catalog description spells out the `LSP` acronym so the
common `search_tools("lsp")` query loads it.
The desktop LSP pool is keyed by the durable database `roots.id` returned by
workspace-tool resolution. Root disconnect therefore evicts every LSP pool
entry using the durable ids returned by the path-keyed database transition,
never the renderer adapter id from `rootsList`; those identities can diverge
after remove/re-add reconciliation.
For successful
hooked results, every original result shape and its control metadata travel in
the explicitly discriminated internal `HOOK_RESULT_ENVELOPE_FIELD` protocol.
The official Mastra display/transcript transforms unwrap that protocol for
application and persistence consumers; Brainstrike's PGlite store enforces the
transcript projection at its write boundary because Mastra 1.51 otherwise
stores the carrier alongside its transform metadata. The envelope is also
removed and the exact domain result restored before either a custom or default
projector runs. The central composer then appends PostToolUse context without
reordering authored content parts, truncating only that context when needed to
keep the final generic non-media serialized envelope at or below 8000
characters. A nullish synchronous or asynchronous custom projection
falls through to the bounded deterministic default over the clean domain
result, while malformed non-callable projections throw. Serialized-character
checks include JSON escaping; inline media bodies are excluded while their
metadata is counted. MCP image/audio results use Mastra `content` output so
base64 media remains model-native while companion text is bounded.
When a valid MCP result includes both `structuredContent` and image/audio
`content`, the transport-owned MCP runtime preserves the canonical result envelope
through persistence bounding instead of collapsing to the structured object.
The structured JSON joins the bounded model-facing companion text while the
media remains model-native; both the inline-media and non-media persistence
ceilings still fail visibly before transport. The discovered output schema
remains exposed for documentation, while the official MCP SDK owns
structured-output validation and Mastra does not incorrectly re-validate the
complete `CallToolResult` envelope against the inner schema.
Brainstrike's projection contract is Mastra 1.51's documented CoreTool
`toModelOutput(output)` callback: `output` is the raw execute result. Do not
reinterpret a public `{toolCallId,input,output}` object by shape; those keys are
valid domain data, and Mastra owns AI SDK adapter normalization at its known
boundary. Any future standalone AI SDK v6 adapter must be a separately named
boundary with an explicit input type, not an ambiguous branch inside the
one-argument Mastra projector. The real Mastra loop regression pins this with
an exact three-key domain result. `skill` is the explicit text exception: its
instruction body cannot be paged, so the complete 6000-token activation budget
remains available and a separate bounded 2000-character PostToolUse allowance
plus structural reserve expands only its final model-facing envelope.

Mastra 1.51's stock `TokenLimiter` counts raw database-shaped
`toolInvocation.result` before provider conversion. Brainstrike therefore
installs `ProjectionAwareTokenLimiter`: it temporarily substitutes the stored
`providerMetadata.mastra.modelOutput` (with inline media replaced by counting
markers), delegates to Mastra's limiter, and restores the exact raw result in a
`finally`. Keep its canonical processor id `token-limiter`.

Before compatibility normalization and token limiting, hosted runs apply the
projection-safe stale-history filter documented in `assistant-runtime.md`.
Brainstrike owns the per-call eligibility and one-tool-step window because
Mastra's stock processor filters by tool name and performs its transform from a
message-processing hook whose result is applied to the live `MessageList`.
Eligibility is recorded during `processInputStep`; replacement happens only in
Mastra's transient `processLLMRequest` hook. Persisted raw evidence and artifact
continuation data therefore remain authoritative. Stateful writes remain
verbatim regardless of age, while the newest eligible read/search/retrieval
step protects the only current verification result without retaining an older
redundant read. Protected state tools do not consume that recent-read window.

Runtime token measurement is observational and MUST NOT replace those safety
limits. `provider-registry.ts` resolves one explicit capability from the exact
provider/model tuple: `exact-selected-model`, `declared-compatible-reference`,
or `deterministic-serialized-character-backstop`. The current direct OpenAI
GPT-5.x registry entries deliberately declare local `o200k_base` as a compatible
reference, not an exact selected-model tokenizer; `openai/gpt-4o` is the
explicit verified exact mapping. Anthropic, Google, OpenRouter aliases, local
runtimes, and unknown tuples keep the four-serialized-characters-per-token
backstop. Never infer a tokenizer from a model-name substring.

`@brainstrike/tokenization` is the single implementation owner for the shared
heuristic and cost modules plus the strict o200k counter. The root is the eager,
asset-free surface; the only public subpaths are the strict-counter and
worker-lite modules with real consumers. `text-splitter`, `utils`, and worker
packages must not carry re-export facades or local copies. The worker bundles
still inline that one source independently at their real bundle boundaries, so
neither worker imports the other's runtime graph.

`RunTokenDiagnostics` initializes the declared local tokenizer once while the
server-side Mastra runtime is built, normalizes the FINAL tool map through
Mastra's Standard Schema conversion, and observes only already-bounded
`toModelOutput` projections. Inline media bodies become deterministic markers
before measurement. One `mastra_agent_token_measurement` structured log joins
the mode, tokenizer (when declared), tool-definition count/tokens, projected
result count/tokens, independent backstop totals, and actual provider/Mastra
prompt usage when reported. It contains counts and bounded failure metadata
only—never raw prompts, tool schemas, results, credentials, or user content.
Counter initialization/execution failure retains the declared mode, omits the
unavailable tokenizer counts, keeps the deterministic backstop totals, and logs
at warning level; it never silently changes measurement semantics or disables
the independent serialized-character safety envelope. Paired proofs:
`provider-registry-token-measurement.test.ts`, `token-measurement.spec.ts`,
`tool-model-output.spec.ts`, and `mastra-streaming.spec.ts`.

MCP text/JSON uses a separate temporary inline ceiling only when the host does
not supply durable artifact settlement: it is bounded to
`MAX_TOOL_RESULT_TOKENS` (3000). Multimodal output always stays inline so the
display/transcript channels can render it; durable settlement never converts
image/audio `content` arrays into text artifacts. Raw media is permitted only
up to the assistant aggregate encoded-media ceiling and 12000 non-media
serialized characters in both host modes. Multimodal `content` arrays
containing any non-object part are malformed and throw before persistence
accounting. Exceeding either ceiling throws visibly—never drops media.

The browser-safe `@brainstrike/assistant-contract/tool-output-artifact`
subpath defines the versioned foundation for that replacement: an opaque
artifact reference, a bounded provider-facing preview envelope, and contiguous
UTF-8 byte-addressed continuation pages. Artifact ids and cursors accept only
bounded opaque tokens—never filesystem paths, URLs, thread ids, or storage
locations. Preview and page fields are capped at 8000 UTF-8 bytes after outer
JSON string serialization as well as 8000 decoded UTF-8 bytes, so ordinary JSON
escaping or persistence-safe encoding cannot expand the provider-facing field
past its budget. Page guards decode that bounded content before verifying the
declared byte span, require a continuation cursor exactly when bytes remain,
and reject gaps, overlaps, extra fields, unsupported encodings, and malformed
versions instead of guessing. U+0000 content uses an explicit reversible
`json-string` encoding because PostgreSQL jsonb cannot represent it directly.
Migration 068 and `ToolOutputArtifactRepository` provide exact UTF-8 `BYTEA`,
resource+thread-scoped bounded range reads, seven-day expiry, bounded
oldest-first purge, typed visible failures, and explicit web/desktop
factory-reset cleanup. Exact replay of one scoped tool call is idempotent only
when format and complete bytes match; a conflicting replay is a hard failure.

`applyToolOutputArtifactSettlement` is the central live settlement seam. With a
trusted host store, non-media native and MCP output above 12,000 UTF-8 bytes is
retained completely before display/transcript receives the bounded envelope. A
tool may also declare a stricter canonical-name serialized-character ceiling
when its complete domain projection must fit below that generic transport
threshold. Desktop sets `brainstrike.webExtract` to 2400 characters so
escape-heavy inline source still fits the 6000-character domain projection;
larger extracts use the same durable artifact format and an exact cursor only
when unread bytes remain. A settlement that fits one model page retains the raw
display and returns `complete: true`; a host without a durable store receives
an explicit model-output-unavailable projection instead of clipped source or a
projection exception.
A private carrier retains the original result without leaking it into
persistence.
After settlement, `toModelOutput` bypasses the original domain projector and
projects a bounded initial-page view, composing authenticated hook context
centrally. That model view omits the redundant artifact reference, exposes one
exact reader/cursor action, and recomputes the cursor if its preview must shrink
to fit the domain budget; otherwise smaller models can combine mutually
exclusive initial and continuation inputs. MCP image/audio stays inline under
the media ceilings above instead of being serialized into a text artifact. The upstream
settlement cap for pageable text/JSON is 16 MiB;
over-cap output, missing tool-call provenance, serialization failure, storage
failure, or incoherent storage metadata throws visibly.
Without the capability, the temporary MCP ceilings above remain authoritative.
Desktop injects the settlement store only for a server-owned run with resource,
thread, and run scope; the paired reader needs server-owned resource and thread
scope but no new run id. The shared resolver accepts one strict discriminated
input: either the initial artifact reference or an opaque continuation cursor.
The cursor binds its version, complete reference identity, expiry, byte length,
format, and exact next offset; envelope and page guards reject a cursor whose
identity or offset differs. The resolver reads through a server-created
capability closed over resource+thread scope, returns contiguous fatal-UTF-8
pages with reversible U+0000 encoding, and surfaces malformed, expired,
wrong-scope, incoherent, non-progress, and storage failures as typed errors.
Settlement and continuation pages use the same cursor encoder. Desktop
registers `brainstrike.readToolOutputArtifact` only when that scoped capability
exists; web and requests without complete memory scope omit it instead of
stubbing it. The shared resolver retains its strict initial-reference and
continuation modes for internal callers, while the registered native model tool
exposes only the required opaque `cursor` plus optional `maxBytes`. Settlement
always creates that cursor, so removing the redundant mode/reference fields
prevents smaller models from fabricating contradictory calls and shrinks the
provider schema. Its raw result is the guarded artifact page for display and persistence. Its purpose-built model
projection omits the repeated artifact reference, retains format and byte
offsets, and carries either `complete: true` or an exact next tool/input pair.
If JSON escaping plus continuation metadata would exceed the 6000-character
domain budget, the projector fits a shorter code-point prefix and recomputes
the cursor at that byte boundary; it never generically truncates content or
loses continuation state.

Finally, the UI transport independently caps streamed output at 3000 tokens.
Oversized collections
(matches/entries/results/items/files/chunks/rows/subAgentToolResults) are
structurally trimmed; opaque outputs become a SUCCESSFUL
`tool_result_truncated` preview with an actionable hint. The legacy
`tool_result_too_large` envelope remains readable only for persisted-history
compatibility, and untrusted envelope-shaped output is revalidated against the
active budget. Proofs:
`tool-model-output.spec.ts`, `tool-output-limits.spec.ts`,
`projection-aware-token-limiter.spec.ts`,
`mastra-tool-execution.integration.spec.ts`,
`mastra-memory-persistence.integration.spec.ts`, and
`data-stream-session.spec.ts`. `listWorkspaceContext` is concise by default
(counts + token budgets); `detail: true` returns per-file Tapestry ranges.
`grepSearch` and `globWorkspace` keep their complete typed raw pages for
display, persistence, hooks, and reload, but their Mastra `toModelOutput`
projections are deterministic line-oriented text. Those projections retain
copyable `read_args` JSON containing the exact `root`, `path`, and (for grep)
1-based `startLine` accepted by `readWorkspaceFile`, plus root display name,
count/source/scan-limit state, and authoritative continuation guidance while
fitting the 6000-character domain budget. This is Brainstrike's local-first
multi-root equivalent of OpenCode's absolute-path grep/glob/read handoff: the
model does not need to translate a display-only root label into a tool input.
Because Mastra's one-argument projector receives the raw result but not the
original tool input, paging guidance tells the model to reuse the prior call;
it never fabricates or duplicates the original pattern. When the whole raw page
fits, the projection preserves the producer's bounded hint because the producer
owns service caps and scan-limit semantics. Only when the tighter projection
budget omits raw page items does the projector calculate an earlier advancing
`offset`. Producer guidance includes an `offset` only when that offset strictly
advances; when search or candidate limits yield an empty page with no reachable
next offset, it instead gives terminal query-refinement guidance. A truncated
result without producer guidance throws instead of guessing. Oversized paths and
match context are clipped with an explicit omitted-character marker, and
malformed result shapes throw a content-free diagnostic naming the rejected
field rather than falling back to generic JSON. The grep producer and projector
share one runtime result contract. The projector also recognizes its own
canonical bounded text envelope when Mastra replays a stored model projection
while preparing a later same-run step; that replay is idempotent and does not
reparse the text as a raw grep result.
`findWorkspaceSymbol` and `lspInspect` keep their complete typed raw results for
display, persistence, hooks, and reload while their Mastra `toModelOutput`
projections emit bounded line-oriented inspection summaries. Symbol output
retains the root/path, 1-based declaration line and enclosing range,
declaration text, preview, total/truncation state, and honest instructions for
passing the returned unique identifier directly or forming the `lspInspect`
cursor marker when that identifier repeats. It does not invent a symbol
kind or the original symbol query: Mastra's one-argument projector receives the
raw result but not the original input. LSP output retains availability/reason,
language, hover text, diagnostics, and definition/implementation locations.
Projection-only omissions are counted explicitly, malformed result shapes
throw, and raw tool results are never mutated.
`listWorkspaceContext` likewise keeps its complete typed raw result for
display, persistence, hooks, and reload while its Mastra `toModelOutput`
projection emits a bounded line-oriented inventory. It retains the main and
other roots, focused-root id, selected-file page and outside-workspace count,
index state, token estimates, concise curated-token totals, and detailed
Tapestry ranges when requested. It reserves one advancing selected-file entry,
then fits the multi-root inventory before spending the remaining budget on
selected paths, so a large selection cannot hide the root ids required by
follow-up tools. Path rendering preserves repeated and boundary whitespace;
only line-breaking characters are escaped and overlong paths are explicitly
clipped. Projection-only omissions are explicit. When the projection cannot
retain the whole producer page, its continuation uses the exact advancing
selected-file offset; malformed, incoherent, or non-advancing producer results
throw instead of falling back to generic JSON.
An authoritatively resolved zero-root Desktop workspace is a successful compact
result with `workspaceRoots: []`, null main/focused identities, and an explicit
`roots=0` model line. An absent or malformed root-resolution result still fails
visibly and is never coerced to that valid empty state.
`queryEmbeddingSpace` and `hybridSearch` retain their typed raw results while
purpose-built Mastra projections emit bounded workspace evidence. Semantic
retrieval keeps the producer's canonical ranked, root-qualified context string
plus compact score and token-budget state; explicit clipping reports omitted
characters and a refinement action. Hybrid retrieval retains fused rank,
root/path, chunk identity, RRF/vector/FTS provenance, bounded excerpts, source
coverage, and producer-owned truncation guidance; path rendering preserves
repeated and boundary whitespace while escaping line breaks. Unavailable
Workspace Index state remains visible, malformed or incoherent results throw,
and neither projection mutates the execute result.
The execute-backed Tavily `webSearch` tool likewise retains its normalized raw
result for display, persistence, hooks, and reload while its Mastra
`toModelOutput` emits a bounded ranked-citation list. The projection retains the
query, availability/error state, producer count/truncation guidance, stable
rank, title, exact citation URL, and bounded snippet. Citation URLs are
JSON-escaped but never clipped or summarized: a citation is admitted whole or
omitted whole, with explicit projection omission and query-refinement guidance.
Malformed or incoherent results, including truncated producer output without a
hint, throw visibly. Provider-native Anthropic/OpenAI web search remains owned
by the provider adapter and does not pass through this execute-backed Tavily
projector.

Native-tool catalog ownership is deliberately split at the browser/runtime
boundary:
- `packages/assistant-contract/src/native-tool-catalog.ts` owns the canonical
  ids and the exact desktop/skill partitions. The browser-safe
  `TOOL_DESCRIPTIONS` and `NATIVE_TOOL_DEFAULTS` registries are exact
  `NativeToolId` maps. `NATIVE_TOOL_SCHEMAS` is display metadata for UI and
  documentation only; it is NEVER an execution or provider-schema source.
- `packages/agent/src/tools/schemas.ts` owns the exact
  `NATIVE_TOOL_INPUT_SCHEMAS` map from every `DesktopNativeToolId` to its
  canonical Zod schema. Desktop provider registration and `validateToolInput`
  reuse those same schema objects. Mastra converts them to provider JSON Schema
  through the Standard Schema input protocol; never reconstruct validation or
  provider schemas from the lossy display metadata.
- Agent Skills (`skill`/`skill_read`/`skill_search`) remain canonical native ids
  for metadata parity, but their execution schemas are Mastra-owned and are not
  entries in `NATIVE_TOOL_INPUT_SCHEMAS`. The separate desktop-only
  `brainstrike.runSkillScript` is a Brainstrike-owned typed execution tool and
  therefore is present in the desktop catalog/schema map, deferred `skills`
  namespace, and execute-risk policy; web and the built-in local model omit it.

Adding or renaming a native tool must update the canonical catalog first, then
the exact metadata/schema maps, live desktop registry, exports, and conditional
model-facing guidance. The parity tests fail on stale, missing, or extra keys;
there is no fallback alias or partially registered tool.

`brainstrike.queryDiagnostics` is a desktop-only, explicit `read`-risk native
tool over `brainstrike_diagnostic_events`. Its `mode` is required:
`events` returns newest matching rows and `fingerprints` groups recurring
failures with count/first-seen/last-seen plus the latest representative
metadata. Both modes accept exact severity/fingerprint/run/thread filters and
inclusive ISO-8601 `since`/`until` bounds. The schema hard-caps `limit` at 200;
the repository applies the same bound, and the producer additionally
self-bounds through `fitItemsToCharBudget`. Hitting either cap is reported in
`truncated` plus an actionable `hint` — never presented as a complete result.
Web omits the tool because its assistant server has no capability to read the
client-local PGlite database; there is no remote fallback.

### Tool discovery contract (LIVE for hosted Mastra catalog search)

`packages/assistant-contract/src/tool-discovery.ts` is the authoritative
adapter and loading-tier contract. `createMastraAgentRuntime` now selects
`mastra-catalog-search` explicitly for hosted routes, constructs the Agent from
the post-gate critical/custom surface, and gives only the post-gate deferred
surface to `BrainstrikeToolSearchProcessor` (the fail-loud wrapper around
Mastra 1.51 `ToolSearchProcessor`). Built-in/local runtime behavior is unchanged;
provider-native tool-search adapters remain out of scope.

The canonical native metadata has one exact eight-tool `critical` set:
`askUser`, `executeCommand`, `globWorkspace`, `grepSearch`,
`readWorkspaceFile`, `stringReplaceWorkspaceFile`, `submitPlan`, and
`writeWorkspaceFile`. These are the universal exact-read/search/edit/create/
execute/suspend primitives that remain model-visible after discovery goes
live. Keeping one approval-gated create primitive critical is deliberate:
smaller hosted models otherwise cannot create a new file unless they first
infer that they must search for the deferred write tool. The search/load
control is owned by the selected discovery adapter and must be exposed beside
this set; it is not a second Brainstrike native-tool id. Every other native tool is `deferred` and
belongs to exactly one concise namespace in
`NATIVE_TOOL_DISCOVERY_NAMESPACES`: artifacts, context, embeddings, semantics,
sessions, skills, web, or specialist workspace operations. Namespace parity tests prove
that the critical plus deferred partitions cover every canonical native id
exactly once and that no namespace exceeds nine functions.

Loading tier is not authorization. User-enabled means only eligible for
discovery. `resolveToolDiscoveryPhaseAccess` keeps disabled, permission-denied,
and host-unavailable tools out of search, load, and active phases. An `ask`
permission remains searchable/loadable, but the existing downstream permission
gate must still suspend before execution. A loaded bit is required before an
eligible deferred tool becomes active. Runtime partitioning happens only after
guards, hooks, plan mode, permission, approval-storage, provider web-search,
artifact settlement, and model-output projection; it cannot restore a tool any
earlier stage omitted. Unknown caller-supplied local tools remain eager because
Brainstrike has no authoritative loading metadata for them. Existing
provider-defined web search remains eager because its provider-owned id/type
pair is not a normal function definition that catalog search may rename.
Mastra's canonical `skill`, `skill_read`, and `skill_search` controls also stay
eager: `SkillsProcessor` tells the model to call them directly, so deferring
them would make Mastra's own injected instructions reference unavailable tools.

`LlmModelDefinition.nativeToolSearch` records provider-native support on the
exact model route:

- Direct OpenAI GPT-5.4 and newer routes declare `openai`; older GPT-5.x routes
  do not. OpenRouter aliases do not inherit the capability because the gateway
  route is a different adapter.
- Current supported direct Anthropic models declare `anthropic`.
- Other declared hosted/gateway LLMs resolve to Mastra catalog search.
- The built-in browser-local model resolves explicitly to `eager-core-only`;
  this contract does not alter its current runtime. Dynamically discovered
  Ollama/LM Studio model ids resolve `unsupported` until their authoritative
  catalog exposes a tool-search capability signal.
- Unknown static model ids and non-LLM providers resolve `unsupported` for
  automatic or provider-native selection. An explicitly requested
  `mastra-catalog-search` adapter is runtime-based: a hosted LLM supplied through
  the supported model-override seam remains valid even when its model id is not
  in the static catalog. Browser-local and non-LLM providers remain unsupported.

`resolveToolDiscoveryAdapter` never substitutes another strategy when a caller
requests an adapter the exact route does not support. The unsupported result
retains a typed reason, keeping an adapter mismatch distinct from a catalog miss,
permission denial, and host unavailability. OpenAI's native `tool_search` is
model-gated, not inferred from `provider === "openai"`. Anthropic native search
likewise preserves provider search/tool-reference history. Live Mastra catalog
search uses `storage: 'context'`, `search.autoLoad: true`, and `topK: 3`.
Mastra's BM25 catalog ranks the sanitized tool id plus its canonical
description. Brainstrike's initial `search_tools` description must therefore
name the major deferred capability families explicitly, including open
workspace roots and focused context. Aside from the deliberately critical
create primitive above, do not widen the eager registry to work around a model
that skips discovery. Deterministic ranking fixtures cover the
context/list/read/grep/glob/edit/command intents. The opt-in hosted matrix in
`tool-discovery-live-eval.integration.spec.ts` exercises GPT-5.4 Mini and Claude
Haiku against the real processor and fails visibly when either provider key is
absent.

Hosted default instructions add the discovery guidance only when the runtime
actually installs `BrainstrikeToolSearchProcessor`. They tell the model to call
`search_tools` for deferred capability families before substituting eager glob
or shell tools. The live matrix passes that processor through Mastra
`runEvals.targetOptions`: Brainstrike owns input processors at the per-call
stream seam, so targeting the bare Agent without those options is not a valid
discovery evaluation.

Discovery observability is content-minimizing by default. Production logs may
record query length plus the original ranked tool ids and finite scores, but
never the raw query, tool schemas, or credentials. The exact query is available
only to an explicit in-memory observer used by the opt-in live evaluation; it
is neither logged nor persisted. The live evaluation also records the final
tool choice and scorer verdict so a retrieval success cannot be mistaken for a
successful model decision.

The telemetry wrapper clones Mastra's `search_tools` value with its original
prototype and complete own-property descriptors, then replaces only the
description and executor on that fresh clone. It never mutates or wraps the
Mastra-owned value in place. Mastra 1.51 context storage is also pinned as
empty-or-complete for approval resume: its same-process supplemental set is
additive by thread, while live message-derived names are unioned with that set.
The adapter compatibility test loads two disjoint tools and requires the direct
resume lookup to return both without durable recall. If a future Mastra release
permits a partial non-empty set, update the adapter to merge the post-gate
durable and delegate sets deterministically; do not add a speculative fallback.

Mastra owns the fixed `search_tools` catalog meta-tool id. When a surviving
eager/core or deferred definition has an original id whose canonical sanitized
form is `search_tools` (including `search.tools`), a run with deferred catalog
discovery throws `mastra_agent_tool_name_collision` before constructing the
Agent. The error reports only the original, sanitized, and reserved ids. A run
with no deferred definitions installs no catalog processor and preserves a
caller-owned `search_tools`; never rename the collision, disable discovery, or
widen the eager surface silently.
Brainstrike configures `search.autoLoad: true`, so Mastra omits its optional
`load_tool` meta-tool and a caller-owned `load_tool` (including `load.tool`
after sanitization) remains valid alongside catalog discovery. If discovery is
ever changed to manual loading, reserve `load_tool` and update the compatibility
tests in that same change.
Persisted `search_tools` results reconstruct loaded definitions after restart;
approval and suspended-tool resume rehydrate those definitions from the durable
Mastra thread before the paused call reaches execution. Anonymous calls never
share a default store. A loaded-set shrink within one runtime/thread (for
example, trimming away its discovery result) throws the typed
`mastra_agent_tool_discovery_failure` instead of silently de-loading.
`TOOL_DISCOVERY_FAILURE_CODES` pins the distinct
failure channels as `catalog-miss`, `permission-denied`, `host-unavailable`, and
`unsupported-adapter`; adapters must not collapse them into an empty result.

#### Provider-native decisions (BST-614 and BST-680, 2026-07-21)

Provider-native support is declarative, not live. The measured decision remains
`mastra-catalog-search` for every hosted production route:

- OpenAI GPT-5.4 Mini and GPT-5.6 Luna both reached native hosted search, then
  failed on the second request because the AI SDK serialized the same stored
  `tool_search_output` item reference twice. OpenAI rejected the request as a
  duplicate item. The latest available OpenAI adapter source retained the same
  branch, so a version bump is not an accepted fix without a captured-request
  regression.
- Anthropic Claude Sonnet 4.6 preserved deferred definitions, approval
  suspension, execution, and approval resume. It missed the target tool from a
  normal task prompt, however, and succeeded only when instructed to issue a
  search query matching the tool description. That successful run had no
  material token/cost advantage over the Mastra baseline.
- The identical Mastra catalog scenario selected and executed the target on all
  three models. Do not trade this quality floor for a smaller unsuccessful
  request or a one-turn improvement that needs answer-specific prompting.

BST-680 subsequently removed OpenAI's duplicate-item blocker without a patched
dependency. Live GPT-5.4 Mini and GPT-5.6 Luna native runs then selected and
executed both semantic and exact-path targets with distinct `tsc_...` and
`tso_...` references. Production adoption still failed its paired economic
gate: compared with the same Mastra catalog, native used 69–117% more input
tokens and cost an estimated 36–79% more across all four comparisons. It was
also slower on both GPT-5.4 Mini scenarios; Luna's isolated exact-path latency
win was not a consistent cross-model advantage. The broader paid matrix stopped
at that failed gate. The full measurements and revisit condition are in
`docs/agents/research/bst-680-openai-native-tool-search-requalification.md`.

There is no fallback between discovery adapters. A future provider-native slice
must be selected explicitly and independently prove provider-history
serialization, normal-prompt selection/miss quality, post-policy catalog
admission, MCP/provider-web coexistence, approval suspension, durable restart
resume, cache behavior, and non-inferior token/cost measurements. The complete
evidence and live tables are in
`docs/agents/research/bst-614-native-tool-search-spike.md` and
`docs/agents/research/bst-680-openai-native-tool-search-requalification.md`.

#### Programmatic orchestration decision (BST-616, 2026-07-21)

Do not add a production programmatic-orchestration mode yet. GPT-5.6 Luna's
hosted Programmatic Tool Calling cut input tokens by 71–94% and estimated cost
by 56–89% on three bounded fan-out workloads, but it was strictly correct on
only one of three first runs; direct calling passed all three. The installed
Mastra 1.51.0 / AI SDK OpenAI 4.0.8 path also cannot express the hosted tool,
`allowed_callers`, function `output_schema`, nested `caller`, or `program` /
`program_output` continuation items. Do not add casts or a raw parallel
Responses loop around Mastra's provider-history, persistence, suspension,
telemetry, and processor contracts.

OpenCode Code Mode validates the local architecture shape: a confined
interpreter over a permission-filtered catalog can reduce fixed read-only
programs without ambient filesystem, process, network, or module authority.
Its host must still reauthorize every nested call and set explicit timeout,
call-count, concurrency, and output budgets. The measured fixed programs were
correct and kept 98–99% of raw intermediate characters out of their final
results, but they were hand-authored and therefore do not establish
model-authored-program quality.

If upstream support and model quality later clear the recorded gates, the exact
program-visible candidate allowlist is `readWorkspaceFile`,
`readWorkspaceDirectory`, `globWorkspace`, `grepSearch`, and
`findWorkspaceSymbol`, intersected after capability, user-enabled, and
permission admission. Keep semantic/adaptive retrieval, web/citation work,
artifact continuation, MCP discovery, LSP diagnostics, command sessions,
shell, approvals, writes, task/plan state, external actions, and unknown tools
direct. There is no silent route switch. Full evidence is in
`docs/agents/research/bst-616-programmatic-orchestration-spike.md`.

The live assembly order is pinned by `TOOL_DISCOVERY_PIPELINE_ORDER`:
capability/permission eligibility → guards/hooks → plan/permission/suspend gates
→ provider-native web-search swap → output settlement/projection → skills
metadata → discovery → projection-safe stale-history filtering →
provider-history compatibility → projection-aware token limiting. Initial,
approval-resume, and suspend-resume
calls all use the same per-runtime processors in the per-call input stack:
SkillsProcessor → tool search → ProjectionSafeToolCallFilter →
ProviderHistoryCompat → ProjectionAwareTokenLimiter. Token limiting remains
last so it counts injected skills metadata, loaded definitions, filtered tool
history, and normalized provider history. Public direct stream processor
overrides stay rejected.

The full hosted desktop tool surface has two measured prompt budgets:
`apps/desktop/src/__tests__/assistant-server/native-tool-prompt-budget.test.ts`
builds the real registry and resolved hosted instructions with the default
skills engine enabled. That means both guards include `skill`, `skill_read`,
and `skill_search`, the conditional skills guidance, and a representative
first-turn `SkillsProcessor` metadata block. The canonical authored
representation converts the real Zod inputs through the Standard Schema input
protocol and must stay INSIDE the 8,650-8,950 `o200k_base` band (BST-927/
BST-980): the ceiling is the bloat gate with real headroom (an unrelated
one-word description edit no longer trips the required Unit check), and the
floor fails just as loudly when a tool or schema silently falls out of the
registry. When the ceiling fires, trim before raising; move both bounds
together (the ~300-token width is the contract) and record the trade in the
test's comment ledger. The live actual Mastra/OpenRouter core surface and
resolved instructions must stay between 2,000 and 5,000 tokens, materially
below the retired 11,500-token eager boundary. A real
Mastra-loop capture separately proves the first provider request contains that
core plus `search_tools`, and that a later request appends the discovered
definition. Dynamically loaded definitions are append-only within the active
context and counted by the last-position token limiter.

Both are whole-surface regressions, not estimates from descriptions alone.
Recover budget by removing duplicated prose and preserving one canonical
definition. Do not weaken validation constraints, spoof provider/model
identity, or remove cross-tool safety/workspace invariants to make either
number pass. Changing Mastra compatibility behavior requires a supported
upstream contract plus captured-request tests proving omitted optionals and
invalid/null inputs retain their authored semantics.

The same fixture also pins the authored definition-only comparison for this
contract: the eager baseline is 32 tools with its aggregate recorded at 8,121
`o200k_base` tokens (banded +/-150 like the surface gates; the tool COUNT
stays exact — it is the precise dropped-tool catcher), while the live critical
definition surface is 8 tools recorded at 2,166 tokens (same band treatment)
before the compact `search_tools` control is added. System instructions, provider conversion,
skills metadata, and each dynamically loaded definition remain part of the
captured-request and last-position limiter budgets.

Persistent commands use two deferred model tools, not six operation-specific
definitions: `inspectCommandSessions` owns read-risk list/read, while
`manageCommandSession` owns execute-risk start/write/stop/remove. Each schema is
a provider-compatible root object containing a nested discriminated `operation`
union. This prevents models from filling irrelevant action fields while keeping
the critical request unchanged; together the two deferred definitions add 809
tokens to the pre-session eager baseline. A single mixed-risk tool is forbidden
because it would either hide harmless inspection behind execute approval or expose
process control as read; top-level schema unions are forbidden because hosted
providers require a root object. Plan mode keeps inspection and omits
management. Inventory pages continue with `offset`, and PTY reads continue with
the exact returned `nextCursor`; both raw result shapes stay below a 5,500-byte
UTF-8 producer ceiling. Their canonical ids are also explicitly excluded from
durable artifact settlement so a hook envelope cannot create a seven-day copy.
Target-aware transcript transforms retain safe action, session, cursor, and
length metadata but redact command strings, cwd, stdin, input deltas, PTY
output, and guarded error messages/reasons before persistence. The built-in local
provider gets neither definition because it has no deferred-discovery path and
would otherwise pay both schemas eagerly.
Desktop registers the capability; Web has no desktop registry, uses the explicit
`WEB_NATIVE_TOOL_IDS` UI/request partition, and therefore exposes neither tool.

The desktop Terminal surface exposes those process-owned sessions through the
capability-gated `window.commandSessions` bridge. Its list/read/write/stop/remove
operations always include the durable workspace root id; the manager rejects a
session owned by another root with the same not-found error. Reads are paged at
32,768 UTF-16 code units with an advancing absolute cursor, explicit `hasMore`,
and the manager's gap/truncation signal. The manager applies that limit while
decoding retained blocks, before joining the page, and never splits a surrogate
pair. IPC retains a fail-loud 32,768-unit assertion; it never materializes and
then silently trims a larger manager result. The same manager-side page bound
applies to the model inspection tool. The renderer retains at most 128 KiB of
visible output. This bridge does not add a second process registry, persist the
command/cwd/environment/output, or exist on Web. Because the manager lives in
Electron main, the inventory reattaches after a renderer reload while normal
shutdown, factory reset, and root removal still reap it through the existing
lifecycle.

---
