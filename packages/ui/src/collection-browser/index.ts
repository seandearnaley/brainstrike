/**
 * Collection inspection module
 *
 * What survives the retired Collection Browser tree (BST-1213): the node
 * inspector, the semantic-search tuning panel, and the shared search
 * config/result contract used by the db-explorer executor.
 */

export type { NodeInspectorProps } from './node-inspector';
export { NodeInspector } from './node-inspector';
// Semantic search components
export {
  clampResultLimit,
  RESULT_LIMIT_LARGE,
  RESULT_LIMIT_MAX,
  RESULT_LIMIT_MIN,
} from './search-config-bounds';
export { SearchConfigPanel } from './search-config-panel';
// Types
export type {
  BrowserNodeData,
  ChunkData,
  CollectionData,
  DistanceMetric,
  EmbeddingData,
  EmbeddingStatus,
  EmbeddingStatusConfig,
  FileData,
  NodeTypeConfig,
  RetrievalMode,
  SearchConfig,
  SearchConfigPanelProps,
  SemanticSearchResult,
} from './types';
export { DEFAULT_SEARCH_CONFIG, EMBEDDING_STATUS_CONFIG, NODE_TYPE_CONFIG } from './types';
