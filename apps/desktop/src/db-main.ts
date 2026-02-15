import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createLogger } from '@brainstrike/utils';
import { app } from 'electron';

const logger = createLogger('DatabaseMain');

export type DatabaseInitFailureCategory =
  | 'missing-extension'
  | 'corruption'
  | 'wasm-runtime'
  | 'filesystem'
  | 'migration'
  | 'unknown';

export type DatabaseInitStage =
  | 'load-extensions'
  | 'open-database'
  | 'migration'
  | 'runtime-corruption-recovery';

interface ErrorDetails {
  message: string;
  stack?: string;
  name?: string;
  code?: string;
}

export interface DatabaseInitFailureSnapshot extends ErrorDetails {
  stage: DatabaseInitStage;
  category: DatabaseInitFailureCategory;
  timestamp: string;
}

export interface DatabaseDiagnosticsSnapshot {
  nodeEnv: string | null;
  dataDir: string;
  appDataDir: string;
  initializationAttemptCount: number;
  initializationInFlight: boolean;
  hasDatabaseHandle: boolean;
  lastInitializationStartedAt: string | null;
  lastInitializationSucceededAt: string | null;
  lastInitializationFailure: DatabaseInitFailureSnapshot | null;
  runtimeCorruptionRecoveryCount: number;
  lastRuntimeCorruptionAt: string | null;
  lastRuntimeCorruptionContext: string | null;
}

interface ExtensionModuleShape {
  default?: unknown;
  vector?: unknown;
  live?: unknown;
}

function extractExtensionExport(module: unknown, field: 'vector' | 'live'): unknown {
  if (module && typeof module === 'object') {
    const record = module as ExtensionModuleShape;
    if (record[field]) {
      return record[field];
    }
    try {
      if (record.default) {
        return record.default;
      }
    } catch {
      // Ignore missing default export for mocked modules that only expose named exports
    }
  }
  return module;
}

function getErrorDetails(error: unknown): ErrorDetails {
  const errorCode =
    error && typeof error === 'object' && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;
  const code = typeof errorCode === 'string' ? errorCode : undefined;

  if (error instanceof Error) {
    const details: ErrorDetails = {
      message: error.message,
    };
    if (error.stack) {
      details.stack = error.stack;
    }
    if (error.name) {
      details.name = error.name;
    }
    if (code) {
      details.code = code;
    }
    return details;
  }
  if (error === null || error === undefined) {
    const details: ErrorDetails = {
      message: 'unknown error',
    };
    if (code) {
      details.code = code;
    }
    return details;
  }
  const details: ErrorDetails = {
    message: String(error),
  };
  if (code) {
    details.code = code;
  }
  return details;
}

async function loadPgVectorExtension(): Promise<unknown> {
  try {
    const vectorModule = await import('@electric-sql/pglite/vector');
    const vector = extractExtensionExport(vectorModule, 'vector');
    if (!vector) {
      throw new Error('vector export missing from module');
    }
    logger.info('pgvector extension loaded successfully (ESM)');
    return vector;
  } catch (error) {
    const details = getErrorDetails(error);
    logger.error('pgvector extension failed to load.', {
      attempts: [
        {
          source: 'ESM',
          ...details,
        },
      ],
    });
    throw new Error(
      `pgvector extension is required and failed to load via ESM import. (${details.message})`
    );
  }
}

async function loadPgLiveExtension(): Promise<unknown> {
  try {
    const liveModule = await import('@electric-sql/pglite/live');
    const live = extractExtensionExport(liveModule, 'live');
    if (!live) {
      throw new Error('live export missing from module');
    }
    logger.info('pglite live query extension loaded successfully (ESM)');
    return live;
  } catch (error) {
    const details = getErrorDetails(error);
    logger.error('pglite live query extension failed to load.', details);
    throw new Error(
      `live query extension is required and failed to load via ESM import. (${details.message})`
    );
  }
}

// Dynamic imports for ESM packages
const getPGlite = async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { migrate } = await import('@brainstrike/db');
  const vector = await loadPgVectorExtension();
  const live = await loadPgLiveExtension();
  return { PGlite, migrate, vector, live };
};

