/**
 * useCollectionTree Hook
 *
 * Transforms flat database records into a hierarchical tree structure
 * for the Collection Browser. Handles filtering, sorting, and memoization.
 */

import { defaultCollator, englishCollator } from '@brainstrike/utils/collator';
import { getFileExtension } from '@brainstrike/utils/file-utils';
import * as React from 'react';
import { warnCycleOnce } from '../lib/cycle-warning';
import type { TreeNode } from '../tree-table/types';
import type {
  BrowserNodeData,
  ChunkData,
  CollectionBrowserFilters,
  CollectionNodeType,
  EmbeddingData,
  EmbeddingStatus,
  FileData,
  GroupByKey,
  GroupHeaderData,
  SemanticSearchResult,
} from './types';
import { EMBEDDING_STATUS_CONFIG, NODE_TYPE_CONFIG } from './types';

const EMPTY_VISIBLE_NODE_IDS = new Set<string>();
// Keep this derived from NODE_TYPE_CONFIG so adding a new node type
// automatically updates the default-filter fast-path check.
const ALL_COLLECTION_NODE_TYPE_COUNT = Object.keys(NODE_TYPE_CONFIG).length;
const MAX_WARNED_FILTER_CYCLE_NODE_IDS = 1000;

/**
 * Input data for building the collection tree
 */
export interface CollectionTreeInput {
  /** File chunks */
  chunks: Array<{
    content?: string;
    embeddingDimensions?: number;
    embeddingSetId?: string;
    hasEmbedding?: boolean;
    id: string;
    fileRecordId: string;
    chunkIndex: number;
    tokenCount: number;
    embedding?: number[];
  }>;
  /** File records */
  files: Array<{
    embeddedChunksCount?: number;
    id: string;
    name: string;
    path: string;
    size: number;
    embeddingSetId?: string;
    chunksCount?: number;
    processedAt?: string;
  }>;
  /** Pending chunk IDs (being embedded) */
  pendingChunkIds?: Set<string>;
}

/**
 * Sort key for hierarchical sorting.
 * Each key applies contextually to different node types:
 * - 'name': files by name, chunks by index
 * - 'size': files by file size, chunks by token count
 * - 'status': by embedding completion status
 * - 'count': files by chunk count
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
  /** Sort direction */
  direction: CollectionSortDirection;
  /** Sort key */
  key: CollectionSortKey;
}

/**
 * Options for the useCollectionTree hook
 */
export interface UseCollectionTreeOptions {
  /** Input data */
  data: CollectionTreeInput;
  /** Currently expanded node IDs */
  expandedIds: Set<string>;
  /** Current filter state */
  filters: CollectionBrowserFilters;
  /** Whether to filter tree to only show semantic results (default: true when results present) */
  filterToSemanticResults?: boolean;
  /** Grouping key for organizing nodes into groups (optional, default: 'none') */
  groupBy?: GroupByKey;
  /** Semantic search results to overlay on tree (optional) */
  semanticResults?: SemanticSearchResult[];
  /** Sort state (optional) */
  sortState?: CollectionSortState;
}

/**
 * Result from the useCollectionTree hook
 */
export interface UseCollectionTreeResult {
  /** Count of filtered/visible nodes */
  filteredCount: number;
  /** Get children for a node ID */
  getChildren: (parentId: string) => TreeNode<BrowserNodeData>[];
  /** Flattened nodes for rendering (respects expansion state) */
  nodes: TreeNode<BrowserNodeData>[];
  /** Root nodes (top-level collections) */
  rootNodes: TreeNode<BrowserNodeData>[];
  /** Node IDs that should be auto-expanded to reveal search matches */
  searchExpandIds: Set<string>;
  /** Node IDs that match the current search query (for highlighting) */
  searchMatchIds: Set<string>;
  /** Node IDs that should be auto-expanded to reveal semantic search matches */
  semanticExpandIds: Set<string>;
  /** Node IDs that match semantic search (subset of nodes) */
  semanticMatchIds: Set<string>;
  /** Map of node ID to similarity score (for score column in semantic search mode) */
  similarityScores: Map<string, number>;
  /** Total count of all nodes */
  totalCount: number;
}

