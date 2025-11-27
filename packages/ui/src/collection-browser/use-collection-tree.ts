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
  SemanticSearchResult,
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
 * Sort key for hierarchical sorting.
 * Each key applies contextually to different node types:
 * - 'name': collections/files by name, chunks by index
 * - 'size': files by file size, chunks by token count
 * - 'status': by embedding completion status
 * - 'count': collections by file count, files by chunk count
 */
export type CollectionSortKey = 'name' | 'size' | 'status' | 'count' | 'score';

/**
 * Sort direction
 */
export type CollectionSortDirection = 'asc' | 'desc';

/**
 * Sort state for the collection tree
 */
export interface CollectionSortState {
  /** Sort key */
  key: CollectionSortKey;
  /** Sort direction */
  direction: CollectionSortDirection;
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
  /** Sort state (optional) */
  sortState?: CollectionSortState;
  /** Semantic search results to overlay on tree (optional) */
  semanticResults?: SemanticSearchResult[];
  /** Whether to filter tree to only show semantic results (default: true when results present) */
  filterToSemanticResults?: boolean;
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
  /** Map of node ID to similarity score (for score column in semantic search mode) */
  similarityScores: Map<string, number>;
  /** Node IDs that match semantic search (subset of nodes) */
  semanticMatchIds: Set<string>;
  /** Node IDs that should be auto-expanded to reveal semantic search matches */
  semanticExpandIds: Set<string>;
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
 * Status priority for sorting (lower = better)
 */
const STATUS_PRIORITY: Record<EmbeddingStatus, number> = {
  complete: 0,
  processing: 1,
  pending: 2,
  failed: 3,
  none: 4,
};

/**
 * Get sort value for a collection node
 */
function getCollectionSortValue(data: CollectionData, sortKey: CollectionSortKey): string | number {
  switch (sortKey) {
    case 'name':
      return data.name.toLowerCase();
    case 'size':
      return data.embeddingCount;
    case 'status':
      // Collections don't have status, sort by completion ratio
      return data.chunkCount > 0 ? data.embeddingCount / data.chunkCount : 0;
    case 'count':
      return data.fileCount;
    case 'score':
      // Score sorting is handled specially in sortNodes using similarityScores map
      return 0;
  }
}

/**
 * Get sort value for a file node
 */
function getFileSortValue(data: FileData, sortKey: CollectionSortKey): string | number {
  switch (sortKey) {
    case 'name':
      return data.name.toLowerCase();
    case 'size':
      return data.size;
    case 'status':
      return STATUS_PRIORITY[data.embeddingStatus];
    case 'count':
      return data.chunkCount;
    case 'score':
      // Score sorting is handled specially in sortNodes using similarityScores map
      return 0;
  }
}

/**
 * Get sort value for a chunk node
 */
function getChunkSortValue(data: ChunkData, sortKey: CollectionSortKey): string | number {
  switch (sortKey) {
    case 'name':
      return data.index; // Chunks sort by index for "name"
    case 'size':
      return data.tokenCount;
    case 'status':
      return STATUS_PRIORITY[data.embeddingStatus];
    case 'count':
      return data.tokenCount; // No count for chunks, use token count
    case 'score':
      // Score sorting is handled specially in sortNodes using similarityScores map
      return 0;
  }
}

/**
 * Get sort value for an embedding node
 */
function getEmbeddingSortValue(data: EmbeddingData, sortKey: CollectionSortKey): string | number {
  switch (sortKey) {
    case 'name':
      return data.vectorId;
    case 'size':
      return data.dimensions;
    case 'status':
      return 0; // Embeddings are always "complete"
    case 'count':
      return data.dimensions;
    case 'score':
      // Score sorting is handled specially in sortNodes using similarityScores map
      return 0;
  }
}

/**
 * Get sort value for any node based on its type
 */
function getNodeSortValue(
  node: TreeNode<BrowserNodeData>,
  sortKey: CollectionSortKey
): string | number {
  switch (node.type) {
    case 'collection':
      return getCollectionSortValue(node.data as CollectionData, sortKey);
    case 'file':
      return getFileSortValue(node.data as FileData, sortKey);
    case 'chunk':
      return getChunkSortValue(node.data as ChunkData, sortKey);
    case 'embedding':
      return getEmbeddingSortValue(node.data as EmbeddingData, sortKey);
    default:
      return 0;
  }
}

/**
 * Compare two nodes for sorting
 */
function compareNodes(
  a: TreeNode<BrowserNodeData>,
  b: TreeNode<BrowserNodeData>,
  sortState: CollectionSortState
): number {
  const aVal = getNodeSortValue(a, sortState.key);
  const bVal = getNodeSortValue(b, sortState.key);

  let result: number;
  if (typeof aVal === 'string' && typeof bVal === 'string') {
    result = aVal.localeCompare(bVal);
  } else {
    result = (aVal as number) - (bVal as number);
  }

  return sortState.direction === 'desc' ? -result : result;
}

/**
 * Sort an array of nodes in place
 */
function sortNodes(
  nodes: TreeNode<BrowserNodeData>[],
  sortState: CollectionSortState | undefined,
  similarityScores?: Map<string, number>
): TreeNode<BrowserNodeData>[] {
  if (!sortState) return nodes;

  // Handle score sorting specially - requires similarityScores map
  if (sortState.key === 'score' && similarityScores) {
    return [...nodes].sort((a, b) => {
      const scoreA = similarityScores.get(a.id) ?? 0;
      const scoreB = similarityScores.get(b.id) ?? 0;
      const result = scoreA - scoreB;
      return sortState.direction === 'desc' ? -result : result;
    });
  }

  return [...nodes].sort((a, b) => compareNodes(a, b, sortState));
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
 * Get the maximum score from a node's children
 */
function getMaxChildScore(
  nodeId: string,
  childrenMap: Map<string, TreeNode<BrowserNodeData>[]>,
  scores: Map<string, number>
): number {
  const children = childrenMap.get(nodeId) ?? [];
  let maxScore = 0;
  for (const child of children) {
    const childScore = scores.get(child.id);
    if (childScore !== undefined && childScore > maxScore) {
      maxScore = childScore;
    }
  }
  return maxScore;
}

/**
 * Aggregate scores for nodes of a specific type from their children
 */
function aggregateScoresForType(
  nodeType: string,
  allNodes: TreeNode<BrowserNodeData>[],
  childrenMap: Map<string, TreeNode<BrowserNodeData>[]>,
  scores: Map<string, number>
): void {
  for (const node of allNodes) {
    if (node.type === nodeType) {
      const maxScore = getMaxChildScore(node.id, childrenMap, scores);
      if (maxScore > 0) {
        scores.set(node.id, maxScore);
      }
    }
  }
}

/**
 * Check if a node passes filtering for visibility when flattening
 */
function nodePassesFilter(
  node: TreeNode<BrowserNodeData>,
  hasSemanticFilter: boolean,
  visibleNodeIds: Set<string>,
  filterCtx: FilterContext
): boolean {
  if (hasSemanticFilter) {
    return visibleNodeIds.has(node.id);
  }
  return filterTreeNode(node, filterCtx) !== null;
}

/**
 * Flatten visible nodes based on expansion state
 * Extracted to reduce cognitive complexity of the main useMemo
 */
function flattenVisibleNodes(
  filteredRoots: TreeNode<BrowserNodeData>[],
  expandedIds: Set<string>,
  sortedChildrenMap: Map<string, TreeNode<BrowserNodeData>[]>,
  hasSemanticFilter: boolean,
  visibleNodeIds: Set<string>,
  filterCtx: FilterContext
): TreeNode<BrowserNodeData>[] {
  const result: TreeNode<BrowserNodeData>[] = [];

  function addNode(node: TreeNode<BrowserNodeData>): void {
    result.push(node);

    if (expandedIds.has(node.id)) {
      const children = sortedChildrenMap.get(node.id) ?? [];
      for (const child of children) {
        // Only add children that pass the filter
        if (nodePassesFilter(child, hasSemanticFilter, visibleNodeIds, filterCtx)) {
          addNode(child);
        }
      }
    }
  }

  for (const root of filteredRoots) {
    addNode(root);
  }

  return result;
}

/**
 * Compute similarity scores with aggregation for parent nodes
 * - Chunks: Direct similarity from search results
 * - Files: Max score of child chunks
 * - Collections: Max score of child files
 */
function computeAggregatedScores(
  semanticResults: SemanticSearchResult[],
  allNodes: TreeNode<BrowserNodeData>[],
  childrenMap: Map<string, TreeNode<BrowserNodeData>[]>
): Map<string, number> {
  const scores = new Map<string, number>();

  // Set chunk scores directly from results
  for (const result of semanticResults) {
    scores.set(result.nodeId, result.similarity);
  }

  // Aggregate file scores from chunks, then collection scores from files
  aggregateScoresForType('file', allNodes, childrenMap, scores);
  aggregateScoresForType('collection', allNodes, childrenMap, scores);

  return scores;
}

/**
 * Hook to transform flat data into a hierarchical tree structure
 */
export function useCollectionTree({
  data,
  filters,
  expandedIds,
  sortState,
  semanticResults,
  filterToSemanticResults = true,
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

  // Compute semantic search match IDs and scores
  const { semanticMatchIds, similarityScores, semanticExpandIds } = React.useMemo(() => {
    const matchIds = new Set<string>();
    const expandIds = new Set<string>();

    if (!semanticResults || semanticResults.length === 0) {
      return {
        semanticMatchIds: matchIds,
        similarityScores: new Map<string, number>(),
        semanticExpandIds: expandIds,
      };
    }

    // Build node ID to parent ID map for traversal
    const nodeParentMap = new Map<string, string | null>();
    for (const node of allNodes) {
      nodeParentMap.set(node.id, node.parentId);
    }

    // Mark matching chunks and compute ancestors to expand
    for (const result of semanticResults) {
      matchIds.add(result.nodeId);

      // Walk up the tree and mark ancestors for expansion
      let currentParentId = nodeParentMap.get(result.nodeId) ?? null;
      while (currentParentId) {
        expandIds.add(currentParentId);
        currentParentId = nodeParentMap.get(currentParentId) ?? null;
      }
    }

    // Compute aggregated scores (includes parent nodes)
    const scores = computeAggregatedScores(semanticResults, allNodes, childrenMap);

    return { semanticMatchIds: matchIds, similarityScores: scores, semanticExpandIds: expandIds };
  }, [semanticResults, allNodes, childrenMap]);

  // Apply sorting to children at each level
  // When semantic results are present, sort by score descending by default
  const sortedChildrenMap = React.useMemo(() => {
    const hasSemanticSort = semanticResults && semanticResults.length > 0 && !sortState;

    if (!sortState && !hasSemanticSort) return childrenMap;

    const sorted = new Map<string, TreeNode<BrowserNodeData>[]>();
    for (const [parentId, children] of childrenMap) {
      if (hasSemanticSort) {
        // Sort by similarity score descending
        const sortedChildren = [...children].sort((a, b) => {
          const scoreA = similarityScores.get(a.id) ?? 0;
          const scoreB = similarityScores.get(b.id) ?? 0;
          return scoreB - scoreA; // Descending
        });
        sorted.set(parentId, sortedChildren);
      } else if (sortState) {
        sorted.set(parentId, sortNodes(children, sortState, similarityScores));
      }
    }
    return sorted;
  }, [childrenMap, sortState, semanticResults, similarityScores]);

  // Sort root nodes as well
  const sortedRootNodes = React.useMemo(() => {
    const hasSemanticSort = semanticResults && semanticResults.length > 0 && !sortState;

    if (hasSemanticSort) {
      return [...rootNodes].sort((a, b) => {
        const scoreA = similarityScores.get(a.id) ?? 0;
        const scoreB = similarityScores.get(b.id) ?? 0;
        return scoreB - scoreA;
      });
    }

    return sortNodes(rootNodes, sortState, similarityScores);
  }, [rootNodes, sortState, semanticResults, similarityScores]);

  // Apply filters (use sorted versions)
  // When filterToSemanticResults is true, filter to only show matching chunks and their ancestors
  // This applies even when semanticResults is empty (shows empty state)
  const { filteredRoots, filteredCount } = React.useMemo(() => {
    // If semantic filter is active, filter to matching nodes and ancestors
    // This includes the case where semanticResults is an empty array (0 results)
    if (filterToSemanticResults && semanticResults) {
      // Build set of all nodes to show (matching chunks + their ancestors)
      const visibleNodeIds = new Set<string>();

      // Add all matching chunks
      for (const result of semanticResults) {
        visibleNodeIds.add(result.nodeId);
      }

      // Add all ancestors
      for (const id of semanticExpandIds) {
        visibleNodeIds.add(id);
      }

      // Filter root nodes (will be empty if no results)
      const filtered = sortedRootNodes.filter((root) => visibleNodeIds.has(root.id));

      return { filteredRoots: filtered, filteredCount: semanticResults.length };
    }

    // Standard text filter logic
    if (!filters.searchQuery && filters.nodeTypes.size === 4 && filters.embeddingStatus === 'all') {
      return { filteredRoots: sortedRootNodes, filteredCount: allNodes.length };
    }

    // Create filter context (use sorted children map)
    const ctx: FilterContext = { filters, childrenMap: sortedChildrenMap };
    const filterFn = (node: TreeNode<BrowserNodeData>) => filterTreeNode(node, ctx);

    const filtered = sortedRootNodes.map(filterFn).filter(Boolean) as TreeNode<BrowserNodeData>[];

    // Count filtered nodes recursively
    let count = 0;
    function countNodes(nodes: TreeNode<BrowserNodeData>[]): void {
      for (const node of nodes) {
        if (filterFn(node)) {
          count++;
          const nodeChildren = sortedChildrenMap.get(node.id) ?? [];
          countNodes(nodeChildren);
        }
      }
    }
    countNodes(filtered);

    return { filteredRoots: filtered, filteredCount: count };
  }, [
    sortedRootNodes,
    allNodes,
    sortedChildrenMap,
    filters,
    semanticResults,
    filterToSemanticResults,
    semanticExpandIds,
  ]);

  // Flatten visible nodes based on expansion state (use sorted children)
  // When semantic results are present, only show nodes that are in the match set or ancestors
  const visibleNodes = React.useMemo(() => {
    const hasSemanticFilter: boolean = !!(
      semanticResults &&
      semanticResults.length > 0 &&
      filterToSemanticResults
    );

    // Build set of visible node IDs for semantic filtering
    const visibleNodeIds = new Set<string>();
    if (hasSemanticFilter && semanticResults) {
      for (const res of semanticResults) {
        visibleNodeIds.add(res.nodeId);
      }
      for (const id of semanticExpandIds) {
        visibleNodeIds.add(id);
      }
    }

    // Create filter context for checking nodes
    const filterCtx: FilterContext = { filters, childrenMap: sortedChildrenMap };

    return flattenVisibleNodes(
      filteredRoots,
      expandedIds,
      sortedChildrenMap,
      hasSemanticFilter,
      visibleNodeIds,
      filterCtx
    );
  }, [
    filteredRoots,
    expandedIds,
    sortedChildrenMap,
    semanticResults,
    filterToSemanticResults,
    semanticExpandIds,
    filters,
  ]);

  // Get children callback (returns sorted children, filtered appropriately)
  const getChildren = React.useCallback(
    (parentId: string): TreeNode<BrowserNodeData>[] => {
      const children = sortedChildrenMap.get(parentId) ?? [];

      // If semantic filter active, only return children that are visible
      if (semanticResults && semanticResults.length > 0 && filterToSemanticResults) {
        const visibleNodeIds = new Set<string>();
        for (const res of semanticResults) {
          visibleNodeIds.add(res.nodeId);
        }
        for (const id of semanticExpandIds) {
          visibleNodeIds.add(id);
        }
        return children.filter((c) => visibleNodeIds.has(c.id));
      }

      // Apply type/status/search filters to children
      const filterCtx: FilterContext = { filters, childrenMap: sortedChildrenMap };
      return children.filter((c) => filterTreeNode(c, filterCtx) !== null);
    },
    [sortedChildrenMap, semanticResults, filterToSemanticResults, semanticExpandIds, filters]
  );

  // Compute search match IDs and nodes to auto-expand (text search)
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
    similarityScores,
    semanticMatchIds,
    semanticExpandIds,
  };
}
