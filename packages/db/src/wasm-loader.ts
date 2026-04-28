import { createLogger, isDevEnv, setupHMR } from '@brainstrike/utils';
import type { Extension } from '@electric-sql/pglite';
import { PGlite } from '@electric-sql/pglite';
import type { PGliteWorker, PGliteWorkerOptions } from '@electric-sql/pglite/worker';

type VectorExtension = Extension;
type LiveExtension = Extension;

export interface PGliteLeaderChangeSource {
  readonly offLeaderChange: (listener: () => void) => void;
  readonly onLeaderChange: (listener: () => void) => (() => void) | undefined;
}

export type PGliteRuntimeClient = Pick<PGlite, 'close' | 'exec' | 'query' | 'transaction'> & {
  readonly live?: unknown;
};

type BrowserPGliteWorkerClient = PGliteWorker & PGliteRuntimeClient & PGliteLeaderChangeSource;

const logger = createLogger('WasmLoader');

let cachedVectorPromise: Promise<VectorExtension> | null = null;
let cachedLivePromise: Promise<LiveExtension> | null = null;

async function loadVectorExtension(): Promise<VectorExtension> {
  if (!cachedVectorPromise) {
    cachedVectorPromise = (async () => {
      try {
        // Dynamic import for pgvector extension (ES module compatible)
        /* Stryker disable next-line StringLiteral */
        const { vector } = await import('@electric-sql/pglite/vector');
        return vector;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`pgvector extension is required and failed to load: ${message}`);
      }
    })();
  }

  return cachedVectorPromise;
}

async function loadLiveExtension(): Promise<LiveExtension> {
  if (!cachedLivePromise) {
    cachedLivePromise = (async () => {
      try {
        const { live } = await import('@electric-sql/pglite/live');
        return live;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`live query extension is required and failed to load: ${message}`);
      }
    })();
  }

  return cachedLivePromise;
}

class WasmLoader {
  private static instance: WasmLoader;
  private wasmLoadPromise: Promise<void> | null = null;
  private isLoaded = false;
  private readonly dbCache: Map<string, PGlite> = new Map();
  private readonly workerCache: Map<string, BrowserPGliteWorkerClient> = new Map();
  private readonly workerClientPromises: Map<string, Promise<BrowserPGliteWorkerClient>> =
    new Map();

  private constructor() {}

  static getInstance(): WasmLoader {
    if (!WasmLoader.instance) {
      WasmLoader.instance = new WasmLoader();
    }
    return WasmLoader.instance;
  }

  ensureWasmLoaded(): Promise<void> {
    if (this.isLoaded) {
      return Promise.resolve();
    }

    if (this.wasmLoadPromise) {
      return this.wasmLoadPromise;
    }

    this.wasmLoadPromise = this.loadWasm();
    return this.wasmLoadPromise;
  }

  private async loadWasm(): Promise<void> {
    try {
      // Just preload extensions - actual WASM loading happens when creating the real DB
      // This avoids creating a wasteful temporary database
      await Promise.all([loadVectorExtension(), loadLiveExtension()]);
      this.isLoaded = true;
      logger.debug('Extensions preloaded successfully');
    } catch (error) {
      this.wasmLoadPromise = null;
      throw error;
    }
  }

