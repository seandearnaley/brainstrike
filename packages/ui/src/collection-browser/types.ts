/**
 * Collection inspection + semantic-search types.
 *
 * What is left here after the Collection Browser tree was retired (BST-1213):
 * the per-node shapes the {@link NodeInspector} renders, and the semantic
 * search config/result contract shared with the db-explorer executor. The
 * tree, filter, grouping, and toolbar types went with the browser.
 */

import type { CollectionNodeType } from '../bulk-action-bar';

// The node-kind union is owned by the shared bulk action bar; this module
// re-exports it because the inspector's display config is keyed by it.
export type { CollectionNodeType };

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
export type BrowserNodeData = CollectionData | FileData | ChunkData | EmbeddingData;

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
  chunk: {
    color: 'text-warning',
    icon: 'FileText',
    label: 'Chunk',
    pluralLabel: 'Chunks',
    type: 'chunk',
  },
  collection: {
    color: 'text-info',
    icon: 'FolderOpen',
    label: 'Collection',
    pluralLabel: 'Collections',
    type: 'collection',
  },
  embedding: {
    color: 'text-info',
    icon: 'Sparkles',
    label: 'Embedding',
    pluralLabel: 'Embeddings',
    type: 'embedding',
  },
  file: {
    color: 'text-success',
    icon: 'File',
    label: 'File',
    pluralLabel: 'Files',
    type: 'file',
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
  distanceMetric: 'cosine',
  resultLimit: 20,
  retrievalMode: 'hybrid',
  threshold: 0.5,
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
  /** 1-based inclusive ending line in the original file */
  endLine?: number;
  /** Exclusive ending character offset in the original file */
  endOffset?: number;
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
  /** 1-based inclusive starting line in the original file */
  startLine?: number;
  /** Inclusive starting character offset in the original file */
  startOffset?: number;
  /** Stored token count for the matched chunk */
  tokenCount?: number;

  // === Hybrid Search Metadata (BST-294) ===
  /** Vector similarity score from vector search (if available) */
  vectorSimilarity?: number;
}

/**
 * Props for the SearchConfigPanel component.
 *
 * The panel is pure presentational content (search tuning controls). Open/close
 * is owned by whatever surface hosts it — currently the cog Popover in the
 * Database tab's collection debug drawer (`retrieval-preview-section.tsx`).
 * The former host, `SearchModeBar`, went with the Collection Browser tree.
 */
export interface SearchConfigPanelProps {
  /** Custom class name */
  className?: string;
  /** Default distance metric from the active collection (hint) */
  collectionDistanceMetric?: DistanceMetric;
  /** Current search configuration */
  config: SearchConfig;
  /** Callback when configuration changes */
  onConfigChange: (config: SearchConfig) => void;
}

/**
 * Configuration for embedding status display
 */
export const EMBEDDING_STATUS_CONFIG: Record<EmbeddingStatus | 'all', EmbeddingStatusConfig> = {
  all: {
    color: 'text-muted-foreground',
    icon: 'CircleDot',
    label: 'All Status',
    status: 'all',
  },
  complete: {
    color: 'text-success',
    icon: 'CheckCircle',
    label: 'Complete',
    status: 'complete',
  },
  failed: {
    color: 'text-destructive',
    icon: 'XCircle',
    label: 'Failed',
    status: 'failed',
  },
  none: {
    color: 'text-muted-foreground',
    icon: 'Circle',
    label: 'No Embedding',
    status: 'none',
  },
  pending: {
    color: 'text-warning',
    icon: 'Clock',
    label: 'Pending',
    status: 'pending',
  },
  processing: {
    color: 'text-info',
    icon: 'Loader2',
    label: 'Processing',
    status: 'processing',
  },
};
