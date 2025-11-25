/**
 * useCollectionTree Hook
 *
 * Transforms flat database records into a hierarchical tree structure
 * for the Collection Browser. Handles filtering, sorting, and memoization.
 */

import * as React from 'react';
import type { TreeNode } from '../tree-table/types';
import type {
  BrowserNodeData,
  ChunkData,
  CollectionBrowserFilters,
  CollectionData,
  CollectionNodeType,
  EmbeddingData,
  EmbeddingStatus,
  FileData,
} from './types';

/**
 * Input data for building the collection tree
 */
export interface CollectionTreeInput {
  /** Embedding sets / collections */
  collections: Array<{
    id: string;
    name?: string;
    description?: string;
    modelId: string;
    dimensions: number;
  }>;
  /** File records */
  files: Array<{
    id: string;
    name: string;
    path: string;
    size: number;
    embeddingSetId?: string;
    chunksCount?: number;
    processedAt?: string;
  }>;
  /** File chunks */
  chunks: Array<{
    id: string;
    fileRecordId: string;
    chunkIndex: number;
    content: string;
    tokenCount: number;
    embedding?: number[];
    embeddingSetId?: string;
  }>;
  /** Pending chunk IDs (being embedded) */
  pendingChunkIds?: Set<string>;
}

/**
 * Options for the useCollectionTree hook
 */
export interface UseCollectionTreeOptions {
  /** Input data */
  data: CollectionTreeInput;
  /** Current filter state */
  filters: CollectionBrowserFilters;
  /** Currently expanded node IDs */
  expandedIds: Set<string>;
}

/**
 * Result from the useCollectionTree hook
 */
export interface UseCollectionTreeResult {
  /** Flattened nodes for rendering (respects expansion state) */
  nodes: TreeNode<BrowserNodeData>[];
  /** Root nodes (top-level collections) */
  rootNodes: TreeNode<BrowserNodeData>[];
  /** Total count of all nodes */
  totalCount: number;
  /** Count of filtered/visible nodes */
  filteredCount: number;
  /** Get children for a node ID */
  getChildren: (parentId: string) => TreeNode<BrowserNodeData>[];
  /** Node IDs that match the current search query (for highlighting) */
  searchMatchIds: Set<string>;
  /** Node IDs that should be auto-expanded to reveal search matches */
  searchExpandIds: Set<string>;
}

/**
 * Determine embedding status for a file based on its chunks
 */
function getFileEmbeddingStatus(
  file: CollectionTreeInput['files'][0],
  chunks: CollectionTreeInput['chunks'],
  pendingChunkIds?: Set<string>
): EmbeddingStatus {
  const fileChunks = chunks.filter((c) => c.fileRecordId === file.id);
  if (fileChunks.length === 0) return 'none';

  const embeddedCount = fileChunks.filter((c) => c.embedding && c.embedding.length > 0).length;
  const pendingCount = fileChunks.filter((c) => pendingChunkIds?.has(c.id)).length;

  if (pendingCount > 0) return 'processing';
  if (embeddedCount === fileChunks.length) return 'complete';
  if (embeddedCount > 0) return 'pending';
  return 'none';
}

/**
 * Determine embedding status for a chunk
 */
function getChunkEmbeddingStatus(
  chunk: CollectionTreeInput['chunks'][0],
  pendingChunkIds?: Set<string>
): EmbeddingStatus {
  if (pendingChunkIds?.has(chunk.id)) return 'processing';
  if (chunk.embedding && chunk.embedding.length > 0) return 'complete';
  return 'none';
}

/**
 * Get searchable text fields from node data
 */
function getSearchableFields(data: BrowserNodeData): string[] {
  const fields: string[] = [];
  if ('name' in data && typeof data.name === 'string') fields.push(data.name);
  if ('description' in data && typeof data.description === 'string') fields.push(data.description);
  if ('path' in data && typeof data.path === 'string') fields.push(data.path);
  if ('content' in data && typeof data.content === 'string') fields.push(data.content);
  return fields;
}

/**
 * Check if a node matches the current search query
 */
