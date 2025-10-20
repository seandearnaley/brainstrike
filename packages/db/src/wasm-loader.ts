import type { Extension } from '@electric-sql/pglite';
import { PGlite } from '@electric-sql/pglite';

type VectorExtension = Extension;

let cachedVectorPromise: Promise<VectorExtension> | null = null;

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

class WasmLoader {
  private static instance: WasmLoader;
  private wasmLoadPromise: Promise<void> | null = null;
  private isLoaded = false;
  private dbCache: Map<string, PGlite> = new Map();

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
      const vector = await loadVectorExtension();

      // Create a temporary PGlite instance to trigger WASM loading with pgvector
      const tempDbPath = 'memory://';
      const tempDb = new PGlite({ dataDir: tempDbPath, extensions: { vector } });

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
    const vector = await loadVectorExtension();

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
        console.info(`[WasmLoader] Reusing cached PGlite instance for ${cacheKey}`);
        return cached;
      }
    }

    const db = normalizedDataDir
      ? new PGlite({ dataDir: normalizedDataDir, extensions: { vector } })
      : new PGlite({ extensions: { vector } });

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
        console.info(`[WasmLoader] Closed and removed cached instance for ${cacheKey}`);
      } catch (err) {
        console.warn(`[WasmLoader] Failed to close ${cacheKey}:`, err);
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
        console.info(`[WasmLoader] Successfully deleted IndexedDB database: ${dbName}`);
        resolve();
      };

      request.onerror = () => {
        const error = new Error(`Failed to delete IndexedDB database: ${dbName}`);
        console.error('[WasmLoader]', error, request.error);
        reject(error);
      };

      request.onblocked = () => {
        console.warn(
          `[WasmLoader] IndexedDB deletion blocked for: ${dbName}. Close all tabs/connections.`
        );
        // Don't reject - the database will be deleted when connections close
      };
    });
  }
}

export const wasmLoader = WasmLoader.getInstance();
