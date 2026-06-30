# Turso Migration Ledger

Last updated: 2026-06-30 on `feature/turso-migration`.

This ledger is the working map for finishing the greenfield migration from
PGlite to Turso. It is not a go/no-go memo. Treat the "Remaining Work" section
as the implementation backlog.

## Current Branch State

`feature/turso-migration` currently contains these Turso migration slices:

- #1304 `feat(db): add profile bootstrap readiness report`
- #1305 `feat(db): add bootstrap capability probe`
- #1306 `feat(db): add runtime selection seam`
- #1307 `feat(desktop): require db host bootstrap reports`
- #1308 `Add Turso capability spike`
- #1309 `Codify Turso search index ownership`
- #1310 `Add Turso profile bootstrap contract`
- #1311 `Add Turso owner client execution surface`
- #1312 `Add Turso-neutral DB capability contracts`
- #1314 `Add Turso schema baseline ledger`
- #1315 `Route desktop Turso lazy init through bootstrap`
- #1316 `Add Turso view filter preset repository`
- #1317 `Shard affected unit tests in CI`
- #1318 `Use generic DB client aliases in Turso migration consumers`
- #1319 `Shard affected coverage in PR CI`
- #1320 `Reduce PR unit shard blast radius`
- #1321 `Use generic DB hook in file explorer UI`
- #1322 `Add Turso token cache store`
- #1323 `Wire Turso token cache provider`
- #1324 `Clear Turso token cache store on DB init error`
- #1325 `Narrow DB affected CI lanes`
- #1326 `Add Turso file record repository`
- #1327 `Add Turso embedding sets repository`
- #1328 `Narrow Turso schema affected lanes`
- #1329 `Add Turso file chunk repository`
- #1330 `Add Turso chunk job enqueue seam`
- #1331 `Narrow chunk enqueue affected CI lanes`
- #1332 `Expose Turso file record repository in provider`
- #1333 `Scope affected shard builds to planned packages`
- #1334 `Add Turso managed-cache import path`
- #1335 `Split DB affected unit lanes`
- #1336 `Add Turso job queue runtime`
- #1339 `Gate Turso provider execution surfaces`
- #1340 `Expose Turso file chunks in DB provider`
- #1341 `Add Turso collection snapshots to DB Explorer`
- #1342 `Use Turso collection status snapshots in DB Explorer`
- #1343 `Use Turso snapshots for collection coverage banner`
- #1344 `Gate quick open on indexed repository snapshots`
- #1345 `Add Turso indexed quick-open filename search`
- #1346 `Use Turso vector queue stats and retry controls`
- #1347 `Gate vector queue service by DB runtime`
- #1348 `Add Turso embedding backfill candidate queries`
- #1349 `Extract vector backfill repository port`
- #1350 `Add Turso vector backfill adapter`
- #1351 `Make vector queue refresh metrics storage-neutral`
- #1352 `Add Turso Mastra memory adapter`
- #1353 `Tighten Turso backfill dedupe diagnostics`
- #1354 `Wire desktop Mastra memory to Turso runtime`
- #1355 `Add Turso grep candidates`
- #1356 `Gate Turso grep search`
- #1357 `Add Turso vector search`
- #1358 `Gate Turso semantic retrieval by bootstrap`
- #1359 `Gate scheduled desktop database and dimension-index maintenance by runtime`
- #1360 `Fix Turso inherited chunk stats`
- #1361 `Fix Turso baseline seed upgrades`
- #1362 `Fix Turso queue write contention retries`
- #1363 `Fix Turso embedding-set delete file metadata`
- #1364 `Add Turso owner client QoS diagnostics`
- #1365 `Surface Turso owner QoS diagnostics in desktop`
- #1366 `Persist desktop assistant run data on Turso`
- #1367 `Share assistant run persistence SQL`
- Current slice: add a Turso/SQLite scheduled database maintenance
  implementation for old terminal job pruning plus `ANALYZE`, selected through
  an explicit desktop maintenance capability. Dimension-index maintenance
  remains PGlite/pgvector-only.

Recently completed diagnostics slice: surface the Turso owner-client QoS snapshot through desktop
  database diagnostics and DB-host IPC, with explicit unavailable states for
  non-Turso runtimes, not-yet-open owner handles, and unsupported owner-handle
  diagnostics.

