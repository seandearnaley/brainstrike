/**
 * CollectionBrowser Types
 *
 * Type definitions for the Collection Browser component that provides
 * a unified hierarchical view of collections, files, chunks, and embeddings.
 */

import type * as React from 'react';
import type { TreeNode } from '../tree-table/types';

/**
 * Node types in the collection hierarchy
 */
export type CollectionNodeType = 'collection' | 'file' | 'chunk' | 'embedding';

/**
 * Embedding status for filtering
 */
export type EmbeddingStatus = 'pending' | 'processing' | 'complete' | 'failed' | 'none';

/**
 * Collection node data
 */
export interface CollectionData {
  name: string;
  description?: string;
  modelId?: string;
  dimensions?: number;
  fileCount: number;
  chunkCount: number;
  embeddingCount: number;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * File node data
 */
export interface FileData {
  name: string;
  path: string;
  size: number;
  mimeType?: string;
  chunkCount: number;
  embeddingStatus: EmbeddingStatus;
  embeddingProgress?: number; // 0-100
  importedAt?: Date;
}

/**
 * Chunk node data
 */
export interface ChunkData {
  index: number;
  content: string;
  tokenCount: number;
  embeddingStatus: EmbeddingStatus;
  metadata?: Record<string, unknown>;
}

/**
 * Embedding node data (vector representation)
 */
export interface EmbeddingData {
  vectorId: string;
  dimensions: number;
  similarity?: number; // For search results
  metadata?: Record<string, unknown>;
}

/**
 * Union type for all node data types
 */
export type BrowserNodeData = CollectionData | FileData | ChunkData | EmbeddingData;

/**
 * Typed tree node for collection browser
 */
export type CollectionTreeNode = TreeNode<BrowserNodeData>;

/**
 * Filter state for the collection browser
 */
export interface CollectionBrowserFilters {
  /** Text search query */
  searchQuery: string;
  /** Filter by node type */
  nodeTypes: Set<CollectionNodeType>;
  /** Filter by embedding status */
  embeddingStatus: EmbeddingStatus | 'all';
  /** Only show nodes matching search */
  searchMatchesOnly: boolean;
}

/**
 * Default filter state
 */
export const DEFAULT_FILTERS: CollectionBrowserFilters = {
  searchQuery: '',
  nodeTypes: new Set(['collection', 'file', 'chunk', 'embedding']),
  embeddingStatus: 'all',
  searchMatchesOnly: false,
};

/**
 * Props for the FilterBar component
 */
export interface FilterBarProps {
  /** Current filter state */
  filters: CollectionBrowserFilters;
  /** Callback when filters change */
  onFiltersChange: (filters: CollectionBrowserFilters) => void;
  /** Whether the panel is expanded */
  isExpanded: boolean;
  /** Callback when expansion state changes */
  onExpandedChange: (expanded: boolean) => void;
  /** Custom class name */
  className?: string;
}

/**
 * Props for the FilterChip component
 */
export interface FilterChipProps {
  /** Label to display */
  label: string;
  /** Whether the chip is active/selected */
  active: boolean;
  /** Callback when clicked */
  onClick: () => void;
  /** Icon to show (optional) */
  icon?: React.ReactNode;
  /** Whether the chip is disabled */
  disabled?: boolean;
}

/**
 * Node type configuration for display
 */
export interface NodeTypeConfig {
  type: CollectionNodeType;
  label: string;
  pluralLabel: string;
  icon: string; // lucide icon name
  color: string; // Tailwind color class
}

/**
 * Configuration for each node type
 */
export const NODE_TYPE_CONFIG: Record<CollectionNodeType, NodeTypeConfig> = {
  collection: {
    type: 'collection',
    label: 'Collection',
    pluralLabel: 'Collections',
    icon: 'FolderOpen',
    color: 'text-blue-500',
  },
  file: {
    type: 'file',
    label: 'File',
    pluralLabel: 'Files',
    icon: 'File',
    color: 'text-green-500',
  },
  chunk: {
    type: 'chunk',
    label: 'Chunk',
    pluralLabel: 'Chunks',
    icon: 'FileText',
    color: 'text-orange-500',
  },
  embedding: {
    type: 'embedding',
    label: 'Embedding',
    pluralLabel: 'Embeddings',
    icon: 'Sparkles',
    color: 'text-purple-500',
  },
};

/**
 * Embedding status configuration for display
 */
export interface EmbeddingStatusConfig {
  status: EmbeddingStatus | 'all';
  label: string;
  icon: string;
  color: string;
}

// ============================================================================
// SEMANTIC SEARCH TYPES
// ============================================================================

/**
 * Search mode for the collection browser
 */
export type SearchMode = 'quick' | 'semantic';

/**
 * Distance metric for vector similarity search
 */
export type DistanceMetric = 'cosine' | 'l2' | 'ip';

/**
 * Retrieval mode for semantic search
 * - 'vector': Vector similarity search only (default, fastest)
 * - 'hybrid': Combines vector search with full-text search using RRF fusion
 */
export type RetrievalMode = 'vector' | 'hybrid';

/**
 * Configuration for semantic search
 */
export interface SearchConfig {
  /** Similarity threshold (0.0-1.0, default 0.5) */
  threshold: number;
  /** Maximum number of results (default 20) */
  resultLimit: number;
  /** Distance metric for similarity calculation */
  distanceMetric: DistanceMetric;
  /**
   * Optional allowlist of file paths to scope search results.
   * When provided, only chunks from files matching these paths are returned.
   * Use for selection-based search (e.g., "search within selected files").
   */
  filePaths?: readonly string[];
  /**
   * Optional snapshot ID referencing a persisted selection allowlist.
   * Use when file path list exceeds inline limits (~500 paths).
   * Takes precedence over filePaths if both are provided.
   */
  selectionSnapshotId?: string;

