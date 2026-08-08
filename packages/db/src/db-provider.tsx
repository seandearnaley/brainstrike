import {
  MASTRA_MEMORY_TABLES,
  MASTRA_VECTOR_TABLE,
  MASTRA_WORKFLOW_TABLE,
} from '@brainstrike/assistant-contract/mastra-memory-schema';
import type {
  EmbeddingProviderType,
  ProviderDimensionParameter,
} from '@brainstrike/indexing-contract';
import { createLogger } from '@brainstrike/logging';
import type { DatabaseDiagnosticsSnapshot, ElectronDatabaseAPI } from '@brainstrike/types';
import { isDevEnv } from '@brainstrike/utils';
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
import type { FactoryResetOnlyTable, ResetTable } from './reset-table-registry.js';
import {
  type PGliteRuntimeClient,
  runFirstRunBootstrapInWorker,
  wasmLoader,
} from './wasm-loader.js';

const logger = createLogger('DbProvider');

function logDatabaseError(message: string, error: unknown): void {
  logger.error({ err: error }, message);
}

/**
 * Every relation the clear/reset paths empty. A closed union rather than a
 * `string` parameter ON PURPOSE: because the helper below PROBES with
 * `to_regclass`, a stale or misspelled name is indistinguishable from an absent
 * table and becomes a PERMANENT SILENT SKIP — no error, no warn, only a
 * `logger.debug`, with every test still green.
 *
 * Derived from the reset-table registry (BST-992) rather than hand-enumerated:
 * the registry owns the SET all three table-enumerating reset paths clear;
 * this file owns the renderer paths' order and mechanics.
 * `reset-table-registry.test.ts` asserts each renderer path clears exactly the
 * registry set, so a table added to the registry without a call site here (or
 * vice versa) fails fast.
 */
type ClearableRelation = FactoryResetOnlyTable | ResetTable;

/**
 * Deletes every row of a relation that may legitimately be ABSENT, PROBING for
 * it first rather than deleting and catching "relation does not exist".
 *
 * Both reset paths run their whole body inside ONE transaction, and PGlite is
 * real Postgres: a statement error puts the transaction into the ABORTED state,
 * after which every later command fails with `25P02 current transaction is
 * aborted, commands ignored until end of transaction block` until ROLLBACK.
 * Catching the 42P01 does not undo that and there are no savepoints anywhere in
 * this repo, so catch-and-tolerate could never actually tolerate anything — it
 * rolled the ENTIRE reset back. `to_regclass` returns NULL for an absent
 * relation instead of raising, so the probe can never poison the transaction
 * (BST-558 review).
 *
 * This replaces five overlapping predecessors, including the bare
 * `catch (err) { logger.warn(...) }` blocks in `clearViaPGlite`. Those swallowed
 * EVERY error, not just a missing relation: the first genuine failure aborted
 * the transaction, each following `25P02` was swallowed in turn, and the caller
 * was eventually told the transaction was aborted rather than which statement
 * actually failed. Measured, not reasoned — an FK violation on `roots` produced
 * three consecutive "(table may not exist)" warnings before surfacing as a
 * misleading 25P02.
 *
 * The DELETE after a successful probe is deliberately NOT wrapped: nothing in
 * this repo ever DROPs these relations, so the probe/delete race is unreachable,
 * and a tolerated error there could not recover anyway. A genuine delete failure
 * must surface as itself.
 *
 * Callers pass `MASTRA_WORKFLOW_TABLE` itself, never a hand-copied literal: with
 * `to_regclass` a stale name returns NULL forever, turning the clear into a
 * permanent silent skip rather than a visible error. That constant is read only
 * INSIDE functions — never into a module-scope const — because module-scope
 * initializers run at bundle chunk initialization, where the contract chunk is
 * not guaranteed to have evaluated; the binding would be `undefined` and
 * `to_regclass('undefined')` returns NULL. Enforced repo-wide by
 * `scripts/verify-mastra-schema-init-order.mjs` (BST-558, #1988).
 */
