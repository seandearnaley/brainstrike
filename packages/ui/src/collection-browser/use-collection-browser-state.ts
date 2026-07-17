/**
 * useCollectionBrowserState
 *
 * Manages all state and event handlers for the CollectionBrowser component,
 * including controlled/uncontrolled selection, expansion, and auto-expand logic.
 */

import * as React from 'react';
import type { SortDirection, SortState, TreeNode } from '../tree-table/types';
import type {
  BrowserNodeData,
  CollectionBrowserFilters,
  CollectionNodeType,
  GroupByKey,
  SearchMode,
  SemanticSearchResult,
} from './types';
import { DEFAULT_FILTERS } from './types';
import type {
  CollectionSortKey,
  CollectionSortState,
  CollectionTreeInput,
} from './use-collection-tree';
import { useCollectionTree } from './use-collection-tree';

const COLUMN_TO_SORT_KEY: Record<string, CollectionSortKey> = {
  meta: 'count',
  name: 'name',
  score: 'score',
  size: 'size',
  status: 'status',
};

const SORT_KEY_TO_COLUMN: Record<CollectionSortKey, string> = {
  count: 'meta',
  name: 'name',
  score: 'score',
  size: 'size',
  status: 'status',
};

function sameNodeTypes(
  left: ReadonlySet<CollectionNodeType>,
  right: ReadonlySet<CollectionNodeType>
): boolean {
  if (left === right) {
    return true;
  }
  if (left.size !== right.size) {
    return false;
  }
  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }
  return true;
}

/**
 * Apply a deferred search query onto filter state.
 * When the deferred value lags behind keystrokes, keep the previous query so
 * expensive filtering (and selection-clear side effects) do not run eagerly.
 *
 * Controlled parents (e.g. CollectionBrowserView) often rebuild a fresh `filters`
 * object on every keystroke — including a new `nodeTypes` Set with the same
 * members. While search is lagging, reuse the previous composed filters object
 * so `useCollectionTree` memos are not defeated by identity churn.
 */
export function withDeferredSearchQuery(
  filters: CollectionBrowserFilters,
  deferredSearchQuery: string,
  previousDeferredFilters: CollectionBrowserFilters | null = null
): CollectionBrowserFilters {
  if (deferredSearchQuery === filters.searchQuery) {
    return filters;
  }
  if (
    previousDeferredFilters !== null &&
    previousDeferredFilters.searchQuery === deferredSearchQuery &&
    previousDeferredFilters.embeddingStatus === filters.embeddingStatus &&
    previousDeferredFilters.searchMatchesOnly === filters.searchMatchesOnly &&
    sameNodeTypes(previousDeferredFilters.nodeTypes, filters.nodeTypes)
  ) {
    return previousDeferredFilters;
  }
  return { ...filters, searchQuery: deferredSearchQuery };
}

interface UseCollectionBrowserStateOptions {
  data: CollectionTreeInput;
  expandedIds?: Set<string> | undefined;
  filters?: CollectionBrowserFilters | undefined;
  groupBy?: GroupByKey | undefined;
  hasSearched?: boolean | undefined;
  onContextMenu?:
    | ((nodeId: string, nodeType: string, data: BrowserNodeData, event: React.MouseEvent) => void)
    | undefined;
  onDoubleClick?: ((nodeId: string, nodeType: string, data: BrowserNodeData) => void) | undefined;
  onExpandedIdsChange?: ((ids: Set<string>) => void) | undefined;
  onMultiSelect?: ((nodeIds: Set<string>) => void) | undefined;
  onSelect?: ((nodeId: string, nodeType: string, data: BrowserNodeData) => void) | undefined;
  onSelectedIdChange?: ((id: string | null) => void) | undefined;
  onSortChange?: ((sortState: CollectionSortState | null) => void) | undefined;
  searchMode?: SearchMode | undefined;
  selectedId?: string | null | undefined;
  semanticResults?: SemanticSearchResult[] | undefined;
  sortState?: CollectionSortState | undefined;
}

