import { migration001CurrentSchema } from './001-current-schema.js';
import type { Migration } from './migration-runner';

/**
 * The migration registry: one step, which constructs the current schema.
 *
 * Brainstrike is greenfield (ADR-0020), so schema construction has no history
 * to replay. A schema change is authored in `current-schema-ddl.ts` itself and
 * then normalized (`pnpm --filter @brainstrike/db db:schema:ddl`); the
 * renormalized DDL carries a new ledger key, which is what makes an
 * already-built profile refuse to open rather than drift. Editing
 * `src/schema/index.ts` alone does NOT change the shipped schema.
 */
export const migrations: Migration[] = [migration001CurrentSchema];

export { CURRENT_SCHEMA_DDL, CURRENT_SCHEMA_LEDGER_KEY } from './current-schema-ddl.js';
// Public route for the dimension-index helpers (BST-990 root-API drift --
// the root index previously bypassed this barrel for them).
export {
  createDimensionIndex,
  dimensionIndexIsReady,
  dropDimensionIndex,
  estimateEmbeddedRowCount,
  hnswParams,
  precreateEmptyDimensionIndex,
  resolveIndexBuildMaintenanceWorkMemMb,
  resumeDimensionIndexBuilds,
  suspendDimensionIndexBuilds,
  withIndexBuildMaintenanceWorkMem,
} from './dimension-index-helpers.js';
export type { Migration } from './migration-runner';
// Re-export types and runner
export { MigrationRunner } from './migration-runner.js';
