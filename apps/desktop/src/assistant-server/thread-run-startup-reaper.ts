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
 * - It never creates the table. The runs schema is renderer-bootstrapped
 *   (settled ruling, docs/agents/assistant-persistence.md § RUN-EVENT /
 *   THREAD-RUN SCHEMA OWNERSHIP); main may only UPDATE, so a missing
 *   relation is probed with `to_regclass` and reported, exactly like the
 *   rewind repository's own probes.
 */
import type { EditCheckpointDatabase } from './edit-checkpoint-journal';

const RUNS_TABLE = 'brainstrike_assistant_thread_runs';

/** Visible on the run row (and the Task Ledger's status badge) — never a silent flip. */
export const ORPHANED_THREAD_RUN_ERROR =
  'run orphaned by an earlier app session; marked failed by the startup sweep';

/** Guard band for non-monotonic clocks — see CLOCK SKEW in the module doc. */
export const REAP_CLOCK_SKEW_MARGIN_MS = 60_000;

export interface ThreadRunReapReport {
  readonly reaped: readonly { readonly id: string; readonly threadId: string }[];
  /** True when the renderer bootstrap has never run on this profile. */
  readonly runsTableMissing: boolean;
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
  const probe = await db.query<{ oid: string | null }>('SELECT to_regclass($1)::text AS oid', [
    RUNS_TABLE,
  ]);
  const probedOid = probe.rows[0]?.oid;
  if (probedOid === null || probedOid === undefined) {
    return { reaped: [], runsTableMissing: true };
  }
  const now = new Date();
  const reapBefore = new Date(bootedAt.getTime() - REAP_CLOCK_SKEW_MARGIN_MS);
  // `completed_at` is stamped with the REAP instant, deliberately non-null:
  // `resolveRewindRunRange`'s fallback predicate treats a NULL `completed_at`
  // as in-range, so a null here would pull the reaped row into EVERY rewind
  // range for its thread forever — the opposite of unsticking it. The Task
  // Ledger's `durationMs` therefore spans the downtime for a reaped row; the
  // visible orphan error string on the same row is the explanation, and that
  // display tradeoff is accepted (PR #2292 review).
  const result = await db.query<{ id: string; threadId: string }>(
    `UPDATE ${RUNS_TABLE}
     SET status = 'failed', error = $2, completed_at = $3, updated_at = $3
     WHERE status = 'running' AND started_at < $1::timestamptz
     RETURNING id, thread_id AS "threadId"`,
    [reapBefore, ORPHANED_THREAD_RUN_ERROR, now]
  );
  const reaped = result.rows.map((row) => ({ id: row.id, threadId: row.threadId }));
  return { reaped, runsTableMissing: false };
}