## Turso Docs Guardrail

The current Turso docs draw a hard line between embedded replicas and Turso
Sync:

- Embedded replicas serve reads from the local file, but writes go to the
  remote primary by default and are then reflected into the local replica.
- The TypeScript client reference states that `@libsql/client/web` does not
  support local file URLs.
- Turso recommends Turso Sync for new projects that need local-first writes:
  reads and writes are local, and applications call explicit `push()` /
  `pull()`.

Migration implication: do not mark a Brainstrike path "local-first Turso" just
because it can open a local `file:` libSQL database or embedded replica. Any
latency-critical write path must either use a local Turso database with explicit
sync semantics, or be documented as remote-primary/online-bound.

Primary docs consulted:

- <https://docs.turso.tech/features/embedded-replicas/introduction>
- <https://docs.turso.tech/sdk/ts/reference>
- <https://docs.turso.tech/sync/usage>

## Implemented Runtime Shape

The branch currently has a real Turso runtime seam:

- Runtime selection uses `BRAINSTRIKE_DB_RUNTIME=turso`.
- Desktop bootstrap opens the Turso primary store and reports typed
  capabilities.
- The Turso primary store uses a greenfield baseline ledger rather than the
  PGlite/Postgres migration chain.
- The desktop DB host can open a long-lived Turso owner client.
- The Turso owner client exposes read-only QoS snapshots for its exclusive
  operation queue: active operation, queued operations, slow queued operation
  count, and queued/started/completed/failed totals. Desktop
  `DatabaseDiagnosticsSnapshot` now carries that snapshot through the DB host
  IPC surface when Turso is active, returns explicit unavailable reasons for
  non-Turso, not-yet-open, or unsupported owner-handle diagnostics states, and
  logs an error when an active Turso owner handle lacks the diagnostics method.
  This is diagnostic-only and does not alter timeout, retry, or write
  serialization policy.
- Live query capability is explicit and currently false for Turso.
- PGlite-only query surfaces now fail closed under Turso instead of silently
  returning stale PGlite behavior.

Current Turso repository/runtime coverage:

- `embedding_sets`
- `file_records`
- `file_chunks` for non-search persistence, exposed through the desktop Turso
  provider
- `view_filter_presets`
- `file_token_cache`
- managed-cache apply/invalidate
- chunk insert plus embedding job enqueue
- job queue claim, lease, completion, failure, retry, pending-count, and delete;
  Turso write-contention retries cover enqueue, claim, completion, heartbeat,
  failure/retry, cancel/clear/prune/expire, and failed-job reset paths
- selected model/embedding-set read paths exposed through provider-safe hooks
- DB Explorer selected-collection browsing snapshots, indexed chunk count, and
  requested file status lookups through repository-backed Turso paths
- quick-open filename lookup through an indexed Turso name-gram table maintained
  by Turso file-record and managed-cache writes
- vector-management durable queue stats and retry/repair controls through a
  runtime-keyed queue hook that constructs `TursoJobQueue` only for ready Turso
  profiles
- embedding runtime queue service construction now keys off the bootstrap
  runtime. PGlite still constructs the legacy Postgres-shaped
  `VectorQueueService`; Turso returns an explicit
  `turso-vector-backfill-not-migrated` unavailable result so old PGlite SQL does
  not run under Turso.
- Turso file chunks expose SQLite-compatible embedding backfill candidate
  counting, diagnostics, and cursor-batched candidate selection. These methods
  exclude active queued/running deduped jobs, include inherited
  `file_records.embedding_set_id` scope, and fail closed when pending chunks
  lack `content_hash`.
- `VectorQueueService` now consumes a storage-neutral
  `EmbeddingBackfillRepository` for embedding-set metadata, candidate counts,
  candidate batches, candidate diagnostics, and per-set drain counts. The
  default implementation preserves the existing PGlite SQL path, while tests
  prove backfill and API-key validation can run through an injected repository
  without raw DB queries.
- Turso has a concrete `EmbeddingBackfillRepository` adapter that composes the
  Turso file-chunk candidate methods, embedding-set metadata repository, and
  Turso job-queue per-set state counts. It is exported for future wiring, but
  runtime selection still returns `turso-vector-backfill-not-migrated` until the
  hidden worker, Electron IPC, and Turso claim/load/complete path are migrated.
