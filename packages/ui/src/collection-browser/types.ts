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
  chunkCount: number;
  createdAt?: Date;
  description?: string;
  dimensions?: number;
  embeddingCount: number;
  fileCount: number;
  modelId?: string;
  name: string;
  updatedAt?: Date;
}

/**
 * File node data
 */
export interface FileData {
  chunkCount: number;
  embeddingProgress?: number; // 0-100
  embeddingStatus: EmbeddingStatus;
  importedAt?: Date;
  mimeType?: string;
  name: string;
  path: string;
  size: number;
}

/**
 * Chunk node data
 */
export interface ChunkData {
  content: string;
  embeddingStatus: EmbeddingStatus;
  index: number;
  metadata?: Record<string, unknown>;
  tokenCount: number;
}

/**
 * Embedding node data (vector representation)
 */
export interface EmbeddingData {
  dimensions: number;
  metadata?: Record<string, unknown>;
  similarity?: number; // For search results
  vectorId: string;
}

/**
 * Union type for all node data types
 */
export type BrowserNodeData =
  | CollectionData
  | FileData
  | ChunkData
  | EmbeddingData
  | GroupHeaderData;

/**
 * Typed tree node for collection browser
 */
export type CollectionTreeNode = TreeNode<BrowserNodeData>;

/**
 * Filter state for the collection browser
 */
export interface CollectionBrowserFilters {
  /** Filter by embedding status */
  embeddingStatus: EmbeddingStatus | 'all';
  /** Filter by node type */
  nodeTypes: Set<CollectionNodeType>;
  /** Only show nodes matching search */
  searchMatchesOnly: boolean;
  /** Text search query */
  searchQuery: string;
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
 * Props for the FilterChip component
 */
export interface FilterChipProps {
  /** Whether the chip is active/selected */
  active: boolean;
  /**
   * Custom class name. Passes through `cn`, so `undefined` is a no-op.
   *
   * The explicit `| undefined` is required (not redundant) because this repo
   * sets `exactOptionalPropertyTypes: true` — without it, callers couldn't
   * write `className={maybeString}` where `maybeString` may be `undefined`
   * and would have to fall back to a conditional spread.
   */
  className?: string | undefined;
  /** Whether the chip is disabled */
  disabled?: boolean;
  /** Icon to show (optional) */
  icon?: React.ReactNode;
  /** Label to display */
  label: string;
  /** Callback when clicked */
  onClick: () => void;
}

/**
 * Node type configuration for display
 */
export interface NodeTypeConfig {
  color: string; // Tailwind color class
  icon: string; // lucide icon name
  label: string;
  pluralLabel: string;
  type: CollectionNodeType;
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
  color: string;
  icon: string;
  label: string;
  status: EmbeddingStatus | 'all';
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
  /** Distance metric for similarity calculation */
  distanceMetric: DistanceMetric;
  /**
   * Optional allowlist of file paths to scope search results.
   * When provided, only chunks from files matching these paths are returned.
   * Use for selection-based search (e.g., "search within selected files").
   */
  filePaths?: readonly string[];
  /**
   * Weight for full-text search results in hybrid mode (default: 1.0)
   * Higher values favor keyword/exact matches.
   */
  ftsWeight?: number;
  /** Maximum number of results (default 20) */
  resultLimit: number;

