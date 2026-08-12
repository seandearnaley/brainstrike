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
`droppedSampleCount` exposes overflow. Failure counts and token lookup/hit totals
use the same exact rolling bucket model; none of those totals are reconstructed
from the capped percentile samples. Overflow is attributed to the evicted
sample's occurrence time so it expires with that sample, not with the later query
that forced the eviction.
`docs/diagnostics-privacy-contract.md` is the cross-cutting privacy authority.

The in-renderer live-query scheduler and Electron live-query bridge both wrap
creation/refresh and listener lifecycle; the single embedding queue poller wraps
its stats read. The production `@brainstrike/token-cache` store exposes a narrow
lookup telemetry port that the file-explorer composition layer wires to this
collector, avoiding a package dependency back to `@brainstrike/db`. File-record
read methods report the coarse `file-tree` feature, including full and
metadata-only managed-cache listings on both repository implementations. Keep
these seams and their paired tests aligned when a query path moves.
Folder-wide token-cache preloads record duration and failure with zero lookup and
hit counts, because they are population reads rather than cache-hit decisions.

The pinned PGlite 0.5.4 live-query implementation marks a handle dead before its
unsubscribe transaction settles and clears its callback collection during that
teardown. Scheduler instrumentation therefore supports exactly one listener,
releases that local ownership on the first teardown attempt, treats repeated
unsubscribe as idempotent, and rejects later subscribe or refresh calls on the
dead handle; a caller that wants to continue must create a fresh live-query
handle. Do not add same-handle retry or reactivation semantics that the underlying
dependency cannot honor. The collector latches retention-clock failure per
instance, logs the first producer failure, stops timer-driven publication, and
publishes a stable explicit failed snapshot to `useSyncExternalStore` reads.
Imperative `snapshot()` calls still throw the latched error.
Count buckets use a boundary-inclusive bucket interval: a count can remain for
up to one coarse bucket after its individual event crosses the strict duration-
sample cutoff. A nonzero count with zero retained percentile inputs at that
boundary is therefore expected.

## DATABASE WORK SCHEDULER FAIRNESS

`DatabaseWorkScheduler` is the single-process admission boundary around each
PGlite host. Foreground work receives a 75 ms quiet window after its latest
arrival, but that preference is bounded: once the background lane has been
deferred for 250 ms, the scheduler admits exactly one background task before
returning to foreground-first ordering. When foreground or normal work remains
queued, at least one such task must be admitted before another background task
can bypass it through the starvation rule. The wait clock restarts after each
background admission, so the guarantee is one admission per bound, not a
250 ms per-task latency ceiling. The clock restarts at admission even while the
admitted task is running; the next forced background admission occurs only after
both the bound has elapsed and the required foreground/normal turn has started.
The wait clock and pending foreground-turn requirement both reset when every
queue drains, so an idle scheduler never carries bypass debt into an unrelated
workload. `forcedBackgroundAdmissionCount` records only starvation-rule
admissions and is the authoritative diagnostic that the bound actually fired.
Queueing behind multiple background tasks compounds those intervals; background
consumers must be sized for bounded progress rather than a fixed completion
deadline. This keeps embedding claims, completion writes, and background
indexing live under continuous foreground polling without turning the
background lane into an equal-priority queue.

The windows are configurable through `backgroundStarvationMs` and
`foregroundQuietMs` for deterministic tests and specialized hosts. The
starvation bound must be positive and finite; the quiet window must be
non-negative and finite. Invalid values throw rather than silently disabling or
degrading either fairness rule. Fairness elapsed time uses a monotonic clock.
Scheduler snapshots carry elapsed timestamps from that same clock origin so
`DatabasePressureController` can age quiet and latency windows safely even over
IPC, while wall-clock timestamps remain diagnostic only. Embedding-claim
starvation bypass uses its renderer-local monotonic clock as well, so clock
corrections cannot extend either admission layer. Work admitted through the
background lane must therefore be short and bounded. Long maintenance statements such as
`VACUUM (ANALYZE)` may run only after the maintenance scheduler has established
an idle database/queue state; do not use background priority as authority to run
an unbounded maintenance statement.

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
   - MODEL_ID_MIGRATIONS in packages/app-state/src/stores/assistant-preferences-store.ts (bump its store version)
   - MEMORY_MODEL_TARGET_MIGRATIONS in packages/app-state/src/stores/assistant-memory-preferences-store.ts (also self-heals on every rehydration)
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

