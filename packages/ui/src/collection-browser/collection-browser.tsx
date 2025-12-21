/**
 * CollectionBrowser Component
 *
 * A unified hierarchical browser for collections, files, chunks, and embeddings.
 * Combines the TreeTable with FilterBar for a complete browsing experience.
 */

import { File, FileText, FolderOpen, Sparkles } from 'lucide-react';
import * as React from 'react';
import { Badge } from '../badge';
import { cn } from '../lib/utils';
import { Progress } from '../progress';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../tooltip';
import { TreeTable } from '../tree-table/tree-table';
import type { SortDirection, SortState, TreeNode, TreeTableColumn } from '../tree-table/types';
import type { BulkAction } from './bulk-action-bar';
import { BulkActionBar } from './bulk-action-bar';
import type {
  BrowserNodeData,
  ChunkData,
  CollectionBrowserFilters,
  CollectionData,
  CollectionNodeType,
  EmbeddingData,
  FileData,
  SearchMode,
  SemanticSearchResult,
} from './types';
import { DEFAULT_FILTERS, EMBEDDING_STATUS_CONFIG, NODE_TYPE_CONFIG } from './types';
import type {
  CollectionSortKey,
  CollectionSortState,
  CollectionTreeInput,
} from './use-collection-tree';
import { useCollectionTree } from './use-collection-tree';

/**
 * Shorten a file path for display while keeping it informative.
 * - Replaces home directory with ~
 * - Collapses middle segments if path exceeds maxLength
 * - Preserves filename and immediate parent for context
 *
 * @param path - The full file path
 * @param maxLength - Maximum display length (default: 50)
 * @returns Shortened path string
 */
export function shortenPath(path: string, maxLength = 50): string {
  if (!path || path.length <= maxLength) {
    return path;
  }

  // Replace common home directory patterns with ~
  const homePatterns = [/^\/Users\/[^/]+/, /^\/home\/[^/]+/, /^C:\\Users\\[^\\]+/i];

  let shortenedPath = path;
  for (const pattern of homePatterns) {
    if (pattern.test(path)) {
      shortenedPath = path.replace(pattern, '~');
      break;
    }
  }

  // If still too long, collapse middle segments
  if (shortenedPath.length > maxLength) {
    const separator = path.includes('\\') ? '\\' : '/';
    const parts = shortenedPath.split(separator);

    if (parts.length > 3) {
      // Keep first segment (~ or root), ellipsis, and last 2 segments
      const first = parts[0];
      const lastTwo = parts.slice(-2);
      shortenedPath = [first, '…', ...lastTwo].join(separator);
    }
  }

  return shortenedPath;
}

/**
 * Mapping from TreeTable column IDs to hierarchical sort keys
 */
const COLUMN_TO_SORT_KEY: Record<string, CollectionSortKey> = {
  name: 'name',
  status: 'status',
  size: 'size',
  meta: 'count', // 'meta' column shows counts, so map to 'count' sort key
  score: 'score', // semantic search score column
};

/**
 * Mapping from hierarchical sort keys to TreeTable column IDs
 */
const SORT_KEY_TO_COLUMN: Record<CollectionSortKey, string> = {
  name: 'name',
  status: 'status',
  size: 'size',
  count: 'meta',
  score: 'score',
};

/**
 * Props for the CollectionBrowser component
 */
