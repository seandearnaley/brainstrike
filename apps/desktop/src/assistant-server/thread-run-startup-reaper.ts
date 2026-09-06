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
 *   treats any non-terminal status as in flight; the reaper matching only
 *   the literal `'running'` keeps that posture — a future status this module
 *   does not understand stays refused, never silently "recovered".
 * - It never creates the table. MIGRATION 118 owns the runs schema (revised
 *   ruling, docs/agents/assistant-persistence.md § RUN-EVENT / THREAD-RUN
 *   SCHEMA OWNERSHIP, 2026-09-05); main may only UPDATE. It no longer probes
 *   for the relation either: `getDatabase()` cannot resolve a handle until
 *   `migrate()` has run (`db-main.ts`), so the only database that lacks it
 *   was never migrated, and that raises 42P01 into the caller's `catch`
 *   rather than the `info`-level `runsTableMissing` report it used to return.
 */
import {
  ORPHANED_THREAD_RUN_ERROR,
  REAP_CLOCK_SKEW_MARGIN_MS,
  reapOrphanedAssistantThreadRuns,
} from '@brainstrike/assistant-data/assistant-thread-run-reaper';
import type { EditCheckpointDatabase } from './edit-checkpoint-journal';

export { ORPHANED_THREAD_RUN_ERROR, REAP_CLOCK_SKEW_MARGIN_MS };

export interface ThreadRunReapReport {
  readonly reaped: readonly { readonly id: string; readonly threadId: string }[];
}

/**
 * Mark every provably-dead `running` row `failed` — see the module doc
 * comment for the evidence rule. Returns what it changed; the CALLER owns
 * visible reporting (main.ts logs the reaped ids, the table-missing signal,
 * and any failure under its own step name). Throws only on a genuine
 * database failure.
 */
export async function reapOrphanedThreadRuns(
  db: EditCheckpointDatabase,
  bootedAt: Date
): Promise<ThreadRunReapReport> {
  return reapOrphanedAssistantThreadRuns(db, bootedAt);
}
