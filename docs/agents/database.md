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

`createScheduledLiveQueryHandle` OWNS its terminal state; it does not inherit it
from the raw PGlite handle. The scheduled handle admits exactly one listener,
releases that local ownership on the first teardown attempt, treats repeated
unsubscribe as idempotent, and rejects later subscribe or refresh calls on the
released handle; a caller that wants to continue must create a fresh live-query
handle. Do not add same-handle retry or reactivation semantics.

The upstream fact that justifies "no retry" is narrower than it once read here,
and it did NOT change in the 0.5.5 bump (BST-1283): PGlite's `unsubscribe`
detaches the callback and latches `dead = true` SYNCHRONOUSLY, before it awaits
the teardown transaction. So a rejected teardown still leaves the listener
detached and the raw handle permanently dead — upstream itself offers no retry,
and the wrapper's own `active = false`-before-await mirrors that exactly. What
0.5.5 DID change is the multi-listener case only: `unsubscribe(cb)` previously
ran `callbacks.filter((callback) => callback !== callback)`, a shadowed
parameter that made the predicate always false and so emptied the whole
collection, terminalizing the handle for every listener. 0.5.5 fixes the shadow
(`(cb) => cb !== callback`), so a handle with other listeners now stays live.
Nothing in this repo subscribes twice to one handle, so that fix is inert here.

Vitest 5 migration (BST-1689): the clock-less package import regression runs
in an isolated Node/tsx process using the shared workspace source aliases.
The resolver converts absolute source paths to file URLs for Windows ESM, and
child assertion errors inherit stderr so import failures remain diagnosable.
Removing `performance` from a Vitest worker breaks the runner's own clock and
cannot test package initialization reliably. The child must import the public
DB source entry without a clock, then fail explicitly when telemetry is used.
DB browser-storage tests stub and restore `navigator` with Vitest's global
helpers; hook cleanup uses `vi.doUnmock`, since hoisted `vi.unmock` is module-only.
Root source aliases are shared by inline projects through Vitest 5 inheritance;
keep the snapshot `globalSetup` on the unit project only.

## DESKTOP LIVE-QUERY MEMORY TEST DIAGNOSTICS

BST-438's memory regression lane observes live-query ownership without widening
the production renderer bridge or changing cache lifetime. The database demo
installs `__brainstrikeDatabaseDemoTestHooks__.getMemorySnapshot` only when the
desktop lifecycle bridge reports test mode. Its bounded snapshot contains the
active collection ID, at most 100 currently visible record IDs, cardinalities
for the existing collection/page caches, and the query-telemetry live
subscription/update counts. It also reports an opaque generation ledger for the
actual mapped `records` array identities. The ledger keeps at most 256
`WeakRef`s, numeric generation IDs, the current/alive/collected counts, and a
visible dropped-generation count. It never holds a strong reference to a result
array or exposes a row. An empty result clears both the current generation and
last-identity reference; a later return of the same array object is therefore a
new generation. Missing `WeakRef` support in explicit test mode throws, and
dropping a ledger entry is observable rather than silent. Outside test mode the
hook and tracker are absent. The snapshot must never include SQL, parameters,
content, paths, or complete result arrays.

The remote ownership snapshot is also test-only and counts the same live query
at each retaining layer. The DB-host `diagnostics` response carries its internal
`activeLiveQueryCount`; `DbHostManager.getDiagnostics()` deliberately strips
that field from the normal diagnostics IPC result. In explicit test mode,
`getLiveQueryDiagnosticsForTests()` reports the DB-host map and manager proxy
map counts. Database IPC registration installs the main-process
`__brainstrike_e2e_db_live_query_diagnostics__` function only in that mode,
adds the renderer-owner map count, and removes the function when those handlers
unregister. Missing test mode or a missing diagnostic function throws; it must
not return a fabricated zero.

The visible renderer telemetry count is realm-local, while the IPC, manager,
and host diagnostics aggregate their process-wide ownership maps across
renderer owners. Reloading the visible renderer preserves its `WebContents`,
so main-process ownership must be reaped by the live-query owner reaper, not
only on `'destroyed'`: `db:live-query:start` attaches teardown listeners for
all three shapes (`'destroyed'`, `'render-process-gone'`, `'did-navigate'`),
and any firing removes all three listeners, bumps a per-owner generation, and
cleans up every subscription that owner holds — mirroring the fs-watch owner
reaper (`attachOwnerReaper` in `file-system-watch-ipc.ts`). A start whose
`createLiveQueryHandle` await straddles a reap observes the generation change
and tears its fresh handle down instead of registering an orphan. Reloads are
therefore idempotent for the main-side counts: the mutation regression
performs a second reload + panel mount after the pre-warm capture and requires
all three main-side counts to return to the pre-warm values exactly, gated on
the renderer-local count so the transient window before the fresh page
re-registers cannot pass. The regression then captures each layer before
selecting a collection and asserts the same exact **+5** delta thereafter: the
three database-demo queries (`file-records`, total, and collection counts) plus
the active-set queue-count and coverage queries mounted by
`useEmbeddingControls`. That computed object is rechecked after every warm and
switch window and after the final insert and delete; absolute counts are never
hardcoded.

Memory release means superseded result arrays and live-query handles stop
accumulating. It does **not** mean evicting inactive database-demo pages: that
surface intentionally retains one page per visited collection for fast
revisits. The three-collection regression therefore captures an empty pre-warm
cache, warms A/B/C, and requires every chunk-page, collection-count,
record-page, record-total, and loaded-page cache to contain exactly three keyed
entries throughout repeated switching. It also mutates the final collection
after switching and requires both the inserted and deleted state, proving the
remaining current subscription is live rather than merely bounded. The
mutation regression separately commits 100 alternating inserts/deletes and
requires each current result before continuing.

Forced collection must remove the mutation baseline and midpoint generations,
leave the current generation alive, collect at least 97 of at least 101 tracked
arrays, and leave at most four alive. The switching test must remove all three
warm generations, leave the current generation alive, collect at least 30 of at
least 35 tracked arrays, and leave at most eight alive (CI-calibrated: the
first ubuntu memory-baseline dispatch held 7, local runs hold 5). Both require
zero dropped
ledger entries. These identity assertions are the primary retained-result
proof; renderer heap and visible-renderer working set are independent physical
pressure bounds, not substitutes for collection evidence.

