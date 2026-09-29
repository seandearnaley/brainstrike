# Database: Model Catalog Migrations, PGlite Extensions, First-Run Bootstrap

> Read before migrations, models, PGlite, or browser bootstrap. Rules are current;
> historical records live in `database/<topic>.md`.

## ATOMIC CHUNK AND JOB WRITES

- `insertChunksAndEnqueueEmbeddingJobs` uses one transaction: construct the chunk
  repository from its connection and pass its query surface to `insertManyWithTx`.
- The callback's `IDatabase` guarantees `query` only; query-only handles must not be cast to support nested transactions.
- `claimMany` atomically fails expired final-attempt leases once, releasing
  ownership/dedupe eligibility; live leases survive, and claims never refund attempts.

Guard: `packages/db/__tests__/job-queue-transactional-enqueue.test.ts`,
`packages/db/__tests__/job-queue-expired-lease.test.ts`.
Evidence: `database/job-queue-lease-exhaustion.md`.

## CHUNK SEARCH POLICY AND ATOMIC TRANSPORTS

- Chunk repository consumers use `IFileChunkRepository`; transport choice never
  enters UI consumer types. `repositories/file-chunk-search-policy.ts` owns the
  shared normalization, scope plans, distance expressions, query modes, and
  result mapping.
- Keep each adapter difference explicit rather than harmonised by guess: Drizzle
  alone rejects vector-search limits above 2,000 and keeps membership-only
  snapshot behaviour; raw/IPC snapshot scopes check expiry; empty file-path lists
  stay unfiltered while empty root lists match nothing.
- Search tuning through `SET LOCAL` and its SELECT share ONE atomic transaction —
  a callback transaction in-process, an ordered statement list through the IPC
  transaction primitive on Electron. Separate `BEGIN`/tune/SELECT/`COMMIT` calls
  do not hold the connection lock and are not a production search path. Missing
  atomic capability rejects explicitly; transport errors propagate. An exact
  vector scan needs no HNSW settings and may stay one direct query.
- Renderer assistant repositories probe migrated schema readiness and never
  create tables or constraints (`assistant-persistence.md` § RUN-EVENT /
  THREAD-RUN SCHEMA OWNERSHIP).

Guard: `packages/db/__tests__/chunk-search-adapter-parity.test.ts`,
`file-chunk-search-policy.test.ts`, `atomic-transaction.test.ts`,
`electron-file-chunk-repository.test.ts`.

## QUERY TELEMETRY BOUNDARY

- Instrument through the typed, memory-only collector in
  `packages/db/src/database-query-telemetry.ts`. Declare feature ownership at the
  call site; never classify a query by parsing SQL or parameters.
- Record only durations, failure counts, live subscription/update counts, and
  token lookup/hit totals. SQL, parameters, rows, paths, filenames, queue names,
  and content are prohibited. `docs/diagnostics-privacy-contract.md` is the
  cross-cutting privacy authority.
- Read the counters for what they are: rolling bucket totals (`queryCount`,
  `queriesPerMinute`, failures, token totals) are separate from the capped
  duration samples behind `sampleCount` / `droppedSampleCount`, and buckets are
  boundary-inclusive, so a nonzero count with zero retained samples is expected.
- Retention-clock failure latches per instance, stops timer-driven publication,
  and publishes a stable failed snapshot to `useSyncExternalStore`; imperative
  `snapshot()` still throws.
- Keep the existing seams when a query path moves: the renderer live-query
  scheduler, the Electron live-query bridge, the single embedding-queue poller,
  and `@brainstrike/token-cache`'s narrow lookup port wired by the file-explorer
  composition layer (no dependency back to `@brainstrike/db`). Folder-wide
  token-cache preloads record duration and failure with zero lookup/hit counts:
  they are population reads, not cache-hit decisions.
- `createScheduledLiveQueryHandle` OWNS its terminal state. It admits exactly one
  listener, releases ownership on the first teardown attempt, treats repeated
  unsubscribe as idempotent, and rejects later subscribe/refresh; a caller that
  wants to continue creates a fresh handle.

Settled: no same-handle retry/reactivation; upstream offers no retry. Guard named seams with `scripts/__tests__/database-telemetry-seams-contract.test.mjs`.
Evidence: `database/query-telemetry-scheduled-handles.md` (file-record, token-cache, queue poller, live-query coverage and limits).

## DESKTOP LIVE-QUERY MEMORY TEST DIAGNOSTICS

- The database-demo memory hooks, the remote ownership snapshot, and the
  main-process `__brainstrike_e2e_db_live_query_diagnostics__` exist only in explicit
  test mode and are removed with their handlers. A missing test mode or diagnostic
  function throws rather than returning a fabricated zero, and
  `DbHostManager.getDiagnostics()` strips `activeLiveQueryCount` from the normal IPC
  result.
- Snapshots stay bounded and carry no SQL, parameters, content, paths, or complete
  result arrays; the generation ledger holds at most 256 `WeakRef`s and never a strong
  reference to a result array or a row.
- `db:live-query:start` attaches teardown listeners for all three owner shapes
  (`'destroyed'`, `'render-process-gone'`, `'did-navigate'`); any firing removes all
  three, bumps the per-owner generation, and cleans up that owner's subscriptions, and
  a start whose handle await straddles a reap tears its handle down. Why: a reload
  preserves the `WebContents`, so `'destroyed'` alone leaks.
- Memory release means superseded result arrays and handles stop accumulating, NOT
  evicting inactive database-demo pages: that surface retains one page per visited
  collection on purpose.
- Regression assertions are computed deltas and cache cardinalities, never hardcoded
  absolute counts. Heap assertions need real forced collection and real heap reads: the
  E2E launcher passes `--js-flags=--expose-gc` and `--enable-precise-memory-info`, and
  `forceRendererGarbageCollection` throws when `window.gc` is unavailable.
- Database IPC channel, role, envelope, and parser declarations live in
  `apps/desktop/src/ipc-domains/database.contract.ts`; main keeps a narrow event-aware
  registration adapter because admission and ownership need the authenticated
  `IpcMainInvokeEvent`. Keep the visible live-update multiplexer's shared listener and
  local subscriber isolation.

Settled: generation-ledger identity assertions are the primary retained-result
proof; heap and working-set bounds are independent, not substitutes. Evidence:
`database/live-query-memory-diagnostics.md`.
Guard: `apps/desktop/e2e/database-live-query-memory.desktop.test.ts`,
`scripts/__tests__/desktop-memory-dispatch-contract.test.mjs`.

## MANAGED-CACHE BATCH ADMISSION

- Count every SQL bind before opening a transaction, and keep the batch limit and
  the emitted parameter array aligned when adding a column. Imports bind one value
  per import column; replacements additionally bind one embedding-set id outside
  their per-record VALUES list.
