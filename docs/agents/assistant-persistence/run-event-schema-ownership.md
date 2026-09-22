# Run-event schema ownership and runId provenance — evidence

Supports `docs/agents/assistant-persistence.md` §
"RUN-EVENT / THREAD-RUN SCHEMA OWNERSHIP". Read this before proposing to change the desktop writers, the duration rounding, the provenance argument, or the loudness carve-outs.
The contract holds the rules; this file is the record behind them, extracted
verbatim from the pre-distillation contract.

Correction noted at extraction (verified 2026-09-21 against
`packages/db/src/migrations/118-assistant-thread-runs.ts`): the header comment of
`scripts/assistant-run-id-producer-guard.mjs` still says "Neither table is
migration-backed". That is stale — migration 118 creates both relations, as the
extract below records. The guard's actual assertions (one declaration, one call
site, not exported for `createThreadRunId`) are unaffected; only its prose
premise is out of date.

`brainstrike_assistant_thread_runs` and `brainstrike_assistant_run_events` are
created by **migration 118**, and NOTHING creates them at runtime.

**This supersedes the 2026-07-24 ruling** that they must never get a numbered
migration. That ruling was correct for its premise and the premise is gone: both
tables carry `ON DELETE CASCADE` FKs to parents no migration created (the Mastra
threads table, and the runs row itself), so the only options then were an FK-less
migration or a runtime bootstrap. **Migration 117 now creates Mastra's memory
schema**, so 118 declares both FKs exactly as the bootstrap did. Do not restore
the bootstrap.

The desktop MAIN process has FOUR writers against these relations, none of
which creates them (all in `apps/desktop/src/assistant-server/run-persistence.ts`, all reached
through injected handles rather than a module-level import —
`recordDesktopAssistantRunEvent` and `completeDesktopAssistantThreadRun` take a
database PROVIDER, `recordDesktopAssistantHookRunOutcome` takes an
already-resolved handle; the sole composition site is the `assistant-server.ts`
root, which supplies `db-main`'s `getDatabase` — the service's `stream-init.ts` takes
that provider on `InitializeAgentStreamParams` and forwards it (or its awaited
result) to the writers — so every write still resolves the same main-process
handle (BST-972 A1/A2) — and all gated on `if (runId)`):

| Writer | Shape | On a missing parent row |
| --- | --- | --- |
| `recordDesktopAssistantRunEvent` | `INSERT … SELECT FROM brainstrike_assistant_thread_runs` | 0 rows, silent no-op |
| `recordDesktopAssistantHookRunOutcome` | `INSERT … SELECT FROM brainstrike_assistant_thread_runs` | THROWS (deliberate) |
| `completeDesktopAssistantThreadRun` | `UPDATE brainstrike_assistant_thread_runs` | 0 rows, silent no-op |
| `reapOrphanedThreadRuns` (BST-1162, startup only) | `UPDATE … WHERE status = 'running' AND started_at < bootedAt` | 0 rows, empty sweep. A MISSING RELATION is not a case: migration 118 owns the table and `getDatabase()` resolves only after `migrate()`, so an unmigrated database raises 42P01 into main's own `catch` (BST-1651 retired the `runsTableMissing` report, which had reduced that state to an `info` line) |

Run-critical desktop reads and event writes use the existing foreground `DatabaseWorkScheduler`
lane. A run-scoped `mastra_workflow_snapshot` SELECT and same-id event upsert may retry once for
typed, non-terminating host saturation. Snapshot retries emit `run.database.retried`; event retries
stamp sanitized `metadata.databaseRetry`. Serial host ordering plus same-id upsert prevents duplication
after late completion. Retries are logged; arbitrary, wedged, terminating, and exhausted failures remain typed.

The delegated conversation host is built on that same run-critical handle in `mastra-memory.ts`.
That covers `createDesktopDelegatedConversationHost`: scope reads, step budget, tool-action
claims, swarm diagnostics and continuation admission. Only workspace snapshot capture keeps the
owner handle.

On the owner handle, the host's queries skipped the scheduler and reached a DB host held by an 82 s
maintenance statement. Two children failed on the 30 s request timeout (live GLM run 22,
2026-09-15). Its transactions use only `tx` inside the callback, and history capture runs after them,
so the serial scheduler never waits on itself.

Paired: `delegated-host-run-lane.test.ts`. A held lane defers the host's scope read; the owner
handle fails it.

