/**
 * CollectionBrowserView Component
 *
 * Wrapper that connects the CollectionBrowser from @brainstrike/ui
 * to the database demo panel's data sources.
 *
 * Provides persistent state management for:
 * - Expanded/collapsed tree nodes
 * - Selected node
 * - Sort state (column and direction)
 * - Inspector panel collapsed state
 * - Semantic search mode and configuration
 */

import {
  type AnyContextAction,
  createClipboardService,
  defineContextAction,
} from '@brainstrike/context-actions';
import type { FileChunk } from '@brainstrike/db';
import { useCollectionBrowserColumnSizesStore } from '@brainstrike/preferences';
import {
  ActionContextMenu,
  type BrowserNodeData,
  type BulkAction,
  Button,
  CollectionBrowser,
  type CollectionBrowserFilters,
  CollectionBrowserToolbar,
  type CollectionNodeType,
  type CollectionSortState,
  type CollectionTreeInput,
  type EmbeddingStatus,
  type GroupByKey,
  NodeInspector,
  type SearchConfig,
  SearchConfigPanel,
  type SearchMode,
  SearchModeBar,
  TablePagination,
  useContextMenuTarget,
} from '@brainstrike/ui';
import { createLogger } from '@brainstrike/utils/logger';
import {
  ChevronLeft,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Copy,
  Eye,
  SquareCheck,
} from 'lucide-react';
import type * as React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Group, Panel, type PanelImperativeHandle, Separator } from 'react-resizable-panels';
import { type BrowserNodeDescriptor, browserNodeToTarget } from '../context-actions';
import { useSemanticSearch } from '../contexts/semantic-search-context';
import { useCollectionBrowserStore } from '../stores/collection-browser-store';
import type {
  DatabaseFileChunkSummary,
  DatabaseFileRecordSummary,
} from '../use-database-demo-data';
import { CollectionEmbeddingCoverageBanner } from './embedding-coverage-notice';

const logger = createLogger('CollectionBrowserView');
const clipboard = createClipboardService();

function SearchErrorBanner({ message }: { message: string | null }) {
  if (!message) {
    return null;
  }
  return (
    <div className="border-border border-b bg-destructive/10 px-3 py-2 text-destructive text-sm">
      {message}
    </div>
  );
}

type NodeIdPrefix = Extract<CollectionNodeType, 'collection' | 'file' | 'chunk' | 'embedding'>;
const NODE_ID_PREFIXES = [
  'collection',
  'file',
  'chunk',
  'embedding',
] as const satisfies readonly NodeIdPrefix[];
const NODE_ID_PREFIX_PATTERN = new RegExp(`^(${NODE_ID_PREFIXES.join('|')})-(.+)$`);
const EMBEDDING_TREE_PAGE_SIZE_OPTIONS = [25, 50, 100, 250] as const;
const LARGE_COLLECTION_BROWSER_RECORD_THRESHOLD = 250;
const LARGE_COLLECTION_BROWSER_CHUNK_THRESHOLD = 1000;

export interface CollectionBrowserPaginationState {
  currentPage: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  pageSize: number;
  totalRecords: number;
}

function isNodeIdPrefix(value: string): value is NodeIdPrefix {
  return NODE_ID_PREFIXES.some((prefix) => prefix === value);
}

function parseNodeId(nodeId: string): {
  nodeType: NodeIdPrefix | null;
  originalId: string;
} {
  const match = NODE_ID_PREFIX_PATTERN.exec(nodeId);
  if (!match) {
    return { nodeType: null, originalId: nodeId };
  }

  const nodeType = match[1];
  const originalId = match[2];
  if (nodeType === undefined || originalId === undefined || !isNodeIdPrefix(nodeType)) {
    return { nodeType: null, originalId: nodeId };
  }

  return { nodeType, originalId };
}

/**
 * BrowserNodeData is a union without a discriminant, so probe the optional
 * fields structurally (strict mode, no `any`) to build the context-target
 * descriptor for the shared action menu.
 */
function toBrowserNodeDescriptor(
  nodeType: string,
  originalId: string,
  data: BrowserNodeData
): BrowserNodeDescriptor {
  const probe = data as {
    content?: unknown;
    name?: unknown;
    path?: unknown;
    vectorId?: unknown;
  };
  return {
    nodeType,
    originalId,
    ...(typeof probe.content === 'string' ? { content: probe.content } : {}),
    ...(typeof probe.name === 'string' ? { name: probe.name } : {}),
    ...(typeof probe.path === 'string' ? { path: probe.path } : {}),
    ...(typeof probe.vectorId === 'string' ? { vectorId: probe.vectorId } : {}),
  };
}

function canUseCollectionForNormalSearch(
  activeCollectionId: string | null,
  activeCollectionSystemRole: 'workspace-index' | null | undefined
): activeCollectionId is string {
  return activeCollectionId !== null && activeCollectionSystemRole !== 'workspace-index';
}

function getNormalSearchDisabledReason(
  activeCollectionSystemRole: 'workspace-index' | null | undefined
): string | undefined {
  if (activeCollectionSystemRole !== 'workspace-index') {
    return;
  }
  return 'Workspace Index is system-managed and cannot be used for normal collection search.';
}

