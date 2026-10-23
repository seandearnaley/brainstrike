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
// Status extension keys the embedding host runtime reports through the shared runtime store
export const EMBEDDING_RUNTIME_STATUS_EXTENSION_KEYS: readonly string[] = ['embeddingRuntime'];
