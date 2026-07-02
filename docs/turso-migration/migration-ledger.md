# Turso Migration Ledger

Last updated: 2026-07-02 on `feature/turso-migration`.

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
- #1368 `Add Turso scheduled database maintenance`
- #1369 `Fix Turso profile reset recreation`
- #1371 `test(agent): prove Turso tool approval resume`
- #1372 `feat(db-explorer): activate Turso collection snapshots`
- #1373 `Extract embedding worker storage port`
- #1374 `Add Turso embedding worker storage adapter`
- #1375 `Wire Turso embedding host storage`
- #1376 `Prove Turso worker IPC owner path`
- #1377 `Gate Turso vector queue actions on adapter`
- #1378 `Wire Turso vector queue actions through owner IPC`
- #1379 `Wire query selection snapshots to Turso`
- #1380 `Make workspace roots runtime-aware for Turso`
- #1381 `Fix Turso vector queue model lookup placeholder`
- #1382 `Clear assistant usage in direct reset paths`
- #1383 `Use Turso-ready model registry in memory settings`
- #1384 `Use runtime DB in vector status selector`
- #1385 `Fix Turso model registry toggles`
- #1386 `Use runtime registry DB in database demo`
- #1387 `Use Turso snapshots for file mentions`
- #1388 `Add Turso queue activity snapshot fallback`
- #1389 `Enable Turso vector search in DB Explorer`
- #1390 `Enable non-chunked Turso manual imports`
- #1391 `Enable Turso chunked manual imports`
- #1392 `Use runtime DB client for indexing activity`
- #1393 `Wire background indexing to Turso runtime`
- #1396 `Run embedding backfill on Turso`
- #1397 `Fail closed on Turso background chunk updates`
- #1398 `Enable Turso lexical hybrid search`
- #1399 `Fix Turso runtime follow-up seams`
- #1400 `Enable Turso embedding cache`
- #1401 `Add Turso embedding clear owner action`
- #1402 `Align embedding clear set membership`
- #1403 `Fix inherited embedding set delete cleanup`
- #1404 `Compose Turso re-embed flow`
- #1405 `Terminate Turso DB host on request timeout`
- #1406 `Recover Turso bootstrap corruption`
- #1407 `Resolve DB Explorer semantic search sets via repository`
- #1408 `Prove assistant reindex DB-host applier path`
- #1409 `Prefer Turso collection repository snapshots`
- #1410 `Remove PGlite-specific assistant memory copy`
- #1411 `Remove PGlite-specific desktop database copy`
- #1412 `Neutralize database status fallback copy`
- #1413 `Neutralize file status backend error copy`
- #1414 `Remove stale Turso queue boundary`
- #1415 `Neutralize collection browser snapshot copy`
- #1441 `Expose runtime execution DB client hook`

Recently completed reset slice: desktop reset now removes the whole active
  profile directory for both runtimes, then recreates the runtime-owned empty
  directory: `<profile>/pgdata` for PGlite and `<profile>` for Turso.

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

MVCC/concurrent-write maturity is a separate release-readiness risk. The
Brainstrike Turso path hard-requires `PRAGMA journal_mode = 'mvcc'`, and owner
client transactions use `BEGIN CONCURRENT`. Current official Turso material is
mixed: the TypeScript SDK reference presents `@tursodatabase/database` as the
recommended local embedded package, while the TursoDB quickstart and 0.5.0
release notes still describe MVCC/concurrent-write behavior as beta,
experimental, or not production-ready in places. Treat this as requiring
explicit team signoff, backup/reset validation, and real-engine tests before
shipping. Do not hide that risk behind a PGlite fallback.

Primary docs consulted:

- <https://docs.turso.tech/features/embedded-replicas/introduction>
- <https://docs.turso.tech/sdk/ts/reference>
- <https://docs.turso.tech/sync/usage>
- <https://docs.turso.tech/tursodb/quickstart>
- <https://turso.tech/blog/turso-0.5.0>

## Implemented Runtime Shape

The branch currently has a real Turso runtime seam:

