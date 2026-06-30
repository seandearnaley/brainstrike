// Provider and utilities

export {
  type ChunkingPresetDefinition,
  type ChunkingPresetId,
  type ChunkingPresetSelection,
  type ChunkingStrategy,
  getChunkingPreset,
  getChunkingPresetDefinitions,
  type ResolvedChunkingStrategy,
  resolveChunkingStrategyForFile,
} from '@brainstrike/indexing-contract';
export * from './architecture/brainstrike-db-client-contract.js';
export * from './architecture/db-migration-authority.js';
export * from './architecture/db-runtime-baseline.js';
export * from './architecture/db-runtime-selection.js';
export * from './atomic-transaction.js';
export * from './bootstrap/bootstrap-capability-probe.js';
export * from './bootstrap/profile-bootstrap-report.js';
export * from './browser-pglite-storage.js';
export * from './browser-pglite-storage-benchmark.js';
export {
  type InsertChunksAndEnqueueEmbeddingJobsArgs,
  insertChunksAndEnqueueEmbeddingJobs,
  insertTursoChunksAndEnqueueEmbeddingJobs,
} from './chunk-embedding-job-batch.js';
// Configuration
export { CHUNKING_CONFIG } from './config/chunking-config.js';
export * from './database-pressure-controller.js';
export * from './database-work-scheduler.js';
export * from './db-provider.js';
// Drizzle ORM utilities and database wrapper
export {
  type DrizzleDb,
  drizzle,
  drizzleFromHandle,
  extractDbExecutionClient,
  extractPGlite,
  hasDbExecutionClientRaw,
  hasPGliteRaw,
  runMigrations as runDrizzleMigrations,
} from './drizzle/index.js';
export {
  type ApplyManagedCacheBatchArgs,
  type ApplyManagedCacheInvalidationsArgs,
  applyManagedCacheBatch,
  applyTursoManagedCacheBatch,
  invalidateManagedCacheEntriesByIdentity,
  invalidateTursoManagedCacheEntriesByIdentity,
  type ManagedCacheBatchMutation,
  type ManagedCacheInvalidationResult,
  type ManagedCacheInvalidationTarget,
  parseManagedCacheBatchArgs,
} from './managed-cache/index.js';
// Legacy migration export
export * from './migrations/bootstrap.js';
export {
  createDimensionIndex,
  dropDimensionIndex,
  hnswParams,
  resumeDimensionIndexBuilds,
  suspendDimensionIndexBuilds,
} from './migrations/dimension-index-helpers.js';
export type { Migration } from './migrations/index.js';
// New migration system
export { MigrationRunner, migrations } from './migrations/index.js';
export type {
  EmbeddingDistance,
  EmbeddingSet,
  EmbeddingSetSystemRole,
} from './models/embedding-set.js';
export {
  WORKSPACE_INDEX_EMBEDDING_SET_DEFAULTS,
  WORKSPACE_INDEX_SYSTEM_ROLE,
} from './models/embedding-set.js';
export type {
  ChunkSearchOptions,
  ChunkSearchResult,
  FileChunk,
  FileChunkInsert,
  FileChunkUpdate,
  // Full-text search types (BST-292)
  FTSQueryMode,
  FTSSearchOptions,
  FTSSearchResult,
} from './models/file-chunk.js';
export type {
  FileImportRequest,
  FileImportResult,
  FileRecord,
  FileRecordUpdate,
  ImportProgress,
  ManagedCacheEntryMetadata,
} from './models/file-record.js';
export type { GrepCandidate, GrepCandidateOptions } from './models/grep.js';
export { escapePGliteLiveQueryFormatPercents } from './pglite-live-query-format.js';
export type {
  CancelParams,
  ClaimParams,
  CompleteParams,
  EnqueueParams,
  FailBatchParams,
  FailParams,
  HeartbeatParams,
  Job,
  JobQueueMetricsSnapshot,
  JobQueueStateCounts,
  JobState,
  JobType,
  TursoJobQueueQueryClient,
  TursoJobQueueReadModel,
} from './queue/index.js';
// Queue
export {
  buildEmbeddingJobDedupeKey,
  createTursoJobQueueReadModel,
  EMBEDDING_JOB_NULL_SET_DEDUPE_SEGMENT,
  JobQueue,
  TursoJobQueue,
} from './queue/index.js';
export { DEFAULT_EMBEDDING_DIMENSION, MAX_EMBEDDING_DIMENSION } from './repositories/_shared.js';
export { FileChunkRepository } from './repositories/file-chunk-repository.js';
// Repository exports
export * from './repositories/index.js';
// Schema types for embedding cache (BST-170)
// Schema types for view filter presets
export type {
  EmbeddingCacheEntry,
  Model,
  NewEmbeddingCacheEntry,
  NewModel,
  NewProvider,
  NewViewFilterPreset,
  Provider,
  ViewFilterPreset,
} from './schema/index.js';
// Schema table for view filter presets (needed for live queries)
export { viewFilterPresets } from './schema/index.js';
// Search utilities (RRF fusion for hybrid search)
export * from './search/index.js';
export {
  ACTIVE_COLLECTION_LIVE_COUNTS_QUERY,
  type CollectionIndexingStats,
  getCollectionIndexingStats,
  markCollectionIndexingStatsDirty,
  refreshCollectionIndexingStats,
} from './services/collection-indexing-stats.js';
export {
  type DimensionIndexMaintenanceClockOptions,
  type DimensionIndexMaintenanceRow,
  type DimensionIndexMaintenanceSkipReason,
  type DimensionIndexMaintenanceState,
  type DimensionIndexMaintenanceStatus,
  type DimensionIndexMaintenanceStrategy,
  type DimensionIndexSuspensionRow,
  listDimensionIndexMaintenance,
  listDimensionIndexSuspensions,
  type RequestDimensionIndexMaintenanceInput,
  type RunDimensionIndexMaintenanceOptions,
  type RunDimensionIndexMaintenanceResult,
  reconcileSuspendedDimensionIndexMaintenance,
  requestDimensionIndexMaintenance,
  runNextDimensionIndexMaintenance,
} from './services/dimension-index-maintenance.js';
export {
  DEFAULT_DATABASE_MAINTENANCE_ANALYZE_TABLES,
  DEFAULT_DATABASE_MAINTENANCE_INTERVAL_MS,
  DEFAULT_DATABASE_MAINTENANCE_TERMINAL_JOB_RETENTION_MS,
  DEFAULT_DATABASE_MAINTENANCE_VACUUM_TABLES,
  runScheduledDatabaseMaintenance,
  runTursoScheduledDatabaseMaintenance,
  type ScheduledDatabaseMaintenanceOptions,
  type ScheduledDatabaseMaintenanceResult,
  type ScheduledDatabaseMaintenanceSkipReason,
  type ScheduledDatabaseMaintenanceStatus,
} from './services/scheduled-database-maintenance.js';
export { createTursoOwnerClient, type TursoOwnerClient } from './turso/owner-client.js';
export { applyTursoSchemaBaseline } from './turso/schema-baseline.js';
export * from './use-drizzle-live-query.js';
export * from './use-live-query.js';
export * from './wasm-loader.js';
