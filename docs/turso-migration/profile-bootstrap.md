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

Current desktop Turso provider coverage:

- `embedding_sets`
- `file_records`
- `view_filter_presets`
- `file_token_cache`

Turso file-record repository is exposed through the desktop Turso provider for
CRUD, content import, managed-cache metadata, stat stamping, and bulk import.
This is repository coverage, not full import parity: default imports still need
Turso chunk storage plus embedding-job enqueue support before file records,
chunks, and jobs are committed atomically in Turso mode.

Turso file-chunk repository implementation is now staged as repository-level
groundwork for persistence and native search: ordered reads, single and batched
upserts, transaction-scoped batch inserts, content/position/embedding metadata
updates, delete/clear operations, coverage counts, stats, explicit
embedding-clearing stats refresh, trigram-backed grep candidates, and native
`vector32(?)` similarity search. Repository-authored embeddings are stored as
Turso vector blobs and decoded from the raw BLOB on reads, so ordinary reads do
not depend on vector SQL functions. Legacy JSON embedding blobs from the
pre-vector Turso slice remain readable for cleanup or re-embedding, but new
writes use native Turso vector storage. `fullTextSearch` is backed by the
primary-store gram/content index for lexical hybrid retrieval, while a split
Tantivy/native FTS owner remains a future search-quality option.
Repository-authored chunks must also carry the non-null `FileChunk`
identity/type fields (`contentHash`, `chunkType`); if another raw Turso path
writes nullable baseline rows that violate that contract, repository reads fail
loudly instead of coalescing malformed data.

The first Turso-native chunk/job orchestration seam is also staged:
`insertTursoChunksAndEnqueueEmbeddingJobs()` inserts chunks through the Turso
chunk repository and queues `embed_chunk` jobs in the same owner-client
transaction. It uses SQLite-compatible statements and active-job dedupe instead
of the Postgres `JobQueue` batch SQL. This is only the import write-side
primitive; it does not port job claiming, heartbeats, completion, retries, or
search indexing.

Vector-management queue status and retry controls now resolve their durable
queue adapter through a runtime-keyed hook. PGlite profiles still construct the
existing `JobQueue`; ready Turso profiles construct `TursoJobQueue` for queue
stats, failed-job retry, unclaimable queued-job repair, and explicit queue
clear operations exposed by that hook. The embedding runtime provider does not
construct a Turso `VectorQueueService` in the visible renderer. It exposes Turso
queue snapshots through the storage-neutral snapshot reader, keeps queue actions
unavailable with `missing-turso-vector-queue-adapter`, and requires a future
desktop owner-client adapter before backfill, clear, wipe, or re-embed actions
can be enabled through the shared action service. Desktop embedding execution
still runs through the hidden embedding host.

Turso managed-cache apply/invalidation is now staged for the desktop DB host.
`applyTursoManagedCacheBatch()` writes imported file records, replaces stale
file chunks, cancels active embedding jobs for replaced chunks, calls the
Turso-native chunk/job write primitive, and refreshes collection indexing stats
inside one owner-client transaction. `invalidateTursoManagedCacheEntriesByIdentity()`
matches exact/prefix cache identities with SQLite-compatible statements, deletes
matched file records, cancels active embedding jobs for deleted chunks, and
returns the deleted ids. The DB host dispatches managed-cache apply,
managed-cache invalidation, and atomic chunk/job enqueue requests to Turso
implementations when the bootstrap report runtime engine is `turso`; unsupported
engines fail loudly before mutation.

The provider still does not expose a generic `db` handle or `file_chunks` in
Turso mode. Those remain explicit migration work rather than silent PGlite
compatibility.

## Next Touchpoint

Desktop assistant `brainstrike.queryEmbeddingSpace` is enabled for Turso only
when the ready bootstrap report proves `search.vector32-functions`. Quick-open
filename lookup and grep already use primary-store gram candidate tables because
they only need bounded substring search. FTS snippets and hybrid retrieval
remain split-owned until `docs/turso-migration/search-index-architecture.md` is
implemented.
