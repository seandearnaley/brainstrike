import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createLogger } from '@brainstrike/utils';
import { app } from 'electron';

const logger = createLogger('DatabaseMain');

// Dynamic imports for ESM packages
const getPGlite = async (opts?: { disableVector?: boolean }) => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { migrate } = await import('@brainstrike/db');
  // Try to load pgvector extension
  let vector = null;
  try {
    const disableVector = process.env['DISABLE_VECTOR_EXTENSION'] === 'true' || opts?.disableVector;
    if (disableVector) {
      throw new Error('pgvector extension disabled via environment');
    }
    // Use dynamic import with type assertion to bypass TypeScript module resolution issues
    // biome-ignore lint/suspicious/noExplicitAny: Dynamic import of optional extension
    const vectorModule = await import('@electric-sql/pglite/vector' as any);
    vector = vectorModule.vector;
    logger.info('pgvector extension loaded successfully');
  } catch (err) {
    const details = {
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
      name: err instanceof Error ? err.name : undefined,
    };
    logger.error('pgvector extension failed to load. Error details:', details);
    // Deterministic behavior: do not fallback. Desktop requires pgvector.
    throw new Error(
      `pgvector extension is required and failed to load. Ensure @electric-sql/pglite/vector is available. (${details.message})`
    );
  }

  return { PGlite, migrate, vector };
};

// Database instance for main process
// biome-ignore lint/suspicious/noExplicitAny: PGlite type is not available at compile time due to dynamic import
let db: any = null;

// Helper to create and validate a PGlite instance with pgvector
async function createVectorDatabase(PGliteCtor: unknown, dataDir: string, vector: unknown) {
  // biome-ignore lint/suspicious/noExplicitAny: PGlite ctor type not available at compile time
  const Ctor: any = PGliteCtor as any;
  // biome-ignore lint/suspicious/noExplicitAny: PGlite instance type not available at compile time
  const instance: any = new Ctor({
    dataDir,
    // biome-ignore lint/suspicious/noExplicitAny: PGlite vector extension type not available at compile time
    extensions: { vector: vector as any },
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
  const isProduction = process.env['NODE_ENV'] === 'production';
  const dbDirName = isProduction ? 'BrainStrike' : 'BrainStrike-dev';
  return path.join(app.getPath('documents'), dbDirName, 'pgdata');
}

/**
 * Initialize the database with NodeFS
 * Creates the directory if it doesn't exist and runs migrations
 */
// biome-ignore lint/suspicious/noExplicitAny: PGlite type is not available at compile time due to dynamic import
export async function initializeMainDatabase(options?: { disableVector?: boolean }): Promise<any> {
  if (db) {
    return db;
  }

  const dataDir = getDatabasePath();
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
    logger.info(`Created database directory: ${dataDir}`);
  }
  // Get ESM modules
  const { PGlite, migrate, vector } = await getPGlite(
    options?.disableVector ? { disableVector: true } : undefined
  );

  // Initialize PGlite with filesystem path (Node.js mode) and required pgvector extension
  try {
    db = await createVectorDatabase(PGlite, dataDir, vector);
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
    throw new Error(
      `Failed to initialize PGlite with pgvector: ${msg}. pgvector is mandatory for desktop.`
    );
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
export async function reinitializeDatabase(options?: { disableVector?: boolean }): Promise<any> {
  await closeDatabase();
  return await initializeMainDatabase(options);
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
