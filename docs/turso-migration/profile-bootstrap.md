# Turso Profile Bootstrap

## Contract

`ProfileBootstrapReport` now always includes `search`.

- PGlite reports default to `primary-store-indexes`, because the current primary store owns pgvector, pg_trgm, and full-text indexes in one database.
- Turso reports must pass an explicit search ownership mode. Omitting it throws during report construction.
- Current Turso bootstrap uses `split-search-index-store`, because the primary Turso store must enable MVCC and Turso FTS custom indexes are not supported in MVCC mode.

## Desktop Runtime Switch

Set `BRAINSTRIKE_DB_RUNTIME=turso` in the desktop DB utility process environment to run the Turso profile bootstrap path.

Current behavior:

1. Resolve the desktop runtime selection.
2. Open `<profile>/turso-primary.db`.
3. Enable `PRAGMA journal_mode = 'mvcc'`.
4. Apply the Turso greenfield schema baseline through `brainstrike_turso_schema_ledger`.
5. Prove the required Turso search primitives:
   `search.grep-content-grams` and `search.vector32-functions`.
6. Return a ready bootstrap report with `search.ownershipMode = "split-search-index-store"`.
7. Open a long-lived Turso owner client for the same primary database.
8. Return `initialized: true` only after the Turso owner handle is live, with `capabilities.liveQuery = false`.

The host manager validates Turso reports against Turso-required checks
(`store.open`, `primary-store.mvcc`, `schema.baseline`,
`search.grep-content-grams`, `search.vector32-functions`,
`search.ownership`, `store.close`) and still rejects any ready report that
does not include an initialized owner client and an explicit capability
contract. This prevents silent fallback to PGlite while Turso-specific
repositories and search ownership are still being converted.

`initialized` means the current engine-specific execution surface is open. It does not mean every PGlite capability exists. Turso live queries are rejected locally by the remote DB client before any `live:start` request is sent to the host.

Release risks: the Turso runtime hard-requires MVCC and owner transactions use
`BEGIN CONCURRENT`. Treat this as requiring explicit team signoff, backup/reset
validation, real-engine tests, and the queue-topology profiling gate in the
migration ledger. Do not add a PGlite fallback for these risks.

## Owner Client

`@brainstrike/db/turso/owner-client` is the first production Turso execution surface.

- `query(sql, params?)` returns `{ rows }`.
- Bootstrap and the long-lived owner handle both open with Turso's `experimental: ["index_method"]` option.
- `exec(sql, params?)` uses Turso `exec` for unparameterized SQL and prepared `run` for bound statements. Parameterized `exec` is intentionally single-statement only.
- `transaction(callback)` serializes the full callback, manually issues `BEGIN` / `COMMIT` / `ROLLBACK`, and passes a Brainstrike-shaped transaction facade into the callback. The callback must use that facade; re-entering the outer owner client fails fast to avoid self-deadlock.
- `close()` closes the owner handle and later `query` / `exec` calls fail loudly.

The adapter does not claim PGlite live-query compatibility. `live:start` remains unsupported until a Turso-native live/reconciliation strategy is designed.

## Schema Baseline

`@brainstrike/db/turso/schema-baseline` owns the Turso-native schema baseline.
It creates `brainstrike_turso_schema_ledger`, rejects existing Postgres/PGlite
migration ledgers (`_migrations` and `__drizzle_migrations`), and applies the
greenfield Turso table shape directly instead of replaying numbered PGlite
migrations.

The baseline intentionally omits PGlite/Postgres-only physical features:

- pgvector HNSW/IVF and dimension maintenance indexes.
- `pg_trgm`, `tsvector`, and same-file MVCC FTS indexes.
- PGlite live-query compatibility.
- historical backfills for pre-Turso user data.

JSON-like values use validated JSON text and booleans use integer `0`/`1`.
Embedding columns are `BLOB` at the schema layer. Repository-authored
embeddings are stored with Turso `vector32(?)` payloads and the bootstrap
report proves the required vector functions before assistant semantic retrieval
can use them.

## Repository Coverage

Current desktop Turso provider/runtime coverage:

- `embedding_sets`
- `file_records`
- `file_chunks` when `tursoRepositories.fileChunkRepository` is available;
  otherwise it is explicitly reported unavailable.
- `view_filter_presets`
- `file_token_cache`
- managed-cache apply/invalidate
- atomic chunk insert plus embedding job enqueue
- Turso job queue claim/lease/heartbeat/completion/failure/retry/clear/read-model
  metrics
- vector-management owner-IPC queue actions
- hidden embedding-host worker storage through owner IPC
- assistant grep/vector/hybrid search gated by bootstrap checks

Turso file-record repository is exposed through the desktop Turso provider and
`file_chunks` is an explicit conditional repository capability, not an inferred
generic-DB compatibility layer.

Default imports now commit file records, chunks, and embedding jobs atomically
through Turso managed-cache and owner-client transaction paths. User-visible
Turso re-embed is composed as owner-IPC clear-embeddings followed by hidden-host
backfill; keep that split.

The visible renderer must not construct `TursoJobQueue` for Turso mutations.
Mutation paths requiring transactions or query-capable writes stay on explicit
desktop owner-client IPC/action surfaces. The provider still does not expose a
generic live-query-compatible `db` handle in Turso mode; that remains an
explicit unsupported capability, not a silent PGlite compatibility layer.
`file_chunks` remains explicit/conditional through
`tursoRepositories.fileChunkRepository`, not silent PGlite compatibility.

## Next Touchpoint

Desktop assistant `brainstrike.queryEmbeddingSpace` is enabled for Turso only
when the ready bootstrap report proves `search.vector32-functions`. Quick-open
filename lookup and grep already use primary-store gram candidate tables because
they only need bounded substring search. Hybrid retrieval now uses the Turso
repository lexical source plus vector search when bootstrap proves vector
support. Native Tantivy-style FTS snippets/ranking remain future work if the
primary-store gram indexes are not enough.
