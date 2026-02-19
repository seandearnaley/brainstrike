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

import type { FileChunk, FileRecord } from '@brainstrike/db';
import {
  type BrowserNodeData,
  Button,
  CollectionBrowser,
  type CollectionBrowserFilters,
  type CollectionNodeType,
  type CollectionSortState,
  type CollectionTreeInput,
  type EmbeddingStatus,
  FilterBar,
  NodeInspector,
  type SearchConfig,
  SearchConfigPanel,
  type SearchMode,
  SearchModeBar,
} from '@brainstrike/ui';
import { ChevronLeft } from 'lucide-react';
import { useCallback, useMemo, useRef } from 'react';
import { Group, Panel, type PanelImperativeHandle, Separator } from 'react-resizable-panels';
import { useSemanticSearch } from '../contexts/semantic-search-context';
import { useCollectionBrowserStore } from '../stores/collection-browser-store';

export interface CollectionBrowserViewProps {
  /** File records */
  records: FileRecord[];
  /** File chunks */
  chunks: FileChunk[];
  /** Pending chunk IDs (being embedded) */
  pendingChunkIds?: Set<string>;
  /** Active collection ID */
  activeCollectionId: string | null;
  /** Loading state */
  isLoading?: boolean;
  /** Height of the browser */
  height?: number | string;
  /** Called when a file is selected */
  onFileSelect?: (fileId: string, file: FileRecord) => void;
  /** Called when a chunk is selected */
  onChunkSelect?: (chunkId: string, chunk: FileChunk) => void;
}

/**
 * Transform database data into CollectionTreeInput format
 */