export interface CollectionBrowserViewProps {
  /** Active collection ID */
  activeCollectionId: string | null;
  /** Display name for embedding coverage notices */
  activeCollectionName?: string;
  /** Durable system role for the active collection, when known. */
  activeCollectionSystemRole?: 'workspace-index' | null;
  /** File chunks */
  chunks: DatabaseFileChunkSummary[];
  /** Height of the browser */
  height?: number | string;
  /** Loading state */
  isLoading?: boolean;
  /** Load full chunk content only for the selected inspector node. */
  loadChunkDetail?: (chunkId: string) => Promise<FileChunk | null>;
  /** Load chunk summaries only for a specific file when the user expands it. */
  loadFileChunkSummaries?: (fileRecordId: string) => Promise<DatabaseFileChunkSummary[]>;
  /** Called when a chunk is selected */
  onChunkSelect?: (chunkId: string, chunk: FileChunk) => void;
  /** Called when a file is selected */
  onFileSelect?: (fileId: string, file: DatabaseFileRecordSummary) => void;
  /** Source pagination for the active collection file list. */
  pagination?: CollectionBrowserPaginationState;
  /** Pending chunk IDs (being embedded) */
  pendingChunkIds?: Set<string>;
  /** File records */
  records: DatabaseFileRecordSummary[];
}

/**
 * Transform database data into CollectionTreeInput format
 */
function transformToTreeInput(
  records: DatabaseFileRecordSummary[],
  chunks: DatabaseFileChunkSummary[],
  activeCollectionId: string | null,
  pendingChunkIds?: Set<string>
): CollectionTreeInput {
  const filteredRecords = activeCollectionId
    ? records.filter((r) => r.embeddingSetId === activeCollectionId)
    : records;

  const filteredChunks = activeCollectionId
    ? chunks.filter((c) => c.embeddingSetId === activeCollectionId)
    : chunks;

  return {
    chunks: filteredChunks.map((chunk) => {
      const chunkItem: {
        id: string;
        fileRecordId: string;
        chunkIndex: number;
        tokenCount: number;
        hasEmbedding: boolean;
        embeddingDimensions?: number;
        embeddingSetId?: string;
      } = {
        chunkIndex: chunk.chunkIndex,
        fileRecordId: chunk.fileRecordId,
        hasEmbedding: chunk.hasEmbedding ?? false,
        id: chunk.id,
        tokenCount: chunk.tokenCount,
      };
      if ((chunk.hasEmbedding ?? false) && (chunk.embeddingDimensions ?? 0) > 0) {
        chunkItem.embeddingDimensions = chunk.embeddingDimensions ?? 0;
      }
      if (chunk.embeddingSetId) {
        chunkItem.embeddingSetId = chunk.embeddingSetId;
      }
      return chunkItem;
    }),
    files: filteredRecords.map((record) => {
      const file: {
        embeddedChunksCount?: number;
        id: string;
        name: string;
        path: string;
        size: number;
        embeddingSetId?: string;
        chunksCount?: number;
        processedAt?: string;
      } = {
        id: record.id,
        name: record.name,
        path: record.path,
        size: record.size,
      };
      if (record.embeddingSetId) {
        file.embeddingSetId = record.embeddingSetId;
      }
      if (record.chunksCount !== undefined) {
        file.chunksCount = record.chunksCount;
      }
      if (record.embeddedChunksCount !== undefined) {
        file.embeddedChunksCount = record.embeddedChunksCount;
      }
      if (record.processedAt) {
        file.processedAt = record.processedAt;
      }
      return file;
    }),
    ...(pendingChunkIds ? { pendingChunkIds } : {}),
  };
}

/**
 * Build file node data from the selected file
 */
function buildFileData(
  fileId: string,
  records: DatabaseFileRecordSummary[],
  chunks: DatabaseFileChunkSummary[]
): BrowserNodeData | null {
  const file = records.find((r) => r.id === fileId);
  if (!file) {
    return null;
  }
  const fileChunks = chunks.filter((c) => c.fileRecordId === file.id);
  const totalChunkCount = file.chunksCount ?? fileChunks.length;
  const embeddedChunkCount =
    file.embeddedChunksCount ?? fileChunks.filter((c) => c.hasEmbedding).length;
  const hasAllEmbeddings = totalChunkCount > 0 && embeddedChunkCount >= totalChunkCount;
  const hasSomeEmbeddings = embeddedChunkCount > 0;
  return {
    chunkCount: totalChunkCount,
    embeddingProgress:
      totalChunkCount > 0 ? Math.round((embeddedChunkCount / totalChunkCount) * 100) : 0,
    embeddingStatus: hasAllEmbeddings ? 'complete' : hasSomeEmbeddings ? 'pending' : 'none',
    name: file.name,
    path: file.path,
    size: file.size,
  };
}

/**
 * Build chunk node data from the selected chunk
 */
function buildChunkData(chunkId: string, chunks: FileChunk[]): BrowserNodeData | null {
  const chunk = chunks.find((c) => c.id === chunkId);
  if (!chunk) {
    return null;
  }
  return {
    content: chunk.content,
    embeddingStatus: chunk.embedding && chunk.embedding.length > 0 ? 'complete' : 'none',
    index: chunk.chunkIndex,
    tokenCount: chunk.tokenCount,
  };
}

/**
 * Build embedding node data from the selected chunk
 */
function buildEmbeddingData(chunkId: string, chunks: FileChunk[]): BrowserNodeData | null {
  const chunk = chunks.find((c) => c.id === chunkId);
  if (!chunk?.embedding) {
    return null;
  }
  return {
    dimensions: chunk.embedding.length,
    vectorId: chunk.id,
  };
}

/**
 * Build selected node data based on node type
 */
function buildSelectedNodeData(
  nodeType: string,
  nodeId: string,
  chunks: FileChunk[]
): BrowserNodeData | null {
  switch (nodeType) {
    case 'chunk':
      return buildChunkData(nodeId, chunks);
    case 'embedding':
      return buildEmbeddingData(nodeId, chunks);
    default:
      return null;
  }
}