export type CollectionBrowserProps = {
  /** Input data for the tree */
  data: CollectionTreeInput;
  /** Called when a node is selected */
  onSelect?: (nodeId: string, nodeType: string, data: BrowserNodeData) => void;
  /** Called when multiple nodes are selected */
  onMultiSelect?: (nodeIds: Set<string>) => void;
  /** Called when a node is double-clicked */
  onDoubleClick?: (nodeId: string, nodeType: string, data: BrowserNodeData) => void;
  /** Called when context menu is requested */
  onContextMenu?: (
    nodeId: string,
    nodeType: string,
    data: BrowserNodeData,
    event: React.MouseEvent
  ) => void;
  /** Height of the component */
  height?: number | string;
  /** Custom class name */
  className?: string;
  /** Whether to enable multi-select mode */
  multiSelectEnabled?: boolean;
  /** Loading state */
  isLoading?: boolean;
  /** Empty state message */
  emptyMessage?: string;
  /** Bulk actions for multi-select mode */
  bulkActions?: BulkAction[];
  /** Whether to show the bulk action bar when items are selected */
  showBulkActionBar?: boolean;
  /** Hierarchical sort state (sorts within each level of the tree) */
  sortState?: CollectionSortState;
  /** Called when sort changes */
  onSortChange?: (sortState: CollectionSortState | null) => void;
  /** Expanded node IDs (controlled mode) */
  expandedIds?: Set<string>;
  /** Called when expansion state changes (controlled mode) */
  onExpandedIdsChange?: (ids: Set<string>) => void;
  /** Selected node ID (controlled mode) */
  selectedId?: string | null;
  /** Called when selection changes (controlled mode) */
  onSelectedIdChange?: (id: string | null) => void;
  /** Current search mode (quick filter or semantic search) */
  searchMode?: SearchMode;
  /** Semantic search results to overlay on tree */
  semanticResults?: SemanticSearchResult[];
  /** Whether semantic search is currently loading */
  isSearching?: boolean;
  /** Whether a semantic search has been executed at least once */
  hasSearched?: boolean;
  /** Current filter state (controlled) */
  filters?: CollectionBrowserFilters;
  /** Callback when filters change (controlled) */
  onFiltersChange?: (filters: CollectionBrowserFilters) => void;
};

/**
 * Format file size for display
 */
function formatFileSize(bytes: number): string {
  if (bytes === 0) {
    return '0 B';
  }
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${Number.parseFloat((bytes / k ** i).toFixed(1))} ${sizes[i]}`;
}

/**
 * Get icon for node type
 */
function NodeIcon({ type }: { type: string }) {
  switch (type) {
    case 'collection':
      return <FolderOpen className={cn('h-4 w-4', NODE_TYPE_CONFIG.collection.color)} />;
    case 'file':
      return <File className={cn('h-4 w-4', NODE_TYPE_CONFIG.file.color)} />;
    case 'chunk':
      return <FileText className={cn('h-4 w-4', NODE_TYPE_CONFIG.chunk.color)} />;
    case 'embedding':
      return <Sparkles className={cn('h-4 w-4', NODE_TYPE_CONFIG.embedding.color)} />;
    default:
      return null;
  }
}

/**
 * Status badge component
 */
function StatusBadge({ status }: { status: string }) {
  const config = EMBEDDING_STATUS_CONFIG[status as keyof typeof EMBEDDING_STATUS_CONFIG];
  if (!config || status === 'all') {
    return null;
  }

  return (
    <Badge
      className="text-xs"
      variant={
        status === 'complete' ? 'default' : status === 'failed' ? 'destructive' : 'secondary'
      }
    >
      {config.label}
    </Badge>
  );
}

/**
 * Get display name and subtitle for a node
 */
function getNodeDisplayInfo(
  type: string,
  data: BrowserNodeData
): { displayName: string; subtitle: string } {
  switch (type) {
    case 'collection': {
      const collData = data as CollectionData;
      return {
        displayName: collData.name,
        subtitle: `${collData.fileCount} files • ${collData.chunkCount} chunks`,
      };
    }
    case 'file': {
      const fileData = data as FileData;
      return { displayName: fileData.name, subtitle: shortenPath(fileData.path) };
    }
    case 'chunk': {
      const chunkData = data as ChunkData;
      const content = chunkData.content;
      return {
        displayName: `Chunk #${chunkData.index}`,
        subtitle: content.slice(0, 60) + (content.length > 60 ? '...' : ''),
      };
    }
    case 'embedding': {
      const embData = data as EmbeddingData;
      return { displayName: 'Vector', subtitle: `${embData.dimensions} dimensions` };
    }
    default:
      return { displayName: '', subtitle: '' };
  }
}

/**
 * Get the appropriate empty state message based on current search state
 */
function getEmptyStateMessage(
  isSearching: boolean,
  isSemanticMode: boolean,
  hasSearched: boolean,
  nodesLength: number,
  defaultMessage: string
): string {
  if (isSearching) {
    return 'Searching...';
  }
  // Show "no results" message when in semantic mode, search was performed, and there are no nodes
  if (isSemanticMode && hasSearched && nodesLength === 0) {
    return 'No matching results found. Try adjusting your search query or threshold.';
  }
  return defaultMessage;
}