- `VectorQueueService.refresh()` now reads queue throughput, latest failure, and
  latency samples through a storage-neutral `VectorQueueMetricsRepository`.
  PGlite keeps the existing PostgreSQL-shaped SQL behind the default repository;
  Turso exposes the same metrics through `TursoJobQueue.getQueueMetrics()` and a
  vector-management adapter. This is intentionally not runtime wiring yet.
- Desktop Turso assistant memory is wired through the ready runtime/bootstrap
  verdict. The renderer thread repository, OM meter, and cross-root usage reads
  now select PGlite live queries or Turso/SQLite snapshot reads by runtime.
  Desktop assistant run-event and run-status writes now also select SQL by the
  ready runtime: PGlite keeps the existing Postgres-shaped statements, while
  Turso uses `?` placeholders, SQLite timestamps, and `excluded.*` conflict
  updates for `brainstrike_assistant_run_events` and
  `brainstrike_assistant_thread_runs`. Those write queries are now built by
  shared `@brainstrike/assistant-contract/assistant-run-persistence` helpers
  used by both the desktop assistant server and app-shell thread repositories.
- Desktop assistant `brainstrike.grepSearch` is available under Turso only when
  the ready bootstrap report includes required check
  `search.grep-content-grams=passed`. The tool uses
  `TursoFileChunkRepository.findGrepCandidates()` through the shared bounded
  `GrepSearchService`.
- Desktop assistant `brainstrike.queryEmbeddingSpace` is available under Turso
  only when the ready bootstrap report includes required check
  `search.vector32-functions=passed`. It uses Turso embedding-set, file-record,
  and file-chunk repositories plus SQLite-compatible snapshot/root-label helper
  queries; PGlite keeps the legacy retrieval path.
- Turso collection indexing stats now use the same effective embedding-set
  membership as the backfill and file-status paths: explicit
  `file_chunks.embedding_set_id` wins, and chunks with a null chunk set inherit
  from `file_records.embedding_set_id`. This is covered for
  `listEmbeddingSpaces({ includeStats: true })`,
  `TursoFileChunkRepository.clearEmbeddingsForSet()` stats refresh, and
  managed-cache stats refresh. Turso clear/delete cleanup now uses the same
  effective membership rule so inherited chunks do not retain stale embeddings
  or survive embedding-set deletion. Turso vector similarity search now uses the
  same membership rule so `brainstrike.queryEmbeddingSpace` can retrieve chunks
  that stats report as embedded/covered. Turso indexed grep candidates also use
  the same rule so `brainstrike.grepSearch` can search inherited chunks when it
  receives the workspace index embedding set.
- Turso schema baseline v6 treats seed DML changes as a real baseline upgrade
  instead of mutating v5 in place. Upgrades from v1-v5 re-run idempotent seed
  DML before recording the current ledger row, so future catalog rows are
  inserted for existing Turso profiles while `models.is_enabled` and
  `view_filter_presets.sort_order` remain user-owned. Generated quick-open and
  grep gram backfills only run for historical baselines whose upgrade DDL
  introduced those sidecar tables; v5-to-v6 reseeding leaves existing generated
  gram rows untouched.
- Turso embedding-set deletion now keeps durable `file_records` but clears
  `embedding_set_id`, `chunks_processed_at`, `chunks_count`, and
  `chunking_strategy` for rows that belonged to the deleted set after deleting
  effective-member chunks. This prevents stale file rows from surfacing under a
  deleted embedding set while preserving the file identity for future reindexing.

## Non-Negotiable Migration Rules

- Do not hide missing Turso functionality behind PGlite fallbacks.
- Do not replace indexed search with unbounded SQLite scans.
- Do not treat PGlite live query hooks as available under Turso.
- Do not replay the PGlite/Postgres migration chain into a Turso profile.
- Do not move embedding or built-in local LLM work into Electron main.
- Do not call generic `db` handles PGlite-compatible unless the runtime has a
  real execution client behind the generic contract.
- Every production Turso write path needs a Turso-specific test or an existing
  runtime test that proves the Turso path, not a mock-only PGlite path.

## Remaining Work

### 1. Shared Provider And Hook Gates

