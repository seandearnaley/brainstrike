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
import { cn } from '../lib/utils';
import { Table, TableBody, TableHead, TableHeader, TableRow } from '../table';
import { DEFAULT_ROW_HEIGHTS, TreeTableRow } from './tree-table-row';
import { createChildrenGetter, flattenTreeRecursive } from './tree-utils';
import type { TreeNode, TreeTableProps } from './types';
import { type UseTreeKeyboardOptions, useTreeKeyboard } from './use-tree-keyboard';

/**
 * Default overscan count for virtualization.
 * Higher values provide smoother scrolling at the cost of more DOM elements.
 */
const DEFAULT_OVERSCAN = 10;

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
  multiSelectedIds = new Set<string>(),
  onMultiSelectChange,
  selectionMode = 'single',
  highlightedIds = new Set<string>(),
  rowHeight = DEFAULT_ROW_HEIGHTS,
  overscan = DEFAULT_OVERSCAN,
  maxHeight = '600px',
  sortState,
  onSortChange,
  onLoadChildren: _onLoadChildren,
  loadingNodeIds = new Set<string>(),
  className,
  rowClassName,
  emptyState,
  ariaLabel = 'Tree table',
  onRowDoubleClick,
  onRowContextMenu,
}: TreeTableProps<T>) {
  // These props are passed through but not used directly yet (future expansion)
  void _onExpandAll;
  void _onCollapseAll;
  void _onLoadChildren;
  // Ref for the scroll container
  const parentRef = React.useRef<HTMLDivElement>(null);

  // Track container height for proper virtualization
  const [, setParentHeight] = React.useState(0);

  // Create a children getter for the flat node array
  const getChildren = React.useMemo(() => createChildrenGetter(nodes), [nodes]);

  // Flatten the tree based on expansion state
  const { rows, indexMap } = React.useMemo(() => {
    // Mark loading nodes
    const nodesWithLoading = nodes.map((node) => ({
      ...node,
      isLoading: loadingNodeIds.has(node.id),
    }));

    // Rebuild tree with loading state
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

  // Calculate row height for a given node
  const getRowHeight = React.useCallback(
    (node: TreeNode<T>): number => {
      if (typeof rowHeight === 'function') {
        return rowHeight(node);
      }
      if (typeof rowHeight === 'number') {
        return rowHeight;
      }
      // rowHeight is a Record<string, number>
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
  });

  // ResizeObserver for container sizing
  React.useEffect(() => {
    if (!parentRef.current) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setParentHeight(entry.contentRect.height);
      }
    });

    observer.observe(parentRef.current);
    return () => observer.disconnect();
  }, []);

  // Scroll to a specific node
  const scrollToNode = React.useCallback(
    (nodeId: string) => {
      const index = indexMap.get(nodeId);
      if (index !== undefined) {
        rowVirtualizer.scrollToIndex(index, { align: 'auto', behavior: 'auto' });
      }
    },
    [indexMap, rowVirtualizer]
  );

  // Setup keyboard navigation - build options with explicit typing for exactOptionalPropertyTypes
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
  // Only add optional properties if they have values
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

  // Handle range selection (shift+click)
  const handleRangeSelect = React.useCallback(
    (nodeId: string) => {
      const lastSelected = Array.from(multiSelectedIds).pop();
      if (!lastSelected) return;

      const fromIndex = rows.findIndex((r) => r.node.id === lastSelected);
      const toIndex = rows.findIndex((r) => r.node.id === nodeId);
      if (fromIndex === -1 || toIndex === -1) return;

      const start = Math.min(fromIndex, toIndex);
      const end = Math.max(fromIndex, toIndex);
      const rangeIds = new Set(rows.slice(start, end + 1).map((r) => r.node.id));
      onMultiSelectChange?.(rangeIds);
    },
    [multiSelectedIds, rows, onMultiSelectChange]
  );

  // Handle toggle selection (ctrl/cmd+click)
  const handleToggleSelect = React.useCallback(
    (nodeId: string) => {
      const newSelection = new Set(multiSelectedIds);
      if (newSelection.has(nodeId)) {
        newSelection.delete(nodeId);
      } else {
        newSelection.add(nodeId);
      }
      onMultiSelectChange?.(newSelection);
    },
    [multiSelectedIds, onMultiSelectChange]
  );

  // Handle row click
  const handleRowClick = React.useCallback(
    (nodeId: string, event: React.MouseEvent) => {
      keyboard.actions.setFocus(nodeId);

      if (selectionMode === 'none') return;
      if (selectionMode === 'single') {
        onSelect?.(nodeId);
        return;
      }

      // Multi-select handling
      if (event.shiftKey && multiSelectedIds.size > 0) {
        handleRangeSelect(nodeId);
      } else if (event.ctrlKey || event.metaKey) {
        handleToggleSelect(nodeId);
      } else {
        onMultiSelectChange?.(new Set([nodeId]));
      }
    },
    [
      selectionMode,
      onSelect,
      multiSelectedIds,
      onMultiSelectChange,
      keyboard.actions,
      handleRangeSelect,
      handleToggleSelect,
    ]
  );

  // Handle row double-click
  const handleRowDoubleClick = React.useCallback(
    (nodeId: string) => {
      const node = nodes.find((n) => n.id === nodeId);
      if (node) {
        onRowDoubleClick?.(nodeId, node);
      }
    },
    [nodes, onRowDoubleClick]
  );

  // Handle row context menu
  const handleRowContextMenu = React.useCallback(
    (nodeId: string, event: React.MouseEvent) => {
      const node = nodes.find((n) => n.id === nodeId);
      if (node) {
        onRowContextMenu?.(nodeId, node, event);
      }
    },
    [nodes, onRowContextMenu]
  );

  // Handle sort click
  const handleSortClick = React.useCallback(
    (columnId: string) => {
      if (!onSortChange) return;

      const currentDirection = sortState?.columnId === columnId ? sortState.direction : null;
      let newDirection: 'asc' | 'desc' | null = 'asc';

      if (currentDirection === 'asc') {
        newDirection = 'desc';
      } else if (currentDirection === 'desc') {
        newDirection = null;
      }

      onSortChange(columnId, newDirection);
    },
    [sortState, onSortChange]
  );

  // Get row class name
  const getRowClassName = React.useCallback(
    (node: TreeNode<T>): string => {
      if (typeof rowClassName === 'function') {
        return rowClassName(node);
      }
      return rowClassName ?? '';
    },
    [rowClassName]
  );

  // Measure row callback for dynamic heights
  const measureRow = React.useCallback(
    (element: HTMLTableRowElement | null) => {
      if (element) {
        rowVirtualizer.measureElement(element);
      }
    },
    [rowVirtualizer]
  );

  // Virtual items
  const virtualItems = rowVirtualizer.getVirtualItems();
  const totalSize = rowVirtualizer.getTotalSize();

  // Calculate padding for virtual space
  const paddingTop = virtualItems.length > 0 ? (virtualItems[0]?.start ?? 0) : 0;
  const paddingBottom =
    virtualItems.length > 0 ? totalSize - (virtualItems[virtualItems.length - 1]?.end ?? 0) : 0;

  // Empty state
  if (nodes.length === 0) {
    return (
      <div
        className={cn(
          'flex items-center justify-center h-32 text-sm text-muted-foreground',
          className
        )}
      >
        {emptyState ?? 'No data available'}
      </div>
    );
  }

  return (
    <div
      ref={parentRef}
      className={cn('overflow-auto border rounded-md', className)}
      style={{ maxHeight, height: '100%' }}
      onKeyDown={keyboard.onKeyDown}
      tabIndex={0}
      role="treegrid"
      aria-label={ariaLabel}
    >
      <Table>
        <TableHeader className="sticky top-0 bg-background z-10">
          <TableRow>
            {columns.map((column) => (
              <TableHead
                key={column.id}
                className={cn(
                  column.headerClassName,
                  column.sortable && onSortChange && 'cursor-pointer select-none'
                )}
                style={{
                  width: column.width,
                  minWidth: column.minWidth,
                  maxWidth: column.maxWidth,
                }}
                onClick={() => column.sortable && handleSortClick(column.id)}
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
          {/* Top padding for virtual space */}
          {paddingTop > 0 && (
            <tr>
              <td colSpan={columns.length} style={{ height: `${paddingTop}px`, padding: 0 }} />
            </tr>
          )}

          {/* Virtual rows */}
          {virtualItems.map((virtualRow) => {
            const row = rows[virtualRow.index];
            if (!row) return null;

            return (
              <TreeTableRow
                key={row.node.id}
                row={row}
                columns={columns}
                onToggleExpand={onToggleExpand}
                onClick={handleRowClick}
                onDoubleClick={handleRowDoubleClick}
                onContextMenu={handleRowContextMenu}
                className={getRowClassName(row.node)}
                isFocused={keyboard.state.focusedId === row.node.id}
                measureRef={measureRow}
                virtualIndex={virtualRow.index}
              />
            );
          })}

          {/* Bottom padding for virtual space */}
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