/**
 * Determine embedding status for a file based on its chunks
 */
function getFileEmbeddingStatus(
  file: CollectionTreeInput['files'][0],
  fileChunks: CollectionTreeInput['chunks'],
  pendingChunkIds?: Set<string>
): EmbeddingStatus {
  const totalChunkCount = file.chunksCount ?? fileChunks.length;
  if (totalChunkCount === 0) {
    return 'none';
  }

  // Check live pending state before the embeddedChunksCount fast-path —
  // otherwise actively-embedding files show 'pending' instead of 'processing'.
  if (pendingChunkIds) {
    for (const c of fileChunks) {
      if (pendingChunkIds.has(c.id)) {
        return 'processing';
      }
    }
  }

  if (file.embeddedChunksCount !== undefined) {
    if (file.embeddedChunksCount >= totalChunkCount) {
      return 'complete';
    }
    if (file.embeddedChunksCount > 0) {
      return 'pending';
    }
  }

  let embeddedCount = 0;
  for (const c of fileChunks) {
    if ((c.embedding && c.embedding.length > 0) || c.hasEmbedding) {
      embeddedCount++;
    }
  }

  if (embeddedCount === totalChunkCount) {
    return 'complete';
  }
  if (embeddedCount > 0) {
    return 'pending';
  }
  return 'none';
}

/**
 * Build a map from fileRecordId to its chunks for O(1) lookup.
 */
function buildChunksByFileMap(
  chunks: CollectionTreeInput['chunks']
): Map<string, CollectionTreeInput['chunks']> {
  const map = new Map<string, CollectionTreeInput['chunks']>();
  for (const chunk of chunks) {
    const existing = map.get(chunk.fileRecordId);
    if (existing) {
      existing.push(chunk);
    } else {
      map.set(chunk.fileRecordId, [chunk]);
    }
  }
  return map;
}

/**
 * Determine embedding status for a chunk
 */
function getChunkEmbeddingStatus(
  chunk: CollectionTreeInput['chunks'][0],
  pendingChunkIds?: Set<string>
): EmbeddingStatus {
  if (pendingChunkIds?.has(chunk.id)) {
    return 'processing';
  }
  if ((chunk.embedding && chunk.embedding.length > 0) || chunk.hasEmbedding) {
    return 'complete';
  }
  return 'none';
}

function resolveEmbeddingDimensions(chunk: CollectionTreeInput['chunks'][0]): number {
  if (chunk.embedding && chunk.embedding.length > 0) {
    return chunk.embedding.length;
  }
  return chunk.embeddingDimensions ?? 0;
}

/**
 * Get searchable text fields from node data
 */
