/**
 * Drizzle Database Utility
 *
 * Provides utilities for creating and managing Drizzle ORM database
 * instances from PGlite connections.
 */

import type { PGlite } from '@electric-sql/pglite';
import type { PgRemoteDatabase } from 'drizzle-orm/pg-proxy';
import { drizzle as createDrizzle, type PgliteDatabase } from 'drizzle-orm/pglite';

/**
 * Unified Drizzle database type that works with both:
 * - PGlite (direct browser/web path)
 * - pg-proxy (Electron IPC path)
 *
 * Both implementations provide the same query interface, differing only
 * in internal session types. Repositories use this unified type.
 */
export type DrizzleDb = PgliteDatabase | PgRemoteDatabase;

/**
 * Result type from Drizzle execute() - can be either:
 * - Results<T> from PGlite (has .rows property)
 * - T[] from pg-proxy (direct array)
 */
type ExecuteResult<T> = T[] | { rows: T[] };

/**
 * Extract rows from a Drizzle execute() result.
 *
 * This normalizes the difference between PGlite and pg-proxy:
 * - PGlite returns Results<T> with a .rows property
 * - pg-proxy returns T[] directly
 *
 * @param result - The result from db.execute()
 * @returns The rows array
 */
export function extractRows<T>(result: ExecuteResult<T>): T[] {
  if (Array.isArray(result)) {
    return result;
  }
  return result.rows;
}

/**
 * Normalize a date value to an ISO string.
 *
 * Handles the difference between PGlite and pg-proxy:
 * - PGlite returns Date objects
 * - pg-proxy returns ISO strings (dates are serialized over IPC)
 *
 * Also handles undefined/null gracefully by returning current timestamp,
 * which can occur due to column mapping issues with pg-proxy.
 *
 * @param value - Date object, ISO string, or undefined/null
 * @returns ISO string representation
 */
export function toISOString(value: Date | string | undefined | null): string {
  if (value === undefined || value === null) {
    // Defensive fallback for missing date fields
    // This shouldn't happen, but prevents crashes in IPC scenarios
    return new Date().toISOString();
  }
  if (typeof value === 'string') {
    return value;
  }
  return value.toISOString();
}

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
