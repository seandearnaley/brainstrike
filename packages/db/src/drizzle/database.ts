/**
 * Drizzle Database Utility
 *
 * Provides utilities for creating and managing Drizzle ORM database
 * instances from PGlite connections.
 */

import type { PGlite } from '@electric-sql/pglite';
import { drizzle as createDrizzle, type PgliteDatabase } from 'drizzle-orm/pglite';

export type DrizzleDb = PgliteDatabase;

/**
 * Create a Drizzle database instance from a PGlite connection.
 *
 * @example
 * ```typescript
 * import { PGlite } from '@electric-sql/pglite';
 * import { drizzle } from '@brainstrike/db';
 *
 * const pglite = new PGlite('idb://mydb');
 * const db = drizzle(pglite);
 *
 * // Now use with Drizzle repositories
 * const repo = new DrizzleFileRecordRepository(db);
 * ```
 */
export function drizzle(pglite: PGlite): DrizzleDb {
  return createDrizzle(pglite);
}

/**
 * Type guard to check if a database handle contains a raw PGlite instance
 */
export function hasPGliteRaw(db: unknown): db is { raw: PGlite } {
  return (
    typeof db === 'object' &&
    db !== null &&
    'raw' in db &&
    typeof (db as { raw: unknown }).raw === 'object' &&
    (db as { raw: { query?: unknown } }).raw !== null &&
    typeof (db as { raw: { query?: unknown } }).raw.query === 'function'
  );
}

/**
 * Extract PGlite instance from a database handle if available
 */
export function extractPGlite(db: unknown): PGlite | null {
  if (hasPGliteRaw(db)) {
    return db.raw as PGlite;
  }
  return null;
}

/**
 * Create a Drizzle database from a DbHandle (from DbProvider context).
 *
 * @example
 * ```typescript
 * const dbHandle = usePGliteDatabase();
 * const drizzleDb = drizzleFromHandle(dbHandle);
 * if (drizzleDb) {
 *   const repo = new DrizzleFileRecordRepository(drizzleDb);
 * }
 * ```
 */
export function drizzleFromHandle(dbHandle: unknown): DrizzleDb | null {
  const pglite = extractPGlite(dbHandle);
  if (pglite) {
    return drizzle(pglite);
  }
  return null;
}
