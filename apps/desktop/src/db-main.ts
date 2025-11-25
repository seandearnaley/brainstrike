import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createLogger } from '@brainstrike/utils';
import { app } from 'electron';

const logger = createLogger('DatabaseMain');

type ExtensionModuleShape = {
  default?: unknown;
  vector?: unknown;
  live?: unknown;
};

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

function getErrorDetails(error: unknown) {
  if (error instanceof Error) {
    return {
      message: error.message,
      stack: error.stack,
      name: error.name,
    };
  }
  if (error === null || error === undefined) {
    return {
      message: 'unknown error',
      stack: undefined,
      name: undefined,
    };
  }
  return {
    message: String(error),
    stack: undefined,
    name: undefined,
  };
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

/**
 * Check if an error indicates database corruption that requires a full reset
 */
export function isCorruptionError(error: unknown): boolean {
  if (!error) return false;

  const errorObj = error as { code?: string; message?: string };
  const code = errorObj.code;
  const message = errorObj.message ?? String(error);

  if (code && CORRUPTION_ERROR_CODES.includes(code as (typeof CORRUPTION_ERROR_CODES)[number])) {
    return true;
  }

  const lowerMessage = message.toLowerCase();
  return CORRUPTION_ERROR_PATTERNS.some((pattern) => lowerMessage.includes(pattern.toLowerCase()));
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
async function attemptCorruptionRecovery(context: string): Promise<void> {
  logger.warn(`Database corruption detected during ${context}. Attempting auto-recovery...`);
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

  if (!retryAfterCorruption || !isCorruptionError(err)) {
    return null; // Signal that we didn't handle it
  }

  try {
    await attemptCorruptionRecovery(context);
    return await initializeMainDatabase(false);
  } catch (resetErr) {
    logger.error('Auto-recovery failed:', resetErr);
    throw new Error(
      `Database corruption detected during ${context} and auto-recovery failed. Please manually delete the BrainStrike data folder and restart the app.`
    );
  }
}

/**
 * Initialize the database with NodeFS
 * Creates the directory if it doesn't exist and runs migrations.
 * If corruption is detected, automatically resets and retries once.
 */
// biome-ignore lint/suspicious/noExplicitAny: PGlite type is not available at compile time due to dynamic import
export async function initializeMainDatabase(retryAfterCorruption = true): Promise<any> {
  if (db) {
    return db;
  }

  const dataDir = getDatabasePath();
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
    logger.info(`Created database directory: ${dataDir}`);
  }

  const { PGlite, migrate, vector, live } = await getPGlite();

  // Initialize PGlite with filesystem path (Node.js mode) and required pgvector extension
  try {
    db = await createVectorDatabase(PGlite, dataDir, vector, live);
    logger.info('Database initialized with pgvector extension at:', dataDir);
  } catch (err) {
    const recovered = await handleCorruptionError(err, 'initialization', retryAfterCorruption);
    if (recovered) return recovered;

    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Failed to initialize database with pgvector:', msg);
    throw new Error(`pgvector extension is required and failed to initialize via PGlite: ${msg}.`);
  }

  // Run migrations
  try {
    await migrate(db);
  } catch (err) {
    const recovered = await handleCorruptionError(err, 'migration', retryAfterCorruption);
    if (recovered) return recovered;

    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Database migrations failed:', msg);
    throw new Error(`Database migrations failed with pgvector: ${msg}`);
  }

  logger.info(`Database initialized successfully at: ${dataDir}`);
  return db;
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
