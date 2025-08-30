// Import all migrations
import { migration001InitialSchema } from './001-initial-schema.js';
import { migration002AddVectorColumns } from './002-add-vector-columns.js';
import { migration003AddIndexes } from './003-add-indexes.js';
import { migration004AddChunksTable } from './004-add-chunks-table.js';
import { migration005SafeIndices } from './005-safe-indices.js';
import { migration006EmbeddingSetsAndColumns } from './006-embedding-sets-and-columns.js';
import { migration007JobQueue } from './007-job-queue.js';
import type { Migration } from './migration-runner';

// Export all migrations in order
// Migration 004 is conditionally included based on pgvector availability
export const migrations: Migration[] = [
  migration001InitialSchema,
  migration002AddVectorColumns,
  migration003AddIndexes,
  migration004AddChunksTable,
  migration005SafeIndices,
  migration006EmbeddingSetsAndColumns,
  migration007JobQueue,
];

// Export base migrations (without chunks table) for test environments
export const baseMigrations: Migration[] = [
  migration001InitialSchema,
  migration002AddVectorColumns,
  migration003AddIndexes,
];

export type { Migration } from './migration-runner';
// Re-export types and runner
export { MigrationRunner } from './migration-runner.js';
