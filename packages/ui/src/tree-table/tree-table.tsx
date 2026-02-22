/**
 * TreeTable Component
 *
 * A virtualized hierarchical table component supporting:
 * - Tree structure with expand/collapse
 * - Virtual scrolling via @tanstack/react-virtual
 * - Single and multi-selection with optional checkboxes
 * - Keyboard navigation
 * - Search highlighting
 * - Context awareness indicators
 * - Sorting with aria-sort
 * - Full WAI-ARIA treegrid compliance
 */

import { usePagination } from '@brainstrike/hooks';
import { useVirtualizer } from '@tanstack/react-virtual';
import * as React from 'react';
import { useResizeObserver } from '../hooks/use-resize-observer';
import { warnCycleOnce } from '../lib/cycle-warning';
import { cn } from '../lib/utils';
import { Table, TableBody, TableHead, TableHeader, TableRow } from '../table';
import { TablePagination } from '../table-pagination';
import { DEFAULT_ROW_HEIGHTS, TreeTableRow } from './tree-table-row';
import { createChildrenGetter, flattenTreeRecursive, getDescendantIds } from './tree-utils';
import type { CheckboxState, TreeNode, TreeTableProps } from './types';
import { type UseTreeKeyboardOptions, useTreeKeyboard } from './use-tree-keyboard';
import { useTreeTableHandlers } from './use-tree-table-handlers';

/**
 * Default overscan count for virtualization.
 * Higher values provide smoother scrolling at the cost of more DOM elements.
 */
const DEFAULT_OVERSCAN = 10;

const DEFAULT_MULTI_SELECTED = new Set<string>();
const DEFAULT_HIGHLIGHTED = new Set<string>();
const DEFAULT_CONTEXT_NODE_IDS = new Set<string>();
const DEFAULT_LOADING_NODE_IDS = new Set<string>();
const MAX_WARNED_CYCLE_NODE_IDS = 1000;
const DEFAULT_PAGE_SIZE = 50;
export const DEFAULT_AUTO_PAGED_ROW_THRESHOLD = 200;
const MIN_FALLBACK_VIRTUAL_ROWS = 1;

/**
 * Maps our SortDirection to ARIA sort values.
 */
function getAriaSortValue(
  columnId: string,
  sortState?: { columnId: string | null; direction: 'asc' | 'desc' | null }
): 'ascending' | 'descending' | 'none' | undefined {
  if (!sortState || sortState.columnId !== columnId) {
    return undefined;
  }
  if (sortState.direction === 'asc') {
    return 'ascending';
  }
  if (sortState.direction === 'desc') {
    return 'descending';
  }
  return 'none';
}

interface ResolveWindowingStrategyOptions {
  strategy: TreeTableProps<unknown>['windowingStrategy'];
  autoWindowingContext: NonNullable<TreeTableProps<unknown>['autoWindowingContext']>;
  rowCount: number;
  autoPagedRowThreshold: number;
}

function resolveWindowingStrategy({
  strategy,
  autoWindowingContext,
  rowCount,
  autoPagedRowThreshold,
}: ResolveWindowingStrategyOptions): 'virtual' | 'paged' | 'none' {
  if (strategy === 'none') {
    return 'none';
  }
  if (strategy === 'paged') {
    return 'paged';
  }
  if (strategy !== 'auto') {
    return 'virtual';
  }

  if (autoWindowingContext !== 'search') {
    return 'virtual';
  }

  const normalizedThreshold = Number.isFinite(autoPagedRowThreshold)
    ? autoPagedRowThreshold
    : DEFAULT_AUTO_PAGED_ROW_THRESHOLD;
  // Clamp to 1 so invalid/zero thresholds don't produce degenerate page math.
  // In search mode, this means `0` behaves as "always paged" once there is at least one row.
  return rowCount >= Math.max(1, normalizedThreshold) ? 'paged' : 'virtual';
}

