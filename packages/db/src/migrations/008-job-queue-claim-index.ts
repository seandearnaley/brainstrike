import type { Migration } from './migration-runner';

// Migration 008: Add tie-breaker id to claim index for deterministic ordering
export const migration008JobQueueClaimIndex: Migration = {
  down: `
    DROP INDEX IF EXISTS idx_job_queue_claim;
  `,
  name: 'job_queue_claim_index',
  up: `
    CREATE INDEX IF NOT EXISTS idx_job_queue_claim
      ON job_queue(queue, state, run_at, id);
  `,
  version: 8,
};
