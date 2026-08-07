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
 * `status = 'running' AND started_at < bootedAt` identifies provably-dead
 * rows by predicate — safe even though the caller runs fire-and-forget and
 * may race the first renderer send. An age bound was explicitly rejected in
 * BST-1162 (it weakens the fail-safe for genuinely long runs); this rule
 * never touches a row the current process could own.
 *
 * WHAT IT DOES NOT DO:
 * - It never reaps an UNKNOWN status. `hasInFlightThreadRun` deliberately
 *   treats any non-terminal status as in flight; the reaper matching only
 *   the literal `'running'` keeps that posture — a future status this module
 *   does not understand stays refused, never silently "recovered".
 * - It never creates the table. The runs schema is renderer-bootstrapped
 *   (settled ruling, docs/agents/assistant-persistence.md § RUN-EVENT /
 *   THREAD-RUN SCHEMA OWNERSHIP); main may only UPDATE, so a missing
 *   relation is probed with `to_regclass` and reported, exactly like the
 *   rewind repository's own probes.
 */
import { createLogger } from '@brainstrike/logging';
import type { EditCheckpointDatabase } from './edit-checkpoint-journal';

const logger = createLogger('ThreadRunStartupReaper');

const RUNS_TABLE = 'brainstrike_assistant_thread_runs';

/** Visible on the run row (and the Task Ledger's status badge) — never a silent flip. */
export const ORPHANED_THREAD_RUN_ERROR =
  'run orphaned by an earlier app session; marked failed by the startup sweep';

export interface ThreadRunReapReport {
  readonly reaped: readonly { readonly id: string; readonly threadId: string }[];
  /** True when the renderer bootstrap has never run on this profile. */
  readonly runsTableMissing: boolean;
}

/**
 * Mark every provably-dead `running` row `failed` — see the module doc
 * comment for the evidence rule. Returns what it changed so the caller can
 * log it visibly; throws only on a genuine database failure.
 */
export async function reapOrphanedThreadRuns(
  db: EditCheckpointDatabase,
  bootedAt: Date
): Promise<ThreadRunReapReport> {
  const probe = await db.query<{ oid: string | null }>('SELECT to_regclass($1)::text AS oid', [
    RUNS_TABLE,
  ]);
  const probedOid = probe.rows[0]?.oid;
  if (probedOid === null || probedOid === undefined) {
    return { reaped: [], runsTableMissing: true };
  }
  const now = new Date();
  const result = await db.query<{ id: string; threadId: string }>(
    `UPDATE ${RUNS_TABLE}
     SET status = 'failed', error = $2, completed_at = $3, updated_at = $3
     WHERE status = 'running' AND started_at < $1::timestamptz
     RETURNING id, thread_id AS "threadId"`,
    [bootedAt, ORPHANED_THREAD_RUN_ERROR, now]
  );
  const reaped = result.rows.map((row) => ({ id: row.id, threadId: row.threadId }));
  if (reaped.length > 0) {
    logger.info('Reaped orphaned assistant thread runs from an earlier session', {
      bootedAt: bootedAt.toISOString(),
      runIds: reaped.map((row) => row.id),
    });
  }
  return { reaped, runsTableMissing: false };
}