// Database instance for main process
// biome-ignore lint/suspicious/noExplicitAny: PGlite type is not available at compile time due to dynamic import
let db: any = null;
// Single-flight guard for startup/runtime callers that hit getDatabase() concurrently.
// Without this we can spawn multiple PGlite initializations at once, which causes
// nondeterministic wasm aborts and noisy pgvector initialization failures.
// biome-ignore lint/suspicious/noExplicitAny: PGlite type is not available at compile time
let dbInitializationPromise: Promise<any> | null = null;
let initializationAttemptCount = 0;
let lastInitializationStartedAt: string | null = null;
let lastInitializationSucceededAt: string | null = null;
let lastInitializationFailure: DatabaseInitFailureSnapshot | null = null;
let runtimeCorruptionRecoveryCount = 0;
let lastRuntimeCorruptionAt: string | null = null;
let lastRuntimeCorruptionContext: string | null = null;

// Helper to create and validate a PGlite instance with pgvector
async function createVectorDatabase(
  PGliteCtor: unknown,
  dataDir: string,
  vector: unknown,
  live: unknown
) {
  // biome-ignore lint/suspicious/noExplicitAny: PGlite ctor type not available at compile time
  const Ctor: any = PGliteCtor as any;
  // biome-ignore lint/suspicious/noExplicitAny: PGlite instance type not available at compile time
  const instance: any = new Ctor({
    dataDir,
    // biome-ignore lint/suspicious/noExplicitAny: PGlite vector extension type not available at compile time
    extensions: { vector: vector as any, live: live as any },
  });
  await instance.query('SELECT 1');
  await instance.exec('CREATE EXTENSION IF NOT EXISTS vector');
  const res = await instance.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'");
  if (!res.rows.length) {
    throw new Error('pgvector extension not registered in database');
  }
  return instance;
}

/**
 * Get the database directory path
 * Uses a different directory for development vs production
 */
function getDatabasePath(): string {
  // In test mode, store the database within the isolated User Data directory.
  // This ensures that parallel test shards (which have unique User Data dirs)
  // do not conflict over the same database lock file in the shared Documents folder.
  if (process.env['NODE_ENV'] === 'test') {
    return path.join(app.getPath('userData'), 'pgdata');
  }

  const isProduction = process.env['NODE_ENV'] === 'production';
  const dbDirName = isProduction ? 'BrainStrike' : 'BrainStrike-dev';
  return path.join(app.getPath('documents'), dbDirName, 'pgdata');
}

/**
 * Get the parent application data directory (contains pgdata and potentially other app files)
 */
function getAppDataPath(): string {
  if (process.env['NODE_ENV'] === 'test') {
    return path.join(app.getPath('userData'), 'pgdata');
  }

  const isProduction = process.env['NODE_ENV'] === 'production';
  const dbDirName = isProduction ? 'BrainStrike' : 'BrainStrike-dev';
  return path.join(app.getPath('documents'), dbDirName);
}

function createResetBackup(appDataDir: string): string | null {
  if (process.env['NODE_ENV'] === 'test' || !existsSync(appDataDir)) {
    return null;
  }

  const backupRootDir = path.join(path.dirname(appDataDir), 'backups');
  mkdirSync(backupRootDir, { recursive: true });
  const backupSuffix = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(backupRootDir, `${path.basename(appDataDir)}-${backupSuffix}`);

  cpSync(appDataDir, backupDir, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });

  return backupDir;
}

/**
 * Known PostgreSQL error codes that indicate index/data corruption requiring full reset.
 *
 * NOTE: We intentionally exclude XX000 (internal_error) as it's too broad and used for
 * many non-corruption failures (e.g., internal bugs, unsupported features). Including it
 * would cause false positives that wipe user data unnecessarily.
 *
 * We rely on specific error codes and message pattern matching to identify true corruption.
 */
const CORRUPTION_ERROR_CODES = [
  'XX002', // Index corruption (e.g., "right sibling's left-link doesn't match")
  // XX000 deliberately excluded - too generic, causes false positives
  // XX001 (data_corrupted) is rare but specific enough to include
  'XX001', // Data corruption
] as const;

