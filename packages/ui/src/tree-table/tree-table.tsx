/**
 * TreeTable Component
 *
 * A virtualized hierarchical table component supporting:
 * - Tree structure with expand/collapse
 * - Virtual scrolling via @tanstack/react-virtual
 * - Single and multi-selection
 * - Keyboard navigation
 * - Search highlighting
 * - Sorting
 */

import { useVirtualizer } from '@tanstack/react-virtual';
import * as React from 'react';
import { useResizeObserver } from '../hooks/use-resize-observer';
import { cn } from '../lib/utils';
import { Table, TableBody, TableHead, TableHeader, TableRow } from '../table';
import { DEFAULT_ROW_HEIGHTS, TreeTableRow } from './tree-table-row';
import { createChildrenGetter, flattenTreeRecursive } from './tree-utils';
import type { TreeNode, TreeTableProps } from './types';
import { type UseTreeKeyboardOptions, useTreeKeyboard } from './use-tree-keyboard';
import { useTreeTableHandlers } from './use-tree-table-handlers';

/**
 * Default overscan count for virtualization.
 * Higher values provide smoother scrolling at the cost of more DOM elements.
 */
const DEFAULT_OVERSCAN = 10;

const DEFAULT_MULTI_SELECTED = new Set<string>();
const DEFAULT_HIGHLIGHTED = new Set<string>();
const DEFAULT_LOADING_NODE_IDS = new Set<string>();

/**
 * TreeTable - A virtualized hierarchical table component.
 *
 * Features:
 * - Virtual scrolling for large datasets (10k+ rows)
 * - Tree structure with expand/collapse
 * - Single and multi-selection modes
 * - Full keyboard navigation (arrow keys, Enter, Space, etc.)
 * - Search result highlighting
 * - Column sorting
 * - Lazy loading support for children
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
 * />
 * ```
 */
export function TreeTable<T>({
  nodes,
  columns,
  expandedIds,
  onToggleExpand,
  onExpandAll: _onExpandAll,
  onCollapseAll: _onCollapseAll,
  selectedId = null,
  onSelect,
  multiSelectedIds = DEFAULT_MULTI_SELECTED,
  onMultiSelectChange,
  selectionMode = 'single',
  highlightedIds = DEFAULT_HIGHLIGHTED,
  rowHeight = DEFAULT_ROW_HEIGHTS,
  overscan = DEFAULT_OVERSCAN,
  maxHeight = '600px',
  sortState,
  onSortChange,
  onLoadChildren: _onLoadChildren,
  loadingNodeIds = DEFAULT_LOADING_NODE_IDS,
  className,
  rowClassName,
  emptyState,
  ariaLabel = 'Tree table',
  onRowDoubleClick,
  onRowContextMenu,
}: TreeTableProps<T>) {
  'use no memo';
  // These props are passed through but not used directly yet (future expansion)
  void _onExpandAll;
  void _onCollapseAll;
  void _onLoadChildren;

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
      },
      getChildrenWithLoading
    );
  }, [nodes, expandedIds, selectedId, multiSelectedIds, highlightedIds, loadingNodeIds]);

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
      aria-label={ariaLabel}
      className={cn('overflow-auto', className)}
      onKeyDown={keyboard.onKeyDown}
      ref={parentRef}
      role="treegrid"
      style={{ maxHeight, height: '100%' }}
      tabIndex={0}
    >
      <Table>
        <TableHeader className="sticky top-0 z-10 bg-background">
          <TableRow>
            {columns.map((column) => (
              <TableHead
                className={cn(
                  column.headerClassName,
                  column.sortable && onSortChange && 'cursor-pointer select-none'
                )}
                key={column.id}
                onClick={() => column.sortable && handleSortClick(column.id)}
                style={{
                  width: column.width,
                  minWidth: column.minWidth,
                  maxWidth: column.maxWidth,
                }}
              >
                <div className="flex items-center gap-1">
                  {column.header ?? column.id}
                  {column.sortable && sortState?.columnId === column.id && (
                    <span className="text-xs">
                      {sortState.direction === 'asc'
                        ? '↑'
                        : sortState.direction === 'desc'
                          ? '↓'
                          : ''}
                    </span>
                  )}
                </div>
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>

        <TableBody>
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
                className={getRowClassName(row.node)}
                columns={columns}
                isFocused={keyboard.state.focusedId === row.node.id}
                key={row.node.id}
                measureRef={measureRow}
                onClick={handleRowClick}
                onContextMenu={handleRowContextMenu}
                onDoubleClick={handleRowDoubleClick}
                onToggleExpand={onToggleExpand}
                row={row}
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
