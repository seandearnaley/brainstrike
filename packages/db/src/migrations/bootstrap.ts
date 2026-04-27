import type { PGlite } from '@electric-sql/pglite';
import { assertNoConflictingMigrationLedger } from '../architecture/db-migration-authority.js';
import { MigrationRunner, migrations } from './index.js';

/**
 * Legacy bootstrap function - now uses the migration system
 * @deprecated Use MigrationRunner directly for new code
 */
export async function migrate(db: PGlite) {
  await assertNoConflictingMigrationLedger(db);

  const runner = new MigrationRunner(db);
  await runner.initialize();
  await runner.up(migrations);
}
