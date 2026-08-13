/**
 * The DbProvider consumer hooks, split out of `db-provider.tsx` so that file
 * exports only the component: mixing hook and component exports breaks the
 * Vite Fast Refresh boundary (identity-based — see
 * docs/agents/ci-quality.md), downgrading every provider edit to a full
 * reload. Public API is unchanged: everything here re-exports through
 * `@brainstrike/db/react`.
 *
 * React-coupled: this module must never become reachable from the root
 * barrel (`src/index.ts`) — `architecture-ownership.test.ts` walks the root
 * import graph and fails on any React import.
 */
import { createLogger } from '@brainstrike/logging';
import { useContext, useEffect } from 'react';
import { DbContext, type DbInitializationStatus } from './db-context.js';
import type { DbHandle } from './db-handle.js';
import type { DrizzleDb } from './drizzle/database.js';
import type { DrizzleFileChunkRepository } from './repositories/drizzle/file-chunk-repository.js';
import type { DrizzleFileRecordRepository } from './repositories/drizzle/file-record-repository.js';
import type { ElectronFileChunkRepository } from './repositories/electron-file-chunk-repository.js';
import type { ElectronFileRecordRepository } from './repositories/electron-file-record-repository.js';
import type {
  IEmbeddingSetsRepository,
  IViewFilterPresetsRepository,
} from './repositories/interfaces.js';

// Same channel as db-provider.tsx: these hooks are the provider's consumer
// surface, and their warnings should land in the same place they always have.
const logger = createLogger('DbProvider');

function logDatabaseError(message: string, error: unknown): void {
  logger.error({ err: error }, message);
}

export function useVectorEnabled(): boolean {
  const context = useContext(DbContext);
  if (context === undefined) {
    throw new Error('useVectorEnabled must be used within a DbProvider');
  }
  return context.vectorEnabled;
}

/**
 * Hook to check if database initialization is in progress.
 * Useful for showing loading states in UI components.
 */
export function useDbInitializing(): boolean {
  const ctx = useContext(DbContext);
  if (!ctx) {
    throw new Error('useDbInitializing must be used within a DbProvider');
  }
  return ctx.initializing;
}

/**
 * Hook to inspect the lazy database initialization lifecycle.
 * `ready` on the provider context only means the provider is mounted; this
 * status is the deterministic signal for whether DB init is idle, in flight,
 * complete, or failed.
 */
export function useDbInitializationStatus(): DbInitializationStatus {
  const ctx = useContext(DbContext);
  if (!ctx) {
    throw new Error('useDbInitializationStatus must be used within a DbProvider');
  }
  return ctx.initializationStatus;
}

export function useFileRecordRepository():
  | DrizzleFileRecordRepository
  | ElectronFileRecordRepository
  | null {
  const ctx = useContext(DbContext);

  // Destructure to get stable references for dependency array
  const fileRecordRepository = ctx?.fileRecordRepository;
  const error = ctx?.error;
  const initializing = ctx?.initializing;
  const initializeDatabase = ctx?.initializeDatabase;

  // Trigger lazy initialization when first accessed
  // Only trigger if not already initializing to avoid duplicate calls
  useEffect(() => {
    if (!(fileRecordRepository || error || initializing) && initializeDatabase) {
      initializeDatabase().catch((err) => {
        logDatabaseError('Failed to lazy-initialize database', err);
      });
    }
  }, [fileRecordRepository, error, initializing, initializeDatabase]);

  if (!ctx) {
    logger.warn('useFileRecordRepository must be used within a DbProvider');
    return null;
  }

  return ctx.ready && !ctx.error ? ctx.fileRecordRepository : null;
}

