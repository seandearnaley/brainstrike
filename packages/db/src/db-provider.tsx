import type {
  EmbeddingProviderType,
  ProviderDimensionParameter,
} from '@brainstrike/indexing-contract';
import type {
  DatabaseDiagnosticsSnapshot,
  DatabaseProfileBootstrapReportSnapshot,
  DatabaseTestResult,
  ElectronDatabaseAPI,
} from '@brainstrike/types';
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
import type {
  BrainstrikeDbExecutionClient,
  BrainstrikeDbTransactionClient,
} from './architecture/brainstrike-db-client-contract.js';
import type { BrainstrikeDbRuntimeEngine } from './architecture/db-runtime-selection.js';
import {
  createProfileBootstrapReport,
  failProfileBootstrapReport,
  type ProfileBootstrapCheck,
  type ProfileBootstrapPhase,
  type ProfileBootstrapReport,
  type ProfileBootstrapRuntime,
} from './bootstrap/profile-bootstrap-report.js';
import {
  getDefaultBrowserPGliteDataDir,
  isBrowserPersistentPGliteDataDir,
} from './browser-pglite-storage.js';
import {
  createDatabaseWorkScheduler,
  createScheduledDbHandle,
  type DatabaseWorkOptions,
  type DatabaseWorkPriority,
  type ScheduledDbHandle,
} from './database-work-scheduler.js';
import { clearDbProviderRepositoryStateForError } from './db-provider-state-reset.js';
import { type DrizzleDb, drizzle, markPGliteDrizzleCompatible } from './drizzle/database.js';
import type { ApplyManagedCacheBatchArgs } from './managed-cache/index.js';
import { migrate, PGVECTOR_EXTENSION_PRESENCE_QUERY } from './migrations/bootstrap.js';
import type { FileChunk, FileChunkInsert, FileChunkUpdate } from './models/file-chunk.js';
import { DrizzleFileChunkRepository } from './repositories/drizzle/file-chunk-repository.js';
import { DrizzleFileRecordRepository } from './repositories/drizzle/file-record-repository.js';
import { ElectronFileChunkRepository } from './repositories/electron-file-chunk-repository.js';
import { ElectronFileRecordRepository } from './repositories/electron-file-record-repository.js';
import type { IDatabase } from './repositories/interfaces.js';
import type { TursoFileChunkRepository } from './repositories/turso-file-chunk-repository.js';
import { type PGliteRuntimeClient, wasmLoader } from './wasm-loader.js';

const logger = createLogger('DbProvider');