  // === Hybrid Search Options (BST-294) ===
  /**
   * Retrieval mode for search (default: 'vector')
   * - 'vector': Vector similarity search only (fastest)
   * - 'hybrid': Combines vector + full-text search with RRF fusion
   */
  retrievalMode?: RetrievalMode;
  /**
   * Optional snapshot ID referencing a persisted selection allowlist.
   * Use when file path list exceeds inline limits (~500 paths).
   * Takes precedence over filePaths if both are provided.
   */
  selectionSnapshotId?: string;
  /** Similarity threshold (0.0-1.0, default 0.5) */
  threshold: number;
  /**
   * Weight for vector search results in hybrid mode (default: 1.0)
   * Higher values favor semantic similarity matches.
   */
  vectorWeight?: number;
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
  /** Original chunk ID in the database */
  chunkId: string;
  /** Original chunk index within the source file */
  chunkIndex?: number;
  /** Chunk content for preview */
  content: string;
  /** Embedding vector dimensions for the matched chunk */
  embeddingDimensions?: number;
  /** Embedding set ID this chunk belongs to */
  embeddingSetId?: string;
  /** File name for context */
  fileName: string;
  /** File path for context */
  filePath: string;
  /** File record ID this chunk belongs to */
  fileRecordId: string;
  /** File size in bytes */
  fileSize?: number;
  /** Full-text search rank score (if available) */
  ftsRank?: number;
  /** Headline snippet with highlighted matches from FTS */
  headline?: string;
  /** Tree node ID (e.g., "chunk-abc123") */
  nodeId: string;
  /** Similarity score (0.0-1.0) - For hybrid search, this is the normalized RRF score */
  similarity: number;
  /** Number of search sources that found this result (1-2 for hybrid) */
  sourceCount?: number;
  /** Stored token count for the matched chunk */
  tokenCount?: number;

  // === Hybrid Search Metadata (BST-294) ===
  /** Vector similarity score from vector search (if available) */
  vectorSimilarity?: number;
}

/**
 * Props for the SearchModeBar component
 */
export interface SearchModeBarProps {
  /** Advanced search controls rendered inside the expanded hybrid search panel */
  advancedOptions?: React.ReactNode;
  /** Custom class name */
  className?: string;
  /** Whether semantic search has been executed */
  hasSearched?: boolean;
  /** Whether the hybrid search panel is expanded */
  isSearchExpanded: boolean;
  /** Whether semantic search is in progress */
  isSearching: boolean;
  /** Current search mode */
  mode: SearchMode;
  /** Callback when mode changes */
  onModeChange: (mode: SearchMode) => void;
  /** Callback when hybrid search panel expansion changes */
  onSearchExpandedChange: (expanded: boolean) => void;
  /** Callback when semantic query changes */
  onSemanticQueryChange: (query: string) => void;
  /** Callback to execute semantic search */
  onSemanticSearch: () => void;
  /** Number of visible results */
  resultCount?: number;
  /** Semantic search query */
  semanticQuery: string;
}

/**
 * Props for the collection browser toolbar that sits directly above the grid.
 *
 * The toolbar hosts the inline filter input + Embedded toggle. The controls
 * collapse to a popover when the parent panel is too narrow to fit them; this
 * is driven by Tailwind container queries on the toolbar root, so the toolbar
 * just needs to be inside a `@container/cb-toolbar` (which it sets on itself).
 */
export interface CollectionBrowserToolbarProps {
  /** Custom class name */
  className?: string;
  /** Current filter state (controlled) — required to render filter UI */
  filters?: CollectionBrowserFilters;
  /** Current group-by key */
  groupBy?: GroupByKey;
  /** Whether multi-select mode is enabled */
  multiSelectEnabled?: boolean;
  /** Callback to collapse all nodes */
  onCollapseAll?: () => void;
  /** Callback to expand all nodes */
  onExpandAll?: () => void;
  /** Callback when filters change — required to render filter UI */
  onFiltersChange?: (filters: CollectionBrowserFilters) => void;
  /** Callback when group-by changes */
  onGroupByChange?: (groupBy: GroupByKey) => void;
  /** Callback when multi-select toggle changes */
  onMultiSelectToggle?: (enabled: boolean) => void;
}

/**
 * Props for the SearchConfigPanel component
 */
export interface SearchConfigPanelProps {
  /** Custom class name */
  className?: string;
  /** Default distance metric from the active collection (hint) */
  collectionDistanceMetric?: DistanceMetric;
  /** Current search configuration */
  config: SearchConfig;
  /** Whether the panel is expanded */
  isExpanded: boolean;
  /** Callback when configuration changes */
  onConfigChange: (config: SearchConfig) => void;
  /** Callback when expansion state changes */
  onExpandedChange: (expanded: boolean) => void;
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
  /** Grouping key that produced this group */
  groupKey: GroupByKey;
  /** Group display label */
  groupLabel: string;
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
