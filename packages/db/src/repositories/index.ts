// Interfaces

// Re-export preset types from @brainstrike/types for convenience
export type {
  CreateViewFilterPresetInput,
  UpdateViewFilterPresetInput,
  ViewFilterPreset,
} from '@brainstrike/types';
// Base class
export { BaseFileRecordRepository } from './base-repository.js';
// Drizzle ORM implementations
export {
  type BatchLookupRequest,
  type BatchLookupResult,
  DrizzleEmbeddingCacheRepository,
  DrizzleEmbeddingSetsRepository,
  DrizzleFileChunkRepository,
  DrizzleFileRecordRepository,
  DrizzleTokenCacheStore,
  DrizzleViewFilterPresetsRepository,
  type EmbeddingCacheLookupResult,
  type EmbeddingCacheStats,
  MAX_SEARCH_RESULT_LIMIT,
  type TokenCacheEntry,
  type TokenCacheStats,
  type TokenCountingMode,
} from './drizzle/index.js';
export { ElectronEmbeddingSetsRepository } from './electron-embedding-sets-repository.js';
// Legacy raw SQL implementations
export { ElectronFileChunkRepository } from './electron-file-chunk-repository.js';
export {
  type ElectronDbAPI,
  ElectronFileRecordRepository,
} from './electron-file-record-repository.js';
export { ElectronViewFilterPresetsRepository } from './electron-view-filter-presets-repository.js';
export {
  type CreateEmbeddingCacheRepositoryOptions,
  createEmbeddingCacheRepository,
  EmbeddingCacheRepository,
} from './embedding-cache-repository.js';
export {
  EmbeddingSetsRepository,
  type EmbeddingSpaceListing,
  type EmbeddingSpaceStats,
  type ListEmbeddingSpacesOptions,
} from './embedding-sets-repository.js';
export { FileChunkRepository } from './file-chunk-repository.js';
export { FileRecordRepository } from './file-record-repository.js';
export type {
  IDatabase,
  IEmbeddingSetsRepository,
  IFileRecordRepository,
  IViewFilterPresetsRepository,
} from './interfaces.js';

// Factory functions
export { createFileRecordRepository, isPGlite } from './repository-factory.js';
