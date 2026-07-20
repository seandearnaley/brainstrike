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
  - Hosted Web: local Vite and protected Vercel Preview may read the server-only
    OpenAI environment key and build an OpenAI runtime with the registry default
    model. Because the Vite process holds a developer credential, its assistant
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
    expose the key through a `VITE_`-prefixed variable. The shared renderer's
    model, provider, generation, loop, MCP, and enabled-tool fields are
    wire-compatibility hints only and are never copied into that trusted runtime.
    `resolveWebAssistantRuntime` copies an explicit allowlist of non-privileged
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
- OpenRouter request options use the native `providerOptions.openrouter`
  namespace. The shared reasoning controls map to
  `{openrouter:{reasoning:{effort,summary}}}`; never reuse the OpenAI camel-case
  `{openai:{reasoningEffort,reasoningSummary}}` shape, which Mastra's OpenRouter
  adapter ignores.
- OpenRouter reasoning controls are model-capability-aware when the Models API
  publishes `reasoning.supported_efforts`. Declare those efforts on the static
  model definition; `resolveReasoningControlsAvailability` in
  packages/assistant-contract/src/model-reasoning.ts is the single resolver
  that filters the UI controls (the composer model menu's Effort submenu) to
  the declared set, and the request boundary rejects incompatible settings at
  construction. Its sibling `resolveModelReasoningSupport` is deliberately
  separate: an UNDECLARED OpenRouter model keeps the full effort list for the
  controls (the request boundary accepts `openrouter.reasoning` for any model)
  while its capability badge resolves to a visible `unknown` ("unverified") —
  never a silent yes/no. On an explicit model switch, clear an incompatible
  provider-wide effort override so the newly selected model uses its documented
  default; do not map it to a guessed nearest level.
- Reasoning-control placement: effort/level selection and the primary Thinking
  toggle live in the composer model menu (packages/ui/src/assistant-ui-panel/
  composer-model-menu.tsx, backed by reasoning-effort-controls.tsx). The
  Controls menu's provider section is now "Output & Limits" (formerly
  "Reasoning & Output") and keeps only agent runtime limits, max output,
  OpenAI reasoning summary, the Anthropic numeric thinking budget, and the
  Google include-thoughts debug toggle. Moved controls must emit
  byte-identical settings updates to the old panel sections (pinned by
  write-through tests in composer-model-menu.test.tsx).
- Static OpenRouter prices are estimates for pre-existing/unreported usage.
  Exact provider-reported cost is authoritative because routing, caching, BYOK,
  and provider tiers can make the catalog rate differ from the billed amount.
- When the user has not set an output limit, OpenRouter requests use a 4,096
  token per-step default. Mastra's provider otherwise expands an omitted limit
  to the model's full output ceiling, which can make OpenRouter reject even a
  tiny prompt during credit preflight. Explicit user limits remain authoritative.
- State:
  - packages/preferences/src/stores/assistant-preferences-store.ts
  - packages/app-shell/src/assistant-thread-store.ts
  - Assistant preferences persist the most recently selected model as the default for the next
    new thread, plus a capped `recentModels` list (composite keys, newest first) that feeds the
    composer model menu's top-level rows. The thread store persists each existing thread's model and provider settings so
    switching chats or restarting the app restores that thread-specific runtime.

Assistant status endpoint resolution (in order):
1. window.assistant.getUrl()  (async)
2. window.assistant.url       (static)
3. /api/assistant/status      (fallback)

