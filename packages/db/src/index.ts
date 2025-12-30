// Provider and utilities

// Configuration
export { CHUNKING_CONFIG } from './config/chunking-config.js';
export * from './db-provider.js';

// Drizzle ORM utilities and database wrapper
export {
  type DrizzleDb,
  drizzle,
  drizzleFromHandle,
  extractPGlite,
  hasPGliteRaw,
  runMigrations as runDrizzleMigrations,
} from './drizzle/index.js';

// Legacy migration export
export * from './migrations/bootstrap.js';
export type { Migration } from './migrations/index.js';
// New migration system
export { MigrationRunner, migrations } from './migrations/index.js';
export type { EmbeddingDistance, EmbeddingSet } from './models/embedding-set.js';
export type {
  ChunkSearchOptions,
  ChunkSearchResult,
  FileChunk,
  FileChunkInsert,
  FileChunkUpdate,
} from './models/file-chunk.js';
export type {
  FileImportRequest,
  FileImportResult,
  FileRecord,
  ImportProgress,
} from './models/file-record.js';
export type { Job, JobState, JobType } from './queue/job-queue.js';
// Queue
export { JobQueue } from './queue/job-queue.js';
export { DEFAULT_EMBEDDING_DIMENSION, MAX_EMBEDDING_DIMENSION } from './repositories/_shared.js';
export { FileChunkRepository } from './repositories/file-chunk-repository.js';
// Repository exports
export * from './repositories/index.js';
export type {
  ChunkingOptions,
  ChunkingResult,
  ChunkingStrategy,
} from './services/chunking-service.js';
export { ChunkingService } from './services/chunking-service.js';
export * from './use-live-query.js';
export * from './wasm-loader.js';
