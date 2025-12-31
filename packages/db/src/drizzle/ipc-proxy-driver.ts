/**
 * Drizzle IPC Proxy Driver
 *
 * Creates a Drizzle ORM instance that sends queries over Electron IPC.
 * This allows the Electron renderer process to use type-safe Drizzle
 * repositories while the actual database lives in the main process.
 *
 * Row key transformation (snake_case → camelCase) is handled centrally
 * in the main process IPC handlers (apps/desktop/src/ipc-handlers.ts),
 * so this driver simply passes through the already-transformed results.
 *
 * @example
 * ```typescript
 * // In Electron renderer process
 * const db = createIPCProxyDrizzle(window.electronAPI.db);
 * const repo = new DrizzleFileRecordRepository(db);
 * const records = await repo.findAll();
 * ```
 */

import type { ElectronDatabaseAPI } from '@brainstrike/types';
import { createLogger } from '@brainstrike/utils';
import {
  drizzle as createPgProxyDrizzle,
  type PgRemoteDatabase,
  type RemoteCallback,
} from 'drizzle-orm/pg-proxy';

const logger = createLogger('IPCProxyDriver');

/**
 * Database type for IPC proxy connections.
 * Compatible with PgliteDatabase for repository usage.
 */
export type IPCProxyDb = PgRemoteDatabase;

/**
 * Create a RemoteCallback that sends queries over Electron IPC.
 *
 * The callback translates Drizzle's query interface to the IPC API:
 * - 'all' method → db.query() for SELECT statements
 * - 'execute' method → db.query() for INSERT/UPDATE/DELETE (we use query for all)
 *
 * Note: Row key transformation (snake_case → camelCase) is handled by the
 * main process IPC handlers, not here. This keeps the transformation centralized.
 *
 * @param electronDb - The Electron IPC database API
 * @returns A RemoteCallback compatible with drizzle-orm/pg-proxy
 */
export function createIPCRemoteCallback(electronDb: ElectronDatabaseAPI): RemoteCallback {
  return async (
    sql: string,
    params: unknown[],
    method: 'all' | 'execute',
    _typings?: unknown[]
  ): Promise<{ rows: unknown[] }> => {
    logger.debug('IPC query', { method, sqlPreview: sql.slice(0, 100) });

    try {
      // Both 'all' and 'execute' methods use query() - PGlite handles both
      // Row transformation happens in the main process (ipc-handlers.ts)
      const result = await electronDb.query(sql, params);

      logger.debug('IPC query result', {
        method,
        rowCount: result.rows.length,
        sampleKeys: result.rows[0] ? Object.keys(result.rows[0] as object).slice(0, 5) : [],
      });

      return { rows: result.rows };
    } catch (error) {
      logger.error('IPC query failed', {
        method,
        sql: sql.slice(0, 200),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };
}

/**
 * Create a Drizzle database instance that operates over Electron IPC.
 *
 * This function creates a Drizzle ORM instance using the pg-proxy driver,
 * which sends all queries through the Electron IPC bridge to the main process
 * where PGlite actually executes them.
 *
 * Benefits:
 * - Type-safe Drizzle queries in renderer process
 * - Database operations don't block UI
 * - Same repository code works for both web and Electron
 *
 * @param electronDb - The Electron IPC database API (window.electronAPI.db)
 * @returns A Drizzle database instance
 *
 * @example
 * ```typescript
 * const db = createIPCProxyDrizzle(window.electronAPI.db);
 *
 * // Use with Drizzle query builder
 * const records = await db.select().from(fileRecords).where(eq(fileRecords.id, '123'));
 *
 * // Or with repositories
 * const repo = new DrizzleFileRecordRepository(db);
 * ```
 */
export function createIPCProxyDrizzle(electronDb: ElectronDatabaseAPI): IPCProxyDb {
  const callback = createIPCRemoteCallback(electronDb);
  return createPgProxyDrizzle(callback, {
    logger: process.env['NODE_ENV'] === 'development',
    // Map snake_case database columns to camelCase JavaScript properties
    // This is essential for IPC serialization where PGlite returns snake_case
    // column names that need to match schema-defined camelCase properties
    casing: 'snake_case',
  });
}

/**
 * Type guard to check if a database is an IPC proxy database.
 */
export function isIPCProxyDb(db: unknown): db is IPCProxyDb {
  return (
    typeof db === 'object' &&
    db !== null &&
    'dialect' in db &&
    typeof (db as { dialect?: { name?: string } }).dialect === 'object' &&
    (db as { dialect: { name: string } }).dialect?.name === 'pg'
  );
}
