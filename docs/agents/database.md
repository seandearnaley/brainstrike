# Database: Model Catalog Migrations, PGlite Extensions, First-Run Bootstrap

> Extracted from AGENTS.md (2026-07-12). Read before adding migrations, models, PGlite construction sites, or touching browser bootstrap. Keep updated with the code.

## QUERY TELEMETRY BOUNDARY

Database performance instrumentation uses the typed, memory-only collector in
`packages/db/src/database-query-telemetry.ts`. Feature ownership is declared at
the call site; never classify queries by parsing SQL or parameters. Producers
may record duration/failure counts, live subscription/update counts, and token
lookup/hit totals only. SQL, parameters, rows, paths, filenames, queue names,
and content are prohibited. The collector rejects unsupported runtime record
keys and materializes retained samples from an explicit field allowlist, so an
untyped caller cannot smuggle caller data into the in-memory buffer.
Per-feature query arrivals use their own bounded rolling count buckets, separate
from the capped duration samples used for percentiles. `queryCount` and
`queriesPerMinute` therefore report bounded-bucket rolling executions above the
sample cap, while top-level `sampleCount` reports retained percentile inputs and
`droppedSampleCount` exposes overflow.
`docs/diagnostics-privacy-contract.md` is the cross-cutting privacy authority.

The in-renderer live-query scheduler and Electron live-query bridge both wrap
creation/refresh and listener lifecycle; the single embedding queue poller wraps
its stats read. The production `@brainstrike/token-cache` store exposes a narrow
lookup telemetry port that the file-explorer composition layer wires to this
collector, avoiding a package dependency back to `@brainstrike/db`. File-record
read methods report the coarse `file-tree` feature, including full and
metadata-only managed-cache listings on both repository implementations. Keep
these seams and their paired tests aligned when a query path moves.

The pinned PGlite 0.5.3 live-query implementation marks a handle dead before its
unsubscribe transaction settles. Scheduler instrumentation must therefore release
all local listener ownership on the first teardown attempt and reject later
subscribe, refresh, or unsubscribe calls on that handle; a caller that wants to
continue must create a fresh live-query handle. Do not add same-handle retry or
reactivation semantics that the underlying dependency cannot honor. The collector
latches retention-clock failure per instance, logs the first producer failure,
and stops timer-driven publication without hiding the failure at explicit snapshot
read boundaries.

## MODEL CATALOG MIGRATIONS (CRITICAL)

Adding, removing, or renaming a supported AI model is a multi-layer change. Updating only the static registry is NOT enough — the in-app model picker is driven by a DB-backed catalog.

When changing the model catalog:
1. Update the static registry (single source of truth):
   - packages/assistant-contract/src/provider-registry.ts
2. Add a numbered DB migration that upserts/deletes catalog rows, and register it in BOTH:
   - packages/db/src/migrations/index.ts (numbered MigrationRunner — used by tests)
   - the `customMigrations` ledger in packages/db/src/drizzle/migrate.ts (used by the real app)
   - Registering in only one means tests pass but existing users never see the change.
3. Preserve user choices on kept rows with `ON CONFLICT (id) DO UPDATE SET ... is_enabled = models.is_enabled`.
   - INVARIANT: never use `is_enabled = EXCLUDED.is_enabled` for a catalog refresh — it clobbers the user's toggle. Force on/off only for a deliberate (e.g. security) swap.