- Runtime selection uses `BRAINSTRIKE_DB_RUNTIME=turso`.
- Desktop bootstrap opens the Turso primary store and reports typed
  capabilities.
- The Turso primary store uses a greenfield baseline ledger rather than the
  PGlite/Postgres migration chain.
- The desktop DB host can open a long-lived Turso owner client.
- Turso bootstrap now treats explicit SQLite/libSQL corruption signals
  (`SQLITE_CORRUPT`, `SQLITE_NOTADB`, `database disk image is malformed`, and
  `file is not a database`) as recoverable during `opening-store` and
  `migrating-schema`, plus Turso-only `probing-capabilities`: the active
  profile is backed up/reset, the process lock is reacquired, bootstrap is
  retried once, and the owner client is opened only after a ready report.
- The Turso owner client exposes read-only QoS snapshots for its exclusive
  operation queue: active operation, queued operations, slow queued operation
  count, and queued/started/completed/failed totals. Desktop
  `DatabaseDiagnosticsSnapshot` now carries that snapshot through the DB host
  IPC surface when Turso is active, returns explicit unavailable reasons for
  non-Turso, not-yet-open, or unsupported owner-handle diagnostics states, and
  logs an error when an active Turso owner handle lacks the diagnostics method.
  This is diagnostic-only and does not alter retry or write serialization
  policy. Turso request timeouts are enforced at the DB utility-host boundary:
  once a host has initialized a ready Turso runtime, any request timeout
  terminates the utility host instead of leaving the serialized owner client
  wedged behind a timed-out operation. PGlite keeps the existing policy where
  plain query/exec timeouts do not kill the host, while transaction timeouts
  remain process-poisoning for both runtimes.
- Connection-model decision for the hidden embedding worker: desktop Turso
  worker DB mutations use the shared main-process owner client through explicit
  command-style IPC and the existing database work scheduler's `background`
  priority lane, not a separate renderer-owned Turso connection. This keeps
  local embedding inference in the hidden renderer while routing interactive
  `TursoJobQueue` transactions to a query-capable owner client. The tradeoff is
  deliberate: this path is foreground-prioritized serialized access, not true
  parallel writer concurrency. A background transaction can briefly head-of-line
  block foreground DB work until it commits, and `BEGIN CONCURRENT` does not add
  primary-store write parallelism while all writes share one owner client. Reopen
  the separate-connection design if release profiling shows
  `slowQueuedOperationCount > 0` for foreground-labeled work, or foreground DB
  work repeatedly waits more than 1000ms behind embedding-worker/background
  operations during manual or e2e profiling. Until that profiling exists, do not
  claim this topology proves foreground latency under active background writes.
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
- vector-management durable queue snapshots through Turso read models, with
  retry/repair, clear, wipe, and clear-embeddings routed through the desktop
  owner-client action IPC rather than renderer-owned `TursoJobQueue` mutation
- embedding runtime queue service construction now keys off the bootstrap
  runtime. PGlite still constructs the legacy Postgres-shaped
  `VectorQueueService`; desktop Turso constructs an explicit bridge-backed
  action service when the preload exposes `tursoVectorQueueAction`, while queue
  snapshots come from `createTursoVectorQueueSnapshotReader()` when the ready DB
  client and coverage repository are present. Do not construct `TursoJobQueue`
  or Turso mutation repositories directly in the visible renderer: mutation
  paths that need transactions or query-capable writes must stay on the desktop
  owner-client IPC surface.
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
  Turso job-queue per-set state counts. Runtime selection keeps desktop
  backfill orchestration in the hidden embedding host; the visible renderer
  must not call these mutation paths through its raw transaction facade.
- `VectorQueueService.refresh()` now reads queue throughput, latest failure, and
  latency samples through a storage-neutral `VectorQueueMetricsRepository`.
  PGlite keeps the existing PostgreSQL-shaped SQL behind the default repository;
  Turso exposes the same metrics through `TursoJobQueue.getQueueMetrics()` and a
  vector-management snapshot adapter.
