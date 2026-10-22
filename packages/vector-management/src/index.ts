// Main components

// Shared collection select base component
export type {
  CollectionSelectProps,
  CollectionSelectSize,
  CollectionWithDocCount,
  EmbeddingSetEventCollection,
  EmbeddingSetUpdatedEventDetail,
} from './collection-select/index.js';
export {
  CollectionSelect,
  canonicalizeCollectionTimestamps,
  dispatchEmbeddingSetUpdated,
  fetchCollectionsSnapshot,
  formatCollectionLabel,
  toCanonicalTimestamp,
  useCollections,
} from './collection-select/index.js';
// Embedding set management
export * from './embedding-set-management';
export { IndexingActivityCoordinator } from './indexing-activity-coordinator';
// Shared search embedder resolution + device-loss recovery
export type {
  EmbedderRuntime,
  EmbeddingSetModelInfo,
  LocalSearchEmbedderFactory,
  SearchEmbedder,
  UseSearchEmbedderResult,
} from './search-embedder/index.js';
export {
  SearchEmbedderProvider,
  useSearchEmbedder,
  useSharedSearchEmbedder,
} from './search-embedder/index.js';
// Vector preferences
export * from './vector-preferences';
// Status extension keys the embedding host runtime reports through the shared runtime store
export const EMBEDDING_RUNTIME_STATUS_EXTENSION_KEYS: readonly string[] = ['embeddingRuntime'];