4. Remap dropped IDs in the preference stores so persisted selections don't dangle:
   - MODEL_ID_MIGRATIONS in packages/preferences/src/stores/assistant-preferences-store.ts (bump its store version)
   - MEMORY_MODEL_TARGET_MIGRATIONS in packages/preferences/src/stores/assistant-memory-preferences-store.ts (also self-heals on every rehydration)
   - The guard canonicalizes discovered migration identifiers with
     `path.posix.join` so diagnostics and downstream checks are platform-neutral.
     Its version parser still accepts `/` or `\` for direct analyzer callers and
     fixtures, preventing Windows paths from misclassifying historical deletions
     as new remap obligations.
5. Add new `packages/db/__tests__/**/*.test.{ts,tsx}` files without a lane-registry edit. The `unit` Vitest project discovers that tree recursively; required Unit and nightly coverage both supply the complete `DB_TEST_SHARD=1/2` + `2/2` set to that project, where Vitest applies its native shard. The value is a DB-task environment input, never a Turbo CLI passthrough argument. Nightly rejoins Vitest blob reports with `--merge-reports`, so coverage is one native union rather than whichever serial lane wrote last. `scripts/__tests__/db-test-discovery-contract.test.mjs` pins the recursive include, browser exclusion, nested discovery, and a minimum 150-file floor, with mutations proving each assertion can fail. The former regex manifest and its two derived lane scripts were deleted in BST-1046; do not recreate a registration map for test placement.
6. Every LLM model entry MUST declare `contextWindow` (and `maxOutputTokens` when documented) in
   packages/assistant-contract/src/provider-registry.ts — compile-enforced, static-registry-only
   (no DB migration). It drives the thread context meter and the auto-derived
   `agentLoop.inputTokenLimit` (see packages/assistant-contract/src/context-budget.ts).
7. `tagline` on a registry LLM entry is OPTIONAL, registry-only composer copy: it renders as
   the model's one-line description in the composer model menu. The DB catalog's own
   tagline/description column feeds the db-explorer surface instead — the two are separate
   sources on purpose (no migration needed for registry tagline changes). Omit rather than
   invent copy: taglineless models render name-only.
8. Every LLM model entry MUST also declare `vision` ('supported' | 'unsupported'; never
   'unknown' in the static registry — pinned by provider-registry-vision.test.ts). It gates the
   composer image-attachment affordance per selected model. Unlike `contextWindow`, this one IS
   mirrored into the DB catalog: new model rows must include `"vision"` in the capabilities
   jsonb (migration 061 backfilled existing rows), and frontier-models-migration.test.ts fails
   if any LLM row is left without a vision value.

---

## ASSISTANT THREAD GROUP PRESENTATION

Thread group structure and presentation are local-first Brainstrike state in
`brainstrike_assistant_thread_groups`, not Mastra thread metadata. Migration 056
owns group color and split flat/grouped rank; migration 059 owns the nullable,
validated group icon. The repository must reject unsupported color/icon values
at both read and write boundaries, and every new presentation column must be
registered in the numbered runner plus Drizzle's append-only
`customMigrations` ledger.

Migration 067 owns the thread hybrid-search index
(`brainstrike_thread_message_index` + `_search_profiles` + `_search_state`)
under the same Mastra-ownership ruling — no FKs to the Mastra tables, joined
by id, factory-reset-cleared except the singleton profile. Full contract:
`docs/agents/assistant-persistence.md` § THREADS PANEL HYBRID SEARCH.

Migration 068 owns complete tool-output artifact storage
(`brainstrike_assistant_tool_output_artifacts`). Content is exact UTF-8 in
`BYTEA`; callers pass hex text through PostgreSQL `decode` because
worker/Electron boundaries do not preserve a single JavaScript typed-array
realm. The table has no Mastra FKs, is scoped by resource/thread/run/tool call,
expires after seven days, and is explicitly factory-reset-cleared. Register
every change in both migration runners and keep the migration/repository/reset
tests paired with the persistence contract in
`docs/agents/assistant-persistence.md`.

Migration 076 owns terminal provider-forensics storage
(`brainstrike_assistant_run_errors`) and the hot diagnostic correlation index
`bst_diagnostic_events_run_idx`. Register it in the numbered runner and the
append-only Drizzle `customMigrations` ledger. The run-errors table is also
mirrored byte-for-byte in renderer lazy assistant bootstrap because the main
writer is reached only with a renderer-minted durable run id. It has no FK:
numbered migrations run without the lazy `brainstrike_assistant_thread_runs`
parent. The canonical repository must derive thread/resource ownership from
that parent, throw when it is absent, and preserve the first terminal row with
`ON CONFLICT (run_id) DO NOTHING`. `cause_chain` is array-shaped JSON,
`response_headers` is object-shaped JSON, and there is deliberately no
`attempts` column until an honest complete retry producer exists. Pair every
shape change with both migration and bootstrap parity tests, explicit
thread-deletion cleanup, and all three table-enumerating reset paths. Full
contract: `docs/agents/assistant-persistence.md` § RUN ERROR PROVIDER
FORENSICS.

## PGLITE EXTENSION INVARIANT

Every PGlite construction site MUST load the same engine-extension set, or the
corresponding `CREATE EXTENSION` migration fails with a cryptic "could not open
extension control file" error on that path only:

- `vector` (pgvector, from `@electric-sql/pglite-pgvector`)
- `pg_trgm` (from `@electric-sql/pglite/contrib/pg_trgm` — powers `brainstrike.grepSearch` trigram prefilter, migration 038)
- `pg_textsearch` (BM25 index AM, from
  `@electric-sql/pglite-pg_textsearch`) is a fail-closed, version-qualified
  runtime dependency. The compatible package family is pinned together:
  `@electric-sql/pglite@0.5.3`,
  `@electric-sql/pglite-pgvector@0.0.4`, and
  `@electric-sql/pglite-pg_textsearch@0.0.4`, whose bundled extension reports
  exactly `pg_textsearch 1.2.0`. Do not independently bump one member.
  pg_textsearch 1.3.x introduced a persisted paged-memtable design and 1.3.1
  produced invalid BM25 page chains during real `file_chunks` updates.
  Migration 065 always drops the historical index/extension first; migration
  066 recreates them only after checking
  `pg_extension.extversion = '1.2.0'`. A package drift therefore aborts
  migration visibly before BM25 writes begin. The production lexical arm
  matches through migration 034's generated tsvector + GIN index and orders
  those matches with the migration-066 BM25 index. `rankNormalization` remains
  in the public options type for compatibility but is inert because
  pg_textsearch owns BM25 normalization. The opt-in qualification test is
  `packages/db/__tests__/pg-textsearch-durability-gate.integration.test.ts`;
  run it from the repository root with
  `pnpm --filter @brainstrike/db test:pg-textsearch-durability`. It submits a
  rotated burst of inserts, updates, deletes, BM25 searches, and VACUUM
  requests; PGlite serializes them through its single WASM Postgres instance.
  The gate checkpoints every cycle and repeatedly closes/reopens the same
  on-disk store while verifying heap/BM25 row-count agreement, revision
  continuity, catalog index validity, extension version, forced index
  traversal, and ranked reads. The command logs every bounded cycle/reopen and
  fails a cycle after 60 seconds instead of appearing to hang. Any future
  extension or PGlite upgrade must first change the exact migration guard,
  update the whole peer-compatible package family, pass repeated gate runs on
  every supported desktop platform, and pass the normal
  migration/repository regression suite.
- `live` (client-side reactive queries — loaded everywhere EXCEPT the two live-less worker hosts: `pglite-worker-entry.ts`, where the PGliteWorker client installs it, and `browser-first-run-bootstrap-worker.ts`, whose short-lived bootstrap instances serve no reactive queries)

Construction sites (keep in sync when adding extensions or new sites):
- packages/db/src/wasm-loader.ts (cached loaders + HMR reset in `resetExtensionCaches`)
- packages/db/src/pglite-worker-entry.ts (engine extensions only)
- packages/db/src/browser-first-run-bootstrap-worker.ts (engine extensions only; the dedicated first-run bootstrap worker — see BROWSER FIRST-RUN FAST BOOTSTRAP)
- apps/desktop/src/db-main.ts (main-process host; ambient type shims live in apps/desktop/src/types/)

Tests that construct PGlite directly and run migrations must also pass the full
extension set (see drizzle-migrate.test.ts / drizzle-job-queue-compatibility.test.ts).

### The test snapshot `globalSetup` lives on ONE project — do not hoist it

`packages/db/vitest.config.mts` declares
`globalSetup: ['./__tests__/helpers/db-snapshot-global.ts']` on the **`unit`
project only**. That setup runs the whole numbered-migration chain once and
`provide()`s the resulting tarball path, so per-test boots become cheap
`loadDataDir` restores (PR #1807). Two ways to break it, both measured on vitest
4.1.10 and pinned by `__tests__/vitest-global-setup-contract.test.ts`:

- **Declaring it on a second project** re-runs the full migration chain once per
  project — `globalSetup` is per-project, not per-run.
- **Hoisting it to the root `test` config** still runs once for a full
  `vitest run`, but a root-declared `globalSetup` also runs under *every*
  `--project` filter — including `--project browser`, which the `Browser tests`
  CI job runs against this package. `pglite-browser.browser.test.ts` never calls
  `inject('dbSnapshotPath')`, so that job would build and discard a fully
  migrated snapshot on every run.

Note this is a **per-process** property: each native DB shard is its own
`vitest run` process and therefore builds one snapshot. The two required Unit
rows and two nightly coverage rows run those processes on separate runners;
within each process, the selected files share that one snapshot.

**There is a second, correct declaration** — `packages/db/vitest.mutation.config.ts`
also declares the same `globalSetup`, deliberately: the Stryker lane throws in
`beforeEach` before any mutant runs without it. That is NOT the per-project
double-run this section warns about, because it is a separate config reached by
a separate `vitest run` invocation, so it inherits the per-process property
above. The rule to apply is "one declaration **per config**", not "one in the
package" — and the contract test inspects `vitest.config.mts` only, for exactly
that reason.

---

## BROWSER FIRST-RUN FAST BOOTSTRAP (idb:// STORES)

A genuine first run of the web app used to pay ~53s creating `idb://web-pg18`:
initdb + every migration under strict durability, where each statement awaits a
full IDBFS `syncfs` round (#1111). The fast path creates a MISSING store
greenfield in seconds — WITHOUT ever relaxing durability on the persistent
store:

1. initdb + all migrations run in a throwaway `memory://` PGlite.
2. `dumpDataDir('none')` captures the migrated data dir as a tarball.
3. A short-lived STRICT (`relaxedDurability: false`) PGlite opens the real
   `idb://` store with `loadDataDir: <tarball>`; one explicit awaited
   `syncToFs()` flushes the whole data dir to IndexedDB in a single pass
   (atomic: IDBFS reconcile is ONE readwrite transaction and its callback
   fires on `transaction.oncomplete`).
4. Only after that flush (plus an existence re-probe) is bootstrap complete;
   the long-lived strict worker client then opens the store exactly as before.
   The #1111 guarantee therefore holds for every byte the store ever sees.

Layers:
- Orchestration (probe/marker/lock/recovery):
  `packages/db/src/browser-first-run-bootstrap.ts`, wired in `db-provider.tsx`'s
  `initializeDirectPGlite` for `idb://` paths.
- Pipeline (memory migrate → dump → strict load → flush) over injectable PGlite
  constructors: `browser-first-run-bootstrap-pipeline.ts`.
- Production execution: a DEDICATED plain worker
  (`browser-first-run-bootstrap-worker.ts` + `-worker-entry.ts` — a PGlite
  construction site, engine extensions vector + pg_trgm + pg_textsearch)
  driven by
  `wasm-loader.ts`'s `runFirstRunBootstrapInWorker` over a two-message
  `{type:'run',dataDir}` → `{type:'result',ok,error?}` protocol with a
  fail-loud 5-minute timeout.

Invariants (do not regress):
- NEVER rebuild this on "relaxed bootstrap + syncToFs + strict reopen": on a
  relaxed instance PGlite's public `syncToFs()` fire-and-forgets the underlying
  flush and `close()` does not flush at all (verified against
  @electric-sql/pglite 0.5.3 src/pglite.ts). Dump/load into a strict instance
  is the only public-API path with a guaranteed awaited flush.
- NEVER run the bootstrap through PGliteWorker sessions: its leader-election
  machinery rejects in-flight RPCs with 'Leader changed, pending operation in
  indeterminate state' when the asynchronously delivered leader-here/leader-now
  events land after the client starts issuing RPCs — ephemeral sole-member
  groups hit this readily under load (observed live in dev; it failed DB init).
  The dedicated worker has no election and no RPC layer, and the dump never
  crosses a thread boundary. The shared `pglite-worker-entry.ts` host stays
  untouched (no `loadDataDir` on its wire — so a leader takeover can never
  replay a stale load).
- Crash safety: a localStorage marker
  (`brainstrike.pgliteFirstRunBootstrap:<dataDir>`) is written before the first
  IndexedDB write and cleared only after the strict flush. marker+store on a
  later launch ⇒ the partial store is deleted (warn-logged) and the bootstrap
  re-runs greenfield — safe because a store whose marker never cleared cannot
  contain user data. Factory reset's blanket `localStorage.clear()` covers the
  marker.
- Capability-gated, never silent: missing IndexedDB / Web Locks / usable
  localStorage each SKIP with an explicit logged reason (the pre-existing
  strict slow path runs instead, slower but equally correct); a bootstrap
  FAILURE rejects into DbProvider's visible init error state — no fallback.
- Multi-tab: serialized on the `brainstrike-pglite-first-run:<dataDir>` Web
  Lock; the loser re-probes inside the lock and skips (`existing-store`).
- Scope: browser `idb://` only (including the per-session `idb://web-e2e-*`
  Playwright stores, which get the same speedup). `opfs-ahp://`
  (worker-host-only backend, far cheaper syncs) and desktop (native FS via
  Electron main) keep their existing paths.

Paired tests: `packages/db/__tests__/browser-first-run-bootstrap.test.ts`
(orchestration/marker/probe), `browser-first-run-bootstrap-pipeline.test.ts`
(phase ordering/cleanup), `browser-first-run-bootstrap-worker.test.ts`
(protocol + STRICT store-load PGlite option pinning),
`browser-first-run-bootstrap.integration.test.ts` (REAL PGlite +
fake-indexeddb over the production pipeline: durable fast bootstrap across
reopen, strict post-ready writes, torn-store recovery),
`wasm-loader-worker.test.ts` (worker runner protocol/timeout), and
`db-provider-first-run-bootstrap.test.tsx` (wiring order + error surfacing).

---

## STATS ROLLUP + WAKEUP POLLING (settled 2026-07 — do not relitigate)

`collection_indexing_stats` stays a hand-maintained rollup table (NOT a
materialized view), and queue wakeups / cross-tab invalidation stay on
`live` queries + bounded interval polling (NO raw LISTEN/NOTIFY layer).
Load-bearing facts: PGlite `live` queries throw at subscribe time on
matviews (triggers are forbidden on them), `REFRESH` is an unbounded
all-collections recompute on the single connection, the `dirty` /
`last_refreshed_at` columns are a reader contract (#1115), and `live` is
itself trigger+pg_notify under the hood — a raw NOTIFY channel would
duplicate it while feeding burst wakeups into the #1247-hardened
scheduling layers. Full rationale, revisit conditions, and verification
probes: `docs/db-rollup-and-wakeup-modernization-decision-2026-07.md`.

---
