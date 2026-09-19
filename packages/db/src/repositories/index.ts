export * from './assistant-history-repository.js';
export * from './delegated-continuation-repository.js';
export * from './delegated-conversation-insights.js';
// Interfaces

// Re-export preset types from @brainstrike/types for convenience
export type {
  CreateViewFilterPresetInput,
  UpdateViewFilterPresetInput,
  ViewFilterPreset,
} from '@brainstrike/types';
// The shared dimension constants live in the underscore-private _shared
// module; this barrel is their ONLY public route (BST-990 root-API drift —
// the root index previously exported the private module directly).
export { DEFAULT_EMBEDDING_DIMENSION, MAX_EMBEDDING_DIMENSION } from './_shared.js';
export {
  type AssistantRunErrorDatabase,
  AssistantRunErrorRepository,
  AssistantRunErrorStorageError,
  type AssistantRunErrorStorageOperation,
} from './assistant-run-error-repository.js';
// Base class
export { BaseFileRecordRepository } from './base-repository.js';
export {
  type CreateDelegatedChild,
  type CreateDelegatedInvocation,
  createDelegatedConversationRepository,
  type DelegatedConversationColor,
  type DelegatedConversationDatabase,
  DelegatedConversationIdentityError,
  type DelegatedConversationNode,
  type DelegatedConversationRepository,
  type DelegatedConversationScope,
  type DelegatedInvocation,
  type DelegatedInvocationKey,
} from './delegated-conversation-repository.js';
export {
  DIAGNOSTIC_EVENTS_PURGE_LIMIT,
  DIAGNOSTIC_RETENTION_MAX_AGE_MS,
  DIAGNOSTIC_RETENTION_MAX_ROWS,
  type DiagnosticEventRow,
  type DiagnosticEventsDatabase,
  type DiagnosticEventsOperation,
  type DiagnosticEventsQueryFilter,
  DiagnosticEventsRepository,
  DiagnosticEventsStorageError,
  type DiagnosticFingerprintGroup,
  mapDiagnosticEventRow,
} from './diagnostic-events-repository.js';
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
export { EmbeddingSetsRepository } from './embedding-sets-repository.js';
export type {
  EmbeddingSpaceListing,
  EmbeddingSpaceStats,
  ListEmbeddingSpacesOptions,
} from './embedding-space-listing.js';
export {
  type FileChunkDatabase,
  type FileChunkQueryTx,
  FileChunkRepository,
} from './file-chunk-repository.js';
export { FileRecordRepository } from './file-record-repository.js';
export {
  type FileSymbolInsert,
  type FileSymbolKind,
  type FileSymbolRefInsert,
  type FileSymbolRefKind,
  FileSymbolRepository,
} from './file-symbol-repository.js';
export type {
  IDatabase,
  IEmbeddingSetsRepository,
  IFileChunkRepository,
  IFileRecordRepository,
  IViewFilterPresetsRepository,
} from './interfaces.js';
export {
  type CreateMcpTaskInput,
  MAX_ACTIVE_MCP_TASKS_PER_SCOPE,
  MCP_TASK_METADATA_MAX_BYTES,
  type McpTaskAuthorityInput,
  type McpTaskAuthorityLease,
  type McpTaskBlockedDiagnostic,
  type McpTaskDatabase,
  type McpTaskIdentity,
  McpTaskMetadataTooLargeError,
  type McpTaskRecord,
  McpTaskRepository,
  type McpTaskScope,
  type McpTaskStatus,
  type UpdateMcpTaskInput,
} from './mcp-task-repository.js';
export {
  type PromptItemDatabase,
  PromptItemRepository,
} from './prompt-item-repository.js';
// Factory functions
export { createFileRecordRepository, isPGlite } from './repository-factory.js';
export {
  readThreadDebugSnapshot,
  type ThreadDebugDatabase,
  type ThreadDebugSnapshot,
} from './thread-debug-snapshot.js';
export { ThreadSearchRepository } from './thread-search-repository.js';
export {
  type PurgeExpiredToolOutputArtifactsOptions,
  type ReadToolOutputArtifactRangeInput,
  type StoreToolOutputArtifactInput,
  TOOL_OUTPUT_ARTIFACT_RETENTION_MS,
  type ToolOutputArtifactDatabase,
  type ToolOutputArtifactRangeResult,
  ToolOutputArtifactRepository,
  type ToolOutputArtifactRepositoryOptions,
  ToolOutputArtifactStorageError,
  type ToolOutputArtifactStorageOperation,
} from './tool-output-artifact-repository.js';