function findRowElementByNodeId(
  container: HTMLElement,
  nodeId: string
): HTMLTableRowElement | null {
  const escapedNodeId = CSS.escape(nodeId);
  const directMatch = container.querySelector<HTMLTableRowElement>(
    `[data-node-id="${escapedNodeId}"]`
  );
  if (directMatch) {
    return directMatch;
  }

  // Fallback for edge-case selector parsing differences with quoted/special ids.
  const rows = container.querySelectorAll<HTMLTableRowElement>('[data-node-id]');
  for (const row of rows) {
    if (row.getAttribute('data-node-id') === nodeId) {
      return row;
    }
  }
  return null;
}

interface BuildTablePaginationPropsOptions {
  currentPage: number;
  onPageChange: (nextPage: number) => void;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  onPageSizeChange: (nextPageSize: number) => void;
  paginationOptions: TreeTableProps<unknown>['pagination'];
}

function buildTablePaginationProps({
  currentPage,
  onPageChange,
  pageSize,
  totalItems,
  totalPages,
  onPageSizeChange,
  paginationOptions,
}: BuildTablePaginationPropsOptions): React.ComponentProps<typeof TablePagination> {
  const tablePaginationProps: React.ComponentProps<typeof TablePagination> = {
    currentPage,
    onPageChange,
    pageSize,
    totalItems,
    totalPages,
    onPageSizeChange,
  };
  if (paginationOptions?.pageInfo !== undefined) {
    tablePaginationProps.pageInfo = paginationOptions.pageInfo;
  }
  if (paginationOptions?.pageSizeOptions !== undefined) {
    tablePaginationProps.pageSizeOptions = paginationOptions.pageSizeOptions;
  }
  if (paginationOptions?.showItemRange !== undefined) {
    tablePaginationProps.showItemRange = paginationOptions.showItemRange;
  }
  return tablePaginationProps;
}

interface RenderTableHeaderOptions<T> {
  showHeader: boolean;
  columns: TreeTableProps<T>['columns'];
  sortState: TreeTableProps<T>['sortState'];
  onSortChange: TreeTableProps<T>['onSortChange'];
  onSortClick: (columnId: string) => void;
}

function renderTableHeader<T>({
  showHeader,
  columns,
  sortState,
  onSortChange,
  onSortClick,
}: RenderTableHeaderOptions<T>): React.ReactNode {
  if (!showHeader) {
    return null;
  }

  return (
    <TableHeader className="sticky top-0 z-10 bg-background" role="rowgroup">
      <TableRow role="row">
        {columns.map((column) => {
          const ariaSortValue = column.sortable
            ? getAriaSortValue(column.id, sortState)
            : undefined;

          return (
            <TableHead
              aria-sort={ariaSortValue}
              className={cn(
                column.headerClassName,
                column.sortable && onSortChange && 'cursor-pointer select-none'
              )}
              key={column.id}
              onClick={() => column.sortable && onSortClick(column.id)}
              role="columnheader"
              style={{
                width: column.width,
                minWidth: column.minWidth,
                maxWidth: column.maxWidth,
              }}
            >
              <div className="flex items-center gap-1">
                {column.header ?? column.id}
                {column.sortable && sortState?.columnId === column.id && (
                  <span aria-hidden="true" className="text-xs">
                    {sortState.direction === 'asc'
                      ? '\u2191'
                      : sortState.direction === 'desc'
                        ? '\u2193'
                        : ''}
                  </span>
                )}
              </div>
            </TableHead>
          );
        })}
      </TableRow>
    </TableHeader>
  );
}

function resolveRowIndexOffset(showHeader: boolean): number {
  return showHeader ? 2 : 1;
}

function resolveTotalRowCount(rowCount: number, showHeader: boolean): number {
  return rowCount + (showHeader ? 1 : 0);
}

function resolveTableAriaRole(ariaRole: TreeTableProps<unknown>['ariaRole']): 'treegrid' | 'grid' {
  return ariaRole === 'grid' ? 'grid' : 'treegrid';
}

interface TreeTableViewportProps {
  className: string;
  maxHeight: string;
  parentRef: React.RefObject<HTMLDivElement | null>;
  children: React.ReactNode;
}

function TreeTableViewport({
  className,
  maxHeight,
  parentRef,
  children,
}: TreeTableViewportProps): React.ReactElement {
  return (
    <div className={className} ref={parentRef} style={{ maxHeight, height: '100%' }}>
      {children}
    </div>
  );
}