Renderer heap assertions require real forced collection AND real heap reads.
The desktop E2E launcher passes `--js-flags=--expose-gc` plus
`--enable-precise-memory-info` (without the latter,
`performance.memory.usedJSHeapSize` is quantized and cached for 20 minutes, so
every in-test heap delta reads as exactly `0.0`), and
`forceRendererGarbageCollection` throws when `window.gc` is unavailable; a
silent no-op would make the retained-heap result meaningless. Both regressions
live in `apps/desktop/e2e/database-live-query-memory.desktop.test.ts` and are
explicitly selected by the `memory-baseline` branch of
`.github/workflows/desktop-e2e.yml`; nightly `full` runs include the file too,
and both branches are pinned by
`scripts/__tests__/desktop-memory-dispatch-contract.test.mjs`. Paired unit/contract coverage lives in
`packages/db-explorer/src/__tests__/database-demo-panel.test.tsx`,
`packages/db-explorer/src/hooks/__tests__/use-database-demo-test-hook.test.ts`,
`packages/db-explorer/src/__tests__/use-database-demo-data.test.ts`,
`apps/desktop/src/__tests__/main/db-host-entry.test.ts`,
`apps/desktop/src/__tests__/main/db-host-manager.test.ts`,
`apps/desktop/src/__tests__/ipc-domains/db-ipc.test.ts`, and
`apps/desktop/src/__tests__/desktop-e2e-harness-contract.test.ts`.

The collector latches retention-clock failure per instance, logs the first
producer failure, stops timer-driven publication, and
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

Run-scoped assistant operations enter this SAME scheduler as `foreground`; they own no second policy.
Transient saturation requires another pending request or one abandoned within its preceding request-timeout window.
An abandonment surviving another full window marks the host wedged until a host response proves forward progress; transaction timeouts terminate the host.
Neither is retryable. Eligible idempotent work may retry once with warning plus durable evidence; exhaustion surfaces the typed
`DbHostRequestTimeoutError`. The retry is another foreground admission, so the 250 ms starvation bound and required foreground/normal turn remain authoritative.

The windows are configurable through `backgroundStarvationMs` and
`foregroundQuietMs` for deterministic tests and specialized hosts. The
starvation bound must be positive and finite; the quiet window must be
non-negative and finite. Invalid values throw rather than silently disabling or
degrading either fairness rule. Fairness elapsed time uses a monotonic clock.
Scheduler snapshots carry elapsed timestamps from that same clock origin so
`DatabasePressureController` can age quiet and latency windows safely even over
IPC, while wall-clock timestamps remain diagnostic only. Embedding-claim
starvation bypass uses its renderer-local monotonic clock as well, so clock
corrections cannot extend either admission layer. Scheduler wait and service
metrics also use monotonic elapsed time; diagnostic wall-clock corrections must
not distort pressure percentiles. Work admitted through the
background lane must therefore be short and bounded. Long maintenance statements such as
`VACUUM (ANALYZE)` may run only after the maintenance scheduler has established
an idle database/queue state; do not use background priority as authority to run
an unbounded maintenance statement.

**Idle means SUSTAINED idle, not an instantaneous sample (BST-1333).** The DB
host dispatches envelopes strictly serially and cannot preempt one, so a
maintenance statement that runs for seconds blocks every renderer query behind
it for its whole duration — a measured `VACUUM (ANALYZE) file_chunks` took
**7.3s** and started in a momentary gap between the renderer's startup query
bursts, which a point-in-time "is the scheduler busy right now?" check read as
safe. `createDesktopDatabaseMaintenanceScheduler` therefore requires the work
scheduler to have been *continuously* idle for `quietPeriodMs` (default 15s,
observed via `subscribeToSchedulerSnapshots`) before a pass may begin, and
`start()` seeds the window as busy so booting never counts as quiet. Skips are
logged with reason `database-scheduler-recently-busy` and simply retry on the
next interval — never widen this gate to "idle right now" for a statement whose
duration is unbounded.

## MODEL CATALOG MIGRATIONS (CRITICAL)

Adding, removing, or renaming a supported AI model is a multi-layer change. Updating only the static catalog is NOT enough — the in-app model picker is driven by a DB-backed catalog.

When changing the model catalog:
1. Update the static provider catalog (single source of truth):
   - packages/assistant-contract/src/provider-catalog.json
   - The catalog is DATA (BST-1650), not a TypeScript literal. `scripts/model-catalog-migration-contract.mjs` and `scripts/__tests__/provider-env-keys-mirror-contract.test.mjs` read it with `JSON.parse`; the earlier requirement to keep `PROVIDER_DEFINITIONS` AST-parseable (BST-1143) is retired, and no catalog field may reference a constant, because JSON cannot. Comments moved to optional `_note` strings, which `parseProviderCatalog` strips before any consumer sees a definition.
   - Because JSON widens under `resolveJsonModule`, `tsc` no longer checks catalog rows: `packages/assistant-contract/src/provider-catalog-schema.ts` does, at module load, and THROWS. It is a `strictObject` schema, so an unknown or misspelled key fails rather than being dropped. `provider-catalog-schema.test.ts` pins the schema against the `ProviderDefinition` / `LlmModelDefinition` / `EmbeddingModelDefinition` interfaces in BOTH directions, so schema-vs-type drift is a type-check failure.
   - `packages/assistant-contract/src/provider-registry.ts` keeps the types and the accessors — it no longer carries a single row, so a new field must be added to the schema AND the interface in the same change (data ownership and the schema/type synchronisation invariant: docs/agents/assistant-providers.md, "Provider catalog data ownership"). A catalog-only edit still re-hashes the package and everything downstream of it — Turbo hashes JSON inputs exactly like `.ts` inputs (measured in BST-1650). The move buys reviewability and script access, NOT build time.
