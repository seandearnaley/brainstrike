# PGlite to Turso Migration Exploration

Date: 2026-06-20

Status: exploration and conversion planning. This is not a go/no-go memo. It assumes the team wants to proceed into planning unless a proof gate shows Turso cannot satisfy a required Brainstrike contract.

Scope: Brainstrike local-first storage, desktop and web database runtime, vector search, FTS/grep, durable embedding queue, assistant memory, live UI invalidation, and migration sequencing.

## Executive Summary

Migrating Brainstrike from PGlite to Turso is credible, but it is not a driver swap. It is a storage architecture migration.

The main upside is real: Turso's new database packages are aimed directly at the pain that pushed Brainstrike into awkward PGlite patterns - local embedded operation, concurrent writes in the new engine, async I/O, browser WASM direction, local-first sync packages, built-in vector support, FTS, CDC, and multi-process ambitions. Those capabilities line up with the product much better than a single PGlite connection plus Postgres extensions in a browser-like runtime.

The hard part is that Brainstrike has already invested deeply in Postgres semantics:

- Drizzle schema is `pg-core`, not SQLite/Turso.
- Migrations create `vector`, `tsvector`, GIN, HNSW, pg_trgm, PL/pgSQL triggers, UUID defaults, JSONB, arrays, and Postgres timestamps.
- Queue correctness uses `FOR UPDATE SKIP LOCKED`, writable CTEs, `unnest`, `UPDATE ... FROM`, `RETURNING`, and lease-guarded vector writes.
- Search uses pgvector operators, dimension-specific halfvec HNSW indexes, `SET LOCAL hnsw.*`, Postgres FTS, and pg_trgm prefilters.
- UI live queries depend on the PGlite `live` extension.
- Assistant memory contains a separate PGlite/Postgres store and vector store.

The shortest path would be to replace the database client under the current repository interfaces and patch SQL as errors appear. That is not the right path. It would hide the hardest ownership and correctness changes until late. The better route is to introduce a stricter Brainstrike database contract, prove Turso runtime capability in the exact Electron and browser surfaces, then port the schema, queue, search, live invalidation, and assistant memory as explicit workstreams.

Because Brainstrike is greenfield, the migration does not need a user data migration promise. That changes the cost profile substantially. We can reset local profiles and preserve investment in domain contracts, repository APIs, tests, indexing logic, assistant workflows, and UI behavior instead of preserving every historical migration.

## Source-backed Turso Position

Primary docs checked during this exploration:

