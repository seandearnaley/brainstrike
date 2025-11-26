/**
 * Collection Browser Module
 *
 * Components for the unified hierarchical collection browser that provides
 * a tree-based view of collections, files, chunks, and embeddings.
 */

// Re-export tree-table types for convenience
export type { SortDirection, SortState } from '../tree-table/types';

// Sub-components
export type { BulkAction, BulkActionBarProps } from './bulk-action-bar';
export { BulkActionBar, DEFAULT_BULK_ACTIONS } from './bulk-action-bar';
export type { CollectionBrowserProps } from './collection-browser';
// Main component
export { CollectionBrowser } from './collection-browser';
export { FilterBar } from './filter-bar';
export { FilterChip } from './filter-chip';
export type { NodeInspectorProps } from './node-inspector';
export { NodeInspector } from './node-inspector';
// Semantic search components
export { SearchConfigPanel } from './search-config-panel';
export { SearchModeBar } from './search-mode-bar';
// Types
export type {
  BrowserNodeData,
  ChunkData,
  CollectionBrowserFilters,
  CollectionData,
  CollectionNodeType,
  CollectionTreeNode,
  DistanceMetric,
  EmbeddingData,
  EmbeddingStatus,
  EmbeddingStatusConfig,
  FileData,
  FilterBarProps,
  FilterChipProps,
  NodeTypeConfig,
  SearchConfig,
  SearchConfigPanelProps,
  SearchMode,
  SearchModeBarProps,
  SemanticSearchResult,
} from './types';
export {
  DEFAULT_FILTERS,
  DEFAULT_SEARCH_CONFIG,
  EMBEDDING_STATUS_CONFIG,
  NODE_TYPE_CONFIG,
} from './types';
export type {
  CollectionSortDirection,
  CollectionSortKey,
  CollectionSortState,
  CollectionTreeInput,
  UseCollectionTreeOptions,
  UseCollectionTreeResult,
} from './use-collection-tree';
// Hooks
export { useCollectionTree } from './use-collection-tree';
