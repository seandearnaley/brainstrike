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
export type CollectionData = {
  name: string;
  description?: string;
  modelId?: string;
  dimensions?: number;
  fileCount: number;
  chunkCount: number;
  embeddingCount: number;
  createdAt?: Date;
  updatedAt?: Date;
};

/**
 * File node data
 */
export type FileData = {
  name: string;
  path: string;
  size: number;
  mimeType?: string;
  chunkCount: number;
  embeddingStatus: EmbeddingStatus;
  embeddingProgress?: number; // 0-100
  importedAt?: Date;
};

/**
 * Chunk node data
 */
export type ChunkData = {
  index: number;
  content: string;
  tokenCount: number;
  embeddingStatus: EmbeddingStatus;
  metadata?: Record<string, unknown>;
};

/**
 * Embedding node data (vector representation)
 */
export type EmbeddingData = {
  vectorId: string;
  dimensions: number;
  similarity?: number; // For search results
  metadata?: Record<string, unknown>;
};

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
export type CollectionBrowserFilters = {
  /** Text search query */
  searchQuery: string;
  /** Filter by node type */
  nodeTypes: Set<CollectionNodeType>;
  /** Filter by embedding status */
  embeddingStatus: EmbeddingStatus | 'all';
  /** Only show nodes matching search */
  searchMatchesOnly: boolean;
};

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
export type FilterBarProps = {
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
  /** Number of visible results (for display) */
  resultCount?: number;
  /** Total number of nodes */
  totalCount?: number;
};

/**
 * Props for the FilterChip component
 */
export type FilterChipProps = {
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
};

/**
 * Node type configuration for display
 */
export type NodeTypeConfig = {
  type: CollectionNodeType;
  label: string;
  pluralLabel: string;
  icon: string; // lucide icon name
  color: string; // Tailwind color class
};

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
export type EmbeddingStatusConfig = {
  status: EmbeddingStatus | 'all';
  label: string;
  icon: string;
  color: string;
};

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
 * Configuration for semantic search
 */
export type SearchConfig = {
  /** Similarity threshold (0.0-1.0, default 0.5) */
  threshold: number;
  /** Maximum number of results (default 20) */
  resultLimit: number;
  /** Distance metric for similarity calculation */
  distanceMetric: DistanceMetric;
};

/**
 * Default search configuration
 */
export const DEFAULT_SEARCH_CONFIG: SearchConfig = {
  threshold: 0.5,
  resultLimit: 20,
  distanceMetric: 'cosine',
};

/**
 * Result from a semantic search operation
 */
export type SemanticSearchResult = {
  /** Tree node ID (e.g., "chunk-abc123") */
  nodeId: string;
  /** Original chunk ID in the database */
  chunkId: string;
  /** File record ID this chunk belongs to */
  fileRecordId: string;
  /** Similarity score (0.0-1.0) */
  similarity: number;
  /** Chunk content for preview */
  content: string;
  /** File name for context */
  fileName: string;
  /** File path for context */
  filePath: string;
  /** Embedding set ID this chunk belongs to */
  embeddingSetId?: string;
};

/**
 * Props for the SearchModeBar component
 */
export type SearchModeBarProps = {
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
  /** Custom class name */
  className?: string;
};

/**
 * Props for the SearchConfigPanel component
 */
export type SearchConfigPanelProps = {
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
};

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
