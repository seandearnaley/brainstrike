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
export * from './atomic-transaction.js';
export * from './browser-pglite-storage.js';
export * from './browser-pglite-storage-benchmark.js';
export {
  type InsertChunksAndEnqueueEmbeddingJobsArgs,
  insertChunksAndEnqueueEmbeddingJobs,
} from './chunk-embedding-job-batch.js';
// Configuration
export { CHUNKING_CONFIG } from './config/chunking-config.js';
export {
  CRASH_SENSITIVE_INDEX_ACCESS_METHODS,
  type CrashSensitiveIndex,
  type CrashSensitiveIndexDb,
  type CrashSensitiveIndexRebuild,
  CrashSensitiveIndexRebuildError,
  type CrashSensitiveIndexRebuildOptions,
  type CrashSensitiveIndexRebuildResult,
  listCrashSensitiveIndexes,
  rebuildCrashSensitiveIndexes,
} from './crash-sensitive-indexes.js';
export * from './database-integrity.js';
export {
  type DiagnosedTable,
  diagnoseDatabaseIntegrity,
  type IntegrityDiagnosis,
  type IntegrityDiagnosisOptions,
  IntegrityDiagnosisStoppedError,
  type UncheckedRelation,
} from './database-integrity-diagnosis.js';
export {
  classifyFindingSeverity,
  type FindingSeverity,
  INTEGRITY_CHECKS,
  type IntegrityCheck,
  MAX_FINDING_MESSAGE_LENGTH,
  type RelationFinding,
  truncateFindingMessage,
} from './database-integrity-finding.js';
export * from './database-pressure-controller.js';
export * from './database-query-telemetry.js';
export {
  DATABASE_SNAPSHOT_METHODS,
  DATABASE_SNAPSHOT_REASONS,
  type DatabaseSnapshotManifest,
  type DatabaseSnapshotMethod,
  type DatabaseSnapshotReason,
  parseDatabaseSnapshotManifest,
} from './database-snapshot-manifest.js';
export * from './database-work-scheduler.js';
// Close-drain seams (BST-1329). Shared with apps/desktop: the idle join is the
// single implementation both surfaces use — see docs/agents/database.md
// "CLOSING a PGlite: drain first".
export {
  createLiveQueryDrainRegistry,
  createResetBarrierDatabaseWork,
  DEFAULT_DATABASE_WORK_IDLE_TIMEOUT_MS,
  type LiveQueryDrainRegistration,
  type LiveQueryDrainRegistry,
  type ResetBarrierDatabaseWork,
  waitForDatabaseWorkSchedulerIdle,
} from './db-reset-drain.js';
export * from './desktop-database-bridge.js';
// Drizzle ORM utilities and database wrapper
export {
  computeLedgerHead,
  type DrizzleDb,
  drizzle,
  drizzleFromHandle,
  extractPGlite,
  getBundledLedgerHead,
  hasPGliteRaw,
  runMigrations as runDrizzleMigrations,
} from './drizzle/index.js';
export {
  type ApplyManagedCacheBatchArgs,
  type ApplyManagedCacheInvalidationsArgs,
  applyManagedCacheBatch,
  deleteManagedRootData,
  invalidateManagedCacheEntriesByIdentity,
  type ManagedCacheBatchMutation,
  type ManagedCacheInvalidationResult,
  type ManagedCacheInvalidationTarget,
  type ManagedCachePartitionId,
  parseManagedCacheBatchArgs,
} from './managed-cache/index.js';
// Legacy migration export
export * from './migrations/bootstrap.js';
export type { Migration } from './migrations/index.js';
// New migration system
export {
  createDimensionIndex,
  dimensionIndexIsReady,
  dropDimensionIndex,
  estimateEmbeddedRowCount,
  hnswParams,
  MigrationRunner,
  migrations,
  precreateEmptyDimensionIndex,
  resolveIndexBuildMaintenanceWorkMemMb,
  resumeDimensionIndexBuilds,
  suspendDimensionIndexBuilds,
  withIndexBuildMaintenanceWorkMem,
} from './migrations/index.js';
export {
  ASSISTANT_RUN_ERRORS_TABLE,
  type AssistantRunErrorRecord,
  type RecordAssistantRunErrorInput,
} from './models/assistant-run-error.js';
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
export {
  buildPromptItemEmbeddingText,
  type CreatePromptItemInput,
  derivePromptItemTitle,
  normalizePromptItemTags,
  PROMPT_ITEM_KINDS,
  PROMPT_ITEM_USAGE_ACTIONS,
  type PromptEmbeddingProfile,
  type PromptItem,
  type PromptItemEmbeddingStatus,
  type PromptItemFilter,
  type PromptItemKind,
  type PromptItemRevision,
  type PromptItemSimilarityOptions,
  type PromptItemSimilarityResult,
  type PromptItemUsageAction,
  type StorePromptItemEmbeddingInput,
  type UpdatePromptItemInput,
} from './models/prompt-item.js';
export type {
  MarkThreadMessageEmbeddingErrorInput,
  StoreThreadMessageEmbeddingInput,
  ThreadMessageFtsMatch,
  ThreadMessageFtsOptions,
  ThreadMessagePendingEmbedding,
  ThreadMessageVectorMatch,
  ThreadMessageVectorOptions,
  ThreadSearchCoverage,
  ThreadSearchDatabase,
  ThreadSearchEmbeddingProfile,
  ThreadSearchSyncOptions,
  ThreadSearchSyncResult,
  ThreadTitleMatch,
  ThreadTitleSearchOptions,
} from './models/thread-search.js';
export { escapePGliteLiveQueryFormatPercents } from './pglite-live-query-format.js';
export type {
  CancelParams,
  ClaimedJob,
  ClaimParams,
  CompleteParams,
  EnqueueParams,
  FailBatchParams,
  FailParams,
  HeartbeatParams,
  Job,
  JobState,
  JobType,
} from './queue/index.js';
// Queue
export { JobQueue } from './queue/index.js';

