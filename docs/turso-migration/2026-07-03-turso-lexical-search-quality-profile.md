# Turso Lexical Search Quality Profile

Last updated: 2026-07-03 on `codex/turso-search-quality-profile`,
targeting `feature/turso-migration`.

## Scope

This profile characterizes Brainstrike's current Turso lexical search path for
the migration branch. It is not a native Tantivy FTS benchmark. The current
supported Turso path is primary-store gram search:

- generated gram rows in `file_chunk_content_grams`;
- normalized content rows in `file_chunk_content_index`;
- exact `instr(...)` checks over normalized content;
- deterministic relevance scoring and optional escaped `<mark>` snippets;
- explicit fail-closed errors for unsupported PostgreSQL-only language or
  rank-normalization options.

The test evidence lives in
`packages/db/__tests__/search-turso-lexical-quality-profile.test.ts`.

## Tiny Corpus Result

The real-engine profile seeds a small code-search corpus into a real Turso owner
client and queries `TursoFileChunkRepository.fullTextSearch()`.

Query: `authentication login`

Judged relevant chunks:

- `chunk-auth-focused`: `login authentication token validator`
- `chunk-auth-context`: longer session-policy text containing both
  `authentication` and `login`

Observed result order:

1. `chunk-auth-focused`
2. `chunk-auth-context`

Metrics:

- precision@5 = 1.000
- recall@5 = 1.000

Deliberate current limitations:

- `chunk-auth-only` is not returned because it lacks `login`.
- `chunk-login-only` is not returned because it lacks `authentication`.
- `chunk-near-stem` is not returned because the current path does exact
  normalized substring checks, not stemming or synonym expansion.

Phrase/exclusion query:

- `fullTextSearch('"rate limit" -test')` returns `chunk-rate-prod` and excludes
  the test helper row that contains the excluded term.

Hybrid check:

- `HybridSearchService` over the real `TursoFileChunkRepository` keeps the
  repository lexical source; with `minSourceCount: 2`, the top results are the
  two chunks that are present in both the lexical and vector source pools.

Query-plan check:

- The lexical SQL uses `file_chunk_content_grams` and
  `file_chunk_content_index`.
- It does not scan `file_chunks` as the primary lexical candidate source.

## Decision Boundary

Primary-store gram lexical search remains the Turso migration path for parity.
It covers Brainstrike's current exact code-search needs without adding a second
mutable store or routing native FTS custom indexes through the MVCC primary
database.

Native Tantivy FTS is a future search-index-owner decision, not a blocker for
the current migration. Split native FTS is justified only if product search
quality or release profiling requires behavior the gram path cannot honestly
provide:

- BM25 ranking as a first-class quality signal;
- field weights;
- Tantivy query syntax beyond the current websearch-compatible subset;
- tokenizer-specific behavior such as native token-boundary matching;
- engine-owned highlighting/snippet behavior;
- stemming, fuzzy matching, or synonym expansion;
- measured write amplification, storage growth, or foreground DB contention from
  primary-store gram sidecars.

If split native FTS is adopted, it must be explicitly owned as rebuildable
derived state: bootstrap checks, reset/backup/sync ownership, rebuild and
freshness diagnostics, and fail-closed behavior are required. It must not become
an implicit fallback scan or an assumed attachment to the MVCC primary store.

## Turso Docs Cross-Check

Current Turso docs describe native FTS as Tantivy-powered indexes created with
`CREATE INDEX ... USING fts`, queried through `fts_match`, ranked with
`fts_score`, and highlighted with `fts_highlight`.

The same docs list native FTS capabilities that Brainstrike's gram path does not
claim: BM25 scoring, field weights, tokenizers including `ngram`, phrase/prefix,
boolean, column, and boost query syntax. They also list limitations: no snippet
function, manual `OPTIMIZE INDEX`, no read-your-writes for FTS changes inside an
open transaction, and no SQLite `MATCH` syntax.

Sources:

- https://docs.turso.tech/sql-reference/functions/fts
- https://docs.turso.tech/sql-reference/statements/create-index
- https://docs.turso.tech/tursodb/concurrent-writes