async function clearRelationIfPresent(
  tx: { query: (sql: string) => Promise<unknown> },
  table: ClearableRelation
): Promise<void> {
  const probe = (await tx.query(`SELECT to_regclass('${table}') IS NOT NULL AS present`)) as
    | { rows?: Array<{ present?: boolean }> }
    | undefined;
  if (probe?.rows?.[0]?.present !== true) {
    // `debug`, not `warn`: an absent relation is the expected state for a
    // never-used assistant or a pre-migration database, and warn+ records are
    // persisted into brainstrike_diagnostic_events — one of the tables this
    // clear is emptying.
    logger.debug(`[DbProvider] Skipped absent ${table} table during clear`);
    return;
  }
  await tx.query(`DELETE FROM ${table}`);
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

export function createDbHandle(executor: QueryExecutor): DbHandle {
  const query: DbHandle['query'] = async <T = unknown>(
    sql: string,
    params?: unknown[],
    options?: unknown,
    workOptions?: unknown
  ) => {
    // A 4th argument only ever originates from a priority proxy stacked over a
    // scheduler-backed handle: a native per-query config (drizzle's parser
    // set, the sandbox's rowMode) occupies the 3rd slot, pushing the
    // scheduler work options to the 4th (appendDatabaseWorkOptions THROWS on
    // unscheduled stacks instead of emitting one). Forward it — the scheduled
    // executor variadic-splits trailing work options. This wrapper's fixed
    // 3-arg arity used to drop it, silently downgrading background embedding
    // workers to foreground QoS (PR #2166 review P1).
    if (workOptions !== undefined) {
      const variadicQuery = executor.query as (...args: unknown[]) => Promise<{ rows: unknown[] }>;
      const result = await variadicQuery.call(executor, sql, params, options, workOptions);
      return { rows: result.rows as T[] };
    }
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
    const electronDB = window.electronAPI?.db;
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

      await clearRelationIfPresent(tx, 'selection_snapshot_files');
      await clearRelationIfPresent(tx, 'selection_snapshots');

      // Then clear files
      const filesResult = await tx.query('SELECT COUNT(*) as count FROM file_records');
      const filesRow = filesResult.rows[0] as { count: string | number } | undefined;
      const deletedFiles = filesRow?.count || 0;
      await tx.query('DELETE FROM file_records');

      // These awaits are deliberately SEQUENTIAL, not `Promise.all` (react-doctor
      // async-parallel flags them): they are statements on ONE PGlite connection
      // inside ONE transaction. Interleaving them races statements on a single
      // connection, and once any statement fails the transaction is aborted, so
      // the rest would only pile up `25P02` errors.
      //
      // After file_records (the FK child): stale roots would otherwise survive a
      // clear and resurface as ghost workspaces once consumers read the table.
      await clearRelationIfPresent(tx, 'roots');
      // Also clear embedding sets and queue to avoid stale state.
      await clearRelationIfPresent(tx, 'collection_indexing_stats');
      await clearRelationIfPresent(tx, 'embedding_sets');
      await clearRelationIfPresent(tx, 'job_queue');
      // Revisions cascade from prompt_items. The system embedding profile is
      // configuration seeded by migration 051 and intentionally survives.
      await clearRelationIfPresent(tx, 'prompt_items');
      // Durable per-thread token/cost usage (migration 046): FK-less, so
      // nothing cascades it — cost history must not survive a fresh start.
      await clearRelationIfPresent(tx, 'brainstrike_assistant_run_usage');
      // FK-less terminal provider forensics can contain response metadata and
      // error text. Clear them before the lazy parent run/thread stores.
      await clearRelationIfPresent(tx, 'brainstrike_assistant_run_errors');
      // Task Ledger outcome labels (migration 062): writable on web via the
      // renderer repository (user verdicts), no FK cascades them — clear
      // explicitly per the FACTORY RESET CONTRACT (review #1693).
      await clearRelationIfPresent(tx, 'brainstrike_assistant_run_outcomes');
      // BST-992 drift fix: desktop `db:clearAll` cleared these three FK-less
      // stores but web missed them, so the assistant task list, edit-checkpoint
      // before-content, and assistant-ui branch topology survived a web clear.
      await clearRelationIfPresent(tx, 'brainstrike_assistant_task_lists');
      await clearRelationIfPresent(tx, 'brainstrike_assistant_edit_checkpoints');
      await clearRelationIfPresent(tx, 'brainstrike_assistant_message_parents');
      // Soft-rewind tombstones (migration 080, BST-1115): bookkeeping over
      // conversation content this clear destroys, so it goes with it.
      await clearRelationIfPresent(tx, 'brainstrike_assistant_message_tombstones');
      // Shadow-git snapshot ledger (migration 081, BST-1164): turn↔commit-oid
      // bookkeeping for threads this clear destroys, so it goes with them.
      await clearRelationIfPresent(tx, 'brainstrike_workspace_snapshots');
      // Versioned Canvas documents (migration 082, BST-1173): thread-owned
      // content must not survive the threads/resources this clear destroys.
      await clearRelationIfPresent(tx, 'brainstrike_canvas_versions');
      // Durable per-tool model-facing telemetry (migration 083): FK-less.
      await clearRelationIfPresent(tx, 'brainstrike_tool_call_telemetry');
      // Complete tool output can contain sensitive command results and has no FK
      // to Mastra-owned message tables, so it must be deleted explicitly.
      await clearRelationIfPresent(tx, 'brainstrike_assistant_tool_output_artifacts');
      // Thread grouping is Brainstrike-owned assistant presentation state.
      // Delete placements before groups, and both before Mastra threads.
      await clearRelationIfPresent(tx, 'brainstrike_assistant_thread_placements');
      await clearRelationIfPresent(tx, 'brainstrike_assistant_thread_groups');
      // Mastra memory tables are lazy, database-owned assistant persistence.
      // Delete children before their logical parents even though the current
      // schema does not declare foreign keys. Vectors are deliberately cleared
      // without an index-name filter: every assistant-memory index belongs to
      // the database being reset (BST-844).
      await clearRelationIfPresent(tx, MASTRA_MEMORY_TABLES.messages);
      await clearRelationIfPresent(tx, MASTRA_MEMORY_TABLES.observationalMemory);
      await clearRelationIfPresent(tx, MASTRA_MEMORY_TABLES.threads);
      await clearRelationIfPresent(tx, MASTRA_MEMORY_TABLES.resources);
      await clearRelationIfPresent(tx, MASTRA_VECTOR_TABLE);
      // Suspended Mastra workflow snapshots: unbounded lifetime, no FK, and they
      // retain the pending tool call and its arguments (BST-558).
      await clearRelationIfPresent(tx, MASTRA_WORKFLOW_TABLE);
      // Thread search index (migration 067): derived conversation text + sync
      // state. Diagnostic events (migration 073): the durable warn+ error log,
      // no FK, so nothing cascades it. Neither may survive a "true fresh start"
      // per the FACTORY RESET CONTRACT. The singleton search profile is
      // configuration and intentionally survives, like the prompt profile.
      await clearRelationIfPresent(tx, 'brainstrike_thread_message_index');
      await clearRelationIfPresent(tx, 'brainstrike_thread_search_state');
      await clearRelationIfPresent(tx, 'brainstrike_diagnostic_events');
      // Mind op-log (migration 079): tombstones for data this reset just
      // destroyed must not survive onto the fresh database (BST-993).
      await clearRelationIfPresent(tx, 'brainstrike_mind_ops');

      return { deletedChunks: Number(deletedChunks), deletedFiles: Number(deletedFiles) };
    });
  }, [initializeDatabase]);

  const clearAllData = useCallback(async () => {
    // Initialize database if not already initialized
    if (!lazyInitialized) {
      await initializeDatabase();
    }

    // Check if Electron IPC is actually available (not just configured)
    const electronAPI = typeof window === 'undefined' ? null : (window.electronAPI ?? null);

    const isElectronIPCAvailable = useElectronIPC && electronAPI?.db?.clearAll;

    if (isElectronIPCAvailable) {
      return await clearViaElectronIPC();
    }

    // For direct PGlite, use transaction
    return await clearViaPGlite();
  }, [useElectronIPC, lazyInitialized, initializeDatabase, clearViaElectronIPC, clearViaPGlite]);

  // Helpers to reduce complexity within contextValue actions
  const purgeTablesTx = useCallback(async (tx: { query: (sql: string) => Promise<unknown> }) => {
    // Sequential by necessity — see the identical note in clearViaPGlite: one
    // connection, one transaction, so `Promise.all` would race statements and
    // turn any single failure into a pile of `25P02`s.
    await clearRelationIfPresent(tx, 'prompt_items');
    await clearRelationIfPresent(tx, 'brainstrike_assistant_tool_output_artifacts');
    await clearRelationIfPresent(tx, 'brainstrike_assistant_run_errors');
    await clearRelationIfPresent(tx, 'brainstrike_assistant_thread_placements');
    await clearRelationIfPresent(tx, 'brainstrike_assistant_thread_groups');
    await clearRelationIfPresent(tx, MASTRA_MEMORY_TABLES.messages);
    await clearRelationIfPresent(tx, MASTRA_MEMORY_TABLES.observationalMemory);
    await clearRelationIfPresent(tx, MASTRA_MEMORY_TABLES.threads);
    await clearRelationIfPresent(tx, MASTRA_MEMORY_TABLES.resources);
    await clearRelationIfPresent(tx, MASTRA_VECTOR_TABLE);
    await clearRelationIfPresent(tx, MASTRA_WORKFLOW_TABLE);
    // Task Ledger outcome labels: web-writable (user verdicts), no FK —
    // clear explicitly per the FACTORY RESET CONTRACT (review #1693).
    await clearRelationIfPresent(tx, 'brainstrike_assistant_run_outcomes');
    // BST-992 drift fix: FK-less desktop-parity stores web previously missed —
    // token/cost history, task lists, edit-checkpoint before-content, and
    // branch topology must not survive a web factory reset.
    await clearRelationIfPresent(tx, 'brainstrike_assistant_run_usage');
    await clearRelationIfPresent(tx, 'brainstrike_assistant_task_lists');
    await clearRelationIfPresent(tx, 'brainstrike_assistant_edit_checkpoints');
    await clearRelationIfPresent(tx, 'brainstrike_assistant_message_parents');
    // Soft-rewind tombstones (migration 080, BST-1115).
    await clearRelationIfPresent(tx, 'brainstrike_assistant_message_tombstones');
    // Shadow-git snapshot ledger (migration 081, BST-1164).
    await clearRelationIfPresent(tx, 'brainstrike_workspace_snapshots');
    // Versioned Canvas documents (migration 082, BST-1173).
    await clearRelationIfPresent(tx, 'brainstrike_canvas_versions');
    // Durable per-tool model-facing telemetry (migration 083).
    await clearRelationIfPresent(tx, 'brainstrike_tool_call_telemetry');
    await clearRelationIfPresent(tx, 'brainstrike_thread_message_index');
    await clearRelationIfPresent(tx, 'brainstrike_thread_search_state');
    await clearRelationIfPresent(tx, 'brainstrike_diagnostic_events');
    // Mind op-log (migration 079): cleared with the mind it describes (BST-993).
    await clearRelationIfPresent(tx, 'brainstrike_mind_ops');
    await clearRelationIfPresent(tx, 'job_queue');
    await clearRelationIfPresent(tx, 'collection_indexing_stats');
    await clearRelationIfPresent(tx, 'embedding_sets');
    await clearRelationIfPresent(tx, 'selection_snapshot_files');
    await clearRelationIfPresent(tx, 'selection_snapshots');
    await clearRelationIfPresent(tx, 'file_chunks');
    await clearRelationIfPresent(tx, 'file_records');
    // After file_records (the FK child): stale roots would otherwise survive a
    // reset and resurface as ghost workspaces once consumers read the table.
    await clearRelationIfPresent(tx, 'roots');
    // FACTORY-RESET-ONLY convergence (BST-992): desktop factory reset
    // destroys the profile directory, so these six seed-free caches and
    // bookkeeping tables previously survived only on web. Clear Database
    // intentionally keeps them on both surfaces; view_filter_presets stays
    // out (migration-seeded — the purge preserves schema without re-running
    // migrations, so its seeds would be lost forever).
    await clearRelationIfPresent(tx, 'token_cache');
    await clearRelationIfPresent(tx, 'file_token_cache');
    await clearRelationIfPresent(tx, 'embedding_cache');
    await clearRelationIfPresent(tx, 'job_queue_metrics');
    await clearRelationIfPresent(tx, 'embedding_dimension_index_suspensions');
    await clearRelationIfPresent(tx, 'embedding_dimension_index_maintenance');
    // view_filter_presets mixes migration-SEEDED defaults (is_default TRUE,
    // custom-027) with USER-authored presets (is_default FALSE). Desktop
    // factory reset destroys both and re-seeds; the web purge cannot re-run
    // migrations, so it deletes ONLY the user rows — seeds survive, user
    // presets converge with desktop (review #2162). Targeted delete, not the
    // probe helper: the predicate makes it a partial clear, and the table is
    // migration-guaranteed so a probe adds nothing.
    await tx.query('DELETE FROM view_filter_presets WHERE is_default = FALSE');
  }, []);

  const tryElectronHardReset = useCallback(async (): Promise<boolean> => {
    const w = typeof window === 'undefined' ? null : window;
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
    const w = typeof window === 'undefined' ? null : window;
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
          const w = typeof window === 'undefined' ? null : window;
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
