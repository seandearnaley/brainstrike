import type { PGlite } from '@electric-sql/pglite';
import { assertNoLegacyMigrationLedger } from '../architecture/db-migration-authority.js';
import { runMigrations } from '../drizzle/migrate.js';

/**
 * Production migration bootstrap for greenfield Brainstrike databases.
 */
export async function migrate(db: PGlite): Promise<void> {
  await assertNoLegacyMigrationLedger(db);

  const result = await runMigrations(db);
  if (!result.success) {
    throw new Error(result.error ?? 'Drizzle migration failed without an error message.');
  }
}