function buildFallbackVirtualItems(rowCount: number, overscan: number): Array<{ index: number }> {
  const fallbackCount = Math.min(rowCount, Math.max(MIN_FALLBACK_VIRTUAL_ROWS, overscan * 2));
  return Array.from({ length: fallbackCount }, (_, index) => ({ index }));
}

function resolveRenderedVirtualItems(
  isVirtualWindowing: boolean,
  virtualItems: Array<{ index: number }>,
  rowCount: number,
  overscan: number
): Array<{ index: number }> {
  if (!isVirtualWindowing) {
    return [];
  }
  if (virtualItems.length > 0 || rowCount === 0) {
    return virtualItems;
  }
  return buildFallbackVirtualItems(rowCount, overscan);
}

interface CheckboxStateContext<T> {
  getChildren: (node: TreeNode<T>) => TreeNode<T>[];
  multiSelectedIds: Set<string>;
  states: Map<string, CheckboxState>;
  visiting: Set<string>;
  warnedCycleNodeIds: Set<string>;
}

function getCycleFallbackState(
  nodeId: string,
  selectedIds: Set<string>,
  warnedCycleNodeIds: Set<string>
): CheckboxState {
  warnCycleOnce({
    nodeId,
    warnedNodeIds: warnedCycleNodeIds,
    // Cap warning memory instead of clearing it; avoids repeated warnings for the same IDs.
    maxWarnings: MAX_WARNED_CYCLE_NODE_IDS,
    warningMessage: `[TreeTable] Cycle detected while computing checkbox state for node "${nodeId}".`,
  });
  // Cycles indicate malformed tree data; prefer a conservative visual state
  // that avoids incorrectly showing a fully checked parent.
  return selectedIds.has(nodeId) ? 'indeterminate' : 'unchecked';
}

function aggregateChildStates<T>(
  children: TreeNode<T>[],
  context: CheckboxStateContext<T>
): CheckboxState {
  // TreeTable data is expected to be shallow (collection/file/chunk/embedding).
  // Recursive traversal keeps the state logic straightforward and cacheable.
  let hasSelectedDescendant = false;
  let allChildrenChecked = true;

  for (const child of children) {
    const childState = computeNodeState(child, context);
    if (childState !== 'unchecked') {
      hasSelectedDescendant = true;
    }
    if (childState !== 'checked') {
      allChildrenChecked = false;
    }
  }

  if (!hasSelectedDescendant) {
    return 'unchecked';
  }
  return allChildrenChecked ? 'checked' : 'indeterminate';
}

function mergeParentSelectionState(
  nodeId: string,
  childState: CheckboxState,
  selectedIds: Set<string>
): CheckboxState {
  if (!selectedIds.has(nodeId)) {
    return childState;
  }
  return childState === 'checked' ? 'checked' : 'indeterminate';
}

function computeNodeState<T>(node: TreeNode<T>, context: CheckboxStateContext<T>): CheckboxState {
  const cached = context.states.get(node.id);
  if (cached) {
    return cached;
  }

  if (context.visiting.has(node.id)) {
    const fallbackState = getCycleFallbackState(
      node.id,
      context.multiSelectedIds,
      context.warnedCycleNodeIds
    );
    context.states.set(node.id, fallbackState);
    return fallbackState;
  }

  context.visiting.add(node.id);
  const children = context.getChildren(node);
  const state =
    children.length === 0
      ? context.multiSelectedIds.has(node.id)
        ? 'checked'
        : 'unchecked'
      : mergeParentSelectionState(
          node.id,
          aggregateChildStates(children, context),
          context.multiSelectedIds
        );
  context.visiting.delete(node.id);

  context.states.set(node.id, state);
  return state;
}

function buildCheckboxStateMap<T>(
  nodes: TreeNode<T>[],
  getChildren: (node: TreeNode<T>) => TreeNode<T>[],
  multiSelectedIds: Set<string>,
  warnedCycleNodeIds: Set<string>
): Map<string, CheckboxState> {
  const context: CheckboxStateContext<T> = {
    getChildren,
    multiSelectedIds,
    states: new Map<string, CheckboxState>(),
    visiting: new Set<string>(),
    warnedCycleNodeIds,
  };

  for (const node of nodes) {
    if (!context.states.has(node.id)) {
      computeNodeState(node, context);
    }
  }

  return context.states;
}

