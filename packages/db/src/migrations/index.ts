import type { Migration } from './migration-runner';

// Import all migrations
import { migration001InitialSchema } from './001-initial-schema.js';
import { migration002AddVectorColumns } from './002-add-vector-columns.js';
import { migration003AddIndexes } from './003-add-indexes.js';

// Export all migrations in order
export const migrations: Migration[] = [
  migration001InitialSchema,
  migration002AddVectorColumns,
  migration003AddIndexes,
];

// Re-export types and runner
export { MigrationRunner } from './migration-runner.js';
export type { Migration } from './migration-runner';