  // === Hybrid Search Options (BST-294) ===
  /**
   * Retrieval mode for search (default: 'vector')
   * - 'vector': Vector similarity search only (fastest)
   * - 'hybrid': Combines vector + full-text search with RRF fusion
   */
  retrievalMode?: RetrievalMode;
  /**
   * Weight for vector search results in hybrid mode (default: 1.0)
   * Higher values favor semantic similarity matches.
   */
  vectorWeight?: number;
  /**
   * Weight for full-text search results in hybrid mode (default: 1.0)
   * Higher values favor keyword/exact matches.
   */
  ftsWeight?: number;
}

/**
 * Default search configuration
 */
export const DEFAULT_SEARCH_CONFIG: SearchConfig = {
  threshold: 0.5,
  resultLimit: 20,
  distanceMetric: 'cosine',
  retrievalMode: 'hybrid',
};

/**
 * Result from a semantic search operation
 */
export interface SemanticSearchResult {
  /** Tree node ID (e.g., "chunk-abc123") */
  nodeId: string;
  /** Original chunk ID in the database */
  chunkId: string;
  /** File record ID this chunk belongs to */
  fileRecordId: string;
  /** Similarity score (0.0-1.0) - For hybrid search, this is the normalized RRF score */
  similarity: number;
  /** Chunk content for preview */
  content: string;
  /** File name for context */
  fileName: string;
  /** File path for context */
  filePath: string;
  /** Embedding set ID this chunk belongs to */
  embeddingSetId?: string;

