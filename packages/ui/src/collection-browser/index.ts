/**
 * Collection Browser Module
 *
 * Components for the unified hierarchical collection browser that provides
 * a tree-based view of collections, files, chunks, and embeddings.
 */

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
// Types
export type {
  BrowserNodeData,
  ChunkData,
  CollectionBrowserFilters,
  CollectionData,
  CollectionNodeType,
  CollectionTreeNode,
  EmbeddingData,
  EmbeddingStatus,
  EmbeddingStatusConfig,
  FileData,
  FilterBarProps,
  FilterChipProps,
  NodeTypeConfig,
} from './types';
export { DEFAULT_FILTERS, EMBEDDING_STATUS_CONFIG, NODE_TYPE_CONFIG } from './types';
export type {
  CollectionTreeInput,
  UseCollectionTreeOptions,
  UseCollectionTreeResult,
} from './use-collection-tree';
// Hooks
export { useCollectionTree } from './use-collection-tree';
