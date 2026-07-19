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
- API keys:
  - Managed via Settings.
  - Desktop: encrypted keychain.
  - Hosted Web: the server reads only its OpenAI environment key and builds an
    OpenAI runtime with the registry default model. The shared renderer's model,
    provider, generation, loop, MCP, and enabled-tool fields are
    wire-compatibility hints only and are never copied into that trusted runtime.
    `resolveWebAssistantRuntime` copies an explicit allowlist of non-privileged
    request metadata only after strict runtime validation of every value,
    including bounded strings, arrays, numbers, and strict nested objects.
    Malformed known fields and server-only or unknown fields (including `apiKey`,
    `mcpConfig`, `mastraTools`, and `permissionPolicy`) fail with
    `invalid_runtime_data` / HTTP 400. TypeScript types alone are not a request
    trust boundary. The Web request therefore cannot create tools, launch stdio
    MCP, replace provider credentials, or set server cost policy through
    serialized runtime data. Production route handlers and the Vite dev/preview
    middleware share the canonical assistant request-body limit contract:
    declared and streamed/chunked overflow is byte-counted before JSON parsing
    and fails visibly with `request_body_too_large` / HTTP 413 while the Node
    stream drains. Malformed JSON fails without logging its value as
    `invalid_json` / HTTP 400. Before recursive assistant-ui compatibility
    normalization, the shared iterative message boundary caps message and part
    counts, graph nodes/depth, object fields, and string sizes. It rejects
    cycles, non-plain objects, and non-JSON scalars (including bigint and
    non-finite numbers) while permitting `undefined` for optional in-memory
    fields. Violations fail as `invalid_messages` / HTTP 400. One shared
    compatibility traversal extracts both text and attachments: every
    `type: "file"` candidate is validated before scalar extraction, so malformed
    candidates fail visibly and valid nested files cannot be flattened or
    silently dropped. Attachment validation failures return a safe
    `invalid_attachment` / HTTP 400 response. After normalization, chat requests
    require at least one effective message and normal assistant turns require a
    non-empty prompt on both production and Vite dev/preview routes. Assistant
    resume requests consume the bounded body before session lookup so reconnects
    cannot bypass the cap. Wire-compatible provider/model/tool hints are
    strictly bounded and validated before they are discarded, including
    iterative depth/cardinality/string/number limits for arbitrary provider
    options.
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
`countTokensHeuristic`). Native producers self-bound result lists to
`NATIVE_TOOL_RESULT_TOKEN_BUDGET` (2750) via `fitItemsToCharBudget`. The Mastra
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

MCP does not yet have durable artifact settlement, so its persistence channel
has a separate temporary inline ceiling: text/JSON is bounded to
`MAX_TOOL_RESULT_TOKENS` (3000); multimodal output keeps raw media only up to
the assistant aggregate encoded-media ceiling and 12000 non-media serialized
characters. Multimodal `content` arrays containing any non-object part are
malformed and throw before persistence accounting. Exceeding either ceiling
throws visibly—never drops media. The artifact-store PR must replace this
temporary compromise.

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
