/**
 * Drizzle Database Utility
 *
 * Provides utilities for creating and managing Drizzle ORM database
 * instances from PGlite connections.
 */

import type { PGlite } from '@electric-sql/pglite';
import { drizzle as createDrizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import {
  type BrainstrikeDbExecutionClient,
  markBrainstrikeDbExecutionRuntime,
} from '../architecture/brainstrike-db-client-contract.js';

export const BRAINSTRIKE_PGLITE_DRIZZLE_COMPATIBLE = Symbol.for(
  'brainstrike.db.pglite-drizzle-compatible'
);

export type DrizzleDb = PgliteDatabase;
interface PGliteDrizzleCompatibilityMarker {
  readonly [BRAINSTRIKE_PGLITE_DRIZZLE_COMPATIBLE]: true;
}
type PGliteCompatibleClient = BrainstrikeDbExecutionClient & PGliteDrizzleCompatibilityMarker;

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

export function markPGliteDrizzleCompatible<TClient extends object>(
  client: TClient
): TClient & PGliteDrizzleCompatibilityMarker {
  markBrainstrikeDbExecutionRuntime(client, 'pglite');
  Object.defineProperty(client, BRAINSTRIKE_PGLITE_DRIZZLE_COMPATIBLE, {
    value: true,
    enumerable: false,
    configurable: false,
  });
  return client as TClient & PGliteDrizzleCompatibilityMarker;
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
  return hasDbExecutionClientRaw(db) && isPGliteDrizzleCompatible(db.raw);
}

/**
 * Extract a PGlite-compatible execution client from a database handle if available.
 *
 * @deprecated Prefer extractDbExecutionClient for runtime-neutral call sites.
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
    // Drizzle's PGlite adapter is typed to the concrete PGlite class. The raw
    // bridge must be explicitly marked by the PGlite owner path so future
    // Turso-shaped execution clients cannot enter this Postgres adapter.
    return drizzle(pglite as unknown as PGlite);
  }
  return null;
}

function isPGliteDrizzleCompatible(
  value: BrainstrikeDbExecutionClient
): value is PGliteCompatibleClient {
  return (
    (value as { [BRAINSTRIKE_PGLITE_DRIZZLE_COMPATIBLE]?: unknown })[
      BRAINSTRIKE_PGLITE_DRIZZLE_COMPATIBLE
    ] === true
  );
}
