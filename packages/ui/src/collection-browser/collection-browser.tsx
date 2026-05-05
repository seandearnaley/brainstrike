/**
 * CollectionBrowser Component
 *
 * A unified hierarchical browser for collections, files, chunks, and embeddings.
 * Combines the TreeTable with FilterBar for a complete browsing experience.
 */

import * as React from 'react';
import { cn } from '../lib/utils';
import { DEFAULT_AUTO_PAGED_ROW_THRESHOLD, TreeTable } from '../tree-table/tree-table';
import type { TreeTablePaginationOptions, TreeTableWindowingStrategy } from '../tree-table/types';
import type { BulkAction } from './bulk-action-bar';
import { BulkActionBar } from './bulk-action-bar';
import type {
  BrowserNodeData,
  CollectionBrowserFilters,
  GroupByKey,
  SearchMode,
  SemanticSearchResult,
} from './types';
import { useCollectionBrowserColumns } from './use-collection-browser-columns';
import { useCollectionBrowserState } from './use-collection-browser-state';
import type { CollectionSortState, CollectionTreeInput } from './use-collection-tree';

export { shortenPath } from './utils';

const DEFAULT_BULK_ACTIONS: BulkAction[] = [];
const DEFAULT_TREE_WINDOWING_STRATEGY: TreeTableWindowingStrategy = 'auto';
const DEFAULT_SEMANTIC_PAGE_SIZE_OPTIONS = [25, 50, 100, 250] as const;

/**
 * Props for the CollectionBrowser component
 */
export interface CollectionBrowserProps {
  /** Bulk actions for multi-select mode */
  bulkActions?: BulkAction[];
  /** Custom class name */
  className?: string;
  /** Set of node IDs that are in the active context (e.g., selected in file explorer) */
  contextNodeIds?: Set<string>;
  /** Input data for the tree */
  data: CollectionTreeInput;
  /** Empty state message */
  emptyMessage?: string;
  /** Expanded node IDs (controlled mode) */
  expandedIds?: Set<string>;
  /** Current filter state (controlled) */
  filters?: CollectionBrowserFilters;
  /** Grouping key for organizing tree nodes (default: 'none') */
  groupBy?: GroupByKey;
  /** Whether a semantic search has been executed at least once */
  hasSearched?: boolean;
  /** Height of the component */
  height?: number | string;
  /** Loading state */
  isLoading?: boolean;
  /** Whether semantic search is currently loading */
  isSearching?: boolean;
  /** Whether to enable multi-select mode */
  multiSelectEnabled?: boolean;
  /** Called when context menu is requested */
  onContextMenu?: (
    nodeId: string,
    nodeType: string,
    data: BrowserNodeData,
    event: React.MouseEvent
  ) => void;
  /** Called when a node is double-clicked */
  onDoubleClick?: (nodeId: string, nodeType: string, data: BrowserNodeData) => void;
  /** Called when expansion state changes (controlled mode) */
  onExpandedIdsChange?: (ids: Set<string>) => void;
  /** Callback when filters change (controlled) */
  onFiltersChange?: (filters: CollectionBrowserFilters) => void;
  /** Called when multiple nodes are selected */
  onMultiSelect?: (nodeIds: Set<string>) => void;
  /** Called when a node is selected */
  onSelect?: (nodeId: string, nodeType: string, data: BrowserNodeData) => void;
  /** Called when selection changes (controlled mode) */
  onSelectedIdChange?: (id: string | null) => void;
  /** Called when sort changes */
  onSortChange?: (sortState: CollectionSortState | null) => void;
  /** Current search mode (quick filter or semantic search) */
  searchMode?: SearchMode;
  /** Selected node ID (controlled mode) */
  selectedId?: string | null;
  /** Semantic search results to overlay on tree */
  semanticResults?: SemanticSearchResult[];
  /** Whether to show the bulk action bar when items are selected */
  showBulkActionBar?: boolean;
  /** Whether to show checkboxes for multi-select */
  showCheckbox?: boolean;
  /** Hierarchical sort state (sorts within each level of the tree) */
  sortState?: CollectionSortState;
  /** Auto mode threshold for switching semantic search to paged mode */
  treeAutoPagedRowThreshold?: number;
  /** Optional pagination configuration for tree table */
  treePagination?: TreeTablePaginationOptions;
  /** Tree row windowing strategy */
  treeWindowingStrategy?: TreeTableWindowingStrategy;
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
  if (isSemanticMode && hasSearched && nodesLength === 0) {
    return 'No matching results found. Try adjusting your search query or threshold.';
  }
  return defaultMessage;
}