function transformToTreeInput(
  records: FileRecord[],
  chunks: FileChunk[],
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
        content: string;
        tokenCount: number;
        embedding?: number[];
        embeddingSetId?: string;
      } = {
        id: chunk.id,
        fileRecordId: chunk.fileRecordId,
        chunkIndex: chunk.chunkIndex,
        content: chunk.content,
        tokenCount: chunk.tokenCount,
      };
      if (chunk.embedding && chunk.embedding.length > 0) {
        chunkItem.embedding = chunk.embedding;
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
  records: FileRecord[],
  chunks: FileChunk[]
): BrowserNodeData | null {
  const file = records.find((r) => r.id === fileId);
  if (!file) {
    return null;
  }
  const fileChunks = chunks.filter((c) => c.fileRecordId === file.id);
  const embeddedChunks = fileChunks.filter((c) => c.embedding && c.embedding.length > 0);
  const hasAllEmbeddings = embeddedChunks.length === fileChunks.length;
  const hasSomeEmbeddings = embeddedChunks.length > 0;
  return {
    name: file.name,
    path: file.path,
    size: file.size,
    chunkCount: fileChunks.length,
    embeddingStatus: hasAllEmbeddings ? 'complete' : hasSomeEmbeddings ? 'pending' : 'none',
    embeddingProgress:
      fileChunks.length > 0 ? Math.round((embeddedChunks.length / fileChunks.length) * 100) : 0,
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
  records: FileRecord[],
  chunks: FileChunk[]
): BrowserNodeData | null {
  switch (nodeType) {
    case 'file':
      return buildFileData(nodeId, records, chunks);
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
export function CollectionBrowserView({
  records,
  chunks,
  pendingChunkIds,
  activeCollectionId,
  isLoading = false,
  height = 500,
  onFileSelect,
  onChunkSelect,
}: CollectionBrowserViewProps) {
  // Use persistent store for all UI state
  const {
    expandedIds,
    selectedId,
    sortState,
    isInspectorCollapsed,
    inspectorWidth,
    setExpandedIds,
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
    showCheckbox,
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
      const fileId = `file-${record.id}`;
      allExpandableIds.add(fileId);

      const fileChunks = chunks.filter((c) => c.fileRecordId === record.id);
      for (const chunk of fileChunks) {
        const chunkId = `chunk-${chunk.id}`;
        // Chunks are expandable if they have embeddings
        if (chunk.embedding && chunk.embedding.length > 0) {
          allExpandableIds.add(chunkId);
        }
      }
    }
    setExpandedIds(Array.from(allExpandableIds));
  }, [records, chunks, setExpandedIds]);

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
      return { selectedNodeType: null, selectedNodeId: null };
    }
    // Parse the node ID to determine type and original ID
    const prefixMatch = selectedId.match(/^(collection|file|chunk|embedding)-(.+)$/);
    if (!prefixMatch) {
      return { selectedNodeType: null, selectedNodeId: null };
    }
    const [, nodeType, originalId] = prefixMatch;
    return {
      selectedNodeType: nodeType,
      selectedNodeId: originalId,
    };
  }, [selectedId]);

  // Build selected node data based on node type
  const actualSelectedNodeData = useMemo((): BrowserNodeData | null => {
    if (!(selectedId && selectedNodeType && selectedNodeId)) {
      return null;
    }

    return buildSelectedNodeData(selectedNodeType, selectedNodeId, records, chunks);
  }, [selectedId, selectedNodeType, selectedNodeId, records, chunks]);

  const hasInspectableSelection = useMemo(
    () => selectedNodeType !== null && selectedNodeId !== null && actualSelectedNodeData !== null,
    [selectedNodeType, selectedNodeId, actualSelectedNodeData]
  );

  // Handle expansion state changes
  const handleExpandedIdsChange = useCallback(
    (ids: Set<string>) => {
      setExpandedIds(Array.from(ids));
    },
    [setExpandedIds]
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

      // Extract the original ID (remove prefix like 'file-', 'chunk-', etc.)
      const originalId = nodeId.replace(/^(collection|file|chunk|embedding)-/, '');

      // Call specific handlers based on node type
      if (nodeType === 'file' && onFileSelect) {
        const file = records.find((r) => r.id === originalId);
        if (file) {
          onFileSelect(originalId, file);
        }
      } else if (nodeType === 'chunk' && onChunkSelect) {
        const chunk = chunks.find((c) => c.id === originalId);
        if (chunk) {
          onChunkSelect(originalId, chunk);
        }
      }
    },
    [setSelectedId, records, chunks, onFileSelect, onChunkSelect]
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
        hasSearched={hasSearched}
        isConfigExpanded={searchConfigExpanded}
        isFilterVisible={isFilterVisible}
        isSearching={isSearching}
        mode={searchMode}
        onCollapseAll={handleCollapseAll}
        onConfigExpandedChange={setSearchConfigExpanded}
        onExpandAll={handleExpandAll}
        onFilterVisibleChange={setIsFilterVisible}
        onModeChange={handleSearchModeChange}
        onResetFilters={handleResetFilters}
        onSemanticQueryChange={setSemanticQuery}
        onSemanticSearch={handleSearch}
        resultCount={searchResults.length}
        semanticQuery={semanticQuery}
        totalCount={records.length}
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
            className="min-w-0"
            defaultSize={`${
              hasInspectableSelection && !isInspectorCollapsed ? 100 - inspectorWidth : 100
            }%`}
            minSize="30%"
          >
            <CollectionBrowser
              className="h-full"
              data={treeData}
              emptyMessage={emptyMessage}
              expandedIds={expandedIdsSet}
              filters={filters}
              hasSearched={hasSearched}
              height="100%"
              isLoading={isLoading}
              isSearching={isSearching}
              onExpandedIdsChange={handleExpandedIdsChange}
              onFiltersChange={handleFiltersChange}
              onSelect={handleSelect}
              onSelectedIdChange={handleSelectedIdChange}
              onSortChange={handleSortChange}
              searchMode={searchMode}
              selectedId={selectedId}
              {...(sortState ? { sortState } : {})}
              {...(searchMode === 'semantic' ? { semanticResults: searchResults } : {})}
              {...(groupBy !== 'none' ? { groupBy } : {})}
              showCheckbox={showCheckbox}
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
    </div>
  );
}

export default CollectionBrowserView;
