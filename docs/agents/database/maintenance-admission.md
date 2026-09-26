# Unpreemptable maintenance admission — evidence

Supports `docs/agents/database.md` § "DATABASE WORK SCHEDULER FAIRNESS".

The two incidents behind the sustained-quiet window and the in-flight assistant-work gate (BST-1333's 7.3 s VACUUM; live GLM run 22's 82 s HNSW build that failed two children), and why boot evidence rather than row age proves an orphan is dead. Read before widening either gate.

The record below is the original contract text, extracted unchanged.

The desktop process-counter sampler (`process-counter-sample`, 30 s, behind the
`main-process-health` tick) is the one RECURRING background-lane consumer that
is not maintenance: a single indexed `COUNT(*) … GROUP BY status` over
`mastra_background_tasks` (`idx_mastra_background_tasks_status`). It is bounded
by construction — a tick whose previous sample is still outstanding skips the
read and records `previous sample still pending` instead of queueing another —
so it contributes at most one short statement per tick and can never build a
backlog that consumes forced background admissions. Shutdown stops it before
the idle join; the factory-reset barrier it waits on is what keeps a
diagnostics read from reopening the database mid-reset (contract in
`docs/agents/platform-contracts.md`).

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

**Unpreemptable maintenance never starts while assistant work is in flight (2026-09-15).**
Sustained scheduler quiet cannot see a run waiting on its model. In live GLM run 22,
`createDesktopDimensionIndexMaintenanceScheduler` still sampled idle once, and it started an 82 s HNSW
`CREATE INDEX` 24 s into a four-child fan-out, during a gap between run-scoped queries. Every
run-scoped query behind the build hit the 30 s DB host request timeout, and two children failed.
Both desktop maintenance schedulers now share `maintenance-admission.ts`:

- The BST-1333 sustained-quiet window applies to both. The HNSW scheduler REQUIRES the snapshot
  subscription; there is no single-sample mode.
- Inside the background lane, immediately before the statement, `readInFlightAssistantWork` runs.
  Any `brainstrike_assistant_thread_runs` row in `running`/`cancelling`, or `mastra_background_tasks`
  row in `pending`/`running`, skips the pass with reason `assistant-work-in-flight`. The skip is
  logged at info, so a pass held off by a stuck row is visible — boot reconciliation clears the
  crash-stranded rows, but a genuinely stuck LIVE row can still exist, and info is why it is visible.
- The gate reads those rows across every thread, so boot reconciliation is part of this contract.
  A crash leaves them in flight with no process to finish them. The desktop startup reaper
  (`reapOrphanedThreadRuns`, assistant-persistence.md) fails pre-boot `running` runs, cancels
  pre-boot `cancelling` runs (pinned by the reaper suite's "retains cancellation authority" case),
  and fails pre-boot `pending`/`running` background tasks with a visible orphan error — in EVERY
  thread, matching what this gate reads (pinned by that suite's foreign-thread row). Mastra's own
  stale-task recovery cannot stand in for it: it runs only when a later run of the SAME thread
  builds its thread-scoped manager, so an orphan in a thread the user never revisits would hold
  both statements off for the database's lifetime. The reap is fire-and-forget; losing the race to
  a scheduler's first pass costs one skipped pass. Never swap the boot evidence for an age bound.
  Age is a GUESS that can kill live work: a task row does carry `timeout_ms`, so
  `"createdAt" + timeout_ms` is an available bound, and it would still reap a task that is running
  legitimately long. Boot evidence is PROOF of death — no worker or stream survives its process,
  so a row stamped before this boot has no owner left. (Neither table carries an `updated_at` /
  `"updatedAt"` heartbeat either, so there is no cheap liveness signal to bound age against.)
  The background sweep runs after the native-decision repair, so a failure in the sweep cannot
  skip that repair (pinned). Its position last in the function is intent, not a pinned claim. Reaping supersedes no retry path and never reruns a crashed task; assistant-persistence.md
  (the reaper paragraph) is canonical for that rule and names the test that pins it.
- A malformed read throws; it never reads as idle.
- A task suspended on the user does not block. Its decision resumes it as a new run.

The work scheduler is serial, so run-scoped work submitted after that read queues behind the
statement rather than racing it. One window stays open: a run started while a statement is
already running. The host cannot preempt the statement, so that run WAITS in the scheduler.
Run-scoped work must therefore be on the scheduler, so it waits instead of timing out at the host
(assistant-persistence.md, run-critical lane).

Paired:
- `dimension-index-maintenance-scheduler.test.ts` ("admission")
- `database-maintenance-scheduler.test.ts` ("assistant work admission")
- `maintenance-admission.test.ts` (malformed reads)
- `maintenance-admission.integration.test.ts` (statuses against migrated tables)
- `thread-run-startup-reaper.integration.test.ts` (orphaned background tasks leave the in-flight read)

Removing the in-flight skip, the quiet gate, the busy seed at start, the subscription, or the
boot reap of background tasks each fails its own rows.

## Interrupted HNSW maintenance at desktop boot (2026-09-26)

An interrupted index build can leave a durable maintenance row in `running` alongside
its index suspension. A real PGlite restart reproduced a permanent skip: suspension
reconciliation treats `running` as owned, while the scheduler claims only `pending`.
The single-instance desktop boot now moves those rows back to `pending` before
starting maintenance triggers. It restores the consumed in-flight attempt rather
than clearing retry history, keeps the suspension, and makes the row due at boot.
This recovery cannot run on routine ticks: a long live build has no heartbeat,
so elapsed time cannot prove abandonment. The persisted-database service test and
desktop boot-order test guard the two halves of this ownership rule.
