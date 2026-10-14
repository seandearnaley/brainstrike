# Search verbs and vector routing — evidence

Supports `docs/agents/assistant-providers.md` § "ASSISTANT SEARCH TOOLS". The remaining search verbs, the web retrieval pair, and the adaptive vector routing benchmark.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 4053-4133); append rather than
rewrite.

---

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
   lexical arm matches with built-in PostgreSQL FTS over migration 034's
   generated tsvector + GIN index and orders those matches with the
   migration-066 pg_textsearch BM25 index plus an `id` tiebreaker; the caller's
   language and query mode remain authoritative for matching (BM25 orders but
   never matches — see `docs/agents/database.md`). RRF fuses rank positions,
   so the fusion layer is unchanged.
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
