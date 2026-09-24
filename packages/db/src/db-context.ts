/**
 * The DbProvider context object and its value type, in a React-coupled but
 * component-free module so both `db-provider.tsx` (the provider component)
 * and `use-db.ts` (the consumer hooks) can share them without either file
 * importing the other. Keeping `createContext` out of the component file also
 * keeps the context identity stable across Fast Refresh: replacing the
 * provider module must not mint a new context and orphan mounted consumers.
 *
 * React-coupled: this module must never become reachable from the root
 * barrel (`src/index.ts`) — `architecture-ownership.test.ts` walks the root
 * import graph and fails on any React import.
 */
import { createContext } from 'react';
import type { DbInitializationStatus } from './database-runtime.js';
import type { DbHandle } from './db-handle.js';
import type { LiveQueryDrainRegistry } from './db-reset-drain.js';
import type { DrizzleDb } from './drizzle/database.js';
import type { DrizzleFileRecordRepository } from './repositories/drizzle/file-record-repository.js';
import type { ElectronFileRecordRepository } from './repositories/electron-file-record-repository.js';
import type {
  IEmbeddingSetsRepository,
  IFileChunkRepository,
  IViewFilterPresetsRepository,
} from './repositories/interfaces.js';

/**
 * Re-exported, not declared here: the status is RUNTIME state (BST-1653), and
 * `database-runtime.ts` must never import from this React-coupled module — a
 * value import added later would leak React into the runtime.
 */
export type { DbInitializationStatus } from './database-runtime.js';

export interface DbContextValue {
  chunkRepository: IFileChunkRepository | null;
  clearAllData: () => Promise<{ deletedFiles: number; deletedChunks: number }>;
  clearQueuesAndEmbeddingSets: () => Promise<void>; // Helper to purge job_queue and embedding_sets
  db: DbHandle | null;
  drizzleDb: DrizzleDb | null; // Drizzle instance for direct access
  embeddingSetsRepository: IEmbeddingSetsRepository | null;
  error: Error | null;
  factoryReset: () => Promise<void>; // Close DB, wipe state, reinitialize
  fileRecordRepository: DrizzleFileRecordRepository | ElectronFileRecordRepository | null;
  initializationStatus: DbInitializationStatus;
  initializeDatabase: () => Promise<void>; // Lazy initialization trigger
  initializing: boolean; // Whether database initialization is in progress
  /**
   * Provider-scoped registry `usePGliteLiveQuery` handles register into so
   * factory reset / unmount can AWAIT unsubscribing them before a PGlite
   * `close()` — a still-subscribed handle's internal refresh statements race
   * close into the BST-1320 wedge (BST-1329).
   */
  liveQueryDrainRegistry: LiveQueryDrainRegistry;
  ready: boolean;
  vectorEnabled: boolean; // Whether pgvector extension is available
  viewFilterPresetsRepository: IViewFilterPresetsRepository | null;
}

export const DbContext = createContext<DbContextValue | undefined>(undefined);
