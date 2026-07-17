import type { Migration } from './migration-runner';

/**
 * Migration 064: lifetime failed/canceled outcome counters.
 *
 * job_queue_metrics (049) only tracked a monotonic per-queue succeeded_total,
 * so scheduled maintenance pruning terminal job rows destroyed lifetime
 * failed/canceled history. These columns hold monotonic per-queue lifetime
 * failed and canceled counts, incremented at the terminal-fail and cancel
 * transitions in JobQueue and never decremented — aggregate-then-prune, so
 * the totals are immune to pruning, clearing, and restarts.
 *
 * ADD COLUMN is IF NOT EXISTS because the dual migration runner (numbered
 * runner for tests, drizzle customMigrations for the real app) runs on
 * different paths — both must converge on the same table shape.
 *
 * BACKFILL (review #1696): an upgrading DB may hold terminal job_queue rows
 * that predate the counters; without seeding, the next maintenance prune
 * would erase that history and the lifetime totals would read 0. The seed is
 * idempotent-by-guard: metrics rows are created for any queue with terminal
 * rows (ON CONFLICT DO NOTHING), then ONLY still-zero counters are populated
 * from the surviving rows — a re-run after later pruning can never shrink or
 * double-count an already-seeded total.
 */
export const migration064JobQueueOutcomeMetrics: Migration = {
  down: `
    ALTER TABLE job_queue_metrics DROP COLUMN IF EXISTS failed_total;
    --> statement-breakpoint

    ALTER TABLE job_queue_metrics DROP COLUMN IF EXISTS canceled_total;
  `,
  name: 'job_queue_outcome_metrics',
  up: `
    ALTER TABLE job_queue_metrics ADD COLUMN IF NOT EXISTS failed_total BIGINT NOT NULL DEFAULT 0;
    --> statement-breakpoint

    ALTER TABLE job_queue_metrics ADD COLUMN IF NOT EXISTS canceled_total BIGINT NOT NULL DEFAULT 0;
    --> statement-breakpoint

    INSERT INTO job_queue_metrics (queue, succeeded_total)
    SELECT DISTINCT queue, 0 FROM job_queue WHERE state IN ('failed', 'canceled')
    ON CONFLICT (queue) DO NOTHING;
    --> statement-breakpoint

    UPDATE job_queue_metrics m
    SET failed_total = seeded.failed_count,
        canceled_total = seeded.canceled_count
    FROM (
      SELECT queue,
        COUNT(*) FILTER (WHERE state = 'failed') AS failed_count,
        COUNT(*) FILTER (WHERE state = 'canceled') AS canceled_count
      FROM job_queue
      WHERE state IN ('failed', 'canceled')
      GROUP BY queue
    ) seeded
    WHERE m.queue = seeded.queue
      AND m.failed_total = 0
      AND m.canceled_total = 0;
  `,
  version: 64,
};