function matchesSearch(node: TreeNode<BrowserNodeData>, searchQuery: string): boolean {
  if (!searchQuery) return true;
  const query = searchQuery.toLowerCase();
  const fields = getSearchableFields(node.data);
  return fields.some((field) => field.toLowerCase().includes(query));
}

/**
 * Build tree context for accumulating nodes
 */
interface TreeBuildContext {
  all: TreeNode<BrowserNodeData>[];
  children: Map<string, TreeNode<BrowserNodeData>[]>;
}

/**
 * Create an embedding node from a chunk
 */
function createEmbeddingNode(
  chunk: CollectionTreeInput['chunks'][0],
  parentId: string
): TreeNode<BrowserNodeData> {
  const embeddingData: EmbeddingData = {
    vectorId: chunk.id,
    dimensions: chunk.embedding?.length ?? 0,
  };
  return {
    id: `embedding-${chunk.id}`,
    type: 'embedding',
    depth: 3,
    data: embeddingData,
    parentId,
    hasChildren: false,
  };
}

/**
 * Create a chunk node with optional embedding child
 */
function createChunkNode(
  chunk: CollectionTreeInput['chunks'][0],
  parentId: string,
  pendingChunkIds: Set<string> | undefined,
  ctx: TreeBuildContext
): TreeNode<BrowserNodeData> {
  const chunkStatus = getChunkEmbeddingStatus(chunk, pendingChunkIds);
  const hasEmbedding = Boolean(chunk.embedding && chunk.embedding.length > 0);

  const chunkData: ChunkData = {
    index: chunk.chunkIndex,
    content: chunk.content,
    tokenCount: chunk.tokenCount,
    embeddingStatus: chunkStatus,
  };

  const chunkNode: TreeNode<BrowserNodeData> = {
    id: `chunk-${chunk.id}`,
    type: 'chunk',
    depth: 2,
    data: chunkData,
    parentId,
    hasChildren: hasEmbedding,
  };

  ctx.all.push(chunkNode);

  if (hasEmbedding) {
    const embeddingNode = createEmbeddingNode(chunk, chunkNode.id);
    ctx.all.push(embeddingNode);
    ctx.children.set(chunkNode.id, [embeddingNode]);
  }

  return chunkNode;
}

/**
 * Create a file node with its chunk children
 */
function createFileNode(
  file: CollectionTreeInput['files'][0],
  parentId: string,
  data: CollectionTreeInput,
  ctx: TreeBuildContext
): TreeNode<BrowserNodeData> {
  const fileChunks = data.chunks.filter((c) => c.fileRecordId === file.id);
  const embeddingStatus = getFileEmbeddingStatus(file, data.chunks, data.pendingChunkIds);
  const embeddedChunks = fileChunks.filter((c) => c.embedding && c.embedding.length > 0).length;
  const progress =
    fileChunks.length > 0 ? Math.round((embeddedChunks / fileChunks.length) * 100) : 0;

  const fileData: FileData = {
    name: file.name,
    path: file.path,
    size: file.size,
    chunkCount: fileChunks.length,
    embeddingStatus,
    embeddingProgress: progress,
  };
  if (file.processedAt) {
    fileData.importedAt = new Date(file.processedAt);
  }

  const fileNode: TreeNode<BrowserNodeData> = {
    id: `file-${file.id}`,
    type: 'file',
    depth: 1,
    data: fileData,
    parentId,
    hasChildren: fileChunks.length > 0,
  };

  ctx.all.push(fileNode);

  // Create chunk nodes
  const chunkNodes = fileChunks.map((chunk) =>
    createChunkNode(chunk, fileNode.id, data.pendingChunkIds, ctx)
  );
  ctx.children.set(fileNode.id, chunkNodes);

  return fileNode;
}

/**
 * Create a collection node with its file children
 */