Migration 082 owns the FK-less `brainstrike_canvas_versions` ledger. Register
it in both the numbered runner and Drizzle's append-only custom ledger, mirror
its DDL in the renderer-lazy assistant bootstrap, and keep thread-delete plus
factory-reset ownership explicit. A Canvas document is the rows sharing one
app-side uuidv7 `canvas_id`; greatest `version` is current. Full contract:
`docs/agents/assistant-persistence.md` § CANVAS DOCUMENT VERSIONS.

Migration 083 owns the FK-less `brainstrike_tool_call_telemetry` ledger for
durable model-facing per-tool counts and sizes. Register it in both migration
runners and the reset/thread-delete registries. Mirror its DDL in the renderer-
lazy assistant bootstrap: although only the migrated desktop main-process
assistant server writes rows, the renderer repository's thread-delete CTE
references every registered sidecar unconditionally. Rows contain only thread/
run/tool ids, timestamps, numeric sizes, and booleans; raw tool inputs and
outputs are prohibited. Migration 074's default-privilege grant makes the
later-created table readable by the `brainstrike.querySelf` sandbox role.
The primary key uses `crypto.randomUUID()` (matching the sibling
`brainstrike_assistant_run_usage` writer), not a uuidv7 — this table is a
net-new counters ledger outside any sync-related rework, so AGENTS.md's
uuidv7-groundwork carve-out does not apply.

**Retention (BST-1198, closes the BST-1190 deferral):** rows older than 60
days are pruned by the existing scheduled-database-maintenance mechanism —
`runScheduledDatabaseMaintenance` in
`packages/db/src/services/scheduled-database-maintenance.ts`, the same
idle-triggered pass that runs the #1716 plain `ANALYZE` sweep for
`file_records`/`embedding_cache`, the `VACUUM (ANALYZE)` sweep that includes
`file_chunks`, and the terminal-job prune. No
new scheduler or timer was added, but retention did require one small
migration:
- `DEFAULT_DATABASE_MAINTENANCE_TOOL_CALL_TELEMETRY_RETENTION_MS` (60 days) is
  the default; callers may override it via
  `ScheduledDatabaseMaintenanceOptions.toolCallTelemetryRetentionMs`, resolved
  and validated (non-negative) on every pass, like the sibling job-queue
  options.