/**
 * CollectionBrowser - Unified hierarchical browser
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This component handles multiple search modes, tree state, and semantic search with aggregated scores
export function CollectionBrowser({
  data,
  onSelect,
  onMultiSelect,
  onDoubleClick,
  onContextMenu,
  height = 600,
  className,
  multiSelectEnabled = false,
  isLoading = false,
  emptyMessage = 'No collections found. Import files to get started.',
  bulkActions = [],
  showBulkActionBar = true,
  sortState,
  onSortChange,
  expandedIds: controlledExpandedIds,
  onExpandedIdsChange,
  selectedId: controlledSelectedId,
  onSelectedIdChange,
  searchMode = 'quick',
  semanticResults,
  isSearching = false,
  hasSearched = false,
  filters: controlledFilters,
}: CollectionBrowserProps) {
  // Filter state - support controlled and uncontrolled modes
  const [internalFilters] = React.useState<CollectionBrowserFilters>(() => ({
    ...DEFAULT_FILTERS,
    nodeTypes: new Set(DEFAULT_FILTERS.nodeTypes),
  }));
  const filters = controlledFilters ?? internalFilters;

  // Selection state - support controlled and uncontrolled modes
  const [internalSelectedId, setInternalSelectedId] = React.useState<string | null>(null);
  const selectedId = controlledSelectedId !== undefined ? controlledSelectedId : internalSelectedId;
  const setSelectedId = onSelectedIdChange ?? setInternalSelectedId;

  const [multiSelectedIds, setMultiSelectedIds] = React.useState<Set<string>>(new Set());

  // Expansion state - support controlled and uncontrolled modes
  const [internalExpandedIds, setInternalExpandedIds] = React.useState<Set<string>>(new Set());
  const isControlledExpansion = controlledExpandedIds !== undefined;
  const expandedIds = isControlledExpansion ? controlledExpandedIds : internalExpandedIds;

  // Determine if semantic results should filter the tree
  const hasSemanticResults = semanticResults && semanticResults.length > 0;
  const isSemanticMode = searchMode === 'semantic';
  // Show score column whenever in semantic mode (not just when results exist)
  const showScoreColumn = isSemanticMode;
  // Filter to semantic results when: in semantic mode AND (has results OR search was performed)
  const shouldFilterToSemanticResults = isSemanticMode && (hasSemanticResults || hasSearched);

  // Build tree structure with hierarchical sorting
  const {
    nodes,
    searchMatchIds,
    searchExpandIds,
    similarityScores,
    semanticMatchIds,
    semanticExpandIds,
  } = useCollectionTree({
    data,
    filters,
    expandedIds,
    ...(sortState ? { sortState } : {}),
    ...(shouldFilterToSemanticResults
      ? { semanticResults: semanticResults ?? [], filterToSemanticResults: true }
      : {}),
  });

  // Track previous search query to detect changes
  const prevSearchQuery = React.useRef(filters.searchQuery);

  // Callback to expand nodes for search results
  const expandForSearch = React.useCallback(
    (idsToExpand: Set<string>) => {
      const currentExpanded = isControlledExpansion ? controlledExpandedIds : internalExpandedIds;
      const next = new Set(currentExpanded);
      for (const id of idsToExpand) {
        next.add(id);
      }
      if (isControlledExpansion && onExpandedIdsChange) {
        onExpandedIdsChange(next);
      } else {
        setInternalExpandedIds(next);
      }
    },
    [isControlledExpansion, controlledExpandedIds, internalExpandedIds, onExpandedIdsChange]
  );

  // Auto-expand nodes when search query changes to reveal matches
  React.useEffect(() => {
    const queryChanged = filters.searchQuery !== prevSearchQuery.current;
    if (!queryChanged) {
      return;
    }

    prevSearchQuery.current = filters.searchQuery;
    const shouldExpand = filters.searchQuery && searchExpandIds.size > 0;
    if (shouldExpand) {
      expandForSearch(searchExpandIds);
    }
  }, [filters.searchQuery, searchExpandIds, expandForSearch]);

  // Track previous semantic results to detect changes
  const prevSemanticResultsLength = React.useRef<number | undefined>(undefined);

  // Auto-expand nodes when semantic search results arrive
  React.useEffect(() => {
    // Skip if not in semantic mode or no results
    if (!(isSemanticMode && semanticResults)) {
      return;
    }

    // Only expand when results length changes (new results arrived)
    const resultsChanged = prevSemanticResultsLength.current !== semanticResults.length;
    if (!resultsChanged) {
      return;
    }

    prevSemanticResultsLength.current = semanticResults.length;

    // Auto-expand ancestors to reveal semantic matches
    if (semanticResults.length > 0 && semanticExpandIds.size > 0) {
      expandForSearch(semanticExpandIds);
    }
  }, [isSemanticMode, semanticResults, semanticExpandIds, expandForSearch]);

  // Handle toggle expand
  const handleToggleExpand = React.useCallback(
    (nodeId: string) => {
      const currentExpanded = isControlledExpansion ? controlledExpandedIds : internalExpandedIds;
      const next = new Set(currentExpanded);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }

      if (isControlledExpansion && onExpandedIdsChange) {
        onExpandedIdsChange(next);
      } else {
        setInternalExpandedIds(next);
      }
    },
    [isControlledExpansion, controlledExpandedIds, internalExpandedIds, onExpandedIdsChange]
  );

  // Handle selection
  const handleSelect = React.useCallback(
    (nodeId: string | null) => {
      setSelectedId(nodeId);
      if (nodeId) {
        const node = nodes.find((n) => n.id === nodeId);
        if (node && onSelect) {
          onSelect(nodeId, node.type, node.data);
        }
      }
    },
    [nodes, onSelect]
  );

  // Handle multi-select change
  const handleMultiSelectChange = React.useCallback(
    (newSelection: Set<string>) => {
      setMultiSelectedIds(newSelection);
      onMultiSelect?.(newSelection);
    },
    [onMultiSelect]
  );

  // Build map of node ID to node type for bulk actions
  const nodeTypeMap = React.useMemo(() => {
    const map = new Map<string, CollectionNodeType>();
    for (const node of nodes) {
      map.set(node.id, node.type as CollectionNodeType);
    }
    return map;
  }, [nodes]);

  // Handle clearing selection
  const handleClearSelection = React.useCallback(() => {
    setMultiSelectedIds(new Set());
    onMultiSelect?.(new Set());
  }, [onMultiSelect]);

  // Handle double-click
  const handleDoubleClick = React.useCallback(
    (nodeId: string, node: TreeNode<BrowserNodeData>) => {
      if (onDoubleClick) {
        onDoubleClick(nodeId, node.type, node.data);
      }
    },
    [onDoubleClick]
  );

  // Handle context menu
  const handleContextMenu = React.useCallback(
    (nodeId: string, node: TreeNode<BrowserNodeData>, event: React.MouseEvent) => {
      if (onContextMenu) {
        onContextMenu(nodeId, node.type, node.data, event);
      }
    },
    [onContextMenu]
  );

  // Convert hierarchical sort state to TreeTable's column-based format
  const treeTableSortState: SortState | undefined = React.useMemo(() => {
    if (!sortState) {
      return;
    }
    const columnId = SORT_KEY_TO_COLUMN[sortState.key];
    return { columnId, direction: sortState.direction };
  }, [sortState]);

  // Handle sort changes from TreeTable and convert to CollectionSortState
  const handleTreeTableSortChange = React.useCallback(
    (columnId: string, direction: SortDirection) => {
      if (!onSortChange) {
        return;
      }

      if (direction === null) {
        onSortChange(null);
      } else {
        const sortKey = COLUMN_TO_SORT_KEY[columnId];
        if (sortKey) {
          onSortChange({ key: sortKey, direction });
        }
      }
    },
    [onSortChange]
  );

  // Define base columns - adjust widths based on whether score column is shown
  const baseColumns: TreeTableColumn<BrowserNodeData>[] = React.useMemo(
    () => [
      {
        id: 'name',
        header: 'Name',
        // Narrower in semantic mode to make room for score column
        width: showScoreColumn ? '30%' : '40%',
        minWidth: 150,
        sortable: true,
        accessorFn: (node) => getNodeDisplayInfo(node.type, node.data).displayName.toLowerCase(),
        cell: ({ node }) => {
          const { data: nodeData, type } = node;
          const { displayName, subtitle } = getNodeDisplayInfo(type, nodeData);
          // For files, show full path in tooltip; otherwise use subtitle
          const subtitleTooltip = type === 'file' ? (nodeData as FileData).path : subtitle;

          return (
            <TooltipProvider delayDuration={300}>
              <div className="flex min-w-0 max-w-full items-center gap-2 overflow-hidden">
                <NodeIcon type={type} />
                <div className="min-w-0 flex-1 overflow-hidden">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div className="cursor-default truncate font-medium">{displayName}</div>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs" side="top">
                      {displayName}
                    </TooltipContent>
                  </Tooltip>
                  {subtitle && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <div className="cursor-default truncate text-muted-foreground text-xs">
                          {subtitle}
                        </div>
                      </TooltipTrigger>
                      <TooltipContent
                        className="max-w-md break-all font-mono text-xs"
                        side="bottom"
                      >
                        {subtitleTooltip}
                      </TooltipContent>
                    </Tooltip>
                  )}
                </div>
              </div>
            </TooltipProvider>
          );
        },
      },
      {
        id: 'status',
        header: 'Status',
        width: showScoreColumn ? '10%' : '15%',
        sortable: true,
        accessorFn: (node) => {
          const { data: nodeData, type } = node;
          if (type === 'file') {
            return (nodeData as FileData).embeddingStatus;
          }
          if (type === 'chunk') {
            return (nodeData as ChunkData).embeddingStatus;
          }
          return '';
        },
        cell: ({ node }) => {
          const { data: nodeData, type } = node;
          if (type === 'file') {
            return <StatusBadge status={(nodeData as FileData).embeddingStatus} />;
          }
          if (type === 'chunk') {
            return <StatusBadge status={(nodeData as ChunkData).embeddingStatus} />;
          }
          return null;
        },
      },
      {
        id: 'size',
        header: 'Size',
        width: showScoreColumn ? '10%' : '15%',
        sortable: true,
        accessorFn: (node) => {
          const { data: nodeData, type } = node;
          if (type === 'file') {
            return (nodeData as FileData).size;
          }
          if (type === 'chunk') {
            return (nodeData as ChunkData).tokenCount;
          }
          if (type === 'embedding') {
            return (nodeData as EmbeddingData).dimensions;
          }
          if (type === 'collection') {
            return (nodeData as CollectionData).embeddingCount;
          }
          return 0;
        },
        cell: ({ node }) => {
          const { data: nodeData, type } = node;
          if (type === 'file') {
            return (
              <span className="text-muted-foreground text-sm">
                {formatFileSize((nodeData as FileData).size)}
              </span>
            );
          }
          if (type === 'chunk') {
            return (
              <span className="text-muted-foreground text-sm">
                {(nodeData as ChunkData).tokenCount} tokens
              </span>
            );
          }
          if (type === 'embedding') {
            return (
              <span className="text-muted-foreground text-sm">
                {(nodeData as EmbeddingData).dimensions}d
              </span>
            );
          }
          if (type === 'collection') {
            return (
              <span className="text-muted-foreground text-sm">
                {(nodeData as CollectionData).embeddingCount} embeddings
              </span>
            );
          }
          return null;
        },
      },
      {
        id: 'meta',
        header: 'Info',
        // Hide completely in semantic mode to maximize space for score
        width: showScoreColumn ? '15%' : '30%',
        sortable: false,
        cell: ({ node }) => {
          const { data: nodeData, type } = node;
          if (type === 'collection') {
            const collData = nodeData as CollectionData;
            return (
              <div
                className="truncate text-muted-foreground text-xs"
                title={`${collData.modelId} • ${collData.dimensions}d`}
              >
                {collData.modelId} • {collData.dimensions}d
              </div>
            );
          }
          if (type === 'file') {
            const fileData = nodeData as FileData;
            const text =
              fileData.embeddingProgress !== undefined && fileData.embeddingProgress < 100
                ? `${fileData.chunkCount} chunks (${fileData.embeddingProgress}%)`
                : `${fileData.chunkCount} chunks`;
            return (
              <div className="truncate text-muted-foreground text-xs" title={text}>
                {text}
              </div>
            );
          }
          return null;
        },
      },
    ],
    [showScoreColumn]
  );

  // Score column for semantic search mode - always present when in semantic mode
  const scoreColumn: TreeTableColumn<BrowserNodeData> = React.useMemo(
    () => ({
      id: 'score',
      header: 'Score',
      width: '20%',
      minWidth: 100,
      sortable: true,
      accessorFn: (node) => similarityScores.get(node.id) ?? 0,
      cell: ({ node }) => {
        const score = similarityScores.get(node.id);

        // Show placeholder when no score (before search or no results)
        if (score === undefined) {
          return <span className="text-muted-foreground/50 text-xs">—</span>;
        }

        const percentage = Math.round(score * 100);
        const isDirectMatch = semanticMatchIds.has(node.id);

        return (
          <div className="flex items-center gap-2">
            <Progress
              className={cn('h-2 w-12 flex-shrink-0', isDirectMatch ? 'bg-primary/20' : 'bg-muted')}
              value={percentage}
            />
            <span
              className={cn(
                'whitespace-nowrap font-mono text-xs tabular-nums',
                isDirectMatch ? 'font-medium text-primary' : 'text-muted-foreground'
              )}
            >
              {percentage}%
            </span>
          </div>
        );
      },
    }),
    [similarityScores, semanticMatchIds]
  );

  // Combine columns based on search mode
  // Score column is always shown in semantic mode (not just when results exist)
  const columns: TreeTableColumn<BrowserNodeData>[] = React.useMemo(() => {
    if (showScoreColumn) {
      // Insert score column after name column (index 1)
      return [...baseColumns.slice(0, 1), scoreColumn, ...baseColumns.slice(1)].filter(
        (col): col is TreeTableColumn<BrowserNodeData> => col !== undefined
      );
    }
    return baseColumns;
  }, [baseColumns, scoreColumn, showScoreColumn]);

  // Determine which IDs to highlight based on mode
  const highlightedIds = isSemanticMode && hasSemanticResults ? semanticMatchIds : searchMatchIds;

  // Compute empty state message
  const displayEmptyMessage = getEmptyStateMessage(
    isSearching,
    isSemanticMode,
    hasSearched,
    nodes.length,
    emptyMessage
  );

  // Loading state
  if (isLoading) {
    return (
      <div
        className={cn('flex items-center justify-center bg-background', className)}
        style={{ height }}
      >
        <div className="text-muted-foreground text-sm">Loading...</div>
      </div>
    );
  }

  return (
    <div className={cn('relative flex flex-col bg-background', className)} style={{ height }}>
      <div className="relative flex-1 overflow-hidden">
        {/* Search loading overlay */}
        {isSearching && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/50">
            <div className="text-muted-foreground text-sm">Searching...</div>
          </div>
        )}

        <TreeTable
          columns={columns}
          expandedIds={expandedIds}
          nodes={nodes}
          onSelect={handleSelect}
          onToggleExpand={handleToggleExpand}
          selectedId={selectedId}
          selectionMode={multiSelectEnabled ? 'multi' : 'single'}
          {...(multiSelectEnabled
            ? {
                multiSelectedIds,
                onMultiSelectChange: handleMultiSelectChange,
              }
            : {})}
          ariaLabel="Collection browser"
          emptyState={
            <div className="p-4 text-muted-foreground text-sm">{displayEmptyMessage}</div>
          }
          highlightedIds={highlightedIds}
          maxHeight="none"
          onRowContextMenu={handleContextMenu}
          onRowDoubleClick={handleDoubleClick}
          rowHeight={48}
          {...(treeTableSortState ? { sortState: treeTableSortState } : {})}
          {...(onSortChange ? { onSortChange: handleTreeTableSortChange } : {})}
        />
      </div>

      {/* Bulk Action Bar - floating at the bottom when items are selected */}
      {multiSelectEnabled && showBulkActionBar && multiSelectedIds.size > 0 && (
        <div className="-translate-x-1/2 absolute bottom-4 left-1/2 z-20">
          <BulkActionBar
            actions={bulkActions}
            nodeTypes={nodeTypeMap}
            onClearSelection={handleClearSelection}
            selectedIds={multiSelectedIds}
          />
        </div>
      )}
    </div>
  );
}

CollectionBrowser.displayName = 'CollectionBrowser';

export default CollectionBrowser;