export function usePGliteDatabase(): DbHandle | null {
  const ctx = useContext(DbContext);

  // Destructure to get stable references for dependency array
  const db = ctx?.db;
  const error = ctx?.error;
  const initializing = ctx?.initializing;
  const initializeDatabase = ctx?.initializeDatabase;

  // Trigger lazy initialization when first accessed
  // Only trigger if not already initializing to avoid duplicate calls
  useEffect(() => {
    if (!(db || error || initializing) && initializeDatabase) {
      initializeDatabase().catch((err) => {
        logDatabaseError('Failed to lazy-initialize database', err);
      });
    }
  }, [db, error, initializing, initializeDatabase]);

  if (!ctx) {
    logger.warn('usePGliteDatabase must be used within a DbProvider');
    return null;
  }

  return ctx.ready && !ctx.error ? ctx.db : null;
}

export function useOptionalPGliteDatabase(): DbHandle | null {
  const ctx = useContext(DbContext);
  const db = ctx?.db;
  const error = ctx?.error;
  const initializing = ctx?.initializing;
  const initializeDatabase = ctx?.initializeDatabase;

  useEffect(() => {
    if (!(db || error || initializing) && initializeDatabase) {
      initializeDatabase().catch((err) => {
        logDatabaseError('Failed to lazy-initialize database', err);
      });
    }
  }, [db, error, initializing, initializeDatabase]);

  return ctx?.ready && !ctx.error ? ctx.db : null;
}

export function useDbProviderError(): Error | null {
  const ctx = useContext(DbContext);
  if (!ctx) {
    throw new Error('useDbProviderError must be used within a DbProvider');
  }
  return ctx.error;
}

export function useFileChunkRepository():
  | DrizzleFileChunkRepository
  | ElectronFileChunkRepository
  | null {
  const ctx = useContext(DbContext);

  // Destructure to get stable references for dependency array
  const chunkRepository = ctx?.chunkRepository;
  const error = ctx?.error;
  const initializing = ctx?.initializing;
  const initializeDatabase = ctx?.initializeDatabase;

  // Trigger lazy initialization when first accessed
  // Only trigger if not already initializing to avoid duplicate calls
  useEffect(() => {
    if (!(chunkRepository || error || initializing) && initializeDatabase) {
      initializeDatabase().catch((err) => {
        logDatabaseError('Failed to lazy-initialize database', err);
      });
    }
  }, [chunkRepository, error, initializing, initializeDatabase]);

  if (!ctx) {
    logger.warn('useFileChunkRepository must be used within a DbProvider');
    return null;
  }

  return ctx.ready && !ctx.error ? ctx.chunkRepository : null;
}

export function useClearAllData():
  | (() => Promise<{ deletedFiles: number; deletedChunks: number }>)
  | null {
  const ctx = useContext(DbContext);

  // Destructure to get stable references for dependency array
  const fileRecordRepository = ctx?.fileRecordRepository;
  const error = ctx?.error;
  const initializing = ctx?.initializing;
  const initializeDatabase = ctx?.initializeDatabase;

  // Trigger lazy initialization when first accessed
  // Only trigger if not already initializing to avoid duplicate calls
  useEffect(() => {
    if (!(fileRecordRepository || error || initializing) && initializeDatabase) {
      initializeDatabase().catch((err) => {
        logDatabaseError('Failed to lazy-initialize database', err);
      });
    }
  }, [fileRecordRepository, error, initializing, initializeDatabase]);

  if (!ctx) {
    logger.warn('useClearAllData must be used within a DbProvider');
    return null;
  }

  return ctx.ready && !ctx.error ? ctx.clearAllData : null;
}

export function useFactoryReset(): (() => Promise<void>) | null {
  const ctx = useContext(DbContext);

  // Destructure to get stable references for dependency array
  const db = ctx?.db;
  const error = ctx?.error;
  const initializing = ctx?.initializing;
  const initializeDatabase = ctx?.initializeDatabase;

  // Trigger lazy initialization when first accessed
  // Only trigger if not already initializing to avoid duplicate calls
  useEffect(() => {
    if (!(db || error || initializing) && initializeDatabase) {
      initializeDatabase().catch((err) => {
        logDatabaseError('Failed to lazy-initialize database', err);
      });
    }
  }, [db, error, initializing, initializeDatabase]);

  if (!ctx) {
    return null;
  }
  return ctx.ready && !ctx.error ? ctx.factoryReset : null;
}

