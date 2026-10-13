/**
 * Startup reaper for orphaned `running` thread-run rows (BST-1162).
 *
 * WHY: `brainstrike_assistant_thread_runs.status` reaches a terminal value
 * only through two process-local writers (the renderer's
 * `completeThreadRun` tap and main's `recordDesktopAssistantThreadRunStatus`)
 * — both die with their process, and the latter deliberately swallows write
 * failures. An app crash/quit mid-run therefore strands the row in
 * `'running'` forever, and `hasInFlightThreadRun`'s fail-safe refusal then
 * disables Conversation Rewind for that thread permanently (found in
 * BST-1115's PR-review triage).
 *
 * EVIDENCE RULE — boot time, not age. At main-process start no assistant
 * stream can have survived the previous process, and every run row THIS boot
 * mints is stamped `started_at >= bootedAt` (the renderer mints rows with the
 * same machine clock, and no renderer exists before `app.whenReady()`). So
 * `status = 'running' AND started_at < bootedAt - margin` identifies
 * provably-dead rows by predicate — safe even though the caller runs
 * fire-and-forget and may race the first renderer send. An age bound was
 * explicitly rejected in BST-1162 (it weakens the fail-safe for genuinely
 * long runs); this rule never touches a row the current process could own.
 *
 * CLOCK SKEW (PR #2292 review): the machine clock is not monotonic. The
 * {@link REAP_CLOCK_SKEW_MARGIN_MS} guard band absorbs a backward NTP
 * correction landing between boot and a racing first send — a live row
 * minted after such a step reads slightly "pre-boot" and must NOT be reaped
 * (real orphans are minutes-to-days old and clear the band trivially). The
 * residual exposures are accepted and self-limiting: a backward step LARGER
 * than the band inside the first seconds of app life could reap a
 * just-minted live run, but that run's own terminal status write overwrites
 * the reap when it finishes (unconditional UPDATE by id), so the exposure is
 * a transient open rewind gate, not a corrupted record; and a FORWARD-set
 * clock makes an orphan read "post-boot" so it survives until a later boot
 * catches up — continued refusal, the fail-safe direction. A durable
 * per-session marker column would close both, but the runs schema is
 * renderer-owned and the cross-process boot-id plumbing outweighs the
 * residual risk; revisit if either scenario is ever observed.
 *
 * WHAT IT DOES NOT DO:
 * - It never reaps an UNKNOWN status. `hasInFlightThreadRun` deliberately
 *   treats any non-terminal status as in flight; the reaper matching only the
 *   literals `'running'` and `'cancelling'` keeps that posture — a future
 *   status this module does not understand stays refused, never silently
 *   "recovered".
 * - It never creates the table. MIGRATION 118 owns the runs schema (revised
 *   ruling, docs/agents/assistant-persistence.md § RUN-EVENT / THREAD-RUN
 *   SCHEMA OWNERSHIP, 2026-09-05); main may only UPDATE. It no longer probes
 *   for the relation either: `getDatabase()` cannot resolve a handle until
 *   `migrate()` has run (`db-main.ts`), so the only database that lacks it
 *   was never migrated, and that raises 42P01 into the caller's `catch`
 *   rather than the `info`-level `runsTableMissing` report it used to return.
 */
import { MASTRA_BACKGROUND_TASKS_TABLE } from '@brainstrike/assistant-contract/mastra-memory-schema';
import {
  ORPHANED_THREAD_RUN_ERROR,
  REAP_CLOCK_SKEW_MARGIN_MS,
  reapOrphanedAssistantThreadRuns,
} from '@brainstrike/assistant-data/assistant-thread-run-reaper';
import type { MainQueryHandle } from './main-query-handle';

export { ORPHANED_THREAD_RUN_ERROR, REAP_CLOCK_SKEW_MARGIN_MS };

/** The failure the thread's next turn delivers for a task no worker survived to finish. */
export const ORPHANED_BACKGROUND_TASK_ERROR =
  'Background task orphaned by an earlier app session; marked failed by the startup sweep. It was not rerun. A task that had started may have partially applied its effects; inspect the workspace before rerunning.';

export interface ThreadRunReapReport {
  readonly reaped: readonly { readonly id: string; readonly threadId: string }[];
  readonly reapedBackgroundTaskIds: readonly string[];
}

/**
 * Finalize every provably-dead run row (`running` becomes `failed`, and a
 * `cancelling` leg becomes `cancelled`, retaining its cancellation authority)
 * and fail every provably-dead `pending`/`running` background task — see the
 * module doc comment for the evidence rule. Returns what it changed; the CALLER owns visible
 * reporting (main.ts logs the reaped ids and any failure under its own step
 * name). Throws only on a genuine database failure.
 */
export async function reapOrphanedThreadRuns(
  db: MainQueryHandle,
  bootedAt: Date
): Promise<ThreadRunReapReport> {
  const report = await reapOrphanedAssistantThreadRuns(db, bootedAt);
  // BST-1749: no worker survives a process, so a background task created
  // before boot that is still pending/running never finishes. Mastra's own
  // stale-task recovery is thread-scoped and waits for that thread's next run,
  // while unpreemptable maintenance admission reads these rows across every
  // thread (database.md). Same boot evidence rule as the runs above; a task
  // suspended on the user stays resumable. `delivered_at` stays NULL so the
  // thread's next turn delivers the failure once.
  //
  const backgroundTasks = await db.query<{ id: string }>(
    `UPDATE ${MASTRA_BACKGROUND_TASKS_TABLE}
     SET status = 'failed', error = jsonb_build_object('message', $2::text), "completedAt" = NOW()
     WHERE status IN ('pending', 'running') AND "createdAt" < $1::timestamptz
     RETURNING id`,
    [new Date(bootedAt.getTime() - REAP_CLOCK_SKEW_MARGIN_MS), ORPHANED_BACKGROUND_TASK_ERROR]
  );
  return { ...report, reapedBackgroundTaskIds: backgroundTasks.rows.map((row) => row.id) };
}
