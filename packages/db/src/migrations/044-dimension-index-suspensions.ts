import type { Migration } from './migration-runner';

export const migration044DimensionIndexSuspensions: Migration = {
  version: 44,
  name: 'dimension_index_suspensions',
  up: `
    CREATE TABLE IF NOT EXISTS embedding_dimension_index_suspensions (
      dimension INTEGER PRIMARY KEY,
      reason TEXT NOT NULL,
      suspended_at TEXT NOT NULL
    );
  `,
  down: `
    DROP TABLE IF EXISTS embedding_dimension_index_suspensions;
  `,
};