/**
 * Error messages that indicate corruption even without error codes
 */
const CORRUPTION_ERROR_PATTERNS = [
  "right sibling's left-link doesn't match",
  'could not locate a valid checkpoint record',
  'invalid resource manager ID',
  'database system was interrupted',
  'invalid page in block',
  'page verification failed',
] as const;

const WASM_ABORT_ERROR_PATTERNS = [
  'aborted(). build with -sassertions for more info.',
  'aborted()',
  'runtimeerror: unreachable',
  'wasm trap',
] as const;

/**
 * Check if an error indicates database corruption that requires a full reset
 */
export function isCorruptionError(error: unknown): boolean {
  if (!error) {
    return false;
  }

  const errorObj = error as { code?: string; message?: string };
  const code = errorObj.code;
  const message = errorObj.message ?? String(error);

  if (code && CORRUPTION_ERROR_CODES.includes(code as (typeof CORRUPTION_ERROR_CODES)[number])) {
    return true;
  }

  const lowerMessage = message.toLowerCase();
  return CORRUPTION_ERROR_PATTERNS.some((pattern) => lowerMessage.includes(pattern.toLowerCase()));
}

export function isWasmAbortError(error: unknown): boolean {
  if (!error) {
    return false;
  }

  const message = error instanceof Error ? error.message : String(error);
  const lowerMessage = message.toLowerCase();
  return WASM_ABORT_ERROR_PATTERNS.some((pattern) => lowerMessage.includes(pattern));
}

const FILESYSTEM_ERROR_CODES = ['EACCES', 'EPERM', 'ENOENT', 'EIO', 'ENOTDIR'] as const;

function classifyInitializationFailure(
  stage: DatabaseInitStage,
  error: unknown
): DatabaseInitFailureCategory {
  const details = getErrorDetails(error);
  const message = details.message.toLowerCase();

  if (
    stage === 'load-extensions' ||
    message.includes('@electric-sql/pglite/vector') ||
    message.includes('vector export missing') ||
    message.includes('failed to load via esm import')
  ) {
    return 'missing-extension';
  }

  if (isCorruptionError(error)) {
    return 'corruption';
  }

  if (
    (details.code &&
      FILESYSTEM_ERROR_CODES.includes(details.code as (typeof FILESYSTEM_ERROR_CODES)[number])) ||
    message.includes('permission denied') ||
    message.includes('read-only file system') ||
    message.includes('no such file')
  ) {
    return 'filesystem';
  }

  if (stage === 'migration' || message.includes('migrations failed')) {
    return 'migration';
  }

  if (message.includes('aborted()') || message.includes('wasm')) {
    return 'wasm-runtime';
  }

  return 'unknown';
}

function recordInitializationFailure(stage: DatabaseInitStage, error: unknown): void {
  const details = getErrorDetails(error);
  lastInitializationFailure = {
    ...details,
    stage,
    category: classifyInitializationFailure(stage, error),
    timestamp: new Date().toISOString(),
  };
}

function recordInitializationSuccess(): void {
  lastInitializationSucceededAt = new Date().toISOString();
  lastInitializationFailure = null;
}

export function getDatabaseDiagnostics(): DatabaseDiagnosticsSnapshot {
  return {
    nodeEnv: process.env['NODE_ENV'] ?? null,
    dataDir: getDatabasePath(),
    appDataDir: getAppDataPath(),
    initializationAttemptCount,
    initializationInFlight: dbInitializationPromise !== null,
    hasDatabaseHandle: Boolean(db),
    lastInitializationStartedAt,
    lastInitializationSucceededAt,
    lastInitializationFailure,
    runtimeCorruptionRecoveryCount,
    lastRuntimeCorruptionAt,
    lastRuntimeCorruptionContext,
  };
}

/**
 * Safely close the database connection, ignoring errors
 */
async function safeCloseDatabase(): Promise<void> {
  try {
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  } catch {
    // ignore close errors
  } finally {
    db = null;
  }
}

/**
 * Attempt corruption recovery by resetting and reinitializing the database.
 * Throws if recovery fails.
 */
