/**
 * Drizzle Database Utility
 *
 * Provides utilities for creating and managing Drizzle ORM database
 * instances from PGlite connections.
 */

import type { PGlite } from '@electric-sql/pglite';
import { drizzle as createDrizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import type { BrainstrikeDbExecutionClient } from '../architecture/brainstrike-db-client-contract.js';

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
 * Type guard to check if a database handle contains a raw dialect-neutral execution client.
 */
export function hasDbExecutionClientRaw(db: unknown): db is {
  raw: BrainstrikeDbExecutionClient;
} {
  return (
    typeof db === 'object' &&
    db !== null &&
    'raw' in db &&
    isDbExecutionClient((db as { raw: unknown }).raw)
  );
}

function isDbExecutionClient(value: unknown): value is BrainstrikeDbExecutionClient {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { exec?: unknown }).exec === 'function' &&
    typeof (value as { query?: unknown }).query === 'function' &&
    typeof (value as { transaction?: unknown }).transaction === 'function'
  );
}

/**
 * Extract a dialect-neutral execution client from a database handle if available.
 */
export function extractDbExecutionClient(db: unknown): BrainstrikeDbExecutionClient | null {
  if (hasDbExecutionClientRaw(db)) {
    return db.raw;
  }
  return null;
}

/**
 * Type guard to check if a database handle contains a raw PGlite-compatible execution client.
 *
 * @deprecated Prefer hasDbExecutionClientRaw for runtime-neutral call sites.
 */
export function hasPGliteRaw(db: unknown): db is { raw: PGliteCompatibleClient } {
  return hasDbExecutionClientRaw(db);
}

/**
 * Extract a PGlite-compatible execution client from a database handle if available.
 *
 * @deprecated Prefer extractDbExecutionClient for runtime-neutral call sites.
 */
export function extractPGlite(db: unknown): PGliteCompatibleClient | null {
  return extractDbExecutionClient(db) as PGliteCompatibleClient | null;
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
  const pglite = extractDbExecutionClient(dbHandle);
  if (pglite) {
    // Drizzle's PGlite adapter is typed to the concrete PGlite class, while
    // DbHandle.raw may expose a scheduled PGliteWorker-compatible client with
    // the same query/exec/transaction execution surface. Keep this bridge
    // explicit to DbHandle.raw so arbitrary structural objects are not accepted.
    return drizzle(pglite as unknown as PGlite);
  }
  return null;
}