/**
 * TreeTable - A virtualized hierarchical table component.
 *
 * Features:
 * - Virtual scrolling for large datasets (10k+ rows)
 * - Tree structure with expand/collapse
 * - Single and multi-selection modes with optional checkboxes
 * - Full keyboard navigation (arrow keys, Enter, Space, etc.)
 * - Search result highlighting
 * - Context awareness indicators
 * - Column sorting with ARIA sort indicators
 * - Lazy loading support for children
 * - Full WAI-ARIA treegrid compliance
 *
 * @example
 * ```tsx
 * <TreeTable
 *   nodes={fileNodes}
 *   columns={fileColumns}
 *   expandedIds={expandedIds}
 *   onToggleExpand={handleToggleExpand}
 *   selectedId={selectedId}
 *   onSelect={handleSelect}
 *   contextNodeIds={inContextIds}
 * />
 * ```
 */
export function TreeTable<T>({
  nodes,
  columns,
  expandedIds,
  onToggleExpand,
  selectedId = null,
  onSelect,
  multiSelectedIds = DEFAULT_MULTI_SELECTED,
  onMultiSelectChange,
  selectionMode = 'single',
  highlightedIds = DEFAULT_HIGHLIGHTED,
  contextNodeIds = DEFAULT_CONTEXT_NODE_IDS,
  rowHeight = DEFAULT_ROW_HEIGHTS,
  overscan = DEFAULT_OVERSCAN,
  windowingStrategy = 'virtual',
  autoWindowingContext = 'browse',
  autoPagedRowThreshold = DEFAULT_AUTO_PAGED_ROW_THRESHOLD,
  pagination,
  maxHeight = '600px',
  sortState,
  onSortChange,
  loadingNodeIds = DEFAULT_LOADING_NODE_IDS,
  className,
  rowClassName,
  emptyState,
  ariaLabel = 'Tree table',
  ariaRole = 'treegrid',
  showHeader = true,
  showCheckbox = false,
  onRowDoubleClick,
  onRowContextMenu,
}: TreeTableProps<T>) {
  const tableAriaRole = resolveTableAriaRole(ariaRole);
  const parentRef = React.useRef<HTMLDivElement>(null);
  // Diagnostic-only cycle warning cache. This is intentionally mutable and
  // excluded from memo deps because it does not affect rendered output.
  const warnedCycleNodeIdsRef = React.useRef<Set<string>>(new Set());

  const getChildren = React.useMemo(() => createChildrenGetter(nodes), [nodes]);

  const { rows, indexMap } = React.useMemo(() => {
    const nodesWithLoading =
      loadingNodeIds.size === 0
        ? nodes
        : nodes.map((node) => {
            const isLoading = loadingNodeIds.has(node.id);
            if (isLoading) {
              return node.isLoading === true ? node : { ...node, isLoading: true };
            }
            if (node.isLoading === true) {
              return { ...node, isLoading: false };
            }
            return node;
          });

    const rootsWithLoading = nodesWithLoading.filter((n) => n.parentId === null);
    const getChildrenWithLoading = createChildrenGetter(nodesWithLoading);

    return flattenTreeRecursive(
      rootsWithLoading,
      {
        expandedIds,
        selectedId,
        multiSelectedIds,
        highlightedIds,
        contextNodeIds,
        rowIndexOffset: resolveRowIndexOffset(showHeader),
      },
      getChildrenWithLoading
    );
  }, [
    nodes,
    expandedIds,
    selectedId,
    multiSelectedIds,
    highlightedIds,
    contextNodeIds,
    loadingNodeIds,
    showHeader,
  ]);

  const resolvedWindowingStrategy = React.useMemo(
    () =>
      resolveWindowingStrategy({
        strategy: windowingStrategy,
        autoWindowingContext,
        rowCount: rows.length,
        autoPagedRowThreshold,
      }),
    [windowingStrategy, autoWindowingContext, rows.length, autoPagedRowThreshold]
  );
  const isVirtualWindowing = resolvedWindowingStrategy === 'virtual';
  const isPagedWindowing = resolvedWindowingStrategy === 'paged';

  const [pageSize, setPageSize] = React.useState<number>(
    () => pagination?.pageSize ?? DEFAULT_PAGE_SIZE
  );
  React.useEffect(() => {
    if (pagination?.pageSize !== undefined) {
      setPageSize(pagination.pageSize);
    }
  }, [pagination?.pageSize]);

  const { currentPage, totalPages, startIndex, endIndex, goToPage, resetToFirstPage } =
    usePagination({
      totalItems: rows.length,
      pageSize,
    });

  const totalRowCount = resolveTotalRowCount(rows.length, showHeader);

  // O(1) node lookup map — avoids O(N) nodes.find() per row
  const nodeById = React.useMemo(() => {
    const map = new Map<string, TreeNode<T>>();
    for (const node of nodes) {
      map.set(node.id, node);
    }
    return map;
  }, [nodes]);

  // Compute checkbox states in a single bottom-up pass across the whole tree.
  // This avoids O(visibleRows * subtreeTraversal) work on each render.
  const checkboxStates = React.useMemo((): Map<string, CheckboxState> => {
    if (!showCheckbox) {
      return new Map();
    }
    return buildCheckboxStateMap(
      nodes,
      getChildren,
      multiSelectedIds,
      warnedCycleNodeIdsRef.current
    );
  }, [showCheckbox, nodes, multiSelectedIds, getChildren]);

  // Handle checkbox toggle - select/deselect node and all descendants
  const handleCheckboxChange = React.useCallback(
    (nodeId: string) => {
      if (!onMultiSelectChange) {
        return;
      }

      const node = nodeById.get(nodeId);
      if (!node) {
        return;
      }

      const descendants = getDescendantIds(node, getChildren);
      const currentState = checkboxStates.get(nodeId);
      const newSelection = new Set(multiSelectedIds);

      if (currentState === 'checked') {
        // Deselect this node and all descendants
        newSelection.delete(nodeId);
        for (const descId of descendants) {
          newSelection.delete(descId);
        }
      } else {
        // Select this node and all descendants
        newSelection.add(nodeId);
        for (const descId of descendants) {
          newSelection.add(descId);
        }
      }

      onMultiSelectChange(newSelection);
    },
    [nodeById, getChildren, multiSelectedIds, onMultiSelectChange, checkboxStates]
  );

  const getRowHeight = React.useCallback(
    (node: TreeNode<T>): number => {
      if (typeof rowHeight === 'function') {
        return rowHeight(node);
      }
      if (typeof rowHeight === 'number') {
        return rowHeight;
      }
      return rowHeight[node.type] ?? rowHeight['default'] ?? DEFAULT_ROW_HEIGHTS['default'] ?? 40;
    },
    [rowHeight]
  );

  const displayedRows = React.useMemo(
    () => (isPagedWindowing ? rows.slice(startIndex, endIndex) : rows),
    [isPagedWindowing, rows, startIndex, endIndex]
  );
  const pendingPagedScrollNodeIdRef = React.useRef<string | null>(null);

  const scrollPagedRowIntoView = React.useCallback((nodeId: string): boolean => {
    const parentElement = parentRef.current;
    if (!parentElement) {
      return false;
    }
    const rowElement = findRowElementByNodeId(parentElement, nodeId);
    if (!rowElement) {
      return false;
    }
    rowElement.scrollIntoView({ block: 'nearest' });
    return true;
  }, []);

  // Setup virtualizer
  const rowVirtualizer = useVirtualizer({
    count: isVirtualWindowing ? rows.length : 0,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => {
      const row = rows[index];
      return row ? getRowHeight(row.node) : 40;
    },
    overscan,
    // Avoid react-virtual calling ReactDOM.flushSync during layout updates.
    useFlushSync: false,
  });

  // ResizeObserver for container sizing
  useResizeObserver(parentRef, () => {
    if (isVirtualWindowing) {
      rowVirtualizer.measure();
    }
  });

  const scrollToNode = React.useCallback(
    (nodeId: string) => {
      const index = indexMap.get(nodeId);
      if (index === undefined) {
        return;
      }

      if (isPagedWindowing) {
        const targetPage = Math.floor(index / Math.max(1, pageSize));
        if (targetPage !== currentPage) {
          pendingPagedScrollNodeIdRef.current = nodeId;
          goToPage(targetPage);
          pagination?.onPageChange?.(targetPage);
          return;
        }

        pendingPagedScrollNodeIdRef.current = null;
        scrollPagedRowIntoView(nodeId);
        return;
      }

      if (!isVirtualWindowing) {
        pendingPagedScrollNodeIdRef.current = null;
        scrollPagedRowIntoView(nodeId);
        return;
      }

      rowVirtualizer.scrollToIndex(index, { align: 'auto', behavior: 'auto' });
    },
    [
      indexMap,
      isVirtualWindowing,
      isPagedWindowing,
      currentPage,
      goToPage,
      pageSize,
      pagination,
      rowVirtualizer,
      scrollPagedRowIntoView,
    ]
  );

  // `displayedRows` is intentionally included so this runs after page-slice DOM updates.
  React.useEffect(() => {
    if (!isPagedWindowing) {
      pendingPagedScrollNodeIdRef.current = null;
      return;
    }

    const pendingNodeId = pendingPagedScrollNodeIdRef.current;
    if (!pendingNodeId) {
      return;
    }

    const pendingIndex = indexMap.get(pendingNodeId);
    if (pendingIndex === undefined) {
      pendingPagedScrollNodeIdRef.current = null;
      return;
    }

    const pendingPage = Math.floor(pendingIndex / Math.max(1, pageSize));
    if (pendingPage !== currentPage) {
      return;
    }

    if (scrollPagedRowIntoView(pendingNodeId)) {
      pendingPagedScrollNodeIdRef.current = null;
    }
  }, [isPagedWindowing, indexMap, pageSize, currentPage, displayedRows, scrollPagedRowIntoView]);

  // Setup keyboard navigation
  const keyboardOptions: UseTreeKeyboardOptions<T> = {
    rows,
    rowIndexById: indexMap,
    nodes,
    getChildren,
    expandedIds,
    onToggleExpand,
    selectionMode,
    isTableFocused: true,
    onScrollToNode: scrollToNode,
  };
  if (selectedId !== undefined) {
    keyboardOptions.selectedId = selectedId;
  }
  if (onSelect !== undefined) {
    keyboardOptions.onSelect = onSelect;
  }
  if (multiSelectedIds !== undefined) {
    keyboardOptions.multiSelectedIds = multiSelectedIds;
  }
  if (onMultiSelectChange !== undefined) {
    keyboardOptions.onMultiSelectChange = onMultiSelectChange;
  }
  const keyboard = useTreeKeyboard(keyboardOptions);

  const {
    handleRowClick,
    handleRowDoubleClick,
    handleRowContextMenu,
    handleSortClick,
    getRowClassName,
    measureRow,
  } = useTreeTableHandlers({
    rows,
    rowIndexById: indexMap,
    nodeById,
    keyboard,
    selectionMode,
    selectedId,
    multiSelectedIds,
    rowClassName,
    sortState,
    onSelect,
    onMultiSelectChange,
    onSortChange,
    onRowDoubleClick,
    onRowContextMenu,
    rowVirtualizer: {
      measureElement: (element) => {
        if (isVirtualWindowing && element) {
          rowVirtualizer.measureElement(element);
        }
      },
    },
  });

  const handlePaginationPageChange = React.useCallback(
    (nextPage: number) => {
      goToPage(nextPage);
      pagination?.onPageChange?.(nextPage);
    },
    [goToPage, pagination]
  );

  const handlePageSizeChange = React.useCallback(
    (nextPageSize: number) => {
      setPageSize(nextPageSize);
      resetToFirstPage();
      pagination?.onPageSizeChange?.(nextPageSize);
    },
    [pagination, resetToFirstPage]
  );

  const virtualItems = isVirtualWindowing ? rowVirtualizer.getVirtualItems() : [];
  const renderedVirtualItems = resolveRenderedVirtualItems(
    isVirtualWindowing,
    virtualItems as Array<{ index: number }>,
    rows.length,
    overscan
  );
  const totalSize = isVirtualWindowing ? rowVirtualizer.getTotalSize() : 0;
  const paddingTop = virtualItems.length > 0 ? (virtualItems[0]?.start ?? 0) : 0;
  const paddingBottom = virtualItems.length > 0 ? totalSize - (virtualItems.at(-1)?.end ?? 0) : 0;
  const shouldShowPagination = isPagedWindowing ? (pagination?.showControls ?? true) : false;
  const tablePaginationProps = React.useMemo(
    () =>
      buildTablePaginationProps({
        currentPage,
        onPageChange: handlePaginationPageChange,
        pageSize,
        totalItems: rows.length,
        totalPages,
        onPageSizeChange: handlePageSizeChange,
        paginationOptions: pagination,
      }),
    [
      currentPage,
      handlePaginationPageChange,
      pageSize,
      rows.length,
      totalPages,
      handlePageSizeChange,
      pagination,
    ]
  );
  const tableHeader = React.useMemo(
    () =>
      renderTableHeader({
        showHeader,
        columns,
        sortState,
        onSortChange,
        onSortClick: handleSortClick,
      }),
    [showHeader, columns, sortState, onSortChange, handleSortClick]
  );

  if (nodes.length === 0) {
    return (
      <div
        className={cn(
          'flex h-32 items-center justify-center text-muted-foreground text-sm',
          className
        )}
      >
        {emptyState ?? 'No data available'}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TreeTableViewport className="overflow-auto" maxHeight={maxHeight} parentRef={parentRef}>
        <Table
          aria-colcount={columns.length}
          aria-label={ariaLabel}
          aria-multiselectable={selectionMode === 'multi' || undefined}
          aria-rowcount={totalRowCount}
          className={className}
          onKeyDown={keyboard.onKeyDown}
          role={tableAriaRole}
          tabIndex={0}
        >
          {tableHeader}

          <TableBody role="rowgroup">
            {isVirtualWindowing && paddingTop > 0 && (
              <tr>
                <td colSpan={columns.length} style={{ height: `${paddingTop}px`, padding: 0 }} />
              </tr>
            )}

            {isVirtualWindowing
              ? renderedVirtualItems.map((virtualRow) => {
                  const row = rows[virtualRow.index];
                  if (!row) {
                    return null;
                  }

                  return (
                    <TreeTableRow
                      ariaRole={tableAriaRole}
                      checkboxState={checkboxStates.get(row.node.id) ?? 'unchecked'}
                      className={getRowClassName(row.node)}
                      columns={columns}
                      isFocused={keyboard.state.focusedId === row.node.id}
                      key={row.node.id}
                      measureRef={measureRow}
                      onCheckboxChange={showCheckbox ? handleCheckboxChange : undefined}
                      onClick={handleRowClick}
                      onContextMenu={handleRowContextMenu}
                      onDoubleClick={handleRowDoubleClick}
                      onToggleExpand={onToggleExpand}
                      row={row}
                      showCheckbox={showCheckbox}
                      totalRowCount={totalRowCount}
                      virtualIndex={virtualRow.index}
                    />
                  );
                })
              : displayedRows.map((row) => (
                  <TreeTableRow
                    ariaRole={tableAriaRole}
                    checkboxState={checkboxStates.get(row.node.id) ?? 'unchecked'}
                    className={getRowClassName(row.node)}
                    columns={columns}
                    isFocused={keyboard.state.focusedId === row.node.id}
                    key={row.node.id}
                    onCheckboxChange={showCheckbox ? handleCheckboxChange : undefined}
                    onClick={handleRowClick}
                    onContextMenu={handleRowContextMenu}
                    onDoubleClick={handleRowDoubleClick}
                    onToggleExpand={onToggleExpand}
                    row={row}
                    showCheckbox={showCheckbox}
                    totalRowCount={totalRowCount}
                    virtualIndex={row.index}
                  />
                ))}

            {isVirtualWindowing && paddingBottom > 0 && (
              <tr>
                <td colSpan={columns.length} style={{ height: `${paddingBottom}px`, padding: 0 }} />
              </tr>
            )}
          </TableBody>
        </Table>
      </TreeTableViewport>

      {shouldShowPagination && <TablePagination {...tablePaginationProps} />}
    </div>
  );
}

export default TreeTable;
