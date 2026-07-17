import type {
  EmbeddingProviderType,
  ProviderDimensionParameter,
} from '@brainstrike/indexing-contract';
import type { DatabaseDiagnosticsSnapshot, ElectronDatabaseAPI } from '@brainstrike/types';
import { createLogger, isDevEnv } from '@brainstrike/utils';
import type { PGlite } from '@electric-sql/pglite';
import type React from 'react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { TransactionStatement } from './atomic-transaction.js';
import { maybeBootstrapBrowserFirstRunStore } from './browser-first-run-bootstrap.js';
import {
  getDefaultBrowserPGliteDataDir,
  isBrowserPersistentPGliteDataDir,
  isIndexedDbPGliteDataDir,
} from './browser-pglite-storage.js';
import {
  createDatabaseWorkScheduler,
  createScheduledDbHandle,
  type DatabaseWorkOptions,
  type DatabaseWorkPriority,
  type ScheduledDbHandle,
} from './database-work-scheduler.js';
import { type DrizzleDb, drizzle } from './drizzle/database.js';
import { migrate, PGVECTOR_EXTENSION_PRESENCE_QUERY } from './migrations/bootstrap.js';
import type { FileChunk } from './models/file-chunk.js';
import { DrizzleFileChunkRepository } from './repositories/drizzle/file-chunk-repository.js';
import { DrizzleFileRecordRepository } from './repositories/drizzle/file-record-repository.js';
import { ElectronFileChunkRepository } from './repositories/electron-file-chunk-repository.js';
import { ElectronFileRecordRepository } from './repositories/electron-file-record-repository.js';
import type { IDatabase } from './repositories/interfaces.js';
import {
  type PGliteRuntimeClient,
  runFirstRunBootstrapInWorker,
  wasmLoader,
} from './wasm-loader.js';

const logger = createLogger('DbProvider');

function logDatabaseError(message: string, error: unknown): void {
  logger.error({ err: error }, message);
}

function isMissingRelationError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /\b(?:relation|table)\s+(?:"(?:[a-z_][\w$]*\.)?prompt_items"|(?:(?:"[a-z_][\w$]*"|[a-z_][\w$]*)\.)?(?:"prompt_items"|prompt_items))\s+does not exist\b/iu.test(
    message
  );
}

async function clearPromptItemsIfPresent(
  tx: { query: (sql: string) => Promise<unknown> },
  missingRelationMessage: string
): Promise<void> {
  try {
    await tx.query('DELETE FROM prompt_items');
  } catch (error) {
    if (!isMissingRelationError(error)) {
      throw error;
    }
    logger.warn(missingRelationMessage, error);
  }
}

/**
 * Discriminated union for the internal DB connection handle.
 * IPC mode: renderer communicates via Electron IPC bridge (no local close).
 * Direct mode: renderer owns a PGlite instance (must close on teardown).
 */
type DbConnection =
  | { kind: 'ipc'; bridge: ElectronDatabaseAPI }
  | { kind: 'direct'; db: PGliteRuntimeClient; dataDir: string };

async function closeDirectConnection(db: PGliteRuntimeClient, dataDir: string): Promise<void> {
  try {
    if (isBrowserPersistentPGliteDataDir(dataDir)) {
      await wasmLoader.closeCached(dataDir);
    } else {
      await db.close();
    }
  } catch (err: unknown) {
    const errorMessage = (err as Error)?.message || '';
    if (!(errorMessage.includes('closed') || errorMessage.includes('PGlite is closed'))) {
      logger.error('Failed to close database:', err);
    }
  }
}

async function purgeAndCloseDirectDb(
  db: PGliteRuntimeClient,
  dataDir: string,
  purgeTablesTx: (tx: { query: (sql: string) => Promise<unknown> }) => Promise<void>
): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await purgeTablesTx(tx);
    });
  } catch (error) {
    logger.error('[DbProvider] Failed to purge tables during factory reset:', error);
    throw error;
  }
  try {
    await db.exec('VACUUM');
  } catch (err) {
    logger.warn('VACUUM after purge failed:', err);
  }
  if (isBrowserPersistentPGliteDataDir(dataDir)) {
    try {
      await wasmLoader.closeCached(dataDir);
      logger.info('[DbProvider] Closed cached browser PGlite instance during factory reset');
    } catch (err) {
      logger.warn('Failed to close cached browser PGlite instance during reset:', err);
    }
  } else {
    try {
      await db.close();
    } catch (err) {
      logger.warn('Closing database after purge failed:', err);
    }
  }
}

// Module-level dynamic import helpers — extracted from component scope
// so the React Compiler's HIR builder doesn't encounter import() expressions.
async function loadElectronEmbeddingSetsRepository() {
  const mod = await import('./repositories/electron-embedding-sets-repository.js');
  return mod.ElectronEmbeddingSetsRepository;
}

async function loadElectronViewFilterPresetsRepository() {
  const mod = await import('./repositories/electron-view-filter-presets-repository.js');
  return mod.ElectronViewFilterPresetsRepository;
}

