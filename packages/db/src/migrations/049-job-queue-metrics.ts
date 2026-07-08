import type { Migration } from './migration-runner';

/**
 * Migration 049: durable per-queue lifetime job metrics.
 *
 * The queue HUD's "Success" number was a live COUNT of `succeeded` job_queue
 * rows. Once scheduled maintenance began pruning finished rows during long
 * backfills (to stop job_queue bloat), that count became a ~1h rolling window
 * instead of a cumulative total. This table holds a monotonic per-queue
 * lifetime succeeded count, incremented at the succeed transition in JobQueue
 * and never decremented — so it is immune to pruning, clearing, and restarts.
 *
 * CREATE TABLE is IF NOT EXISTS because the dual migration runner (numbered
 * runner for tests, drizzle customMigrations for the real app) runs on
 * different paths — both must converge on the same table shape.
 */
export const migration049JobQueueMetrics: Migration = {
  down: `
    DROP TABLE IF EXISTS job_queue_metrics;
  `,
  name: 'job_queue_metrics',
  up: `
    CREATE TABLE IF NOT EXISTS job_queue_metrics (
      queue TEXT PRIMARY KEY,
      succeeded_total BIGINT NOT NULL DEFAULT 0
    );
  `,
  version: 49,
};