  async createPGlite(dataDir?: string): Promise<PGlite> {
    await this.ensureWasmLoaded();

    // Load vector extension asynchronously
    const [vector, live] = await Promise.all([loadVectorExtension(), loadLiveExtension()]);

    // Normalize in-memory indicator: map legacy ':memory:' to 'memory://'
    const normalizedDataDir = dataDir === ':memory:' ? 'memory://' : dataDir;

    // Use cache key for persistent databases to prevent double-open in dev mode
    // (React Strict Mode + HMR can cause multiple mounts without proper cleanup)
    const cacheKey = normalizedDataDir || 'default';

    // For persisted databases (idb://), reuse existing instance if available
    // This prevents TOAST corruption from concurrent IndexedDB access
    if (normalizedDataDir?.startsWith('idb://')) {
      const cached = this.dbCache.get(cacheKey);
      if (cached) {
        logger.info('Reusing cached PGlite instance', { cacheKey });
        return cached;
      }
    }

    // Enable relaxed durability for IndexedDB to dramatically improve write performance.
    // Under relaxed durability mode, PGlite doesn't wait for IndexedDB flushes after each query.
    // The flush is scheduled asynchronously after the query returns.
    // This is suitable for most embedded use cases where occasional data loss on crash is acceptable.
    // See: https://pglite.dev/docs/filesystems
    const useRelaxedDurability = normalizedDataDir?.startsWith('idb://');

    const db = normalizedDataDir
      ? new PGlite({
          dataDir: normalizedDataDir,
          extensions: { vector, live },
          ...(useRelaxedDurability ? { relaxedDurability: true } : {}),
        })
      : new PGlite({ extensions: { vector, live } });

    // Cache persisted databases only (not memory://)
    if (normalizedDataDir?.startsWith('idb://')) {
      this.dbCache.set(cacheKey, db);
    }

    return db;
  }

  async createPGliteClient(dataDir?: string): Promise<PGliteRuntimeClient> {
    const normalizedDataDir = dataDir === ':memory:' ? 'memory://' : dataDir;
    if (this.requiresBrowserWorkerHost(normalizedDataDir) && typeof Worker === 'undefined') {
      throw new Error('Browser IndexedDB PGlite requires Worker support');
    }
    if (!this.shouldUseBrowserWorkerHost(normalizedDataDir)) {
      return await this.createPGlite(normalizedDataDir);
    }

    const cacheKey = normalizedDataDir || 'default';
    const cached = this.workerCache.get(cacheKey);
    if (cached) {
      logger.info('Reusing cached PGlite worker client', { cacheKey });
      return cached;
    }

    const pending = this.workerClientPromises.get(cacheKey);
    if (pending) {
      logger.info('Reusing pending PGlite worker client', { cacheKey });
      return await pending;
    }

    const workerClientPromise = this.createBrowserWorkerClient(normalizedDataDir);
    this.workerClientPromises.set(cacheKey, workerClientPromise);

    try {
      const db = await workerClientPromise;
      this.workerCache.set(cacheKey, db);
      return db;
    } catch (error) {
      this.workerClientPromises.delete(cacheKey);
      throw error;
    }
  }

  private async createBrowserWorkerClient(dataDir: string): Promise<BrowserPGliteWorkerClient> {
    await this.ensureWasmLoaded();
    const live = await loadLiveExtension();
    const { PGliteWorker } = await import('@electric-sql/pglite/worker');
    const worker = new Worker(new URL('./pglite-worker-entry.ts', import.meta.url), {
      type: 'module',
    });
    try {
      const options: PGliteWorkerOptions<{ live: LiveExtension }> = {
        dataDir,
        extensions: { live },
        id: `brainstrike-db:${dataDir}`,
        relaxedDurability: true,
      };
      return await PGliteWorker.create(worker, options);
    } catch (error) {
      worker.terminate();
      throw error;
    }
  }

  private shouldUseBrowserWorkerHost(dataDir: string | undefined): dataDir is string {
    return typeof Worker !== 'undefined' && this.requiresBrowserWorkerHost(dataDir);
  }

  private requiresBrowserWorkerHost(dataDir: string | undefined): dataDir is string {
    return (
      typeof window !== 'undefined' && typeof dataDir === 'string' && dataDir.startsWith('idb://')
    );
  }

