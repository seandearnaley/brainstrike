import { createLogger, isDevEnv, setupHMR } from '@brainstrike/utils';
import type { Extension } from '@electric-sql/pglite';
import { PGlite } from '@electric-sql/pglite';
import type { LiveNamespace } from '@electric-sql/pglite/live';
import type { PGliteWorker, PGliteWorkerOptions } from '@electric-sql/pglite/worker';
import type { FirstRunBootstrapResultMessage } from './browser-first-run-bootstrap-worker.js';
import {
  IDB_DB_NAME_PREFIX,
  isBrowserPersistentPGliteDataDir,
  isIndexedDbPGliteDataDir,
  isOpfsAhpPGliteDataDir,
  reclaimLegacyBrowserPGliteStorage,
} from './browser-pglite-storage.js';

type VectorExtension = Extension;
type LiveExtension = Extension;
type TrgmExtension = Extension;
const WORKER_STARTUP_DISPOSED_MESSAGE =
  'PGlite worker client startup was disposed before completion';

export interface PGliteLeaderChangeSource {
  readonly offLeaderChange: (listener: () => void) => void;
  readonly onLeaderChange: (listener: () => void) => (() => void) | undefined;
}

export type PGliteRuntimeClient = Pick<
  PGlite,
  'close' | 'exec' | 'query' | 'syncToFs' | 'transaction'
> & {
  readonly live?: Pick<LiveNamespace, 'query'>;
};

type BrowserPGliteWorkerClient = PGliteWorker & PGliteRuntimeClient & PGliteLeaderChangeSource;

const logger = createLogger('WasmLoader');

interface PendingBrowserWorkerStartup {
  readonly closeResolved: (db: BrowserPGliteWorkerClient) => Promise<boolean>;
  readonly dispose: () => void;
  readonly promise: Promise<BrowserPGliteWorkerClient>;
}

let cachedVectorPromise: Promise<VectorExtension> | null = null;
let cachedLivePromise: Promise<LiveExtension> | null = null;
let cachedTrgmPromise: Promise<TrgmExtension> | null = null;

