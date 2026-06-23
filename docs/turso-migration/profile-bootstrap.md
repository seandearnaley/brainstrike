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
5. Return a ready bootstrap report with `search.ownershipMode = "split-search-index-store"`.
6. Open a long-lived Turso owner client for the same primary database.
7. Return `initialized: true` only after the Turso owner handle is live, with `capabilities.liveQuery = false`.

The host manager validates Turso reports against Turso-required checks (`store.open`, `primary-store.mvcc`, `schema.baseline`, `search.ownership`, `store.close`) and still rejects any ready report that does not include an initialized owner client and an explicit capability contract. This prevents silent fallback to PGlite while Turso-specific repositories and search ownership are still being converted.

`initialized` means the current engine-specific execution surface is open. It does not mean every PGlite capability exists. Turso live queries are rejected locally by the remote DB client before any `live:start` request is sent to the host.

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
Embedding columns are stored as Turso-compatible `BLOB` placeholders until the
repository/search slices bind them to Turso vector APIs.

## Repository Coverage

Current desktop Turso provider coverage:

- `embedding_sets`
- `view_filter_presets`
- `file_token_cache`

Turso file-record repository implementation is staged as repository-only
groundwork for CRUD, content import, managed-cache metadata, stat stamping, and
bulk import. The desktop provider intentionally does not expose it through
`useFileRecordRepository()` yet, because default imports require file-record and
chunk storage to become available together. Exposing file records first would
allow partial failed imports with no chunks or searchable content.

Turso file-chunk repository implementation is now staged as repository-only
groundwork for non-search persistence: ordered reads, single and batched upserts,
transaction-scoped batch inserts, content/position/embedding metadata updates,
delete/clear operations, coverage counts, stats, and explicit embedding-clearing
stats refresh. Search methods (`searchSimilar`, `fullTextSearch`, and
`findGrepCandidates`) fail loudly until the split search-index owner is wired;
they do not fall back to unindexed scans.

The provider still does not expose a generic `db` handle, `file_records`, or
`file_chunks` in Turso mode. Those remain explicit migration work rather than
silent PGlite compatibility.

## Next Touchpoint

The next low-vector-risk slice is coherent provider exposure for the generic
execution handle plus the staged `file_records` and non-search `file_chunks`
repositories. Search remains split-owned until
`docs/turso-migration/search-index-architecture.md` is implemented, and
quick-open name search must not be treated as complete until the Turso
search-index owner is designed.
