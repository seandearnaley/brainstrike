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
 * Initialize the database with NodeFS
 * Creates the directory if it doesn't exist and runs migrations
 */
// biome-ignore lint/suspicious/noExplicitAny: PGlite type is not available at compile time due to dynamic import
export async function initializeMainDatabase(): Promise<any> {
  if (db) {
    return db;
  }

  const dataDir = getDatabasePath();
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
    logger.info(`Created database directory: ${dataDir}`);
  }
  // Get ESM modules
  const { PGlite, migrate, vector, live } = await getPGlite();

  // Initialize PGlite with filesystem path (Node.js mode) and required pgvector extension
  try {
    db = await createVectorDatabase(PGlite, dataDir, vector, live);
    logger.info('Database initialized with pgvector extension at:', dataDir);
  } catch (err) {
    try {
      // Safely close if allocated
      if (db && typeof db.close === 'function') {
        await db.close();
      }
    } catch {
      // ignore
    } finally {
      db = null;
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Failed to initialize database with pgvector:', msg);
    throw new Error(`pgvector extension is required and failed to initialize via PGlite: ${msg}.`);
  }

  // Run migrations
  try {
    await migrate(db);
  } catch (err) {
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
 * Reset local database by removing the on-disk cluster and closing any open connection.
 * Next access will lazily recreate and migrate from scratch.
 */
export async function resetLocalDatabase(): Promise<void> {
  // Ensure any existing handle is closed
  try {
    await closeDatabase();
  } catch {
    // ignore
  }

  const dataDir = getDatabasePath();
  try {
    rmSync(dataDir, { recursive: true, force: true });
    logger.info(`Removed database directory: ${dataDir}`);
  } catch (err) {
    logger.error('Failed to remove database directory:', err);
    throw err;
  }

  // Recreate empty dir to avoid first-run permission flakiness
  try {
    mkdirSync(dataDir, { recursive: true });
    logger.info(`Recreated database directory: ${dataDir}`);
  } catch (err) {
    logger.error('Failed to recreate database directory:', err);
    throw err;
  }
}
