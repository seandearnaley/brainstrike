const RUNS_TABLE = 'brainstrike_assistant_thread_runs';

/** Visible on the run row (and the Task Ledger's status badge) — never a silent flip. */
export const ORPHANED_THREAD_RUN_ERROR =
  'run orphaned by an earlier app session; marked failed by the startup sweep';

/** Guard band for non-monotonic clocks around the renderer/main boot boundary. */
export const REAP_CLOCK_SKEW_MARGIN_MS = 60_000;

export interface AssistantThreadRunReaperDatabase {
  query: <T = unknown>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
}

export interface ThreadRunReapReport {
  readonly reaped: readonly { readonly id: string; readonly threadId: string }[];
  /** True when the renderer bootstrap has never run on this profile. */
  readonly runsTableMissing: boolean;
}

/**
 * Marks pre-boot `running` rows failed without guessing from run age.
 *
 * A row is provably orphaned only when it predates this process/renderer boot,
 * less a clock-skew guard band. Desktop invokes this at main-process startup;
 * web invokes it after renderer schema bootstrap and before subscribing the
 * Threads panel to active runs. Both runtimes therefore share one predicate
 * and one visible terminal transition.
 */
export async function reapOrphanedAssistantThreadRuns(
  db: AssistantThreadRunReaperDatabase,
  bootedAt: Date
): Promise<ThreadRunReapReport> {
  const probe = await db.query<{ oid: string | null }>('SELECT to_regclass($1)::text AS oid', [
    RUNS_TABLE,
  ]);
  const probedOid = probe.rows[0]?.oid;
  if (probedOid === null || probedOid === undefined) {
    return { reaped: [], runsTableMissing: true };
  }

  // Stamp the reap instant, never NULL: rewind range fallback logic treats a
  // NULL completed_at as still in-range, which would pull this failed row into
  // every later rewind range for its thread. The ledger duration therefore
  // includes downtime; the durable orphan error on the same row explains it.
  const completedAt = new Date();
  const reapBefore = new Date(bootedAt.getTime() - REAP_CLOCK_SKEW_MARGIN_MS);
  const result = await db.query<{ id: string; threadId: string }>(
    `UPDATE ${RUNS_TABLE}
     SET status = 'failed', error = $2, completed_at = $3, updated_at = $3
     WHERE status = 'running' AND started_at < $1::timestamptz
     RETURNING id, thread_id AS "threadId"`,
    [reapBefore, ORPHANED_THREAD_RUN_ERROR, completedAt]
  );

  return {
    reaped: result.rows.map((row) => ({ id: row.id, threadId: row.threadId })),
    runsTableMissing: false,
  };
}
