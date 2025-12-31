// Interfaces

// Base class
export { BaseFileRecordRepository } from './base-repository.js';
// Drizzle ORM implementations
export {
  DrizzleEmbeddingSetsRepository,
  DrizzleFileChunkRepository,
  DrizzleFileRecordRepository,
  DrizzleTokenCacheStore,
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
export { EmbeddingSetsRepository } from './embedding-sets-repository.js';
export { FileChunkRepository } from './file-chunk-repository.js';
export { FileRecordRepository } from './file-record-repository.js';
export type {
  IDatabase,
  IEmbeddingSetsRepository,
  IFileRecordRepository,
} from './interfaces.js';

// Factory functions
export { createFileRecordRepository, isPGlite } from './repository-factory.js';
