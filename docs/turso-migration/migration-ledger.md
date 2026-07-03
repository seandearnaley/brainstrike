# Turso Migration Ledger

Last updated: 2026-07-03 on `codex/turso-browser-runtime-audit-20260703`,
targeting `feature/turso-migration`.

This ledger is the working map for finishing the greenfield migration from
PGlite to Turso. It is not a go/no-go memo. Treat the "Remaining Work" section
as the implementation backlog.

## Current Branch State

`feature/turso-migration` currently contains merged Turso migration slices
through #1463 at `790249e5`. The branch migrates the web Vite Node server's
Mastra workflow-storage singleton to embedded Turso. Desktop fresh profiles use
the Turso runtime by default when `BRAINSTRIKE_DB_RUNTIME` is unset, while
preserving existing desktop PGlite profiles when `<profile>/pgdata` already
exists. Explicit desktop PGlite compatibility remains available with
`BRAINSTRIKE_DB_RUNTIME=pglite`, explicit Turso remains available with
`BRAINSTRIKE_DB_RUNTIME=turso`, and browser/client DB storage still owns the
PGlite worker path until a separate browser-runtime decision replaces it.

Merged slices:

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
- #1416 `docs(turso): refresh migration wording`
- #1417 `fix(desktop): skip dimension probe for turso startup`
- #1418 `Route Turso manual imports through managed cache`
- #1419 `Batch background cache removals for Turso`
- #1420 `Make index debug SQL portable for Turso`
- #1421 `Fail closed on managed cache apply errors`
- #1422 `fix(db-explorer): gate import queue on runtime client`
- #1423 `fix(app-shell): gate file search on live-query capability`
- #1424 `Use live-query capability in db explorer hooks`
- #1425 `Route Turso queue owner requests through DB host`
- #1426 `Fix Turso DB Explorer collection snapshot mode`
- #1427 `Surface Turso vector queue action failures`
- #1428 `Clear stale Turso schema readiness`
- #1429 `Make Turso retry failed queue action atomic`
- #1430 `Guard Turso background imports behind atomic enqueue`
- #1431 `Mark DB execution runtime explicitly`
- #1432 `Require explicit desktop Turso readiness seams`
- #1433 `Guard PGlite-gated hook imports`
- #1434 `Route desktop token cache through runtime store`
- #1435 `Resolve DB Explorer search metadata through repositories`
- #1436 `Stop DB Explorer panel using PGlite DB hook`
- #1437 `Gate visible embedding worker by runtime`
- #1438 `Use live-query capability for collection selector`
- #1439 `Move schema readiness into db capability hook`
- #1440 `Report ready Turso runtime status`
- #1441 `Expose runtime execution DB client hook`
- #1442 `Gate tools settings live queries by capability`
- #1443 `Fix model registry toggle SQL by runtime`
- #1444 `Add Turso snapshot invalidation triggers`
- #1445 `Add Turso Mastra vector memory store`
- #1446 `Retire raw queue purge helper`
- #1447 `Prove Turso clear-all path`
- #1450 `Retire unregistered hybrid search assistant wrapper`
- #1451 `Label Turso queue work for profiling`
- #1452 `Add Turso queue profile verdict`
- #1453 `Prove Turso queue topology`
- #1454 `Prove sustained Turso queue profiling`
- #1455 `Add Turso Mastra vector profile benchmark`
- #1456 `Profile Turso lexical search quality`
- #1457 `Fix Turso enhanced import SQL dialect`
- #1458 `Default desktop runtime to Turso`
- #1459 `docs(turso): neutralize stale runtime wording`
- #1460 `fix(turso): harden runtime SQL seams`
- #1461 `test(turso): guard live query consumers`
- #1462 `test(turso): guard pglite import inventory`
- #1463 `feat(web): use Turso for web Mastra storage`

