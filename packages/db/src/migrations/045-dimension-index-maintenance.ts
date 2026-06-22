import type { Migration } from './migration-runner';

export const migration045DimensionIndexMaintenance: Migration = {
  version: 45,
  name: 'dimension_index_maintenance',
  up: `
    CREATE TABLE IF NOT EXISTS embedding_dimension_index_maintenance (
      dimension INTEGER PRIMARY KEY,
      state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'succeeded', 'failed')),
      reason TEXT NOT NULL,
      strategy TEXT NOT NULL DEFAULT 'regular' CHECK (strategy IN ('regular', 'concurrent')),
      requested_at TEXT NOT NULL,
      next_run_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      last_duration_ms INTEGER CHECK (last_duration_ms IS NULL OR last_duration_ms >= 0),
      last_foreground_probe_p95_ms INTEGER
        CHECK (last_foreground_probe_p95_ms IS NULL OR last_foreground_probe_p95_ms >= 0),
      last_foreground_probe_max_ms INTEGER
        CHECK (last_foreground_probe_max_ms IS NULL OR last_foreground_probe_max_ms >= 0),
      last_invalid_index_name TEXT,
      last_error TEXT
    );
    --> statement-breakpoint

    CREATE INDEX IF NOT EXISTS idx_embedding_dimension_index_maintenance_due
      ON embedding_dimension_index_maintenance (state, next_run_at, requested_at);
  `,
  down: `
    DROP INDEX IF EXISTS idx_embedding_dimension_index_maintenance_due;
    --> statement-breakpoint

    DROP TABLE IF EXISTS embedding_dimension_index_maintenance;
  `,
};
