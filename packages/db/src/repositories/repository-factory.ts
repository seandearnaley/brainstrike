import type { PGlite } from '@electric-sql/pglite';
import { FileRecordRepository } from './file-record-repository.js';
import type { IFileRecordRepository } from './interfaces.js';

/**
 * Create a FileRecordRepository for the given database.
 *
 * @deprecated Prefer using DrizzleFileRecordRepository directly via
 * the DbProvider hooks (useFileRecordRepository). This factory returns the legacy
 * raw SQL FileRecordRepository for PGlite which is being phased out.
 * Kept for backward compatibility with existing tests.
 */
export function createFileRecordRepository(db: PGlite): IFileRecordRepository {
  return new FileRecordRepository(db);
}

/**
 * Type guard to check if database is PGlite
 */
export function isPGlite(db: unknown): db is PGlite {
  return (
    typeof db === 'object' && db !== null && 'exec' in db && 'listen' in db && 'unlisten' in db
  );
}
