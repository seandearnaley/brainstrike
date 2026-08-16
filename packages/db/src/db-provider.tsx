import {
  MASTRA_MEMORY_TABLES,
  MASTRA_VECTOR_TABLE,
  MASTRA_WORKFLOW_TABLE,
} from '@brainstrike/assistant-contract/mastra-memory-schema';
import { createLogger } from '@brainstrike/logging';
import type { DatabaseDiagnosticsSnapshot, ElectronDatabaseAPI } from '@brainstrike/types';
import { isDevEnv } from '@brainstrike/utils';
import type { PGlite } from '@electric-sql/pglite';
import type React from 'react';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { maybeBootstrapBrowserFirstRunStore } from './browser-first-run-bootstrap.js';
import {
  isBrowserPersistentPGliteDataDir,
  isIndexedDbPGliteDataDir,
} from './browser-pglite-storage.js';
import {
  createDatabaseWorkScheduler,
  createScheduledDbHandle,
  type DatabaseWorkPriority,
  type ScheduledDbHandle,
} from './database-work-scheduler.js';
import { DbContext, type DbContextValue, type DbInitializationStatus } from './db-context.js';
import { createDbHandle, type DbHandle, type QueryExecutor } from './db-handle.js';
import {
  createLiveQueryDrainRegistry,
  createResetBarrierDatabaseWork,
  waitForDatabaseWorkSchedulerIdle,
} from './db-reset-drain.js';
import { getDefaultDbPath } from './default-db-path.js';
import { type DrizzleDb, drizzle } from './drizzle/database.js';
import { migrate, PGVECTOR_EXTENSION_PRESENCE_QUERY } from './migrations/bootstrap.js';
import { DrizzleFileChunkRepository } from './repositories/drizzle/file-chunk-repository.js';
import { DrizzleFileRecordRepository } from './repositories/drizzle/file-record-repository.js';
import { ElectronFileChunkRepository } from './repositories/electron-file-chunk-repository.js';
import { ElectronFileRecordRepository } from './repositories/electron-file-record-repository.js';
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

// Forward declare for type reference (imported below)
type EmbeddingSetsRepo = import('./repositories/interfaces.js').IEmbeddingSetsRepository;
type ViewFilterPresetsRepo = import('./repositories/interfaces.js').IViewFilterPresetsRepository;

interface DbProviderProps {
  children: React.ReactNode;
  dbPath?: string;
  useElectronIPC?: boolean;
}

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