async function attemptCorruptionRecovery(
  context: string,
  reason: 'corruption' | 'wasm-abort'
): Promise<void> {
  const reasonLabel = reason === 'corruption' ? 'database corruption' : 'WASM initialization abort';
  logger.warn(`Recoverable ${reasonLabel} detected during ${context}. Attempting auto-recovery...`);
  await safeCloseDatabase();
  await resetLocalDatabase();
  logger.info('Database reset complete. Retrying initialization...');
}

/**
 * Handle corruption error with optional auto-recovery.
 * Returns reinitalized db if recovery succeeds, otherwise throws.
 */
async function handleCorruptionError(
  err: unknown,
  context: string,
  retryAfterCorruption: boolean
  // biome-ignore lint/suspicious/noExplicitAny: PGlite type is not available at compile time
): Promise<any> {
  await safeCloseDatabase();

  const hasCorruptionSignal = isCorruptionError(err);
  const hasWasmAbortSignal = isWasmAbortError(err);
  if (!(retryAfterCorruption && (hasCorruptionSignal || hasWasmAbortSignal))) {
    return null; // Signal that we didn't handle it
  }

  const recoveryReason: 'corruption' | 'wasm-abort' = hasCorruptionSignal
    ? 'corruption'
    : 'wasm-abort';

  try {
    await attemptCorruptionRecovery(context, recoveryReason);
    return await initializeMainDatabaseInternal(false);
  } catch (resetErr) {
    recordInitializationFailure('runtime-corruption-recovery', resetErr);
    logger.error('Auto-recovery failed', {
      context,
      recoveryReason,
      error: getErrorDetails(resetErr),
      originalError: getErrorDetails(err),
    });
    throw new Error(
      `Database initialization failed during ${context} and auto-recovery failed. Please manually delete the BrainStrike data folder and restart the app.`
    );
  }
}

/**
 * Initialize the database with NodeFS
 * Creates the directory if it doesn't exist and runs migrations.
 * If corruption is detected, automatically resets and retries once.
 */
// biome-ignore lint/suspicious/noExplicitAny: PGlite type is not available at compile time due to dynamic import
async function initializeMainDatabaseInternal(retryAfterCorruption = true): Promise<any> {
  if (db) {
    return db;
  }

  initializationAttemptCount += 1;
  lastInitializationStartedAt = new Date().toISOString();
  const dataDir = getDatabasePath();
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
    logger.info(`Created database directory: ${dataDir}`);
  }

  let loadedPGlite: Awaited<ReturnType<typeof getPGlite>> | null = null;

  try {
    loadedPGlite = await getPGlite();
  } catch (err) {
    recordInitializationFailure('load-extensions', err);
    logger.error('Failed to load required PGlite modules', {
      dataDir,
      appDataDir: getAppDataPath(),
      failure: lastInitializationFailure,
    });
    throw err instanceof Error ? err : new Error(getErrorDetails(err).message);
  }

  // Initialize PGlite with filesystem path (Node.js mode) and required pgvector extension
  try {
    if (!loadedPGlite) {
      throw new Error('PGlite modules were not loaded');
    }
    db = await createVectorDatabase(
      loadedPGlite.PGlite,
      dataDir,
      loadedPGlite.vector,
      loadedPGlite.live
    );
    logger.info('Database initialized with pgvector extension at:', dataDir);
  } catch (err) {
    recordInitializationFailure('open-database', err);
    const recovered = await handleCorruptionError(err, 'initialization', retryAfterCorruption);
    if (recovered) {
      return recovered;
    }

    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Failed to initialize database with pgvector', {
      dataDir,
      appDataDir: getAppDataPath(),
      failure: lastInitializationFailure,
    });
    throw new Error(`pgvector extension is required and failed to initialize via PGlite: ${msg}.`);
  }

  // Run migrations
  try {
    if (!loadedPGlite) {
      throw new Error('Database migration function is unavailable');
    }
    await loadedPGlite.migrate(db);
  } catch (err) {
    recordInitializationFailure('migration', err);
    const recovered = await handleCorruptionError(err, 'migration', retryAfterCorruption);
    if (recovered) {
      return recovered;
    }

    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Database migrations failed', {
      dataDir,
      appDataDir: getAppDataPath(),
      failure: lastInitializationFailure,
    });
    throw new Error(`Database migrations failed with pgvector: ${msg}`);
  }

  recordInitializationSuccess();
  logger.info(`Database initialized successfully at: ${dataDir}`);
  return db;
}

