/**
 * Drizzle-based Repository Exports
 *
 * This module exports Drizzle ORM versions of repositories.
 * These provide type-safe database operations using the Drizzle query builder.
 */

export type {
  BatchLookupRequest,
  BatchLookupResult,
  EmbeddingCacheLookupResult,
  EmbeddingCacheStats,
} from './embedding-cache-repository.js';
export { DrizzleEmbeddingCacheRepository } from './embedding-cache-repository.js';
export { DrizzleEmbeddingSetsRepository } from './embedding-sets-repository.js';
export { DrizzleFileChunkRepository } from './file-chunk-repository.js';
export { DrizzleFileRecordRepository } from './file-record-repository.js';
export type {
  TokenCacheEntry,
  TokenCacheStats,
  TokenCountingMode,
} from './token-cache-store.js';
export { DrizzleTokenCacheStore } from './token-cache-store.js';