export function useClearQueuesAndEmbeddingSets(): (() => Promise<void>) | null {
  const ctx = useContext(DbContext);

  // Destructure to get stable references for dependency array
  const db = ctx?.db;
  const error = ctx?.error;
  const initializing = ctx?.initializing;
  const initializeDatabase = ctx?.initializeDatabase;

  // Trigger lazy initialization when first accessed
  // Only trigger if not already initializing to avoid duplicate calls
  useEffect(() => {
    if (!(db || error || initializing) && initializeDatabase) {
      initializeDatabase().catch((err) => {
        logDatabaseError('Failed to lazy-initialize database', err);
      });
    }
  }, [db, error, initializing, initializeDatabase]);

  if (!ctx) {
    return null;
  }
  return ctx.ready && !ctx.error ? ctx.clearQueuesAndEmbeddingSets : null;
}

/**
 * Hook to access the Drizzle database instance directly.
 * Use this for advanced queries or when you need the raw Drizzle instance.
 */
export function useDrizzleDb(): DrizzleDb | null {
  const ctx = useContext(DbContext);

  // Destructure to get stable references for dependency array
  const drizzleDb = ctx?.drizzleDb;
  const error = ctx?.error;
  const initializing = ctx?.initializing;
  const initializeDatabase = ctx?.initializeDatabase;

  // Trigger lazy initialization when first accessed
  useEffect(() => {
    if (!(drizzleDb || error || initializing) && initializeDatabase) {
      initializeDatabase().catch((err) => {
        logDatabaseError('Failed to lazy-initialize database', err);
      });
    }
  }, [drizzleDb, error, initializing, initializeDatabase]);

  if (!ctx) {
    logger.warn('useDrizzleDb must be used within a DbProvider');
    return null;
  }

  return ctx.ready && !ctx.error ? ctx.drizzleDb : null;
}

/**
 * Hook to access the EmbeddingSets repository.
 * Use this to manage embedding sets (collections) in the database.
 */
export function useEmbeddingSetsRepository(): IEmbeddingSetsRepository | null {
  const ctx = useContext(DbContext);

  // Destructure to get stable references for dependency array
  const embeddingSetsRepository = ctx?.embeddingSetsRepository;
  const error = ctx?.error;
  const initializing = ctx?.initializing;
  const initializeDatabase = ctx?.initializeDatabase;

  // Trigger lazy initialization when first accessed
  useEffect(() => {
    if (!(embeddingSetsRepository || error || initializing) && initializeDatabase) {
      initializeDatabase().catch((err) => {
        logDatabaseError('Failed to lazy-initialize database', err);
      });
    }
  }, [embeddingSetsRepository, error, initializing, initializeDatabase]);

  if (!ctx) {
    logger.warn('useEmbeddingSetsRepository must be used within a DbProvider');
    return null;
  }

  return ctx.ready && !ctx.error ? ctx.embeddingSetsRepository : null;
}

/**
 * Hook to access the ViewFilterPresets repository.
 * Use this to manage view filter presets (include/exclude patterns) in the database.
 */
export function useViewFilterPresetsRepository(): IViewFilterPresetsRepository | null {
  const ctx = useContext(DbContext);

  // Destructure to get stable references for dependency array
  const viewFilterPresetsRepository = ctx?.viewFilterPresetsRepository;
  const error = ctx?.error;
  const initializing = ctx?.initializing;
  const initializeDatabase = ctx?.initializeDatabase;

  // Trigger lazy initialization when first accessed
  useEffect(() => {
    if (!(viewFilterPresetsRepository || error || initializing) && initializeDatabase) {
      initializeDatabase().catch((err) => {
        logDatabaseError('Failed to lazy-initialize database', err);
      });
    }
  }, [viewFilterPresetsRepository, error, initializing, initializeDatabase]);

  if (!ctx) {
    logger.warn('useViewFilterPresetsRepository must be used within a DbProvider');
    return null;
  }

  return ctx.ready && !ctx.error ? ctx.viewFilterPresetsRepository : null;
}
