// Drizzle ORM implementations (unified for both Web and Electron)

// Legacy PGlite-based implementations (kept for backward compatibility with tests)
export { BaseFileRecordRepository } from './base-repository.js';
export {
  DrizzleEmbeddingSetsRepository,
  DrizzleFileChunkRepository,
  DrizzleFileRecordRepository,
  DrizzleTokenCacheStore,
  type TokenCacheEntry,
  type TokenCacheStats,
  type TokenCountingMode,
} from './drizzle/index.js';
export { EmbeddingSetsRepository } from './embedding-sets-repository.js';
export { FileChunkRepository } from './file-chunk-repository.js';
export { FileRecordRepository } from './file-record-repository.js';
// Interfaces
export type {
  IDatabase,
  IEmbeddingSetsRepository,
  IFileRecordRepository,
} from './interfaces.js';
// Factory functions (kept for backward compatibility with tests)
export { createFileRecordRepository, isPGlite } from './repository-factory.js';