function createCollectionNode(
  collection: CollectionTreeInput['collections'][0],
  data: CollectionTreeInput,
  ctx: TreeBuildContext
): TreeNode<BrowserNodeData> {
  const collectionFiles = data.files.filter((f) => f.embeddingSetId === collection.id);
  const collectionChunks = data.chunks.filter((c) => c.embeddingSetId === collection.id);
  const embeddingCount = collectionChunks.filter(
    (c) => c.embedding && c.embedding.length > 0
  ).length;

  const collectionData: CollectionData = {
    name: collection.name ?? `Collection ${collection.id.slice(0, 8)}`,
    modelId: collection.modelId,
    dimensions: collection.dimensions,
    fileCount: collectionFiles.length,
    chunkCount: collectionChunks.length,
    embeddingCount,
  };
  if (collection.description !== undefined) {
    collectionData.description = collection.description;
  }

  const collectionNode: TreeNode<BrowserNodeData> = {
    id: `collection-${collection.id}`,
    type: 'collection',
    depth: 0,
    data: collectionData,
    parentId: null,
    hasChildren: collectionFiles.length > 0,
  };

  ctx.all.push(collectionNode);

  // Create file nodes
  const fileNodes = collectionFiles.map((file) =>
    createFileNode(file, collectionNode.id, data, ctx)
  );
  ctx.children.set(collectionNode.id, fileNodes);

  return collectionNode;
}

/**
 * Check if a node matches the embedding status filter
 */
function matchesEmbeddingStatus(
  node: TreeNode<BrowserNodeData>,
  status: EmbeddingStatus | 'all'
): boolean {
  if (status === 'all') return true;

  const data = node.data;
  if ('embeddingStatus' in data) {
    return data.embeddingStatus === status;
  }

  // Collections don't have status (they aggregate their children)
  return true;
}

/**
 * Filter context for recursive node filtering
 */
interface FilterContext {
  filters: CollectionBrowserFilters;
  childrenMap: Map<string, TreeNode<BrowserNodeData>[]>;
}

/**
 * Check if node passes type filter, considering children visibility
 */
function checkTypeFilter(
  node: TreeNode<BrowserNodeData>,
  ctx: FilterContext,
  filterFn: (n: TreeNode<BrowserNodeData>) => TreeNode<BrowserNodeData> | null
): TreeNode<BrowserNodeData> | null {
  const nodeType = node.type as CollectionNodeType;
  if (ctx.filters.nodeTypes.has(nodeType)) return node; // Type passes

  // Type doesn't pass, but check children
  const nodeChildren = ctx.childrenMap.get(node.id) ?? [];
  const hasVisibleChildren = nodeChildren.some((child) => filterFn(child) !== null);

  // Keep collections if they have visible children
  if (hasVisibleChildren && nodeType === 'collection') return node;
  return null;
}

/**
 * Check if a leaf node matches all filters
 */
function checkLeafFilters(
  node: TreeNode<BrowserNodeData>,
  ctx: FilterContext
): TreeNode<BrowserNodeData> | null {
  const matchesSearchFilter = matchesSearch(node, ctx.filters.searchQuery);
  const matchesStatusFilter = matchesEmbeddingStatus(node, ctx.filters.embeddingStatus);
  return matchesSearchFilter && matchesStatusFilter ? node : null;
}

/**
 * Check if a parent node should be included (has matching children or matches itself)
 */
function checkParentFilters(
  node: TreeNode<BrowserNodeData>,
  ctx: FilterContext,
  filterFn: (n: TreeNode<BrowserNodeData>) => TreeNode<BrowserNodeData> | null
): TreeNode<BrowserNodeData> | null {
  const nodeChildren = ctx.childrenMap.get(node.id) ?? [];
  const hasMatchingChildren = nodeChildren.some((child) => filterFn(child) !== null);
  if (hasMatchingChildren) return node;
  return checkLeafFilters(node, ctx);
}

/**
 * Recursive filter function for tree nodes
 */
function filterTreeNode(
  node: TreeNode<BrowserNodeData>,
  ctx: FilterContext
): TreeNode<BrowserNodeData> | null {
  // First check type filter
  const typeResult = checkTypeFilter(node, ctx, (n) => filterTreeNode(n, ctx));
  if (typeResult === null) return null;
  if (typeResult !== node) return typeResult; // Type didn't pass but had visible children

  // Check if leaf or parent
  const nodeChildren = ctx.childrenMap.get(node.id) ?? [];
  if (nodeChildren.length === 0) {
    return checkLeafFilters(node, ctx);
  }
  return checkParentFilters(node, ctx, (n) => filterTreeNode(n, ctx));
}

