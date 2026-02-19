/**
 * CollectionBrowser Component
 *
 * A unified hierarchical browser for collections, files, chunks, and embeddings.
 * Combines the TreeTable with FilterBar for a complete browsing experience.
 */

import type * as React from 'react';
import { cn } from '../lib/utils';
import { TreeTable } from '../tree-table/tree-table';
import type { BulkAction } from './bulk-action-bar';
import { BulkActionBar } from './bulk-action-bar';
import type {
  BrowserNodeData,
  CollectionBrowserFilters,
  SearchMode,
  SemanticSearchResult,
} from './types';
import { useCollectionBrowserColumns } from './use-collection-browser-columns';
import { useCollectionBrowserState } from './use-collection-browser-state';
import type { CollectionSortState, CollectionTreeInput } from './use-collection-tree';

export { shortenPath } from './utils';

const DEFAULT_BULK_ACTIONS: BulkAction[] = [];

/**
 * Props for the CollectionBrowser component
 */
export interface CollectionBrowserProps {
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