2. Add a numbered DB migration that upserts/deletes catalog rows with a `ledgerKey`, and add it to `packages/db/src/migrations/index.ts`; the Drizzle ledger is derived.
   - For pure ADDITIONS, generate it: `node scripts/gen-model-catalog-migration.mjs` prints the plan and `--write` emits the numbered file and registers it in the manifest (BST-1650). It derives only what the catalog carries — id, provider, name from `label`, `capabilities` from `type`/`supportsStreaming`/`vision`/`defaultDimension` — appends `sort_order` in SQL at apply time, seeds `is_enabled` false, and writes the `is_enabled = models.is_enabled` upsert. `tagline` and `best_for` are left NULL for a human to author per rule 7; the generator never copies the registry's composer tagline into them.
   - It is ADD-ONLY and refuses to run when a catalog row disappeared, because a removal needs the rule-4 remap decisions and a user-visible notice (BST-565) first. An entire provider leaving the catalog is that same removal, not residue: the generator and the contract checker share `isHistoricalCatalogResidue`, whose only exemptions are the pre-021 `transformers` rows (migration 021 renamed that provider with an `UPDATE` the operation extractor does not model) and the checker's `STATIC_CATALOG_STALE_ROW_ALLOWLIST`, so the two tools can never disagree about which rows are reconstruction residue.
   - It also refuses a catalog row that reuses an id the DB catalog already holds under a different provider or type — `models.id` is the upsert's conflict target, so the generated migration would overwrite a live row going up and DELETE a pre-existing one going down — and refuses a model whose `vision`, `supportsStreaming` or `defaultDimension` is missing rather than guessing a capability. `scripts/__tests__/gen-model-catalog-migration.test.mjs` feeds a generated migration back through the contract checker.
   - `ledgerKey` is the persisted `__drizzle_migrations.hash` and must never change once shipped.
   - `packages/db/src/drizzle/migrate.ts` derives `customMigrations` from the numbered manifest, excluding 001–014, 016–019, 029, and 031 folded into the immutable drizzle-kit snapshot. Migration 008 remains numbered-only (ADR-0002).
   - Unfolded migrations must have SQL-string `up`; derivation throws for callbacks. Folded callbacks remain numbered-runner-only.
   - Paired tests: `packages/db/__tests__/drizzle-ledger-keys.test.ts` freezes the 95 shipped keys and verifies old-ledger startup applies nothing; `drizzle-migration-manifest.test.ts` proves automatic registration and fail-closed callback rejection. `scripts/__tests__/model-catalog-migration-contract.test.mjs` preserves the numbered-registration guard.
3. Preserve user choices on kept rows with `ON CONFLICT (id) DO UPDATE SET ... is_enabled = models.is_enabled`.
   - INVARIANT: never use `is_enabled = EXCLUDED.is_enabled` for a catalog refresh — it clobbers the user's toggle. Force on/off only for a deliberate (e.g. security) swap.