async function loadVectorExtension(): Promise<VectorExtension> {
  if (!cachedVectorPromise) {
    cachedVectorPromise = (async () => {
      try {
        // Dynamic import for pgvector extension (ES module compatible)
        /* Stryker disable next-line StringLiteral */
        const { vector } = await import('@electric-sql/pglite-pgvector');
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

async function loadTrgmExtension(): Promise<TrgmExtension> {
  if (!cachedTrgmPromise) {
    cachedTrgmPromise = (async () => {
      try {
        const { pg_trgm: pgTrgm } = await import('@electric-sql/pglite/contrib/pg_trgm');
        return pgTrgm;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`pg_trgm extension is required and failed to load: ${message}`);
      }
    })();
  }

  return cachedTrgmPromise;
}

function isWorkerStartupDisposedError(error: unknown): boolean {
  return error instanceof Error && error.message === WORKER_STARTUP_DISPOSED_MESSAGE;
}

class WasmLoader {
  private static instance: WasmLoader;
  private wasmLoadPromise: Promise<void> | null = null;
  private isLoaded = false;
  private readonly dbCache: Map<string, PGlite> = new Map();
  private readonly workerCache: Map<string, BrowserPGliteWorkerClient> = new Map();
  private readonly workerClientStartups: Map<string, PendingBrowserWorkerStartup> = new Map();

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
      await Promise.all([loadVectorExtension(), loadLiveExtension(), loadTrgmExtension()]);
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
    const [vector, live, pgTrgm] = await Promise.all([
      loadVectorExtension(),
      loadLiveExtension(),
      loadTrgmExtension(),
    ]);

    // Normalize in-memory indicator: map legacy ':memory:' to 'memory://'
    const normalizedDataDir = dataDir === ':memory:' ? 'memory://' : dataDir;
    if (typeof window !== 'undefined' && isOpfsAhpPGliteDataDir(normalizedDataDir)) {
      throw new Error('Browser OPFS AHP PGlite requires the PGlite worker host');
    }

    // Use cache key for persistent databases to prevent double-open in dev mode
    // (React Strict Mode + HMR can cause multiple mounts without proper cleanup)
    const cacheKey = normalizedDataDir || 'default';

    // For persisted databases (idb://), reuse existing instance if available
    // This prevents TOAST corruption from concurrent IndexedDB access
    if (isIndexedDbPGliteDataDir(normalizedDataDir)) {
      const cached = this.dbCache.get(cacheKey);
      if (cached) {
        logger.info('Reusing cached PGlite instance', { cacheKey });
        return cached;
      }
    }

    const db = normalizedDataDir
      ? new PGlite({
          dataDir: normalizedDataDir,
          extensions: { live, pg_trgm: pgTrgm, vector },
        })
      : new PGlite({ extensions: { live, pg_trgm: pgTrgm, vector } });

    // Cache persisted databases only (not memory://)
    if (isIndexedDbPGliteDataDir(normalizedDataDir)) {
      this.dbCache.set(cacheKey, db);
      // Mirror the worker-host path's legacy reclamation for the direct idb path.
      // (In the real browser app idb routes through the worker host, so this is
      // effectively unreachable today — wired for symmetry/future-proofing.)
      void reclaimLegacyBrowserPGliteStorage(normalizedDataDir).catch(() => undefined);
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

    const pending = this.workerClientStartups.get(cacheKey);
    if (pending) {
      logger.info('Reusing pending PGlite worker client', { cacheKey });
      return await this.awaitActiveWorkerClient(cacheKey, pending);
    }

    const workerClientStartup = this.createBrowserWorkerStartup(normalizedDataDir);
    this.workerClientStartups.set(cacheKey, workerClientStartup);

    try {
      const db = await this.awaitActiveWorkerClient(cacheKey, workerClientStartup);
      if (this.workerClientStartups.get(cacheKey) === workerClientStartup) {
        this.workerClientStartups.delete(cacheKey);
        this.workerCache.set(cacheKey, db);
        // Best-effort reclamation of the pre-engine-version legacy storage
        // (e.g. idb://app) now that the versioned DB (idb://app-pg18) has opened,
        // so the orphaned old database doesn't sit against the origin's quota.
        // Fires once per new (non-cached) worker-host cold start; it re-enumerates
        // storage each cold start but is a cheap idempotent no-op once the legacy
        // store is gone. Kept un-gated (rather than a persisted once-marker) so a
        // transiently-stuck entry is retried on a later launch.
        if (normalizedDataDir) {
          void reclaimLegacyBrowserPGliteStorage(normalizedDataDir).catch(() => undefined);
        }
      }
      return db;
    } catch (error) {
      if (this.workerClientStartups.get(cacheKey) === workerClientStartup) {
        this.workerClientStartups.delete(cacheKey);
      }
      throw error;
    }
  }

  private async awaitActiveWorkerClient(
    cacheKey: string,
    workerClientStartup: PendingBrowserWorkerStartup
  ): Promise<BrowserPGliteWorkerClient> {
    const db = await workerClientStartup.promise;
    if (this.workerClientStartups.get(cacheKey) === workerClientStartup) {
      return db;
    }
    if (this.workerCache.get(cacheKey) === db) {
      return db;
    }
    throw new Error(WORKER_STARTUP_DISPOSED_MESSAGE);
  }

  private createBrowserWorkerStartup(dataDir: string): PendingBrowserWorkerStartup {
    let disposed = false;
    let resolvedClientClosed = false;
    let worker: Worker | null = null;
    let rejectDisposed: (reason: Error) => void = () => undefined;
    const disposedPromise = new Promise<never>((_, reject) => {
      rejectDisposed = reject;
    });
    // The rejection is also consumed by Promise.race below; attach this eagerly
    // so dispose-before-race cannot surface as an unhandled rejection.
    void disposedPromise.catch(() => undefined);

    const promise = (async () => {
      await this.ensureWasmLoaded();
      const live = await loadLiveExtension();
      const { PGliteWorker } = await import('@electric-sql/pglite/worker');
      if (disposed) {
        throw new Error(WORKER_STARTUP_DISPOSED_MESSAGE);
      }
      worker = new Worker(new URL('./pglite-worker-entry.ts', import.meta.url), {
        type: 'module',
      });
      try {
        const options: PGliteWorkerOptions<{ live: LiveExtension }> = {
          dataDir,
          extensions: { live },
          id: `brainstrike-db:${dataDir}`,
          // Brainstrike treats browser PGlite as the source of truth, not a cache.
          // PGlite's relaxed durability mode makes syncToFs fire-and-forget, so a
          // confirmed local write can still be lost on immediate reload or close.
          relaxedDurability: false,
        };
        const workerClientPromise = PGliteWorker.create(worker, options);
        void workerClientPromise
          .then(async (db) => {
            if (!disposed) {
              return;
            }
            try {
              await closeResolved(db);
            } catch (err) {
              logger.warn('Failed to close late PGlite worker startup', { dataDir, error: err });
            }
          })
          .catch(() => undefined);
        return await Promise.race([workerClientPromise, disposedPromise]);
      } catch (error) {
        if (!disposed) {
          worker.terminate();
        }
        throw error;
      }
    })();

    return {
      closeResolved,
      dispose: () => {
        if (disposed) {
          return;
        }
        disposed = true;
        worker?.terminate();
        rejectDisposed(new Error(WORKER_STARTUP_DISPOSED_MESSAGE));
      },
      promise,
    };

    async function closeResolved(db: BrowserPGliteWorkerClient): Promise<boolean> {
      if (resolvedClientClosed) {
        return false;
      }
      resolvedClientClosed = true;
      await db.close();
      return true;
    }
  }

  private shouldUseBrowserWorkerHost(dataDir: string | undefined): dataDir is string {
    return typeof Worker !== 'undefined' && this.requiresBrowserWorkerHost(dataDir);
  }

  private requiresBrowserWorkerHost(dataDir: string | undefined): dataDir is string {
    return typeof window !== 'undefined' && isBrowserPersistentPGliteDataDir(dataDir);
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

    const pendingWorkerStartup = this.workerClientStartups.get(cacheKey);
    const workerDb = this.workerCache.get(cacheKey);
    if (workerDb) {
      this.workerCache.delete(cacheKey);
      this.workerClientStartups.delete(cacheKey);
      try {
        await workerDb.close();
        logger.info('Closed and removed cached PGlite worker client', { cacheKey });
      } catch (err) {
        logger.warn('Failed to close cached PGlite worker client', { cacheKey, error: err });
      }
    } else if (pendingWorkerStartup) {
      this.workerClientStartups.delete(cacheKey);
      pendingWorkerStartup.dispose();
      try {
        const pendingDb = await pendingWorkerStartup.promise;
        this.workerCache.delete(cacheKey);
        const closed = await pendingWorkerStartup.closeResolved(pendingDb);
        if (closed) {
          logger.info('Closed pending PGlite worker client', { cacheKey });
        }
      } catch (err) {
        if (isWorkerStartupDisposedError(err)) {
          logger.info('Disposed pending PGlite worker client startup', { cacheKey });
        } else {
          logger.warn('Failed to close pending PGlite worker client', { cacheKey, error: err });
        }
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
    const pendingWorkerEntries = Array.from(this.workerClientStartups.entries());
    this.dbCache.clear();
    this.workerCache.clear();
    this.workerClientStartups.clear();
    this.wasmLoadPromise = null;
    this.isLoaded = false;

    const closeResolvedDb = async (cacheKey: string, db: PGliteRuntimeClient): Promise<void> => {
      try {
        await db.close();
        logger.info('HMR dispose: closed cached PGlite instance', { cacheKey });
      } catch (err) {
        logger.warn('HMR dispose: failed to close PGlite instance', { cacheKey, error: err });
      }
    };

    const closePendingWorkerDb = async (
      cacheKey: string,
      startup: PendingBrowserWorkerStartup
    ): Promise<void> => {
      startup.dispose();
      try {
        const resolvedDb = await startup.promise;
        const closed = await startup.closeResolved(resolvedDb);
        if (closed) {
          logger.info('HMR dispose: closed cached PGlite instance', { cacheKey });
        }
      } catch (err) {
        if (isWorkerStartupDisposedError(err)) {
          logger.info('HMR dispose: disposed pending PGlite worker startup', { cacheKey });
        } else {
          logger.warn('HMR dispose: failed to close PGlite instance', { cacheKey, error: err });
        }
      }
    };

    await Promise.all([
      ...entries.map(async ([cacheKey, db]) => await closeResolvedDb(cacheKey, db)),
      ...workerEntries.map(async ([cacheKey, db]) => await closeResolvedDb(cacheKey, db)),
      ...pendingWorkerEntries.map(
        async ([cacheKey, db]) => await closePendingWorkerDb(cacheKey, db)
      ),
    ]);
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

    const bareName = dataDir.slice(idbPrefix.length);
    if (!bareName) {
      throw new Error('Invalid IndexedDB path: database name is empty');
    }

    // PGlite's idb backend is Emscripten IDBFS, which names the actual IndexedDB
    // database `/pglite/<dataDir>` — NOT the bare name (verified against pglite
    // 0.5.1; see IDB_DB_NAME_PREFIX). Deleting only the bare name silently no-ops
    // against a real PGlite store, so target the prefixed name; also delete the
    // bare name as a harmless no-op safety net for any non-pglite/legacy store.
    const dbNames = [`${IDB_DB_NAME_PREFIX}${bareName}`, bareName];
    await Promise.all(dbNames.map((dbName) => this.deleteOneIndexedDb(dbName)));
  }

  /**
   * Delete a single IndexedDB database by its exact name. Resolves on success or
   * when blocked (the delete completes once other connections close); rejects only
   * on a genuine deletion error. Deleting an absent database fires `onsuccess`.
   */
  private deleteOneIndexedDb(dbName: string): Promise<void> {
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

/**
 * Wall-clock ceiling for one first-run bootstrap worker run. Generous — a cold
 * worker fetches + compiles the PGlite WASM twice and runs the full migration
 * suite — but finite, so a wedged worker fails LOUDLY into the DB init error
 * state instead of hanging startup forever.
 */
export const FIRST_RUN_BOOTSTRAP_WORKER_TIMEOUT_MS = 300_000;

function isFirstRunBootstrapResultMessage(data: unknown): data is FirstRunBootstrapResultMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { type?: unknown }).type === 'result' &&
    typeof (data as { ok?: unknown }).ok === 'boolean'
  );
}

/**
 * Runs the first-run fast bootstrap pipeline (see
 * browser-first-run-bootstrap-pipeline.ts) for `dataDir` inside a DEDICATED
 * plain worker — no PGliteWorker, no leader election, no RPC layer — keeping
 * the initdb + migration WASM work off the main thread. Resolves once the
 * worker reports the strict flush completed; rejects (and terminates the
 * worker) on failure or timeout.
 */
export function runFirstRunBootstrapInWorker(
  dataDir: string,
  timeoutMs = FIRST_RUN_BOOTSTRAP_WORKER_TIMEOUT_MS
): Promise<void> {
  const workerInstance = new Worker(
    new URL('./browser-first-run-bootstrap-worker-entry.ts', import.meta.url),
    { type: 'module' }
  );
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (outcome: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      workerInstance.terminate();
      outcome();
    };
    const timer = setTimeout(() => {
      settle(() =>
        reject(
          new Error(
            `First-run PGlite bootstrap worker timed out after ${timeoutMs}ms for ${dataDir}`
          )
        )
      );
    }, timeoutMs);
    workerInstance.addEventListener('message', (event: MessageEvent) => {
      const data: unknown = event.data;
      if (!isFirstRunBootstrapResultMessage(data)) {
        settle(() =>
          reject(new Error('First-run PGlite bootstrap worker sent a malformed result message'))
        );
        return;
      }
      if (data.ok) {
        settle(resolve);
        return;
      }
      settle(() => reject(new Error(`First-run PGlite bootstrap worker failed: ${data.error}`)));
    });
    workerInstance.addEventListener('error', (event: ErrorEvent) => {
      settle(() =>
        reject(
          new Error(
            `First-run PGlite bootstrap worker crashed: ${event.message || 'unknown error'}`
          )
        )
      );
    });
    workerInstance.postMessage({ dataDir, type: 'run' });
  });
}

// Reset module-level extension caches during HMR so stale promise references
// from the previous module instance don't leak into the replacement.
function resetExtensionCaches(): void {
  cachedVectorPromise = null;
  cachedLivePromise = null;
  cachedTrgmPromise = null;
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
