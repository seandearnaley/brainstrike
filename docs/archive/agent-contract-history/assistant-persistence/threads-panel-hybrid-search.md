# Threads panel hybrid search — evidence

Supports `docs/agents/assistant-persistence.md` §
"THREADS PANEL HYBRID SEARCH". Read this before proposing to change the index, the HNSW transaction, the sync passes, fusion, or delegated search scope.
The contract holds the rules; this file is the record behind them, extracted
verbatim from the pre-distillation contract.

Hybrid (lexical + semantic + title) search over threads, rendered at the top
of the Threads panel. Mastra has no cross-thread content search
(`listThreads` filters metadata only; `semanticRecall` is vector-only,
per-thread, retrieval-for-context), so this is Brainstrike-owned derived
state under the SAME ownership ruling as thread groups: never ALTER the
Mastra tables.

Where state lives (do not relitigate):
- Index: `brainstrike_thread_message_index` (migration 067; one row PER
  mastra message, no FKs — orphans are inert via query-time joins and swept
  by the bounded sync GC). `content_text` is bounded plain text extracted
  IN SQL from the Mastra v2 content JSONB (text parts only — tool payloads
  are never indexed; non-conversational roles keep '' so the anti-join sync
  still sees them as processed). `content_hash` = md5 of the RAW content
  JSONB: the sync upsert's `IS DISTINCT FROM` CAS detects progressive
  same-id saves and resets the row's embedding to pending. The tsvector is
  a STORED generated column (034 precedent) + GIN; deliberately NO
  pg_textsearch BM25 index (the 065/066 durability-gate burden is not
  re-paid for a second hot-write table; ts_rank_cd orders the lexical arm).
- Semantic arm HNSW tuning (BST-576): `searchSimilar` runs its filtered ANN
  SELECT inside ONE transaction with `SET LOCAL hnsw.ef_search` +
  `iterative_scan='strict_order'` (`SET LOCAL` outside a transaction is a
  silent no-op → pgvector default ef_search=40, the #1141 filtered-ANN
  under-return class). Path order in `runVectorSearchInTransaction`: desktop
  runs the `ThreadSearchDatabase.runTransaction` atomic IPC primitive; web
  (ScheduledDbHandle) and raw PGlite handles run the callback-style
  `transaction`, which holds the single connection's lock so concurrent
  scheduled work (the controller's embedding-backlog writes run alongside
  searches) cannot interleave inside the open transaction; the raw
  BEGIN/COMMIT-over-`query` fallback remains only for legacy/mock seams.
  Paired tests: the mock-db describe in
  `packages/db/__tests__/search-thread-message-index.test.ts`.
- Embeddings: per-message inline `vector(384)` column (typed to the
  singleton profile; a partial HNSW index serves the semantic arm) with the
  singleton `brainstrike_thread_search_profiles` row — the prompt-library
  (051) pattern, NOT the file-collection `embedding_sets` lifecycle, and NOT
  the hidden-host job_queue: embedding runs in the visible renderer through
  the registered embedding queue factory + shared `SearchEmbedderProvider`,
  drained in bounded sequential resource-scoped passes. Writes are
  double-CAS'd: content hash (stale text) AND profile model key (a
  mid-flight same-dimension model swap must not land a cross-space vector).
  The source hash covers role + raw content, since extraction depends on
  both.
- Sync: `ThreadSearchRepository.sync()` — a row-count membership fast path
  (idle searches pay two COUNTs, not anti-join scans; a same-count
  delete+insert pair defers one pass and heals on the next divergence),
  bounded anti-join inserts, a PER-THREAD refresh
  (`brainstrike_thread_search_state`: threads strictly newer than their own
  recorded activity, plus a trailing 2-minute live window for same-id
  progressive saves — never a global watermark, which could let one busy
  thread push a quiet thread's pending change out of the refresh window
  forever), and bounded orphan GC. Runs per search pass behind a 5s TTL and
  an in-flight guard (concurrent searches share one sync); every statement
  is bounded (single-PGlite-connection contract).
- Fusion: `ThreadSearchService` (packages/db/src/search/thread-search-service.ts)
  is the thread-native binding of the SHARED generic RRF core (`rrf.ts`) —
  `HybridSearchService` stays FileChunk-bound on purpose; do not fake chunk
  shapes to reuse it. Two levels: message arms (FTS + vector) fuse per
  message id, then content-ranked threads fuse with trigram-ranked title
  matches (title+content beats equal content-only; title-only threads still
  surface). Titles are matched live off `mastra_threads` (few + mutable),
  never copied into the index.
- UI/state: session-only `thread-search-store.ts` (app-shell) with the
  workspace-search generation contract (monotonic token gates every async
  completion; `clearResults` keeps the typed query, `clearSearch` is the
  full Esc/✕ dismiss). Like workspace-search, `setQuery` deliberately does
  NOT bump the generation — the debounced auto-search owns that transition,
  so the previous query's results may render for ≤ debounce+search time
  (settled; keep the two stores' contracts aligned).
  `use-thread-search-controller.ts` owns debounce (250ms, 2-char minimum),
  sync, the embedding backlog drain, and semantic honesty: an unproducible
  query embedding runs lexical-only WITH a visible `unavailable` reason
  (failure cached 60s so searches never stall behind a repeatedly-failing
  model init; a success recorded after a stale attempt started wins), plus
  coverage progress AND embedding-failure counts — never a silent downgrade
  or a silently shrinking semantic corpus.
  `ThreadsPanelSearch` renders ts_headline `<mark>` tokens as elements and
  everything else as plain text (persisted content is never HTML), with
  aria-activedescendant keyboard nav. While searching, the tree is hidden
  (not unmounted) so disclosure/selection state survives dismissal.
- Delegated search scope (BST-1725): lexical, semantic, title and embedding-coverage reads walk the durable child graph from native roots owned by the requested resource. Every child edge checks owner/root identity and the native resource, including intermediate ancestors. Child native resource IDs remain unchanged; search does not broaden ordinary memory authorization. Activation rechecks the selected native message and rejects tombstoned/deleted/foreign hits visibly.
- Explicit child search navigation uses the ordinary history mapper with an exclusive `(createdAt, id)` cursor. Each older-page read is capped at 80 and scoped to the same native thread/resource; ordinary opening still loads only the latest 80. A cancelled or superseded navigation stops paging. Hydrated assistant groups retain `brainstrikeNativeMessageIds` so raw search IDs select their actual rendered group. Older context supplements the host baseline; the host keeps its current head and live decision state. Navigation intent lives in the existing factory-reset-registered session search store, never in a new persistent store.
- Cleanup: panel thread deletion clears index rows eagerly (like
  placements); missed paths self-heal via sync GC. Factory reset clears
  `brainstrike_thread_message_index` + `_state` on BOTH the desktop
  db:clearAll path and the web DbProvider paths; the search profile row is
  configuration and survives (prompt-profile precedent). The session store
  registers in `register-factory-reset-session-stores.ts`.

Paired tests: `migration-067-thread-search-index.test.ts`,
`search-thread-message-index.test.ts`, `delegated-thread-search.test.ts`, `search-thread-search-service.test.ts`
(packages/db); `thread-search-store.test.ts`, `thread-search-embedding.test.ts`,
`use-thread-search-controller.test.ts`, `threads-panel-search.test.tsx`,
`delegated-child-reload.integration.test.tsx`
(packages/app-shell).