  // === Hybrid Search Metadata (BST-294) ===
  /** Vector similarity score from vector search (if available) */
  vectorSimilarity?: number;
  /** Full-text search rank score (if available) */
  ftsRank?: number;
  /** Headline snippet with highlighted matches from FTS */
  headline?: string;
  /** Number of search sources that found this result (1-2 for hybrid) */
  sourceCount?: number;
}

/**
 * Props for the SearchModeBar component
 */
export interface SearchModeBarProps {
  /** Current search mode */
  mode: SearchMode;
  /** Callback when mode changes */
  onModeChange: (mode: SearchMode) => void;
  /** Semantic search query */
  semanticQuery: string;
  /** Callback when semantic query changes */
  onSemanticQueryChange: (query: string) => void;
  /** Callback to execute semantic search */
  onSemanticSearch: () => void;
  /** Whether semantic search is in progress */
  isSearching: boolean;
  /** Whether config panel is expanded */
  isConfigExpanded: boolean;
  /** Callback when config expansion changes */
  onConfigExpandedChange: (expanded: boolean) => void;
  /** Whether the filter bar is visible */
  isFilterVisible?: boolean;
  /** Callback when filter visibility changes */
  onFilterVisibleChange?: (visible: boolean) => void;
  /** Number of visible results */
  resultCount?: number;
  /** Total number of nodes */
  totalCount?: number;
  /** Callback to expand all nodes */
  onExpandAll?: () => void;
  /** Callback to collapse all nodes */
  onCollapseAll?: () => void;
  /** Whether semantic search has been executed */
  hasSearched?: boolean;
  /** Current filter state (controlled) */
  filters?: CollectionBrowserFilters;
  /** Callback when filters change (controlled) */
  onFiltersChange?: (filters: CollectionBrowserFilters) => void;
  /** Callback to reset filters */
  onResetFilters?: () => void;
  /** Whether multi-select mode is enabled */
  multiSelectEnabled?: boolean;
  /** Callback when multi-select toggle changes */
  onMultiSelectToggle?: (enabled: boolean) => void;
  /** Current group-by key */
  groupBy?: GroupByKey;
  /** Callback when group-by changes */
  onGroupByChange?: (groupBy: GroupByKey) => void;
  /** Custom class name */
  className?: string;
}

/**
 * Props for the SearchConfigPanel component
 */
export interface SearchConfigPanelProps {
  /** Current search configuration */
  config: SearchConfig;
  /** Callback when configuration changes */
  onConfigChange: (config: SearchConfig) => void;
  /** Whether the panel is expanded */
  isExpanded: boolean;
  /** Callback when expansion state changes */
  onExpandedChange: (expanded: boolean) => void;
  /** Default distance metric from the active collection (hint) */
  collectionDistanceMetric?: DistanceMetric;
  /** Custom class name */
  className?: string;
}

// ============================================================================
// GROUPING TYPES
// ============================================================================

/**
 * Available keys for grouping tree nodes.
 * - 'none': No grouping (flat list)
 * - 'status': Group by embedding status
 * - 'type': Group by file extension / MIME type
 */
export type GroupByKey = 'none' | 'status' | 'type';

/**
 * Grouping configuration for the collection browser.
 */
export interface GroupingState {
  /** Active grouping key */
  groupBy: GroupByKey;
}

/**
 * Default grouping state (no grouping)
 */
export const DEFAULT_GROUPING_STATE: GroupingState = {
  groupBy: 'none',
};

/**
 * Data for a virtual group header node.
 */
export interface GroupHeaderData {
  /** Group display label */
  groupLabel: string;
  /** Grouping key that produced this group */
  groupKey: GroupByKey;
  /** Value of the group (e.g., 'complete', '.ts') */
  groupValue: string;
  /** Number of direct children in this group */
  itemCount: number;
}

/**
 * Configuration for embedding status display
 */
export const EMBEDDING_STATUS_CONFIG: Record<EmbeddingStatus | 'all', EmbeddingStatusConfig> = {
  all: {
    status: 'all',
    label: 'All Status',
    icon: 'CircleDot',
    color: 'text-muted-foreground',
  },
  pending: {
    status: 'pending',
    label: 'Pending',
    icon: 'Clock',
    color: 'text-yellow-500',
  },
  processing: {
    status: 'processing',
    label: 'Processing',
    icon: 'Loader2',
    color: 'text-blue-500',
  },
  complete: {
    status: 'complete',
    label: 'Complete',
    icon: 'CheckCircle',
    color: 'text-green-500',
  },
  failed: {
    status: 'failed',
    label: 'Failed',
    icon: 'XCircle',
    color: 'text-red-500',
  },
  none: {
    status: 'none',
    label: 'No Embedding',
    icon: 'Circle',
    color: 'text-muted-foreground',
  },
};
