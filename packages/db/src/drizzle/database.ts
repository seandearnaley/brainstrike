/**
 * Drizzle Database Utility
 *
 * Provides utilities for creating and managing Drizzle ORM database
 * instances from PGlite connections.
 */

import type { PGlite } from '@electric-sql/pglite';
import { drizzle as createDrizzle, type PgliteDatabase } from 'drizzle-orm/pglite';

export type DrizzleDb = PgliteDatabase;
type PGliteCompatibleClient = Pick<PGlite, 'exec' | 'query' | 'transaction'>;

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
 * Type guard to check if a database handle contains a raw PGlite-compatible execution client
 */
export function hasPGliteRaw(db: unknown): db is { raw: PGliteCompatibleClient } {
  return (
    typeof db === 'object' &&
    db !== null &&
    'raw' in db &&
    isPGliteCompatibleClient((db as { raw: unknown }).raw)
  );
}

function isPGliteCompatibleClient(value: unknown): value is PGliteCompatibleClient {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { exec?: unknown }).exec === 'function' &&
    typeof (value as { query?: unknown }).query === 'function' &&
    typeof (value as { transaction?: unknown }).transaction === 'function'
  );
}

/**
 * Extract a PGlite-compatible execution client from a database handle if available
 */
export function extractPGlite(db: unknown): PGliteCompatibleClient | null {
  if (hasPGliteRaw(db)) {
    return db.raw;
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
    // Drizzle's PGlite adapter is typed to the concrete PGlite class, while
    // DbHandle.raw may expose a scheduled PGliteWorker-compatible client with
    // the same query/exec/transaction execution surface. Keep this bridge
    // explicit to DbHandle.raw so arbitrary structural objects are not accepted.
    return drizzle(pglite as unknown as PGlite);
  }
  return null;
}