Recently completed web-server Mastra storage slice: #1463 moves
`apps/web/src/server/web-mastra-storage.ts` off direct PGlite construction and
onto a temp embedded Turso profile opened through the shared Turso owner client.
The singleton still has process lifetime, so suspended web tool-approval
snapshots survive separate HTTP requests in the same Vite server but do not
silently become durable across server restarts. The focused web test now asserts
real Turso `TursoMemoryStore`, `TursoVectorStore`, and `TursoWorkflowsStore`
instances, and the import guardrail rejects both direct `@electric-sql/pglite*`
imports and the PGlite Mastra memory factory from the web server storage file.

Recently completed import-inventory guardrail slice: #1462 added
`packages/db/__tests__/architecture-pglite-import-guardrails.test.ts`. The test
scans production `apps/` and `packages/` TypeScript sources for direct
`@electric-sql/pglite*` imports, requires every file to be explicitly
allowlisted with an owner and reason, and pins the expected PGlite package
specifiers per file. This does not remove PGlite; it turns the final dependency
audit into a controlled inventory so new direct imports cannot appear without
review.

Recently completed live-query guardrail slice: #1461 added
`packages/db/__tests__/architecture-turso-live-query-guardrails.test.ts`. The
test scans production `apps/` and `packages/` source for root-barrel named
`useBrainstrikeLiveQuery` imports from `@brainstrike/db` and requires every
consumer to stay policy-classified with concrete Turso-safe markers: direct
live-query capability gates, explicit PGlite/Turso runtime snapshot splits, or
provider-owned live-query metric flags paired with repository snapshots. This
turns the 2026-07-03 manual live-query sweep into an executable regression
guard before the final PGlite dependency/removal audit. If the hook later gains
namespace or subpath import surfaces, the guardrail must be tightened in the
same PR that adds those surfaces.

Recently completed runtime-SQL hardening slice: #1460 turned the
final-runtime-audit follow-up into concrete behavior checks. The shared
embedding-set metadata helper now has an explicit SQL dialect so Turso metadata
create/read/repair queries use SQLite `?` placeholders while PGlite/Drizzle
keep PostgreSQL `$n` placeholders. SQLite `no such table: models` metadata
registry absence is classified with the same fallback behavior as PostgreSQL
`42P01`. Desktop assistant edit re-indexing now fails closed when a
Turso-marked DB handle lacks the injected DB-host managed-cache applier, rather
than falling through to the PostgreSQL-shaped standalone managed-cache
implementation.

Recently completed stale-wording cleanup slice: #1459 refreshed this ledger
through #1458/default-runtime state and neutralized stale PGlite-only comments
on supported Turso runtime paths, including DB-host owner transactions, grep
candidate wording, renderer runtime comments, token-cache wording, quick-open
repository comments, assistant memory aggregate-count wording, and the
primary-store lexical search architecture note.

Recently completed default-runtime slice: #1458 made unset desktop runtime
selection default fresh profiles to Turso while preserving existing PGlite
profiles that already contain `<profile>/pgdata`. Reset now bypasses the
existing-profile preservation gate, so an unset-runtime reset of a former
PGlite profile recreates the fresh Turso default profile directory instead of
manufacturing an empty `pgdata` directory.

Recently completed final-runtime-audit slice: #1457 fixed the enhanced manual
import Turso SQL dialect leak found during the final runtime audit:
`runEnhancedImport` now emits SQLite/Turso `?` placeholders for Turso metadata
and embedding-set SQL while retaining the existing PGlite/PostgreSQL-shaped
statements for PGlite.

Recently completed lexical-quality profile slice: #1456 added a real-engine
primary-store gram lexical search-quality profile for the current Turso
repository path. The profile seeds a tiny code-search corpus into a real Turso
owner client, verifies exact query relevance metrics, proves real hybrid search
still uses the repository lexical source, checks query-plan evidence for gram
sidecars, and writes the durable report
`docs/turso-migration/2026-07-03-turso-lexical-search-quality-profile.md`.
It deliberately characterizes the current non-FTS gram path rather than adding a
split native Tantivy search-index store.

