# Turso Migration Touchpoint Primer

Date: 2026-06-20

Purpose: give engineers a practical map of the Brainstrike files and contracts that must change when migrating from PGlite/Postgres semantics to Turso/libSQL/SQLite semantics.

Use this with:

- `docs/turso-migration/2026-06-20-pglite-to-turso-exploration.md`
- `docs/turso-migration/2026-06-21-mastra-code-ui-libsql-reverse-engineering.md`
- `docs/turso-migration/2026-06-21-bootstrap-research-orchestration.md`
- `docs/superpowers/plans/2026-06-20-pglite-to-turso-migration.md`
- `docs/superpowers/plans/2026-06-21-turso-bootstrap-contract.md`

## Ground Rule

Do not treat this as an adapter replacement. Each touchpoint below has an ownership or correctness contract. If a Turso implementation cannot satisfy a contract, it must fail loudly or block the migration phase. No fallback behavior should make search, queue, sync, or live invalidation appear better than it is.

## 1. Dependencies And Runtime Packages

Current files:

- `packages/db/package.json`
- `apps/desktop/package.json`
- root lockfile
- `packages/db/src/drizzle/database.ts`
- `packages/db/drizzle.config.ts`

Current state:

- `@brainstrike/db` depends on `@electric-sql/pglite` and `@electric-sql/pglite-pgvector`.
- Desktop also depends on PGlite and PGlite pgvector.
- Drizzle adapter is `drizzle-orm/pglite`.
- Drizzle config uses `dialect: 'postgresql'` and `driver: 'pglite'`.

Turso work:

- Select exact package path: `@tursodatabase/database`, `@tursodatabase/sync`, or `@libsql/client`.
- Prove Drizzle adapter support before schema work.
- Replace Drizzle config with Turso/SQLite dialect.
- Add package-level runtime probes for Electron and browser.

Verification:

- Package install is deterministic.
- TypeScript sees the selected adapter without shims.
- A minimal migration and query runs in Node/Electron and browser target, not only in Vitest mocks.

## 2. PGlite Construction And Extension Loading

Current files:

- `packages/db/src/wasm-loader.ts`
- `packages/db/src/pglite-worker-entry.ts`
- `apps/desktop/src/db-main.ts`
- `packages/db/src/db-provider.tsx`

Current state:

- Every PGlite construction site must load `vector`, `pg_trgm`, and `live` consistently.
- Desktop dynamically imports PGlite extension modules.
- Browser worker/direct construction is PGlite-specific.
- The `vectorEnabled` runtime check is based on `pg_extension`.

Turso work:

- Replace PGlite construction with Turso runtime construction.
- Remove extension cache/reset logic.
- Replace `pg_extension` checks with runtime capability probes.
- Define a typed capability report: vectors, FTS, sync, CDC/invalidation, transaction mode, engine version.

Verification:

- Capability checks are strict and fail startup when a required feature is missing.
- Electron and browser startup paths run the same required capability contract.
- No code path can continue with vector/search disabled while reporting normal indexing.

## 3. Schema

Current files:

- `packages/db/src/schema/index.ts`
- `packages/assistant-contract/src/mastra-memory-schema.ts`

Current state:

- Schema uses `drizzle-orm/pg-core`.
- Uses `jsonb`, `uuid`, `timestamp`, `timestamptz`, arrays, `tsvector`, custom pgvector type, generated identity, and Postgres expressions.

Turso work:

- Port to SQLite/Turso schema primitives.
- Decide storage policy for:
  - IDs: app-generated text IDs.
  - timestamps: ISO text or integer epoch.
  - JSON: text JSON with `json_extract`/generated columns where needed.
  - arrays: normalized tables or JSON arrays.
  - vectors: BLOB columns with fixed dimension policy or per-embedding-set tables.
  - FTS: Turso/Tantivy or SQLite FTS tables/indexes.
- Keep schema comments that describe ownership and non-portable choices.

Verification:

- Schema generation produces Turso-compatible SQL.
- Generated SQL does not contain Postgres casts/types/functions.
- Inserts/selects for every table class pass against real Turso runtime.

## 4. Migration Ledger

Current files:

- `packages/db/src/migrations/index.ts`
- `packages/db/src/drizzle/migrate.ts`
- `packages/db/src/migrations/migration-runner.ts`
- `packages/db/src/migrations/*`

Current state:

- Numbered migration runner is typed around PGlite.
- Runtime custom migration ledger mirrors numbered migrations.
- Existing migrations are Postgres-specific.

Turso work:

- Prefer a new Turso baseline migration ledger if greenfield reset is accepted.
- Replace `__drizzle_migrations` DDL with SQLite/Turso-compatible metadata.
- If historical PGlite migrations are kept for reference, remove them from the runtime migration path.
- Preserve the rule that tests and app runtime use the same migration set.

Verification:

- Fresh DB migrates to the full schema.
- Re-running migrations is idempotent.
- Migration lane registry remains updated if new tests are added.

## 5. Repository And DB Handle Contract

Current files:

- `packages/db/src/db-provider.tsx`
- `packages/db/src/repositories/interfaces.ts`
- `packages/db/src/atomic-transaction.ts`
- `packages/db/src/repositories/drizzle/*`
- `packages/db/src/repositories/electron-*`

Current state:

- `DbHandle` hides direct PGlite vs Electron IPC but still exposes PGlite-shaped assumptions.
- Some repositories require transaction primitives to keep PGlite single-connection `SET LOCAL` behavior safe.
- Electron repositories use raw SQL through IPC.

Turso work:

- Define engine-neutral query result shapes.
- Define transaction modes and conflict behavior explicitly.
- Add batch input primitives to avoid ad hoc JSON/`unnest` rewrites everywhere.
- Separate "query", "mutation", "maintenance", and "diagnostics" channels.
- Define invalidation metadata for mutations.

Verification:

- Contract tests run against real Turso.
- Repositories no longer import PGlite types.
- Transaction failures surface typed errors and do not retry silently.

## 6. Desktop DB Owner And IPC

Current files:

- `apps/desktop/src/db-main.ts`
- `apps/desktop/src/db-host-manager.ts`
- `apps/desktop/src/db-host-entry.ts`
- `apps/desktop/src/ipc-domains/db-ipc.ts`
- `packages/db/src/database-work-scheduler.ts`

Current state:

- Desktop owns DB centrally and serializes work through the DB host.
- DB scheduler prioritizes foreground, normal, and background work.
- Hidden hosts use DB priority hints.

Turso work:

- Keep this owner boundary for the first migration.
- Replace PGlite host internals with Turso runtime.
- Revisit serialization after correctness is proven, not before.
- Preserve scheduler priority and foreground/background pressure reporting.
- Add Turso diagnostics to the existing desktop debug surface.

Verification:

- Utility-process lifecycle tests pass.
- DB startup/reset/corruption paths are explicit.
- Hidden embedding host can index through the Turso-backed desktop owner.
- No renderer opens an uncoordinated desktop write handle during the first migration.

## 7. Browser Storage

Current files:

- `packages/db/src/wasm-loader.ts`
- `packages/db/src/pglite-worker-entry.ts`
- `packages/db/src/browser-pglite-storage.ts`
- `packages/db/src/db-provider.tsx`

Current state:

- Browser storage is PGlite/IndexedDB/worker shaped.
- PGlite engine storage versioning appears in browser storage naming.

Turso work:

- Prove browser local durable storage with the selected package.
- Decide whether browser uses the same Turso engine package as desktop.
- Replace worker initialization and persistence naming.
- Add explicit local reset behavior.

Verification:

- Browser reload preserves data.
- Browser worker path can run migrations.
- Bundle size and WASM/native artifacts are understood.

## 8. Live Queries And Invalidation

Current files:

- `packages/db/src/use-live-query.ts`
- `packages/db/src/pglite-live-query-format.ts`
- `apps/desktop/src/ipc-domains/db-ipc.ts`

Current state:

- UI reactivity depends on PGlite `live.query` and `live.incrementalQuery`.
- Electron forwards live subscriptions over IPC.

Turso work:

- Replace PGlite live with explicit invalidation.
- Mutation paths must declare affected tables/entities after commit.
- Hooks should resubscribe/refetch by stable query keys.
- CDC can be used only after proving local timing and packaging.

Verification:

- UI updates after insert/update/delete without polling-only behavior.
- Invalidation is commit-bound: failed transactions do not notify success.
- Tests cover desktop IPC and direct browser invalidation.

## 9. Job Queue

Current files:

- `packages/db/src/queue/job-queue.ts`
- `packages/db/src/chunk-embedding-job-batch.ts`
- `packages/embeddings/src/worker/embedding-worker.ts`
- `apps/desktop/src/embedding-backfill.ts`

Current state:

- Claim uses `FOR UPDATE SKIP LOCKED`.
- Batch operations use `unnest` and JSONB arrays.
- Completion atomically writes embeddings and marks jobs complete under the same lease guard.

Turso work:

- Design an atomic claim protocol using Turso transactions.
- Replace batch inputs with temp tables, JSON expansion, or batched prepared statements.
- Preserve lease token checks for every lifecycle transition.
- Preserve atomic chunk embedding update plus job completion.
- Make conflict retries explicit, bounded, observable, and tested.

Verification:

- Multi-worker claim test proves no duplicate claims.
- Stale lease completion test proves stale workers cannot write embeddings.
- Expired leases requeue correctly.
- Queue stats remain accurate under concurrent work.

## 10. Vector Search

Current files:

- `packages/db/src/repositories/file-chunk-repository.ts`
- `packages/db/src/repositories/_shared.ts`
- `packages/db/src/migrations/dimension-index-helpers.ts`
- `packages/db/src/migrations/vector-index-helpers.ts`
- `packages/agent/src/pglite-mastra-memory/vector-store.ts`

Current state:

- pgvector column stores variable dimensions.
- Query filters `vector_dims(embedding) = N`.
- HNSW indexes are partial per dimension over `halfvec(N)`.
- Query-time tuning uses `SET LOCAL hnsw.*`.

Turso work:

- Decide vector layout:
  - fixed-dimension table per embedding set,
  - shared table with dimension column and strict constraints,
  - or separate vector index table.
- Store vectors in Turso-compatible BLOB format.
- Use Turso vector index/query functions.
- Preserve dimension and distance validation.
- Remove HNSW/halfvec tuning assumptions unless Turso provides equivalent controls.

Verification:

- Exact and ANN query parity against fixed corpora.
- Filtered top-k results preserve embedding set scoping.
- Mixed-dimension data cannot produce misleading results.
- Threshold behavior is tested.
- Performance is measured on realistic chunk counts.

## 11. FTS And Grep

Current files:

- `packages/db/src/repositories/file-chunk-repository.ts`
- `packages/db/src/search/grep-search-service.ts`
- `packages/db/src/search/hybrid-search-service.ts`
- `packages/db/src/migrations/019-fts-tsvector-column.ts`
- `packages/db/src/migrations/034-tsvector-generated-column.ts`
- `packages/db/src/migrations/038-pg-trgm-grep-index.ts`

Current state:

- FTS uses `tsvector`, `websearch_to_tsquery`, `ts_rank`, and `ts_headline`.
- Grep prefilter uses pg_trgm plus `ILIKE`/`LIKE`.
- JS remains authoritative for regex/literal line matches.

Turso work:

- Choose Turso FTS or SQLite FTS5 strategy.
- Rebuild ranking and snippet/highlight behavior.
- Rebuild substring prefilter for grep.
- Keep JS authoritative matching for regex semantics.
- Preserve `scanLimited`/`truncated` output flags.

Verification:

- Identifier search, error text search, case-sensitive search, regex search, path filters, chunk overlap dedupe, and pagination are covered.
- FTS rank changes are measured and accepted, not hidden.
- Hybrid RRF tests prove stable ordering for representative queries.

## 12. Assistant Tools And Retrieval

Current files:

- `apps/desktop/src/assistant-server/assistant-tools.ts`
- `apps/desktop/src/assistant-server/retrieval-tool.ts`
- `packages/agent/src/mastra/default-instructions.ts`
- `packages/agent/src/tools/*`

Current state:

- Instructions present `grepSearch` first for exact identifiers and `queryEmbeddingSpace` for semantic search.
- Tool output budgets and truncation contracts are explicit.
- Retrieval depends on file chunk vector/FTS repositories.

Turso work:

- Preserve tool names and output contracts where possible.
- Keep grep-first behavior.
- Update any model-facing guidance only if retrieval behavior changes.
- Keep token budget enforcement unchanged.

Verification:

- Native tool tests pass.
- Retrieval tool integration returns source ranges and chunk metadata.
- Tool outputs remain bounded and explicit when truncated.

## 13. Assistant Memory And Mastra Stores

Current files:

- `packages/app-shell/src/assistant-memory-repository.ts`
- `packages/agent/src/pglite-mastra-memory/memory-store.ts`
- `packages/agent/src/pglite-mastra-memory/vector-store.ts`
- `packages/agent/src/pglite-mastra-memory/workflows-store.ts`
- `packages/agent/src/__tests__/mastra-memory-persistence.spec.ts`

Current state:

- Assistant memory uses Postgres JSONB/timestamptz syntax.
- Vector store uses pgvector.
- Reload hydration depends on real persisted Mastra rows.

Turso work:

