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
  name: 'name',
  status: 'status',
  size: 'size',
  meta: 'count',
  score: 'score',
};

const SORT_KEY_TO_COLUMN: Record<CollectionSortKey, string> = {
  name: 'name',
  status: 'status',
  size: 'size',
  count: 'meta',
  score: 'score',
};

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
    filters,
    expandedIds,
    ...(sortState ? { sortState } : {}),
    ...(shouldFilterToSemanticResults
      ? { semanticResults: semanticResults ?? [], filterToSemanticResults: true }
      : {}),
    ...(groupBy ? { groupBy } : {}),
  });

  const prevSearchQuery = React.useRef(filters.searchQuery);
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
    const queryChanged = filters.searchQuery !== prevSearchQuery.current;
    if (!queryChanged) {
      return;
    }
    prevSearchQuery.current = filters.searchQuery;
    if (filters.searchQuery && searchExpandIds.size > 0) {
      expandForSearch(searchExpandIds);
    }
  }, [filters.searchQuery, searchExpandIds, expandForSearch]);

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
          onSortChange({ key: sortKey, direction });
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
    nodes,
    columns: null,
    filters,
    selectedId,
    multiSelectedIds,
    expandedIds,
    isSemanticMode,
    showScoreColumn,
    hasSemanticResults: !!hasSemanticResults,
    highlightedIds,
    searchMatchIds,
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
  };
}
