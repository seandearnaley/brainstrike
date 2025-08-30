import { existsSync, mkdirSync } from 'node:fs';
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
      throw new Error('Vector extension disabled via environment');
    }
    // Use dynamic import with function wrapper to bypass TypeScript module resolution
    const dynamicImport = new Function('modulePath', 'return import(modulePath)');
    const vectorModule = await dynamicImport('@electric-sql/pglite/vector');
    vector = vectorModule.vector;
    logger.info('pgvector extension loaded successfully');
  } catch (err) {
    logger.error('pgvector extension failed to load. Error details:', {
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
      name: err instanceof Error ? err.name : undefined,
    });
    logger.warn('Falling back to basic PGlite without vector extension');
  }

  return { PGlite, migrate, vector };
};

// Database instance for main process
// biome-ignore lint/suspicious/noExplicitAny: PGlite type is not available at compile time due to dynamic import
let db: any = null;

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

  // Initialize PGlite with filesystem path (Node.js mode)
  // Prefer vector if available, but fall back cleanly if initialization fails
  if (vector) {
    try {
      db = new PGlite({
        dataDir,
        // biome-ignore lint/suspicious/noExplicitAny: PGlite vector extension type not available at compile time
        extensions: { vector: vector as any },
      });
      // Quick smoke query to force-load and validate the backend
      await db.query('SELECT 1');
      logger.info('Database initialized with pgvector extension at:', dataDir);
    } catch (err) {
      logger.warn('pgvector initialization failed; falling back to non-vector PGlite. Error:', err);
      db = new PGlite({ dataDir });
      // Validate basic connectivity
      await db.query('SELECT 1');
      logger.info('Database initialized without pgvector extension at:', dataDir);
    }
  } else {
    db = new PGlite({ dataDir });
    await db.query('SELECT 1');
    logger.info('Database initialized without pgvector extension at:', dataDir);
  }

  // Run migrations
  await migrate(db);

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