An enabled Hosted Web status response advertises its trusted server runtime as
`{enabled:true,provider:"openai",model:<registry default>}`. The app shell
validates both values against the shared provider registry and exposes only
that fixed server model in the picker; it must not attempt renderer-side key
discovery or pretend client model toggles control a server-owned runtime.
Desktop status may omit both fields, in which case its encrypted-key discovery
remains authoritative. The pair is atomic, and incomplete or unknown runtime
metadata fails visibly.

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
1. `brainstrike.grepSearch` — FIRST for exact strings, identifiers, error messages. Two-phase: trigram-indexed ILIKE/regex-literal prefilter (`FileChunkRepository.findGrepCandidates`) + authoritative JS line matcher (`GrepSearchService` in packages/db/src/search/). Regex patterns with no extractable ≥3-char literal fall back to a bounded scan surfaced via `scanLimited` (never silent). Desktop-only wiring in apps/desktop/src/assistant-server/grep-search-tool.ts. Progressive disclosure: default `outputMode: 'files'` returns per-path match counts (cheap survey); `outputMode: 'content'` returns line matches with context; both support `offset` paging.
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
   Anthropic/OpenAI) and `brainstrike.webExtract` (report R5 — reads up to 5
   PUBLIC pages behind results/user URLs as markdown, Tavily `/extract`; it has
   NO provider-native swap and must stay Tavily-backed). Both are keyless-
   HONEST (`available:false` + actionable message, never a throw) and
   non-fatal on network errors. webExtract additionally validates every
   model-supplied URL BEFORE anything is sent (http/https only, no embedded
   credentials, no private/loopback/link-local hosts — IPv4 literal ranges +
   IPv6 `::1`/`fe80::/10`/`fc00::/7`; public hostnames are NOT DNS-resolved
   locally since the fetch runs on Tavily's servers, the guard keeps clearly
   internal URLs from leaving the machine) and reports every refusal per-URL
   in `failed` — never a silent drop. Content is bounded per page (6000 chars)
   and overall via `fitItemsToCharBudget`. Hermetic tests:
   apps/desktop/src/__tests__/assistant-server/web-extract-tool.test.ts.

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
If the requested page exceeds the envelope, it shortens the page and returns
an opaque `nextCursor` that resumes at the exact source line and column,
including within a long generated/minified line. The cursor is bound to the
workspace root id, workspace path, byte size, and mtime; selecting another root
or changing the file fails visibly instead of resuming against different
content. `omittedChars` counts exact unread source characters; when a page ends
after a complete line, that includes the source newline before the next line.
Desktop reads each page from one containment-checked file handle: the same
handle is statted before and after the read, binary-probed, and decoded as fatal
UTF-8 in 64 KiB chunks. It retains only page-sized source fragments plus line
and character counters; it still scans to EOF because `totalLines` and
`omittedChars` are exact public metadata, never estimates. Full-file allocation
remains reserved for consumers that require the complete source, such as symbol,
LSP, and tapestry-range processing.
Pass `nextCursor` back unchanged as `cursor`; when `root` is omitted on
a continuation, the cursor's root id selects the same workspace root. An
explicit different root is rejected. Prefer omitting `startLine`/`endLine` on
a continuation. A v2 cursor also binds the original requested range so an
exact provider replay of either field is accepted, while a changed range fails
visibly. Existing v1 cursors remain valid when range fields are omitted.
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

Guarded failures (`tool_timeout`, `tool_failed`, `tool_blocked_by_hook`) bypass
domain projectors and retain the bounded structured failure. For successful
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
private carrier retains the original result without leaking it into persistence.
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
root-qualified paths, 1-based grep locations, count/source/scan-limit state,
and authoritative continuation guidance while fitting the 6000-character
domain budget.
Because Mastra's one-argument projector receives the raw result but not the
original tool input, paging guidance tells the model to reuse the prior call;
it never fabricates or duplicates the original pattern. When the whole raw page
fits, the projection preserves the producer's bounded hint because the producer
owns service caps and scan-limit semantics. Only when the tighter projection
budget omits raw page items does the projector calculate an earlier advancing
`offset`. A truncated result without producer guidance throws instead of
guessing. Oversized paths and match context are clipped with an explicit
omitted-character marker, and malformed result shapes throw rather than falling
back to generic JSON.
`findWorkspaceSymbol` and `lspInspect` keep their complete typed raw results for
display, persistence, hooks, and reload while their Mastra `toModelOutput`
projections emit bounded line-oriented inspection summaries. Symbol output
retains the root/path, 1-based declaration line and enclosing range,
declaration text, preview, total/truncation state, and honest instructions for
forming the existing `lspInspect` cursor marker. It does not invent a symbol
kind or the original symbol query: Mastra's one-argument projector receives the
raw result but not the original input. LSP output retains availability/reason,
language, hover text, diagnostics, and definition/implementation locations.
Projection-only omissions are counted explicitly, malformed result shapes
throw, and raw tool results are never mutated.

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
  entries in `NATIVE_TOOL_INPUT_SCHEMAS`.

Adding or renaming a native tool must update the canonical catalog first, then
the exact metadata/schema maps, live desktop registry, exports, and conditional
model-facing guidance. The parity tests fail on stale, missing, or extra keys;
there is no fallback alias or partially registered tool.

The full hosted desktop tool surface has two measured prompt budgets:
`apps/desktop/src/__tests__/assistant-server/native-tool-prompt-budget.test.ts`
builds the real registry and resolved hosted instructions with the default
skills engine enabled. That means both guards include `skill`, `skill_read`,
and `skill_search`, the conditional skills guidance, and a representative
first-turn `SkillsProcessor` metadata block. The canonical authored
representation converts the real Zod inputs through the Standard Schema input
protocol and must remain at or below 7,900 `o200k_base` tokens. The actual
OpenRouter representation comes from Mastra's public
`agent.getToolsForExecution({})` boundary and must remain at or below 11,500
tokens. Mastra 1.51 currently expands optional fields for the routed
`openai/*` model, so the actual-provider guard is intentionally higher and
must not be replaced with the authored estimate.

Both are whole-surface regressions, not estimates from descriptions alone.
Recover budget by removing duplicated prose and preserving one canonical
definition. Do not weaken validation constraints, spoof provider/model
identity, or remove cross-tool safety/workspace invariants to make either
number pass. Changing Mastra compatibility behavior requires a supported
upstream contract plus captured-request tests proving omitted optionals and
invalid/null inputs retain their authored semantics.

---