Many UI blockers are now centralized at the shared DB provider layer:

- `DbProvider` initializes Turso repositories for `embedding_sets`,
  `file_records`, `file_chunks`, `file_token_cache`, and
  `view_filter_presets`.
- `useBrainstrikeDbClient()` returns a raw execution handle only for
  `runtime.engine === "pglite"`.
- `useBrainstrikeLiveQuery()` remains a PGlite live-query alias.

Remaining provider work: add a generic execution-client hook with capability
metadata so callers stop treating "raw DB handle" as "PGlite". Vector, FTS, and
grep methods on the chunk repository remain explicitly unsupported until their
search slices land.

### 2. UI Snapshot Replacements For Live Queries

PGlite live queries are not part of the Turso runtime. Any UI still depending
on `useBrainstrikeLiveQuery` needs either:

- a repository-backed snapshot loader with explicit refresh triggers, or
- an explicit unsupported state with diagnostics if live updates are required.

Known production touchpoints:

- `packages/db-explorer/src/database-demo-panel.tsx`
- `packages/db-explorer/src/use-database-demo-data.ts`
- `packages/preferences/src/settings/tools/unified-tools-settings.tsx`
- `packages/app-shell/src/use-quick-open-files.ts`
- `packages/app-shell/src/use-file-mentions.ts`
- `packages/app-shell/src/cost-tracking/use-cross-root-cost.ts`
- `packages/app-shell/src/use-om-segment-row.ts`

Completed UI snapshot slices now cover selected collection browsing, indexed
chunk count, requested file status lookups, and collection embedding coverage
banner snapshots. Quick-open now has a repository-snapshot hook seam for runtimes
that expose an indexed `findByNameSubstring` repository capability. Turso
implements that seam with a primary-store `file_record_name_grams` table indexed
by `(gram, file_record_id)` plus a `file_record_name_index` normalized-name
sidecar: the gram index produces candidates, SQLite's `instr` applies the exact
substring guard, and ordering remains the same shortest-name-then-path ordering
used by the PGlite query. Schema upgrades backfill both sidecar tables from
existing `file_records`. This is intentionally not a general FTS replacement;
grep, full-text snippets, and hybrid search still need the split search-index
work below.

### 3. Background Indexing And Embedding Host

The hidden embedding host still uses PGlite-oriented runtime access even though
Turso has file/chunk/job primitives.

Known production touchpoints:

- `apps/desktop/src/renderer/components/embedding-host-runtime.tsx`
- `apps/desktop/src/renderer/components/embedding-worker-provider.tsx`
- `packages/app-shell/src/background-indexing/workspace-collection-sync-provider.tsx`
- `packages/vector-management/src/embedding-runtime-provider.tsx`
- `packages/vector-management/src/vector-status/use-vector-queue-state.ts`
- `packages/vector-management/src/vector-status/vector-status.tsx`

Completed low-risk queue UI slices:

- `EmbeddingJobQueueTracker` and `QueueHud` use a runtime-keyed queue hook.
  Ready Turso profiles can poll `TursoJobQueue.getQueueStats()` and run
  failed-job retry/repair controls without opening a PGlite handle.
- `EmbeddingRuntimeProvider` no longer calls the PGlite-only database hook to
  construct its vector queue service. It uses the generic ready DB client and
  the bootstrap runtime, constructs `JobQueue` only for PGlite, and keeps Turso
  service-null with an explicit unavailable reason.

Remaining slice: wire the Turso `EmbeddingBackfillRepository` only after the
hidden embedding host can run the Turso claim/load/complete path end-to-end.
Preserve the hidden-renderer worker boundary. Do not enable Turso backfill
through `vector-queue-service.ts` until Electron transaction/query support and
runtime-specific worker tests prove the full path.

### 4. Assistant Search And Retrieval

The assistant's grep, retrieval, and hybrid search surfaces remain the largest
PGlite capability gap. The current architecture deliberately separates primary
state from search ownership because Turso custom FTS indexes do not work in the
same MVCC primary store in the current capability spike.

Known production touchpoints:

- `apps/desktop/src/assistant-server/assistant-tools.ts`
- `apps/desktop/src/assistant-server/grep-search-tool.ts`
- `apps/desktop/src/assistant-server/retrieval-tool.ts`
- `packages/db/src/search/grep-search-service.ts`
- `packages/db/src/search/hybrid-search-service.ts`
- `packages/db/src/repositories/turso-file-chunk-repository.ts`

Concrete status:

- Turso `brainstrike.grepSearch` is registered only behind the explicit
  `search.grep-content-grams` bootstrap proof.
- Turso `brainstrike.queryEmbeddingSpace` is registered and requires the
  explicit `search.vector32-functions` bootstrap proof before it can query.
- `TursoFileChunkRepository.findGrepCandidates()` now provides bounded
  SQLite-compatible candidate selection. Literal/regex-literal prefilters use
  `file_chunk_content_grams` plus `file_chunk_content_index` as an indexed
  candidate source; no-prefilter regex scans stay explicitly bounded and are
  surfaced by the grep service as `scanLimited`. The path covers root, path,
  embedding-set, limit, and root-display metadata.
- `TursoFileChunkRepository.searchSimilar()` now writes repository-authored
  embeddings as native `vector32(?)` blobs, queries with Turso vector distance
  primitives (`vector_distance_cos`, `vector_distance_l2`, `vector_distance_dot`),
  preserves the PGlite similarity formulas, and supports embedding-set, root,
  file-record, chunk-type, inline file-path, and selection-snapshot filters.
- `TursoFileChunkRepository.fullTextSearch()` still throws until the Turso FTS
  slice lands.

Preferred implementation order:

1. Re-enable remaining assistant retrieval tools only for capabilities proven by the repository
   and bootstrap reports.
2. Implement FTS snippets and hybrid ranking through the split search-index
   owner once `docs/turso-migration/search-index-architecture.md` is
   implemented.

### 5. Mastra Memory And Assistant Persistence

The desktop assistant server still initializes PGlite Mastra memory on the
hosted-provider path. This is not just a SQL swap: tool approval suspend/resume,
message hydration, run events, local-provider desktop persistence, and stream
resilience all depend on the live Mastra loop.

Known production touchpoints:

- `apps/desktop/src/assistant-server.ts`
- `packages/agent/src/pglite-mastra-memory`
- `packages/app-shell/src/assistant-memory-repository.ts`
- `packages/app-shell/src/assistant-ui-panel-wrapper.tsx`
- `packages/app-shell/src/threads-panel.tsx`
- `packages/app-shell/src/assistant-thread-tabs-workspace.tsx`

Concrete blockers:

- `TursoMemoryStore` and `TursoWorkflowsStore` now exist under
  `@brainstrike/agent/turso-mastra-memory`, with SQLite-compatible schema,
  thread/message/resource persistence, non-vector observational memory, and
  workflow snapshots.
- The Turso factory intentionally does not expose vector memory yet. Semantic
  recall and observational vector retrieval fail closed with deterministic
  configuration errors instead of silently disabling vector behavior.
- `PgliteVectorStore` creates `vector` extension, `embedding vector`, JSONB,
  and GIN indexes.
- The renderer thread repository still contains separate PGlite and Turso read
  query dialects for latest-run listing, message hydration, usage aggregation,
  and thread CRUD. Do not centralize those until each read surface is covered by
  a dialect-specific contract test; the current shared helper only owns
  run-event append and terminal run-status writes.

Completed slices have wired the desktop assistant server to select the Turso
factory from the ready runtime/bootstrap verdict, included runtime/profile/store
identity in the memory cache key, and replayed live-loop persistence against
Turso. Remaining work in this area is vector semantic memory parity: the Turso
factory intentionally fails closed for vector memory until a Turso-compatible
vector store and recall contract exist.

### 6. Schema Authority, Maintenance, And Data Migration

The Turso path is intentionally greenfield, but the final migration still needs
clear authority boundaries.

Known production touchpoints:

- `packages/db/src/schema/index.ts`
- `packages/db/src/drizzle/migrate.ts`
- `packages/db/src/migrations/index.ts`
- `packages/db/src/architecture/db-runtime-baseline.ts`
- `packages/db/src/services/scheduled-database-maintenance.ts`
- `apps/desktop/src/main.ts`

Concrete blockers:

- Canonical Drizzle schema still defines pgvector and generated
  `to_tsvector` structures.
