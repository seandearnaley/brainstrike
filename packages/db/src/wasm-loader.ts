import { createLogger } from '@brainstrike/utils';
import type { Extension } from '@electric-sql/pglite';
import { PGlite } from '@electric-sql/pglite';

type VectorExtension = Extension;
type LiveExtension = Extension;

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
      // Load vector extension asynchronously
      const [vector, live] = await Promise.all([loadVectorExtension(), loadLiveExtension()]);

      // Create a temporary PGlite instance to trigger WASM loading with pgvector
      const tempDbPath = 'memory://';
      const tempDb = new PGlite({ dataDir: tempDbPath, extensions: { vector, live } });

      // Ensure the database is ready (this loads the WASM)
      await tempDb.query('SELECT 1');

      // Close the temporary database
      await tempDb.close();

      this.isLoaded = true;
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

    const db = normalizedDataDir
      ? new PGlite({ dataDir: normalizedDataDir, extensions: { vector, live } })
      : new PGlite({ extensions: { vector, live } });

    // Cache persisted databases only (not memory://)
    if (normalizedDataDir?.startsWith('idb://')) {
      this.dbCache.set(cacheKey, db);
    }

    return db;
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