- Desktop Turso vector queue actions now run through explicit owner-client IPC:
  retry/repair, queue clear, queue wipe, and embedding clearing for one
  embedding set. The clear-embeddings path calls
  `TursoFileChunkRepository.clearEmbeddingsForSet()` in the main DB owner
  process, so stats refresh and SQLite transaction semantics stay in the
  query-capable Turso owner client rather than the visible renderer.
- Vector-management now exposes a user-visible re-embed action under Turso by
  composing that owner-client clear-embeddings action with the existing
  embedding runtime controller's backfill path. The visible renderer does not
  construct `TursoJobQueue` and does not move hidden-host worker ownership into
  the DB action channel. The controls validate embedding credentials and start
  the worker before clearing embeddings, so a startup/configuration failure does
  not empty the active collection.
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
- Turso-backed Mastra workflow storage supports the same per-tool approval
  suspend/resume contract as PGlite: ask-gated tools suspend without executing,
  approve resumes and executes the tool, and decline resumes without executing.
  The proof uses the real `@mastra/core/agent` loop, real Turso workflow
  storage, the production `streamMastraToolApprovalAction` resume path, and the
  desktop `runtime.mastraTools` wiring used by native tools.
- DB Explorer selected-collection browsing can load repository snapshots under
  Turso even when the raw PGlite database handle is null. The hook keeps PGlite
  live queries disabled, uses the Turso-capable file-record/file-chunk
  repositories for records, totals, collection counts, chunk summaries, and
  export data, and preserves the explicit unavailable message when neither
  PGlite collection SQL nor repository snapshots are available.
- DB Explorer semantic search resolves the active embedding set's model through
  `useEmbeddingSetsRepository()` before falling back to the raw PGlite-only DB
  handle, so Turso repository mode can generate query embeddings without
  requiring a PGlite client.
- `DbSchemaVerifier` now consumes the DB provider's schema-readiness
  capability instead of reassembling readiness from raw database handles, so
  the existing vector-status `schemaVerified` compatibility flag follows ready
  PGlite handles and ready Turso bootstrap reports through one provider-owned
  decision.
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

Provider execution-client slice now exposes `useBrainstrikeExecutionDbClient()`
for ready PGlite and Turso runtimes. The hook returns the runtime engine and
explicit SQL capability metadata (`postgres` plus Postgres-only features for
PGlite, `sqlite` plus Turso baseline features for Turso), and returns `null`
unless the ready provider handle has query, exec, and transaction capabilities.
Consumer migrations should use this hook when they need generic SQL execution
metadata; do not use it to imply live-query, vector, grep, or FTS availability.
Those capabilities remain repository/bootstrap-gated.

Remaining provider work: migrate remaining generic SQL consumers onto
`useBrainstrikeExecutionDbClient()` or a concrete repository capability so
callers stop treating "raw DB handle" as "PGlite". Vector, FTS, and grep
methods on the chunk repository must stay capability-gated by the concrete
repository and bootstrap proofs instead of a raw database-handle assumption.

Audit follow-up: `useModelRegistryDbClient()` and model-registry toggle writes
still need a runtime-specific SQL helper. Current Turso driver probes accepted
Postgres-style `$1` placeholders and raw boolean params, but production code
must not depend on dialect lenience. The next model-registry slice should emit
SQLite/Turso `?` placeholders with integer booleans under Turso and keep the
existing Postgres-shaped path only for PGlite, with tests that assert emitted
SQL/params by runtime.

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
chunk count, requested file status lookups, collection embedding coverage banner
snapshots, quick-open, and file mentions. Selected collection browsing now uses
repository snapshots under Turso without requiring a raw PGlite database handle.
DB Explorer semantic search now also resolves the active set's model through the
repository path before the PGlite-only raw DB fallback. Unified Tools Settings
now fails closed when optional PGlite `toolsLiveQuery` metadata is configured
but the shared live-query capability is unavailable; it does not silently
substitute `operations.getTools()` snapshots for an explicitly live-query
surface. Quick-open now has a repository-snapshot hook seam for runtimes that
expose an indexed `findByNameSubstring` repository capability. Turso implements
that seam with a primary-store `file_record_name_grams` table indexed by
`(gram, file_record_id)` plus a `file_record_name_index` normalized-name
sidecar: the gram index produces candidates, SQLite's `instr` applies the exact
substring guard, and ordering remains the same shortest-name-then-path ordering
used by the PGlite query. Schema upgrades backfill both sidecar tables from
existing `file_records`. This is intentionally not a general native-FTS
replacement; grep and hybrid search now use primary-store gram indexes, while a
separate native FTS search-index store remains a future option if Tantivy
ranking/snippet semantics become required.

