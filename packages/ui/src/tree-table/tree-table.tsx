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

import { useVirtualizer } from '@tanstack/react-virtual';
import * as React from 'react';
import { useResizeObserver } from '../hooks/use-resize-observer';
import { cn } from '../lib/utils';
import { Table, TableBody, TableHead, TableHeader, TableRow } from '../table';
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

interface CheckboxStateContext<T> {
  getChildren: (node: TreeNode<T>) => TreeNode<T>[];
  multiSelectedIds: Set<string>;
  states: Map<string, CheckboxState>;
  visiting: Set<string>;
}

const warnedCycleNodeIds = new Set<string>();

function shouldWarnForCycles(): boolean {
  if (typeof process !== 'undefined') {
    return process.env['NODE_ENV'] !== 'production';
  }
  return true;
}

function getCycleFallbackState(nodeId: string, selectedIds: Set<string>): CheckboxState {
  if (shouldWarnForCycles() && !warnedCycleNodeIds.has(nodeId)) {
    warnedCycleNodeIds.add(nodeId);
    // biome-ignore lint/suspicious/noConsole: Cycles indicate malformed tree data and should be surfaced during development.
    console.warn(`[TreeTable] Cycle detected while computing checkbox state for node "${nodeId}".`);
  }
  // Cycles indicate malformed tree data; prefer a conservative visual state
  // that avoids incorrectly showing a fully checked parent.
  return selectedIds.has(nodeId) ? 'indeterminate' : 'unchecked';
}

function aggregateChildStates<T>(
  children: TreeNode<T>[],
  context: CheckboxStateContext<T>
): CheckboxState {
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
    const fallbackState = getCycleFallbackState(node.id, context.multiSelectedIds);
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
  multiSelectedIds: Set<string>
): Map<string, CheckboxState> {
  const context: CheckboxStateContext<T> = {
    getChildren,
    multiSelectedIds,
    states: new Map<string, CheckboxState>(),
    visiting: new Set<string>(),
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
  maxHeight = '600px',
  sortState,
  onSortChange,
  loadingNodeIds = DEFAULT_LOADING_NODE_IDS,
  className,
  rowClassName,
  emptyState,
  ariaLabel = 'Tree table',
  showCheckbox = false,
  onRowDoubleClick,
  onRowContextMenu,
}: TreeTableProps<T>) {
  const parentRef = React.useRef<HTMLDivElement>(null);

  const getChildren = React.useMemo(() => createChildrenGetter(nodes), [nodes]);

  const { rows, indexMap } = React.useMemo(() => {
    const nodesWithLoading = nodes.map((node) => ({
      ...node,
      isLoading: loadingNodeIds.has(node.id),
    }));

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
  ]);

  // Total row count for ARIA (includes header row)
  const totalRowCount = rows.length + 1;

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
    return buildCheckboxStateMap(nodes, getChildren, multiSelectedIds);
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

  // Setup virtualizer
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
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
    rowVirtualizer.measure();
  });

  const scrollToNode = React.useCallback(
    (nodeId: string) => {
      const index = indexMap.get(nodeId);
      if (index !== undefined) {
        rowVirtualizer.scrollToIndex(index, { align: 'auto', behavior: 'auto' });
      }
    },
    [indexMap, rowVirtualizer]
  );

  // Setup keyboard navigation
  const keyboardOptions: UseTreeKeyboardOptions<T> = {
    rows,
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
    nodes,
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
    rowVirtualizer,
  });

  const virtualItems = rowVirtualizer.getVirtualItems();
  const totalSize = rowVirtualizer.getTotalSize();
  const paddingTop = virtualItems.length > 0 ? (virtualItems[0]?.start ?? 0) : 0;
  const paddingBottom = virtualItems.length > 0 ? totalSize - (virtualItems.at(-1)?.end ?? 0) : 0;

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
    <div
      aria-colcount={columns.length}
      aria-label={ariaLabel}
      aria-multiselectable={selectionMode === 'multi' || undefined}
      aria-rowcount={totalRowCount}
      className={cn('overflow-auto', className)}
      onKeyDown={keyboard.onKeyDown}
      ref={parentRef}
      role="treegrid"
      style={{ maxHeight, height: '100%' }}
      tabIndex={0}
    >
      <Table>
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
                  onClick={() => column.sortable && handleSortClick(column.id)}
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

        <TableBody role="rowgroup">
          {paddingTop > 0 && (
            <tr>
              <td colSpan={columns.length} style={{ height: `${paddingTop}px`, padding: 0 }} />
            </tr>
          )}

          {virtualItems.map((virtualRow) => {
            const row = rows[virtualRow.index];
            if (!row) {
              return null;
            }

            return (
              <TreeTableRow
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
          })}

          {paddingBottom > 0 && (
            <tr>
              <td colSpan={columns.length} style={{ height: `${paddingBottom}px`, padding: 0 }} />
            </tr>
          )}
        </TableBody>
      </Table>
    </div>
  );
}

export default TreeTable;