function getSearchableFields(node: TreeNode<BrowserNodeData>): string[] {
  const { data, type } = node;
  const fields: string[] = [type, node.id.replace(/^(collection|file|chunk|embedding)-/, '')];

  // Strings
  const stringFields = ['name', 'description', 'path', 'content'];
  for (const key of stringFields) {
    if (key in data && data[key as keyof typeof data]) {
      fields.push(String(data[key as keyof typeof data]));
    }
  }

  // Status and labels
  if ('embeddingStatus' in data && data.embeddingStatus) {
    fields.push(data.embeddingStatus);
    const config =
      EMBEDDING_STATUS_CONFIG[data.embeddingStatus as keyof typeof EMBEDDING_STATUS_CONFIG];
    if (config?.label) {
      fields.push(config.label);
    }
  }

  // Numbers
  const numFields = ['size', 'index', 'dimensions'];
  for (const key of numFields) {
    if (key in data && data[key as keyof typeof data] !== undefined) {
      fields.push(String(data[key as keyof typeof data]));
    }
  }

  // Context for chunks
  if (type === 'chunk') {
    const chunkData = data as ChunkData;
    if (chunkData.metadata?.['fileName']) {
      fields.push(chunkData.metadata['fileName'] as string);
    }
  }

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
    result = defaultCollator.compare(aVal, bVal);
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
  if (!sortState) {
    return nodes;
  }

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
  if (!searchQuery) {
    return true;
  }
  const query = searchQuery.toLowerCase();
  const fields = getSearchableFields(node);
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
    dimensions: resolveEmbeddingDimensions(chunk),
  };
  return {
    id: `embedding-${chunk.id}`,
    type: 'embedding',
    depth: 2,
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
  ctx: TreeBuildContext,
  fileName?: string
): TreeNode<BrowserNodeData> {
  const chunkStatus = getChunkEmbeddingStatus(chunk, pendingChunkIds);
  const hasEmbedding = Boolean(
    (chunk.embedding && chunk.embedding.length > 0) || chunk.hasEmbedding
  );

  const chunkData: ChunkData = {
    index: chunk.chunkIndex,
    content: chunk.content ?? '',
    tokenCount: chunk.tokenCount,
    embeddingStatus: chunkStatus,
  };

  if (fileName) {
    chunkData.metadata = { fileName };
  }

  const chunkNode: TreeNode<BrowserNodeData> = {
    id: `chunk-${chunk.id}`,
    type: 'chunk',
    depth: 1,
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
  parentId: string | null,
  data: CollectionTreeInput,
  ctx: TreeBuildContext,
  chunksByFile: Map<string, CollectionTreeInput['chunks']>
): TreeNode<BrowserNodeData> {
  const fileChunks = chunksByFile.get(file.id) ?? [];
  const totalChunkCount = file.chunksCount ?? fileChunks.length;
  const embeddingStatus = getFileEmbeddingStatus(file, fileChunks, data.pendingChunkIds);
  let embeddedChunks = file.embeddedChunksCount ?? 0;
  if (file.embeddedChunksCount === undefined) {
    for (const c of fileChunks) {
      if ((c.embedding && c.embedding.length > 0) || c.hasEmbedding) {
        embeddedChunks++;
      }
    }
  }
  const progress = totalChunkCount > 0 ? Math.round((embeddedChunks / totalChunkCount) * 100) : 0;

  const fileData: FileData = {
    name: file.name,
    path: file.path,
    size: file.size,
    chunkCount: totalChunkCount,
    embeddingStatus,
    embeddingProgress: progress,
  };
  if (file.processedAt) {
    fileData.importedAt = new Date(file.processedAt);
  }

  const fileNode: TreeNode<BrowserNodeData> = {
    id: `file-${file.id}`,
    type: 'file',
    depth: 0,
    data: fileData,
    parentId,
    hasChildren: totalChunkCount > 0,
  };

  ctx.all.push(fileNode);

  // Create chunk nodes
  const chunkNodes = fileChunks.map((chunk) =>
    createChunkNode(chunk, fileNode.id, data.pendingChunkIds, ctx, file.name)
  );
  ctx.children.set(fileNode.id, chunkNodes);

  return fileNode;
}

/**
 * Check if a node matches the embedding status filter
 */
function matchesEmbeddingStatus(
  node: TreeNode<BrowserNodeData>,
  status: EmbeddingStatus | 'all'
): boolean {
  if (status === 'all') {
    return true;
  }

  const data = node.data;
  if ('embeddingStatus' in data) {
    return data.embeddingStatus === status;
  }

  // Collections don't have status (they aggregate their children)
  return true;
}

/**
 * Check if a node directly matches the active standard filters
 * (type/search/status), without descendant visibility propagation.
 */
function matchesStandardNodeFilters(
  node: TreeNode<BrowserNodeData>,
  filters: CollectionBrowserFilters
): boolean {
  const nodeType = node.type as CollectionNodeType;
  const typeMatches = filters.nodeTypes.has(nodeType);
  if (!typeMatches) {
    return false;
  }
  if (!matchesSearch(node, filters.searchQuery)) {
    return false;
  }
  return matchesEmbeddingStatus(node, filters.embeddingStatus);
}

/**
 * Filter context for recursive node filtering
 */
interface FilterContext {
  childrenMap: Map<string, TreeNode<BrowserNodeData>[]>;
  filters: CollectionBrowserFilters;
}

/**
 * Creates a memoized matcher for filter visibility.
 * A node is visible when:
 * 1. It matches type/search/status filters itself, or
 * 2. It has any descendant that is visible.
 */
function createFilterMatcher(ctx: FilterContext): (node: TreeNode<BrowserNodeData>) => boolean {
  // Filter visibility is path-independent for current semantics, so node-id caching
  // is safe even when the structure is a DAG rather than a strict tree.
  const cache = new Map<string, boolean>();
  const visiting = new Set<string>();
  const warnedCycleNodeIds = new Set<string>();

  const matchesNode = (node: TreeNode<BrowserNodeData>): boolean => {
    const cached = cache.get(node.id);
    if (cached !== undefined) {
      return cached;
    }
    if (visiting.has(node.id)) {
      warnCycleOnce({
        nodeId: node.id,
        warnedNodeIds: warnedCycleNodeIds,
        maxWarnings: MAX_WARNED_FILTER_CYCLE_NODE_IDS,
        warningMessage: `[CollectionTree] Cycle detected while filtering node "${node.id}". Excluding this cycle path.`,
      });
      cache.set(node.id, false);
      return false;
    }

    visiting.add(node.id);
    try {
      const selfMatches = matchesStandardNodeFilters(node, ctx.filters);

      const children = ctx.childrenMap.get(node.id) ?? [];
      // Keep parent nodes visible when descendants match, even if the parent
      // itself does not match node type/search/status filters.
      // Intentionally short-circuit when self matches to avoid unnecessary
      // descendant traversal during visibility checks. In DAG-shaped inputs this
      // can reduce cache population for descendants, but it remains correct.
      // Filtered-count computation uses a separate direct matcher and traversal.
      const result = selfMatches || children.some((child) => matchesNode(child));
      cache.set(node.id, result);
      return result;
    } finally {
      visiting.delete(node.id);
    }
  };

  return matchesNode;
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
  matchesFilter: (node: TreeNode<BrowserNodeData>) => boolean
): boolean {
  // Group headers are structural nodes — they pass if any child is visible
  if (node.type === 'group') {
    if (hasSemanticFilter) {
      return visibleNodeIds.has(node.id);
    }
    return true;
  }
  if (hasSemanticFilter) {
    return visibleNodeIds.has(node.id);
  }
  return matchesFilter(node);
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
  matchesFilter: (node: TreeNode<BrowserNodeData>) => boolean
): TreeNode<BrowserNodeData>[] {
  const result: TreeNode<BrowserNodeData>[] = [];

  /**
   * Check if a group header has any visible children (recursive).
   * This ensures group headers are only shown when they contain visible content.
   */
  function groupHasVisibleChildren(groupId: string): boolean {
    const children = sortedChildrenMap.get(groupId) ?? [];
    return children.some((child) =>
      nodePassesFilter(child, hasSemanticFilter, visibleNodeIds, matchesFilter)
    );
  }

  function addNode(node: TreeNode<BrowserNodeData>): void {
    result.push(node);

    if (expandedIds.has(node.id)) {
      const children = sortedChildrenMap.get(node.id) ?? [];
      for (const child of children) {
        // Only add children that pass the filter
        if (nodePassesFilter(child, hasSemanticFilter, visibleNodeIds, matchesFilter)) {
          addNode(child);
        }
      }
    }
  }

  for (const root of filteredRoots) {
    // For group headers, only include if they have at least one visible child
    if (root.type === 'group' && !groupHasVisibleChildren(root.id)) {
      continue;
    }
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

  // Aggregate file scores from chunks
  aggregateScoresForType('file', allNodes, childrenMap, scores);

  return scores;
}

/**
 * Filter and build visible node IDs for semantic search results
 */
function buildSemanticVisibleNodeIds(
  semanticResults: SemanticSearchResult[],
  allNodes: TreeNode<BrowserNodeData>[],
  filterFn: (node: TreeNode<BrowserNodeData>) => boolean
): { visibleNodeIds: Set<string>; matchingCount: number } {
  const visibleNodeIds = new Set<string>();
  let matchingCount = 0;

  // Build node map for faster lookup
  const nodeMap = new Map<string, TreeNode<BrowserNodeData>>();
  for (const node of allNodes) {
    nodeMap.set(node.id, node);
  }

  for (const result of semanticResults) {
    const node = nodeMap.get(result.nodeId);
    if (node && filterFn(node)) {
      visibleNodeIds.add(result.nodeId);
      matchingCount++;

      // Walk up the tree and mark all ancestors for visibility
      let currentParentId = node.parentId;
      while (currentParentId) {
        visibleNodeIds.add(currentParentId);
        const parent = nodeMap.get(currentParentId);
        currentParentId = parent?.parentId ?? null;
      }
    }
  }

  return { visibleNodeIds, matchingCount };
}

function countMatchingNodes(
  roots: TreeNode<BrowserNodeData>[],
  childrenMap: Map<string, TreeNode<BrowserNodeData>[]>,
  matchesNodeFilters: (node: TreeNode<BrowserNodeData>) => boolean
): number {
  let count = 0;
  const visited = new Set<string>();

  function visit(node: TreeNode<BrowserNodeData>): void {
    if (visited.has(node.id)) {
      return;
    }
    visited.add(node.id);

    if (matchesNodeFilters(node)) {
      count++;
    }

    const children = childrenMap.get(node.id) ?? [];
    for (const child of children) {
      visit(child);
    }
  }

  // Count only nodes reachable from visible roots so orphaned/pre-flatten nodes
  // from intermediate transforms do not inflate filtered totals.
  for (const root of roots) {
    visit(root);
  }

  return count;
}

function includeGroupHeadersWithVisibleChildren(
  roots: TreeNode<BrowserNodeData>[],
  childrenMap: Map<string, TreeNode<BrowserNodeData>[]>,
  visibleNodeIds: Set<string>
): void {
  for (const root of roots) {
    if (root.type !== 'group') {
      continue;
    }
    const groupChildren = childrenMap.get(root.id) ?? [];
    const hasVisibleChild = groupChildren.some((child) => visibleNodeIds.has(child.id));
    if (hasVisibleChild) {
      visibleNodeIds.add(root.id);
    }
  }
}

function hasDefaultFilters(filters: CollectionBrowserFilters): boolean {
  return (
    !filters.searchQuery &&
    filters.nodeTypes.size === ALL_COLLECTION_NODE_TYPE_COUNT &&
    filters.embeddingStatus === 'all'
  );
}

function computeSemanticFilteredRoots(
  semanticResults: SemanticSearchResult[],
  allNodes: TreeNode<BrowserNodeData>[],
  roots: TreeNode<BrowserNodeData>[],
  childrenMap: Map<string, TreeNode<BrowserNodeData>[]>,
  matchesDirectNodeFilters: (node: TreeNode<BrowserNodeData>) => boolean
): { filteredRoots: TreeNode<BrowserNodeData>[]; filteredCount: number } {
  // Semantic results already identify concrete matching nodes.
  // We only need a direct matcher here; ancestor visibility is added by
  // the parent walk inside buildSemanticVisibleNodeIds.
  const { visibleNodeIds, matchingCount } = buildSemanticVisibleNodeIds(
    semanticResults,
    allNodes,
    matchesDirectNodeFilters
  );

  includeGroupHeadersWithVisibleChildren(roots, childrenMap, visibleNodeIds);

  return {
    filteredRoots: roots.filter((root) => visibleNodeIds.has(root.id)),
    filteredCount: matchingCount,
  };
}

function computeStandardFilteredRoots(
  filters: CollectionBrowserFilters,
  allNodes: TreeNode<BrowserNodeData>[],
  roots: TreeNode<BrowserNodeData>[],
  childrenMap: Map<string, TreeNode<BrowserNodeData>[]>,
  // Visibility matcher supports descendant propagation for tree display.
  matchesVisibleFilter: (node: TreeNode<BrowserNodeData>) => boolean,
  // Node matcher is direct-only and used for leaf-count reporting.
  matchesNodeFilters: (node: TreeNode<BrowserNodeData>) => boolean
): { filteredRoots: TreeNode<BrowserNodeData>[]; filteredCount: number } {
  if (hasDefaultFilters(filters)) {
    return { filteredRoots: roots, filteredCount: allNodes.length };
  }

  return {
    filteredRoots: roots.filter((root) => matchesVisibleFilter(root)),
    filteredCount: countMatchingNodes(roots, childrenMap, matchesNodeFilters),
  };
}

/**
 * Formats a file extension for display as a group label.
 * Wraps the canonical getFileExtension (which returns "ts")
 * to produce ".ts" with leading dot, or "No extension" for bare names.
 */
function getFileExtensionForGrouping(fileName: string): string {
  const ext = getFileExtension(fileName);
  return ext ? `.${ext}` : 'No extension';
}

/**
 * Get group key value for a file node based on the grouping key.
 */
function getGroupValue(node: TreeNode<BrowserNodeData>, groupBy: GroupByKey): string {
  if (node.type !== 'file') {
    return '';
  }
  const fileData = node.data as FileData;
  switch (groupBy) {
    case 'status':
      return fileData.embeddingStatus;
    case 'type':
      return getFileExtensionForGrouping(fileData.name);
    default:
      return '';
  }
}

/**
 * Get a display label for a group value.
 */
function getGroupLabel(groupBy: GroupByKey, groupValue: string): string {
  if (groupBy === 'status') {
    const config = EMBEDDING_STATUS_CONFIG[groupValue as keyof typeof EMBEDDING_STATUS_CONFIG];
    return config?.label ?? groupValue;
  }
  return groupValue;
}

/**
 * Re-depth chunks and embeddings under a reparented file, updating
 * the children map and node registry.
 */
function reparentFileDescendants(
  file: TreeNode<BrowserNodeData>,
  groupedChildrenMap: Map<string, TreeNode<BrowserNodeData>[]>,
  allNodesById: Map<string, TreeNode<BrowserNodeData>>
): void {
  const fileChildren = groupedChildrenMap.get(file.id);
  if (!fileChildren) {
    return;
  }

  const reparentedChunks = fileChildren.map((chunk) => ({
    ...chunk,
    depth: 2,
  }));
  groupedChildrenMap.set(file.id, reparentedChunks);

  for (const chunk of reparentedChunks) {
    allNodesById.set(chunk.id, chunk);

    const chunkChildren = groupedChildrenMap.get(chunk.id);
    if (chunkChildren) {
      const reparentedEmbeddings = chunkChildren.map((emb) => ({
        ...emb,
        depth: 3,
      }));
      groupedChildrenMap.set(chunk.id, reparentedEmbeddings);

      for (const emb of reparentedEmbeddings) {
        allNodesById.set(emb.id, emb);
      }
    }
  }
}

/**
 * Organize root file nodes into groups based on a grouping key.
 * Returns new root nodes (group headers) with file nodes as children,
 * along with updated children and all-nodes maps.
 */
function applyGrouping(
  rootNodes: TreeNode<BrowserNodeData>[],
  childrenMap: Map<string, TreeNode<BrowserNodeData>[]>,
  allNodes: TreeNode<BrowserNodeData>[],
  groupBy: GroupByKey
): {
  groupedRoots: TreeNode<BrowserNodeData>[];
  groupedChildrenMap: Map<string, TreeNode<BrowserNodeData>[]>;
  groupedAllNodes: TreeNode<BrowserNodeData>[];
} {
  if (groupBy === 'none') {
    return {
      groupedRoots: rootNodes,
      groupedChildrenMap: childrenMap,
      groupedAllNodes: allNodes,
    };
  }

  // Group file nodes by the grouping key
  const groups = new Map<string, TreeNode<BrowserNodeData>[]>();
  for (const root of rootNodes) {
    const groupValue = getGroupValue(root, groupBy);
    if (!groups.has(groupValue)) {
      groups.set(groupValue, []);
    }
    groups.get(groupValue)?.push(root);
  }

  // Create group header nodes and rebuild the tree
  const groupedRoots: TreeNode<BrowserNodeData>[] = [];
  const groupedChildrenMap = new Map(childrenMap);

  // Build a mutable map of allNodes by ID so reparented versions replace originals
  const allNodesById = new Map<string, TreeNode<BrowserNodeData>>();
  for (const node of allNodes) {
    allNodesById.set(node.id, node);
  }

  // Sort groups by label
  const sortedGroupEntries = [...groups.entries()].sort(([a], [b]) =>
    englishCollator.compare(getGroupLabel(groupBy, a), getGroupLabel(groupBy, b))
  );

  for (const [groupValue, files] of sortedGroupEntries) {
    const groupId = `group-${groupBy}-${groupValue}`;
    const groupLabel = getGroupLabel(groupBy, groupValue);

    const groupHeaderData: GroupHeaderData = {
      groupLabel,
      groupKey: groupBy,
      groupValue,
      itemCount: files.length,
    };

    const groupNode: TreeNode<BrowserNodeData> = {
      id: groupId,
      type: 'group',
      depth: 0,
      data: groupHeaderData,
      parentId: null,
      hasChildren: files.length > 0,
      childCount: files.length,
    };

    groupedRoots.push(groupNode);
    allNodesById.set(groupNode.id, groupNode);

    // Re-parent file nodes under the group header
    const reparentedFiles = files.map((file) => ({
      ...file,
      depth: 1,
      parentId: groupId,
    }));

    // Replace original file entries and re-depth descendants
    for (const file of reparentedFiles) {
      allNodesById.set(file.id, file);
      reparentFileDescendants(file, groupedChildrenMap, allNodesById);
    }

    groupedChildrenMap.set(groupId, reparentedFiles);
  }

  const groupedAllNodes = [...allNodesById.values()];

  return { groupedRoots, groupedChildrenMap, groupedAllNodes };
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
  groupBy = 'none',
}: UseCollectionTreeOptions): UseCollectionTreeResult {
  // Build the tree structure using helper functions
  const {
    rootNodes: rawRootNodes,
    allNodes: rawAllNodes,
    childrenMap: rawChildrenMap,
  } = React.useMemo(() => {
    const ctx: TreeBuildContext = {
      all: [],
      children: new Map<string, TreeNode<BrowserNodeData>[]>(),
    };

    // Pre-build chunk lookup map: O(C) once instead of O(F×C) per file
    const chunksByFile = buildChunksByFileMap(data.chunks);

    const roots = data.files.map((file) => createFileNode(file, null, data, ctx, chunksByFile));

    return { rootNodes: roots, allNodes: ctx.all, childrenMap: ctx.children };
  }, [data]);

  // Apply grouping if a groupBy key is set
  const { rootNodes, allNodes, childrenMap } = React.useMemo(() => {
    if (groupBy === 'none') {
      return {
        rootNodes: rawRootNodes,
        allNodes: rawAllNodes,
        childrenMap: rawChildrenMap,
      };
    }
    const { groupedRoots, groupedChildrenMap, groupedAllNodes } = applyGrouping(
      rawRootNodes,
      rawChildrenMap,
      rawAllNodes,
      groupBy
    );
    return {
      rootNodes: groupedRoots,
      allNodes: groupedAllNodes,
      childrenMap: groupedChildrenMap,
    };
  }, [rawRootNodes, rawAllNodes, rawChildrenMap, groupBy]);

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

    if (!(sortState || hasSemanticSort)) {
      return childrenMap;
    }

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
  // When roots are group headers, preserve their alphabetical order from applyGrouping
  const sortedRootNodes = React.useMemo(() => {
    const firstRoot = rootNodes[0];
    const hasGroupRoots = firstRoot !== undefined && firstRoot.type === 'group';

    // Group headers maintain their own ordering — don't sort them
    if (hasGroupRoots) {
      return rootNodes;
    }

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

  const filterContext = React.useMemo<FilterContext>(
    () => ({
      filters,
      childrenMap: sortedChildrenMap,
    }),
    [filters, sortedChildrenMap]
  );

  const matchesStandardFilters = React.useMemo(
    () => createFilterMatcher(filterContext),
    [filterContext]
  );
  const matchesDirectNodeFilters = React.useCallback(
    (node: TreeNode<BrowserNodeData>) => matchesStandardNodeFilters(node, filters),
    [filters]
  );

  // Apply filters (use sorted versions)
  // When filterToSemanticResults is true, filter to only show matching chunks and their ancestors
  // This applies even when semanticResults is empty (shows empty state)
  const { filteredRoots, filteredCount } = React.useMemo(() => {
    // If semantic filter is active, filter to matching nodes and ancestors
    // This includes the case where semanticResults is an empty array (0 results)
    if (filterToSemanticResults && semanticResults) {
      return computeSemanticFilteredRoots(
        semanticResults,
        allNodes,
        sortedRootNodes,
        sortedChildrenMap,
        matchesDirectNodeFilters
      );
    }

    return computeStandardFilteredRoots(
      filters,
      allNodes,
      sortedRootNodes,
      sortedChildrenMap,
      matchesStandardFilters,
      matchesDirectNodeFilters
    );
  }, [
    sortedRootNodes,
    allNodes,
    sortedChildrenMap,
    semanticResults,
    filterToSemanticResults,
    filters,
    matchesStandardFilters,
    matchesDirectNodeFilters,
  ]);

  const semanticVisibleNodeIds = React.useMemo((): Set<string> | null => {
    if (!(semanticResults && semanticResults.length > 0 && filterToSemanticResults)) {
      return null;
    }

    const visibleNodeIds = new Set<string>();
    for (const result of semanticResults) {
      visibleNodeIds.add(result.nodeId);
    }
    for (const id of semanticExpandIds) {
      visibleNodeIds.add(id);
    }

    return visibleNodeIds;
  }, [semanticResults, semanticExpandIds, filterToSemanticResults]);

  // Flatten visible nodes based on expansion state (use sorted children)
  // When semantic results are present, only show nodes that are in the match set or ancestors
  const visibleNodes = React.useMemo(() => {
    const hasSemanticFilter = semanticVisibleNodeIds !== null;

    return flattenVisibleNodes(
      filteredRoots,
      expandedIds,
      sortedChildrenMap,
      hasSemanticFilter,
      semanticVisibleNodeIds ?? EMPTY_VISIBLE_NODE_IDS,
      matchesStandardFilters
    );
  }, [
    filteredRoots,
    expandedIds,
    sortedChildrenMap,
    semanticVisibleNodeIds,
    matchesStandardFilters,
  ]);

  // Get children callback (returns sorted children, filtered appropriately)
  const getChildren = React.useCallback(
    (parentId: string): TreeNode<BrowserNodeData>[] => {
      const children = sortedChildrenMap.get(parentId) ?? [];

      // If semantic filter active, only return children that are visible
      if (semanticVisibleNodeIds) {
        return children.filter((child) => semanticVisibleNodeIds.has(child.id));
      }

      return children.filter((child) => matchesStandardFilters(child));
    },
    [sortedChildrenMap, semanticVisibleNodeIds, matchesStandardFilters]
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