- The replacement boundary is 6,553 rows (65,531 parameters); 6,554 rows reject
  before any mutation.

Guard: `packages/db/__tests__/managed-cache-batch-parameter-limit.test.ts`.

## DATABASE WORK SCHEDULER FAIRNESS

- `DatabaseWorkScheduler` is the single-process admission boundary around each
  PGlite host. Foreground work gets a 75 ms quiet window after its latest arrival;
  once the background lane has waited 250 ms the scheduler admits exactly one
  background task, then returns to foreground-first ordering.
- At least one queued foreground/normal task must be admitted before another
  background bypass. The wait clock restarts at each background admission — even
  while that task runs — so the guarantee is one admission per bound, not a
  per-task latency ceiling; clock and pending-turn requirement reset when every
  queue drains. `forcedBackgroundAdmissionCount` counts starvation-rule admissions
  only and is the authoritative diagnostic that the bound fired.
- Run-scoped assistant operations enter the SAME scheduler as `foreground`.
  State/reset ownership lives in Node-safe `desktop-database-work-scheduler.ts`;
  Electron only adapts IPC. Saturated-host retry re-enters foreground; wedges and
  transaction timeouts fail visibly as `DbHostRequestTimeoutError`.
- `backgroundStarvationMs` must be positive and finite, `foregroundQuietMs`
  non-negative and finite; invalid values throw rather than disabling a fairness rule.
  All fairness, wait, and service timing is monotonic, and snapshots carry elapsed
  timestamps from that origin so `DatabasePressureController` can age windows over IPC.
  Wall-clock timestamps are diagnostic only.
- Keep background-lane work short and bounded; background priority is not authority to
  run an unbounded maintenance statement. The desktop process-counter sampler is the
  one recurring non-maintenance consumer, and it skips a tick whose previous sample is
  still outstanding rather than queueing another.
- Both desktop maintenance schedulers gate through
  `apps/desktop/src/maintenance-admission.ts`:
  - A pass begins only after the work scheduler has been CONTINUOUSLY idle for
    `quietPeriodMs` (default 15 s, via `subscribeToSchedulerSnapshots`), and
    `start()` seeds the window as busy so booting never counts as quiet. The HNSW
    scheduler requires the subscription; there is no single-sample mode.
  - Inside the background lane, immediately before the statement,
    `readInFlightAssistantWork` runs: any `brainstrike_assistant_thread_runs` row in
    `running`/`cancelling`, or `mastra_background_tasks` row in `pending`/`running`,
    skips the pass with reason `assistant-work-in-flight`, logged at info so a stuck
    row stays visible. A malformed read throws; it never reads as idle. A task
    suspended on the user does not block.
  - The gate reads those rows across EVERY thread, so the desktop startup reaper
    (`reapOrphanedThreadRuns`, `assistant-persistence.md`) is part of this contract,
    and the background sweep runs after the native-decision repair.
- On exclusive desktop boot, before maintenance triggers start, reclaim persisted
  `running` HNSW maintenance as pending; routine ticks must not reset live-owner rows.
- Run-scoped work must be ON the scheduler, so a run started during a statement waits there instead of timing out at the host.
- A maintenance failure matching `isCorruptionError` enters runtime corruption recovery with context `'maintenance'`;
  any other maintenance failure is only logged (`platform-contracts.md` § RUNTIME DATABASE CORRUPTION RECOVERY).