Remaining live-query replacement gaps: `use-cross-root-cost` and
`use-om-segment-row` currently rely on one-shot Turso snapshots without an
explicit invalidation trigger. They need event-driven refresh tokens tied to the
write paths that change their data, not polling and not a PGlite live-query
fallback.

### 3. Background Indexing And Embedding Host

The hidden embedding host now reaches Turso through the desktop embedding worker
storage adapter and owner IPC paths. Keep new work on that owner-mediated path:
renderer workers must not construct independent Turso job queues or bypass the
DB host.

Known production touchpoints:

- `apps/desktop/src/renderer/components/embedding-host-runtime.tsx`
- `apps/desktop/src/renderer/components/embedding-worker-provider.tsx`
- `packages/app-shell/src/background-indexing/workspace-collection-sync-provider.tsx`
- `packages/vector-management/src/embedding-runtime-provider.tsx`
- `packages/vector-management/src/vector-status/use-vector-queue-state.ts`
- `packages/vector-management/src/vector-status/vector-status.tsx`

Completed low-risk queue UI slices:

- `EmbeddingJobQueueTracker` and `QueueHud` use a runtime-keyed queue hook.
  Ready Turso profiles can poll read-only queue stats without opening a PGlite
  handle. User-visible retry/repair controls are routed through the
  vector-status owner-IPC action path, not through `QueueHud` itself.
- `EmbeddingRuntimeProvider` no longer calls the PGlite-only database hook to
  construct its vector queue service. It uses the generic ready DB client and
  the bootstrap runtime, constructs `JobQueue` only for PGlite, exposes Turso
  queue snapshots, and wires the desktop Turso action service only when the
  owner-IPC bridge is present.
- `useEmbeddingRuntimeController()` now treats Electron as a host-required
  runtime: if `window.electronAPI` exists but `window.embeddingHost` is missing,
  backfill/start/status/reset/stop operations fail closed instead of falling
  through to the browser/local worker path.
- `startEmbeddingWorker()` now accepts an `EmbeddingWorkerStorage` port for
  queue claim/heartbeat/complete/fail, chunk loading, model config lookup,
  embedding-set dimension lookup, and stats refresh scheduling. The default
  storage remains PGlite-backed and preserves the current behavior; a focused
  worker test proves the worker can process a job through injected storage with
  no raw PGlite database handle.
- PGlite-family clear/re-embed prerequisites are aligned with Turso effective
  embedding-set membership: direct chunk set IDs still win, and chunks with
  null `file_chunks.embedding_set_id` inherit from `file_records.embedding_set_id`
  for PGlite, Electron IPC, and Drizzle `clearEmbeddingsForSet()` coverage/stats
  paths. This prevents stale inherited embeddings from surviving the upcoming
  clear-then-backfill re-embed composition. All repository clear paths now
  fail before clearing chunks when the requested embedding set does not exist,
  instead of reporting a clear with no refreshed stats row.
- Shared PGlite collection stats refresh and active live-count queries use the
  same effective membership predicate, so later background refreshes cannot
  overwrite repository-correct inherited chunk counts with direct-only zeroes.
- PGlite-family embedding-set deletion now matches Turso's effective membership
  cleanup: deleting a set removes direct chunks and inherited chunks whose file
  record points at the deleted set, clears the file-record embedding metadata,
  and refuses cleanup when the set does not exist.