4. Remap dropped IDs in the preference stores so persisted selections don't dangle:
   - MODEL_ID_MIGRATIONS in packages/app-state/src/stores/assistant-model-id-migrations.ts (bump `ASSISTANT_PREFERENCES_STORE_VERSION` in `assistant-preferences-store-version.ts`)
   - A remap that changes the user's SELECTED model is not silent: the
     persist migration records it in session-only `modelMigrationNotices`
     and `useModelMigrationNotices` (mounted once in app-shell's `AppLayout`)
     takes-and-clears it into one toast (BST-565 — an OpenRouter Pro → Flash
     swap is a capability downgrade the user must see). Retired defaults under
     providers the user is not running on, and enabled-list-only remaps, stay
     quiet: `modelsByProvider` is seeded for every provider and is not
     evidence of intent.
   - MEMORY_MODEL_TARGET_MIGRATIONS in packages/app-state/src/stores/assistant-memory-preferences-store.ts (also self-heals on every rehydration)
   - The guard canonicalizes discovered migration identifiers with
     `path.posix.join` so diagnostics and downstream checks are platform-neutral.
     Its version parser still accepts `/` or `\` for direct analyzer callers and
     fixtures, preventing Windows paths from misclassifying historical deletions
     as new remap obligations.
5. Add new `packages/db/__tests__/**/*.test.{ts,tsx}` files without a lane-registry edit. The `unit` Vitest project discovers that tree recursively; required Unit and nightly coverage both supply the complete `DB_TEST_SHARD=1/2` + `2/2` set to that project, where Vitest applies its native shard. The value is a DB-task environment input, never a Turbo CLI passthrough argument. Nightly rejoins Vitest blob reports with `--merge-reports`, so coverage is one native union rather than whichever serial lane wrote last. `scripts/__tests__/db-test-discovery-contract.test.mjs` pins the recursive include, browser exclusion, nested discovery, and a minimum 150-file floor, with mutations proving each assertion can fail. The former regex manifest and its two derived lane scripts were deleted in BST-1046; do not recreate a registration map for test placement.
6. Every LLM model entry MUST declare `contextWindow` (and `maxOutputTokens` when documented) in
   packages/assistant-contract/src/provider-catalog.json — schema-enforced at module load
   (BST-1650 moved this from a compile error to a `parseProviderCatalog` throw; it still fails
   closed, and any test that imports the registry surfaces it), static-registry-only (no DB
   migration). It drives the thread context meter and the auto-derived
   `agentLoop.inputTokenLimit` (see packages/assistant-contract/src/context-budget.ts).
7. `tagline` on a registry LLM entry is OPTIONAL, registry-only composer copy: it renders as
   the model's one-line description in the composer model menu. The DB catalog's own
   tagline/description column feeds the db-explorer surface instead — the two are separate
   sources on purpose (no migration needed for registry tagline changes). Omit rather than
   invent copy: taglineless models render name-only.
8. Every LLM model entry MUST also declare `vision` ('supported' | 'unsupported'; never
   'unknown' in the static registry — schema-enforced as above, and pinned by
   provider-registry-vision.test.ts). It gates the
   composer image-attachment affordance per selected model. Unlike `contextWindow`, this one IS
   mirrored into the DB catalog: new model rows must include `"vision"` in the capabilities
   jsonb (migration 061 backfilled existing rows), and frontier-models-migration.test.ts fails
   if any LLM row is left without a vision value.

The Drizzle runner is the sole production migration authority; the numbered runner is `schema-validation-only`, as enforced by `packages/db/src/architecture/db-migration-authority.ts`.

Three schema differences pre-date BST-1643: Drizzle-only `embedding_cache` (8 columns) and `token_cache` (5 columns), and numbered-only `file_records.embedding`. `packages/db/__tests__/drizzle-migration-parity.integration.test.ts` freezes these in a shrink-only allowlist, requiring equality elsewhere and proving the exceptions still diverge. Reconciling them is separate work: follow-up ticket to be filed.

### SAFE CATALOG ROLLBACK WITH LIVE USER DATA

BrainStrike has no shipped production `down` path. The app applies only forward migrations through Drizzle's append-only `__drizzle_migrations` ledger; `MigrationRunner.down()` and its `_migrations` ledger are test-only. Never execute raw `down` SQL or edit the production ledger in an active local profile: the next startup can reapply the migration or continue from a schema the ledger falsely reports as current. A reviewed forward migration is the only sanctioned production recovery.

Use this fail-closed procedure:

1. Prefer a forward catalog migration that restores compatibility without deleting durable IDs. Treat any manual rollback as an exceptional developer/support investigation, not a supported app operation.
2. Before an exceptional investigation, fully quit BrainStrike (all desktop processes or browser tabs/workers) to quiesce writes. On desktop, capture both `Documents/BrainStrike[-dev]/profiles/<profile>/pgdata` and the relevant Electron `userData` artifacts: Chromium renderer `localStorage` and `electron-storage.json`. On web, capture the origin's PGlite IndexedDB store and `localStorage`. Prove the complete clone can be restored into an isolated profile. BrainStrike does not ship a catalog-rollback backup command; if any required store or a verified restore is unavailable, stop.
3. Inventory references in both storage systems. Query PGlite tables such as `models`, `brainstrike_assistant_thread_runs.model`, and `brainstrike_assistant_run_usage.model`, plus any additional model-ID columns found in the current schemas. Separately inspect `assistant-preferences.v1` in renderer `window.localStorage` on desktop and web. Inspect `assistant-memory-preferences.v1` through the Electron storage bridge (`electron-storage.json`) on desktop or browser `localStorage` on web. Include selected/current models, enabled and recent models, and observational-memory targets; record affected counts and representative IDs.
4. Preserve historical run model text; do not rewrite conversation provenance to make a catalog change pass. If a present or future foreign key blocks deletion, design a forward migration that preserves or archives the referenced catalog identity; never disable the constraint or cascade-delete user history.
5. Remap only mutable preference state to a supported replacement through the relevant preference-store migration contract and a store-version bump. Verify the replacement exists in the target catalog first.
6. Rehearse the exact forward recovery against the isolated clone with the production Drizzle runner and its real ledger state. Tests may additionally exercise numbered-runner `down` then `up` behavior, but that is rollback verification—not a production deployment path. Keep the live profile untouched if any reference, constraint, reader, or ledger assertion fails.
7. Apply only the reviewed forward migration through the production Drizzle runner. Afterward verify migration-ledger state, model-picker state, historical thread rendering, and a fresh assistant run; retain the pre-change clone through the next normal startup.

---

## Delegated conversation graph (BST-1718 storage layer)

Migration 126 owns `brainstrike_delegated_conversations`; its `ledgerKey` is
registered in the numbered manifest and consumed by the production Drizzle
runner. The graph records an immutable root anchor and child nodes keyed by
actual native thread id. Root owner, immediate parent, native resource,
configuration, display identity and workspace snapshot are separate columns.
The composite parent foreign key forbids linking a node across root/owner
boundaries. The repository creates children only beneath existing ancestors;
it exposes no reparent operation and conflicting duplicate delivery fails.

Unlike the older FK-less presentation sidecars, this graph references
`mastra_threads`: migration 117 already guarantees that table exists before 126,
as it already does for the run tables in migration 118. Native thread deletion
cascades its graph node and descendant graph nodes. This does **not** cascade
upward into descendant native transcripts; the production branch-deletion
command must explicitly remove those transcripts and their ordinary sidecars
before this storage API is activated in the host. Do not report graph deletion
as complete conversation deletion.

All three table-enumerating clear/reset paths explicitly clear the graph; it is
in the shared reset registry. Root anchors contain no copied presentation or
workspace state. A new direct child snapshots the root's current canonical
`operatingRootId`; nested children inherit their immediate parent's snapshot.
Re-delivery preserves the existing node, including its original workspace.
Configuration must survive a JSON round trip without coercion or omitted data.

The real-PGlite suite `delegated-conversations.integration.test.ts` covers
concurrent duplicate delivery, same-persona siblings, ownership, nested scope
changes, workspace changes, graph deletion, legacy absence, a dumped database
loaded in a new engine, and production-ledger upgrade/replay. Invocation/run
identity, lifecycle, usage and host publication are subsequent BST-1718 layers;
the graph repository is not yet called by production delegation.

### Native invocation identity (BST-1718, host activation pending)

Migration 127 adds `brainstrike_delegated_invocations`. Its immutable key is
root thread + observed native parent run + parent tool call. A conversation may
have multiple invocations; persona identity is never a substitute for either.
`createInvocation` requires an already authorized child graph node and a real
root host run row belonging to the same owner/root. It snapshots that row's
nonblank `turn_message_id`. The host leg id and native parent run id are separate:
Mastra mints its own run ids, and approval/suspension creates new host legs.

`bindInvocationRun` records the observed native child run once; exact duplicate
delivery is idempotent and a different child run is rejected. A follow-up gets a
new invocation key and child run while retaining its conversation. Reads and
run binding revalidate the whole native ancestry and the original host row's
owner/root/turn. Resume must read the existing invocation, rather than create it
with the resume leg id. No placeholder native run id is invented before the
first child stream chunk.

Current root host-run writers set `turn_message_id` only on insert; terminal
updates change status/error/timestamps. There is no age/count pruning of host
run rows today. The invocation FK cascades on explicit host-run deletion; a
future retention policy must retain these rows while descendants can resume,
or atomically delete the complete branch. It must not silently orphan resumable
identity. Reset helpers issue `DELETE`, not `TRUNCATE`, including the desktop
and both direct-PGlite paths. Multiple pending follow-ups rely on the UNIQUE
constraint's default NULLS DISTINCT semantics; a native child run cannot equal
its native parent run.

The repository has no lifecycle or usage writer yet. This is a persistence API,
not desktop activation. `delegated-invocations.integration.test.ts` verifies
ownership changes, duplicates, follow-ups, reconstruction in a new PGlite engine,
production-ledger upgrade/replay, and native-thread deletion cascades. All reset
paths clear the new table before its graph parent. The real Mastra contract test
binds each of two concurrent child invocations before inspecting its first
native event and verifies the separate host/root-turn/native identities.

## ASSISTANT THREAD GROUP PRESENTATION

Thread group structure and presentation are local-first Brainstrike state in
`brainstrike_assistant_thread_groups`, not Mastra thread metadata. Migration 056
owns group color and split flat/grouped rank; migration 059 owns the nullable,
validated group icon. The repository must reject unsupported color/icon values
at both read and write boundaries, and every new presentation column must be
added to `migrations/index.ts` with a `ledgerKey`; the Drizzle ledger is derived.

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
expires after seven days, and is explicitly factory-reset-cleared. Add
every change to `migrations/index.ts` with a `ledgerKey`; the Drizzle ledger is derived. Keep the migration/repository/reset
tests paired with the persistence contract in
`docs/agents/assistant-persistence.md`.

Migration 114 owns the original generation-bound MCP Tasks handles in
`brainstrike_mcp_tasks`. Migration 115 upgrades that schema in place: it
backfills one authority epoch per historical generation, retires every older
generation in a scope, and makes only the highest generation live in
`brainstrike_mcp_task_authorities`.
The task identity is configured server, canonical resource, auth principal,
durable authority epoch, and task id. An authority epoch survives a Desktop
process restart even though the new host connection generation starts at one;
an increasing generation inside one runtime retires that epoch and mints a new
uuidv7 epoch, while a lower same-runtime generation is rejected as stale. Every
create/update SQL statement requires the exact live epoch/runtime/generation
lease, so retirement or factory-reset deletion fences late writes. Reset clears
task rows before their authority parent in all three table-enumerating paths.

The repository bounds transition history at 32 entries and rejects hydration
when timestamps regress, a terminal status is followed by another entry, or the
final history status/timestamp disagrees with `status`/`updated_at`. Metadata
limits are measured through PostgreSQL's canonical `jsonb::text`
representation; an oversize failure includes that representation's SHA-256 so
the lifecycle can persist a bounded omission projection without retaining the
payload. It lists resumable rows only for one exact live authority epoch.
Migration 115 also adds the bounded blocked diagnostic and is registered after
114 in `migrations/index.ts` with a `ledgerKey`; the Drizzle ledger is derived. Both tables are factory-reset
owned; never edit migration 114 to introduce the authority schema because an
existing BST-1562 profile must traverse the same upgrade.

A poller that abandons a task after bounded-lifetime or observation-failure
exhaustion rejects its caller but does not write a blocked diagnostic, so the
row keeps `terminal_at NULL` and `listActive` returns it to the next
`recover()`; only the oversize-state path persists the terminal blocked
diagnostic (BST-1581 verifier scope).

Migration 076 owns terminal provider-forensics storage
(`brainstrike_assistant_run_errors`) and the hot diagnostic correlation index
`bst_diagnostic_events_run_idx`. Add it to `migrations/index.ts` with a `ledgerKey`;
the Drizzle ledger is derived. The run-errors table is also
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

Migration 082 owns the FK-less `brainstrike_canvas_versions` ledger. Add it to `migrations/index.ts` with a `ledgerKey`;
the Drizzle ledger is derived. Mirror
its DDL in the renderer-lazy assistant bootstrap, and keep thread-delete plus
factory-reset ownership explicit. A Canvas document is the rows sharing one
app-side uuidv7 `canvas_id`; greatest `version` is current. Full contract:
`docs/agents/assistant-persistence.md` § CANVAS DOCUMENT VERSIONS.

Migration 083 owns the FK-less `brainstrike_tool_call_telemetry` ledger for
durable model-facing per-tool counts and sizes. Add it to `migrations/index.ts` with a `ledgerKey`; the Drizzle ledger is derived.
Register the table in the reset/thread-delete registries. Mirror its DDL in the renderer-
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

**Substrate split (migration 092, BST-1247):** `truncated` means exactly
"model-facing output was clipped". Substrate degradation lives in its own
columns — `engine` (live-pass engine for search tools: 'ripgrep' | 'js-walk'
| 'skipped'; NULL for non-search tools and all pre-092 rows), `scan_limited`,
and `candidates_truncated` — populated by the desktop writer from flags the
search results already carry. The pre-split OR fold made the
`self-improvement-signal` waste ranking blame the model for the BST-1246
ripgrep degradation (94-100% "truncation" that was mostly the capped JS-walk
fallback). Pre-092 rows are acknowledged-ambiguous: their `truncated` keeps
the old folded meaning, is NOT backfilled, and ages out of the lens's 24h
window; `engine IS NULL` marks them. The lens excludes degraded calls from
`truncation_hit_rate`/`zero_match_rate` and reports
`substrate_degraded_rate` separately
(`packages/db/__tests__/search-lens-self-improvement-signal.test.ts` pins
this).

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
  scans of the whole table. Registered in `migrations/index.ts` with a `ledgerKey`; the Drizzle ledger is derived. Mirrored
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
The migration is registered in `migrations/index.ts` with a `ledgerKey`; the Drizzle ledger is derived.
The table is registered in the shared factory-reset registry and the thread-delete sidecar list. Its DDL is mirrored in the
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
`migrations/index.ts` with a `ledgerKey`; the Drizzle ledger is derived. It is mirrored in the renderer-lazy bootstrap's fresh
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
transient stale-read replay processor. Add it to `migrations/index.ts` with a `ledgerKey`; the Drizzle ledger is derived.
Register the table in the reset registry, all three table-enumerating clear paths, and the shared
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
as sortable range keys. Add it to `migrations/index.ts` with a `ledgerKey`; the Drizzle ledger is derived.
Register the table in the reset registry, all three table-enumerating clear paths, and the shared thread-delete
sidecar list. Mirror the final schema in renderer lazy assistant bootstrap for
the same unconditional thread-delete-CTE reason as migration 084. The overlay
processor derives liveness from the summary message's presence in Mastra's
already-tombstone-filtered ID-bearing input-step message list; neither raw
Mastra content nor rewind state is mutated.

Migration 090 widens `brainstrike_assistant_run_usage.run_kind` to admit
`compaction-summary`, the provider-exact auxiliary summarizer call attributed
under its parent run. Add the constraint replacement to `migrations/index.ts` with a `ledgerKey`;
the Drizzle ledger is derived. Keep the renderer-lazy bootstrap CHECK aligned; adding only the
TypeScript union makes real PGlite inserts fail. The numbered migration must
replace migration 077's existing same-name CHECK and therefore uses
main-process-only `DROP CONSTRAINT` + `ADD CONSTRAINT`. The renderer-reachable
bootstrap must never emit that destructive statement: it installs the final
constraint only when the catalog says it is absent, because `db:exec` rejects
renderer schema drops.

Migration 095 owns the FK-less `brainstrike_assistant_thread_workspaces`
sidecar (BST-1268): one row per thread (`thread_id` PK) holding that thread's
saved workspace as a versioned JSONB `payload` (open app/file tabs, editor
view state, per-root tree expansions, root view). Add it to `migrations/index.ts` with a `ledgerKey`; the Drizzle ledger is derived.
Register the table in the shared factory-reset registry and the thread-delete
sidecar list, and mirror its DDL in the renderer-lazy assistant bootstrap —
the renderer coordinator is the sole writer, and the thread-delete CTE
references every registered sidecar unconditionally. The payload is repaired
section-wise on read by `coerceWorkspaceSnapshot` (unknown versions fall back
to the empty snapshot; expansion lists are capped shallowest-first), so schema
evolution happens in the payload version, not in DDL churn. Rows contain
workspace file paths and tab ids; message content, prompts, and file contents
are prohibited. Paired pins:
`packages/assistant-data/src/__tests__/thread-workspace-contract.test.ts`
(migration↔bootstrap CREATE TABLE shape parity, sidecar-list membership,
reset-registry membership) plus the pinned counts in
`packages/db/__tests__/reset-table-registry.test.tsx`.

Migration 110 owns the FK-less `brainstrike_forge_prs` cache (BST-1391): one
normalized GitHub pull-request observation per realpath'd git common directory
and branch. Add it to `migrations/index.ts` with a `ledgerKey`; the Drizzle ledger is derived.
Register the table in every table-enumerating factory-reset path. It is not a thread-delete sidecar because pull requests
outlive individual threads and are shared by threads on the same branch. The
thread-row PR pill reads it through ONE list-wide, unparameterized PGlite
live query (`use-forge-pr-cache.ts`) rather than a per-thread lookup, so it
renders instantly on boot and offline; the composer's live status instead
reads the capability-gated `window.forge` bridge, which is the only surface
that needs the transient in-flight/error state this table does not carry.

## MANAGED WORKTREE LEDGER (migration 109, BST-1390)

`brainstrike_worktrees` records every linked git worktree BrainStrike itself
created (`created_by IN ('agent','user')`), keyed by its `path` (UNIQUE) and
its realpath'd `repo_common_dir`. It is the authorization source for the ONE
sanctioned picker-less root mount besides recents (`isManagedWorktreePath` →
`isAuthorizedWorktreeMountPath`, `worktree-adopt.ts`; a live row must also be
reachable per adoption's `assertReachable` rule — see
`docs/agents/workspace-context.md`) and the provenance source the git inventory joins
to produce `'both'` / `'agent-reported'`. Setup outcomes persist their closed
status, bounded output, and nullable user-facing reason so later inventory
reads can explain failed or skipped setup without reconstructing create-time
state.

Boot-time root reconciliation reads active ledger identities through
`WorktreeService.listManagedPaths()`, which returns only `{ id, path }` and
deliberately does not resolve git inventory or workspace-root containment.
`WorktreeService.list()` remains the full inventory-joined UI surface.

Deliberate omissions, all load-bearing:

- **No `root_id`.** The durable `roots.id` is derived by path from the live
  `roots` table in `WorktreeService.list`; a stored copy goes stale the moment
  the folder is disconnected.
- **No foreign keys, and NOT in `THREAD_DELETE_SIDECAR_TABLES`.** A worktree
  outlives its thread on purpose — cascading it would orphan a directory of
  uncommitted work. Thread delete offers "also archive its worktree" instead.
- **Not part of the assistant memory schema probe.** That probe covers the
  relations the assistant repository reads or writes — the run tables plus every
  registered thread-delete sidecar (BST-1651).

Registered in both runners and in `BRAINSTRIKE_RESET_TABLES`. Factory reset
clears the ROWS; deleting the worktree DIRECTORIES is a separate, explicitly
confirmed step (see `platform-contracts.md`).

Any migration merged to a long-lived branch counts as shipped and must never be amended in place, because execution on a shared branch cannot be disproven even if no production profile is known to have run it. Corrections must use a new, additive, forward-only migration; `112-worktree-setup-reason.ts` is the concrete example.

## PGLITE EXTENSION INVARIANT

Every PGlite construction site MUST load the same engine-extension set, or the
corresponding `CREATE EXTENSION` migration fails with a cryptic "could not open
extension control file" error on that path only:

- `vector` (pgvector, from `@electric-sql/pglite-pgvector`)
- `pg_trgm` (from `@electric-sql/pglite/contrib/pg_trgm` — powers `brainstrike.grepSearch` trigram prefilter, migration 038)
- `pg_textsearch` (BM25 index AM, from
  `@electric-sql/pglite-pg_textsearch`) is a fail-closed, version-qualified
  runtime dependency. The compatible package family is pinned together in ONE
  place, the `catalog:` block of `pnpm-workspace.yaml`:
  `@electric-sql/pglite@0.5.5`,
  `@electric-sql/pglite-pgvector@0.0.6`, and
  `@electric-sql/pglite-pg_textsearch@0.0.7`, whose bundled extension reports
  exactly `pg_textsearch 1.3.1`. The literal triple is enforced by
  `packages/db/__tests__/migration-066-restore-pg-textsearch.test.ts`; keep this
  paragraph in step with it. Do not independently bump one member — this
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

  That 1.3.1 qualification CARRIES FORWARD across the BST-1283 bump to
  0.5.5/0.0.6/0.0.7 without a re-run, because both extension bumps are pure
  peer-pin re-releases: unpacking the published tarballs and diffing the inner
  payloads shows `pg_textsearch.so`, `pg_textsearch.control`, every versioned
  `.sql`, and the pgvector equivalents are BYTE-IDENTICAL to 0.0.6/0.0.5; the
  only delta in either package is its own `version` and its exact
  `@electric-sql/pglite` peer (0.5.4 → 0.5.5). `default_version` stays
  `1.3.1`, so `QUALIFIED_PG_TEXTSEARCH_VERSION`, `PGLITE_DATA_DIR_VERSION`
  (`pg18`), and `BUNDLED_PG_MAJOR` (`18`) are all unchanged and no data-dir
  migration is implied. Re-derive this the same way before assuming it of a
  FUTURE bump — an extension release that actually rebuilds the binary does
  need the gate re-run on the terms this section sets out.

  **The guard protects greenfield installs only — RESOLVED BY RULING
  (BST-1081, Canceled 2026-08-02): Brainstrike is a greenfield app with no
  existing installs, so greenfield is the entire population.** The structural
  facts stand: migration 066's Drizzle ledger key is a fixed string literal
  (never re-runs for an already-migrated database), nothing calls
  `ALTER EXTENSION UPDATE`, and no runtime code compares the catalog's
  extversion against the loaded binary. They simply have nobody to affect —
  the first public build ships a 1.3.1 family (0.5.4 when this ruling was
  written; 0.5.5 since BST-1283 — the same 1.3.1 binary either way), so every
  install that will ever exist runs migration 066 under it. Pre-bump
  DEVELOPMENT databases
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
  those matches with the migration-066 BM25 index. BM25 orders but never
  matches, so recall is bounded by the tsvector arm; the ts_rank-era
  `rankNormalization` option was removed (BST-908) because pg_textsearch owns
  BM25 normalization and the knob had become a silent no-op.
  `__tests__/fts-search-options-contract.test.ts` pins both facts. When that
  exact English `plain` arm
  returns zero rows, all three file-chunk repository implementations may run
  one bounded `pg_trgm` fallback using the index-supported `$query <% content`
  word-similarity predicate. Websearch and phrase modes remain exact-only so
  their operators/adjacency are never silently discarded, stopword-only
  tsqueries remain honestly empty, and `fuzzyFallback: false` gives evaluation
  callers an explicit opt-out. The fallback pins its session GUC and explicit
  `fuzzyThreshold` to the same value (default `0.6`), returns
  `matchKind: 'fuzzy'`, and does not apply the unbounded BM25 `threshold` to the
  separate 0–1 fuzzy score domain. It reuses every file, root, embedding-set,
  and selection-snapshot scope assembled for the exact arm. Fuzzy-only rows
  omit `ts_headline` because the misspelled tsquery has no honest highlight to
  render. `file-chunk-repository.test.ts` proves typo recall, stopword and mode
  safety, scope retention, explicit opt-out, score-domain separation, and that
  `idx_file_chunks_content_trgm` supports the admission operator when sequential
  scans are disabled; the Electron and Drizzle repository suites pin transport
  parity. The opt-in qualification test is
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

  Hybrid-search performance evidence is produced by the manual, uncached
  `pnpm --filter @brainstrike/db bench:hybrid-search` command. Its default
  10,000-row, 384-dimension real PGlite run compares the complete hybrid service
  with a vector-only control using the same 50-candidate vector source pool,
  alternates pair order, samples each topic evenly, excludes warmups, retains
  raw samples, and fails visibly when hybrid p95 exceeds 500 ms or additional
  p95 exceeds 100 ms. It bulk-builds HNSW after corpus insertion and perturbs
  query vectors so none exactly duplicates an indexed row. Plan evidence
  replays the exact measured repository SQL: natural-planner HNSW selection is
  required, while the lexical plan is reported honestly rather than forcing or
  claiming GIN selection. Unit tests pin the deterministic measurement/reporting
  contract; a small integration test pins real PGlite execution and the forced
  applicability-plan mode. Retained environment and baseline evidence lives in
  `docs/performance/hybrid-search-benchmarks.md`.
  Do not add a query/result cache on benchmark evidence alone: mutable
  local-first search data needs an explicit invalidation owner before cached
  answers can be correct.

  Live-query parameter comparison evidence is produced by the manual, uncached
  `pnpm --filter @brainstrike/db bench:live-query-params` command. It compares
  the current JSON-key strategy with the exact pre-PR-#728 recursive `deepEqual`
  snapshot from `a801ed0c8e63be7065d2ff596bfd2a2e0aea8b7d`, vendored in the
  manual script so production refactors cannot rewrite the baseline. It uses
  freshly allocated primitive, array, and complex-object params. Both strategies
  warm in balanced order, their measured order alternates, and the report uses
  ten-sample medians. The retained baseline and interpretation live in
  `docs/performance/live-query-parameter-benchmarks.md`; it currently refutes a
  lower-cost claim for the JSON-key path, so do not describe PR #728 as a
  measured render-cost improvement or change the default from this isolated
  microbenchmark alone.

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

Construct production and benchmark PGlite instances only via
`packages/db/src/pglite-factory.ts`; `scripts/__tests__/pglite-factory-contract.test.mjs`
enforces this ownership. The factory uses `PGlite.create()` to await engine
readiness and preserve typed client plugin namespaces. `ENGINE_EXTENSIONS`
is the single engine registry; `CLIENT_EXTENSIONS` contains `live`.

- `wasm-loader.ts` keeps its cached dynamic extension loaders and HMR reset only
  for `createPGliteClient` (the worker client's `live` plugin) and as a fail-fast
  preload; `createPGlite` constructs through the factory's static imports and
  caches the creation promise for persistent instances to prevent double-open.
- `pglite-worker-entry.ts` and `browser-first-run-bootstrap-worker.ts` use
  `createEnginePglite`; the multi-tab client installs `live`, while the
  short-lived bootstrap engines have no reactive client.
- `scripts/benchmark-binary-quantization.ts` uses `createBrainstrikePglite`.
- `apps/desktop/src/db-main.ts` dynamically imports
  `@brainstrike/db/pglite-factory`; its caller retains the vector catalog probe,
  initial sync and failure cleanup. Bare package imports stay external in the
  main-process build; this subpath imports only PGlite and its extensions.
  The obsolete core PGlite ambient declaration is removed so the factory options
  use vendor types. The contract guard has no remaining runtime exceptions.

Paired tests: `packages/db/__tests__/pglite-factory.test.ts` pins registry keys;
`pglite-factory.integration.test.ts` boots the direct, worker-init and bootstrap
factories and probes `pg_extension` after explicit extension installation.
`apps/desktop/src/__tests__/main/db-main.pglite-factory.test.ts` also boots the
real filesystem-backed desktop factory with full migrations and a live query;
it simulates the utility parent port and does not qualify an actual Electron
launch. The scripts contract rejects `any` types and construction suppressions
in the desktop DB host.
Loading the extension binaries does not itself execute `CREATE EXTENSION`;
callers and migrations continue to own that SQL and shutdown/drain behavior.
The DB unit project already includes real-engine integration files;
`pnpm --filter @brainstrike/db test:integration` selects every integration file
from that same project without changing the full unit suite's discovery.

Tests that deliberately construct bare or partial-extension engines remain
fixtures; migration fixtures must still load the full extension set (see
`drizzle-migrate.test.ts` / `drizzle-job-queue-compatibility.test.ts`).

### CLOSING a PGlite: drain first — an overlapping statement wedges it forever

`PGlite.close()` (verified on the pinned 0.5.5) deactivates the WASM backend
(`mod._pgl_setPGliteActive(0)`) **before** it awaits the shutdown protocol and
`closeFs()`, and `_checkReady()` only guards *entry*. A statement still in
flight at that moment enters `execProtocolRawSync`'s **synchronous** main loop
against a dead backend: neither that statement nor `close()` ever settles, and
because the spin is synchronous WASM the **event loop is blocked** — no timer,
no `AbortSignal`, no `Promise.race` timeout can recover it. `SIGKILL` is the
only exit.

Any close path must therefore drain in-flight work first. This is not
theoretical: it wedged a CI job to its 60-minute cancellation cap (BST-1320,
diagnosis and the Mastra-free repro in `docs/agents/mastra-boundary.md`;
upstream [electric-sql/pglite#1084](https://github.com/electric-sql/pglite/issues/1084)).
App-path reachability was **audited by code reading (2026-08-16,
BST-1329/BST-1330; not instrumented)**: desktop shutdown/factory reset cannot
hit it as an event-loop wedge — every statement reaching the DB-host utility
process is a serially dispatched envelope and `close()` runs only as the
`'close'` envelope, so overlap is impossible *as long as `db-host-entry.ts`
stays strictly serial*, and `DbHostManager` caps any in-host wedge at its 2s
ack-race kill. The `'close'`/`'reset'` handlers drain live-query handles first
(BST-1330). The reachable exposure is the **web direct path** — web factory
reset and the DbProvider prod-unmount close, tracked as **BST-1329**.

Drains mean **canonical join points only** — sleeps, `SELECT 1` flushes, and
`Promise.race` timeouts are rejected (a narrowed window is silent degradation,
and no timer can fire against the blocked event loop anyway). The sanctioned
seams, per surface:

- **Desktop (main process / DB host):** the reset barrier + scheduler idle
  join in `apps/desktop/src/platform/desktop-database-work.ts` (the idle join
  delegates to the shared `waitForDatabaseWorkSchedulerIdle` below), the
  awaited live-subscription cleanup in
  `apps/desktop/src/ipc-domains/db-ipc.ts`, and the in-host live-unsubscribe
  in `db-host-entry.ts`'s `'close'`/`'reset'` handlers (BST-1330).
  `resetDesktopDatabaseProfile` (`desktop-reset-platform.ts`) composes them:
  barrier → unsubscribe → idle → unsubscribe again → reset.
- **Web direct path (BST-1329):** `packages/db/src/db-reset-drain.ts` mirrors
  those seams for the renderer-owned PGlite — a reset-barrier scheduler facade
  (new submissions wait out an active reset; no browser `AsyncLocalStorage`,
  so reset-internal statements MUST run on the raw connection, never the
  scheduled handle), `waitForDatabaseWorkSchedulerIdle` over the renderer
  `DatabaseWorkScheduler`'s `getSnapshot`/`subscribe`, and a provider-level
  live-query drain registry that `usePGliteLiveQuery` unsubscribes route
  through (PGlite's live refreshes have no scheduler entry to join — the
  purge's own DELETEs trigger them). The web drain order is deliberately
  **idle join FIRST, then seal, then unsubscribe** — the reverse of the
  desktop's unsubscribe-first double-cleanup: the web barrier already blocks
  new subscriptions (`live.query` is scheduler work), so nothing can attach
  while the scheduler drains, and joining idle first means an idle-timeout
  abort leaves every live handle alive and subscribed instead of silently
  killing them all. Sealing the registry closes the tail where scheduler work
  settled before idle but its handle registration lands after the drain's
  snapshot: a sealed `register()` immediately initiates unsubscribe and the
  drain joins those late unsubscribes before returning; a failed reset
  unseals on barrier release. Both orderings now live in ONE React-free
  module, `packages/db/src/database-runtime.ts` (BST-1653):
  `createDatabaseRuntime().factoryReset` runs barrier → idle → seal →
  unsubscribeAll → purge → close, and `dispose()` (the prod unmount close)
  joins the in-flight initialization promise plus the same
  `drainDatabaseWorkForClose` before running the closer that
  `DatabaseTransport.detachConnection()` handed back (the direct transport
  registers its connection before `migrate()`, so unmount-mid-init is
  otherwise a close under running migration statements; the EARLIER half of
  that window — a client that finishes being created after dispose — is
  covered by `DatabaseTransportOpenContext.isDisposed`). A failed idle join
  aborts/skips the close loudly — never close over a drain you could not
  complete; past the seal the close is committed and unsubscribe failures
  warn and proceed. A DESKTOP reset never reaches that leg: the main process
  owns the database, so `electron-ipc-transport.ts` THROWS from both
  `hardReset()` (when its capability probe fails after the transport was
  already selected) and `purgeAndClose()` rather than handing the runtime a
  local purge that would resolve having destroyed nothing — the caller reloads
  on success, so a fall-through there is a factory reset that silently keeps
  the profile. Pinned by
  `packages/db/__tests__/db-reset-drain.test.ts` and
  `packages/db/__tests__/database-runtime.test.ts` (the invariants, with fake
  transports and no React) plus
  `packages/db/__tests__/electron-ipc-transport.test.ts` (the desktop
  transport's own reset contract, with the real transport);
  `factory-reset.test.tsx` and `db-provider-lifecycle.test.tsx` stay as the
  thin mount-level wiring checks.

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
  `packages/db/src/browser-first-run-bootstrap.ts`, wired in
  `pglite-direct-transport.ts`'s `open()` for `idb://` paths.
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

Delegated graph reads authorize against current native scope. A scope change hides
the branch; restoring the exact native scope restores visibility. This storage
layer does not promise permanent revocation or garbage collection. The host must
source child write identities from observed native delegation, never caller ids;
thread creation timestamps are not proof of ownership or delegation.

Before production host activation, note that createChild revalidates current root
workspace metadata even on duplicate delivery. Malformed current metadata rejects
a duplicate write; get still returns the original authorized binding. The host
must distinguish reading an existing invocation from creating a new one and must
not use duplicate createChild as a substitute for resume authorization.
