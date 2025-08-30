import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createLogger } from '@brainstrike/utils';
import { app } from 'electron';

const logger = createLogger('DatabaseMain');

// Dynamic imports for ESM packages
const getPGlite = async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { migrate } = await import('@brainstrike/db');
  // Try to load pgvector extension
  let vector = null;
  try {
    // Dynamic import to handle module resolution differences between build configs
    const vectorModule = await import('@electric-sql/pglite/vector' as string);
    vector = (vectorModule as { vector: unknown }).vector;
    logger.info('pgvector extension loaded successfully');
  } catch (_e) {
    logger.info('pgvector extension not available, using basic PGlite');
  }

  return { PGlite, migrate, vector };
};

// Database instance for main process
// biome-ignore lint/suspicious/noExplicitAny: PGlite type is not available at compile time due to dynamic import
let db: any | null = null;

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
  const { PGlite, migrate, vector } = await getPGlite();

  // Initialize PGlite with filesystem path (Node.js mode)
  if (vector) {
    db = new PGlite({
      dataDir,
      // biome-ignore lint/suspicious/noExplicitAny: PGlite vector extension type not available at compile time
      extensions: { vector: vector as any },
    });
    logger.info('Database initialized with pgvector extension at:', dataDir);
  } else {
    db = new PGlite({
      dataDir,
    });
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
