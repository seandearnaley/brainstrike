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
  /** Callback to expand all nodes */
  onExpandAll?: () => void;
  /** Callback to collapse all nodes */
  onCollapseAll?: () => void;
  /** Whether expand/collapse buttons are shown */
  showExpandControls?: boolean;
  /** Custom class name */
  className?: string;
  /** Number of visible results (for display) */
  resultCount?: number;
  /** Total number of nodes */
  totalCount?: number;
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