function getRendererDefaultDatabaseWorkPriority(): DatabaseWorkPriority {
  if (typeof window === 'undefined') {
    return 'foreground';
  }
  const search = window.location?.search ?? '';
  const mode = new URLSearchParams(search).get('mode');
  return mode === 'embedding-host' || mode === 'chunking-host' ? 'background' : 'foreground';
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

interface DbProviderState {
  chunkRepository: DrizzleFileChunkRepository | ElectronFileChunkRepository | null;
  drizzleDb: DrizzleDb | null;
  embeddingSetsRepository: EmbeddingSetsRepo | null;
  error: Error | null;
  exposedDb: DbHandle | null;
  fileRecordRepository: DrizzleFileRecordRepository | ElectronFileRecordRepository | null;
  initializationStatus: DbInitializationStatus;
  initializing: boolean;
  lazyInitialized: boolean;
  ready: boolean;
  vectorEnabled: boolean;
  viewFilterPresetsRepository: ViewFilterPresetsRepo | null;
}

/** Everything a successful IPC or direct-PGlite connection publishes at once. */
type DbConnectionSnapshot = Pick<
  DbProviderState,
  | 'chunkRepository'
  | 'drizzleDb'
  | 'embeddingSetsRepository'
  | 'exposedDb'
  | 'fileRecordRepository'
  | 'vectorEnabled'
  | 'viewFilterPresetsRepository'
>;

type DbProviderAction =
  | { type: 'provider-mounted' }
  | { type: 'initialize-started' }
  | { type: 'connection-ready'; connection: DbConnectionSnapshot }
  | { type: 'initialize-succeeded' }
  | { type: 'initialize-failed'; error: Error }
  | { type: 'initialize-settled' }
  | { type: 'connection-closed' }
  | { type: 'reset' };

const INITIAL_DB_PROVIDER_STATE: DbProviderState = {
  chunkRepository: null,
  drizzleDb: null,
  embeddingSetsRepository: null,
  error: null,
  exposedDb: null,
  fileRecordRepository: null,
  initializationStatus: 'idle',
  initializing: false,
  lazyInitialized: false,
  ready: false,
  vectorEnabled: false,
  viewFilterPresetsRepository: null,
};

function dbProviderReducer(state: DbProviderState, action: DbProviderAction): DbProviderState {
  switch (action.type) {
    case 'provider-mounted':
      return { ...state, ready: true };
    case 'initialize-started':
      return { ...state, initializationStatus: 'initializing', initializing: true };
    case 'connection-ready':
      return { ...state, ...action.connection, error: null, ready: true };
    case 'initialize-succeeded':
      return { ...state, initializationStatus: 'ready', lazyInitialized: true };
    case 'initialize-failed':
      // Connection-derived fields (drizzleDb, exposedDb, vectorEnabled) are
      // deliberately left as-is: a failure before connection-ready never set
      // them, and initializeDatabase's guards prevent re-entry afterwards.
      return {
        ...state,
        chunkRepository: null,
        embeddingSetsRepository: null,
        error: action.error,
        fileRecordRepository: null,
        initializationStatus: 'error',
        lazyInitialized: false,
        ready: true,
        viewFilterPresetsRepository: null,
      };
    case 'initialize-settled':
      return { ...state, initializing: false };
    case 'connection-closed':
      return { ...state, exposedDb: null };
    case 'reset':
      // `error` survives a reset: the caller (factoryReset) reloads the page,
      // and clearing it here would blank error UI during the teardown window.
      return { ...INITIAL_DB_PROVIDER_STATE, error: state.error };
    default: {
      const exhaustive: never = action;
      throw new Error(`Unhandled DbProvider action: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export function DbProvider({ children, dbPath, useElectronIPC }: DbProviderProps) {
  const resolvedPath = dbPath ?? getDefaultDbPath();
  const [state, dispatch] = useReducer(dbProviderReducer, INITIAL_DB_PROVIDER_STATE);
  const {
    chunkRepository,
    drizzleDb,
    embeddingSetsRepository,
    error,
    exposedDb,
    fileRecordRepository,
    initializationStatus,
    initializing,
    lazyInitialized,
    ready,
    vectorEnabled,
    viewFilterPresetsRepository,
  } = state;

  const connectionRef = useRef<DbConnection | null>(null);
  const initializingRef = useRef<boolean>(false);
  /** Set by the unmount cleanup; see `initializeDirectPGlite` (BST-1329). */
  const unmountedRef = useRef<boolean>(false);
  const initializingPromiseRef = useRef<Promise<void> | null>(null);
  const resetPendingReloadRef = useRef<boolean>(false);
  // BST-1329: the scheduler is wrapped in a reset barrier so factory reset can
  // hold NEW submissions out while it drains in-flight work before close();
  // the registry lets reset/unmount await unsubscribing every live handle.
  // Lazy useState initializers, not useRef(create()): a ref initializer
  // expression would rebuild-and-discard these on every render (react-doctor
  // rerender-lazy-ref-init); useState runs the factory exactly once.
  const [databaseWork] = useState(() =>
    createResetBarrierDatabaseWork(createDatabaseWorkScheduler())
  );
  const [liveQueryDrainRegistry] = useState(() => createLiveQueryDrainRegistry());

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
        dispatch({
          connection: {
            chunkRepository: chunkRepo,
            drizzleDb: null,
            embeddingSetsRepository: embeddingSetsRepo,
            exposedDb: createDbHandle(electronDB as unknown as QueryExecutor),
            fileRecordRepository: repository,
            vectorEnabled: hasVector,
            viewFilterPresetsRepository: viewFilterPresetsRepo,
          },
          type: 'connection-ready',
        });
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
      if (unmountedRef.current) {
        // BST-1329: the provider unmounted while this client was being built,
        // so the cleanup saw `connectionRef.current === null` and closed
        // nothing. Nothing has issued a statement against this instance yet —
        // no drain is owed — but it must not be installed or leaked (an
        // abandoned `idb://` client holds its IndexedDB lock and the next open
        // fails with the "close other tabs" recovery error).
        logger.debug('[DbProvider] Closing PGlite client created after unmount');
        await closeDirectConnection(db, resolvedPath);
        return;
      }
      connectionRef.current = { dataDir: resolvedPath, db, kind: 'direct' };

      const scheduledDb = createScheduledDbHandle(
        db as unknown as QueryExecutor & object,
        databaseWork.scheduler,
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
        dispatch({
          connection: {
            chunkRepository: chunkRepo,
            drizzleDb: drizzleInstance,
            embeddingSetsRepository: embeddingSetsRepo,
            exposedDb: createDbHandle(scheduledDb as unknown as QueryExecutor),
            fileRecordRepository: repository,
            vectorEnabled: hasVector,
            viewFilterPresetsRepository: viewFilterPresetsRepo,
          },
          type: 'connection-ready',
        });
      }
    },
    [resolvedPath, databaseWork.scheduler]
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
    dispatch({ type: 'initialize-started' });
    logger.debug('Lazy-loading database (triggered by actual usage)');

    initializingPromiseRef.current = (async () => {
      try {
        const isElectronInitialized = await initializeElectronIPC({ value: false });
        if (!isElectronInitialized) {
          await initializeDirectPGlite({ value: false });
        }
        dispatch({ type: 'initialize-succeeded' });
      } catch (err) {
        logDatabaseError('Failed to initialize database', err);
        dispatch({ error: err as Error, type: 'initialize-failed' });
      } finally {
        initializingRef.current = false;
        initializingPromiseRef.current = null;
        dispatch({ type: 'initialize-settled' });
      }
    })();

    await initializingPromiseRef.current;
  }, [lazyInitialized, useElectronIPC, initializeElectronIPC, initializeDirectPGlite]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: run once on mount/unmount; initialization guarded internally
  useEffect(() => {
    // No automatic initialization in prod/dev - only when explicitly requested.
    // In test environments, eagerly initialize to simplify test timing and ensure
    // constructor calls (e.g., default path detection) are observable.
    dispatch({ type: 'provider-mounted' }); // Provider is ready, but database is not yet loaded

    if (process.env['NODE_ENV'] === 'test') {
      // Fire and forget; internal guards prevent duplicate initialization
      initializeDatabase().catch((err) => {
        logDatabaseError('Failed to eager-initialize database in test', err);
      });
    }

    return () => {
      // BST-1329: an unmount during `createPGliteClient` (first-run bootstrap +
      // initdb + extension load — the slowest stretch of init) sees no
      // connection at all, because `connectionRef` is populated only after that
      // await resolves. Without this flag the instance that resolves a moment
      // later is never closed and never referenced again, leaking the
      // IndexedDB lock on `idb://` stores and failing the next tab's open.
      // `initializeDirectPGlite` checks it and closes what it just built.
      unmountedRef.current = true;
      const conn = connectionRef.current;
      if (conn) {
        if (conn.kind === 'direct' && !isDevEnv()) {
          const { db, dataDir } = conn;
          // `connectionRef` is also populated BEFORE `migrate()` runs, so an
          // unmount can observe a connection whose init statements are still
          // in flight — closing under them is the BST-1320 synchronous wedge.
          // Same drain order as the reset path (idle → seal → unsubscribe, see
          // `drainDatabaseWorkForClose`): the seal is what joins a live handle
          // whose registration lands after the idle join. If the drain fails,
          // skip the close loudly — a leaked instance beats a wedged renderer.
          const initInFlight = initializingPromiseRef.current;
          const { scheduler } = databaseWork;
          setTimeout(() => {
            void (async () => {
              // The initialization promise never rejects (failures are
              // dispatched into provider state), so a bare await is safe.
              if (initInFlight) {
                await initInFlight;
              }
              try {
                await waitForDatabaseWorkSchedulerIdle(scheduler);
              } catch (error) {
                logger.error(
                  '[DbProvider] Skipping unmount close: database work never drained',
                  error
                );
                return;
              }
              liveQueryDrainRegistry.seal();
              await liveQueryDrainRegistry.unsubscribeAll();
              await closeDirectConnection(db, dataDir);
            })();
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
      // Per-run experiment treatment records (migration 093, BST-1250):
      // FK-less experiment evidence must not survive a fresh start.
      await clearRelationIfPresent(tx, 'brainstrike_assistant_run_treatments');
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
      // Estimator/provider prompt-token calibration pairs (migration 086): FK-less.
      await clearRelationIfPresent(tx, 'brainstrike_token_estimate_calibration');
      // Superseded native-tool projection overlays (migration 084): FK-less.
      await clearRelationIfPresent(tx, 'brainstrike_assistant_tool_projection_rewrites');
      // Durable conversation-compaction ranges (migration 088): FK-less.
      await clearRelationIfPresent(tx, 'brainstrike_assistant_compaction_ranges');
      // Complete tool output can contain sensitive command results and has no FK
      // to Mastra-owned message tables, so it must be deleted explicitly.
      await clearRelationIfPresent(tx, 'brainstrike_assistant_tool_output_artifacts');
      // Thread grouping is Brainstrike-owned assistant presentation state.
      // Delete placements before groups, and both before Mastra threads.
      await clearRelationIfPresent(tx, 'brainstrike_assistant_thread_placements');
      await clearRelationIfPresent(tx, 'brainstrike_assistant_thread_workspaces');
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
    await clearRelationIfPresent(tx, 'brainstrike_assistant_thread_workspaces');
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
    // Per-run experiment treatment records (migration 093, BST-1250).
    await clearRelationIfPresent(tx, 'brainstrike_assistant_run_treatments');
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
    // Estimator/provider prompt-token calibration pairs (migration 086).
    await clearRelationIfPresent(tx, 'brainstrike_token_estimate_calibration');
    // Superseded native-tool projection overlays (migration 084).
    await clearRelationIfPresent(tx, 'brainstrike_assistant_tool_projection_rewrites');
    // Durable conversation-compaction ranges (migration 088).
    await clearRelationIfPresent(tx, 'brainstrike_assistant_compaction_ranges');
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
    dispatch({ type: 'connection-closed' });
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

  /**
   * BST-1329: the canonical pre-close drain — **idle join, then seal, then
   * unsubscribe**, deliberately the REVERSE of the desktop's unsubscribe-first
   * double-cleanup (`resetDesktopDatabaseProfile`). Two reasons the web order
   * differs, both load-bearing:
   *
   * 1. **An aborted close must not kill live queries.** The idle join is the
   *    only step that can fail (timeout). Unsubscribing first would mean a
   *    failed reset leaves every handle permanently dead — `unsubscribe`
   *    latches the handle inactive and `usePGliteLiveQuery` never re-subscribes
   *    (no dep changed, no error state) — so the app would render stale rows
   *    forever with nothing logged. Joining idle first means that failure path
   *    leaves everything alive and subscribed.
   * 2. **The barrier already blocks new subscribes**, unlike the desktop side:
   *    `live.query`/`live.incrementalQuery` ARE scheduler work, so nothing can
   *    attach while the scheduler drains — which is what makes a single
   *    unsubscribe pass sufficient here.
   *
   * The seal closes the remaining tail: work that settled just before idle can
   * register its handle from a promise continuation landing after the drain's
   * snapshot. Past the seal the close is COMMITTED — unsubscribe failures warn
   * and proceed (`unsubscribeAll` never rejects). Runs on the renderer's OWN
   * scheduler and registry; reset callers must already hold the barrier.
   */
  const drainDatabaseWorkForClose = useCallback(async () => {
    await waitForDatabaseWorkSchedulerIdle(databaseWork.scheduler);
    liveQueryDrainRegistry.seal();
    await liveQueryDrainRegistry.unsubscribeAll();
  }, [databaseWork, liveQueryDrainRegistry]);

  const resetPGliteState = useCallback(async () => {
    resetPendingReloadRef.current = true;

    try {
      // Barrier up first: new scheduler submissions wait behind the reset, so
      // the drain can actually reach idle. The purge below runs on the RAW
      // connection (never the scheduled handle), so it cannot deadlock on its
      // own barrier. A drain failure (idle timeout) aborts the reset loudly —
      // closing anyway would trade a failed reset for a wedged renderer.
      await databaseWork.runWithResetBarrier(async () => {
        await drainDatabaseWorkForClose();
        if (connectionRef.current) {
          await purgeAndClosePGlite();
        } else {
          logger.warn('[DbProvider] No active database to purge during factory reset');
        }
      });
    } catch (error) {
      resetPendingReloadRef.current = false;
      // The database is still open and (when the idle join was what failed)
      // every live handle is still alive — reopen registration so the app keeps
      // working instead of silently losing live updates until a reload.
      liveQueryDrainRegistry.unseal();
      throw error;
    }

    connectionRef.current = null;
    dispatch({ type: 'reset' });

    // Clear active embedding set ID from localStorage to prevent stale collections
    clearActiveEmbeddingSetIdFromStorage();

    await cleanupAndWaitForReset();
  }, [
    databaseWork,
    drainDatabaseWorkForClose,
    liveQueryDrainRegistry,
    purgeAndClosePGlite,
    cleanupAndWaitForReset,
  ]);

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

  const contextValue = useMemo<DbContextValue>(
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
      liveQueryDrainRegistry,
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
      liveQueryDrainRegistry,
    ]
  );

  return <DbContext.Provider value={contextValue}>{children}</DbContext.Provider>;
}

// The consumer hooks live in ./use-db.ts: mixing hook and component exports
// here would break the Vite Fast Refresh boundary (identity-based check).
