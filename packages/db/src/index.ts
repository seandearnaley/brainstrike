// Provider and utilities
export * from './db-provider.js';

// Legacy migration export
export * from './migrations/bootstrap.js';
export type { Migration } from './migrations/index.js';
// New migration system
export { MigrationRunner, migrations } from './migrations/index.js';
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
export { FileChunkRepository } from './repositories/file-chunk-repository.js';
// Repository exports
export * from './repositories/index.js';
export type {
  ChunkingOptions,
  ChunkingResult,
  ChunkingStrategy,
} from './services/chunking-service.js';
export { ChunkingService } from './services/chunking-service.js';
export * from './wasm-loader.js';