export interface UseCollectionBrowserStateResult {
  columns: null; // columns are built by useCollectionBrowserColumns
  expandedIds: Set<string>;
  filters: CollectionBrowserFilters;
  handleClearSelection: () => void;
  handleContextMenu: (
    nodeId: string,
    node: TreeNode<BrowserNodeData>,
    event: React.MouseEvent
  ) => void;
  handleDoubleClick: (nodeId: string, node: TreeNode<BrowserNodeData>) => void;
  handleMultiSelectChange: (newSelection: Set<string>) => void;
  handleSelect: (nodeId: string | null) => void;
  handleToggleExpand: (nodeId: string) => void;
  handleTreeTableSortChange: (columnId: string, direction: SortDirection) => void;
  hasSemanticResults: boolean;
  highlightedIds: Set<string>;
  isSemanticMode: boolean;
  multiSelectedIds: Set<string>;
  nodes: ReturnType<typeof useCollectionTree>['nodes'];
  nodeTypeMap: Map<string, CollectionNodeType>;
  searchMatchIds: Set<string>;
  selectedId: string | null;
  semanticMatchIds: Set<string>;
  showScoreColumn: boolean;
  similarityScores: Map<string, number>;
  treeTableSortState: SortState | undefined;
}

export function useCollectionBrowserState({
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
  searchMode = 'quick',
  semanticResults,
  hasSearched = false,
  filters: controlledFilters,
  groupBy,
}: UseCollectionBrowserStateOptions): UseCollectionBrowserStateResult {
  const [internalFilters] = React.useState<CollectionBrowserFilters>(() => ({
    ...DEFAULT_FILTERS,
    nodeTypes: new Set(DEFAULT_FILTERS.nodeTypes),
  }));
  const filters = controlledFilters ?? internalFilters;

  // Defer the search query to keep typing responsive on large trees.
  // Expensive tree filtering runs in a lower-priority render while the
  // input stays responsive — same pattern as file-explorer quick filter.
  const deferredSearchQuery = React.useDeferredValue(filters.searchQuery);
  const previousDeferredFiltersRef = React.useRef<CollectionBrowserFilters | null>(null);
  const deferredFilters = React.useMemo(() => {
    const next = withDeferredSearchQuery(
      filters,
      deferredSearchQuery,
      previousDeferredFiltersRef.current
    );
    previousDeferredFiltersRef.current = next;
    return next;
  }, [deferredSearchQuery, filters]);

  const [internalSelectedId, setInternalSelectedId] = React.useState<string | null>(null);
  const selectedId = controlledSelectedId === undefined ? internalSelectedId : controlledSelectedId;
  const setSelectedId = onSelectedIdChange ?? setInternalSelectedId;
  const setSelectedIdRef = React.useRef(setSelectedId);

  React.useEffect(() => {
    setSelectedIdRef.current = setSelectedId;
  }, [setSelectedId]);

  const [multiSelectedIds, setMultiSelectedIds] = React.useState<Set<string>>(new Set());

  const [internalExpandedIds, setInternalExpandedIds] = React.useState<Set<string>>(new Set());
  const isControlledExpansion = controlledExpandedIds !== undefined;
  const expandedIds = isControlledExpansion ? controlledExpandedIds : internalExpandedIds;

  const hasSemanticResults = semanticResults && semanticResults.length > 0;
  const isSemanticMode = searchMode === 'semantic';
  const showScoreColumn = isSemanticMode;
  const shouldFilterToSemanticResults = isSemanticMode && (hasSemanticResults || hasSearched);

  const {
    nodes,
    searchMatchIds,
    searchExpandIds,
    similarityScores,
    semanticMatchIds,
    semanticExpandIds,
  } = useCollectionTree({
    data,
    expandedIds,
    filters: deferredFilters,
    ...(sortState ? { sortState } : {}),
    ...(shouldFilterToSemanticResults
      ? { filterToSemanticResults: true, semanticResults: semanticResults ?? [] }
      : {}),
    ...(groupBy ? { groupBy } : {}),
  });

  const prevSearchQuery = React.useRef(deferredSearchQuery);
  const prevSemanticResultsLength = React.useRef<number | undefined>(undefined);

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

  React.useEffect(() => {
    const queryChanged = deferredSearchQuery !== prevSearchQuery.current;
    if (!queryChanged) {
      return;
    }
    prevSearchQuery.current = deferredSearchQuery;
    if (deferredSearchQuery && searchExpandIds.size > 0) {
      expandForSearch(searchExpandIds);
    }
  }, [deferredSearchQuery, searchExpandIds, expandForSearch]);

  React.useEffect(() => {
    if (!(isSemanticMode && semanticResults)) {
      return;
    }
    const resultsChanged = prevSemanticResultsLength.current !== semanticResults.length;
    if (!resultsChanged) {
      return;
    }
    prevSemanticResultsLength.current = semanticResults.length;
    if (semanticResults.length > 0 && semanticExpandIds.size > 0) {
      expandForSearch(semanticExpandIds);
    }
  }, [isSemanticMode, semanticResults, semanticExpandIds, expandForSearch]);

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
    [nodes, onSelect, setSelectedId]
  );

  const handleMultiSelectChange = React.useCallback(
    (newSelection: Set<string>) => {
      setMultiSelectedIds(newSelection);
      onMultiSelect?.(newSelection);
    },
    [onMultiSelect]
  );

  const nodeTypeMap = React.useMemo(() => {
    const map = new Map<string, CollectionNodeType>();
    for (const node of nodes) {
      map.set(node.id, node.type as CollectionNodeType);
    }
    return map;
  }, [nodes]);

  const handleClearSelection = React.useCallback(() => {
    setMultiSelectedIds(new Set());
    onMultiSelect?.(new Set());
  }, [onMultiSelect]);

  const handleDoubleClick = React.useCallback(
    (nodeId: string, node: TreeNode<BrowserNodeData>) => {
      if (onDoubleClick) {
        onDoubleClick(nodeId, node.type, node.data);
      }
    },
    [onDoubleClick]
  );

  const handleContextMenu = React.useCallback(
    (nodeId: string, node: TreeNode<BrowserNodeData>, event: React.MouseEvent) => {
      if (onContextMenu) {
        onContextMenu(nodeId, node.type, node.data, event);
      }
    },
    [onContextMenu]
  );

  const treeTableSortState: SortState | undefined = React.useMemo(() => {
    if (!sortState) {
      return;
    }
    const columnId = SORT_KEY_TO_COLUMN[sortState.key];
    return { columnId, direction: sortState.direction };
  }, [sortState]);

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
          onSortChange({ direction, key: sortKey });
        }
      }
    },
    [onSortChange]
  );

  // Clear selectedId when the selected node is no longer in the visible tree
  // (e.g., after filtering, search mode change, or data update)
  React.useEffect(() => {
    if (selectedId !== null && nodes.length > 0) {
      const stillVisible = nodes.some((n) => n.id === selectedId);
      if (!stillVisible) {
        setSelectedIdRef.current(null);
      }
    }
  }, [selectedId, nodes]);

  const highlightedIds = isSemanticMode && hasSemanticResults ? semanticMatchIds : searchMatchIds;

  return {
    columns: null,
    expandedIds,
    filters,
    handleClearSelection,
    handleContextMenu,
    handleDoubleClick,
    handleMultiSelectChange,
    handleSelect,
    handleToggleExpand,
    handleTreeTableSortChange,
    hasSemanticResults: !!hasSemanticResults,
    highlightedIds,
    isSemanticMode,
    multiSelectedIds,
    nodes,
    nodeTypeMap,
    searchMatchIds,
    selectedId,
    semanticMatchIds,
    showScoreColumn,
    similarityScores,
    treeTableSortState,
  };
}