Recently completed Mastra vector profile slice: #1455 added the real-engine
Mastra Turso vector exact-scan benchmark harness and CLI:
`pnpm --filter @brainstrike/agent run bench:turso-vector-memory`. The harness
seeds deterministic vectors into the current `TursoVectorStore`, compares query
results against a deterministic JavaScript scorer, records compact query timing
and `EXPLAIN QUERY PLAN` evidence, and writes the durable report
`docs/turso-migration/2026-07-03-turso-mastra-vector-exact-scan-baseline.md`.
It deliberately characterizes the current exact-scan path rather than adding a
native ANN/vector-index schema rewrite.

Recently completed queue profile slice: the sustained Turso queue-profile E2E
lane is merged in #1454. It runs `BRAINSTRIKE_DB_RUNTIME=turso`, seeds a real
Turso embedding set/file/chunk fixture with SQLite placeholders, starts the
hidden embedding host backfill path, issues repeated foreground-labeled DB
probes while set-scoped backfill jobs are still queued or running, and requires
`desktopDiagnostics.tursoQueueProfile` to reach `accepted` with hidden-worker
owner labels and foreground wait metrics below threshold.

Recently completed reset slice: desktop reset now removes the whole active
profile directory for both runtimes, then recreates the runtime-owned empty
directory: explicit PGlite reset recreates `<profile>/pgdata`; Turso and unset-runtime reset recreate only `<profile>`.

Independent audit artifact status: `docs/turso-migration/2026-07-02-independent-audit-report.md`
is not tracked in this branch at feature head `2d1777864` through the 2026-07-03
reconciliation pass. Do not cite that report as reconciled work until the
artifact is restored or this ledger links to the correct audit artifact.

Ledger reconciliation pass (2026-07-03): compared this ledger with
`git log --first-parent origin/feature/turso-migration` and
`gh pr list --base feature/turso-migration`; the merged-slice list now includes
#1416 through #1440, which were landed on the feature branch but missing from a
prior ledger pass. The remaining-work sections below should not re-list those
slices as TODO unless they name a concrete follow-up still absent from code.