Settled: boot evidence, not row age, proves an orphaned row is dead — age is a
guess that can kill live work, and neither table carries a heartbeat. Evidence: `database/maintenance-admission.md`.
Guard: `apps/desktop/src/__tests__/dimension-index-maintenance-scheduler.test.ts`
("admission"), `database-maintenance-scheduler.test.ts` ("assistant work
admission"), `maintenance-admission.test.ts`,
`maintenance-admission.integration.test.ts`,
`packages/db/__tests__/thread-run-startup-reaper.integration.test.ts`,
`packages/db/__tests__/dimension-index-maintenance.test.ts` (persisted recovery), `apps/desktop/src/__tests__/main/boot-order.test.ts` (exclusive boot order).

## MODEL CATALOG MIGRATIONS (CRITICAL)

Adding, removing, or renaming a supported AI model is a multi-layer change.
Updating only the static catalog is NOT enough — the in-app model picker is driven
by a DB-backed catalog. `scripts/gen-model-catalog-migration.mjs` cites these rules
by number; keep the numbering stable.

1. Update the static provider catalog (single source of truth):
   - packages/assistant-contract/src/provider-catalog.json
   - The catalog is DATA, not a TypeScript literal. `scripts/model-catalog-migration-contract.mjs` and `scripts/__tests__/provider-env-keys-mirror-contract.test.mjs` read it with `JSON.parse`. No catalog field may reference a constant, because JSON cannot; comments are optional `_note` strings that `parseProviderCatalog` strips.
   - `tsc` does not check catalog rows, because JSON widens under `resolveJsonModule`: `packages/assistant-contract/src/provider-catalog-schema.ts` does, at module load, and THROWS. It is a `strictObject`, so an unknown or misspelled key fails rather than being dropped.
   - `provider-registry.ts` keeps the types and accessors only, so a new field is
     added to the schema AND the interface in the same change.
2. Add a numbered DB migration that upserts/deletes catalog rows with a `ledgerKey`,
   and INSERT it into `packages/db/src/migrations/index.ts` at its ascending-`version`
   position; the Drizzle ledger is derived. Never append — `migrate.ts` applies the
   derived array in ARRAY order, so appending silently inverts apply order.
   - For pure ADDITIONS generate it: `node scripts/gen-model-catalog-migration.mjs`
     prints the plan, `--write` emits the file and registers it. It leaves `tagline`
     and `best_for` NULL for a human to author per rule 7.
   - It is ADD-ONLY: it refuses a disappeared catalog row (that needs the rule-4
     remaps and a user-visible notice first — a whole provider leaving is that same
     removal, not residue), an id the DB catalog already holds under another provider
     or type, and a model missing `vision`, `supportsStreaming`, or
     `defaultDimension`.
   - `ledgerKey` is the persisted `__drizzle_migrations.hash` and never changes once
     shipped. `drizzle/migrate.ts` derives `customMigrations` from the numbered
     manifest, excluding the versions folded into the immutable drizzle-kit snapshot
     (008 stays numbered-only, ADR-0002). Unfolded migrations must have SQL-string
     `up`; derivation throws for callbacks.
3. Preserve user choices on kept rows with
   `ON CONFLICT (id) DO UPDATE SET ... is_enabled = models.is_enabled`.
   - INVARIANT: never `is_enabled = EXCLUDED.is_enabled` for a catalog refresh — it
     clobbers the user's toggle. Force on/off only for a deliberate swap.
   - Sibling invariant: never write `models.updated_at` or `created_at` either — it is
     the per-row record of user intent. See `docs/agents/assistant-providers.md` § "`is_enabled`
     is not evidence of user intent"; guarded by `scripts/__tests__/model-catalog-migration-contract.test.mjs`.
4. Remap dropped IDs so persisted selections do not dangle: `MODEL_ID_MIGRATIONS` in
   packages/app-state/src/stores/assistant-model-id-migrations.ts (bump
   `ASSISTANT_PREFERENCES_STORE_VERSION`) and `MEMORY_MODEL_TARGET_MIGRATIONS` in
   assistant-memory-preferences-store.ts (also self-heals on rehydration).
   - A remap that changes the user's SELECTED model is not silent: the persist
     migration records it in session-only `modelMigrationNotices` and
     `useModelMigrationNotices` turns it into one toast. Retired defaults under
     providers the user is not running on, and enabled-list-only remaps, stay quiet —
     `modelsByProvider` is seeded for every provider and is not evidence of intent.
5. Add new `packages/db/__tests__/**/*.test.{ts,tsx}` files without a lane-registry
   edit. The `unit` Vitest project discovers that tree recursively; required Unit and
   nightly coverage both supply the complete `DB_TEST_SHARD=1/2` + `2/2` set to that
   project, where Vitest applies its native shard. The value is a DB-task environment
   input, never a Turbo CLI passthrough. Do not recreate a registration map for test
   placement.
6. Every LLM model entry MUST declare `contextWindow` (and `maxOutputTokens` when
   documented) in packages/assistant-contract/src/provider-catalog.json —
   schema-enforced at module load, static-registry-only, no DB migration. It drives
   the thread context meter and the auto-derived `agentLoop.inputTokenLimit`.
7. `tagline` on a registry LLM entry is OPTIONAL, registry-only composer copy; the DB
   catalog's own tagline/description column feeds db-explorer instead, so a registry
   tagline change needs no migration. Omit rather than invent copy.
8. Every LLM model entry MUST also declare `vision` ('supported' | 'unsupported';
   never 'unknown' in the static registry). It gates the composer image-attachment
   affordance per selected model, and unlike `contextWindow` it IS mirrored into the
   DB catalog: new model rows include `"vision"` in the capabilities jsonb.

The Drizzle runner is the sole production migration authority; the numbered runner is
`schema-validation-only`, enforced by
`packages/db/src/architecture/db-migration-authority.ts`. Three schema differences
pre-date BST-1643 (Drizzle-only `embedding_cache` and `token_cache`, numbered-only
`file_records.embedding`); the parity test freezes them in a shrink-only allowlist, so
they may be removed but never added to.

Evidence: `database/model-catalog-layers.md`.
Guard: `scripts/__tests__/model-catalog-migration-contract.test.mjs`,
`scripts/__tests__/gen-model-catalog-migration.test.mjs`,
`scripts/__tests__/db-test-discovery-contract.test.mjs`,
`packages/db/__tests__/drizzle-ledger-keys.test.ts`,
`drizzle-migration-manifest.test.ts`, `migration-manifest-order.test.ts`,
`drizzle-migration-parity.integration.test.ts`, `provider-registry-vision.test.ts`.

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

## Delegated conversation graph

- Migration 126 owns `brainstrike_delegated_conversations`: an immutable root anchor
  plus child nodes keyed by actual native thread id, with owner, parent, native
  resource, configuration, display identity, and workspace snapshot in separate
  columns. The composite parent FK forbids linking across root/owner boundaries.
- Children are created only beneath existing ancestors; there is no reparent
  operation, and conflicting duplicate delivery fails. A new direct child snapshots the
  root's current `operatingRootId`, nested children inherit their parent's snapshot,
  and re-delivery preserves the existing node and its workspace.
- Native thread deletion cascades graph nodes but NOT descendant native transcripts:
  expand the branch through `DELEGATED_THREAD_DELETE_CTES`, verify the live root and
  every ancestor and descendant resource, and reject the whole command on an ownership
  mismatch rather than deleting partially.
- A standalone Mastra store legitimately has no graph table and keeps single-thread
  behaviour after its table probe.
- The graph is in the shared reset registry and all three table-enumerating clear paths.
- Reads authorize against CURRENT native scope, so a scope change hides the branch and
  restoring the exact scope restores it; this layer promises no permanent revocation or
  garbage collection. Source child write identities from observed native delegation,
  never caller ids — a creation timestamp is not proof of ownership.

Evidence: `database/delegated-conversation-graph.md`.
Guard: `packages/db/__tests__/delegated-conversations.integration.test.ts`.

### Human continuation admission

- Migration 135's receipt tables let a human wake reuse the authorized native
  child/resource and immutable profile with a new receipt, root host leg, and native
  run. It never invents a parent tool call or rewrites the original invocation.
- Admission and the durable tree/child budget reservation share one transaction. Input
  IDs are global immutable request identities; duplicate IDs and overlapping active root
  admissions fail, and reusing an ID under another root never reveals, replaces, or
  replays the other receipt.
- Keep the refusals distinguishable: an identical existing receipt gives
  `continuation-input-already-admitted` and a changed child/text
  `continuation-input-id-conflict` — neither means the input was undelivered. Only a
  fresh admission refusal reports `continuation-input-not-admitted`.
- Ambiguous crash receipts never automatically resend user input. An unclaimed persisted
  approval/question stays pending for an explicit exact native decision, only the owning
  live host may release a claim before native execution, and a failed cancellation join
  is a failed Stop rather than a successful cancellation.
- A decision resume retains the receipt's originating turn and budget, and consumes the
  exact leaf native run/tool call so sibling leaves with identical tool-call IDs stay
  distinct. Nested paths start at the continuation child.
- Usage uses the existing root-attributed table, one row per continuation/current host
  leg: redelivery within a leg takes maxima, separate resume legs stay additive, and the
  nullable continuation FK is `ON DELETE SET NULL` so child deletion retains spent root
  tokens. Persist observed native finish totals, never invented per-step deltas.
- Discovery reauthorizes each owned pending receipt through the graph, then verifies its
  exact saved pending decision with an inert native reader; receipt rows alone never
  manufacture a resumable control, and unauthorized or malformed saved state fails
  discovery visibly rather than returning an apparently complete partial list.
- There is no persisted conversation archive field; worktree archive is a separate
  contract, not conversation ownership.

Evidence: `database/human-continuation-admission.md`.

### Native invocation identity

- Migration 127's `brainstrike_delegated_invocations` has the immutable key root thread
  + observed native parent run + parent tool call. A conversation may have several
  invocations, and persona identity substitutes for neither. Keep the host leg id and
  the native parent run id separate: Mastra mints its own run ids and approval or
  suspension creates new host legs.
- `createInvocation` requires an already authorized child graph node and a real root
  host run row of the same owner/root, and snapshots that row's nonblank
  `turn_message_id`.
- `bindInvocationRun` checks the observed persona against the stored invocation before
  recording the native child run, on initial bind and on duplicate/resume authorization
  alike; a mismatch never changes the record. Exact duplicate delivery is idempotent, a
  different child run is rejected, resume READS the existing invocation rather than
  creating it with the resume leg id, and no placeholder native run id is invented
  before the first child stream chunk.
- Reads and run binding revalidate the whole native ancestry and the original host row's
  owner/root/turn in the same SQL mutation, so a stale preliminary scope read cannot
  authorize a changed resume leg.
- There is no age or count pruning of host run rows; a future retention policy must
  retain rows while descendants can resume, or atomically delete the complete branch,
  and must never silently orphan resumable identity. Reset helpers issue `DELETE`, not
  `TRUNCATE`.
- `recordInvocationUsage` requires authorized ancestry, a bound child run, and matching
  child thread/resource/persona and original/current host turns; it reconciles
  cumulative provider totals with monotonic maxima on one row, and a model/provider
  change rejects instead of rewriting attribution. Legacy rows stay NULL — the host
  never guesses historical child identity — and deleting an invocation sets only the two
  delegation keys to NULL.
- `createChild` revalidates current root workspace metadata even on duplicate delivery,
  and is never a substitute for resume authorization.

Evidence: `database/native-invocation-identity.md`.
Guard: `packages/db/__tests__/delegated-invocations.integration.test.ts`.

## ASSISTANT THREAD GROUP PRESENTATION

- Thread groups live in `brainstrike_assistant_thread_groups`, not Mastra metadata.
  Migration 143 keeps 18 semantic colors; 144 adds canonical family child tokens.
  Match SQL and types; admit colors tree-wide once. Evidence: `database/agent-family-colors.md`.
- Every schema change here — a presentation column, a sidecar, a constraint replacement
  — is added to `migrations/index.ts` with a `ledgerKey`; the Drizzle ledger is derived.
  Renderer repositories only probe schema readiness and never create or alter tables or
  constraints, so a TypeScript union widened without its migration fails at real PGlite
  insert time.
- A new sidecar is registered in FOUR places: the shared factory-reset registry, all
  three table-enumerating clear paths, the thread-delete sidecar list where it belongs,
  and the renderer schema probe — the renderer's thread-delete CTE references every
  registered sidecar unconditionally even when desktop main owns the writes.
- Rows in these ledgers carry ids, timestamps, numeric sizes, booleans, and explicitly
  allowlisted payload shapes. Raw tool inputs and outputs, message content, prompts, and
  file contents are prohibited. Where a payload is versioned, schema evolution happens
  in the payload version, not DDL churn.
- A ledger leaves historical rows NULL rather than backfilling fabricated evidence, and
  keeps the pre-split meaning of any column it redefines (`truncated` now means exactly
  "model-facing output was clipped"; `engine IS NULL` marks pre-092 folded rows, which
  the lens reports as `substrate_degraded_rate` rather than truncation).
- Retention on the 60-day ledgers runs inside `runScheduledDatabaseMaintenance` — no new
  scheduler or timer. Idle passes run an unbounded age-DELETE; active-queue passes run a
  cheap `SELECT EXISTS` guard probe, then an `activePruneLimit`-bounded
  `ORDER BY occurred_at ASC` delete. Any new retention predicate needs an index leading
  with its own column, and the table joins
  `DEFAULT_DATABASE_MAINTENANCE_VACUUM_TABLES` because PGlite has no autovacuum.
- Never amend a shipped migration to introduce a later schema: an existing profile must
  traverse the same upgrade. MCP task authority epochs are minted forward (a higher
  generation retires the epoch, a lower same-runtime generation is stale), and every
  create/update statement requires the exact live epoch/runtime/generation lease.
- A table whose rows outlive threads (the forge PR cache) is NOT a thread-delete sidecar
  but IS in every factory-reset path.
- Tables owned here whose full contract lives in `assistant-persistence.md`: the thread
  hybrid-search index, run errors, canvas versions, and the stale tool-projection
  rewrite overlays.

Settled: a standalone counters ledger modeled on migration 083 is the
least-new-mechanism seam for a new numeric signal; extending
`brainstrike_assistant_run_usage` would transport an agent-only diagnostic across a
process boundary without improving attribution. Evidence:
`database/assistant-sidecar-migrations.md`,
`database/tool-call-telemetry-substrate-and-retention.md`.
Guard: `packages/db/__tests__/reset-table-registry.test.tsx`,
`scheduled-database-maintenance.test.ts`,
`search-lens-self-improvement-signal.test.ts`,
`migration-085-tool-call-telemetry-occurred-at-index.test.ts`,
`packages/assistant-data/src/__tests__/thread-workspace-contract.test.ts`.

## MANAGED WORKTREE LEDGER

- `brainstrike_worktrees` records every linked git worktree BrainStrike itself created
  (`created_by IN ('agent','user')`), keyed by `path` (UNIQUE) and realpath'd
  `repo_common_dir`, with each setup outcome's closed status, bounded output, and
  nullable user-facing reason.
- It is the authorization source for the one sanctioned picker-less root mount besides
  recents (`isManagedWorktreePath` → `isAuthorizedWorktreeMountPath`; a live row must
  also be reachable per adoption's `assertReachable` rule, `workspace-context.md`) and
  the provenance source the git inventory joins for `'both'` / `'agent-reported'`.
- Boot-time root reconciliation reads `WorktreeService.listManagedPaths()`, which
  returns only `{ id, path }`; `WorktreeService.list()` stays the full inventory-joined
  UI surface.
- Three omissions are load-bearing: no `root_id` (derive `roots.id` by path); no foreign
  keys and NOT in `THREAD_DELETE_SIDECAR_TABLES` (a worktree outlives its thread —
  thread delete offers "also archive its worktree" instead); not part of the assistant
  memory schema probe.
- Registered in both runners and in `BRAINSTRIKE_RESET_TABLES`. Factory reset clears the
  ROWS; deleting worktree DIRECTORIES is a separate, explicitly confirmed step
  (`platform-contracts.md`).
- Any migration merged to a long-lived branch counts as shipped and is never amended in
  place; corrections use a new additive forward-only migration. Why: execution on a
  shared branch cannot be disproven.

Evidence: `database/managed-worktree-ledger.md`.

## TABLE DURABILITY CLASSES

- `table-durability-registry.ts` classifies every table as `precious`, `derived`,
  `operational` or `schema-ledger`; `getTableDurability` throws for an unregistered table
  and never guesses. Class is per TABLE, decided by what a row means, not who wrote it.
- `precious` (user or user-intent state, LLM output that costs a model call, suspended
  runs, user toggles) is never truncated by automated repair and is in every portable
  export. `derived` may be truncated and rebuilt; `operational` may be truncated without
  a rebuild; `schema-ledger` is never truncated and always exported.
- `derived` requires `rebuildOwner` (`path/to/file.ts#symbol`), an existing automatic rebuild
  path the union type enforces and the guard resolves; none, not derived.
- Before truncating ANY non-precious table, repair names to the user each scope it cannot
  rebuild and any user-visible pending work it would drop, never silently; `reason` records it.
- A new table is classified in the same change; the integration guard fails otherwise.
- No foreign key runs from a precious table to a non-precious one. Why: `TRUNCATE ... CASCADE`
  empties every referencing table whatever its rule, and `SET NULL` rewrites precious rows.

Evidence: `database/table-durability-classes.md`.
Guard: `packages/db/__tests__/table-durability-registry.integration.test.ts`,
`table-durability-registry.test.ts`.

## PGLITE EXTENSION INVARIANT

Every PGlite construction site MUST load the same engine-extension set, or the
corresponding `CREATE EXTENSION` migration fails with a cryptic "could not open
extension control file" error on that path only:

- `vector` (pgvector, from `@electric-sql/pglite-pgvector`)
- `pg_trgm` (from `@electric-sql/pglite/contrib/pg_trgm` — powers
  `brainstrike.grepSearch`'s trigram prefilter, migration 038)
- `pg_textsearch` (BM25 index AM, from `@electric-sql/pglite-pg_textsearch`)
- `live` (client-side reactive queries — loaded everywhere EXCEPT the two live-less
  worker hosts: `pglite-worker-entry.ts`, where the PGliteWorker client installs it, and
  `browser-first-run-bootstrap-worker.ts`, whose short-lived bootstrap instances serve
  no reactive queries)

Rules:

- The pglite/pgvector/pg_textsearch family is version-qualified and pinned together in
  ONE place, the `catalog:` block of `pnpm-workspace.yaml`. Never bump one member
  independently: a mismatched pair throws "PGlite failed to initialize properly" before
  any SQL runs. The literal triple and `QUALIFIED_PG_TEXTSEARCH_VERSION` are pinned by
  `packages/db/__tests__/migration-066-restore-pg-textsearch.test.ts`; the qualification
  record is `packages/db/src/pg-textsearch-compatibility.ts`.
- Migration 065 drops the historical index/extension; 066 recreates them only after
  checking `pg_extension.extversion` equals the qualified version, so package drift
  aborts visibly before BM25 writes begin.
- Any future extension or PGlite bump must change the exact migration guard, move the
  whole peer-compatible family, pass repeated runs of the opt-in durability gate
  (`pnpm --filter @brainstrike/db test:pg-textsearch-durability`) on every supported
  desktop platform, and pass the normal migration/repository suite. A bump whose
  published tarballs are byte-identical apart from their own version and peer pin
  carries the qualification forward — re-derive that by diffing payloads, never assume.
- BM25 orders but never matches: the lexical arm matches through migration 034's
  generated tsvector + GIN index and orders with the migration-066 BM25 index, so recall
  is bounded by the tsvector arm. pg_textsearch owns BM25 normalization.
- `CRASH_SENSITIVE_INDEX_ACCESS_METHODS` (`packages/db/src/crash-sensitive-indexes.ts`) is the
  list of index AMs WAL recovery does not restore (`bm25`: pg_textsearch #430/#426).
- When the exact English `plain` arm returns zero rows, all three file-chunk
  repositories may run ONE bounded `pg_trgm` fallback on the index-supported
  `$query <% content` predicate, pinning its session GUC and explicit `fuzzyThreshold`
  to the same value (default `0.6`) and returning `matchKind: 'fuzzy'`. It reuses every
  scope from the exact arm, never applies the unbounded BM25 `threshold` to the 0–1
  fuzzy domain, and omits `ts_headline` because a misspelled tsquery has no honest
  highlight. Websearch and phrase modes stay exact-only, stopword-only tsqueries stay
  honestly empty, and `fuzzyFallback: false` is an explicit opt-out.
- Performance evidence comes from the manual, uncached `bench:hybrid-search` and
  `bench:live-query-params` commands, with baselines in `docs/performance/`. Do not add
  a query/result cache on benchmark evidence alone — mutable local-first search data
  needs an explicit invalidation owner first — and do not change the live-query
  parameter default from that microbenchmark.

Construct production and benchmark PGlite instances only via
`packages/db/src/pglite-factory.ts`, which uses `PGlite.create()` to await engine
readiness and preserve typed client plugin namespaces. `ENGINE_EXTENSIONS` is the single
engine registry; `CLIENT_EXTENSIONS` contains `live`. The sanctioned construction sites
are `wasm-loader.ts` (cached dynamic loaders and HMR reset only for
`createPGliteClient`; `createPGlite` caches the creation promise for persistent
instances to prevent double-open), the two worker entries via `createEnginePglite`, the
quantization benchmark, and `apps/desktop/src/db-main.ts`, which dynamically imports
`@brainstrike/db/pglite-factory` so bare package imports stay external in the
main-process build. The contract guard has no runtime exceptions.

- Loading the extension binaries does not execute `CREATE EXTENSION`; callers and
  migrations own that SQL and shutdown/drain behaviour.
- Tests that deliberately construct bare or partial-extension engines are fixtures;
  migration fixtures must still load the full set.

Settled: greenfield is the entire install population, so migration 066's guard protects
every install that will ever exist; extension qualification is macOS-arm64 only, with
Linux/Windows owed. Evidence: `database/pg-textsearch-qualification.md`.
Guard: `scripts/__tests__/pglite-factory-contract.test.mjs`,
`packages/db/__tests__/pglite-factory.test.ts`,
`pglite-factory.integration.test.ts`, `fts-search-options-contract.test.ts`,
`file-chunk-repository.test.ts`,
`apps/desktop/src/__tests__/main/db-main.pglite-factory.test.ts`.

### A WebAssembly trap poisons the PGlite instance — it never spins (BST-1221)

- `patches/@electric-sql__pglite@0.5.8.patch` is the ONE sanctioned change to
  PGlite: stock 0.5.8 retries a trapped `execProtocolRawSync` iteration forever
  against a blocked event loop; the patch throws `PGliteFatalTrapError` instead,
  naming the exit status and carrying the trap as `cause`.
- A trapped instance is POISONED. Later protocol calls and startup packets reject
  with that fatal as `cause`, the loop runs no WASM finalizers, and `close()`
  releases the instance and then rethrows — a trapped instance never ends a test
  or a session cleanly. Ordinary PostgreSQL errors keep the longjmp path.
- Never widen the patch beyond that loop. When a PGlite release terminates the
  loop itself, drop the patch and rewrite the guard's precondition against the
  upstream fix.

Settled: fail closed — never a retry, a fallback or a timeout.
Evidence: `database/pglite-fatal-trap.md`.
Guard: `packages/db/__tests__/pglite-fatal-trap-fail-closed.integration.test.ts`,
which proves the patched loop is under test before it simulates a trap.

### CLOSING a PGlite: drain first — an overlapping statement wedges it forever

- `PGlite.close()` deactivates the WASM backend BEFORE it awaits the shutdown
  protocol, and `_checkReady()` only guards entry, so a statement still in flight
  runs `execProtocolRawSync`'s SYNCHRONOUS loop against a dead backend. It either
  traps — fatal and named, per the rule above — or blocks the event loop past any
  timer, `AbortSignal` or `Promise.race`, leaving `SIGKILL` the only exit.
- Every close path drains in-flight work first, through CANONICAL join points only.
  Sleeps, `SELECT 1` flushes, and `Promise.race` timeouts are rejected: a narrowed
  window is silent degradation, and no timer fires against a blocked event loop.
- Desktop composes the reset barrier, scheduler idle join, awaited live-subscription
  cleanup, and in-host live-unsubscribe as barrier → unsubscribe → idle → unsubscribe
  again → reset. Keep `db-host-entry.ts` strictly serial; that seriality is what makes
  desktop overlap impossible.
- Web mirrors those seams in `packages/db/src/db-reset-drain.ts` — a reset-barrier
  scheduler facade (reset-internal statements MUST run on the raw connection, never the
  scheduled handle), `waitForDatabaseWorkSchedulerIdle`, and a provider-level live-query
  drain registry that `usePGliteLiveQuery` unsubscribes route through. Its order is idle
  join FIRST, then seal, then unsubscribe — deliberately the reverse of desktop. Why:
  the web barrier already blocks new subscriptions, and joining idle first means an
  idle-timeout abort leaves every live handle alive instead of silently killing them all.
- Both orderings live in ONE React-free module, `packages/db/src/database-runtime.ts`:
  `factoryReset` runs barrier → idle → seal → unsubscribeAll → purge → close, and
  `dispose()` joins the in-flight initialization promise plus `drainDatabaseWorkForClose`
  before running the closer `DatabaseTransport.detachConnection()` handed back.
- A failed idle join aborts/skips close loudly; past seal, close is committed: unsubscribe failures warn and proceed.
- Direct close failures emit `database_close_failed`; only exact `PGlite is closed` is benign.
- A desktop reset never reaches that leg: `electron-ipc-transport.ts` THROWS from both
  `hardReset()` and `purgeAndClose()` rather than handing back a local purge that would
  resolve having destroyed nothing. Why: the caller reloads on success, so a
  fall-through is a factory reset that silently keeps the profile.

Evidence: `database/pglite-close-drain.md` (the Mastra-free repro is in
`mastra-boundary.md`).
Guard: `packages/db/__tests__/db-reset-drain.test.ts`, `database-runtime.test.ts`,
`electron-ipc-transport.test.ts`, with `factory-reset.test.tsx` and
`db-provider-lifecycle.test.tsx` as thin mount-level wiring checks.

### The test snapshot `globalSetup` lives on ONE project — do not hoist it

- `packages/db/vitest.config.mts` declares
  `globalSetup: ['./__tests__/helpers/db-snapshot-global.ts']` on the `unit` project
  ONLY. It runs the numbered-migration chain once and `provide()`s the tarball path, so
  per-test boots are cheap `loadDataDir` restores.
- Declaring it on a second project re-runs the chain per project. Hoisting it to the
  root `test` config makes it run under EVERY `--project` filter, including
  `--project browser`, which would build and discard a migrated snapshot on every
  Browser tests run.
- The rule is one declaration PER CONFIG, not one per package:
  `packages/db/vitest.mutation.config.ts` correctly declares the same `globalSetup`
  because the Stryker lane is a separate `vitest run` invocation. The contract test
  inspects `vitest.config.mts` only, for that reason.
- Snapshot building is per-PROCESS: each native DB shard is its own `vitest run` and
  builds one snapshot, shared by the files it selects.
- The agent integration lane's narrower equivalent
  (`packages/agent/src/__tests__/helpers/migrated-agent-test-db.ts`) restores per test
  through `createEnginePglite`, so it carries the same full extension set as production.
  Cold schema creation, initialization retry, and missing-sidecar cases keep their
  explicit empty-database or mock path.

Evidence: `database/snapshot-global-setup.md`.
Guard: `packages/db/__tests__/vitest-global-setup-contract.test.ts`.

---

## BROWSER FIRST-RUN FAST BOOTSTRAP (idb:// STORES)

The fast path creates a MISSING `idb://` store greenfield in seconds WITHOUT relaxing
durability on the persistent store: initdb + all migrations run in a throwaway
`memory://` PGlite; `dumpDataDir('none')` captures a tarball; a short-lived STRICT
(`relaxedDurability: false`) PGlite opens the real store with `loadDataDir` and one
explicit awaited `syncToFs()` flushes the whole data dir in a single atomic pass; only
after that flush plus an existence re-probe is bootstrap complete. Orchestration lives in
`packages/db/src/browser-first-run-bootstrap.ts`, wired into
`pglite-direct-transport.ts`'s `open()`, over a pipeline and a DEDICATED plain worker
(itself a PGlite construction site) with a fail-loud 5-minute timeout.

Invariants:

- Dump/load into a STRICT instance is the only public-API path with a guaranteed awaited
  flush. Never rebuild this on "relaxed bootstrap + syncToFs + strict reopen": on a
  relaxed instance `syncToFs()` fire-and-forgets and `close()` does not flush at all.
- Never run the bootstrap through PGliteWorker sessions. Why: leader election rejects
  in-flight RPCs with 'Leader changed, pending operation in indeterminate state'. The
  dedicated worker has no election and no RPC layer, and the dump never crosses a thread
  boundary. `pglite-worker-entry.ts` stays untouched — no `loadDataDir` on its wire, so a
  leader takeover can never replay a stale load.
- Crash safety: the localStorage marker `brainstrike.pgliteFirstRunBootstrap:<dataDir>`
  is written before the first IndexedDB write and cleared only after the strict flush.
  Marker + store on a later launch deletes the partial store (warn-logged) and re-runs
  greenfield, safe because a store whose marker never cleared holds no user data. Factory
  reset's `localStorage.clear()` covers the marker.
- Capability-gated, never silent: missing IndexedDB, Web Locks, or usable localStorage
  each SKIP with an explicit logged reason and the pre-existing strict slow path runs
  instead; a bootstrap FAILURE rejects into DbProvider's visible init error state. No
  fallback.
- Multi-tab runs serialize on the `brainstrike-pglite-first-run:<dataDir>` Web Lock; the
  loser re-probes inside the lock and skips (`existing-store`).
- Scope is browser `idb://` only, including per-session `idb://web-e2e-*` Playwright
  stores. `opfs-ahp://` and desktop keep their existing paths.

Evidence: `database/browser-first-run-bootstrap.md`.
Guard: `packages/db/__tests__/browser-first-run-bootstrap.test.ts`,
`browser-first-run-bootstrap-pipeline.test.ts`,
`browser-first-run-bootstrap-worker.test.ts`,
`browser-first-run-bootstrap.integration.test.ts`, `wasm-loader-worker.test.ts`,
`db-provider-first-run-bootstrap.test.tsx`.

---

## COLLECTIONS LIVE QUERY: ONE OWNER

- `useCollections`
  (`packages/vector-management/src/collection-select/collection-select.tsx`) is the
  SINGLE writer of `vectorStatusUIStore.cachedCollections`: it recomputes that cache
  through its own instance-local `pendingMutationsRef` and writes the result back.
- At most one instance is mounted at a time. Why: two instances with differing pending
  mutations never converge, and the loop terminates as React error #185, taking down the
  nearest error boundary.
- A second surface that only DISPLAYS collections reads `cachedCollections` from the
  store; seeds it once with `fetchCollectionsSnapshot(db)` if it may be the first surface
  up, surfacing that helper's rejection rather than rendering an empty list (an empty
  picker reads as "no collections exist" and invites a duplicate); and stays current
  through the `onEmbeddingSetUpdated` browser event. Both store mutations are idempotent.
- Reference implementation: `explorer-collection-picker.tsx`. Mount the sanctioned write
  path `use-collection-cache-sync.ts` on the dialog-hosting surface, never on the picker
  itself, because the popover unmounts before the outcome is announced. Seeding stays
  with each caller.

Settled 2026-08 (BST-1212): one owner, do not relitigate. Evidence:
`database/collections-live-query.md`.

---

## BACKFILL TABLE MAINTENANCE

- Embedding backfill completion never issues `VACUUM` or `ANALYZE` directly. Why: PGlite
  has one WASM Postgres backend, so a table-wide maintenance statement blocks all
  interactive queries and worker claim/complete traffic. Failed or interrupted backfills
  leave maintenance to the scheduled pass, and index recovery must not reacquire the host
  for an inline vacuum.
- The desktop scheduled-database-maintenance pass is the sole owner: it verifies the work
  scheduler is idle, then that no jobs are queued or running, before admitting
  heavyweight maintenance.
- Plain `ANALYZE` runs before the VACUUM set so a slow `file_chunks` vacuum cannot starve
  the cheap `file_records` and `embedding_cache` refreshes; do not also list
  `file_chunks` in the default plain-ANALYZE set, and keep it ordered LAST in the VACUUM
  set so a timeout on the largest table cannot prevent the smaller retention-ledger
  vacuums.
- Every maintenance statement taking at least one second emits a warning with the exact
  SQL and duration — queue reads, retention probes/deletes, plain ANALYZE, and VACUUM
  alike. That preserves one-glance attribution for single-host stalls.

Evidence: `database/backfill-table-maintenance.md`.

---

## STATS ROLLUP + WAKEUP POLLING

- `collection_indexing_stats` stays a hand-maintained rollup table, NOT a materialized
  view. Its `dirty` / `last_refreshed_at` columns are a reader contract.
- Queue wakeups and cross-tab invalidation stay on `live` queries plus bounded interval
  polling; add no raw LISTEN/NOTIFY layer. Why: `live` is itself trigger + pg_notify
  underneath, so a raw channel would duplicate it while feeding burst wakeups into the
  hardened scheduling layers.

Settled 2026-07: do not relitigate; revisit conditions and verification probes are in
`docs/db-rollup-and-wakeup-modernization-decision-2026-07.md`. Evidence:
`database/stats-rollup-and-wakeups.md`.

### Delegated child run/event headers

- The delegated repository reuses migration 118's ordinary run/event tables; there is no
  second transcript journal or new schema, and existing branch deletion/reset already
  removes these sidecars.
- `recordInvocationEvent` revalidates the complete graph, the bound native run/persona,
  and both original and current host turns, then creates the child header and writes the
  event in the SAME statement. An invalid pin or conflicting event identity rejects, and
  model settings/options and the child user message id stay NULL until observed.
- The child's root-owned invocation remains the access authority; a native child resource
  id alone confers no user ownership.
- `bindInvocationRun` returns the latest observed native message id for that exact
  invocation from its own event records — never another run's last transcript row, and
  never a second identity store.

### Delegated decision admission

- Startup reaping runs only AFTER database migrations complete; its decision-state update
  intentionally fails on an unmigrated schema, and optional-relation cleanup is reserved
  for reset, not startup recovery.
- `brainstrike_delegated_tool_decisions` records host admission of an exact root-owned
  native leaf run/call. Permanent leaf uniqueness rejects repeat answers, a partial unique
  root index excludes concurrent claimed resume legs, and the owning runtime alone settles
  its claims to consumed.
- The sole rollback exception is failure of the native snapshot recheck before any native
  resume invocation: the owning binding deletes only its matching unexecuted claim. A
  consumed or interrupted decision cannot be reopened, and cancellation or failure AFTER
  native invocation retains the decision because the effect may already have occurred.
- An interrupted record is never a replay instruction and asserts nothing about whether a
  side effect occurred; native Mastra snapshots remain execution authority.
- The table is in the reset registry and all explicit clear paths, and complete branch
  deletion cascades it.
- Nullable `original_tool_call` on delegated invocations captures the model input before
  delegation, and repeated publication must match it exactly. Legacy NULL stays unknown;
  approval resume cannot substitute the forwarded leaf input.

Evidence: `database/delegated-decision-admission.md`.

## Shared assistant history readers

- `repositories/thread-debug-snapshot.ts` is a local user-initiated export reader: it
  reuses the canonical delegated graph, captures all selected-subtree sections in ONE
  statement snapshot, and performs no schema writes and no row caps. Invalid selected
  ancestry rejects; unrelated threads and unauthorized descendants are excluded.
- Every exported column is explicitly allowlisted in the section inventory; a schema
  addition stays excluded until that inventory gets an export-privacy review. Formatting
  and redaction are in `platform-contracts.md`.
- `repositories/assistant-history-repository.ts` owns the ordinary message/event queries
  used by renderer hydration and delegated pre-resume baselines. It requires a migrated
  handle and performs no DDL. Keep rewind exclusion inside the latest-message window,
  durable parent edges, and event ordering unchanged.
- The desktop host imports these readers through the Node-compatible DB entry; never
  import the browser-facing assistant-data barrel into Electron main.

### Durable delegation limits

- `custom-132-delegation-budgets` adds root-turn budgets, child budgets, and step
  reservations. Admission and native graph/invocation creation share ONE callback
  transaction, locking the root run and budget row; steps validate the same running root,
  owner, and ancestry, then lock the root budget before child allocation.
- Output charge includes unresolved reservations. Settlement happens once per owning host
  reservation and cannot refund an unknown provider result, and an observed overage
  commits BEFORE the caller receives its failure.
- Child deletion removes child rows but retains root spend; root deletion cascades the
  whole budget tree. Migration replay never resets counters, and old turns without a
  budget fail visibly before new inference.
- These accounting limits are not a provider billing meter.
- All three tables are in direct transport reset, desktop IPC reset, and the reset
  registry.

Guard: `packages/db/__tests__/delegated-tree-limits.integration.test.ts`.

### Native background task domain

- `custom-133-mastra-background-tasks` adds the native Mastra background task table and
  indexes. Keep the shared schema definition, forward migration, engine construction,
  direct transport clear, and desktop clear/reset registry aligned.
- The table owns nullable `delivered_at`: native status and result stay available after
  acknowledgement, and only undelivered terminal rows enter result reconciliation. The
  shared DDL and the migration add the column idempotently for already-initialized
  preview profiles, and there is no separate delivery store.

Guard: `packages/db/__tests__/mastra-schema-migration-parity.test.ts`,
`reset-table-registry.test.tsx` (which pins the registry's exact relation counts),
`pglite-background-store.integration.spec.ts`.

### Selective delegated cancellation admission

- `cancellation_requested_at` on the existing invocation is a durable admission
  revocation, not another execution status. Native Mastra remains the execution owner,
  and revoking admission alone never acknowledges Stop: the control host must still join
  the selected native executors and workflow cleanup before reporting success.
- Repeated revocation preserves its timestamp, and root ownership and child ancestry are
  checked before selecting either one conversation or its subtree.
- Decision claims atomically exclude revoked paths; new descendant admission and
  model-step reservations reject a revoked ancestor in the SAME transaction as budget
  admission. Discovery marks the original pending decision cancelled after reload without
  manufacturing an answer or consuming another child's decision.
- The column rides the existing invocation deletion/reset paths.

### Independent paused child continuations

- Migration 138 splits continuation admission ownership: the root unique index covers only
  claimed/running receipts, while a second root/child index covers
  claimed/running/awaiting-approval/awaiting-input. Pending sibling decisions therefore do
  not block one another's admission.
- Decision claims still require the receipt's original turn and a current owned root host
  with no other running/cancelling root leg. These checks also cover ordinary parent
  execution, which has no continuation row.
- Failed concurrent claims roll back the decision insert together with the receipt
  transition. The existing continuation table's reset/delete ownership covers both indexes
  without another persistent store.

### Swarm diagnostics evidence

- `custom-139-swarm-diagnostics` adds `brainstrike_assistant_prompt_manifests`,
  `brainstrike_delegated_wakeups`, and `brainstrike_delegated_live_decisions`:
  append-only debug-pack evidence written by the desktop host, never runtime authority.
  `CHECK` constraints bound every kind, source, and outcome vocabulary.
- Each references `brainstrike_assistant_thread_runs` (the ROOT host run) with
  `ON DELETE CASCADE`, and host runs cascade from `mastra_threads`, so all three sit in
  `RESET_EXCLUDED_TABLES` with that reason and need no clear-path entry.
- Prompt manifests are also in `THREAD_DELETE_SIDECAR_TABLES` by `thread_id`. A
  `child-first-step` row is named by the thread that DISPATCHED it, so deleting a
  delegated branch removes the follow-up and nested-dispatch manifests named by that
  branch but not the child's own first-step row.
- `thread-debug-snapshot.ts` exports all three with explicit column allowlists: wakeups
  and live decisions through their host run's thread in the selected subtree; prompt
  manifests by `thread_id` in the subtree or, for a child-first-step row, through the
  invocation whose `parent_runtime_run_id` / `parent_tool_call_id` equal its
  `native_run_id` / `parent_tool_call_id` under the same root.

Guard: `packages/db/__tests__/migration-139-swarm-diagnostics.integration.test.ts`,
`thread-debug-snapshot.integration.test.ts`,
`reset-table-coverage.integration.test.ts`.

### Per-generation ledger identity

- `custom-140-assistant-native-runs` adds `generation_run_id` to
  `brainstrike_assistant_thread_runs` and creates `brainstrike_assistant_native_runs`,
  mapping a native (Mastra) ROOT run to the host leg that started it. Both exist so the
  delegation ledger is scoped to a GENERATION — the initial send or regeneration that
  opened it — not to a single parent run. Why: one turn spans several native runs, since
  each idle-loop continuation mints a fresh Mastra run id.
- `generation_run_id` is stamped by `createThreadRun`, the sole minting site, and never
  rewritten. An initial or regeneration leg references itself; a leg that answers a
  decision inherits the generation of the leg whose paused run it continues (a child
  continuation through its receipt, a DELEGATED pause through its invocation's
  `host_run_id`, a ROOT-OWN pause through the native run mapped here). Pre-migration rows
  are backfilled to their OWN id.
- NULL means nothing mapped that leg's paused run, and `readBackgroundGeneration` THROWS
  there rather than inventing an identity.
- The two consumers differ in what that throw costs: `createLedgerPublisher.publish`
  catches it and logs `background_ledger_read_failed`, so the leg survives and loses only
  that status row, while the resume path calls `requireBackgroundGeneration` eagerly
  before sibling answers are recorded or native resume begins — so a task parked BEFORE
  migration 140 is refused without consuming the user's claim or changing any parked
  sibling, under the bounded `background-generation-unmapped` reason, whose actionable
  public message (Stop or cancel, then start a new request) both the live-decision 409 and
  the cold approval stream initializer carry. Never guess a generation or auto-replay
  unknown effects.
- The mapping is FIRST-WRITER-WINS: an approval leg re-streams the very run it resumed, so
  the row keeps the leg that STARTED it, and a run already mapped under a different
  generation is rejected rather than silently re-parented.
- NULL is an absence: an unset leg maps no native run; a second generation-read row throws.
- Rows reference `brainstrike_assistant_thread_runs` with `ON DELETE CASCADE`, and host
  runs cascade from `mastra_threads`, so the table sits in `RESET_EXCLUDED_TABLES` with
  that reason and needs no clear-path entry.

Settled: generation scoping (BST-1749, owner ruling 2026-09-15). Evidence:
`database/per-generation-ledger-identity.md`.
Guard: `packages/db/__tests__/migration-140-assistant-native-runs.integration.test.ts`,
`delegated-generation-ports.integration.test.ts`, `background-ledger.spec.ts`,
`background-idle-loop.spec.ts`, `background-ledger-generation.integration.spec.ts`,
`decide-endpoint.test.ts`, `stream-init-tool-budget.test.ts`,
`assistant-run-schema-upgrade-path.test.ts`.