// Repository exports
export * from './repositories/index.js';
export {
  auditResetTableCoverage,
  type FactoryResetOnlyTable,
  getFactoryResetOnlyTables,
  getFactoryResetTables,
  getMastraResetTables,
  getResetTables,
  type MastraResetTable,
  RESET_EXCLUDED_TABLES,
  type ResetTable,
  type ResetTableCoverageAudit,
} from './reset-table-registry.js';
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
  recoverInterruptedDimensionIndexMaintenanceAtStartup,
  requestDimensionIndexMaintenance,
  runNextDimensionIndexMaintenance,
} from './services/dimension-index-maintenance.js';
export {
  DEFAULT_DATABASE_MAINTENANCE_ANALYZE_TABLES,
  DEFAULT_DATABASE_MAINTENANCE_INTERVAL_MS,
  DEFAULT_DATABASE_MAINTENANCE_TERMINAL_JOB_RETENTION_MS,
  DEFAULT_DATABASE_MAINTENANCE_TOKEN_ESTIMATE_CALIBRATION_RETENTION_MS,
  DEFAULT_DATABASE_MAINTENANCE_TOOL_CALL_TELEMETRY_RETENTION_MS,
  DEFAULT_DATABASE_MAINTENANCE_VACUUM_TABLES,
  runScheduledDatabaseMaintenance,
  type ScheduledDatabaseMaintenanceOptions,
  type ScheduledDatabaseMaintenanceResult,
  type ScheduledDatabaseMaintenanceSkipReason,
  type ScheduledDatabaseMaintenanceStatus,
} from './services/scheduled-database-maintenance.js';
export {
  DEFAULT_SNAPSHOT_RETENTION_POLICY,
  planSnapshotRetention,
  type RetentionRule,
  type RetentionSnapshot,
  type SnapshotPrune,
  type SnapshotRetentionPlan,
  type SnapshotRetentionPolicy,
} from './snapshot-retention.js';
export {
  findTableDurability,
  getTableDurability,
  type RebuildOwner,
  TABLE_DURABILITY_CLASSES,
  TABLE_DURABILITY_REGISTRY,
  type TableDurabilityClass,
  type TableDurabilityEntry,
} from './table-durability-registry.js';
export * from './wasm-loader.js';