Ledger reconciliation checkpoint (2026-07-03, post-#1462 branch): the
`db:clearAll` real-engine proof is now merged, not a separate future slice. The
raw queue purge helper removal, live-query sweep, Turso vector memory parity,
reset-directory recreation, and assistant `brainstrike.hybridSearch` wrapper
retirement should stay out of the remaining backlog except where the ledger
names a narrower follow-up. Queue profiling now has owner QoS
labels/priorities for hidden worker paths plus a desktop diagnostics verdict
surface for foreground/background evidence, and the sustained hidden-worker
profile proof is merged. #1455 also adds exact-scan Mastra vector-memory
characterization: 5,000 rows x 384 dimensions, 12 measured queries, exact top-K
match 12/12, recall@K 1.000, query p95 30.411 ms, with query-plan evidence in
`docs/turso-migration/2026-07-03-turso-mastra-vector-exact-scan-baseline.md`.
#1456 adds lexical search-quality characterization on top of that state:
precision@5 0.400, recall@5 1.000 for the tiny seeded corpus, plus query-plan
evidence that gram sidecars supply the lexical candidate source. #1457 fixed the
enhanced manual-import SQL dialect leak for Turso metadata and embedding-set
paths. #1458 made fresh unset-runtime desktop profiles default to Turso while
preserving existing PGlite profiles and keeping reset on the fresh Turso default.
#1459 neutralized the stale runtime wording found in the final-pass audit.
#1460 narrowed the remaining generic SQL audit: chunking-host load-by-id, local
semantic recall dimension lookup, and workspace-root loading are not current
Turso-default bugs because they route through the owner DB host and libSQL
accepts their `$1` bindings; the real fixes were explicit metadata SQL dialect
generation, SQLite missing-models-table classification, and fail-closed Turso
re-index fallback behavior. #1461 codified the production live-query consumer
sweep as an architecture guardrail so new root-barrel named imports of
`useBrainstrikeLiveQuery` cannot enter the feature branch unclassified. #1462
codified the direct production PGlite import inventory, making every remaining
direct `@electric-sql/pglite*` import explicit and owned before the final
dependency-removal pass.
The verified remaining backlog is now:

- product search-quality decision for primary-store gram lexical search versus
  a split native Tantivy search-index owner;
- explicit reset targets only if future Turso sync or split-search stores live
  outside the active profile directory;
- final PGlite dependency/removal audit after browser-runtime ownership and
  explicit desktop PGlite compatibility decisions;
- follow-up stale wording cleanup only for future surfaces found after the
  final PGlite dependency/removal audit.

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

## Browser Runtime Ownership Decision

Current browser/client DB storage remains PGlite-backed by design. This is not
a Turso parity gap being hidden behind a fallback; it is an explicit runtime
ownership boundary for the web/browser build. Browser storage today is a local
PGlite worker path using `idb://` / OPFS-AHP persistence, and the web startup
smoke still proves that `pglite-worker-entry` owns the browser database worker.

The current official Turso TypeScript docs do not provide an equivalent
browser-local embedded database surface:

- `@tursodatabase/database and @tursodatabase/sync are not browser-local storage replacements`.
  The TypeScript reference presents both as native local-file packages; the
  compatible environments listed there are Node.js, Deno, Cloudflare Workers,
  and Netlify/Vercel Edge Functions, not a normal browser tab with IndexedDB or
  OPFS ownership.
- `@tursodatabase/serverless is a remote fetch client, not a local-first browser database`.
  It is browser-compatible because it uses `fetch`, but adopting it for the
  client DB would turn latency-critical local writes into remote Turso Cloud
  requests and would require credentials, auth, offline, privacy, and sync
  product decisions that this migration has not made.
- `@libsql/client/web` cannot open local file URLs, and embedded replicas only
  work where the runtime has filesystem access. That rules out treating
  libSQL's browser/web subpath as a drop-in local replacement for the current
  browser PGlite worker.

Release implication: do not import Turso/libSQL database clients into browser
DB bundle entrypoints, and do not replace the browser PGlite worker with a remote
serverless client as a silent compatibility shim. A future browser Turso path
must be a named product/runtime mode with explicit user-facing semantics:
remote-only, server-backed, or a future Turso-supported browser-local engine.
It must include bootstrap readiness, reset/backup/sync ownership, credential
handling, offline behavior, and tests before it can retire browser PGlite.

`The final PGlite dependency-removal pass is blocked until browser-local storage has a supported Turso replacement or browser support is explicitly dropped`.
Until then, PGlite packages, Vite aliases, the browser worker entry, and
browser reset cleanup remain supported code rather than removable residue.

## Implemented Runtime Shape

The branch currently has a real Turso runtime seam:

- Desktop runtime selection defaults empty profiles to Turso when
  `BRAINSTRIKE_DB_RUNTIME` is unset. If the active desktop profile already has a
  PGlite `pgdata` store, unset runtime selection preserves PGlite until the user
  explicitly selects Turso or a real data migration/import path exists.
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
- Queue-profiling work now carries operation labels and structured priorities
  into owner-client diagnostics for Turso `TursoJobQueue` operations, hidden
  embedding-worker queue/stats DB-host requests, visible vector queue owner
  actions, generic foreground `query`/`exec` DB-host work, and renderer IPC
  query/exec calls. Desktop platform diagnostics now expose
  `tursoQueueProfile`, a verdict derived from the scheduler snapshot plus Turso
  owner QoS. Status is `accepted` only when both foreground and background work
  have been observed and foreground waits stay below the configured threshold;
  `blocked` names the foreground labels queued behind background owner work or
  exceeding the foreground wait threshold; and `insufficient-evidence` keeps an
  idle or one-sided sample from being mistaken for release proof.
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
  operations during manual or e2e profiling. #1453 adds deterministic unit and
  opt-in Electron E2E proof that the diagnostics surface can observe real
  background Turso queue work, foreground DB work, and the hidden embedding
  host's Turso provider initialization, and it refuses to accept a queue profile
  without Turso owner QoS activity. This branch extends that coverage with an
  opt-in sustained Electron E2E lane that starts a real hidden-host Turso
  backfill, sends repeated foreground-labeled DB probes while set-scoped
  backfill jobs are still queued or running, and requires the queue profile to
  reach `accepted` with foreground waits below threshold. If future manual,
  release-candidate, or e2e profiling observes foreground owner work queued
  behind background work at or above the threshold, or foreground DB work
  repeatedly waiting more than 1000ms behind background/embedding operations,
  reopen the separate Turso connection design before release.
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
- Keep production `useBrainstrikeLiveQuery` consumers classified behind a
  concrete capability gate, runtime split, or provider-owned snapshot path.
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
for ready PGlite and query-capable Turso runtimes. The hook returns the runtime
engine and explicit SQL capability metadata (`postgres` plus Postgres-only
features for PGlite, `sqlite` plus Turso baseline features for Turso), and
returns `null` unless the ready provider handle has query, exec, and callback
transaction capabilities. Electron-hosted Turso currently returns `null` on
purpose: renderer-facing Turso mutations must go through repository/bootstrap
capabilities or explicit owner-IPC action surfaces, not a raw callback-style SQL
client. Consumer migrations should use this hook only when they truly need a
generic execution client; do not use it to infer runtime readiness, live-query,
vector, grep, or FTS availability. Those capabilities remain
schema-readiness-, repository-, or bootstrap-gated.

Provider guardrail: future generic SQL consumers should use
`useBrainstrikeExecutionDbClient()` only where the runtime actually exposes a
query-capable execution client, or use a concrete repository capability when
Electron-hosted Turso owns the SQL path. Callers must not treat "raw DB handle"
as "PGlite". Vector, FTS, and grep methods on the chunk repository must stay
capability-gated by the concrete repository and bootstrap proofs instead of a
raw database-handle assumption.

Residual provider cleanup from the 2026-07-03 audit:

- `DbProvider.clearQueuesAndEmbeddingSets` has been retired. The helper sent
  raw Electron SQL and soft-failed around the explicit owner-action pattern used
  by Turso vector queue mutations; the 2026-07-03 audit found no production
  consumer beyond the exported hook/tests. Queue operations now stay on the
  scoped queue service/repository paths, and embedding-set deletion stays on the
  embedding-set repository path.

Model-registry toggle writes now use a runtime-specific SQL helper instead of
depending on dialect lenience. PGlite keeps the existing Postgres-shaped `$1`
placeholder and boolean parameter path; Turso and libSQL emit SQLite-compatible
`?` placeholders with integer booleans. UI callers pass the provider bootstrap
runtime into the toggle action before the store can mutate durable rows. Keep
future model-registry writes on that explicit runtime-authored path, and keep
unsupported runtimes rejected instead of guessing a dialect.

### 2. UI Snapshot Replacements For Live Queries

PGlite live queries are not part of the Turso runtime. Any UI still depending
on `useBrainstrikeLiveQuery` needs either:

- a repository-backed snapshot loader with explicit refresh triggers, or
- an explicit unsupported state with diagnostics if live updates are required.

Known production touchpoints:

- `packages/db-explorer/src/database-demo-panel.tsx`
- `packages/db-explorer/src/use-database-demo-data.ts`
- `packages/db-explorer/src/hooks/use-document-count.ts`
- `packages/db-explorer/src/hooks/use-file-collection-status.ts`
- `packages/db-explorer/src/hooks/use-collection-embedding-coverage.ts`
- `packages/preferences/src/settings/tools/unified-tools-settings.tsx`
- `packages/app-shell/src/use-quick-open-files.ts`
- `packages/app-shell/src/use-file-mentions.ts`
- `packages/app-shell/src/cost-tracking/use-cross-root-cost.ts`
- `packages/app-shell/src/use-om-segment-row.ts`
- `packages/vector-management/src/collection-select/collection-select.tsx`
- `packages/vector-management/src/vector-status/use-vector-queue-state.ts`

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

Cross-root durable usage and OM segment rows now have explicit Turso snapshot
invalidation instead of one-shot reads. Durable usage dispatches a workspace
usage invalidation only after `recordRunUsage()` resolves. OM rows refresh when
the renderer receives a completed observational-memory write run event from the
real assistant stream (`Observations updated`, `Buffered observations updated`,
or `Buffered observations activated`) and derives the active thread/resource
lookup key. The hooks still keep PGlite on live queries and Turso on event-driven
repository/SQLite snapshots; no polling or live-query fallback is introduced.

Latest live-query sweep (2026-07-03): production `useBrainstrikeLiveQuery`
references under `apps/` and `packages/` are either the package-owned live-query
implementation/tests, PGlite-only live query paths paired with Turso repository
snapshot readers, or explicit fail-closed capability gates. No additional
unmapped production live-query consumer was found in this pass. #1461 codifies
the production consumer list and policy markers so new root-barrel named
live-query usage cannot enter the Turso feature branch silently.

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
- Turso embedding-worker queue/stats requests, vector queue owner actions,
  generic foreground `query`/`exec` DB-host requests, and renderer-facing
  `window.electronAPI.db.query()` / `exec()` probes now carry
  `DatabaseWorkOptions` labels and priorities through desktop IPC,
  `DbHostManager`, DB-host protocol messages, and the Turso owner client.
  Profiling can now compare scheduler priority snapshots with owner-client QoS
  labels/priorities for the same foreground/background workload, and
  `desktopDiagnostics.getSnapshot().tursoQueueProfile` summarizes the result.
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
2. The current primary-store lexical implementation remains the Turso migration
   path for parity, backed by
   `docs/turso-migration/2026-07-03-turso-lexical-search-quality-profile.md`.
   Native Tantivy FTS remains a split search-index-owner decision only if product
   search quality or release profiling requires behavior the gram path cannot
   honestly provide.
3. The assistant `brainstrike.hybridSearch` native-tool wrapper is retired on
   this branch because it was never registered in the desktop assistant tool
   surface or assistant contract registries. Hybrid search remains an internal
   DB/UI service. A future model-facing hybrid tool should be a new desktop
   adapter with explicit Turso capability gates, not a revival of the stale
   package-level helper.

#### Turso Lexical Search Decision Boundary

Brainstrike's current Turso lexical path remains primary-store gram search, not
native Tantivy FTS. The primary Turso store is the durable MVCC application
store. Grep, DB Explorer content search, and hybrid lexical search use generated
content gram sidecars plus exact normalized-content checks, gated by
`search.grep-content-grams`; quick-open filename lookup uses `file_record_name_grams`
and `file_record_name_index` through the file-record repository's indexed
name-substring capability; it is not gated by the content grep capability.

Current Turso docs document a real Tantivy FTS surface: `CREATE INDEX ... USING
fts`, `fts_match`, `fts_score`, `fts_highlight`, per-column tokenizers including
`ngram`, field weights, phrase/prefix/boolean/column/boost query syntax, and
automatic DML index updates. They also document limitations: no snippet
function, manual `OPTIMIZE INDEX`, no read-your-writes for FTS inside an open
transaction, and no `MATCH` syntax.

Those docs do not by themselves justify moving Brainstrike search into native
FTS. The local capability spike still proves the relevant architecture boundary
for this branch: native FTS works in a non-MVCC Turso database, but same-file FTS
custom indexes fail under the MVCC primary store. Until a current real-engine
probe proves FTS custom indexes work inside the MVCC primary store, native
Tantivy FTS must not be routed through the primary store.

Split native FTS/search-index ownership is triggered only if product search
quality requires native FTS behavior that the gram path cannot honestly provide:
BM25 ranking as a first-class quality signal, field weighting, Tantivy query
syntax, tokenizer-specific behavior, engine-owned highlighting, or
search-quality evaluation showing primary-store gram ranking/snippets are
insufficient. It is also triggered if primary-store gram sidecars create
unacceptable write amplification, storage growth, or foreground DB contention in
release profiling.

If split FTS is adopted, the search-index store must be explicitly owned as
rebuildable derived state. It must have bootstrap checks, reset/backup/sync
ownership, rebuild/reconciliation rules, freshness diagnostics, and failure
behavior that fails closed instead of falling back to scans. A non-MVCC FTS
store should not be treated as attached to the MVCC primary store unless current
Turso docs/runtime prove the journal-mode and ownership model support that shape.

### 5. Mastra Memory And Assistant Persistence

The desktop assistant server now selects Turso Mastra memory when the ready
runtime/bootstrap verdict is Turso. This path preserves the live Mastra loop:
tool approval suspend/resume, message hydration, run events, local-provider
desktop persistence, and stream resilience stay on the same server-side runtime
contract.

Known production touchpoints:

- `apps/desktop/src/assistant-server.ts`
- `packages/agent/src/pglite-mastra-memory`
- `packages/agent/src/turso-mastra-memory`
- `packages/app-shell/src/assistant-memory-repository.ts`
- `packages/app-shell/src/assistant-ui-panel-wrapper.tsx`
- `packages/app-shell/src/threads-panel.tsx`
- `packages/app-shell/src/assistant-thread-tabs-workspace.tsx`

Concrete status and remaining work:

- `TursoMemoryStore` and `TursoWorkflowsStore` now exist under
  `@brainstrike/agent/turso-mastra-memory`, with SQLite-compatible schema,
  thread/message/resource persistence, non-vector observational memory, and
  workflow snapshots.
- `TursoVectorStore` now exposes the Mastra vector contract under
  `@brainstrike/agent/turso-mastra-memory`. It stores embeddings as Turso
  `vector32(?)` BLOBs in the shared `mastra_vectors` table, keeps the same
  sentinel-row index metadata model as `PgliteVectorStore`, supports equality,
  `$eq`, `$in`, `$and`, and Mastra recall timestamp comparison filters
  (`$lt`/`$lte`/`$gt`/`$gte`) on metadata, returns high-score-is-better
  cosine/euclidean/dot-product results, and emits the same nonblocking
  semantic memory run events. Real Turso-engine tests cover cosine, euclidean,
  dot-product ranking, and `observed_at` recall windows, and fail closed if
  persisted metadata names an unsupported metric.
- The Turso factory now passes the vector store to `Memory`, so semantic recall
  and observational vector retrieval can run when an explicit embedder is
  configured. Those paths still fail closed with deterministic configuration
  errors when vector-enabled memory is requested without an embedder.
- `PgliteVectorStore` creates `vector` extension, `embedding vector`, JSONB,
  and GIN indexes. `TursoVectorStore` intentionally uses exact vector-distance
  ordering for Mastra memory parity in this slice; native vector index/ANN
  tuning remains a separate performance decision once real memory volume
  requires it. The Turso vector memory schema is also lazily owned by the
  Mastra memory store rather than the profile bootstrap baseline; keep that
  ownership explicit unless release readiness requires bootstrap-level vector
  schema proof.
- The renderer thread repository still contains separate PGlite and Turso read
  query dialects. Current tests cover the major Turso read surfaces: latest-run
  listing, message hydration, usage aggregation, thread metadata, and thread
  CRUD. Future centralization should keep equivalent dialect-specific coverage.
  The current shared helper owns only run-event append and terminal run-status
  writes.

Completed slices have wired the desktop assistant server to select the Turso
factory from the ready runtime/bootstrap verdict, included runtime/profile/store
identity in the memory cache key, replayed live-loop persistence against Turso,
and, on this branch, added Turso vector memory parity for Mastra semantic
recall/observational vector retrieval. This branch adds exact-scan performance
characterization for the same path: the benchmark seeds 5,000 deterministic
384-dimensional rows, validates Turso results against an independent scorer,
and records p50/p95/max query timings plus query-plan evidence. Native Turso
vector indexes remain a separate release decision only if expected profile sizes
push exact-scan latency beyond the team budget.

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

Concrete status and authority boundaries:

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
recreates the fresh runtime-owned empty directory: explicit PGlite recreates
`<profile>/pgdata`, while Turso and unset-runtime reset recreate only
`<profile>`. Reset intentionally does not apply the existing-`pgdata`
profile-continuity gate, because that gate protects pre-reset data and must not
manufacture an empty PGlite store that pins a reset profile back to PGlite.

No production Turso sync/search metadata path currently exists outside the
profile directory. Future out-of-profile sync or search stores must be added as
explicit named reset targets with tests; do not delete guessed names such as
`.sync`, `sync`, or `${primary}.fts.db`.

`db:clearAll` is a separate SQL-only live-handle data clear path. It is not the
barrier-coordinated factory reset/profile cleanup path and must not be cited as
proof that runtime-owned profile files or future sidecars were removed.
Real-engine Turso coverage now exercises this path against the production
desktop IPC handler and a real Turso owner client. The test seeds file records,
chunks, roots, embedding sets, collection stats, embedding jobs, selection
snapshots, assistant run usage, and the Turso grep/quick-open sidecar tables;
then it proves `db:clearAll` returns the deleted file/chunk counts and clears
the seeded rows, with sidecars removed by foreign-key cascades. The same test
surface also drops an optional Turso table and verifies SQLite `no such table`
errors are treated as missing optional relations, matching the existing
Postgres `42P01` handling.

Known production touchpoints:

- `packages/preferences/src/settings/system/factory-reset-helpers.ts`
- `packages/preferences/src/settings/system/factory-reset-panel.tsx`
- `apps/desktop/src/db-main.ts`
- `apps/desktop/src/desktop-reset-platform.ts`

Remaining reset follow-up: add explicit reset targets if a future Turso sync or
split-search implementation creates stores outside the active profile directory.

### 8. Dependency And Build Cleanup

PGlite packages, Vite aliases, type shims, and WASM packaging remain necessary
while browser/PGlite and explicit desktop compatibility paths exist. Final
removal should happen only after the runtime audit proves no supported
production path imports PGlite.

Current direct PGlite import guardrail: #1462 added
`packages/db/__tests__/architecture-pglite-import-guardrails.test.ts`, and this
branch removes web server Mastra storage from that allowlist. The test scans
production `apps/` and `packages/` TypeScript sources for direct
`@electric-sql/pglite*` imports, requires every file to be explicitly
allowlisted with an owner and reason, pins the expected PGlite package
specifiers per file, and rejects the PGlite Mastra memory factory from web
server storage.

Known production touchpoints:

- `apps/desktop/package.json`
- `apps/desktop/vite.config.mts`
- `apps/web/package.json`
- `apps/web/vite.config.mts`
- `packages/db/src/wasm-loader.ts`
- `packages/build-utils`
- `apps/desktop/src/types/pglite*.d.ts`

Preferred next slice: keep PGlite-specific files until the final runtime removal
pass; premature cleanup would break current explicit PGlite-mode tests and
browser storage paths without advancing Turso parity.

Stale wording cleanup is a final-pass task after release decisions are made.
Do not repeat already-closed wording items from #1459/#1460 unless a fresh
current-code audit finds a new stale surface.

## Historical Implementation Order

The original implementation order was collection/import, assistant memory,
search, live-query strategy, reset/maintenance, then final runtime audit. Most
of those slices have landed. Keep the remaining work focused on runtime-removal
audits, browser/runtime ownership decisions, explicit desktop PGlite
compatibility decisions, native FTS snippet/ranking decisions, and stale
PGlite-only surfaces that no longer serve a supported runtime.

## Verification Policy

Each implementation PR should include:

- A failing Turso-specific test before production code.
- Targeted package tests for the touched surface.
- `pnpm lint && pnpm type-check && pnpm build && pnpm test` before push.
- PR watcher loops for checks, comments, and independent review.
- Merge back into `feature/turso-migration` only after latest-head checks are
  green and all blocking comments are answered/resolved.