async function loadDrizzleEmbeddingSetsRepository() {
  const mod = await import('./repositories/drizzle/embedding-sets-repository.js');
  return mod.DrizzleEmbeddingSetsRepository;
}

async function loadDrizzleViewFilterPresetsRepository() {
  const mod = await import('./repositories/drizzle/view-filter-presets-repository.js');
  return mod.DrizzleViewFilterPresetsRepository;
}

export interface DbInsertChunksAndEnqueueEmbeddingJobsOptions {
  readonly dimensionParameter?: ProviderDimensionParameter | null;
  readonly model?: string | null;
  readonly provider?: EmbeddingProviderType | null;
  readonly signal?: AbortSignal | null;
  readonly targetDimension?: number | null;
  readonly targetEmbeddingSetId?: string | null;
}

export interface DbHandle extends IDatabase {
  exec?: (sql: string, params?: unknown[], options?: unknown) => Promise<unknown>;
  insertChunksAndEnqueueEmbeddingJobs?: (
    chunks: readonly FileChunk[],
    fileRecordId: string,
    options: DbInsertChunksAndEnqueueEmbeddingJobsOptions,
    workOptions?: DatabaseWorkOptions
  ) => Promise<void>;
  readonly raw?: unknown;
  runTransaction?: (
    statements: TransactionStatement[],
    resultIndex: number,
    options?: DatabaseWorkOptions
  ) => Promise<{ rows: unknown[] }>;
  readonly syncToFs?: () => Promise<void>;
}

interface QueryExecutor {
  exec?: (sql: string, params?: unknown[], options?: unknown) => Promise<unknown>;
  insertChunksAndEnqueueEmbeddingJobs?: (
    chunks: readonly FileChunk[],
    fileRecordId: string,
    options: DbInsertChunksAndEnqueueEmbeddingJobsOptions,
    workOptions?: DatabaseWorkOptions
  ) => Promise<void>;
  query: <T = unknown>(
    sql: string,
    params?: unknown[],
    options?: unknown
  ) => Promise<{ rows: T[] }>;
  runTransaction?: (
    statements: TransactionStatement[],
    resultIndex: number,
    options?: DatabaseWorkOptions
  ) => Promise<{ rows: unknown[] }>;
  readonly syncToFs?: () => Promise<void>;
  transaction?: <T>(fn: (tx: QueryExecutor) => Promise<T>) => Promise<T>;
}

// Forward declare for type reference (imported below)
type EmbeddingSetsRepo = import('./repositories/interfaces.js').IEmbeddingSetsRepository;
type ViewFilterPresetsRepo = import('./repositories/interfaces.js').IViewFilterPresetsRepository;

export type DbInitializationStatus = 'idle' | 'initializing' | 'ready' | 'error';

interface DbContextValue {
  chunkRepository: DrizzleFileChunkRepository | ElectronFileChunkRepository | null;
  clearAllData: () => Promise<{ deletedFiles: number; deletedChunks: number }>;
  clearQueuesAndEmbeddingSets: () => Promise<void>; // Helper to purge job_queue and embedding_sets
  db: DbHandle | null;
  drizzleDb: DrizzleDb | null; // Drizzle instance for direct access
  embeddingSetsRepository: EmbeddingSetsRepo | null;
  error: Error | null;
  factoryReset: () => Promise<void>; // Close DB, wipe state, reinitialize
  fileRecordRepository: DrizzleFileRecordRepository | ElectronFileRecordRepository | null;
  initializationStatus: DbInitializationStatus;
  initializeDatabase: () => Promise<void>; // Lazy initialization trigger
  initializing: boolean; // Whether database initialization is in progress
  ready: boolean;
  vectorEnabled: boolean; // Whether pgvector extension is available
  viewFilterPresetsRepository: ViewFilterPresetsRepo | null;
}

interface DbProviderProps {
  children: React.ReactNode;
  dbPath?: string;
  useElectronIPC?: boolean;
}

export function getDefaultDbPath() {
  const isBrowser = typeof window !== 'undefined';
  if (isBrowser) {
    return getDefaultBrowserPGliteDataDir();
  }

  const { tmpdir } = requireNodeOs();
  const { join } = requireNodePath();
  return join(tmpdir(), 'app.db');
}

type NodeProcessWithBuiltins = NodeJS.Process & {
  getBuiltinModule?: (name: string) => unknown;
};

function getNodeBuiltinModule<TModule>(name: string): TModule {
  const runtimeProcess = globalThis.process as NodeProcessWithBuiltins | undefined;
  const module = runtimeProcess?.getBuiltinModule?.(name);
  if (!module) {
    throw new Error(`Node builtin module is unavailable: ${name}`);
  }
  return module as TModule;
}

// Lazily access Node built-ins without creating static import/require edges in browser bundles.
function requireNodeOs(): { tmpdir: () => string } {
  return getNodeBuiltinModule<{ tmpdir: () => string }>('node:os');
}

function requireNodePath(): { join: (...parts: string[]) => string } {
  return getNodeBuiltinModule<{ join: (...parts: string[]) => string }>('node:path');
}

const DbContext = createContext<DbContextValue | undefined>(undefined);