- [Turso GitHub README](https://github.com/tursodatabase/turso) for the new Turso Database engine status and feature roadmap.
- [Turso TypeScript SDK reference](https://docs.turso.tech/sdk/ts/reference) for package choices, Drizzle support, concurrency claims, transaction behavior, and sync APIs.
- [Turso introduction](https://docs.turso.tech/introduction) for package positioning.
- [Turso SQLite compatibility](https://docs.turso.tech/features/sqlite-compatibility) for extended SQL features.
- [Turso full-text search](https://docs.turso.tech/features/full-text-search) for Tantivy-backed FTS behavior.
- [Turso AI and embeddings](https://docs.turso.tech/features/ai-and-embeddings) for vector functions and vector indexes.
- [Turso sync](https://docs.turso.tech/features/sync) for local writes, explicit push/pull, and conflict behavior.
- [SQLite isolation](https://sqlite.org/isolation.html) for SQLite's one-writer-at-a-time baseline.
- [SQLite FTS5](https://sqlite.org/fts5.html) for trigram tokenizer behavior and LIKE/GLOB caveats.

Related follow-up:

- `docs/turso-migration/2026-06-21-mastra-code-ui-libsql-reverse-engineering.md` reverse-engineers [mastra-ai/mastra-code-ui](https://github.com/mastra-ai/mastra-code-ui) at commit [`c254853f6c6e52f78b22ca056e733a07e113ebf8`](https://github.com/mastra-ai/mastra-code-ui/commit/c254853f6c6e52f78b22ca056e733a07e113ebf8) to understand how a real Mastra coding agent wires LibSQL/Turso-style storage into Harness and Memory.
- `docs/turso-migration/2026-06-21-bootstrap-research-orchestration.md` consolidates ten specialist bootstrap research tracks into a profile bootstrap contract, capability probe, diagnostics, seed, reset, and test strategy.

Important facts:

- The Turso repository describes Turso Database as an in-process SQL database compatible with SQLite, written in Rust. It also explicitly warns that Turso Database is beta, while libSQL is production ready.
- Turso's TypeScript package matrix currently splits options:
  - `@tursodatabase/database`: local embedded Turso Database engine, concurrent writes, async I/O, Drizzle support marked beta.
  - `@tursodatabase/sync`: local-first sync path with local reads/writes and explicit push/pull.
  - `@tursodatabase/serverless`: HTTP/cloud serverless path.
  - `@libsql/client`: production-ready and broadly supported by ORMs, but not the same new local concurrent engine target.
- Turso docs state `@libsql/client` has a default max concurrency of 20 requests, but interactive write transactions hold the write lock until commit/rollback and default to a 5 second timeout. That matters if we pick libSQL client for stability instead of the new Turso engine packages.
- Turso's compatibility docs list `BEGIN CONCURRENT`, vector functions, materialized views, custom index methods, CDC, encryption, and Tantivy FTS as Turso extensions beyond plain SQLite.
- Turso's FTS is Tantivy-backed and not a drop-in PostgreSQL `tsvector` replacement.
- Turso/libSQL vector examples store vectors as SQLite BLOB values, use functions such as `vector32(...)`, and expose ANN search through `vector_top_k(...)`/vector indexes. That is not isomorphic with Brainstrike's dimensionless pgvector column plus per-dimension partial HNSW strategy.
- SQLite's baseline transaction model serializes writes: multiple connections can exist, but writers take turns. If Brainstrike chooses the mature libSQL path instead of the new Turso Database engine path, the concurrency story must be measured rather than assumed.

## Mastra Code UI Addendum

A second pass inspected `mastra-ai/mastra-code-ui` because it is a Mastra coding-agent application that implements LibSQL/Turso-style persistence. The important correction is that the inspected implementation does not use the new `@tursodatabase/database` package. It uses `@mastra/libsql@1.6.3` over `@libsql/client@0.15.15`, with local file-backed LibSQL by default and remote Turso-like behavior represented as a LibSQL URL plus auth token.

What it proves:

- a Mastra coding agent can keep the Electron shell thin and delegate persistence to a `createMastraCode()` runtime;
- one `LibSQLStore` can be injected into both Mastra `Memory` and `Harness`;
- `resourceId` is the durable partition key for thread/resource scoping;
- Harness streams turns with memory scope `{ thread, resource }` rather than putting the store into tool request context;
- Mastra's LibSQL adapter creates real memory, workflow, observability, agent, and vector tables and can run a local vector insert/query probe.

What it does not prove:

- the new Turso Database engine solves Brainstrike's local concurrent-write problem;
- file-backed LibSQL is a browser-local replacement for PGlite;
- Mastra's imperative `CREATE TABLE IF NOT EXISTS`/`ALTER TABLE` storage init is a substitute for Brainstrike's migration ledger;
- `libsql_vector_idx` accelerates Brainstrike-scale chunk retrieval;
- Mastra's memory store is acceptable under Brainstrike's no-silent-degradation rule without wrappers.

The inspected code also contains patterns Brainstrike should explicitly reject: backend fallback from failed PostgreSQL to local LibSQL, malformed config paths that can return `null`, memory list operations that can return empty results after storage failures, and PID-file thread locks that are not equivalent to DB leases. The Mastra Code UI pass is therefore best used as a Harness/Memory integration reference, not as a storage-engine acceptance proof.

## Current Brainstrike Storage Shape

### State Ownership

Desktop centralizes database ownership. Visible UI, hidden embedding host, chunking host, and local LLM host do not directly own separate desktop PGlite databases. They route through the desktop DB main process and utility-process facade.

Key touchpoints:

- `packages/db/src/db-provider.tsx`
- `apps/desktop/src/db-main.ts`
- `apps/desktop/src/db-host-manager.ts`
- `apps/desktop/src/db-host-entry.ts`
- `apps/desktop/src/ipc-domains/db-ipc.ts`
- `packages/db/src/database-work-scheduler.ts`

This centralized owner is not just a workaround. It also controls profile paths, initialization locks, corruption/reset behavior, scheduler priority, hidden-host background priority, live subscriptions, and utility-process isolation.

Web owns a PGlite database through IndexedDB/worker-backed storage. The direct browser path loads PGlite extensions through `packages/db/src/wasm-loader.ts` and `packages/db/src/pglite-worker-entry.ts`.

### Schema And Migrations

The canonical schema lives in `packages/db/src/schema/index.ts` and imports from `drizzle-orm/pg-core`. It declares:

- UUID/text IDs and app-generated UUIDv7 defaults.
- `jsonb`.
- `timestamp`/`timestamptz`.
- text arrays.
- `vector` columns through a custom pgvector type.
- `tsvector` through a custom type.
- generated identity integers.
- generated FTS columns.

Migrations are split across:

- `packages/db/src/migrations/index.ts`
- `packages/db/src/drizzle/migrate.ts`
- `packages/db/src/migrations/migration-runner.ts`

The current migration ledger is Postgres-specific. Examples include:

- `004-add-chunks-table.ts`: creates `VECTOR(768)` and HNSW index.
- `010-flexible-embedding-dimensions.ts`: converts to dimensionless vector.
- `019-fts-tsvector-column.ts`: adds `tsvector`, GIN index, trigger.
- `034-tsvector-generated-column.ts`: generated `content_tsvector`.
- `038-pg-trgm-grep-index.ts`: installs pg_trgm and a trigram GIN index.
- `dimension-index-helpers.ts`: creates halfvec HNSW partial indexes per dimension.

Because the product is greenfield, the team should strongly consider replacing historical Postgres migrations with a new Turso baseline migration set instead of porting every historical migration one by one.

### Query Surface

The raw SQL surface is heavily Postgres-shaped:

- `$1::jsonb`, `$1::text[]`, `$1::vector`.
- `ANY(...)`.
- `unnest(...)`.
- `FOR UPDATE SKIP LOCKED`.
- `UPDATE ... FROM`.
- writable CTEs with `RETURNING`.
- `DISTINCT ON`.
- `ILIKE`.
- `SET LOCAL`.
- `pg_catalog`, `information_schema`, `pg_extension`, `pg_indexes`.

Files with high migration density:

- `packages/db/src/queue/job-queue.ts`
- `packages/db/src/repositories/file-chunk-repository.ts`
- `packages/db/src/repositories/electron-file-chunk-repository.ts`
- `packages/db/src/services/collection-indexing-stats.ts`
- `packages/app-shell/src/assistant-memory-repository.ts`
- `packages/agent/src/pglite-mastra-memory/*`

### Search And Retrieval

Current search has three distinct surfaces:

1. Exact/code search through `brainstrike.grepSearch`.
   - SQL prefilter uses pg_trgm-backed `ILIKE`/`LIKE`.
   - JavaScript performs authoritative line matching.
   - Bounded scan is explicit when the regex has no extractable 3-character literal.

2. Semantic/vector search.
   - pgvector operators: `<=>`, `<->`, `<#>`.
   - dimension filtering through `vector_dims`.
   - HNSW partial indexes per dimension using `halfvec(N)`.
   - transaction-scoped `SET LOCAL hnsw.ef_search` and `hnsw.iterative_scan`.
   - thresholding and overfetch logic in repository code.

3. Hybrid search.
   - Runs vector search and Postgres FTS, then fuses with RRF in `packages/db/src/search/hybrid-search-service.ts`.

This is one of the biggest migration workstreams. Turso has vector and FTS capabilities, but both search lanes need new data layout, new query syntax, new ranking expectations, and parity tests.

### Queue And Embedding Pipeline

The durable embedding queue lives in `packages/db/src/queue/job-queue.ts`.

Important invariants:

- Jobs are lease-based.
- Claims must not double-claim across workers.
- Heartbeats keep leases fresh.
- Expired leases must return work safely.
- Embedding chunk completion must atomically update chunk embedding data and mark jobs complete only if the worker still owns the lease.
- Background indexing and assistant foreground query coordination depend on accurate queue state.

The current implementation relies on Postgres row-level locking and writable CTEs. Turso requires a redesigned queue claim/complete protocol, not a syntax-only port.

### Live Query And UI Reactivity

`packages/db/src/use-live-query.ts` depends on PGlite `live.query` / `live.incrementalQuery`, with Electron IPC subscription forwarding. This is a product contract: UI state updates after local database mutation without blind polling.

Turso has CDC and sync concepts, but there is no drop-in equivalent to the current PGlite `live` hook in this code. The migration must introduce an explicit invalidation model:

- repository-driven table invalidation events,
- DB-host mutation notifications,
- CDC-backed subscriptions if proven in the target runtime,
- or query-key invalidation in a React data layer.

Silent polling would be a behavioral downgrade.

### Assistant Memory

Assistant persistence is split across:

- `packages/app-shell/src/assistant-memory-repository.ts`
- `packages/agent/src/pglite-mastra-memory/memory-store.ts`
- `packages/agent/src/pglite-mastra-memory/vector-store.ts`
- `packages/agent/src/pglite-mastra-memory/workflows-store.ts`
- `packages/assistant-contract/src/mastra-memory-schema.ts`

This is not incidental storage. Hosted-provider turns persist through Mastra, local desktop provider turns also persist through the Mastra loop, run events are interleaved into hydration, and vector memory participates in semantic recall. Porting main app data without porting assistant memory would leave a split storage architecture.

## What We Can Leverage

The investment that should carry forward:

- Domain model: roots, file records, chunks, embedding sets, job queue, model catalog, assistant threads/runs/events, memory tables.
- Repository interfaces and service boundaries.
- Embedding worker lifecycle and foreground query gate.
- Hidden-host renderer architecture for local embeddings and LLM execution.
- Existing assistant tool contracts (`grepSearch`, `queryEmbeddingSpace`, hybrid retrieval behavior).
- Test intent around migrations, job queue leases, search, assistant memory persistence, desktop DB lifecycle, and live queries.
- Tool output budget and progressive disclosure contracts.
- Background indexing QoS concepts and DB scheduler pressure signals.

The parts that should not be preserved as-is:

- Postgres dialect SQL.
- PGlite construction sites and extension cache logic.
- pgvector HNSW/halfvec tuning knobs as product assumptions.
- PGlite `live` as the UI invalidation abstraction.
- Legacy migration history if the team accepts a greenfield reset.
- Any best-effort fallback language around vector indexes, FTS, or queue degradation. The migration should make unsupported paths loud.

## Target Architecture Direction

### 1. Use A Brainstrike DB Contract, Not A PGlite-shaped Contract

Create an explicit DB runtime contract before porting SQL:

- `query(sql, params)` with defined row/value result shape.
- `execute(sql, params)` with defined mutation metadata.
- `transaction(mode, fn)` with explicit transaction modes and conflict semantics.
- `batch` or temp-table input support for bulk operations.
- `subscribe/invalidate` for UI reactivity.
- `maintenance` channel for long-running index or vacuum work.
- `diagnostics` channel for runtime stats, engine version, feature flags, and integrity checks.

The contract must be tested against the actual Turso runtime selected for desktop and web. Mocks are insufficient for transaction and vector semantics.

### 2. Keep Desktop DB Ownership Centralized At First

Even if Turso eventually enables safe multi-process or multi-connection operation, Brainstrike should keep a single desktop DB owner boundary during the migration. That boundary already handles:

- profile path control,
- utility-process isolation,
- startup locks,
- reset/corruption recovery,
- hidden-host priority,
- lifecycle cleanup,
- security surface reduction,
- diagnostics.

After the Turso migration is stable, direct multi-handle access can be a separate optimization. Combining engine migration and ownership decentralization would expand the blast radius.

### 3. Pick The Runtime With A Proof Matrix

The important choice is not "Turso or not". It is which Turso/libSQL package owns each runtime:

- `@tursodatabase/database` if the new embedded engine works in Brainstrike's Electron main/utility process and browser bundle, and Drizzle beta support is adequate.
- `@tursodatabase/sync` if local-first sync is part of the near-term architecture. Its explicit push/pull and conflict behavior need product decisions.
- `@libsql/client` if production maturity and ORM support matter more than the new local concurrent engine. This likely preserves more SQLite write serialization constraints and must not be sold internally as solving concurrency until measured.

Recommendation: spike `@tursodatabase/database` and `@tursodatabase/sync` first because the user's core reason for reconsidering PGlite is concurrency and local-first performance, not cloud access.

### 4. Split Search Storage By Function

Do not assume one `file_chunks` row with a dimensionless vector column is still the right layout.

Likely Turso shape:

- relational chunk metadata in ordinary tables,
- fixed-dimension vector tables or per-embedding-set vector indexes,
- FTS virtual/index tables for lexical ranking,
- trigram/substring prefilter index for grep,
- RRF fusion in application code.

The vector store should preserve Brainstrike's semantic contracts:

- embedding set ID filtering,
- model/dimension validation,
- distance metric semantics,
- result source ranges,
- token budget packing,
- explicit truncation/partial flags.

### 5. Replace Live Queries With Explicit Invalidation

PGlite `live` currently hides a lot of useful behavior. Turso migration should make it explicit:

- mutation paths declare affected tables/entities,
- DB host emits invalidation events after successful commits,
- renderer data hooks subscribe by query key or table/entity key,
- hidden hosts use the same invalidation channel where needed,
- CDC can be adopted only after proving it works in the chosen runtime and does not obscure local write visibility.

### 6. No Remote Round Trips In Latency-critical Paths

Brainstrike's architecture is local-first. Workspace indexing, query embedding coordination, retrieval, assistant memory hydration, and model catalog reads should not require network round trips. Turso sync/cloud can be a replication layer, not the hot path.

## Downsides And Open Risks

### Turso Database Maturity

Turso Database is beta according to its own repository. Brainstrike is greenfield, which makes this acceptable for exploration, but beta status still affects release risk, packaging risk, debugging risk, and API churn.

Mitigation: isolate Turso behind a Brainstrike DB contract and maintain a runtime capability report in tests. Do not let Turso-specific types leak through the app.

### Drizzle Support

Drizzle has mature libSQL/Turso support through `@libsql/client`, while `@tursodatabase/database` support is documented as beta. Brainstrike's current schema is `pg-core`. A port to `sqlite-core`/Turso schema is mandatory either way.

Mitigation: prove the exact Drizzle adapter on a small schema including JSON, timestamps, vector raw SQL, FTS/index DDL, transactions, and migrations before porting the full schema.

### Vector Parity

Current pgvector search relies on dimensionless storage, `vector_dims`, per-dimension halfvec HNSW partial indexes, and query-time HNSW tuning. Turso vector support is promising, but its ANN and exact search behavior must be benchmarked against Brainstrike queries.

Mitigation: create a retrieval parity harness with fixed corpora, expected neighbors, filtered top-k cases, mixed dimensions, and threshold behavior. Treat accuracy loss as a product decision, not an implementation detail.

### FTS And Grep Parity

Postgres FTS and pg_trgm are not portable. Turso's Tantivy FTS and SQLite FTS5/trigram options have different query syntax, ranking, highlighting, and index behavior.

Mitigation: split grep and FTS acceptance tests:

- exact identifier search,
- case-sensitive and case-insensitive literals,
- JS regex semantics,
- path filters,
- overlapping chunk dedupe,
- snippet/highlight behavior,
- ranked FTS queries used by hybrid search.

### Queue Correctness

There is no acceptable "best effort" queue migration. Losing a lease, double-completing an embedding, or marking a chunk embedded after stale ownership would corrupt indexing state.

Mitigation: prove queue semantics with concurrent workers against the real Turso runtime. The likely shape is a transaction-based atomic update claim using an indexed candidate subquery plus lease token, with conflict retries that are visible and bounded.

### Live Query Replacement

Replacing `live` with silent polling would regress UX and hide timing bugs.

Mitigation: build explicit invalidation as a first-class DB contract, then migrate UI hooks to it.

### Sync Conflict Semantics

Turso sync docs describe explicit push/pull and last-push-wins conflict behavior. That may be acceptable for some profile metadata, but not necessarily for workspace indexing state or assistant memory.

Mitigation: keep local DB authoritative for the hot path. Introduce sync later by table class, with conflict policy per table.

### Browser Packaging And Persistence

The web PGlite path currently has a known IndexedDB/worker storage model. Turso browser WASM/local persistence must be proved in Brainstrike's bundler/runtime, including web workers and package size.

Mitigation: require a web runtime spike before committing to a single cross-runtime schema implementation.

## Conversion Strategy

The conversion should run in staged PRs. Each stage should leave the repo green and should make hidden assumptions explicit.

### Phase 0: Capability Spike

Goal: prove the selected Turso runtime can satisfy Brainstrike contracts before porting code.

Must prove:

- Electron main or utility-process open/close lifecycle.
- Browser bundle and local persistence path.
- Drizzle beta adapter if using `@tursodatabase/database`.
- Migration execution and idempotency.
- JSON, timestamps, generated IDs, and foreign keys.
- transaction modes and concurrent write behavior.
- local vector insert/search/index behavior at Brainstrike dimensions.
- FTS and substring search candidates.
- queue claim/complete race behavior.
- invalidation or CDC path for live UI updates.
- packaging and native/WASM artifact behavior.

Exit criterion: a checked-in capability report with runnable scripts/tests. Unknowns are blockers, not assumptions.

### Phase 1: DB Contract And Adapter Boundary

Goal: make the application depend on a Brainstrike DB contract rather than PGlite types.

Work:

- introduce engine-neutral result and transaction types,
- remove `PgliteDatabase` type leakage from repositories,
- define explicit transaction modes,
- define invalidation event shape,
- define maintenance/diagnostics channels,
- add adapter contract tests.

### Phase 2: Turso Baseline Schema And Migrations

Goal: create a new Turso-native baseline schema.

Work:

- port `pg-core` schema to SQLite/Turso schema,
- replace JSONB with JSON text/BLOB policy,
- replace UUID defaults with app-generated IDs,
- replace arrays with JSON or join tables,
- replace Postgres timestamps with ISO text or integer epoch policy,
- replace FTS/vector/index DDL with Turso-native DDL,
- create a new migration ledger,
- remove historical PGlite migrations from the runtime path after reset policy is accepted.

### Phase 3: Durable Queue Rewrite

Goal: preserve job queue invariants against the real Turso runtime.

Work:

- implement atomic claim without `FOR UPDATE SKIP LOCKED`,
- replace `unnest` batch inputs with temp tables, JSON expansion, or batched statements,
- preserve lease token checks on heartbeat, completion, failure, and cancellation,
- preserve atomic chunk vector update plus job completion,
- add multi-worker race tests.

### Phase 4: Search And Retrieval Rewrite

Goal: preserve assistant and UI search behavior with Turso-native indexes.

Work:

- design vector table/index layout,
- port similarity search,
- port FTS ranking and snippets,
- port grep prefilter,
- preserve JS authoritative regex matching,
- preserve hybrid RRF fusion,
- benchmark retrieval parity and latency.

### Phase 5: Runtime Wiring And Live Invalidation

Goal: move desktop/web runtime ownership to Turso while keeping UI behavior explicit.

Work:

- replace PGlite construction sites,
- keep desktop DB owner boundary,
- replace IPC transaction/query/exec handlers,
- replace PGlite live subscriptions with invalidation events,
- implement diagnostics and reset for Turso storage,
- prove hidden hosts and background indexing still operate through the same DB owner.

### Phase 6: Assistant Memory And Mastra Stores

Goal: move assistant persistence and vector memory onto the same storage architecture.

Work:

- port `assistant-memory-repository`,
- port or replace `pglite-mastra-memory`,
- preserve Mastra v2 persisted dialect,
- preserve run event hydration and tool invocation result merging,
- port vector memory search,
- run live-loop Mastra persistence tests against the real store.

### Phase 7: Remove PGlite

Goal: delete obsolete dependencies and invariants only after all runtime paths are Turso-backed.

Work:

- remove `@electric-sql/pglite` and extension packages,
- delete PGlite construction and extension cache code,
- update AGENTS/PGlite extension invariant docs,
- update package names and tests,
- remove dead migrations or archive them as historical notes,
- run full repo gates.

## Verification Gates

Minimum gates before claiming the migration works:

- static, lint, type, build, and unit tests green in one run,
- DB migration tests against the real Turso runtime,
- job queue race tests with multiple concurrent claimers,
- vector retrieval parity tests,
- FTS/grep parity tests,
- assistant memory live-loop persistence tests,
- desktop DB lifecycle tests,
- web local persistence tests,
- Electron app smoke with workspace indexing and assistant retrieval,
- no hidden fallback to remote DB or weaker search mode,
- no silent polling replacing live invalidation,
- no swallowed Turso/transaction/vector capability errors.

## Recommended Next Decision

Start with Phase 0 as a focused spike, not a broad refactor. The highest-value first branch should answer:

1. Which Turso package is the right hot-path local engine for Brainstrike: `@tursodatabase/database`, `@tursodatabase/sync`, or `@libsql/client`?
2. Can it run in Electron utility/main and browser worker surfaces with durable local storage?
3. Can it satisfy vector, FTS, queue, and invalidation contracts without hidden degradations?

If Phase 0 passes, the migration should proceed as a planned storage architecture conversion. If Phase 0 fails one contract, keep the failure specific: vector indexing, live invalidation, queue transaction semantics, browser persistence, or package maturity. Do not collapse that into a generic "Turso failed" conclusion.
