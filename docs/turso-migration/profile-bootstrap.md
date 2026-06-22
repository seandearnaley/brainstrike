# Turso Profile Bootstrap

## Contract

`ProfileBootstrapReport` now always includes `search`.

- PGlite reports default to `primary-store-indexes`, because the current primary store owns pgvector, pg_trgm, and full-text indexes in one database.
- Turso reports must pass an explicit search ownership mode. Omitting it throws during report construction.
- Current Turso bootstrap uses `split-search-index-store`, because the primary Turso store must enable MVCC and Turso FTS custom indexes are not supported in MVCC mode.

## Desktop Runtime Switch

Set `BRAINSTRIKE_DB_RUNTIME=turso` in the desktop DB utility process environment to run the Turso profile bootstrap path.

Current behavior is intentionally fail-closed:

1. Resolve the desktop runtime selection.
2. Open `<profile>/turso-primary.db`.
3. Enable `PRAGMA journal_mode = 'mvcc'`.
4. Return a ready bootstrap report with `search.ownershipMode = "split-search-index-store"`.
5. Do not open the long-lived PGlite owner handle.
6. Do not return a Turso DB client yet.

The host manager validates Turso reports against Turso-required checks (`store.open`, `primary-store.mvcc`, `search.ownership`, `store.close`) and then rejects client use because `initialized` is false. This prevents silent fallback to PGlite while the production Turso repositories and host client are still unwired.

## Next Touchpoint

The next slice should introduce the Turso owner client/adapter behind the desktop DB host, then replace the `initialized: false` stop with a real Turso-backed execution surface.
