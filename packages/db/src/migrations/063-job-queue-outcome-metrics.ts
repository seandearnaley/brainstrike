import type { Migration } from './migration-runner';

/**
 * Migration 063: lifetime failed/canceled outcome counters.
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
 */
export const migration063JobQueueOutcomeMetrics: Migration = {
  down: `
    ALTER TABLE job_queue_metrics DROP COLUMN IF EXISTS failed_total;
    ALTER TABLE job_queue_metrics DROP COLUMN IF EXISTS canceled_total;
  `,
  name: 'job_queue_outcome_metrics',
  up: `
    ALTER TABLE job_queue_metrics ADD COLUMN IF NOT EXISTS failed_total BIGINT NOT NULL DEFAULT 0;
    ALTER TABLE job_queue_metrics ADD COLUMN IF NOT EXISTS canceled_total BIGINT NOT NULL DEFAULT 0;
  `,
  version: 63,
};