/** Clear active embedding set ID from localStorage to prevent stale collection references */
function clearActiveEmbeddingSetIdFromStorage(): void {
  if (typeof localStorage === 'undefined') {
    return;
  }
  try {
    localStorage.removeItem('brainstrike.activeEmbeddingSetId');
    logger.info('[DbProvider] Cleared active embedding set ID from localStorage');
  } catch (err) {
    logger.warn('[DbProvider] Failed to clear active embedding set ID:', err);
  }
}

function createDbHandle(executor: QueryExecutor): DbHandle {
  const query: DbHandle['query'] = async <T = unknown>(
    sql: string,
    params?: unknown[],
    options?: unknown
  ) => {
    const forwarded = splitExposedDatabaseWorkOptions(params, options);
    const result = await executor.query(sql, forwarded.params, forwarded.options);
    return { rows: result.rows as T[] };
  };
  const syncToFs =
    typeof executor.syncToFs === 'function'
      ? async () => {
          await executor.syncToFs?.();
        }
      : undefined;
  const handle: DbHandle = {
    query,
    ...(syncToFs ? { syncToFs } : {}),
  };

  if (typeof executor.exec === 'function') {
    handle.exec = async (sql: string, params?: unknown[], options?: unknown) => {
      const forwarded = splitExposedDatabaseWorkOptions(params, options);
      return await executor.exec?.(sql, forwarded.params, forwarded.options);
    };
  }

  if (typeof executor.insertChunksAndEnqueueEmbeddingJobs === 'function') {
    handle.insertChunksAndEnqueueEmbeddingJobs = async (
      chunks,
      fileRecordId,
      options,
      workOptions
    ) => {
      const { signal: _signal, ...serializableOptions } = options;
      await executor.insertChunksAndEnqueueEmbeddingJobs?.(
        chunks,
        fileRecordId,
        serializableOptions,
        workOptions
      );
    };
  }

  if (typeof executor.runTransaction === 'function') {
    const runTransaction = executor.runTransaction;
    handle.runTransaction = async (statements, resultIndex, options) =>
      await runTransaction.call(executor, statements, resultIndex, options);
  }

  if (typeof executor.transaction === 'function') {
    const tx = executor.transaction;
    const transactionWrapper: DbHandle['transaction'] = async <T,>(
      fn: (txHandle: DbHandle) => Promise<T>
    ) => tx.call(executor, async (inner) => fn(createDbHandle(inner))) as Promise<T>;
    handle.transaction = transactionWrapper;
  }

  Object.defineProperty(handle, 'raw', {
    configurable: false,
    enumerable: false,
    value: executor,
  });

  return handle;
}

function getRendererDefaultDatabaseWorkPriority(): DatabaseWorkPriority {
  if (typeof window === 'undefined') {
    return 'foreground';
  }
  const search = window.location?.search ?? '';
  const mode = new URLSearchParams(search).get('mode');
  return mode === 'embedding-host' || mode === 'chunking-host' ? 'background' : 'foreground';
}

function isDatabaseWorkOptions(value: unknown): value is DatabaseWorkOptions {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const priority = (value as { readonly priority?: unknown }).priority;
  return priority === 'foreground' || priority === 'normal' || priority === 'background';
}

function splitExposedDatabaseWorkOptions(
  params: unknown[] | undefined,
  options: unknown
): { options: unknown; params: unknown[] | undefined } {
  if (options !== undefined || !isDatabaseWorkOptions(params)) {
    return { options, params };
  }
  return { options: params, params: undefined };
}

function formatDesktopDatabaseInitError(
  diagnostics: DatabaseDiagnosticsSnapshot | null,
  fallbackMessage: string
): string {
  const failure = diagnostics?.lastInitializationFailure;
  const rawFailureMessage =
    failure && typeof failure === 'object' && 'message' in failure
      ? (failure as { message?: unknown }).message
      : null;
  const failureMessage = normalizeFailureMessage(rawFailureMessage);
  const failureDetail = failureMessage ? ` Last failure: ${failureMessage}` : '';

  if (!failure) {
    return `pgvector extension is required for desktop. Ensure @electric-sql/pglite-pgvector is available.${failureDetail}`;
  }

  if (failure.category === 'concurrency') {
    return `Desktop database is already in use by another BrainStrike process. Close other instances and restart.${failureDetail}`;
  }

  if (failure.category === 'corruption') {
    return `Desktop database files appear corrupted and cannot be opened safely.${failureDetail}`;
  }

  if (failure.category === 'wasm-runtime') {
    return `Desktop database runtime aborted while opening the database.${failureDetail}`;
  }

  if (failure.category === 'filesystem') {
    return `Desktop database filesystem access failed.${failureDetail}`;
  }

  if (failure.category === 'migration') {
    return `Desktop database migration failed.${failureDetail}`;
  }

  if (failure.category === 'missing-extension') {
    return `pgvector extension is required for desktop. Ensure @electric-sql/pglite-pgvector is available.${failureDetail}`;
  }

  return `${fallbackMessage}${failureDetail}`;
}