User-visible Turso re-embed is now composed as clear-embeddings through the DB
owner IPC followed by backfill through the existing embedding runtime
controller. Keep that split: preserve the hidden-renderer worker boundary, do
not move backfill into the vector queue DB action channel, and do not construct
`TursoJobQueue` in the visible renderer.

### 4. Assistant Search And Retrieval

The assistant's grep, vector retrieval, and lexical hybrid search surfaces now
have Turso runtime paths. The remaining search work is narrower: keep native
Tantivy-style FTS snippets/ranking as a separate search-index-store decision
instead of treating it as a blocker for current primary-store search parity.

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
- `TursoFileChunkRepository.fullTextSearch()` now provides a Turso-compatible
  lexical source for hybrid search and DB Explorer search by querying
  `file_chunk_content_grams` plus `file_chunk_content_index`. It is not native
  Tantivy FTS: it uses indexed gram candidates, exact normalized substring
  checks, deterministic relevance scoring, optional HTML-escaped `<mark>`
  snippets, and explicit errors for unsupported PostgreSQL-only language or
  rank-normalization options.

Remaining search decisions:

1. Keep assistant retrieval tools gated by the repository capabilities and
   bootstrap reports that now prove Turso grep/vector support.
2. Decide whether the current primary-store lexical implementation is enough
   for product search quality, or whether native Tantivy FTS ranking/snippets
   still justify a split search-index owner described in
   `docs/turso-migration/search-index-architecture.md`.

### 5. Mastra Memory And Assistant Persistence

The desktop assistant server now selects Turso Mastra memory when the ready
runtime/bootstrap verdict is Turso. This path preserves the live Mastra loop:
tool approval suspend/resume, message hydration, run events, local-provider
desktop persistence, and stream resilience stay on the same server-side runtime
contract.

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
- `apps/desktop/src/db-main.ts`
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
- Embedding worker storage now has a Turso adapter that satisfies the
  storage-neutral worker port created in the previous slice. It composes
  `TursoJobQueue` for claim/heartbeat/complete/fail semantics, asserts claimed
  jobs carry non-empty lease tokens before the worker sees them, loads chunks
  and model metadata with SQLite-shaped SQL, resolves embedding-set dimensions,
  verifies Turso vector readiness with `vector32`, and refreshes
  `collection_indexing_stats` through the shared `@brainstrike/db` Turso stats
  service.
- The hidden renderer embedding host now selects desktop Turso worker storage
  when the DB provider exposes a ready Turso execution client. Queue and stats
  mutations are delegated to the main DB host over explicit IPC operations so
  claim/heartbeat/complete/fail and stats refresh run on the query-capable Turso
  owner client instead of the renderer's exec-only transaction adapter.
- Turso bootstrap recovery now matches the existing PGlite recovery boundary
  for narrow corruption signals without widening internal/I/O failures into
  profile resets.

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

`db:clearAll` is a separate SQL-only live-handle data clear path. It is not the
barrier-coordinated factory reset/profile cleanup path and must not be cited as
proof that runtime-owned profile files or future sidecars were removed.

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

Preferred next slice: keep PGlite-specific files until the final runtime removal
pass; premature cleanup would break current PGlite-mode tests and web paths
without advancing Turso parity.

## Historical Implementation Order

The original implementation order was collection/import, assistant memory,
search, live-query strategy, reset/maintenance, then final runtime audit. Most
of those slices have landed. Keep the remaining work focused on runtime-removal
audits, web/runtime ownership decisions, native FTS snippet/ranking decisions,
and stale PGlite-only surfaces that no longer serve a supported runtime.

## Verification Policy

Each implementation PR should include:

- A failing Turso-specific test before production code.
- Targeted package tests for the touched surface.
- `pnpm lint && pnpm type-check && pnpm build && pnpm test` before push.
- PR watcher loops for checks, comments, and independent review.
- Merge back into `feature/turso-migration` only after latest-head checks are
  green and all blocking comments are answered/resolved.
