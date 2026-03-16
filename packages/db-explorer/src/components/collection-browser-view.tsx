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

import type { FileChunk } from '@brainstrike/db';
import {
  type BrowserNodeData,
  type BulkAction,
  Button,
  CollectionBrowser,
  type CollectionBrowserFilters,
  type CollectionNodeType,
  type CollectionSortState,
  type CollectionTreeInput,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  type EmbeddingStatus,
  FilterBar,
  type GroupByKey,
  NodeInspector,
  type SearchConfig,
  SearchConfigPanel,
  type SearchMode,
  SearchModeBar,
  TablePagination,
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
import { useSemanticSearch } from '../contexts/semantic-search-context';
import { useCollectionBrowserStore } from '../stores/collection-browser-store';
import type {
  DatabaseFileChunkSummary,
  DatabaseFileRecordSummary,
} from '../use-database-demo-data';

const logger = createLogger('CollectionBrowserView');
type NodeIdPrefix = Extract<CollectionNodeType, 'collection' | 'file' | 'chunk' | 'embedding'>;
const NODE_ID_PREFIXES = [
  'collection',
  'file',
  'chunk',
  'embedding',
] as const satisfies readonly NodeIdPrefix[];
const NODE_ID_PREFIX_PATTERN = new RegExp(`^(${NODE_ID_PREFIXES.join('|')})-(.+)$`);
const EMBEDDING_TREE_PAGE_SIZE_OPTIONS = [25, 50, 100, 250] as const;

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

export interface CollectionBrowserViewProps {
  /** Active collection ID */
  activeCollectionId: string | null;
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
        id: chunk.id,
        fileRecordId: chunk.fileRecordId,
        chunkIndex: chunk.chunkIndex,
        tokenCount: chunk.tokenCount,
        hasEmbedding: chunk.hasEmbedding ?? false,
      };
      if ((chunk.hasEmbedding ?? false) && (chunk.embeddingDimensions ?? 0) > 0) {
        chunkItem.embeddingDimensions = chunk.embeddingDimensions ?? 0;
      }
      if (chunk.embeddingSetId) {
        chunkItem.embeddingSetId = chunk.embeddingSetId;
      }
      return chunkItem;
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
    name: file.name,
    path: file.path,
    size: file.size,
    chunkCount: totalChunkCount,
    embeddingStatus: hasAllEmbeddings ? 'complete' : hasSomeEmbeddings ? 'pending' : 'none',
    embeddingProgress:
      totalChunkCount > 0 ? Math.round((embeddedChunkCount / totalChunkCount) * 100) : 0,
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
    index: chunk.chunkIndex,
    content: chunk.content,
    tokenCount: chunk.tokenCount,
    embeddingStatus: chunk.embedding && chunk.embedding.length > 0 ? 'complete' : 'none',
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
    vectorId: chunk.id,
    dimensions: chunk.embedding.length,
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

/**
 * CollectionBrowserView - Connects CollectionBrowser to database data
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This adapter intentionally centralizes tree-grid wiring and inspector coordination.
export function CollectionBrowserView({
  records,
  chunks,
  pendingChunkIds,
  activeCollectionId,
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
    searchConfigExpanded,
    isFilterVisible,
    setSearchMode,
    setSemanticQuery,
    setSearchConfigThreshold,
    setSearchConfigLimit,
    setSearchConfigDistanceMetric,
    // Hybrid search setters
    setSearchConfigRetrievalMode,
    setSearchConfigVectorWeight,
    setSearchConfigFtsWeight,
    setSearchConfigExpanded,
    setIsFilterVisible,
    // Grouping and checkbox state
    groupBy,
    contextSelectedIds,
    showCheckbox,
    multiSelectEnabled,
    setGroupBy,
    toggleContextSelectedId,
    clearContextSelectedIds,
    setShowCheckbox,
    setMultiSelectEnabled,
    toggleExpanded,
    expandIds,
  } = useCollectionBrowserStore();

  // Convert store filter state to CollectionBrowserFilters format
  const filters = useMemo(
    (): CollectionBrowserFilters => ({
      searchQuery,
      nodeTypes: new Set(nodeTypes as CollectionNodeType[]),
      embeddingStatus: embeddingStatus as EmbeddingStatus | 'all',
      searchMatchesOnly: false,
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

  // Handle filter reset
  const handleResetFilters = useCallback(() => {
    setSearchQuery('');
    setNodeTypes(['collection', 'file', 'chunk', 'embedding']);
    setEmbeddingStatus('all');
  }, [setSearchQuery, setNodeTypes, setEmbeddingStatus]);

  // Handle expand all
  const handleExpandAll = useCallback(() => {
    const allExpandableIds = new Set<string>();
    for (const record of records) {
      if ((record.chunksCount ?? 0) > 0) {
        allExpandableIds.add(`file-${record.id}`);
      }
    }
    setExpandedIds(Array.from(allExpandableIds));
  }, [records, setExpandedIds]);

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
  const contextNodeIdsSet = useMemo(() => new Set(contextSelectedIds), [contextSelectedIds]);
  const shouldShowContextToolbar = selectedId !== null || contextSelectedIds.length > 0;

  // State for selected node inspection (derived from store selectedId)
  const { selectedNodeType, selectedNodeId } = useMemo(() => {
    if (!selectedId) {
      return { selectedNodeType: null, selectedNodeId: null };
    }
    const { nodeType, originalId } = parseNodeId(selectedId);
    if (!nodeType) {
      return { selectedNodeType: null, selectedNodeId: null };
    }
    return {
      selectedNodeType: nodeType,
      selectedNodeId: originalId,
    };
  }, [selectedId]);

  const [selectedChunkDetail, setSelectedChunkDetail] = useState<FileChunk | null>(null);

  const ensureFileChunksLoaded = useCallback(
    async (fileRecordId: string): Promise<void> => {
      if (!loadFileChunkSummaries) {
        return;
      }
      const alreadyLoaded = chunks.some((chunk) => chunk.fileRecordId === fileRecordId);
      if (alreadyLoaded) {
        return;
      }
      await loadFileChunkSummaries(fileRecordId);
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
      const detail = await loadChunkDetail(selectedNodeId);
      if (!cancelled) {
        setSelectedChunkDetail(detail);
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
          index: selectedChunk.chunkIndex,
          content: 'Loading chunk content...',
          tokenCount: selectedChunk.tokenCount,
          embeddingStatus: selectedChunk.hasEmbedding ? 'complete' : 'none',
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
        vectorId: selectedNodeId,
        dimensions: selectedChunk.embeddingDimensions ?? 0,
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
      threshold: searchConfigThreshold,
      resultLimit: searchConfigLimit,
      distanceMetric: searchConfigDistanceMetric,
      retrievalMode: searchConfigRetrievalMode,
      vectorWeight: searchConfigVectorWeight,
      ftsWeight: searchConfigFtsWeight,
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
    if (semanticQuery.trim()) {
      setSearchMode('semantic');
      void executeSearch(semanticQuery, searchConfig, activeCollectionId);
    }
  }, [semanticQuery, searchConfig, activeCollectionId, executeSearch, setSearchMode]);

  // Transform data for CollectionBrowser
  const treeData = useMemo(
    () => transformToTreeInput(records, chunks, activeCollectionId, pendingChunkIds),
    [records, chunks, activeCollectionId, pendingChunkIds]
  );
  const totalRecordPages = useMemo(() => {
    if (!pagination) {
      return 1;
    }
    return Math.max(1, Math.ceil(pagination.totalRecords / Math.max(1, pagination.pageSize)));
  }, [pagination]);

  // Inspector panel ref for imperative control
  const inspectorPanelRef = useRef<PanelImperativeHandle>(null);

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
        void loadChunkDetail(originalId).then((chunk) => {
          if (chunk) {
            onChunkSelect(originalId, chunk);
          }
        });
      }
    },
    [setSelectedId, records, loadChunkDetail, onFileSelect, onChunkSelect]
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

  const handleToggleContextForSelected = useCallback(() => {
    if (!selectedId) {
      return;
    }
    toggleContextSelectedId(selectedId);
  }, [selectedId, toggleContextSelectedId]);

  const handleClearContextSelection = clearContextSelectedIds;

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

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    nodeId: string;
    nodeType: string;
    hasChildren: boolean;
  } | null>(null);

  // Handle right-click context menu
  const handleContextMenu = useCallback(
    (nodeId: string, nodeType: string, _data: BrowserNodeData, event: React.MouseEvent) => {
      event.preventDefault();
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
      setContextMenu({
        x: event.clientX,
        y: event.clientY,
        nodeId,
        nodeType,
        hasChildren,
      });
    },
    [records, chunks, activeCollectionId]
  );

  // Close context menu
  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  // Context menu: expand/collapse node
  const handleContextExpand = useCallback(() => {
    if (contextMenu) {
      toggleExpanded(contextMenu.nodeId);
    }
    closeContextMenu();
  }, [contextMenu, toggleExpanded, closeContextMenu]);

  // Context menu: expand all children for a parent node
  const handleContextExpandAllChildren = useCallback(() => {
    if (!contextMenu) {
      return;
    }
    const run = async () => {
      const childIds: string[] = [];
      const { originalId } = parseNodeId(contextMenu.nodeId);

      if (contextMenu.nodeType === 'file') {
        await ensureFileChunksLoaded(originalId);
        const fileChunks = chunks.filter((c) => c.fileRecordId === originalId);
        childIds.push(contextMenu.nodeId);
        for (const chunk of fileChunks) {
          if (chunk.hasEmbedding) {
            childIds.push(`chunk-${chunk.id}`);
          }
        }
      }

      if (childIds.length > 0) {
        expandIds(childIds);
      }
      closeContextMenu();
    };

    void run();
  }, [closeContextMenu, chunks, contextMenu, ensureFileChunksLoaded, expandIds]);

  // Context menu: inspect node (open inspector)
  const handleContextInspect = useCallback(() => {
    if (contextMenu) {
      setSelectedId(contextMenu.nodeId);
      if (isInspectorCollapsed) {
        handleInspectorCollapse(false);
      }
    }
    closeContextMenu();
  }, [contextMenu, setSelectedId, isInspectorCollapsed, handleInspectorCollapse, closeContextMenu]);

  // Context menu: copy node ID to clipboard
  const handleContextCopyId = useCallback(() => {
    if (contextMenu) {
      const { originalId } = parseNodeId(contextMenu.nodeId);
      navigator.clipboard.writeText(originalId).catch((error: unknown) => {
        logger.warn('Failed to copy node ID to clipboard', { error });
      });
    }
    closeContextMenu();
  }, [contextMenu, closeContextMenu]);

  // Bulk actions for the multi-select action bar
  const bulkActions: BulkAction[] = useMemo(
    () => [
      {
        id: 'expand-selected',
        label: 'Expand',
        icon: <ChevronsUpDown className="h-4 w-4" />,
        onAction: (selectedIds: Set<string>) => {
          expandIds(Array.from(selectedIds));
        },
        applicableTypes: ['file', 'chunk'] as CollectionNodeType[],
      },
      {
        id: 'collapse-selected',
        label: 'Collapse',
        icon: <ChevronsDownUp className="h-4 w-4" />,
        onAction: (selectedIds: Set<string>) => {
          removeExpandedIds(selectedIds);
        },
        applicableTypes: ['file', 'chunk'] as CollectionNodeType[],
      },
      {
        id: 'copy-ids',
        label: 'Copy IDs',
        icon: <Copy className="h-4 w-4" />,
        onAction: (selectedIds: Set<string>) => {
          const ids = Array.from(selectedIds)
            .map((id) => parseNodeId(id).originalId)
            .join('\n');
          navigator.clipboard.writeText(ids).catch((error: unknown) => {
            logger.warn('Failed to copy selected node IDs to clipboard', { error });
          });
        },
      },
    ],
    [expandIds, removeExpandedIds]
  );

  // Empty state message - depends on search mode
  const emptyMessage = useMemo(() => {
    if (searchMode === 'semantic' && hasSearched && searchResults.length === 0) {
      return 'No matching results found. Try adjusting your query or threshold.';
    }
    return 'No files in this collection. Import files to get started.';
  }, [searchMode, hasSearched, searchResults.length]);

  return (
    <div className="flex h-full flex-col" style={{ height }}>
      {/* Search mode bar - Top level controls */}
      <SearchModeBar
        className="border-border border-b"
        filters={filters}
        groupBy={groupBy}
        hasSearched={hasSearched}
        isConfigExpanded={searchConfigExpanded}
        isFilterVisible={isFilterVisible}
        isSearching={isSearching}
        mode={searchMode}
        multiSelectEnabled={multiSelectEnabled}
        onCollapseAll={handleCollapseAll}
        onConfigExpandedChange={setSearchConfigExpanded}
        onExpandAll={handleExpandAll}
        onFilterVisibleChange={setIsFilterVisible}
        onGroupByChange={handleGroupByChange}
        onModeChange={handleSearchModeChange}
        onMultiSelectToggle={handleMultiSelectToggle}
        onResetFilters={handleResetFilters}
        onSemanticQueryChange={setSemanticQuery}
        onSemanticSearch={handleSearch}
        resultCount={searchResults.length}
        semanticQuery={semanticQuery}
        totalCount={pagination?.totalRecords ?? records.length}
      />

      {/* Advanced Search Options Panel */}
      <SearchConfigPanel
        config={searchConfig}
        isExpanded={searchConfigExpanded}
        onConfigChange={handleSearchConfigChange}
        onExpandedChange={setSearchConfigExpanded}
      />

      {/* Quick Filters Panel */}
      <FilterBar
        filters={filters}
        isExpanded={isFilterVisible}
        onExpandedChange={setIsFilterVisible}
        onFiltersChange={handleFiltersChange}
      />

      {shouldShowContextToolbar && (
        <div className="flex items-center justify-between border-border border-b px-3 py-2">
          <span className="text-muted-foreground text-xs">
            In context: {contextSelectedIds.length}
          </span>
          <div className="flex items-center gap-2">
            <Button
              disabled={!selectedId}
              onClick={handleToggleContextForSelected}
              size="sm"
              variant="outline"
            >
              {selectedId && contextNodeIdsSet.has(selectedId)
                ? 'Remove selected from context'
                : 'Add selected to context'}
            </Button>
            <Button
              disabled={contextSelectedIds.length === 0}
              onClick={handleClearContextSelection}
              size="sm"
              variant="outline"
            >
              Clear context
            </Button>
          </div>
        </div>
      )}

      {/* Error message display */}
      {searchError && (
        <div className="border-border border-b bg-destructive/10 px-3 py-2 text-destructive text-sm">
          {searchError}
        </div>
      )}

      {/* Main content area */}
      <div className="relative flex min-h-0 flex-1 border-t">
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

        <Group onLayoutChange={handleLayoutChange} orientation="horizontal">
          {/* Main browser */}
          <Panel
            className="min-h-0 min-w-0"
            defaultSize={`${
              hasInspectableSelection && !isInspectorCollapsed ? 100 - inspectorWidth : 100
            }%`}
            minSize="30%"
          >
            <CollectionBrowser
              bulkActions={bulkActions}
              className="h-full"
              contextNodeIds={contextNodeIdsSet}
              data={treeData}
              emptyMessage={emptyMessage}
              expandedIds={expandedIdsSet}
              filters={filters}
              hasSearched={hasSearched}
              height="100%"
              isLoading={isLoading}
              isSearching={isSearching}
              multiSelectEnabled={multiSelectEnabled}
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
              {...(searchMode === 'semantic' ? { semanticResults: searchResults } : {})}
              {...(groupBy !== 'none' ? { groupBy } : {})}
            />
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

      {pagination && (
        <div className="border-border border-t px-3 py-2">
          <TablePagination
            currentPage={pagination.currentPage}
            onPageChange={pagination.onPageChange}
            onPageSizeChange={pagination.onPageSizeChange}
            pageInfo="files"
            pageSize={pagination.pageSize}
            pageSizeOptions={EMBEDDING_TREE_PAGE_SIZE_OPTIONS}
            showItemRange
            totalItems={pagination.totalRecords}
            totalPages={totalRecordPages}
          />
        </div>
      )}

      {/* Context menu (positioned at right-click location) */}
      {contextMenu && (
        <DropdownMenu
          onOpenChange={(open) => {
            if (!open) {
              closeContextMenu();
            }
          }}
          open
        >
          <DropdownMenuTrigger asChild>
            <div
              className="pointer-events-none fixed h-px w-px"
              style={{ left: contextMenu.x, top: contextMenu.y }}
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="right">
            {contextMenu.hasChildren && (
              <>
                <DropdownMenuItem onClick={handleContextExpand}>
                  {expandedIdsSet.has(contextMenu.nodeId) ? (
                    <>
                      <ChevronRight className="mr-2 h-4 w-4 rotate-90" />
                      Collapse
                    </>
                  ) : (
                    <>
                      <ChevronRight className="mr-2 h-4 w-4" />
                      Expand
                    </>
                  )}
                </DropdownMenuItem>
                {contextMenu.nodeType === 'file' && (
                  <DropdownMenuItem onClick={handleContextExpandAllChildren}>
                    <ChevronsUpDown className="mr-2 h-4 w-4" />
                    Expand All Children
                  </DropdownMenuItem>
                )}
              </>
            )}
            <DropdownMenuItem onClick={handleContextInspect}>
              <Eye className="mr-2 h-4 w-4" />
              Inspect
            </DropdownMenuItem>
            {multiSelectEnabled && (
              <DropdownMenuItem
                onClick={() => {
                  if (contextMenu) {
                    setSelectedId(contextMenu.nodeId);
                  }
                  closeContextMenu();
                }}
              >
                <SquareCheck className="mr-2 h-4 w-4" />
                Select
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={handleContextCopyId}>
              <Copy className="mr-2 h-4 w-4" />
              Copy ID
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

export default CollectionBrowserView;