**`duration_ms` is an INTEGER column, and durations are rounded at the
PRODUCER.** The guard wrapper measures tool execution with `performance.now()`,
whose deltas are fractional; forwarding the raw float made every stamped
terminal tool event fail to persist (field regression 2026-08-23, 22P02
"invalid input syntax for type integer") — holes in the exact timeline the
debug bundle reads. `withRunEventDuration`
(`packages/agent/src/mastra/tool-lifecycle-processors.ts`) is the single seam
where a duration enters a run event and rounds there (non-finite drops the
field). The column contract is pinned by the real-PGlite pair in
`run-event-schema-provenance.integration.test.ts` — integer persists,
fractional rejected — so the rounding is provably load-bearing.

That is safe, and the reason is **runId provenance — NOT startup ordering**:

- `memory.runId` has exactly ONE producer: `createAssistantThreadRunPromise`
  (`assistant-ui-panel-wrapper-runtime.ts`) → `repository.createThreadRun`,
  which awaits the schema bootstrap before it can return an id.
- Every main-process write is gated on `if (runId)`, and `buildAssistantRequestData`
  puts no `runId` on `data.memory`, so no stale or restored id can bypass the mint.
- Desktop has ONE physical database: the renderer's handle is
  `window.electronAPI.db`, whose `db:exec` resolves through the same `db-main`
  `getDatabase()` the assistant server's composition sites inject into the
  run-persistence writers.

Therefore do NOT add a defensive `CREATE TABLE IF NOT EXISTS` in main, and do
not add an ordering handshake: both would be machinery for an unreachable state,
and would mask a genuinely broken invariant if provenance ever changes.

**The regression that WOULD make this real** is a second runId producer — a
server-side background run, a cron/headless run, or subagent runs persisted
under their own ids. Any such producer must bootstrap the schema itself.

**Loudness is NOT uniform — do not read the above as a blanket guarantee.** An
un-bootstrapped write always raises PG `42P01` at the driver, but only one path
propagates it:

- `observeDesktopAssistantRunEvents` `logger.error`s every failed event and
  rethrows on flush — but the rethrow is CONDITIONAL (in
  `assistant-server/run-persistence.ts`): when the source stream ALSO threw, the persistence failure is
  downgraded to a `logger.error` and only the stream error propagates.
- `recordDesktopAssistantThreadRunStatus` (same module) wraps
  `completeDesktopAssistantThreadRun` in a `try/catch` that only logs. A
  `42P01` on the run-status `UPDATE` is SWALLOWED; the run row simply never
  reaches a terminal status. Rows stranded in `'running'` this way (or by a
  crash/quit killing both status writers) are recovered at the NEXT app
  start by `reapOrphanedThreadRuns`
  (`apps/desktop/src/assistant-server/thread-run-startup-reaper.ts`, wired
  into main.ts's startup fire-and-forget sweep, BST-1162): boot-time
  evidence (`started_at < mainProcessStartedAt` — no renderer exists before
  whenReady, so a row this boot minted can never match) marks them `failed`
  with a visible error, un-sticking `hasInFlightThreadRun`'s rewind gate
  without weakening it — live runs and unknown statuses still refuse.
  The same sweep fails pre-boot `pending`/`running` `mastra_background_tasks`
  rows (`"createdAt"` before boot less the same clock-skew margin) with
  `ORPHANED_BACKGROUND_TASK_ERROR`; a `suspended` task is never touched.
  `delivered_at` stays NULL, so the thread's next turn delivers the failure
  once through the ordinary undelivered-outcome repair. Mastra's own
  `recoverStaleTasks` cannot replace this: it is thread-scoped and runs only
  inside that thread's next run, while unpreemptable maintenance admission
  reads these rows across every thread (database.md, maintenance admission).
  Reaping supersedes no retry path, and a crashed task is never rerun: the
  host pins background retries to 0 — `createTask` pins a model-requested
  count down, and `updateTask` refuses to re-arm one on an existing row. Both
  halves are pinned by `pglite-background-store.integration.spec.ts` ("limits
  native manager recovery and every task operation to its conversation
  owner"); cite that test rather than line numbers, which rot silently. No
  host write path can produce `max_retries > 0`, so never add a
  `retry_count < max_retries` carve-out to the reap. This paragraph is the
  canonical statement of that rule; database.md's maintenance admission
  section points here.
  Paired test: `thread-run-startup-reaper.integration.test.ts`, whose cases
  also pin the statement ORDER (the native-decision repair runs before the
  background sweep, so a failing sweep can never skip it) and the clock-skew
  margin from both sides.

Neither carve-out is a regression introduced alongside this ruling, and neither
is currently worth runtime machinery — but they are why the provenance invariant
carries the weight here rather than error surfacing. If provenance is ever
broken, expect partial silence, not a clean failure. Paired test (clean-stream
path only): `apps/desktop/src/__tests__/assistant-server/run-event-schema-provenance.integration.test.ts`.