- Numbered migration runners remain PGlite/Postgres authority.
- There is no production PGlite-to-Turso data migration path. This is
  acceptable only while the project remains greenfield and the bootstrap path
  continues to reject PGlite migration ledgers in Turso profiles.
- Scheduled DB maintenance now has two explicit implementations:
  PGlite/Postgres prunes terminal `job_queue` rows with the existing
  Postgres-shaped SQL and table-targeted `VACUUM`, while Turso/SQLite prunes
  terminal `job_queue` rows with `?` placeholders and runs validated
  `ANALYZE job_queue`. The desktop scheduler selects the implementation through
  an explicit maintenance capability (`pglite-postgres`, `turso-sqlite`, or
  `false`) rather than treating the raw runtime as a SQL capability.
  Dimension-index maintenance remains PGlite/pgvector-only because it still
  builds pgvector HNSW SQL.
- Post-merge retrospective follow-ups still need focused slices: Turso owner
  client timeout/watchdog policy, QoS/connection-model decision, and Turso
  corruption diagnostics/recovery.

Preferred next slice: add the Turso tool-approval suspend/resume live-loop
proof so assistant approval workflows are covered against the Turso workflow
store, not only PGlite.

### 7. Factory Reset And Profile Cleanup

Factory reset still contains PGlite IndexedDB/OPFS cleanup details for the
renderer/browser storage path. Desktop Turso state is currently filesystem
profile state: `<dbRoot>/profiles/<profile>/turso-primary.db`. The main-process
DB reset deletes the whole active profile directory, which removes the Turso
primary store and any profile-local sidecars. After deletion, reset now
recreates the runtime-owned empty directory: PGlite recreates `<profile>/pgdata`,
while Turso recreates only `<profile>` so a Turso reset does not leave a
misleading PGlite-shaped `pgdata` directory.

No production Turso sync/search metadata path currently exists outside the
profile directory. Future out-of-profile sync or search stores must be added as
explicit named reset targets with tests; do not delete guessed names such as
`.sync`, `sync`, or `${primary}.fts.db`.

Known production touchpoints:

- `packages/preferences/src/settings/system/factory-reset-helpers.ts`
- `packages/preferences/src/settings/system/factory-reset-panel.tsx`
- `apps/desktop/src/db-main.ts`
- `apps/desktop/src/desktop-reset-platform.ts`

Remaining reset follow-up: add explicit reset targets if a future Turso sync or
split-search implementation creates stores outside the active profile directory.

### 8. Dependency And Build Cleanup

PGlite packages, Vite aliases, type shims, and WASM packaging remain necessary
while web/PGlite and compatibility paths exist. Final removal should happen
only after the runtime audit proves no production path imports PGlite.

Known production touchpoints:

- `apps/desktop/package.json`
- `apps/desktop/vite.config.mts`
- `packages/db/src/wasm-loader.ts`
- `packages/build-utils`
- `apps/desktop/src/types/pglite*.d.ts`

Preferred next slice: keep these until the final runtime removal pass;
premature cleanup would break current PGlite-mode tests and web paths without
advancing Turso parity.

## Suggested Implementation Order

1. Collection/import slice: make db-explorer manual import and collection
   browser snapshot paths work without live query.
2. Vector queue slice: wire `TursoJobQueue` into vector-management status and
   actions with polling snapshots.
3. Assistant memory slice: add Turso Mastra storage/workflow memory and prove
   the live Mastra loop against it.
4. Search slice: add Turso grep/vector repository methods, then semantic search
   and assistant retrieval.
5. Live-query strategy slice: either implement a Turso live-query source over
   IPC or formalize snapshot+refresh alternatives per UI surface.
6. Reset/maintenance slice: Turso-aware factory reset, profile cleanup, and
   scheduled maintenance gates.
7. Final runtime audit: remove or isolate leftover PGlite-only production
   imports, dependencies, Vite aliases, and type shims.

## Verification Policy

Each implementation PR should include:

- A failing Turso-specific test before production code.
- Targeted package tests for the touched surface.
- `pnpm lint && pnpm type-check && pnpm build && pnpm test` before push.
- PR watcher loops for checks, comments, and independent review.
- Merge back into `feature/turso-migration` only after latest-head checks are
  green and all blocking comments are answered/resolved.
