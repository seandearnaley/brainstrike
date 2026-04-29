import type { PGlite } from '@electric-sql/pglite';
import { runMigrations } from '../drizzle/migrate.js';

/**
 * Production migration bootstrap for greenfield Brainstrike databases.
 */
export async function migrate(db: PGlite): Promise<void> {
  const result = await runMigrations(db);
  if (!result.success) {
    throw new Error(result.error ?? 'Drizzle migration failed without an error message.');
  }
}