const NORMALIZE_FAILURE_MESSAGE_MAX_DEPTH = 5;

function normalizeFailureMessage(message: unknown, depth = 0): string | null {
  if (depth >= NORMALIZE_FAILURE_MESSAGE_MAX_DEPTH) {
    return null;
  }

  if (typeof message === 'string') {
    const trimmed = message.trim();
    if (!trimmed.length) {
      return null;
    }
    if (trimmed === '[object Object]') {
      return null;
    }
    return trimmed;
  }

  if (message && typeof message === 'object') {
    if ('message' in message) {
      const nestedMessage = (message as { message?: unknown }).message;
      const normalizedNestedMessage = normalizeFailureMessage(nestedMessage, depth + 1);
      if (normalizedNestedMessage) {
        return normalizedNestedMessage;
      }
    }
    try {
      const serialized = JSON.stringify(message);
      if (serialized && serialized !== '{}') {
        return serialized;
      }
    } catch {
      return String(message);
    }
  }

  if (message === null || message === undefined) {
    return null;
  }

  return String(message);
}

async function getElectronDiagnostics(
  electronDB: ElectronDatabaseAPI
): Promise<DatabaseDiagnosticsSnapshot | null> {
  if (!electronDB.diagnostics) {
    return null;
  }
  try {
    return await electronDB.diagnostics();
  } catch (error) {
    logger.warn('Failed to fetch desktop database diagnostics', { error });
    return null;
  }
}