/** File-list pagination footer. Extracted so the collection browser stays under
 * the cognitive-complexity budget and the pager's page math lives in one place. */
function CollectionBrowserPaginationFooter({
  pagination,
}: {
  pagination: CollectionBrowserPaginationState;
}) {
  return (
    <TablePagination
      currentPage={pagination.currentPage}
      onPageChange={pagination.onPageChange}
      onPageSizeChange={pagination.onPageSizeChange}
      pageInfo="files"
      pageSize={pagination.pageSize}
      pageSizeOptions={EMBEDDING_TREE_PAGE_SIZE_OPTIONS}
      showItemRange
      totalItems={pagination.totalRecords}
      totalPages={Math.max(
        1,
        Math.ceil(pagination.totalRecords / Math.max(1, pagination.pageSize))
      )}
    />
  );
}

/**
 * CollectionBrowserView - Connects CollectionBrowser to database data
 */
export function CollectionBrowserView({
  records,
  chunks,
  pendingChunkIds,
  activeCollectionId,
  activeCollectionName,
  activeCollectionSystemRole = null,
  isLoading = false,
  height = 500,
  onFileSelect,
  onChunkSelect,
  loadChunkDetail,
  loadFileChunkSummaries,
  pagination,
}: CollectionBrowserViewProps) {
  // Use persistent store for all UI state
  const {
    expandedIds,
    selectedId,
    sortState,
    isInspectorCollapsed,
    inspectorWidth,
    setExpandedIds,
    removeExpandedIds,
    setSelectedId,
    setSortState,
    setInspectorCollapsed,
    setInspectorWidth,
    // Filter state from store
    searchQuery,
    nodeTypes,
    embeddingStatus,
    setSearchQuery,
    setNodeTypes,
    setEmbeddingStatus,
    // Semantic search state from store
    searchMode,
    semanticQuery,
    searchConfigThreshold,
    searchConfigLimit,
    searchConfigDistanceMetric,
    // Hybrid search state from store
    searchConfigRetrievalMode,
    searchConfigVectorWeight,
    searchConfigFtsWeight,
    searchPanelExpanded,
    setSearchMode,
    setSemanticQuery,
    setSearchConfigThreshold,
    setSearchConfigLimit,
    setSearchConfigDistanceMetric,
    // Hybrid search setters
    setSearchConfigRetrievalMode,
    setSearchConfigVectorWeight,
    setSearchConfigFtsWeight,
    setSearchPanelExpanded,
    // Grouping and checkbox state
    groupBy,
    showCheckbox,
    multiSelectEnabled,
    setGroupBy,
    setShowCheckbox,
    setMultiSelectEnabled,
    toggleExpanded,
    expandIds,
  } = useCollectionBrowserStore();

  // Column widths are persisted independently from the rest of the collection
  // browser state so factory-reset + schema migration stays scoped per-surface.
  const columnSizes = useCollectionBrowserColumnSizesStore(
    (state: { sizes: Record<string, number> }) => state.sizes
  );
  const setColumnSizes = useCollectionBrowserColumnSizesStore(
    (state: { setAll: (next: Record<string, number>) => void }) => state.setAll
  );

  // Convert store filter state to CollectionBrowserFilters format
  const filters = useMemo(
    (): CollectionBrowserFilters => ({
      embeddingStatus: embeddingStatus as EmbeddingStatus | 'all',
      nodeTypes: new Set(nodeTypes as CollectionNodeType[]),
      searchMatchesOnly: false,
      searchQuery,
    }),
    [searchQuery, nodeTypes, embeddingStatus]
  );

  // Handle filter changes from CollectionBrowser
  const handleFiltersChange = useCallback(
    (newFilters: CollectionBrowserFilters) => {
      setSearchQuery(newFilters.searchQuery);
      setNodeTypes(Array.from(newFilters.nodeTypes));
      setEmbeddingStatus(newFilters.embeddingStatus);
    },
    [setSearchQuery, setNodeTypes, setEmbeddingStatus]
  );

  // Handle collapse all
  const handleCollapseAll = useCallback(() => {
    setExpandedIds([]);
  }, [setExpandedIds]);

  // Get semantic search transient state from context
  const {
    searchResults,
    isSearching,
    hasSearched,
    error: searchError,
    executeSearch,
    clearResults,
  } = useSemanticSearch();

  // Convert expanded IDs array to Set for CollectionBrowser
  const expandedIdsSet = useMemo(() => new Set(expandedIds), [expandedIds]);

  // State for selected node inspection (derived from store selectedId)
  const { selectedNodeType, selectedNodeId } = useMemo(() => {
    if (!selectedId) {
      return { selectedNodeId: null, selectedNodeType: null };
    }
    const { nodeType, originalId } = parseNodeId(selectedId);
    if (!nodeType) {
      return { selectedNodeId: null, selectedNodeType: null };
    }
    return {
      selectedNodeId: originalId,
      selectedNodeType: nodeType,
    };
  }, [selectedId]);

  // The cog (advanced options) popover is ephemeral UI — it should default to
  // closed each session rather than persist, so it never auto-pops on load.
  const [advancedOptionsOpen, setAdvancedOptionsOpen] = useState(false);

  const [selectedChunkDetail, setSelectedChunkDetail] = useState<FileChunk | null>(null);
  const treeDiagnosticSignatureRef = useRef<string | null>(null);

  const ensureFileChunksLoaded = useCallback(
    async (fileRecordId: string): Promise<DatabaseFileChunkSummary[]> => {
      if (!loadFileChunkSummaries) {
        return [];
      }
      const loadedChunks = chunks.filter((chunk) => chunk.fileRecordId === fileRecordId);
      if (loadedChunks.length > 0) {
        return loadedChunks;
      }
      return loadFileChunkSummaries(fileRecordId);
    },
    [chunks, loadFileChunkSummaries]
  );

  useEffect(() => {
    if (!(selectedNodeType === 'chunk' && selectedNodeId && loadChunkDetail)) {
      setSelectedChunkDetail(null);
      return;
    }

    let cancelled = false;
    setSelectedChunkDetail(null);

    const loadSelectedChunk = async () => {
      try {
        const detail = await loadChunkDetail(selectedNodeId);
        if (!cancelled) {
          setSelectedChunkDetail(detail);
        }
      } catch (error: unknown) {
        logger.warn('Failed to load selected chunk detail', {
          chunkId: selectedNodeId,
          error,
        });
      }
    };

    void loadSelectedChunk();

    return () => {
      cancelled = true;
    };
  }, [loadChunkDetail, selectedNodeId, selectedNodeType]);

  // Build selected node data based on node type
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Selection inspection spans file, chunk, and embedding detail paths in one memoized branch.
  const actualSelectedNodeData = useMemo((): BrowserNodeData | null => {
    if (!(selectedId && selectedNodeType && selectedNodeId)) {
      return null;
    }

    if (selectedNodeType === 'chunk') {
      if (!selectedChunkDetail) {
        const selectedChunk = chunks.find((chunk) => chunk.id === selectedNodeId);
        if (!selectedChunk) {
          return null;
        }
        return {
          content: 'Loading chunk content...',
          embeddingStatus: selectedChunk.hasEmbedding ? 'complete' : 'none',
          index: selectedChunk.chunkIndex,
          tokenCount: selectedChunk.tokenCount,
        };
      }
      return buildSelectedNodeData(selectedNodeType, selectedNodeId, [selectedChunkDetail]);
    }

    if (selectedNodeType === 'embedding') {
      const selectedChunk = chunks.find((chunk) => chunk.id === selectedNodeId);
      if (!selectedChunk) {
        return null;
      }
      if (
        !((selectedChunk.hasEmbedding ?? false) && (selectedChunk.embeddingDimensions ?? 0) > 0)
      ) {
        return null;
      }
      return {
        dimensions: selectedChunk.embeddingDimensions ?? 0,
        vectorId: selectedNodeId,
      };
    }

    if (selectedNodeType === 'file') {
      return buildFileData(selectedNodeId, records, chunks);
    }

    return null;
  }, [selectedChunkDetail, selectedId, selectedNodeId, selectedNodeType, records, chunks]);

  const hasInspectableSelection = useMemo(
    () => selectedNodeType !== null && selectedNodeId !== null && actualSelectedNodeData !== null,
    [selectedNodeType, selectedNodeId, actualSelectedNodeData]
  );

  // Handle expansion state changes
  const handleExpandedIdsChange = useCallback(
    (ids: Set<string>) => {
      const newlyExpandedFileIds: string[] = [];
      for (const id of ids) {
        if (expandedIdsSet.has(id)) {
          continue;
        }
        const { nodeType, originalId } = parseNodeId(id);
        if (nodeType === 'file') {
          newlyExpandedFileIds.push(originalId);
        }
      }
      for (const fileRecordId of newlyExpandedFileIds) {
        void ensureFileChunksLoaded(fileRecordId);
      }
      setExpandedIds(Array.from(ids));
    },
    [ensureFileChunksLoaded, expandedIdsSet, setExpandedIds]
  );

  const handleExpandAll = useCallback(() => {
    const allExpandableIds = new Set<string>();
    for (const record of records) {
      if ((record.chunksCount ?? 0) > 0) {
        allExpandableIds.add(`file-${record.id}`);
      }
    }
    logger.info('Collection browser expand-all requested', {
      activeCollectionId,
      expandableFileCount: allExpandableIds.size,
      loadedChunkCount: chunks.length,
      page: pagination?.currentPage ?? null,
      pageSize: pagination?.pageSize ?? null,
      recordCount: records.length,
      searchMode,
      semanticResultCount: searchResults.length,
      totalRecords: pagination?.totalRecords ?? records.length,
    });
    handleExpandedIdsChange(allExpandableIds);
  }, [
    activeCollectionId,
    chunks.length,
    handleExpandedIdsChange,
    pagination,
    records,
    searchMode,
    searchResults.length,
  ]);

  // Handle selection changes
  const handleSelectedIdChange = useCallback(
    (id: string | null) => {
      setSelectedId(id);
    },
    [setSelectedId]
  );

  // Handle sort changes
  const handleSortChange = useCallback(
    (newSortState: CollectionSortState | null) => {
      setSortState(newSortState);
    },
    [setSortState]
  );

  // Build search config from store values
  const searchConfig: SearchConfig = useMemo(
    () => ({
      distanceMetric: searchConfigDistanceMetric,
      ftsWeight: searchConfigFtsWeight,
      resultLimit: searchConfigLimit,
      retrievalMode: searchConfigRetrievalMode,
      threshold: searchConfigThreshold,
      vectorWeight: searchConfigVectorWeight,
    }),
    [
      searchConfigThreshold,
      searchConfigLimit,
      searchConfigDistanceMetric,
      searchConfigRetrievalMode,
      searchConfigVectorWeight,
      searchConfigFtsWeight,
    ]
  );

  // Handle search config changes (persists all settings including hybrid mode)
  const handleSearchConfigChange = useCallback(
    (config: SearchConfig) => {
      setSearchConfigThreshold(config.threshold);
      setSearchConfigLimit(config.resultLimit);
      setSearchConfigDistanceMetric(config.distanceMetric);
      // Persist hybrid search settings when provided
      if (config.retrievalMode !== undefined) {
        setSearchConfigRetrievalMode(config.retrievalMode);
      }
      if (config.vectorWeight !== undefined) {
        setSearchConfigVectorWeight(config.vectorWeight);
      }
      if (config.ftsWeight !== undefined) {
        setSearchConfigFtsWeight(config.ftsWeight);
      }
    },
    [
      setSearchConfigThreshold,
      setSearchConfigLimit,
      setSearchConfigDistanceMetric,
      setSearchConfigRetrievalMode,
      setSearchConfigVectorWeight,
      setSearchConfigFtsWeight,
    ]
  );

  // Handle search mode change
  const handleSearchModeChange = useCallback(
    (mode: SearchMode) => {
      setSearchMode(mode);
      // Clear results when switching modes
      if (mode === 'quick') {
        clearResults();
      }
    },
    [setSearchMode, clearResults]
  );

  // Handle semantic search execution
  const handleSearch = useCallback(() => {
    if (!canUseCollectionForNormalSearch(activeCollectionId, activeCollectionSystemRole)) {
      return;
    }
    if (semanticQuery.trim()) {
      setSearchMode('semantic');
      void executeSearch(semanticQuery, searchConfig, activeCollectionId);
    }
  }, [
    semanticQuery,
    searchConfig,
    activeCollectionId,
    activeCollectionSystemRole,
    executeSearch,
    setSearchMode,
  ]);

  const hasActiveCollection = canUseCollectionForNormalSearch(
    activeCollectionId,
    activeCollectionSystemRole
  );
  const searchDisabledReason = getNormalSearchDisabledReason(activeCollectionSystemRole);
  const hasScopedSemanticSearch = hasActiveCollection && hasSearched;
  // In semantic/hybrid search mode the tree is built from the bounded search-result
  // set (not the paginated file list), so the file-list pager is meaningless here:
  // paging it only refetches `records` (a loading flash) without changing what is
  // shown. Hide it while scoped search results are on screen.
  const isShowingSemanticResults = searchMode === 'semantic' && hasScopedSemanticSearch;
  const scopedSearchResults = useMemo(() => {
    if (activeCollectionId === null) {
      return [];
    }
    return searchResults.filter((result) => result.embeddingSetId === activeCollectionId);
  }, [activeCollectionId, searchResults]);

  // Transform data for CollectionBrowser.
  // When semantic search results are present, build the tree from the search
  // results themselves — search results span ALL pages but the paginated
  // `records` only contains the current page. Without this, files on other
  // pages have no tree nodes and the tree shows "No matching results".
  const treeData = useMemo(() => {
    if (searchMode === 'semantic' && hasScopedSemanticSearch && scopedSearchResults.length > 0) {
      // Build a minimal tree from search results — each result has enough
      // data (fileRecordId, fileName, filePath, content, chunkId) to create
      // both file and chunk nodes without querying the paginated records.
      // Single pass: build both file and chunk arrays from search results
      const fileMap = new Map<
        string,
        { id: string; name: string; path: string; size: number; chunkCount: number }
      >();
      const treeChunks: CollectionTreeInput['chunks'] = [];

      for (const [i, result] of scopedSearchResults.entries()) {
        const existing = fileMap.get(result.fileRecordId);
        if (existing) {
          existing.chunkCount++;
        } else {
          fileMap.set(result.fileRecordId, {
            chunkCount: 1,
            id: result.fileRecordId,
            name: result.fileName,
            path: result.filePath,
            size: result.fileSize ?? 0,
          });
        }
        treeChunks.push({
          chunkIndex: result.chunkIndex ?? i,
          content: result.content,
          fileRecordId: result.fileRecordId,
          hasEmbedding: true,
          id: result.chunkId,
          tokenCount: result.tokenCount ?? 0,
          ...(result.embeddingDimensions === undefined
            ? {}
            : { embeddingDimensions: result.embeddingDimensions }),
          ...(result.embeddingSetId ? { embeddingSetId: result.embeddingSetId } : {}),
        });
      }

      return {
        chunks: treeChunks,
        files: Array.from(fileMap.values()).map((file) => ({
          chunksCount: file.chunkCount,
          embeddedChunksCount: file.chunkCount,
          id: file.id,
          name: file.name,
          path: file.path,
          size: file.size,
          ...(activeCollectionId ? { embeddingSetId: activeCollectionId } : {}),
        })),
      } satisfies CollectionTreeInput;
    }

    return transformToTreeInput(records, chunks, activeCollectionId, pendingChunkIds);
  }, [
    records,
    chunks,
    activeCollectionId,
    pendingChunkIds,
    searchMode,
    hasScopedSemanticSearch,
    scopedSearchResults,
  ]);

  useEffect(() => {
    const treeFileCount = treeData.files.length;
    const treeChunkCount = treeData.chunks.length;
    const shouldLog =
      records.length >= LARGE_COLLECTION_BROWSER_RECORD_THRESHOLD ||
      chunks.length >= LARGE_COLLECTION_BROWSER_CHUNK_THRESHOLD ||
      treeFileCount >= LARGE_COLLECTION_BROWSER_RECORD_THRESHOLD ||
      treeChunkCount >= LARGE_COLLECTION_BROWSER_CHUNK_THRESHOLD ||
      searchResults.length >= LARGE_COLLECTION_BROWSER_RECORD_THRESHOLD;
    if (!shouldLog) {
      treeDiagnosticSignatureRef.current = null;
      return;
    }

    const diagnosticSignature = [
      activeCollectionId ?? 'none',
      searchMode,
      hasSearched ? 'searched' : 'idle',
      records.length,
      chunks.length,
      treeFileCount,
      treeChunkCount,
      searchResults.length,
      expandedIds.length,
      selectedId ?? 'none',
      pagination?.currentPage ?? -1,
      pagination?.pageSize ?? -1,
      pagination?.totalRecords ?? -1,
    ].join('|');
    if (treeDiagnosticSignatureRef.current === diagnosticSignature) {
      return;
    }
    treeDiagnosticSignatureRef.current = diagnosticSignature;

    logger.info('Large collection browser tree materialized', {
      activeCollectionId,
      expandedIdCount: expandedIds.length,
      groupBy,
      hasSearched,
      isLoading,
      isSearching,
      page: pagination?.currentPage ?? null,
      pageSize: pagination?.pageSize ?? null,
      pendingChunkCount: pendingChunkIds?.size ?? 0,
      searchMode,
      selectedId,
      semanticResultCount: searchResults.length,
      sourceChunkCount: chunks.length,
      sourceRecordCount: records.length,
      totalRecords: pagination?.totalRecords ?? null,
      treeChunkCount,
      treeFileCount,
    });
  }, [
    activeCollectionId,
    chunks.length,
    expandedIds.length,
    groupBy,
    hasSearched,
    isLoading,
    isSearching,
    pagination,
    pendingChunkIds,
    records.length,
    searchMode,
    searchResults.length,
    selectedId,
    treeData,
  ]);
  // Inspector panel ref for imperative control
  const inspectorPanelRef = useRef<PanelImperativeHandle>(null);
  const isMountedRef = useRef(true);

  // Handle inspector toggle from within the component
  const handleInspectorCollapse = useCallback(
    (collapsed: boolean) => {
      setInspectorCollapsed(collapsed);
      if (collapsed) {
        inspectorPanelRef.current?.collapse();
      } else {
        inspectorPanelRef.current?.expand();
      }
    },
    [setInspectorCollapsed]
  );

  // Handle panel layout changes to persist size
  const handleLayoutChange = useCallback(
    (layout: { [id: string]: number }) => {
      const inspectorSize = layout['inspector-panel'];
      if (inspectorSize !== undefined && inspectorSize > 0) {
        setInspectorWidth(inspectorSize);
      }
    },
    [setInspectorWidth]
  );

  // Handle node selection - stores the ID and calls external handlers
  const handleSelect = useCallback(
    (nodeId: string, nodeType: string, _data: BrowserNodeData) => {
      // Store the full prefixed ID in the store
      setSelectedId(nodeId);

      const { originalId } = parseNodeId(nodeId);

      // Call specific handlers based on node type
      if (nodeType === 'file' && onFileSelect) {
        const file = records.find((r) => r.id === originalId);
        if (file) {
          onFileSelect(originalId, file);
        }
      } else if (nodeType === 'chunk' && onChunkSelect && loadChunkDetail) {
        void loadChunkDetail(originalId)
          .then((chunk) => {
            if (isMountedRef.current && chunk) {
              onChunkSelect(originalId, chunk);
            }
          })
          .catch((error: unknown) => {
            logger.warn('Failed to load chunk detail for selection', {
              chunkId: originalId,
              error,
            });
          });
      }
    },
    [setSelectedId, records, loadChunkDetail, onFileSelect, onChunkSelect]
  );

  useEffect(
    () => () => {
      isMountedRef.current = false;
    },
    []
  );

  // Handle multi-select toggle — also toggles showCheckbox in sync
  const handleMultiSelectToggle = useCallback(
    (enabled: boolean) => {
      setMultiSelectEnabled(enabled);
      setShowCheckbox(enabled);
    },
    [setMultiSelectEnabled, setShowCheckbox]
  );

  // Handle group-by change from toolbar
  const handleGroupByChange = useCallback(
    (key: GroupByKey) => {
      setGroupBy(key);
    },
    [setGroupBy]
  );

  // Handle double-click: toggle expand for parent nodes, open inspector for leaves
  const handleDoubleClick = useCallback(
    (nodeId: string, nodeType: string, _data: BrowserNodeData) => {
      // Parent nodes (files with chunks) → toggle expand
      if (nodeType === 'file' || nodeType === 'collection' || nodeType === 'group') {
        toggleExpanded(nodeId);
        return;
      }
      // Chunk nodes with embeddings → toggle expand
      if (nodeType === 'chunk') {
        toggleExpanded(nodeId);
        return;
      }
      // Leaf nodes (embedding) → open the inspector
      setSelectedId(nodeId);
      if (isInspectorCollapsed) {
        handleInspectorCollapse(false);
      }
    },
    [toggleExpanded, setSelectedId, isInspectorCollapsed, handleInspectorCollapse]
  );

  // Context menu target controller for the shared ActionContextMenu. Memoized
  // handlers depend on `setTarget` (stable), not the controller object.
  const contextMenuController = useContextMenuTarget();
  const { setTarget: setContextMenuTarget } = contextMenuController;
  // Surface-local metadata the local actions close over (prefixed nodeId for
  // the expand store, child availability for menu visibility).
  const [contextMenuMeta, setContextMenuMeta] = useState<{
    hasChildren: boolean;
    nodeId: string;
    nodeType: string;
  } | null>(null);

  // Handle right-click: claim the shared context-menu target for this row.
  // Note (intentional v1 simplification): `browserNodeToTarget` returns null
  // for 'group' headers, so group rows no longer get a context menu — they
  // already toggle expansion on click.
  const handleContextMenu = useCallback(
    (nodeId: string, nodeType: string, data: BrowserNodeData, _event: React.MouseEvent) => {
      const { originalId } = parseNodeId(nodeId);
      const hasChildren =
        nodeType === 'group'
          ? true
          : nodeType === 'collection'
            ? records.some(
                (record) =>
                  activeCollectionId === null || record.embeddingSetId === activeCollectionId
              )
            : nodeType === 'file'
              ? records.some(
                  (record) =>
                    record.id === originalId &&
                    (activeCollectionId === null || record.embeddingSetId === activeCollectionId) &&
                    (record.chunksCount ?? 0) > 0
                )
              : nodeType === 'chunk'
                ? chunks.some((chunk) => chunk.id === originalId && chunk.hasEmbedding)
                : false;
      setContextMenuMeta({ hasChildren, nodeId, nodeType });
      setContextMenuTarget(
        browserNodeToTarget(toBrowserNodeDescriptor(nodeType, originalId, data))
      );
    },
    [records, chunks, activeCollectionId, setContextMenuTarget]
  );

  // Surface-local context actions: closures over component state (expand
  // store, inspector). Copy ID / Copy Content come from the global registry.
  const localContextActions = useMemo<readonly AnyContextAction[]>(() => {
    if (!contextMenuMeta) {
      return [];
    }
    const { nodeId, nodeType, hasChildren } = contextMenuMeta;
    const actions: AnyContextAction[] = [];

    if (hasChildren) {
      actions.push(
        defineContextAction({
          appliesTo: ['collection', 'collection-file', 'chunk'] as const,
          group: 'tree',
          icon: ChevronRight,
          id: 'collection-browser.toggle-expand',
          label: () => (expandedIdsSet.has(nodeId) ? 'Collapse' : 'Expand'),
          run: () => {
            toggleExpanded(nodeId);
            return Promise.resolve({ ok: true });
          },
        })
      );
      if (nodeType === 'file') {
        actions.push(
          defineContextAction({
            appliesTo: ['collection-file'] as const,
            group: 'tree',
            icon: ChevronsUpDown,
            id: 'collection-browser.expand-all-children',
            label: 'Expand All Children',
            run: async () => {
              const { originalId } = parseNodeId(nodeId);
              const fileChunks = await ensureFileChunksLoaded(originalId);
              const childIds = [
                nodeId,
                ...fileChunks
                  .filter((chunk) => chunk.hasEmbedding)
                  .map((chunk) => `chunk-${chunk.id}`),
              ];
              expandIds(childIds);
              return { ok: true };
            },
          })
        );
      }
    }

    actions.push(
      defineContextAction({
        appliesTo: ['collection', 'collection-file', 'chunk', 'embedding'] as const,
        group: 'inspect',
        icon: Eye,
        id: 'collection-browser.inspect',
        label: 'Inspect',
        run: () => {
          setSelectedId(nodeId);
          if (isInspectorCollapsed) {
            handleInspectorCollapse(false);
          }
          return Promise.resolve({ ok: true });
        },
      })
    );

    if (multiSelectEnabled) {
      actions.push(
        defineContextAction({
          appliesTo: ['collection', 'collection-file', 'chunk', 'embedding'] as const,
          group: 'inspect',
          icon: SquareCheck,
          id: 'collection-browser.select',
          label: 'Select',
          run: () => {
            setSelectedId(nodeId);
            return Promise.resolve({ ok: true });
          },
        })
      );
    }

    return actions;
  }, [
    contextMenuMeta,
    expandedIdsSet,
    toggleExpanded,
    ensureFileChunksLoaded,
    expandIds,
    setSelectedId,
    isInspectorCollapsed,
    handleInspectorCollapse,
    multiSelectEnabled,
  ]);

  // Bulk actions for the multi-select action bar
  const bulkActions: BulkAction[] = useMemo(
    () => [
      {
        applicableTypes: ['file', 'chunk'] as CollectionNodeType[],
        icon: <ChevronsUpDown className="h-4 w-4" />,
        id: 'expand-selected',
        label: 'Expand',
        onAction: (selectedIds: Set<string>) => {
          expandIds(Array.from(selectedIds));
        },
      },
      {
        applicableTypes: ['file', 'chunk'] as CollectionNodeType[],
        icon: <ChevronsDownUp className="h-4 w-4" />,
        id: 'collapse-selected',
        label: 'Collapse',
        onAction: (selectedIds: Set<string>) => {
          removeExpandedIds(selectedIds);
        },
      },
      {
        icon: <Copy className="h-4 w-4" />,
        id: 'copy-ids',
        label: 'Copy IDs',
        onAction: (selectedIds: Set<string>) => {
          const ids = Array.from(selectedIds)
            .map((id) => parseNodeId(id).originalId)
            .join('\n');
          void clipboard.writeText(ids).then((outcome) => {
            if (!outcome.ok) {
              logger.warn('Failed to copy selected node IDs to clipboard', {
                error: outcome.error,
              });
            }
          });
        },
      },
    ],
    [expandIds, removeExpandedIds]
  );

  // Empty state message - depends on search mode
  const emptyMessage = useMemo(() => {
    if (!activeCollectionId) {
      return 'Create or select a collection to start importing files and searching with semantic embeddings.';
    }
    if (searchMode === 'semantic' && hasScopedSemanticSearch && scopedSearchResults.length === 0) {
      return 'No matching results found. Try adjusting your query or threshold.';
    }
    return 'No files in this collection. Import files to get started.';
  }, [activeCollectionId, searchMode, hasScopedSemanticSearch, scopedSearchResults.length]);

  return (
    <div className="flex h-full min-w-0 flex-col" style={{ height }}>
      {/* Search mode bar - Top level controls */}
      <SearchModeBar
        advancedOptions={
          <SearchConfigPanel config={searchConfig} onConfigChange={handleSearchConfigChange} />
        }
        advancedOptionsOpen={advancedOptionsOpen}
        className="border-border border-b"
        disabled={searchDisabledReason !== undefined}
        disabledReason={searchDisabledReason}
        hasSearched={hasScopedSemanticSearch}
        isSearchExpanded={searchPanelExpanded}
        isSearching={isSearching}
        mode={searchMode}
        onAdvancedOptionsOpenChange={setAdvancedOptionsOpen}
        onModeChange={handleSearchModeChange}
        onSearchExpandedChange={setSearchPanelExpanded}
        onSemanticQueryChange={setSemanticQuery}
        onSemanticSearch={handleSearch}
        resultCount={scopedSearchResults.length}
        semanticQuery={semanticQuery}
      />

      <SearchErrorBanner message={searchError} />

      <CollectionEmbeddingCoverageBanner
        activeCollectionId={activeCollectionId}
        {...(activeCollectionName ? { activeCollectionName } : {})}
      />

      <CollectionBrowserToolbar
        filters={filters}
        groupBy={groupBy}
        multiSelectEnabled={multiSelectEnabled}
        onCollapseAll={handleCollapseAll}
        onExpandAll={handleExpandAll}
        onFiltersChange={handleFiltersChange}
        onGroupByChange={handleGroupByChange}
        onMultiSelectToggle={handleMultiSelectToggle}
      />

      {/* Main content area */}
      <div className="relative flex min-h-0 min-w-0 flex-1 border-t">
        {/* Chip handle for collapsed inspector panel */}
        {hasInspectableSelection && isInspectorCollapsed && (
          <div className="absolute top-1/2 right-0 z-10 -translate-y-1/2">
            <Button
              aria-label="Show inspector panel"
              className="h-8 w-6 rounded-r-none rounded-l-md border border-border border-r-0 bg-muted/90 shadow-sm"
              onClick={() => handleInspectorCollapse(false)}
              size="icon"
              variant="ghost"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
          </div>
        )}

        <Group
          className="min-w-0 flex-1"
          onLayoutChange={handleLayoutChange}
          orientation="horizontal"
        >
          {/* Main browser */}
          <Panel
            className="min-h-0 min-w-0"
            defaultSize={`${
              hasInspectableSelection && !isInspectorCollapsed ? 100 - inspectorWidth : 100
            }%`}
            minSize="30%"
          >
            <div className="flex h-full min-h-0 min-w-0 flex-col">
              <div className="min-h-0 min-w-0 flex-1">
                <ActionContextMenu
                  controller={contextMenuController}
                  localActions={localContextActions}
                >
                  {/* Capture-phase reset: every right-click starts with a clean
                      target before the row handler claims it; unclaimed clicks
                      leave it null and ActionContextMenu suppresses the menu. */}
                  <div
                    className="h-full min-h-0 min-w-0"
                    onContextMenuCapture={() => setContextMenuTarget(null)}
                  >
                    <CollectionBrowser
                      bulkActions={bulkActions}
                      className="h-full"
                      columnSizes={columnSizes}
                      data={treeData}
                      emptyMessage={emptyMessage}
                      expandedIds={expandedIdsSet}
                      filters={filters}
                      hasSearched={hasScopedSemanticSearch}
                      height="100%"
                      isLoading={isLoading}
                      isSearching={isSearching}
                      multiSelectEnabled={multiSelectEnabled}
                      onColumnSizesChange={setColumnSizes}
                      onContextMenu={handleContextMenu}
                      onDoubleClick={handleDoubleClick}
                      onExpandedIdsChange={handleExpandedIdsChange}
                      onFiltersChange={handleFiltersChange}
                      onSelect={handleSelect}
                      onSelectedIdChange={handleSelectedIdChange}
                      onSortChange={handleSortChange}
                      searchMode={searchMode}
                      selectedId={selectedId}
                      showCheckbox={showCheckbox && multiSelectEnabled}
                      treeWindowingStrategy="virtual"
                      {...(sortState ? { sortState } : {})}
                      {...(searchMode === 'semantic' && hasActiveCollection
                        ? { semanticResults: scopedSearchResults }
                        : {})}
                      {...(groupBy === 'none' ? {} : { groupBy })}
                    />
                  </div>
                </ActionContextMenu>
              </div>
              {pagination && !isShowingSemanticResults && (
                <CollectionBrowserPaginationFooter pagination={pagination} />
              )}
            </div>
          </Panel>

          {hasInspectableSelection && !isInspectorCollapsed && (
            <>
              <Separator className="w-1 bg-border transition-colors hover:bg-primary/20" />

              {/* Inspector panel */}
              <Panel
                collapsedSize="0%"
                collapsible
                defaultSize={`${inspectorWidth}%`}
                id="inspector-panel"
                minSize="15%"
                onResize={(panelSize) => {
                  // Detect drag-to-collapse and sync state
                  if (panelSize.asPercentage === 0) {
                    handleInspectorCollapse(true);
                  }
                }}
                panelRef={inspectorPanelRef}
              >
                <NodeInspector
                  isCollapsed={false}
                  nodeData={actualSelectedNodeData}
                  nodeType={selectedNodeType ?? null}
                  onCollapseChange={handleInspectorCollapse}
                  {...(selectedNodeId ? { nodeId: selectedNodeId } : {})}
                />
              </Panel>
            </>
          )}
        </Group>
      </div>
    </div>
  );
}

export default CollectionBrowserView;
