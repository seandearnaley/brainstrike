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
  EmbeddingCacheMetrics,
  EmbeddingCacheStats,
} from './embedding-cache-repository.js';
export {
  DrizzleEmbeddingCacheRepository,
  MAX_BATCH_SIZE,
  RECOMMENDED_MAX_CACHE_ENTRIES,
} from './embedding-cache-repository.js';
export { DrizzleEmbeddingSetsRepository } from './embedding-sets-repository.js';
export { DrizzleFileChunkRepository, MAX_SEARCH_RESULT_LIMIT } from './file-chunk-repository.js';
export { DrizzleFileRecordRepository } from './file-record-repository.js';
export type {
  TokenCacheEntry,
  TokenCacheStats,
  TokenCountingMode,
} from './token-cache-store.js';
export { DrizzleTokenCacheStore } from './token-cache-store.js';
export { DrizzleViewFilterPresetsRepository } from './view-filter-presets-repository.js';
