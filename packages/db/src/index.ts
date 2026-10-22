/**
 * The surviving @brainstrike/db surface: plain types and pure helpers that
 * desktop code shares. The PGlite engine, its schema and its repositories
 * are gone; nothing here touches a database.
 */
export type {
  EmbeddingDistance,
  EmbeddingSet,
  EmbeddingSetSystemRole,
} from './models/embedding-set.js';
export type { FileChunk, FileChunkInsert } from './models/file-chunk.js';
export type {
  FileImportRequest,
  FileImportResult,
  FileRecord,
  ImportProgress,
} from './models/file-record.js';
export {
  THREAD_SEARCH_VECTOR_THRESHOLD,
  type ThreadSearchCoverage,
  type ThreadSearchEmbeddingProfile,
} from './models/thread-search.js';
export {
  ASSISTANT_HISTORY_HYDRATION_MESSAGE_LIMIT,
  type AssistantHistoryMessage,
  type AssistantThreadMessageListOptions,
  type AssistantThreadRunEventListOptions,
} from './repositories/assistant-history-repository.js';
export { createCollectionCatalogRepository } from './repositories/collection-catalog-repository.js';
export {
  DIAGNOSTIC_EVENTS_PURGE_LIMIT,
  type DiagnosticEventsQueryFilter,
  DiagnosticEventsRepository,
  type DiagnosticFingerprintGroup,
} from './repositories/diagnostic-events-repository.js';
export type {
  EmbeddingSpaceListing,
  EmbeddingSpaceStats,
} from './repositories/embedding-space-listing.js';
export type {
  FileSymbolInsert,
  FileSymbolRefInsert,
} from './repositories/file-symbol-repository.js';
export type { IEmbeddingSetsRepository } from './repositories/interfaces.js';
export {
  createThreadSearchService,
  type ThreadSearchExtraArms,
  type ThreadSearchResultItem,
} from './search/thread-search-service.js';