export function DbProvider({ children, dbPath, useElectronIPC }: DbProviderProps) {
  const resolvedPath = dbPath ?? getDefaultDbPath();
  const [fileRecordRepository, setFileRecordRepository] = useState<
    DrizzleFileRecordRepository | ElectronFileRecordRepository | null
  >(null);
  const [chunkRepository, setChunkRepository] = useState<
    DrizzleFileChunkRepository | ElectronFileChunkRepository | null
  >(null);
  const [embeddingSetsRepository, setEmbeddingSetsRepository] = useState<EmbeddingSetsRepo | null>(
    null
  );
  const [viewFilterPresetsRepository, setViewFilterPresetsRepository] =
    useState<ViewFilterPresetsRepo | null>(null);
  const [drizzleDb, setDrizzleDb] = useState<DrizzleDb | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [ready, setReady] = useState(false);
  const [lazyInitialized, setLazyInitialized] = useState(false);
  const [initializationStatus, setInitializationStatus] = useState<DbInitializationStatus>('idle');
  const [initializing, setInitializing] = useState(false);
  const [vectorEnabled, setVectorEnabled] = useState(false);
  const [exposedDb, setExposedDb] = useState<DbHandle | null>(null);

  const connectionRef = useRef<DbConnection | null>(null);
  const initializingRef = useRef<boolean>(false);
  const initializingPromiseRef = useRef<Promise<void> | null>(null);
  const resetPendingReloadRef = useRef<boolean>(false);
  const databaseWorkSchedulerRef = useRef(createDatabaseWorkScheduler());

  const testElectronConnection = useCallback(async (electronDB: ElectronDatabaseAPI) => {
    if (!electronDB.test) {
      return;
    }

    try {
      const testResult = await electronDB.test();
      if (!testResult.success) {
        throw new Error(`Database test failed: ${testResult.message}`);
      }
      logger.debug('Database test passed', { message: testResult.message });
    } catch (error) {
      logger.warn('Database test not available or failed:', error);
    }
  }, []);

  const initializeElectronIPC = useCallback(
    async (cancelled: { value: boolean }) => {
      if (!(useElectronIPC && typeof window !== 'undefined' && window.electronAPI?.db)) {
        return false;
      }

      logger.debug('Using Electron IPC database connection');

      const electronDB = window.electronAPI.db;
      await testElectronConnection(electronDB);
      const electronExec = electronDB.exec;

      if (!electronExec) {
        throw new Error('Electron database exec operation is unavailable over IPC');
      }

      const repositoryDb = {
        exec: async (sql: string) => {
          await electronExec(sql);
        },
        query: electronDB.query,
        // Atomic transaction primitive (#1141): lets repositories run tuning + SELECT
        // in ONE main-process pglite.transaction() so a concurrent FTS query can't
        // interleave. Omitted on older preloads → repos fall back to raw BEGIN/COMMIT.
        ...(electronDB.runTransaction ? { transaction: electronDB.runTransaction } : {}),
      };

      // The repository doesn't need the test method, so we can pass just the db interface
      const repository = new ElectronFileRecordRepository(repositoryDb);
      // Detect pgvector extension availability over IPC
      let hasVector = false;
      let diagnostics: DatabaseDiagnosticsSnapshot | null = null;
      try {
        const res = await electronDB.query(PGVECTOR_EXTENSION_PRESENCE_QUERY);
        hasVector = Array.isArray(res.rows) && res.rows.length > 0;
      } catch (error) {
        diagnostics = await getElectronDiagnostics(electronDB);
        hasVector = false;
        logger.warn('Failed to detect pgvector extension over IPC', { diagnostics, error });
      }
      if (!hasVector) {
        if (!diagnostics) {
          diagnostics = await getElectronDiagnostics(electronDB);
        }
        logger.error('Desktop database initialization missing pgvector extension', { diagnostics });
        throw new Error(
          formatDesktopDatabaseInitError(diagnostics, 'Desktop database failed to initialize.')
        );
      }
      const chunkRepo = new ElectronFileChunkRepository(repositoryDb);

      // Dynamic imports via module-level helpers (avoids import() in component scope);
      // the two repository modules are independent, so load them concurrently.
      const [ElectronEmbeddingSetsRepo, ElectronViewFilterPresetsRepo] = await Promise.all([
        loadElectronEmbeddingSetsRepository(),
        loadElectronViewFilterPresetsRepository(),
      ]);
      const embeddingSetsRepo = new ElectronEmbeddingSetsRepo(repositoryDb);
      const viewFilterPresetsRepo = new ElectronViewFilterPresetsRepo(repositoryDb);

      if (!cancelled.value) {
        connectionRef.current = { bridge: electronDB, kind: 'ipc' };
        setExposedDb(createDbHandle(electronDB as unknown as QueryExecutor));
        setFileRecordRepository(repository);
        setChunkRepository(chunkRepo);
        setEmbeddingSetsRepository(embeddingSetsRepo);
        setViewFilterPresetsRepository(viewFilterPresetsRepo);
        setVectorEnabled(hasVector);
        setError(null);
        setReady(true);
      }
      return true;
    },
    [useElectronIPC, testElectronConnection]
  );

  const initializeDirectPGlite = useCallback(
    async (cancelled: { value: boolean }) => {
      logger.debug('Using direct PGlite connection');

      // First-run fast bootstrap: a not-yet-existing browser idb:// store is
      // created greenfield from an in-memory migrated dump (strict flush)
      // instead of paying strict per-statement durability through initdb +
      // every migration (~53s → a few seconds). Existing stores skip in one
      // cheap probe; failures propagate to the visible init error state.
      if (isIndexedDbPGliteDataDir(resolvedPath) && typeof Worker !== 'undefined') {
        const bootstrapResult = await maybeBootstrapBrowserFirstRunStore(resolvedPath, {
          bootstrapStore: (dataDir) => runFirstRunBootstrapInWorker(dataDir),
          // 'resolve' on BLOCKED (another tab still holds the torn store): the
          // delete settles reporting `blocked: true` and the recovery path
          // throws its loud "close other tabs" error directly — instead of
          // hanging DB init on the factory-reset default of waiting for the
          // holding connection to close.
          deleteStore: (dataDir) =>
            wasmLoader.deleteIndexedDB(dataDir, { blockedBehavior: 'resolve' }),
        });
        logger.info('First-run PGlite bootstrap check', { ...bootstrapResult, resolvedPath });
      }

      const db = await wasmLoader.createPGliteClient(resolvedPath);
      connectionRef.current = { dataDir: resolvedPath, db, kind: 'direct' };

      const scheduledDb = createScheduledDbHandle(
        db as unknown as QueryExecutor & object,
        databaseWorkSchedulerRef.current,
        getRendererDefaultDatabaseWorkPriority()
      ) as unknown as PGlite & ScheduledDbHandle;

      await migrate(scheduledDb);

      // Check if pgvector extension is available
      let hasVector = false;
      try {
        const result = await scheduledDb.query(PGVECTOR_EXTENSION_PRESENCE_QUERY);
        hasVector = result.rows.length > 0;
        logger.debug('pgvector extension detected', { available: hasVector });
      } catch (err) {
        logger.debug('Could not detect pgvector extension:', err);
      }
      if (!hasVector) {
        throw new Error(
          'pgvector extension failed to initialize. Ensure @electric-sql/pglite-pgvector is bundled.'
        );
      }

      // Create Drizzle instance and type-safe repositories
      // Dynamic imports via module-level helpers (avoids import() in component scope);
      // the two repository modules are independent, so load them concurrently.
      const [DrizzleEmbeddingSetsRepo, DrizzleViewFilterPresetsRepo] = await Promise.all([
        loadDrizzleEmbeddingSetsRepository(),
        loadDrizzleViewFilterPresetsRepository(),
      ]);
      const drizzleInstance = drizzle(scheduledDb);
      const repository = new DrizzleFileRecordRepository(drizzleInstance);
      const chunkRepo = new DrizzleFileChunkRepository(drizzleInstance);
      const embeddingSetsRepo = new DrizzleEmbeddingSetsRepo(drizzleInstance);
      const viewFilterPresetsRepo = new DrizzleViewFilterPresetsRepo(drizzleInstance);
      if (!cancelled.value) {
        setDrizzleDb(drizzleInstance);
        setFileRecordRepository(repository);
        setChunkRepository(chunkRepo);
        setEmbeddingSetsRepository(embeddingSetsRepo);
        setViewFilterPresetsRepository(viewFilterPresetsRepo);
        setVectorEnabled(hasVector);
        setError(null);
        setReady(true);
        setExposedDb(createDbHandle(scheduledDb as unknown as QueryExecutor));
      }
    },
    [resolvedPath]
  );

  const initializeDatabase = useCallback(async () => {
    if (resetPendingReloadRef.current) {
      return;
    }

    // Fast exits when already ready
    if (lazyInitialized || (connectionRef.current && !useElectronIPC)) {
      return;
    }

    // If an initialization is in flight, wait for it
    if (initializingPromiseRef.current) {
      await initializingPromiseRef.current;
      return;
    }

    initializingRef.current = true;
    setInitializationStatus('initializing');
    setInitializing(true);
    logger.debug('Lazy-loading database (triggered by actual usage)');

    initializingPromiseRef.current = (async () => {
      try {
        const isElectronInitialized = await initializeElectronIPC({ value: false });
        if (!isElectronInitialized) {
          await initializeDirectPGlite({ value: false });
        }
        setLazyInitialized(true);
        setInitializationStatus('ready');
      } catch (err) {
        logDatabaseError('Failed to initialize database', err);
        setFileRecordRepository(null);
        setChunkRepository(null);
        setEmbeddingSetsRepository(null);
        setViewFilterPresetsRepository(null);
        setError(err as Error);
        setReady(true);
        setLazyInitialized(false);
        setInitializationStatus('error');
      } finally {
        initializingRef.current = false;
        initializingPromiseRef.current = null;
        setInitializing(false);
      }
    })();

    await initializingPromiseRef.current;
  }, [lazyInitialized, useElectronIPC, initializeElectronIPC, initializeDirectPGlite]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: run once on mount/unmount; initialization guarded internally
  useEffect(() => {
    // No automatic initialization in prod/dev - only when explicitly requested.
    // In test environments, eagerly initialize to simplify test timing and ensure
    // constructor calls (e.g., default path detection) are observable.
    setReady(true); // Provider is ready, but database is not yet loaded

    if (process.env['NODE_ENV'] === 'test') {
      // Fire and forget; internal guards prevent duplicate initialization
      initializeDatabase().catch((err) => {
        logDatabaseError('Failed to eager-initialize database in test', err);
      });
    }

    return () => {
      const conn = connectionRef.current;
      if (conn) {
        if (conn.kind === 'direct' && !isDevEnv()) {
          const { db, dataDir } = conn;
          setTimeout(() => {
            void closeDirectConnection(db, dataDir);
          }, 0);
        }
        connectionRef.current = null;
      }
      initializingRef.current = false;
    };
  }, []);

  const clearViaElectronIPC = useCallback(async () => {
    // biome-ignore lint/suspicious/noExplicitAny: Electron API type varies by environment
    const electronDB = (window as any).electronAPI?.db;
    if (!electronDB?.clearAll) {
      throw new Error('Electron IPC clearAll method not available');
    }

    const result = await electronDB.clearAll('CONFIRM_CLEAR_DATABASE');
    if (result.success) {
      return {
        deletedChunks: result.deletedChunks || 0,
        deletedFiles: result.deletedFiles || 0,
      };
    }
    throw new Error(result.message || 'Failed to clear database via Electron IPC');
  }, []);

  const clearViaPGlite = useCallback(async () => {
    if (!connectionRef.current) {
      await initializeDatabase();
    }
    const conn = connectionRef.current;
    if (conn?.kind !== 'direct') {
      throw new Error(
        'Direct PGlite database not available (IPC connections use clearViaElectronIPC)'
      );
    }

    return await conn.db.transaction(async (tx) => {
      // Clear chunks first due to foreign key constraints
      const chunksResult = await tx.query('SELECT COUNT(*) as count FROM file_chunks');
      const chunksRow = chunksResult.rows[0] as { count: string | number } | undefined;
      const deletedChunks = chunksRow?.count || 0;
      await tx.query('DELETE FROM file_chunks');

      try {
        await tx.query('DELETE FROM selection_snapshot_files');
        await tx.query('DELETE FROM selection_snapshots');
      } catch (error) {
        logger.warn('[DbProvider] Failed to clear selection snapshots:', error);
      }

      // Then clear files
      const filesResult = await tx.query('SELECT COUNT(*) as count FROM file_records');
      const filesRow = filesResult.rows[0] as { count: string | number } | undefined;
      const deletedFiles = filesRow?.count || 0;
      await tx.query('DELETE FROM file_records');

      // After file_records (the FK child): stale roots would otherwise
      // survive a clear and resurface as ghost workspaces once consumers
      // read the roots table.
      try {
        await tx.query('DELETE FROM roots');
      } catch (error) {
        logger.warn('[DbProvider] Failed to clear roots (table may not exist):', error);
      }

      // Also clear embedding sets and queue to avoid stale state
      try {
        await tx.query('DELETE FROM collection_indexing_stats');
      } catch (error) {
        logger.warn('[DbProvider] Failed to clear collection_indexing_stats:', error);
      }
      try {
        await tx.query('DELETE FROM embedding_sets');
      } catch (error) {
        // Tables may not exist in older schema versions - log but don't fail
        logger.warn('[DbProvider] Failed to clear embedding_sets (table may not exist):', error);
      }
      try {
        await tx.query('DELETE FROM job_queue');
      } catch (error) {
        // Tables may not exist in older schema versions - log but don't fail
        logger.warn('[DbProvider] Failed to clear job_queue (table may not exist):', error);
      }
      // Revisions cascade from prompt_items. The system embedding profile is
      // configuration seeded by migration 051 and intentionally survives.
      await clearPromptItemsIfPresent(
        tx,
        '[DbProvider] Skipped missing prompt_items table during clear:'
      );
      // Task Ledger outcome labels (migration 062): writable on web via the
      // renderer repository (user verdicts), no FK cascades them — clear
      // explicitly per the FACTORY RESET CONTRACT (review #1693).
      try {
        await tx.query('DELETE FROM brainstrike_assistant_run_outcomes');
      } catch (error) {
        logger.warn(
          '[DbProvider] Failed to clear brainstrike_assistant_run_outcomes (table may not exist):',
          error
        );
      }

      return { deletedChunks: Number(deletedChunks), deletedFiles: Number(deletedFiles) };
    });
  }, [initializeDatabase]);

  const clearAllData = useCallback(async () => {
    // Initialize database if not already initialized
    if (!lazyInitialized) {
      await initializeDatabase();
    }

    // Check if Electron IPC is actually available (not just configured)
    const electronAPI =
      typeof window === 'undefined'
        ? null
        : ((
            window as Window & {
              electronAPI?: {
                db?: { clearAll?: (confirmationToken?: string) => Promise<unknown> };
              };
            }
          ).electronAPI ?? null);

    const isElectronIPCAvailable = useElectronIPC && electronAPI?.db?.clearAll;

    if (isElectronIPCAvailable) {
      return await clearViaElectronIPC();
    }

    // For direct PGlite, use transaction
    return await clearViaPGlite();
  }, [useElectronIPC, lazyInitialized, initializeDatabase, clearViaElectronIPC, clearViaPGlite]);

  // Helpers to reduce complexity within contextValue actions
  const purgeTablesTx = useCallback(async (tx: { query: (sql: string) => Promise<unknown> }) => {
    await clearPromptItemsIfPresent(tx, 'Skipped missing prompt_items table during reset:');
    try {
      // Task Ledger outcome labels: web-writable (user verdicts), no FK —
      // clear explicitly per the FACTORY RESET CONTRACT (review #1693).
      await tx.query('DELETE FROM brainstrike_assistant_run_outcomes');
    } catch (err) {
      logger.warn('Failed to clear brainstrike_assistant_run_outcomes during reset:', err);
    }
    try {
      await tx.query('DELETE FROM job_queue');
    } catch (err) {
      logger.warn('Failed to clear job_queue during reset:', err);
    }
    try {
      await tx.query('DELETE FROM collection_indexing_stats');
    } catch (err) {
      logger.warn('Failed to clear collection_indexing_stats during reset:', err);
    }
    try {
      await tx.query('DELETE FROM embedding_sets');
    } catch (err) {
      logger.warn('Failed to clear embedding_sets during reset:', err);
    }
    try {
      await tx.query('DELETE FROM selection_snapshot_files');
      await tx.query('DELETE FROM selection_snapshots');
    } catch (err) {
      logger.warn('Failed to clear selection snapshots during reset:', err);
    }
    try {
      await tx.query('DELETE FROM file_chunks');
    } catch (err) {
      logger.warn('Failed to clear file_chunks during reset:', err);
    }
    try {
      await tx.query('DELETE FROM file_records');
    } catch (err) {
      logger.warn('Failed to clear file_records during reset:', err);
    }
    try {
      // After file_records (the FK child): stale roots would otherwise
      // survive a reset and resurface as ghost workspaces once consumers
      // read the roots table.
      await tx.query('DELETE FROM roots');
    } catch (err) {
      logger.warn('Failed to clear roots during reset:', err);
    }
  }, []);

  const tryElectronHardReset = useCallback(async (): Promise<boolean> => {
    // biome-ignore lint/suspicious/noExplicitAny: Electron API type varies by environment
    const w = (typeof window === 'undefined' ? null : (window as any)) as any;
    if (!(useElectronIPC && w?.electronAPI?.db)) {
      return false;
    }
    if (typeof w.electronAPI.db.resetLocal !== 'function') {
      throw new Error('Electron database reset bridge is unavailable.');
    }

    const res = await w.electronAPI.db.resetLocal();
    if (!res?.success) {
      throw new Error(res?.message ?? 'Electron database reset failed.');
    }
    // Don't reload here - let the caller handle clearing UI state and reloading.
    // This ensures clearPersistentUiState() runs before the page reloads.
    return true;
  }, [useElectronIPC]);

  const purgeAndClosePGlite = useCallback(async () => {
    const conn = connectionRef.current;
    if (!conn) {
      return;
    }
    if (conn.kind === 'direct') {
      await purgeAndCloseDirectDb(conn.db, conn.dataDir, purgeTablesTx);
    }
    connectionRef.current = null;
    setExposedDb(null);
  }, [purgeTablesTx]);

  const cleanupAndWaitForReset = useCallback(async () => {
    // Delete the IndexedDB database to fully wipe corrupted TOAST chunks
    if (resolvedPath.startsWith('idb://')) {
      try {
        await wasmLoader.deleteIndexedDB(resolvedPath);
        logger.info('[DbProvider] IndexedDB deleted successfully');
        // Wait for IndexedDB deletion to fully complete
        await new Promise((resolve) => {
          setTimeout(resolve, 250);
        });
      } catch (err) {
        logger.warn('[DbProvider] Failed to delete IndexedDB, reinitializing anyway:', err);
      }
    } else {
      // Even for non-IDB paths, wait a bit to ensure cleanup completes
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });
    }
  }, [resolvedPath]);

  const resetPGliteState = useCallback(async () => {
    resetPendingReloadRef.current = true;

    try {
      if (connectionRef.current) {
        await purgeAndClosePGlite();
      } else {
        logger.warn('[DbProvider] No active database to purge during factory reset');
      }
    } catch (error) {
      resetPendingReloadRef.current = false;
      throw error;
    }

    connectionRef.current = null;
    setExposedDb(null);
    setDrizzleDb(null);
    setFileRecordRepository(null);
    setChunkRepository(null);
    setEmbeddingSetsRepository(null);
    setViewFilterPresetsRepository(null);
    setVectorEnabled(false);
    setReady(false);
    setLazyInitialized(false);
    setInitializationStatus('idle');
    setInitializing(false);

    // Clear active embedding set ID from localStorage to prevent stale collections
    clearActiveEmbeddingSetIdFromStorage();

    await cleanupAndWaitForReset();
  }, [purgeAndClosePGlite, cleanupAndWaitForReset]);

  const purgeQueuesAndSetsElectron = useCallback(async () => {
    // biome-ignore lint/suspicious/noExplicitAny: Electron API type varies by environment
    const w = (typeof window === 'undefined' ? null : (window as any)) as any;
    if (w?.electronAPI?.db?.query) {
      try {
        await w.electronAPI.db.query('DELETE FROM job_queue');
      } catch (err) {
        logger.warn('Electron query to clear job_queue failed:', err);
      }
      try {
        await w.electronAPI.db.query('DELETE FROM collection_indexing_stats');
      } catch (err) {
        logger.warn('Electron query to clear collection_indexing_stats failed:', err);
      }
      try {
        await w.electronAPI.db.query('DELETE FROM embedding_sets');
      } catch (err) {
        logger.warn('Electron query to clear embedding_sets failed:', err);
      }
    }
  }, []);

  const purgeQueuesAndSetsTx = useCallback(
    async (tx: { query: (sql: string) => Promise<unknown> }) => {
      try {
        await tx.query('DELETE FROM job_queue');
      } catch (err) {
        logger.warn('Failed to clear job_queue (transaction):', err);
      }
      try {
        await tx.query('DELETE FROM collection_indexing_stats');
      } catch (err) {
        logger.warn('Failed to clear collection_indexing_stats (transaction):', err);
      }
      try {
        await tx.query('DELETE FROM embedding_sets');
      } catch (err) {
        logger.warn('Failed to clear embedding_sets (transaction):', err);
      }
    },
    []
  );

  const contextValue = useMemo(
    () => ({
      chunkRepository,
      clearAllData,
      clearQueuesAndEmbeddingSets: async () => {
        if (useElectronIPC) {
          // biome-ignore lint/suspicious/noExplicitAny: Electron API type varies by environment
          const w = (typeof window === 'undefined' ? null : (window as any)) as any;
          if (w?.electronAPI?.db?.query) {
            await purgeQueuesAndSetsElectron();
            return;
          }
        }
        const conn = connectionRef.current;
        if (conn?.kind !== 'direct') {
          return;
        }
        await conn.db.transaction(async (tx) => {
          await purgeQueuesAndSetsTx(tx);
        });
      },
      db: exposedDb,
      drizzleDb,
      embeddingSetsRepository,
      error,
      factoryReset: async () => {
        const handled = await tryElectronHardReset();
        if (handled) {
          logger.info('[DbProvider] Electron hard reset completed');
          return;
        }

        await resetPGliteState();
      },
      fileRecordRepository,
      initializationStatus,
      initializeDatabase,
      initializing,
      ready,
      vectorEnabled,
      viewFilterPresetsRepository,
    }),
    [
      fileRecordRepository,
      chunkRepository,
      embeddingSetsRepository,
      viewFilterPresetsRepository,
      drizzleDb,
      error,
      ready,
      initializationStatus,
      initializing,
      clearAllData,
      initializeDatabase,
      vectorEnabled,
      useElectronIPC,
      tryElectronHardReset,
      resetPGliteState,
      purgeQueuesAndSetsElectron,
      purgeQueuesAndSetsTx,
      exposedDb,
    ]
  );

  return <DbContext.Provider value={contextValue}>{children}</DbContext.Provider>;
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
export function useEmbeddingSetsRepository(): EmbeddingSetsRepo | null {
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
export function useViewFilterPresetsRepository(): ViewFilterPresetsRepo | null {
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