- Migration 083's `brainstrike_tool_call_telemetry_tool_time_idx` is
  `(tool_id, occurred_at DESC)` — `tool_id`-leading, so it cannot serve a bare
  `occurred_at` range predicate as an index scan; both retention deletes
  filter on `occurred_at` alone. **Migration 085** (version 84 is skipped —
  claimed by the still-open BST-1192 PR #2333) adds a dedicated
  `brainstrike_tool_call_telemetry_occurred_at_idx` on `occurred_at` so the
  guard probe and both deletes below are real index scans, not sequential
  scans of the whole table. Registered in both migration runners and mirrored
  in the renderer-lazy assistant bootstrap DDL
  (`packages/assistant-data/src/assistant-memory-repository.ts`), same as 083.
- Idle passes (`status: 'completed'`) run a full, unbounded-by-count
  age-DELETE — the same shape as `pruneTerminalJobs`.
- Passes while the job queue is active (`status: 'partial'`) first run a
  cheap `SELECT EXISTS (...)` guard probe on `occurred_at` (an index scan that
  stops at the first match); only when it finds an expired row does an
  `activePruneLimit`-bounded age-DELETE run, `ORDER BY occurred_at ASC` so an
  over-limit backlog evicts oldest-first — the same oldest-first shape as
  `DiagnosticEventsRepository.purge()`. The guard exists because the common
  case on a ~10-minute tick is that nothing is expired yet, and without it
  every tick would still pay for planning/running the bounded DELETE for zero
  deletions. This still bounds telemetry growth while a long-running backfill
  keeps the job queue busy, for the same reason job rows once needed it.
- `brainstrike_tool_call_telemetry` is in
  `DEFAULT_DATABASE_MAINTENANCE_VACUUM_TABLES` alongside `job_queue`, so the
  idle path's `VACUUM (ANALYZE)` actually reclaims the dead tuples the idle
  DELETE creates (PGlite has no autovacuum launcher — without this the table's
  heap/index disk usage would keep growing at the same rate, just as dead
  pages instead of live rows) and gives the `token-spend-by-tool` lens planner
  fresh column statistics it previously never got. Only the active-queue path
  defers `VACUUM` until idle; the idle path now genuinely runs it for both
  tables.
- The result's `prunedToolCallTelemetryRows` field reports the count for both
  branches; the desktop scheduler logs it alongside `prunedTerminalJobs`.
Paired tests: `packages/db/__tests__/scheduled-database-maintenance.test.ts`
(`tool_call_telemetry retention (BST-1198)` describe block) proves old rows
are pruned and newer rows survive on both the idle and active-queue paths,
that the active-queue guard probe skips the DELETE when nothing is expired,
that an over-limit active-queue backlog evicts oldest-first, that
`brainstrike_tool_call_telemetry` is VACUUMed on the idle path, and that the
`token-spend-by-tool` lens output for an in-window query is unaffected by
pruning outside that window. Migration coverage:
`packages/db/__tests__/migration-085-tool-call-telemetry-occurred-at-index.test.ts`
(index created on both runners; a forced-seqscan-off `EXPLAIN` probe proves
the bare `occurred_at` predicate resolves to an index scan on it).

Migration 086 owns the FK-less
`brainstrike_token_estimate_calibration` ledger. Each row stores a durable,
model/provider-attributed run-end pair of `estimated_prompt_tokens` and
`final_step_prompt_tokens`; the desktop writer derives `thread_id` from
the existing `run_id` with `INSERT ... SELECT` rather than trusting a carried
thread id. Rows contain numbers, ids, model/provider strings, and timestamps
only—never message content, tool content, prompts, file paths, or command text.
The table is registered in both migration runners, the shared factory-reset
registry, and the thread-delete sidecar list. Its DDL is mirrored in the
renderer-lazy assistant bootstrap because that repository references every
sidecar unconditionally even though desktop main owns normal writes.

Scope is intentionally explicit. The numerator, `estimated_prompt_tokens`, is
`RunTokenDiagnostics`'s chars/4 backstop over model-visible tool-output
projections plus tool definitions, each counted once. The denominator,
`final_step_prompt_tokens`, is the single latest step's prompt count, which
already contains every prior tool output once via Mastra's resend behavior—not
the cross-step accumulated billing total. Both figures are comparable over the
same final-prompt-content basis; conversation/system-prompt text outside tool
outputs and definitions is excluded from both. Only completed runs with at
least one measured tool output persist a row.

Migration 089 adds nullable positive domain/transport resolved-budget token
columns. New calibration rows persist the concrete run tier; historical rows
remain NULL because backfilling an anchor would fabricate evidence. The
renderer-lazy bootstrap mirrors both the fresh final shape and idempotent
`ADD COLUMN IF NOT EXISTS` upgrade seam. Its ordinal column order matches the
migrated path: migration 086's trailing `occurred_at` precedes the two columns
migration 089 appends. The estimator lens groups by model plus both tier
columns.

Migration 091 adds nullable positive `prompt_baseline_tokens`, the same run's
prompt-composition total of system instructions, task list, and tool
definitions. The next turn's pre-request compaction trigger reads the newest
thread-scoped calibration row because that baseline is not yet available when
compaction runs. Historical rows remain NULL rather than receiving fabricated
prompt evidence. This is an additive FK-less ledger extension registered in
both migration runners and mirrored in the renderer-lazy bootstrap's fresh
table shape plus its idempotent `ADD COLUMN IF NOT EXISTS` upgrade seam. It
inherits the calibration table's existing 60-day retention and
`occurred_at`-leading maintenance path; no new retention logic or privacy
surface is introduced.

The least-new-mechanism seam is a standalone table modeled on migration 083.
Both figures already meet in the agent/main-process stream before the existing
desktop persistence wrapper. Extending
`brainstrike_assistant_run_usage` would require transporting the agent-only
diagnostic backstop into its renderer-side `handleUsage` writer, adding a new
process-boundary mechanism without improving attribution or fidelity.

Retention exactly mirrors tool-call telemetry: rows older than 60 days are
pruned unbounded on idle passes and oldest-first in bounded batches while the
job queue is active, with a cheap expired-row guard probe. Migration 086 ships
the `occurred_at`-leading index from the start plus a `thread_id` index for the
thread-delete sidecar predicate, and idle maintenance includes the table in
`VACUUM (ANALYZE)`. Factory reset clears the evidence while normal
restarts retain it. Paired tests cover agent emission/omission, desktop
run/thread attribution in real PGlite, migration/reset/bootstrap parity,
60-day maintenance, and the checked-in `estimator-calibration.sql` lens golden
path through `parseLensFile`, `coerceLensValues`, and `AgentSqlService.query`.

Migration 084 owns the FK-less
`brainstrike_assistant_tool_projection_rewrites` overlay used by BST-1192's
transient stale-read replay processor. Register it in both migration runners,
the reset registry, all three table-enumerating clear paths, and the shared
thread-delete sidecar list. Mirror its final schema in renderer lazy
assistant bootstrap because that repository's delete CTE references every
sidecar unconditionally even though desktop main owns normal writes. Durable
Mastra message content is never mutated. Migration 087 adds the
supersession/prune discriminator and nullable superseder used by BST-1200's
recency pruning; both the migration ledger and bootstrap mirror carry the final
shape. Supersession rewind recovery remains the processor's current-prompt
superseder-presence check, while prune rows remain active whenever their own
call is visible. Full contract:
`docs/agents/assistant-persistence.md` § STALE TOOL-PROJECTION REWRITE OVERLAYS.

Migration 088 owns the FK-less
`brainstrike_assistant_compaction_ranges` overlay used by BST-1200 Milestone
2's durable conversation summaries. Persist an exact ordered JSONB set of
compacted message IDs rather than interpreting opaque client/UUIDv4 message IDs
as sortable range keys. Register it in both migration runners, the reset
registry, all three table-enumerating clear paths, and the shared thread-delete
sidecar list. Mirror the final schema in renderer lazy assistant bootstrap for
the same unconditional thread-delete-CTE reason as migration 084. The overlay
processor derives liveness from the summary message's presence in Mastra's
already-tombstone-filtered ID-bearing input-step message list; neither raw
Mastra content nor rewind state is mutated.

Migration 090 widens `brainstrike_assistant_run_usage.run_kind` to admit
`compaction-summary`, the provider-exact auxiliary summarizer call attributed
under its parent run. Register the constraint replacement in both migration
runners and keep the renderer-lazy bootstrap CHECK aligned; adding only the
TypeScript union makes real PGlite inserts fail. The numbered migration must
replace migration 077's existing same-name CHECK and therefore uses
main-process-only `DROP CONSTRAINT` + `ADD CONSTRAINT`. The renderer-reachable
bootstrap must never emit that destructive statement: it installs the final
constraint only when the catalog says it is absent, because `db:exec` rejects
renderer schema drops.

## PGLITE EXTENSION INVARIANT

Every PGlite construction site MUST load the same engine-extension set, or the
corresponding `CREATE EXTENSION` migration fails with a cryptic "could not open
extension control file" error on that path only:

- `vector` (pgvector, from `@electric-sql/pglite-pgvector`)
- `pg_trgm` (from `@electric-sql/pglite/contrib/pg_trgm` — powers `brainstrike.grepSearch` trigram prefilter, migration 038)
- `pg_textsearch` (BM25 index AM, from
  `@electric-sql/pglite-pg_textsearch`) is a fail-closed, version-qualified
  runtime dependency. The compatible package family is pinned together:
  `@electric-sql/pglite@0.5.4`,
  `@electric-sql/pglite-pgvector@0.0.5`, and
  `@electric-sql/pglite-pg_textsearch@0.0.6`, whose bundled extension reports
  exactly `pg_textsearch 1.3.1`. Do not independently bump one member — this
  is not just a peerDependency lint warning: BST-1063 verified empirically
  that constructing `new PGlite()` with pglite core 0.5.4 and a held-back
  `pglite-pg_textsearch@0.0.4` (built against core 0.5.3) throws "PGlite
  failed to initialize properly" outright, before any SQL runs. The family
  moves as one unit or not at all.
  pg_textsearch 1.3.x introduced a persisted paged-memtable design and 1.3.1
  produced invalid BM25 page chains during real `file_chunks` updates when
  qualified against pglite-pg_textsearch@0.0.5 — that finding quarantined
  1.3.1 in migration 065/066. BST-1063 re-qualified the *same* extension
  version 1.3.1 as now bundled by pglite-pg_textsearch@0.0.6 (the PGlite
  0.5.4 bump left no lower-numbered pg_textsearch option): 6/6 durability-gate
  runs clean (5 default-config + 1 heavier stress config) plus 3/3 clean
  trials of the existing-user upgrade path (a BM25 index created under
  pglite-pg_textsearch@0.0.4/extversion 1.2.0, reopened and further
  written/read/VACUUMed under the 0.0.6/1.3.1 binary — extversion stayed
  '1.2.0' in the catalog with no `ALTER EXTENSION UPDATE`, and the index
  stayed valid throughout). All of that evidence is macOS arm64 only; no CI
  lane exercises this opt-in gate on any platform, so Linux and Windows
  remain unproven for this specific engine version. See
  `packages/db/src/pg-textsearch-compatibility.ts` for the qualification
  record.

  **The guard protects greenfield installs only — RESOLVED BY RULING
  (BST-1081, Canceled 2026-08-02): Brainstrike is a greenfield app with no
  existing installs, so greenfield is the entire population.** The structural
  facts stand: migration 066's Drizzle ledger key is a fixed string literal
  (never re-runs for an already-migrated database), nothing calls
  `ALTER EXTENSION UPDATE`, and no runtime code compares the catalog's
  extversion against the loaded binary. They simply have nobody to affect —
  the first public build ships the 0.5.4/1.3.1 family, so every install that
  will ever exist runs migration 066 under it. Pre-bump DEVELOPMENT databases
  are the one exception: they land in the 1.2.0-catalog/1.3.1-binary mixed
  state after upgrading, which is accepted (3/3 clean upgrade-path trials;
  the BM25 index is derived data) — if such a DB misbehaves in search, reset
  it or drop/recreate `idx_file_chunks_content_bm25` rather than debugging
  the mixed state. If an upgrade path from a pre-1.3.1 database is ever
  shipped, BST-1081's analysis is the spec: `ALTER EXTENSION UPDATE` alone
  relabels without reconciling index pages (the 1.2.0→1.3.0 upgrade SQL is
  catalog-only), so the migration must also rebuild the index under the new
  binary, backed by a committed existing-install test.
  Migration 065 always drops the historical index/extension first; migration
  066 recreates them only after checking
  `pg_extension.extversion = '1.3.1'`. A package drift therefore aborts
  migration visibly before BM25 writes begin **on a greenfield database**.
  The production lexical arm
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

  **Recorded exception (BST-1063, 2026-08-01):** the 1.3.1 re-qualification
  above shipped on macOS-arm64-only gate evidence, short of the "every
  supported desktop platform" bar this paragraph states, because the PGlite
  0.5.4 family leaves no lower-numbered pg_textsearch option to fall back to
  — see the "family cannot be split" finding earlier in this section. Linux
  and Windows qualification is owed under BST-1080. This exception covers
  *platform coverage* only. (The existing-install gap that once also blocked
  merge is resolved by the BST-1081 greenfield ruling recorded above.)

  PGlite 0.5.4 also fixed Electron process detection to key off
  `process.type` instead of `process.versions.electron` (upstream commit
  `7e0d6d1`, PR electric-sql/pglite#1033): the previous guard treated
  Electron's main and utility processes as non-Node, which could break
  PGlite's filesystem path there. This lives entirely inside PGlite's own
  bundled code (`IN_NODE` / `isElectronWebContext`) — Brainstrike has no
  corresponding workaround in its own source to remove, and
  `@brainstrike/platform-utils`' `detectPlatform()` is a separate,
  UI-facing Electron/web classifier unrelated to PGlite's internal Node-FS
  detection. What BST-1063 actually verified for the construction sites
  below: the db package's full unit/integration suite (which exercises
  `wasm-loader.ts` and the worker entries, including under `jsdom`) passed
  clean post-bump, and a source read confirmed none of the four sites hardcode
  a PGlite version string, so the bump propagates without code changes. What
  it did **not** verify: `process.type` is only ever defined inside a real
  Electron process — a Node or jsdom test run cannot set it, so no test in
  that suite exercises the exact code path this upstream fix changes. Real
  main-process host (`apps/desktop/src/db-main.ts`) launch verification under
  actual Electron is still **owed**, not done — do not read the passing test
  suite as covering this. The other three construction sites
  (`pglite-worker-entry.ts`, `browser-first-run-bootstrap-worker.ts`,
  `wasm-loader.ts`) are worker/renderer hosts where `process.type` is also
  never `'browser'` (Electron main), so they were never the code path this
  fix targets in the first place; their coverage by the passing unit suite is
  real and sufficient.
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

## COLLECTIONS LIVE QUERY: ONE OWNER (settled 2026-08, BST-1212 — do not relitigate)

`useCollections` (`packages/vector-management/src/collection-select/collection-select.tsx`)
is the SINGLE writer of the shared `vectorStatusUIStore.cachedCollections`
cache. It does not merely read that cache — it recomputes it through its own
instance-local `pendingMutationsRef` and writes the result back.

**At most one instance may be mounted at a time.** Two instances whose pending
mutations differ each recompute a different "next" cache from the other's
write and never converge: A writes X, B recomputes Y and writes it, A
recomputes X, forever. The loop terminates as React error #185 ("maximum
update depth"), which takes down the nearest error boundary — in the original
report, the whole file Explorer panel, and it presented first as a Playwright
"element was detached from the DOM" flake, not as a crash.

A second surface that only needs to DISPLAY collections must:
- read `cachedCollections` from the store,
- seed it once with `fetchCollectionsSnapshot(db)` if it may be the first
  surface up (that helper THROWS on an unusable handle and its rejection must
  be surfaced, never rendered as an empty list — an empty picker reads as "no
  collections exist" and invites a duplicate), and
- stay current through the `onEmbeddingSetUpdated` browser event
  (`removeCachedCollection` on `deleted`, `upsertCachedCollection` otherwise).
  Both store mutations are idempotent, so this is safe alongside the live
  owner. The rename dialog only DISPATCHES; it never touches the cache, so a
  surface that skips this listener shows stale names.

Reference implementation:
`packages/db-explorer/src/components/explorer-collection-picker.tsx`.
The sanctioned event-sync write path is
`packages/db-explorer/src/hooks/use-collection-cache-sync.ts`; mount it on the
dialog-hosting surface (`explorer-import-action.tsx`), never on the picker
itself, because the popover unmounts before the outcome is announced. Seeding
stays with each caller via `fetchCollectionsSnapshot`.

---

## BACKFILL TABLE MAINTENANCE (BST-1169)

Embedding backfill completion must never issue `VACUUM` or `ANALYZE` directly.
PGlite has one WASM Postgres backend, so a table-wide maintenance statement on
that path blocks all interactive queries and worker claim/complete traffic.
The desktop scheduled-database-maintenance pass is the sole owner instead: it
first verifies the database work scheduler is idle, then verifies there are no
queued or running jobs before admitting heavyweight maintenance.

`file_chunks` and `job_queue` are both members of
`DEFAULT_DATABASE_MAINTENANCE_VACUUM_TABLES`; `VACUUM (ANALYZE)` reclaims their
dead tuples and refreshes planner statistics in one idle pass. Plain `ANALYZE`
runs before the VACUUM set so a slow or failing `file_chunks` vacuum cannot
starve the cheap `file_records` and `embedding_cache` statistics refreshes. Do
not also list `file_chunks` in the default plain-ANALYZE set. `file_chunks` is
ordered last so a timeout or vacuum failure on the largest table cannot prevent
the smaller retention-ledger vacuums from running first. Every maintenance
statement taking at least one second emits a warning containing the exact SQL
statement and duration; this includes queue reads, retention probes/deletes,
plain ANALYZE, and VACUUM. That preserves one-glance attribution for single-host
stalls. Failed or interrupted backfills leave maintenance to the same scheduled
pass; index recovery is independent of heap reclamation and must not reacquire
the host for an inline vacuum.

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