function logDatabaseError(message: string, error: unknown): void {
  logger.error({ err: error }, message);
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

async function clearAssistantRunUsage(
  tx: { query: (sql: string) => Promise<unknown> },
  context: string
): Promise<void> {
  const relation = await tx.query(`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = 'brainstrike_assistant_run_usage'
    ) AS exists
  `);
  const relationRow = (relation as { rows?: Array<{ exists?: boolean | string | number }> })
    .rows?.[0];
  const exists =
    relationRow?.exists === true || relationRow?.exists === 'true' || relationRow?.exists === 1;
  if (!exists) {
    return;
  }

  try {
    await tx.query('DELETE FROM brainstrike_assistant_run_usage');
  } catch (error) {
    logger.warn(`[DbProvider] Failed to clear assistant run usage ${context}:`, error);
    throw error;
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

async function loadTursoViewFilterPresetsRepository() {
  const mod = await import('./repositories/turso-view-filter-presets-repository.js');
  return mod.TursoViewFilterPresetsRepository;
}

async function loadTursoEmbeddingSetsRepository() {
  const mod = await import('./repositories/turso-embedding-sets-repository.js');
  return mod.TursoEmbeddingSetsRepository;
}

async function loadTursoFileRecordRepository() {
  const mod = await import('./repositories/turso-file-record-repository.js');
  return mod.TursoFileRecordRepository;
}

async function loadTursoFileChunkRepository() {
  const mod = await import('./repositories/turso-file-chunk-repository.js');
  return mod.TursoFileChunkRepository;
}

async function loadTursoTokenCacheStore() {
  const mod = await import('./repositories/turso-token-cache-store.js');
  return mod.TursoTokenCacheStore;
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
  applyManagedCacheBatch?: (
    payload: ApplyManagedCacheBatchArgs,
    options?: DatabaseWorkOptions
  ) => Promise<void>;
  exec?: (sql: string, params?: unknown[], options?: unknown) => Promise<unknown>;
  insertChunksAndEnqueueEmbeddingJobs?: (
    chunks: readonly FileChunk[],
    fileRecordId: string,
    options: DbInsertChunksAndEnqueueEmbeddingJobsOptions,
    workOptions?: DatabaseWorkOptions
  ) => Promise<void>;
  readonly raw?: unknown;
  readonly syncToFs?: () => Promise<void>;
}

export interface BrainstrikeRuntimeDbClient {
  readonly db: DbHandle;
  readonly runtimeEngine: BrainstrikeDbRuntimeEngine;
}

export interface AssistantMemoryDbClient extends BrainstrikeRuntimeDbClient {}

export interface ManualImportDbClient extends BrainstrikeRuntimeDbClient {}

export interface QuerySelectionSnapshotDbClient extends BrainstrikeRuntimeDbClient {}

export interface WorkspaceRootsDbClient extends BrainstrikeRuntimeDbClient {}

interface QueryExecutor {
  applyManagedCacheBatch?: (
    payload: ApplyManagedCacheBatchArgs,
    options?: DatabaseWorkOptions
  ) => Promise<void>;
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
  readonly syncToFs?: () => Promise<void>;
  transaction?: <T>(fn: (tx: QueryExecutor) => Promise<T>) => Promise<T>;
}

// Forward declare for type reference (imported below)
type EmbeddingSetsRepo = import('./repositories/interfaces.js').IEmbeddingSetsRepository;
type FileRecordRepo = import('./repositories/interfaces.js').IFileRecordRepository;
type ViewFilterPresetsRepo = import('./repositories/interfaces.js').IViewFilterPresetsRepository;
type TokenCacheStoreRepo = import('./repositories/turso-token-cache-store.js').TursoTokenCacheStore;
type TursoFileChunkRepoConstructor = new (
  db: BrainstrikeDbExecutionClient
) => TursoFileChunkRepository;

export type DbInitializationStatus = 'idle' | 'initializing' | 'ready' | 'error';

interface DbContextValue {
  chunkRepository:
    | DrizzleFileChunkRepository
    | ElectronFileChunkRepository
    | TursoFileChunkRepository
    | null;
  clearAllData: () => Promise<{ deletedFiles: number; deletedChunks: number }>;
  clearQueuesAndEmbeddingSets: () => Promise<void>; // Helper to purge job_queue and embedding_sets
  db: DbHandle | null;
  drizzleDb: DrizzleDb | null; // Drizzle instance for direct access
  embeddingSetsRepository: EmbeddingSetsRepo | null;
  error: Error | null;
  factoryReset: () => Promise<void>; // Close DB, wipe state, reinitialize
  fileRecordRepository: FileRecordRepo | null;
  initializationStatus: DbInitializationStatus;
  initializeDatabase: () => Promise<void>; // Lazy initialization trigger
  initializing: boolean; // Whether database initialization is in progress
  profileBootstrapReport: ProfileBootstrapReport;
  ready: boolean;
  tokenCacheStore: TokenCacheStoreRepo | null;
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

const ELECTRON_IPC_BRIDGE_UNAVAILABLE_MESSAGE =
  'Electron database IPC bridge is unavailable while useElectronIPC is enabled.';

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

  if (typeof executor.applyManagedCacheBatch === 'function') {
    handle.applyManagedCacheBatch = async (payload, options) => {
      await executor.applyManagedCacheBatch?.(payload, options);
    };
  }

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

  if (typeof executor.transaction === 'function') {
    const tx = executor.transaction;
    const transactionWrapper: DbHandle['transaction'] = async <T,>(
      fn: (txHandle: DbHandle) => Promise<T>
    ) => tx.call(executor, async (inner) => fn(createDbHandle(inner))) as Promise<T>;
    handle.transaction = transactionWrapper;
  }

  Object.defineProperty(handle, 'raw', {
    value: executor,
    enumerable: false,
    configurable: false,
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
  const label = (value as { readonly label?: unknown }).label;
  return (
    (priority === undefined ||
      priority === 'foreground' ||
      priority === 'normal' ||
      priority === 'background') &&
    (label === undefined || typeof label === 'string') &&
    (priority !== undefined || label !== undefined)
  );
}

function splitExposedDatabaseWorkOptions(
  params: unknown[] | undefined,
  options: unknown
): { options: unknown; params: unknown[] | undefined } {
  if (options !== undefined || !isDatabaseWorkOptions(params)) {
    return { params, options };
  }
  return { params: undefined, options: params };
}

function inferDbProviderBootstrapRuntime(
  dataDir: string,
  useElectronIPC: boolean | undefined
): ProfileBootstrapRuntime {
  return {
    engine: 'pglite',
    host: useElectronIPC ? 'desktop-ipc' : typeof window === 'undefined' ? 'node' : 'browser',
    persistence: inferDbProviderBootstrapPersistence(dataDir, useElectronIPC),
  };
}

function inferDbProviderBootstrapPersistence(
  dataDir: string,
  useElectronIPC: boolean | undefined
): ProfileBootstrapRuntime['persistence'] {
  if (useElectronIPC) {
    return 'filesystem';
  }
  if (dataDir.startsWith('memory://')) {
    return 'memory';
  }
  if (dataDir.startsWith('idb://')) {
    return 'idb';
  }
  return 'filesystem';
}

function createDbProviderBootstrapChecks(input: {
  readonly schemaMigrated: ProfileBootstrapCheck['status'];
  readonly storeOpen: ProfileBootstrapCheck['status'];
  readonly vectorExtension: ProfileBootstrapCheck['status'];
}): readonly ProfileBootstrapCheck[] {
  return [
    {
      id: 'store.open',
      label: 'database store opened',
      required: true,
      status: input.storeOpen,
    },
    {
      id: 'schema.migrated',
      label: 'database schema migrated',
      required: true,
      status: input.schemaMigrated,
    },
    {
      id: 'extension.pgvector',
      label: 'pgvector extension available',
      required: true,
      status: input.vectorExtension,
    },
  ];
}

function createDbProviderBootstrapReport(input: {
  readonly checks: readonly ProfileBootstrapCheck[];
  readonly phase: ProfileBootstrapPhase;
  readonly profileId: string;
  readonly runtime: ProfileBootstrapRuntime;
  readonly startedAt: string;
  readonly updatedAt: string;
}): ProfileBootstrapReport {
  return createProfileBootstrapReport({
    checks: input.checks,
    phase: input.phase,
    profileId: input.profileId,
    runtime: input.runtime,
    startedAt: input.startedAt,
    updatedAt: input.updatedAt,
  });
}

function createInitialDbProviderBootstrapReport(input: {
  readonly profileId: string;
  readonly runtime: ProfileBootstrapRuntime;
  readonly timestamp: string;
}): ProfileBootstrapReport {
  return createDbProviderBootstrapReport({
    checks: createDbProviderBootstrapChecks({
      schemaMigrated: 'pending',
      storeOpen: 'pending',
      vectorExtension: 'pending',
    }),
    phase: 'uninitialized',
    profileId: input.profileId,
    runtime: input.runtime,
    startedAt: input.timestamp,
    updatedAt: input.timestamp,
  });
}

function getElectronDatabaseBridge(): ElectronDatabaseAPI | null {
  if (typeof window === 'undefined') {
    return null;
  }
  return window.electronAPI?.db ?? null;
}

function getRequiredElectronDatabaseBridge(
  publishDbProviderBootstrapReport: (input: {
    readonly checks: readonly ProfileBootstrapCheck[];
    readonly phase: ProfileBootstrapPhase;
  }) => void
): ElectronDatabaseAPI {
  const electronDB = getElectronDatabaseBridge();
  if (!electronDB) {
    publishDbProviderBootstrapReport(createMissingElectronBridgeBootstrapReportInput());
    throw new Error(ELECTRON_IPC_BRIDGE_UNAVAILABLE_MESSAGE);
  }
  return electronDB;
}

function createMissingElectronBridgeBootstrapReportInput(): {
  readonly checks: readonly ProfileBootstrapCheck[];
  readonly phase: ProfileBootstrapPhase;
} {
  return {
    checks: createDbProviderBootstrapChecks({
      schemaMigrated: 'pending',
      storeOpen: 'failed',
      vectorExtension: 'pending',
    }),
    phase: 'opening-store',
  };
}

function coerceFailureBootstrapPhase(
  phase: ProfileBootstrapPhase
): Exclude<ProfileBootstrapPhase, 'failed'> {
  return phase === 'failed' ? 'opening-store' : phase;
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

function getReadyElectronTursoBootstrapReport(
  report: DatabaseProfileBootstrapReportSnapshot | null | undefined
): ProfileBootstrapReport | null {
  if (!report) {
    return null;
  }
  if (report.runtime.engine !== 'turso') {
    return null;
  }
  if (!report.ready) {
    throw new Error('Desktop Turso database bootstrap report is not ready.');
  }
  return report as ProfileBootstrapReport;
}

async function createElectronTursoViewFilterPresetsRepository(
  bootstrapReport: DatabaseProfileBootstrapReportSnapshot | null | undefined,
  repositoryDb: {
    readonly exec: (
      sql: string,
      params?: readonly unknown[],
      options?: DatabaseWorkOptions
    ) => Promise<void>;
    readonly query: <T = unknown>(
      sql: string,
      params?: readonly unknown[],
      options?: DatabaseWorkOptions
    ) => Promise<{ rows: T[] }>;
  }
): Promise<{
  readonly report: ProfileBootstrapReport;
  readonly repository: ViewFilterPresetsRepo;
} | null> {
  const report = getReadyElectronTursoBootstrapReport(bootstrapReport);
  if (!report) {
    return null;
  }
  const TursoViewFilterPresetsRepo = await loadTursoViewFilterPresetsRepository();
  return {
    report,
    repository: new TursoViewFilterPresetsRepo(repositoryDb),
  };
}

interface ElectronTursoRuntimeRepositories {
  readonly embeddingSetsRepository: EmbeddingSetsRepo;
  readonly executionClient: ElectronTursoExecutionClient;
  readonly fileChunkRepository: TursoFileChunkRepository | null;
  readonly fileRecordRepository: FileRecordRepo;
  readonly report: ProfileBootstrapReport;
  readonly tokenCacheStore: TokenCacheStoreRepo;
  readonly viewFilterPresetsRepository: ViewFilterPresetsRepo;
}

type ElectronTursoExecutionClient = BrainstrikeDbExecutionClient &
  Pick<QueryExecutor, 'applyManagedCacheBatch' | 'insertChunksAndEnqueueEmbeddingJobs'>;

interface ElectronTursoRepositoryDb {
  readonly applyManagedCacheBatch?: QueryExecutor['applyManagedCacheBatch'];
  readonly exec: (
    sql: string,
    params?: readonly unknown[],
    options?: DatabaseWorkOptions
  ) => Promise<void>;
  readonly insertChunksAndEnqueueEmbeddingJobs?: QueryExecutor['insertChunksAndEnqueueEmbeddingJobs'];
  readonly query: <T = unknown>(
    sql: string,
    params?: readonly unknown[],
    options?: DatabaseWorkOptions
  ) => Promise<{ rows: T[] }>;
  readonly runTransaction?: (
    statements: { params?: unknown[]; sql: string }[],
    resultIndex: number,
    options?: DatabaseWorkOptions
  ) => Promise<{ rows: unknown[] }>;
  readonly transaction?: (
    statements: { params?: unknown[]; sql: string }[],
    resultIndex: number
  ) => Promise<{ rows: unknown[] }>;
}

function createElectronTursoRepositoryDb(
  electronDB: ElectronDatabaseAPI,
  electronExec: NonNullable<ElectronDatabaseAPI['exec']>,
  electronRunTransaction: ElectronDatabaseAPI['runTransaction']
): ElectronTursoRepositoryDb {
  return {
    ...(typeof electronDB.applyManagedCacheBatch === 'function'
      ? { applyManagedCacheBatch: electronDB.applyManagedCacheBatch.bind(electronDB) }
      : {}),
    exec: async (sql, params, options) => {
      await electronExec(sql, params ? [...params] : undefined, options);
    },
    ...(typeof electronDB.insertChunksAndEnqueueEmbeddingJobs === 'function'
      ? {
          insertChunksAndEnqueueEmbeddingJobs:
            electronDB.insertChunksAndEnqueueEmbeddingJobs.bind(electronDB),
        }
      : {}),
    query: async (sql, params, options) =>
      await electronDB.query(sql, params ? [...params] : undefined, options),
    ...(electronRunTransaction
      ? {
          runTransaction: electronRunTransaction,
          transaction: (statements: { params?: unknown[]; sql: string }[], resultIndex: number) =>
            electronRunTransaction(statements, resultIndex),
        }
      : {}),
  };
}

function createElectronTursoExecutionClient(
  repositoryDb: ElectronTursoRepositoryDb
): ElectronTursoExecutionClient {
  if (!repositoryDb.runTransaction) {
    throw new Error('Desktop Turso token cache store requires db:transaction IPC support.');
  }
  const runTransaction = repositoryDb.runTransaction;
  const applyManagedCacheBatch = repositoryDb.applyManagedCacheBatch;
  const insertChunksAndEnqueueEmbeddingJobs = repositoryDb.insertChunksAndEnqueueEmbeddingJobs;

  const transactionClient: BrainstrikeDbTransactionClient = {
    exec: repositoryDb.exec,
    query: repositoryDb.query,
  };
  return {
    ...transactionClient,
    ...(applyManagedCacheBatch ? { applyManagedCacheBatch } : {}),
    ...(insertChunksAndEnqueueEmbeddingJobs ? { insertChunksAndEnqueueEmbeddingJobs } : {}),
    transaction: async (callback) => {
      const statements: { params?: unknown[]; sql: string }[] = [];
      const batchClient: BrainstrikeDbTransactionClient = {
        exec: async (sql, params, options) => {
          if (options) {
            throw new Error(
              'Desktop Turso transaction adapter does not support per-statement work options.'
            );
          }
          statements.push({ sql, ...(params ? { params: [...params] } : {}) });
        },
        query: async () => {
          throw new Error('Desktop Turso transaction adapter only supports exec statements.');
        },
      };

      const result = await callback(batchClient);
      if (statements.length > 0) {
        await runTransaction(statements, 0, {
          label: 'turso.transaction',
          priority: 'normal',
        });
      }
      return result;
    },
  };
}

function createElectronProviderTursoFileChunkRepository(
  TursoFileChunkRepo: TursoFileChunkRepoConstructor,
  db: BrainstrikeDbExecutionClient
): TursoFileChunkRepository {
  class ElectronProviderTursoFileChunkRepository extends TursoFileChunkRepo {
    override async insert(_chunk: FileChunkInsert): Promise<FileChunk> {
      throw new Error(
        'Desktop Turso file chunk repository insert requires a callback transaction client with query support.'
      );
    }

    override async insertMany(_chunks: FileChunkInsert[]): Promise<FileChunk[]> {
      throw new Error(
        'Desktop Turso file chunk repository insertMany requires a callback transaction client with query support.'
      );
    }

    override async insertManyWithTx(
      _tx: BrainstrikeDbTransactionClient,
      _chunks: FileChunkInsert[]
    ): Promise<FileChunk[]> {
      throw new Error(
        'Desktop Turso file chunk repository insertManyWithTx requires a callback transaction client with query support.'
      );
    }

    override async clearEmbeddingsForSet(_embeddingSetId: string): Promise<number> {
      throw new Error(
        'Desktop Turso file chunk repository clearEmbeddingsForSet requires a callback transaction client with query support.'
      );
    }

    override async update(_chunk: FileChunkUpdate): Promise<FileChunk | null> {
      throw new Error(
        'Desktop Turso file chunk repository update requires a callback transaction client with query support.'
      );
    }
  }

  return new ElectronProviderTursoFileChunkRepository(db);
}

async function createElectronTursoRuntimeRepositories(
  bootstrapReport: DatabaseProfileBootstrapReportSnapshot | null | undefined,
  repositoryDb: ElectronTursoRepositoryDb
): Promise<ElectronTursoRuntimeRepositories | null> {
  const tursoViewFilterPresets = await createElectronTursoViewFilterPresetsRepository(
    bootstrapReport,
    repositoryDb
  );
  if (!tursoViewFilterPresets) {
    return null;
  }

  const [TursoEmbeddingSetsRepo, TursoFileChunkRepo, TursoFileRecordRepo, TursoTokenCacheStore] =
    await Promise.all([
      loadTursoEmbeddingSetsRepository(),
      loadTursoFileChunkRepository(),
      loadTursoFileRecordRepository(),
      loadTursoTokenCacheStore(),
    ]);
  const tursoExecutionClient = createElectronTursoExecutionClient(repositoryDb);

  return {
    embeddingSetsRepository: new TursoEmbeddingSetsRepo(tursoExecutionClient),
    executionClient: tursoExecutionClient,
    fileChunkRepository: createElectronProviderTursoFileChunkRepository(
      TursoFileChunkRepo,
      tursoExecutionClient
    ),
    fileRecordRepository: new TursoFileRecordRepo(tursoExecutionClient),
    report: tursoViewFilterPresets.report,
    tokenCacheStore: new TursoTokenCacheStore(tursoExecutionClient),
    viewFilterPresetsRepository: tursoViewFilterPresets.repository,
  };
}

async function probeElectronPGliteVectorExtension(
  electronDB: ElectronDatabaseAPI,
  diagnostics: DatabaseDiagnosticsSnapshot | null
): Promise<{
  readonly diagnostics: DatabaseDiagnosticsSnapshot | null;
  readonly hasVector: boolean;
}> {
  try {
    const res = await electronDB.query(PGVECTOR_EXTENSION_PRESENCE_QUERY);
    return {
      diagnostics,
      hasVector: Array.isArray(res.rows) && res.rows.length > 0,
    };
  } catch (error) {
    const latestDiagnostics = await getElectronDiagnostics(electronDB);
    logger.warn('Failed to detect pgvector extension over IPC', {
      diagnostics: latestDiagnostics,
      error,
    });
    return {
      diagnostics: latestDiagnostics,
      hasVector: false,
    };
  }
}

async function assertElectronPGliteVectorAvailable(
  electronDB: ElectronDatabaseAPI,
  publishDbProviderBootstrapReport: (input: {
    readonly checks: readonly ProfileBootstrapCheck[];
    readonly phase: ProfileBootstrapPhase;
  }) => void
): Promise<true> {
  const vectorProbe = await probeElectronPGliteVectorExtension(electronDB, null);
  if (vectorProbe.hasVector) {
    return true;
  }

  const pgliteDiagnostics = vectorProbe.diagnostics ?? (await getElectronDiagnostics(electronDB));
  publishDbProviderBootstrapReport({
    checks: createDbProviderBootstrapChecks({
      schemaMigrated: 'passed',
      storeOpen: 'passed',
      vectorExtension: 'failed',
    }),
    phase: 'probing-capabilities',
  });
  logger.error('Desktop database initialization missing pgvector extension', {
    diagnostics: pgliteDiagnostics,
  });
  throw new Error(
    formatDesktopDatabaseInitError(pgliteDiagnostics, 'Desktop database failed to initialize.')
  );
}

export function DbProvider({ children, dbPath, useElectronIPC }: DbProviderProps) {
  const resolvedPath = dbPath ?? getDefaultDbPath();
  const bootstrapRuntime = useMemo(
    () => inferDbProviderBootstrapRuntime(resolvedPath, useElectronIPC),
    [resolvedPath, useElectronIPC]
  );
  const [profileBootstrapReport, setProfileBootstrapReport] = useState<ProfileBootstrapReport>(() =>
    createInitialDbProviderBootstrapReport({
      profileId: resolvedPath,
      runtime: bootstrapRuntime,
      timestamp: new Date().toISOString(),
    })
  );
  const profileBootstrapReportRef = useRef(profileBootstrapReport);
  const [fileRecordRepository, setFileRecordRepository] = useState<FileRecordRepo | null>(null);
  const [chunkRepository, setChunkRepository] = useState<
    DrizzleFileChunkRepository | ElectronFileChunkRepository | TursoFileChunkRepository | null
  >(null);
  const [embeddingSetsRepository, setEmbeddingSetsRepository] = useState<EmbeddingSetsRepo | null>(
    null
  );
  const [viewFilterPresetsRepository, setViewFilterPresetsRepository] =
    useState<ViewFilterPresetsRepo | null>(null);
  const [tokenCacheStore, setTokenCacheStore] = useState<TokenCacheStoreRepo | null>(null);
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

  const publishProfileBootstrapReport = useCallback((report: ProfileBootstrapReport) => {
    profileBootstrapReportRef.current = report;
    setProfileBootstrapReport(report);
  }, []);

  const publishDbProviderBootstrapReport = useCallback(
    (input: {
      readonly checks: readonly ProfileBootstrapCheck[];
      readonly phase: ProfileBootstrapPhase;
    }) => {
      const report = createDbProviderBootstrapReport({
        checks: input.checks,
        phase: input.phase,
        profileId: resolvedPath,
        runtime: bootstrapRuntime,
        startedAt: profileBootstrapReportRef.current.startedAt,
        updatedAt: new Date().toISOString(),
      });
      publishProfileBootstrapReport(report);
      return report;
    },
    [bootstrapRuntime, publishProfileBootstrapReport, resolvedPath]
  );

  const testElectronConnection: (electronDB: ElectronDatabaseAPI) => Promise<DatabaseTestResult> =
    useCallback(async (electronDB) => {
      if (!electronDB.test) {
        throw new Error('Electron database test operation is unavailable over IPC.');
      }

      try {
        const testResult = await electronDB.test();
        if (!testResult.success) {
          throw new Error(`Database test failed: ${testResult.message}`);
        }
        logger.debug('Database test passed', { message: testResult.message });
        return testResult;
      } catch (error) {
        logger.warn('Database test failed:', error);
        throw error;
      }
    }, []);

  const initializeElectronIPC = useCallback(
    async (cancelled: { value: boolean }) => {
      if (!useElectronIPC) {
        return false;
      }

      const electronDB = getRequiredElectronDatabaseBridge(publishDbProviderBootstrapReport);

      logger.debug('Using Electron IPC database connection');

      const testResult = await testElectronConnection(electronDB);
      const electronExec = electronDB.exec;
      const electronRunTransaction = electronDB.runTransaction;

      if (!electronExec) {
        throw new Error('Electron database exec operation is unavailable over IPC');
      }

      const repositoryDb = createElectronTursoRepositoryDb(
        electronDB,
        electronExec,
        electronRunTransaction
      );

      const tursoRepositories = await createElectronTursoRuntimeRepositories(
        testResult?.profileBootstrapReport,
        repositoryDb
      );
      if (tursoRepositories) {
        if (!cancelled.value) {
          logger.info('Desktop Turso DB provider initialized with migrated repository coverage', {
            migratedRepositories: [
              'embedding_sets',
              ...(tursoRepositories.fileChunkRepository ? ['file_chunks'] : []),
              'file_records',
              'file_token_cache',
              'view_filter_presets',
            ],
            unavailableRepositories: tursoRepositories.fileChunkRepository ? [] : ['file_chunks'],
          });
          connectionRef.current = { kind: 'ipc', bridge: electronDB };
          setExposedDb(
            createDbHandle(tursoRepositories.executionClient as unknown as QueryExecutor)
          );
          setFileRecordRepository(tursoRepositories.fileRecordRepository);
          setChunkRepository(tursoRepositories.fileChunkRepository);
          setEmbeddingSetsRepository(tursoRepositories.embeddingSetsRepository);
          setViewFilterPresetsRepository(tursoRepositories.viewFilterPresetsRepository);
          setTokenCacheStore(tursoRepositories.tokenCacheStore);
          setVectorEnabled(false);
          publishProfileBootstrapReport(tursoRepositories.report);
          setError(null);
          setReady(true);
        }
        return true;
      }

      // The repository doesn't need the test method, so we can pass just the db interface
      const repository = new ElectronFileRecordRepository(repositoryDb);
      publishDbProviderBootstrapReport({
        checks: createDbProviderBootstrapChecks({
          schemaMigrated: 'passed',
          storeOpen: 'passed',
          vectorExtension: 'pending',
        }),
        phase: 'probing-capabilities',
      });
      const hasVector = await assertElectronPGliteVectorAvailable(
        electronDB,
        publishDbProviderBootstrapReport
      );
      const chunkRepo = new ElectronFileChunkRepository(repositoryDb);

      // Dynamic import via module-level helpers (avoids import() in component scope)
      const ElectronEmbeddingSetsRepo = await loadElectronEmbeddingSetsRepository();
      const embeddingSetsRepo = new ElectronEmbeddingSetsRepo(repositoryDb);

      const ElectronViewFilterPresetsRepo = await loadElectronViewFilterPresetsRepository();
      const viewFilterPresetsRepo = new ElectronViewFilterPresetsRepo(repositoryDb);

      if (!cancelled.value) {
        connectionRef.current = { kind: 'ipc', bridge: electronDB };
        setExposedDb(createDbHandle(electronDB as unknown as QueryExecutor));
        setFileRecordRepository(repository);
        setChunkRepository(chunkRepo);
        setEmbeddingSetsRepository(embeddingSetsRepo);
        setViewFilterPresetsRepository(viewFilterPresetsRepo);
        setTokenCacheStore(null);
        setVectorEnabled(hasVector);
        publishDbProviderBootstrapReport({
          checks: createDbProviderBootstrapChecks({
            schemaMigrated: 'passed',
            storeOpen: 'passed',
            vectorExtension: 'passed',
          }),
          phase: 'ready',
        });
        setError(null);
        setReady(true);
      }
      return true;
    },
    [
      useElectronIPC,
      testElectronConnection,
      publishDbProviderBootstrapReport,
      publishProfileBootstrapReport,
    ]
  );

  const initializeDirectPGlite = useCallback(
    async (cancelled: { value: boolean }) => {
      logger.debug('Using direct PGlite connection');

      publishDbProviderBootstrapReport({
        checks: createDbProviderBootstrapChecks({
          schemaMigrated: 'pending',
          storeOpen: 'pending',
          vectorExtension: 'pending',
        }),
        phase: 'opening-store',
      });
      const db = await wasmLoader.createPGliteClient(resolvedPath);
      connectionRef.current = { kind: 'direct', db, dataDir: resolvedPath };
      publishDbProviderBootstrapReport({
        checks: createDbProviderBootstrapChecks({
          schemaMigrated: 'pending',
          storeOpen: 'passed',
          vectorExtension: 'pending',
        }),
        phase: 'migrating-schema',
      });

      const scheduledDb = createScheduledDbHandle(
        db as unknown as QueryExecutor & object,
        databaseWorkSchedulerRef.current,
        getRendererDefaultDatabaseWorkPriority()
      ) as unknown as PGlite & ScheduledDbHandle;
      markPGliteDrizzleCompatible(scheduledDb);

      await migrate(scheduledDb);
      publishDbProviderBootstrapReport({
        checks: createDbProviderBootstrapChecks({
          schemaMigrated: 'passed',
          storeOpen: 'passed',
          vectorExtension: 'pending',
        }),
        phase: 'probing-capabilities',
      });

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
        publishDbProviderBootstrapReport({
          checks: createDbProviderBootstrapChecks({
            schemaMigrated: 'passed',
            storeOpen: 'passed',
            vectorExtension: 'failed',
          }),
          phase: 'probing-capabilities',
        });
        throw new Error(
          'pgvector extension failed to initialize. Ensure @electric-sql/pglite-pgvector is bundled.'
        );
      }
      publishDbProviderBootstrapReport({
        checks: createDbProviderBootstrapChecks({
          schemaMigrated: 'passed',
          storeOpen: 'passed',
          vectorExtension: 'passed',
        }),
        phase: 'probing-capabilities',
      });

      // Create Drizzle instance and type-safe repositories
      // Dynamic imports via module-level helpers (avoids import() in component scope)
      const DrizzleEmbeddingSetsRepo = await loadDrizzleEmbeddingSetsRepository();
      const DrizzleViewFilterPresetsRepo = await loadDrizzleViewFilterPresetsRepository();
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
        publishDbProviderBootstrapReport({
          checks: createDbProviderBootstrapChecks({
            schemaMigrated: 'passed',
            storeOpen: 'passed',
            vectorExtension: 'passed',
          }),
          phase: 'ready',
        });
      }
    },
    [resolvedPath, publishDbProviderBootstrapReport]
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
        publishProfileBootstrapReport(
          failProfileBootstrapReport(profileBootstrapReportRef.current, {
            error: err,
            failedAt: new Date().toISOString(),
            phase: coerceFailureBootstrapPhase(profileBootstrapReportRef.current.phase),
          })
        );
        clearDbProviderRepositoryStateForError({
          setFileRecordRepository,
          setChunkRepository,
          setEmbeddingSetsRepository,
          setViewFilterPresetsRepository,
          setTokenCacheStore,
        });
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
  }, [
    lazyInitialized,
    useElectronIPC,
    initializeElectronIPC,
    initializeDirectPGlite,
    publishProfileBootstrapReport,
  ]);

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
        deletedFiles: result.deletedFiles || 0,
        deletedChunks: result.deletedChunks || 0,
      };
    }
    throw new Error(result.message || 'Failed to clear database via Electron IPC');
  }, []);

  const clearViaPGlite = useCallback(async () => {
    if (!connectionRef.current) {
      await initializeDatabase();
    }
    const conn = connectionRef.current;
    if (!conn || conn.kind !== 'direct') {
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
      await clearAssistantRunUsage(tx, 'during clearAll');

      return { deletedFiles: Number(deletedFiles), deletedChunks: Number(deletedChunks) };
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
    // Durable per-thread token usage has no FK, so it must be explicitly
    // purged to preserve the factory-reset fresh-start contract.
    await clearAssistantRunUsage(tx, 'during reset');
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
    if (connectionRef.current) {
      await purgeAndClosePGlite();
    } else {
      logger.warn('[DbProvider] No active database to purge during factory reset');
    }

    resetPendingReloadRef.current = true;
    connectionRef.current = null;
    setExposedDb(null);
    setDrizzleDb(null);
    setFileRecordRepository(null);
    setChunkRepository(null);
    setEmbeddingSetsRepository(null);
    setViewFilterPresetsRepository(null);
    setTokenCacheStore(null);
    setVectorEnabled(false);
    publishProfileBootstrapReport(
      createInitialDbProviderBootstrapReport({
        profileId: resolvedPath,
        runtime: bootstrapRuntime,
        timestamp: new Date().toISOString(),
      })
    );
    setReady(false);
    setLazyInitialized(false);
    setInitializationStatus('idle');
    setInitializing(false);

    // Clear active embedding set ID from localStorage to prevent stale collections
    clearActiveEmbeddingSetIdFromStorage();

    await cleanupAndWaitForReset();
  }, [
    purgeAndClosePGlite,
    cleanupAndWaitForReset,
    publishProfileBootstrapReport,
    resolvedPath,
    bootstrapRuntime,
  ]);

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
      fileRecordRepository,
      chunkRepository,
      embeddingSetsRepository,
      viewFilterPresetsRepository,
      tokenCacheStore,
      drizzleDb,
      error,
      ready,
      initializationStatus,
      initializing,
      profileBootstrapReport,
      db: exposedDb,
      clearAllData,
      initializeDatabase,
      vectorEnabled,
      factoryReset: async () => {
        const handled = await tryElectronHardReset();
        if (handled) {
          logger.info('[DbProvider] Electron hard reset completed');
          return;
        }

        await resetPGliteState();
      },
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
        if (!conn || conn.kind !== 'direct') {
          return;
        }
        await conn.db.transaction(async (tx) => {
          await purgeQueuesAndSetsTx(tx);
        });
      },
    }),
    [
      fileRecordRepository,
      chunkRepository,
      embeddingSetsRepository,
      viewFilterPresetsRepository,
      tokenCacheStore,
      drizzleDb,
      error,
      ready,
      initializationStatus,
      initializing,
      profileBootstrapReport,
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

export function useOptionalDbInitializationStatus(): DbInitializationStatus {
  const ctx = useContext(DbContext);
  return ctx?.initializationStatus ?? 'idle';
}

export function useProfileBootstrapReport(): ProfileBootstrapReport {
  const ctx = useContext(DbContext);
  if (!ctx) {
    throw new Error('useProfileBootstrapReport must be used within a DbProvider');
  }
  return ctx.profileBootstrapReport;
}

export function useOptionalProfileBootstrapReport(): ProfileBootstrapReport | null {
  const ctx = useContext(DbContext);
  return ctx?.profileBootstrapReport ?? null;
}

export function useFileRecordRepository(): FileRecordRepo | null {
  const ctx = useContext(DbContext);

  // Destructure to get stable references for dependency array
  const fileRecordRepository = ctx?.fileRecordRepository;
  const error = ctx?.error;
  const initializing = ctx?.initializing;
  const initializeDatabase = ctx?.initializeDatabase;
  const initializationStatus = ctx?.initializationStatus;

  // Trigger lazy initialization when first accessed
  // Only trigger if not already initializing to avoid duplicate calls
  useEffect(() => {
    if (
      !(fileRecordRepository || error || initializing || initializationStatus === 'ready') &&
      initializeDatabase
    ) {
      initializeDatabase().catch((err) => {
        logDatabaseError('Failed to lazy-initialize database', err);
      });
    }
  }, [fileRecordRepository, error, initializing, initializeDatabase, initializationStatus]);

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
  const initializationStatus = ctx?.initializationStatus;

  // Trigger lazy initialization when first accessed
  // Only trigger if not already initializing to avoid duplicate calls
  useEffect(() => {
    if (!(db || error || initializing || initializationStatus === 'ready') && initializeDatabase) {
      initializeDatabase().catch((err) => {
        logDatabaseError('Failed to lazy-initialize database', err);
      });
    }
  }, [db, error, initializing, initializeDatabase, initializationStatus]);

  if (!ctx) {
    logger.warn('usePGliteDatabase must be used within a DbProvider');
    return null;
  }

  return ctx.ready && !ctx.error && ctx.profileBootstrapReport.runtime.engine === 'pglite'
    ? ctx.db
    : null;
}

export function useBrainstrikeDatabase(): DbHandle | null {
  return useBrainstrikeDbClient();
}

export function useBrainstrikeDbClient(): DbHandle | null {
  const ctx = useContext(DbContext);

  const db = ctx?.db;
  const error = ctx?.error;
  const initializing = ctx?.initializing;
  const initializeDatabase = ctx?.initializeDatabase;
  const initializationStatus = ctx?.initializationStatus;

  useEffect(() => {
    if (!(db || error || initializing || initializationStatus === 'ready') && initializeDatabase) {
      initializeDatabase().catch((err) => {
        logDatabaseError('Failed to lazy-initialize database', err);
      });
    }
  }, [db, error, initializing, initializeDatabase, initializationStatus]);

  if (!ctx) {
    logger.warn('useBrainstrikeDbClient must be used within a DbProvider');
    return null;
  }

  return ctx.ready && !ctx.error && ctx.profileBootstrapReport.runtime.engine === 'pglite'
    ? ctx.db
    : null;
}

export function useModelRegistryDbClient(): DbHandle | null {
  const ctx = useContext(DbContext);

  const db = ctx?.db;
  const error = ctx?.error;
  const initializing = ctx?.initializing;
  const initializeDatabase = ctx?.initializeDatabase;
  const initializationStatus = ctx?.initializationStatus;

  useEffect(() => {
    if (!(db || error || initializing || initializationStatus === 'ready') && initializeDatabase) {
      initializeDatabase().catch((err) => {
        logDatabaseError('Failed to lazy-initialize database', err);
      });
    }
  }, [db, error, initializing, initializeDatabase, initializationStatus]);

  if (!ctx) {
    logger.warn('useModelRegistryDbClient must be used within a DbProvider');
    return null;
  }

  return ctx.ready && !ctx.error ? ctx.db : null;
}

export function useAssistantMemoryDbClient(): AssistantMemoryDbClient | null {
  const ctx = useContext(DbContext);

  const db = ctx?.db;
  const error = ctx?.error;
  const initializing = ctx?.initializing;
  const initializeDatabase = ctx?.initializeDatabase;
  const initializationStatus = ctx?.initializationStatus;

  useEffect(() => {
    if (!(db || error || initializing || initializationStatus === 'ready') && initializeDatabase) {
      initializeDatabase().catch((err) => {
        logDatabaseError('Failed to lazy-initialize database', err);
      });
    }
  }, [db, error, initializing, initializeDatabase, initializationStatus]);

  if (!ctx) {
    logger.warn('useAssistantMemoryDbClient must be used within a DbProvider');
    return null;
  }

  const runtimeEngine = ctx.profileBootstrapReport.runtime.engine;
  if (!(runtimeEngine === 'pglite' || runtimeEngine === 'turso')) {
    return null;
  }

  return ctx.ready && !ctx.error && ctx.db ? { db: ctx.db, runtimeEngine } : null;
}

export function useManualImportDbClient(): ManualImportDbClient | null {
  const ctx = useContext(DbContext);

  const db = ctx?.db;
  const error = ctx?.error;
  const initializing = ctx?.initializing;
  const initializeDatabase = ctx?.initializeDatabase;
  const initializationStatus = ctx?.initializationStatus;

  useEffect(() => {
    if (!(db || error || initializing || initializationStatus === 'ready') && initializeDatabase) {
      initializeDatabase().catch((err) => {
        logDatabaseError('Failed to lazy-initialize database', err);
      });
    }
  }, [db, error, initializing, initializeDatabase, initializationStatus]);

  const runtimeEngine = ctx?.profileBootstrapReport.runtime.engine;
  const ready = ctx?.ready;
  const client = useMemo<ManualImportDbClient | null>(() => {
    if (!((runtimeEngine === 'pglite' || runtimeEngine === 'turso') && ready) || error || !db) {
      return null;
    }

    return { db, runtimeEngine };
  }, [db, error, ready, runtimeEngine]);

  if (!ctx) {
    logger.warn('useManualImportDbClient must be used within a DbProvider');
    return null;
  }

  return client;
}

export function useQuerySelectionSnapshotDbClient(): QuerySelectionSnapshotDbClient | null {
  const ctx = useContext(DbContext);

  const db = ctx?.db;
  const error = ctx?.error;
  const initializing = ctx?.initializing;
  const initializeDatabase = ctx?.initializeDatabase;
  const initializationStatus = ctx?.initializationStatus;

  useEffect(() => {
    if (!(db || error || initializing || initializationStatus === 'ready') && initializeDatabase) {
      initializeDatabase().catch((err) => {
        logDatabaseError('Failed to lazy-initialize database', err);
      });
    }
  }, [db, error, initializing, initializeDatabase, initializationStatus]);

  const runtimeEngine = ctx?.profileBootstrapReport.runtime.engine;
  const ready = ctx?.ready;
  const client = useMemo<QuerySelectionSnapshotDbClient | null>(() => {
    if (!((runtimeEngine === 'pglite' || runtimeEngine === 'turso') && ready) || error || !db) {
      return null;
    }

    return { db, runtimeEngine };
  }, [db, error, ready, runtimeEngine]);

  if (!ctx) {
    logger.warn('useQuerySelectionSnapshotDbClient must be used within a DbProvider');
    return null;
  }

  return client;
}

export function useWorkspaceRootsDbClient(): WorkspaceRootsDbClient | null {
  const ctx = useContext(DbContext);

  const db = ctx?.db;
  const error = ctx?.error;
  const initializing = ctx?.initializing;
  const initializeDatabase = ctx?.initializeDatabase;
  const initializationStatus = ctx?.initializationStatus;

  useEffect(() => {
    if (!(db || error || initializing || initializationStatus === 'ready') && initializeDatabase) {
      initializeDatabase().catch((err) => {
        logDatabaseError('Failed to lazy-initialize database', err);
      });
    }
  }, [db, error, initializing, initializeDatabase, initializationStatus]);

  const runtimeEngine = ctx?.profileBootstrapReport.runtime.engine;
  const ready = ctx?.ready;
  const client = useMemo<WorkspaceRootsDbClient | null>(() => {
    if (!((runtimeEngine === 'pglite' || runtimeEngine === 'turso') && ready) || error || !db) {
      return null;
    }

    return { db, runtimeEngine };
  }, [db, error, ready, runtimeEngine]);

  if (!ctx) {
    logger.warn('useWorkspaceRootsDbClient must be used within a DbProvider');
    return null;
  }

  return client;
}

export function useOptionalPGliteDatabase(): DbHandle | null {
  const ctx = useContext(DbContext);
  const db = ctx?.db;
  const error = ctx?.error;
  const initializing = ctx?.initializing;
  const initializeDatabase = ctx?.initializeDatabase;
  const initializationStatus = ctx?.initializationStatus;

  useEffect(() => {
    if (!(db || error || initializing || initializationStatus === 'ready') && initializeDatabase) {
      initializeDatabase().catch((err) => {
        logDatabaseError('Failed to lazy-initialize database', err);
      });
    }
  }, [db, error, initializing, initializeDatabase, initializationStatus]);

  return ctx?.ready && !ctx.error && ctx.profileBootstrapReport.runtime.engine === 'pglite'
    ? ctx.db
    : null;
}

export function useOptionalBrainstrikeDatabase(): DbHandle | null {
  return useOptionalBrainstrikeDbClient();
}

export function useOptionalBrainstrikeDbClient(): DbHandle | null {
  const ctx = useContext(DbContext);
  const db = ctx?.db;
  const error = ctx?.error;
  const initializing = ctx?.initializing;
  const initializeDatabase = ctx?.initializeDatabase;
  const initializationStatus = ctx?.initializationStatus;

  useEffect(() => {
    if (!(db || error || initializing || initializationStatus === 'ready') && initializeDatabase) {
      initializeDatabase().catch((err) => {
        logDatabaseError('Failed to lazy-initialize database', err);
      });
    }
  }, [db, error, initializing, initializeDatabase, initializationStatus]);

  return ctx?.ready && !ctx.error && ctx.profileBootstrapReport.runtime.engine === 'pglite'
    ? ctx.db
    : null;
}

export function useTokenCacheStore(): TokenCacheStoreRepo | null {
  const ctx = useContext(DbContext);
  const tokenCacheStore = ctx?.tokenCacheStore;
  const error = ctx?.error;
  const initializing = ctx?.initializing;
  const initializeDatabase = ctx?.initializeDatabase;
  const initializationStatus = ctx?.initializationStatus;

  useEffect(() => {
    if (
      !(tokenCacheStore || error || initializing || initializationStatus === 'ready') &&
      initializeDatabase
    ) {
      initializeDatabase().catch((err) => {
        logDatabaseError('Failed to lazy-initialize database', err);
      });
    }
  }, [tokenCacheStore, error, initializing, initializeDatabase, initializationStatus]);

  if (!ctx) {
    logger.warn('useTokenCacheStore must be used within a DbProvider');
    return null;
  }

  return ctx.ready && !ctx.error ? ctx.tokenCacheStore : null;
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
  | TursoFileChunkRepository
  | null {
  const ctx = useContext(DbContext);

  // Destructure to get stable references for dependency array
  const chunkRepository = ctx?.chunkRepository;
  const error = ctx?.error;
  const initializing = ctx?.initializing;
  const initializeDatabase = ctx?.initializeDatabase;
  const initializationStatus = ctx?.initializationStatus;

  // Trigger lazy initialization when first accessed
  // Only trigger if not already initializing to avoid duplicate calls
  useEffect(() => {
    if (
      !(chunkRepository || error || initializing || initializationStatus === 'ready') &&
      initializeDatabase
    ) {
      initializeDatabase().catch((err) => {
        logDatabaseError('Failed to lazy-initialize database', err);
      });
    }
  }, [chunkRepository, error, initializing, initializeDatabase, initializationStatus]);

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
  const initializationStatus = ctx?.initializationStatus;

  // Trigger lazy initialization when first accessed
  // Only trigger if not already initializing to avoid duplicate calls
  useEffect(() => {
    if (
      !(fileRecordRepository || error || initializing || initializationStatus === 'ready') &&
      initializeDatabase
    ) {
      initializeDatabase().catch((err) => {
        logDatabaseError('Failed to lazy-initialize database', err);
      });
    }
  }, [fileRecordRepository, error, initializing, initializeDatabase, initializationStatus]);

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
  const initializationStatus = ctx?.initializationStatus;

  // Trigger lazy initialization when first accessed
  // Only trigger if not already initializing to avoid duplicate calls
  useEffect(() => {
    if (!(db || error || initializing || initializationStatus === 'ready') && initializeDatabase) {
      initializeDatabase().catch((err) => {
        logDatabaseError('Failed to lazy-initialize database', err);
      });
    }
  }, [db, error, initializing, initializeDatabase, initializationStatus]);

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
  const initializationStatus = ctx?.initializationStatus;

  // Trigger lazy initialization when first accessed
  // Only trigger if not already initializing to avoid duplicate calls
  useEffect(() => {
    if (!(db || error || initializing || initializationStatus === 'ready') && initializeDatabase) {
      initializeDatabase().catch((err) => {
        logDatabaseError('Failed to lazy-initialize database', err);
      });
    }
  }, [db, error, initializing, initializeDatabase, initializationStatus]);

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
  const initializationStatus = ctx?.initializationStatus;

  // Trigger lazy initialization when first accessed
  useEffect(() => {
    if (
      !(drizzleDb || error || initializing || initializationStatus === 'ready') &&
      initializeDatabase
    ) {
      initializeDatabase().catch((err) => {
        logDatabaseError('Failed to lazy-initialize database', err);
      });
    }
  }, [drizzleDb, error, initializing, initializeDatabase, initializationStatus]);

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
  const initializationStatus = ctx?.initializationStatus;

  // Trigger lazy initialization when first accessed
  useEffect(() => {
    if (
      !(embeddingSetsRepository || error || initializing || initializationStatus === 'ready') &&
      initializeDatabase
    ) {
      initializeDatabase().catch((err) => {
        logDatabaseError('Failed to lazy-initialize database', err);
      });
    }
  }, [embeddingSetsRepository, error, initializing, initializeDatabase, initializationStatus]);

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
  const initializationStatus = ctx?.initializationStatus;

  // Trigger lazy initialization when first accessed
  useEffect(() => {
    if (
      !(viewFilterPresetsRepository || error || initializing || initializationStatus === 'ready') &&
      initializeDatabase
    ) {
      initializeDatabase().catch((err) => {
        logDatabaseError('Failed to lazy-initialize database', err);
      });
    }
  }, [viewFilterPresetsRepository, error, initializing, initializeDatabase, initializationStatus]);

  if (!ctx) {
    logger.warn('useViewFilterPresetsRepository must be used within a DbProvider');
    return null;
  }

  return ctx.ready && !ctx.error ? ctx.viewFilterPresetsRepository : null;
}