- Port message/thread/run/event tables.
- Port vector memory store or replace with a Turso-compatible Mastra vector store.
- Decide whether to use `@mastra/libsql` directly for Mastra-owned tables or keep a Brainstrike-owned Mastra storage adapter over the selected DB contract.
- If `@mastra/libsql` is used, wrap or replace any memory/thread reads that return empty results after storage errors.
- Do not copy Mastra Code UI's backend fallback or module-global memory cache without proving profile/resource isolation.
- Preserve Mastra v2 message dialect exactly.
- Preserve run event grouping and tool result hydration.

Verification:

- Live Mastra loop tests pass with real store.
- Local desktop provider turns persist.
- Hosted provider turns persist.
- Reload hydration matches live order.

## 14. Model Catalog And Preferences

Current files:

- `packages/assistant-contract/src/provider-registry.ts`
- `packages/db/src/migrations/*model*`
- `packages/preferences/src/stores/assistant-preferences-store.ts`
- `packages/preferences/src/stores/assistant-memory-preferences-store.ts`

Current state:

- Model catalog is DB-backed.
- Static registry plus DB migrations plus preference remaps must stay in sync.

Turso work:

- Port model catalog migrations into Turso baseline.
- Preserve user-toggle semantics if any refresh migrations remain.
- Keep preference remap logic independent of engine.

Verification:

- Existing model catalog tests port to Turso.
- No selected model ID dangles after baseline reset/remap.

## 15. Tests And Lane Registries

Current files:

- `packages/db/scripts/test-lanes.mjs`
- `packages/db/scripts/coverage-lanes.mjs`
- `packages/db/__tests__/*`
- `packages/agent/src/__tests__/*`
- `packages/app-shell/src/__tests__/*`
- `apps/desktop/src/__tests__/*`

Current state:

- DB tests are lane-registered.
- Coverage lanes are separate from unit lanes.
- Many tests construct PGlite directly.

Turso work:

- Add Turso runtime test helper.
- Port direct PGlite tests to the new helper.
- Register every new DB test in both lane registries.
- Keep race tests on the real engine.

Verification:

- `node packages/db/scripts/test-lanes.mjs check`
- `node packages/db/scripts/coverage-lanes.mjs check`
- targeted DB, agent, app-shell, and desktop suites pass.

## 16. Docs And AGENTS Updates

Current files:

- `AGENTS.md`
- `docs/react-doctor-migration-2026-06-15.md`
- storage/search/background-indexing docs

Current state:

- AGENTS contains a PGlite extension invariant and embedding architecture notes that assume PGlite.

Turso work:

- Replace PGlite extension invariant with Turso runtime capability invariant.
- Update assistant search docs if FTS/vector semantics change.
- Update local-first architecture docs if sync is introduced.
- Document any accepted search ranking differences.

Verification:

- Docs reflect actual code after migration.
- No PGlite-only invariant remains as live guidance.

## 17. Mastra Code UI Reference

Reference inspected:

- [mastra-ai/mastra-code-ui](https://github.com/mastra-ai/mastra-code-ui) at commit [`c254853f6c6e52f78b22ca056e733a07e113ebf8`](https://github.com/mastra-ai/mastra-code-ui/commit/c254853f6c6e52f78b22ca056e733a07e113ebf8)
- installed packages: `mastracode@0.5.1`, `@mastra/libsql@1.6.3`, `@libsql/client@0.15.15`
- detailed notes: `docs/turso-migration/2026-06-21-mastra-code-ui-libsql-reverse-engineering.md`

Verified implementation shape:

- Electron app calls `createMastraCode({ cwd, extraTools })`.
- `mastracode` resolves project/resource identity and storage config.
- It creates `LibSQLStore` and injects the same store into Mastra `Memory` and `Harness`.
- Harness owns thread/resource scoping; tools see IDs, not direct DB handles.
- Remote Turso-style use is LibSQL URL plus auth token, not the new `@tursodatabase/database` engine.

Brainstrike use:

- Use this as the reference for the Mastra/Harness integration seam.
- Keep `resourceId` and thread IDs explicit through assistant memory and hydration tests.
- Treat `@mastra/libsql` as a candidate for Mastra-owned persistence only after fail-closed wrappers are specified.
- Keep app data, queue, search, and live invalidation under the Brainstrike DB contract until proven otherwise.

Do not copy:

- fallback from a failed selected backend to local LibSQL,
- silent config parse ignores,
- empty-result returns after storage failures,
- PID-file thread locks for correctness-critical leases,
- imperative Mastra table creation as the Brainstrike app migration ledger,
- vector-index claims without a Brainstrike-scale benchmark.
