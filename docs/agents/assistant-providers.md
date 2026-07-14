# Assistant Providers, MCP Transports, Native Tools

> Extracted from AGENTS.md (2026-07-12). Read before changing provider config, MCP transport selection, or assistant native tools/registries. Keep updated with the code.

## AI ASSISTANT INTEGRATION

- Supports: OpenAI, Anthropic, Google, OpenRouter.
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
- Config:
  - packages/agent/src/providers/registry.ts
  - packages/agent/src/providers/key-resolver.ts
  - packages/agent/src/providers/provider-factory.ts
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
    new thread. The thread store persists each existing thread's model and provider settings so
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
2. Official client — `packages/agent/src/mcp/explicit-http-client.ts`, exported
   only from `@brainstrike/agent/mcp-client`, owns the SDK 1.29 HTTP transports,
   lazy/concurrency-safe connection, header composition, request forwarding,
   session termination, and idempotent close. Keep the SDK package external in
   the agent build; do not pull this edge into browser-safe/root exports.
3. Desktop — `apps/desktop/src/mcp/http-client.ts` adapts that shared client to
   the desktop `McpClient` discovery/call contract. `sse-client.ts` is only a
   compatibility factory delegating to the canonical adapter; no bespoke SSE
   framing, endpoint rewriting, or environment-selected call path remains.
4. Agent runtime — `packages/agent/src/mastra/mcp-runtime-client.ts` partitions
   servers. Mastra `MCPClient` handles `stdio` ONLY; explicit HTTP clients are
   converted into Mastra tools and combined through the existing pipeline:
   discovery → namespace/sanitize → output bound → guard → hooks → permission.
   Remote progress uses the distinct transient
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
3. Hybrid FTS+vector RRF fusion (`HybridSearchService`) backs UI search paths. The
   lexical arm is MATCH-PRESERVING BM25 (migration 053): matching stays tsvector
   (`content_tsvector @@ tsqueryFunc(...)`, so plain/websearch/phrase semantics are
   unchanged) while ORDERING is `-(content <@> to_bm25query(q, 'idx_file_chunks_content_bm25'))`
   — negated so `FTSSearchResult.rank`/`ftsRank` stay higher-is-better (unbounded,
   corpus-dependent; ts_rank-era fixed thresholds do not transfer). `, id` tiebreaks
   keep ordering deterministic (BM25 ties are common). `rankNormalization` is inert.
   RRF fuses rank POSITIONS, so the fusion layer is unchanged.

Tool output budget (anti-thrash contract): budgets are token-denominated (`NATIVE_TOOL_RESULT_TOKEN_BUDGET` 2750, guard `MAX_TOOL_RESULT_TOKENS` 3000 in packages/agent/src/stream/tool-output-limits.ts) and enforced deterministically on serialized chars at 4 chars/token (mirrors `countTokensHeuristic`). Native tools self-bound their result lists via `fitItemsToCharBudget` and return SUCCESSFUL partial results with `truncated: true`, totals, and an actionable `hint` (offset/filters) built INSIDE the budget-fitted candidate — never a size error. The transport guard (`boundToolOutputForModel`) is a backstop: oversized collection-shaped outputs (matches/entries/results/items/files/chunks/rows) are structurally trimmed to fit with the same truncated+hint contract; only opaque non-collection outputs (e.g. MCP strings) still produce the `tool_result_too_large` error+preview, reported in ~tokens. Do not reintroduce hard size failures for native tools. `listWorkspaceContext` is concise by default (counts + token budgets); `detail: true` returns per-file Tapestry ranges.

Adding/renaming an assistant native tool is multi-registry: zod schema + schemaMap in packages/agent/src/tools/schemas.ts, agent package exports, NATIVE_TOOL_DEFAULTS (tool-categories.ts), TOOL_DESCRIPTIONS, NATIVE_TOOL_SCHEMAS (tool-schemas-display.ts) — all in packages/assistant-contract — plus the live registry in apps/desktop/src/assistant-server/assistant-tools.ts and the model-facing guidance in packages/agent/src/mastra/default-instructions.ts.

---
