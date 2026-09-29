import type { Migration } from './migration-runner';

/**
 * Migration 078: restore the UNIQUE partial dedupe index on the Drizzle path
 * (BST-991).
 *
 * Numbered migration 007 created `idx_job_queue_dedupe_active` — the hard
 * uniqueness backstop behind `JobQueue.enqueue`'s idempotent CTE, which is
 * `INSERT … WHERE NOT EXISTS`, not `ON CONFLICT`. The Drizzle runner (the
 * production path) never created it: its schema declared only the plain
 * non-unique `idx_job_queue_dedupe_key`. Verified empirically by diffing
 * `pg_indexes` between a fully numbered-migrated and a fully
 * Drizzle-migrated PGlite (job-queue-index-parity.integration.test.ts, which
 * now pins the uniqueness behavior on BOTH runners).
 *
 * On the numbered path this whole migration is a no-op: the cleanup finds no
 * duplicates (the index has enforced uniqueness since 007) and the CREATE is
 * `IF NOT EXISTS`.
 */
export const migration078JobQueueDedupeActiveIndex: Migration = {
  down: `
    -- No-op: 007 owns idx_job_queue_dedupe_active on the numbered path, and
    -- dropping it here would revoke that migration's invariant on any partial
    -- rollback that stops between 7 and 77. 078 only creates the index where
    -- it was missing; it is not the owner.
    SELECT 1;
  `,
  ledgerKey: 'custom-078-job-queue-dedupe-active-index',
  name: 'job_queue_dedupe_active_index',
  up: `
    -- A Drizzle-migrated database may already hold duplicate ACTIVE rows per
    -- dedupe_key (the CTE was the only guard, and the debug benchmark INSERTs
    -- raw rows), and CREATE UNIQUE INDEX fails on existing violations. Cancel
    -- all but the newest active row per key first — cancel rather than
    -- delete, so the resolution stays visible in the queue's own forensics.
    -- Shape matches JobQueue.cancel: leased_until nulled, error annotated,
    -- updated_at written in the contractual TEXT-ISO format (the column is
    -- TEXT and every reader compares it lexicographically — a bare
    -- CURRENT_TIMESTAMP cast renders a space-separated non-ISO string).
    -- job_queue_metrics.canceled_total is a monotonic lifetime counter
    -- (migration 064); scheduled pruning later deletes the rows, so the
    -- outcome must be counted here or it is lost forever.
    WITH canceled AS (
      UPDATE job_queue
         SET state = 'canceled',
             leased_until = NULL,
             error = COALESCE(error, 'canceled by migration 078: duplicate active dedupe_key'),
             updated_at = to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
       WHERE id IN (
         SELECT id FROM (
           SELECT id,
                  ROW_NUMBER() OVER (
                    PARTITION BY dedupe_key
                    ORDER BY created_at DESC, id DESC
                  ) AS rn
             FROM job_queue
            WHERE dedupe_key IS NOT NULL AND state IN ('queued','running')
         ) ranked
         WHERE rn > 1
       )
       RETURNING queue
    )
    INSERT INTO job_queue_metrics (queue, canceled_total)
    SELECT queue, COUNT(*) FROM canceled GROUP BY queue
    ON CONFLICT (queue) DO UPDATE
      SET canceled_total = job_queue_metrics.canceled_total + EXCLUDED.canceled_total;
    --> statement-breakpoint

    CREATE UNIQUE INDEX IF NOT EXISTS idx_job_queue_dedupe_active
      ON job_queue(dedupe_key)
      WHERE dedupe_key IS NOT NULL AND state IN ('queued','running');
  `,
  version: 78,
};