/**
 * Hook to transform flat data into a hierarchical tree structure
 */
export function useCollectionTree({
  data,
  filters,
  expandedIds,
}: UseCollectionTreeOptions): UseCollectionTreeResult {
  // Build the tree structure using helper functions
  const { rootNodes, allNodes, childrenMap } = React.useMemo(() => {
    const ctx: TreeBuildContext = {
      all: [],
      children: new Map<string, TreeNode<BrowserNodeData>[]>(),
    };

    const roots = data.collections.map((collection) => createCollectionNode(collection, data, ctx));

    return { rootNodes: roots, allNodes: ctx.all, childrenMap: ctx.children };
  }, [data]);

  // Apply filters
  const { filteredRoots, filteredCount } = React.useMemo(() => {
    // If no filters active, return all roots
    if (!filters.searchQuery && filters.nodeTypes.size === 4 && filters.embeddingStatus === 'all') {
      return { filteredRoots: rootNodes, filteredCount: allNodes.length };
    }

    // Create filter context
    const ctx: FilterContext = { filters, childrenMap };
    const filterFn = (node: TreeNode<BrowserNodeData>) => filterTreeNode(node, ctx);

    const filtered = rootNodes.map(filterFn).filter(Boolean) as TreeNode<BrowserNodeData>[];

    // Count filtered nodes recursively
    let count = 0;
    function countNodes(nodes: TreeNode<BrowserNodeData>[]): void {
      for (const node of nodes) {
        if (filterFn(node)) {
          count++;
          const nodeChildren = childrenMap.get(node.id) ?? [];
          countNodes(nodeChildren);
        }
      }
    }
    countNodes(filtered);

    return { filteredRoots: filtered, filteredCount: count };
  }, [rootNodes, allNodes, childrenMap, filters]);

  // Flatten visible nodes based on expansion state
  const visibleNodes = React.useMemo(() => {
    const result: TreeNode<BrowserNodeData>[] = [];

    function addNode(node: TreeNode<BrowserNodeData>): void {
      result.push(node);

      if (expandedIds.has(node.id) && node.hasChildren) {
        const nodeChildren = childrenMap.get(node.id) ?? [];
        for (const child of nodeChildren) {
          addNode(child);
        }
      }
    }

    for (const root of filteredRoots) {
      addNode(root);
    }

    return result;
  }, [filteredRoots, expandedIds, childrenMap]);

  // Get children callback
  const getChildren = React.useCallback(
    (parentId: string): TreeNode<BrowserNodeData>[] => {
      return childrenMap.get(parentId) ?? [];
    },
    [childrenMap]
  );

  // Compute search match IDs and nodes to auto-expand
  const { searchMatchIds, searchExpandIds } = React.useMemo(() => {
    const matchIds = new Set<string>();
    const expandIds = new Set<string>();

    // No search query means no matches to highlight
    if (!filters.searchQuery) {
      return { searchMatchIds: matchIds, searchExpandIds: expandIds };
    }

    // Build a map from node ID to parent ID for traversal
    const nodeParentMap = new Map<string, string | null>();
    for (const node of allNodes) {
      nodeParentMap.set(node.id, node.parentId);
    }

    // Find all nodes that match the search query
    for (const node of allNodes) {
      if (matchesSearch(node, filters.searchQuery)) {
        matchIds.add(node.id);

        // Walk up the tree and mark all ancestors for expansion
        let currentParentId = node.parentId;
        while (currentParentId) {
          expandIds.add(currentParentId);
          currentParentId = nodeParentMap.get(currentParentId) ?? null;
        }
      }
    }

    return { searchMatchIds: matchIds, searchExpandIds: expandIds };
  }, [allNodes, filters.searchQuery]);

  return {
    nodes: visibleNodes,
    rootNodes: filteredRoots,
    totalCount: allNodes.length,
    filteredCount,
    getChildren,
    searchMatchIds,
    searchExpandIds,
  };
}
