# Turso Search Index Architecture

## Current Verdict

The Turso capability spike is ready for the next migration phase only if Brainstrike does not require Turso FTS custom indexes to live in the same MVCC-enabled database file as the primary writable store.

This readiness is a capability and planning checkpoint. The current migration
branch now exposes the selected search ownership mode in the Turso bootstrap
report and has primary-store implementations for bounded grep candidates and
native vector similarity. It also has a primary-store lexical implementation
for repository `fullTextSearch()` that can feed hybrid search without native
Turso FTS custom indexes. It does not mean Tantivy/native FTS snippets or
ranking are implemented in the primary store.

The verified capabilities are:

- Turso filesystem store opens and closes from Node.
- Basic SQL, transactions, and MVCC concurrent writes work with `BEGIN CONCURRENT` retry handling.
- Native vector storage and exact top-k distance queries work.
- Turso FTS custom indexes work in a non-MVCC database.
- Turso FTS custom indexes fail in MVCC mode with `Custom index modules are not supported in MVCC mode`.

That last item is not a blocker for the product migration by itself. It is a storage ownership constraint.

## Required Contract

The primary Turso store owns durable application state and must use MVCC for concurrent writes.

Search indexing must be explicitly owned by one of these paths:

- a separate Turso search-index store that is not MVCC-enabled and can be rebuilt from primary state,
- a Turso-compatible non-FTS search implementation with clear capability checks,
- or a future Turso runtime where FTS custom indexes work inside MVCC, proven by the capability spike.

Do not silently replace indexed search with an unbounded scan. If a search index is unavailable, the bootstrap/capability report must say so directly and the affected tool or UI path must fail closed with a diagnostic.

## Migration Touchpoints

- `packages/db/src/bootstrap/turso-capability-spike.ts`: source of truth for current Turso runtime capability evidence.
- `packages/db/src/search/hybrid-search-service.ts`: currently models lexical
  and vector sources as repository-provided inputs; keep this shape, but Turso
  repositories must be explicit about whether they provide primary-store lexical
  scoring or native Tantivy FTS ranking/snippets.
- `packages/db/src/search/grep-search-service.ts`: current PGlite path relies on trigram candidate prefilter plus authoritative JavaScript matching. Turso must provide an indexed candidate source or expose bounded scan limits explicitly.
- `packages/db/src/repositories/drizzle/*`: current repositories are Postgres/PGlite Drizzle shaped. Turso will need dialect-specific repositories rather than SQL string compatibility.
- `packages/db/src/drizzle/migrate.ts`: current migration runner is PGlite/Postgres specific. Turso migration work should add a separate migration ledger instead of forcing existing generated SQL through libSQL.
- `apps/desktop/src/db-main.ts`: desktop remains the likely owner for filesystem Turso runtime and bootstrap reporting.

## Current Implementation Step

The Turso profile bootstrap contract opens the primary MVCC store and returns a
typed capability report with `search.ownershipMode = "split-search-index-store"`.
It also requires concrete search checks before the desktop DB host accepts a
ready Turso report:

- `search.grep-content-grams` for bounded indexed grep candidate lookup.
- `search.vector32-functions` for native `vector32(?)` similarity retrieval.

Desktop assistant grep and semantic vector retrieval are routed through those
proofs. Hybrid retrieval can use the repository lexical source backed by
`file_chunk_content_grams` and `file_chunk_content_index`, which satisfies the
"Turso-compatible non-FTS search implementation" ownership path above.
Quick-open filename search is a separate name-gram sidecar path backed by
`file_record_name_grams` and `file_record_name_index`, not by
`search.grep-content-grams`. Do not route native Tantivy FTS through the primary
MVCC store until a split
search-index owner or a future MVCC-compatible Turso FTS runtime is proven.

## Split Native FTS Trigger

The current migration path keeps primary-store gram lexical search for parity.
The real-engine quality profile in
`docs/turso-migration/2026-07-03-turso-lexical-search-quality-profile.md`
records exact-match code-search behavior: the gram path finds chunks containing
all positive query terms, respects phrase/exclusion syntax used by the current
websearch parser, and feeds `HybridSearchService` as a repository lexical source.
It also documents the limitation that near-stem variants such as
`chunk-near-stem` do not match unless the normalized substring is present.

Split native FTS/search-index ownership is triggered only if product quality or
release profiling requires behavior the primary-store gram path does not
provide:

- BM25 ranking as a first-class quality signal;
- field weighting;
- Tantivy query syntax beyond the current websearch-compatible subset;
- tokenizer-specific behavior such as native token-boundary matching;
- engine-owned highlighting or snippets;
- stemming, fuzzy matching, or synonym expansion;
- unacceptable write amplification, storage growth, or foreground DB contention
  from primary-store gram sidecars.

If split native FTS is adopted, treat it as rebuildable derived state with an
explicit owner. It needs bootstrap checks, reset/backup/sync ownership,
rebuild/reconciliation rules, freshness diagnostics, and fail-closed behavior.
Do not attach or co-locate that store with the MVCC primary store unless current
Turso docs and a real-engine capability probe prove that journal-mode and custom
index ownership shape.
