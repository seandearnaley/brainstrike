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
4. Return a ready bootstrap report with `search.ownershipMode = "split-search-index-store"`.
5. Open a long-lived Turso owner client for the same primary database.
6. Return `initialized: true` only after the Turso owner handle is live, with `capabilities.liveQuery = false`.

The host manager validates Turso reports against Turso-required checks (`store.open`, `primary-store.mvcc`, `search.ownership`, `store.close`) and still rejects any ready report that does not include an initialized owner client and an explicit capability contract. This prevents silent fallback to PGlite while Turso-specific repositories and search ownership are still being converted.

`initialized` means the current engine-specific execution surface is open. It does not mean every PGlite capability exists. Turso live queries are rejected locally by the remote DB client before any `live:start` request is sent to the host.

## Owner Client

`@brainstrike/db/turso/owner-client` is the first production Turso execution surface.

- `query(sql, params?)` returns `{ rows }`.
- Bootstrap and the long-lived owner handle both open with Turso's `experimental: ["index_method"]` option.
- `exec(sql, params?)` uses Turso `exec` for unparameterized SQL and prepared `run` for bound statements. Parameterized `exec` is intentionally single-statement only.
- `transaction(callback)` serializes the full callback, manually issues `BEGIN` / `COMMIT` / `ROLLBACK`, and passes a Brainstrike-shaped transaction facade into the callback. The callback must use that facade; re-entering the outer owner client fails fast to avoid self-deadlock.
- `close()` closes the owner handle and later `query` / `exec` calls fail loudly.

The adapter does not claim PGlite live-query compatibility. `live:start` remains unsupported until a Turso-native live/reconciliation strategy is designed.

## Next Touchpoint

The next slice should move one real repository or schema lane onto Turso SQL behind this owner client, starting with a narrow table/query group that does not require pgvector or `pg_trgm` compatibility. Search remains split-owned until `docs/turso-migration/search-index-architecture.md` is implemented.