  /**
   * Closes and removes a cached PGlite instance.
   * Use this during cleanup to properly release resources.
   */
  async closeCached(dataDir?: string): Promise<void> {
    const normalizedDataDir = dataDir === ':memory:' ? 'memory://' : dataDir;
    const cacheKey = normalizedDataDir || 'default';

    const db = this.dbCache.get(cacheKey);
    if (db) {
      this.dbCache.delete(cacheKey);
      try {
        await db.close();
        logger.info('Closed and removed cached PGlite instance', { cacheKey });
      } catch (err) {
        logger.warn('Failed to close cached PGlite instance', { cacheKey, error: err });
      }
    }

    const pendingWorkerDb = this.workerClientPromises.get(cacheKey);
    const workerDb = this.workerCache.get(cacheKey);
    if (workerDb) {
      this.workerCache.delete(cacheKey);
      this.workerClientPromises.delete(cacheKey);
      try {
        await workerDb.close();
        logger.info('Closed and removed cached PGlite worker client', { cacheKey });
      } catch (err) {
        logger.warn('Failed to close cached PGlite worker client', { cacheKey, error: err });
      }
    } else if (pendingWorkerDb) {
      this.workerClientPromises.delete(cacheKey);
      try {
        const pendingDb = await pendingWorkerDb;
        this.workerCache.delete(cacheKey);
        await pendingDb.close();
        logger.info('Closed pending PGlite worker client', { cacheKey });
      } catch (err) {
        logger.warn('Failed to close pending PGlite worker client', { cacheKey, error: err });
      }
    }
  }

  /**
   * Close all cached PGlite instances and reset loader state.
   * Used during HMR dispose to prevent stale DB handles surviving module replacement.
   */
  async disposeAll(): Promise<void> {
    const entries = Array.from(this.dbCache.entries());
    const workerEntries = Array.from(this.workerCache.entries());
    this.dbCache.clear();
    this.workerCache.clear();
    this.workerClientPromises.clear();
    this.wasmLoadPromise = null;
    this.isLoaded = false;

    await Promise.all(
      [...entries, ...workerEntries].map(async ([cacheKey, db]) => {
        try {
          await db.close();
          logger.info('HMR dispose: closed cached PGlite instance', { cacheKey });
        } catch (err) {
          logger.warn('HMR dispose: failed to close PGlite instance', { cacheKey, error: err });
        }
      })
    );
  }

  /**
   * Deletes an IndexedDB database for PGlite storage.
   * This is necessary for factory reset to fully wipe corrupted database state.
   *
   * @param dataDir - The PGlite dataDir path (e.g., 'idb://app')
   * @returns Promise that resolves when deletion completes
   */
  async deleteIndexedDB(dataDir: string): Promise<void> {
    if (typeof window === 'undefined' || !window.indexedDB) {
      throw new Error('IndexedDB is not available in this environment');
    }

    // Extract database name from idb:// path
    // PGlite uses format: idb://dbname or idb://prefix/dbname
    const idbPrefix = 'idb://';
    if (!dataDir.startsWith(idbPrefix)) {
      throw new Error(`Cannot delete non-IndexedDB path: ${dataDir}`);
    }

    const dbName = dataDir.slice(idbPrefix.length);
    if (!dbName) {
      throw new Error('Invalid IndexedDB path: database name is empty');
    }

    return new Promise<void>((resolve, reject) => {
      const request = window.indexedDB.deleteDatabase(dbName);

      request.onsuccess = () => {
        logger.info('Deleted IndexedDB database for PGlite', { dbName });
        resolve();
      };

      request.onerror = () => {
        const error = new Error(`Failed to delete IndexedDB database: ${dbName}`);
        logger.error('Failed to delete IndexedDB database', {
          dbName,
          error,
          requestError: request.error,
        });
        reject(error);
      };

      request.onblocked = () => {
        logger.warn('IndexedDB deletion blocked', {
          dbName,
          message: 'Close all tabs/connections.',
        });
        // Don't reject - the database will be deleted when connections close
      };
    });
  }
}

export const wasmLoader = WasmLoader.getInstance();

// Reset module-level extension caches during HMR so stale promise references
// from the previous module instance don't leak into the replacement.
function resetExtensionCaches(): void {
  cachedVectorPromise = null;
  cachedLivePromise = null;
}

/**
 * Dispose function exposed for testing.
 * In dev mode, also registered as a Vite HMR dispose handler to close
 * cached DB instances when this module is hot-replaced.
 */
export async function disposeWasmLoader(): Promise<void> {
  resetExtensionCaches();
  await wasmLoader.disposeAll();
}

if (isDevEnv()) {
  setupHMR(undefined, async () => {
    await disposeWasmLoader();
  });
}
