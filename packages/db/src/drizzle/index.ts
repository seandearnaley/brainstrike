/**
 * Drizzle ORM Module
 *
 * This module provides Drizzle ORM utilities and exports all Drizzle-based
 * repositories for type-safe database operations.
 */

// Drizzle repositories (re-exported for convenience)
export { DrizzleEmbeddingSetsRepository } from '../repositories/drizzle/embedding-sets-repository.js';
export { DrizzleFileChunkRepository } from '../repositories/drizzle/file-chunk-repository.js';
export { DrizzleFileRecordRepository } from '../repositories/drizzle/file-record-repository.js';
export {
  DrizzleTokenCacheStore,
  type TokenCacheEntry,
  type TokenCacheStats,
  type TokenCountingMode,
} from '../repositories/drizzle/token-cache-store.js';
// Database utilities
export {
  type DrizzleDb,
  drizzle,
  drizzleFromHandle,
  extractDbExecutionClient,
  extractPGlite,
  hasDbExecutionClientRaw,
  hasPGliteRaw,
} from './database.js';
// Migration utilities
export { runMigrations } from './migrate.js';