/**
 * Initialize the database once per process lifecycle event loop.
 * Concurrent callers share a single in-flight initialization.
 */
// biome-ignore lint/suspicious/noExplicitAny: PGlite type is not available at compile time due to dynamic import
export async function initializeMainDatabase(retryAfterCorruption = true): Promise<any> {
  if (db) {
    return db;
  }

  if (dbInitializationPromise) {
    return await dbInitializationPromise;
  }

  dbInitializationPromise = initializeMainDatabaseInternal(retryAfterCorruption);

  try {
    return await dbInitializationPromise;
  } finally {
    dbInitializationPromise = null;
  }
}

/**
 * Get the database instance
 * Automatically initializes if not already done (lazy loading)
 */
// biome-ignore lint/suspicious/noExplicitAny: PGlite type is not available at compile time due to dynamic import
export async function getDatabase(): Promise<any> {
  if (!db) {
    logger.info('🚀 Lazy-loading database (triggered by IPC usage)');
    await initializeMainDatabase();
  }
  return db;
}

/**
 * Close the database connection
 */
export async function closeDatabase(): Promise<void> {
  if (db) {
    await db.close();
    db = null;
    logger.info('Database connection closed');
  }
}

// biome-ignore lint/suspicious/noExplicitAny: PGlite type is not available at compile time due to dynamic import
export async function reinitializeDatabase(): Promise<any> {
  await closeDatabase();
  return await initializeMainDatabase();
}

/**
 * Handle runtime corruption detected during query execution.
 * Resets the database and reinitializes, returning the new database instance.
 * This is meant to be called from IPC handlers when they catch corruption errors.
 */
// biome-ignore lint/suspicious/noExplicitAny: PGlite type is not available at compile time
export async function handleRuntimeCorruption(context: string): Promise<any> {
  runtimeCorruptionRecoveryCount += 1;
  lastRuntimeCorruptionAt = new Date().toISOString();
  lastRuntimeCorruptionContext = context;
  logger.warn(`Runtime corruption detected during ${context}. Resetting database...`);
  await safeCloseDatabase();
  await resetLocalDatabase();
  logger.info('Database reset complete after runtime corruption. Reinitializing...');
  return await initializeMainDatabase(false);
}

/**
 * Reset local database by removing the entire app data directory and closing any open connection.
 * This deletes both the pgdata folder AND the parent BrainStrike/BrainStrike-dev folder
 * to ensure a complete clean slate, including any lock files or corrupted state.
 * Next access will lazily recreate and migrate from scratch.
 */
export async function resetLocalDatabase(): Promise<void> {
  // Ensure any existing handle is closed
  try {
    await closeDatabase();
  } catch {
    // ignore
  }

  const appDataDir = getAppDataPath();
  const dataDir = getDatabasePath();
  let backupDir: string | null = null;

  try {
    backupDir = createResetBackup(appDataDir);
    if (backupDir) {
      logger.warn(`Created database backup before reset: ${backupDir}`);
    }
  } catch (err) {
    logger.error('Failed to backup app data directory before reset', {
      appDataDir,
      error: getErrorDetails(err),
    });
    throw err;
  }

  // Delete the entire app data directory (parent folder) for a complete reset
  try {
    rmSync(appDataDir, { recursive: true, force: true });
    logger.info(`Removed app data directory: ${appDataDir}`);
  } catch (err) {
    logger.error('Failed to remove app data directory:', err);
    throw err;
  }

  // Recreate empty pgdata dir to avoid first-run permission flakiness
  try {
    mkdirSync(dataDir, { recursive: true });
    logger.info(`Recreated database directory: ${dataDir}`);
  } catch (err) {
    logger.error('Failed to recreate database directory:', err);
    throw err;
  }
}
