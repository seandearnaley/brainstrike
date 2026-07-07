import type { Migration } from './migration-runner';

// Migration 007: Job queue with leasing, retries, backoff, and dedupe
// Uses TEXT timestamps for portability across PGlite/Node environments
export const migration007JobQueue: Migration = {
  down: `
    DROP INDEX IF EXISTS idx_job_queue_lease;
    DROP INDEX IF EXISTS idx_job_queue_scheduling;
    DROP INDEX IF EXISTS idx_job_queue_dedupe_active;
    DROP TABLE IF EXISTS job_queue;
  `,
  name: 'job_queue',
  up: `
    -- Create job_queue table
    CREATE TABLE IF NOT EXISTS job_queue (
      id TEXT PRIMARY KEY,
      queue TEXT NOT NULL,
      job_type TEXT NOT NULL,
      payload JSONB,
      state TEXT NOT NULL CHECK (state IN ('queued','running','succeeded','failed','canceled','expired')) DEFAULT 'queued',
      run_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 5,
      backoff_ms INTEGER NOT NULL DEFAULT 0,
      lease_token TEXT,
      leased_until TEXT,
      worker_id TEXT,
      dedupe_key TEXT,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Unique partial index on dedupe_key for active jobs
    CREATE UNIQUE INDEX IF NOT EXISTS idx_job_queue_dedupe_active
      ON job_queue(dedupe_key)
      WHERE dedupe_key IS NOT NULL AND state IN ('queued','running');

    -- Scheduling and lease related indexes
    CREATE INDEX IF NOT EXISTS idx_job_queue_scheduling ON job_queue(queue, state, run_at);
    CREATE INDEX IF NOT EXISTS idx_job_queue_lease ON job_queue(state, leased_until);
  `,
  version: 7,
};