/**
 * CollectionBrowser - Unified hierarchical browser
 */
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
  bulkActions = DEFAULT_BULK_ACTIONS,
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
  groupBy,
  contextNodeIds,
  showCheckbox = false,
  treeWindowingStrategy = DEFAULT_TREE_WINDOWING_STRATEGY,
  treeAutoPagedRowThreshold = DEFAULT_AUTO_PAGED_ROW_THRESHOLD,
  treePagination,
}: CollectionBrowserProps) {
  const {
    nodes,
    selectedId,
    multiSelectedIds,
    expandedIds,
    isSemanticMode,
    showScoreColumn,
    highlightedIds,
    semanticMatchIds,
    similarityScores,
    nodeTypeMap,
    treeTableSortState,
    handleToggleExpand,
    handleSelect,
    handleMultiSelectChange,
    handleClearSelection,
    handleDoubleClick,
    handleContextMenu,
    handleTreeTableSortChange,
  } = useCollectionBrowserState({
    data,
    onSelect,
    onMultiSelect,
    onDoubleClick,
    onContextMenu,
    sortState,
    onSortChange,
    expandedIds: controlledExpandedIds,
    onExpandedIdsChange,
    selectedId: controlledSelectedId,
    onSelectedIdChange,
    searchMode,
    semanticResults,
    hasSearched,
    filters: controlledFilters,
    groupBy,
  });

  const columns = useCollectionBrowserColumns({
    showScoreColumn,
    similarityScores,
    semanticMatchIds,
  });

  const displayEmptyMessage = getEmptyStateMessage(
    isSearching,
    isSemanticMode,
    hasSearched,
    nodes.length,
    emptyMessage
  );

  const shouldUseSearchWindowingContext =
    isSemanticMode && (hasSearched || (semanticResults?.length ?? 0) > 0);
  const treeAutoWindowingContext = shouldUseSearchWindowingContext ? 'search' : 'browse';
  const resolvedTreePagination = React.useMemo<TreeTablePaginationOptions | undefined>(() => {
    if (treePagination) {
      return treePagination;
    }
    if (!shouldUseSearchWindowingContext) {
      return;
    }
    return {
      pageSizeOptions: DEFAULT_SEMANTIC_PAGE_SIZE_OPTIONS,
      showControls: true,
      showItemRange: true,
      pageInfo: 'semantic results',
    };
  }, [treePagination, shouldUseSearchWindowingContext]);

  return (
    <div
      className={cn('relative flex min-h-0 min-w-0 flex-col bg-background', className)}
      style={{ height }}
    >
      <div
        aria-busy={isLoading}
        className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden"
        data-testid="collection-tree-region"
      >
        {isLoading && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-background/70">
            <div className="text-muted-foreground text-sm">Loading...</div>
          </div>
        )}

        {isSearching && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/50">
            <div className="text-muted-foreground text-sm">Searching...</div>
          </div>
        )}

        <TreeTable
          columns={columns}
          expandedIds={expandedIds}
          insetTreeControls
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
          {...(contextNodeIds ? { contextNodeIds } : {})}
          autoPagedRowThreshold={treeAutoPagedRowThreshold}
          autoWindowingContext={treeAutoWindowingContext}
          emptyState={
            <div className="p-4 text-muted-foreground text-sm">{displayEmptyMessage}</div>
          }
          highlightedIds={highlightedIds}
          maxHeight="none"
          onRowContextMenu={handleContextMenu}
          onRowDoubleClick={handleDoubleClick}
          rowHeight={48}
          showCheckbox={showCheckbox && multiSelectEnabled}
          windowingStrategy={treeWindowingStrategy}
          {...(resolvedTreePagination ? { pagination: resolvedTreePagination } : {})}
          {...(treeTableSortState ? { sortState: treeTableSortState } : {})}
          {...(onSortChange ? { onSortChange: handleTreeTableSortChange } : {})}
        />
      </div>

      {multiSelectEnabled && showBulkActionBar && multiSelectedIds.size > 0 && (
        <div className="absolute bottom-4 left-1/2 z-20 -translate-x-1/2">
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
