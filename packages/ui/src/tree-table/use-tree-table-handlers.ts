/**
 * useTreeTableHandlers
 *
 * Extracts row interaction handlers for TreeTable into a dedicated hook
 * to keep the main component focused on layout and virtualization.
 */

import * as React from 'react';
import type { FlattenedRow, SortState, TreeNode, UseTreeKeyboardResult } from './types';

interface UseTreeTableHandlersOptions<T> {
  rows: FlattenedRow<T>[];
  nodes: TreeNode<T>[];
  keyboard: UseTreeKeyboardResult;
  selectionMode: 'single' | 'multi' | 'none';
  selectedId: string | null;
  multiSelectedIds: Set<string>;
  rowClassName?: string | ((node: TreeNode<T>) => string) | undefined;
  sortState?: SortState | undefined;
  onSelect?: ((id: string | null) => void) | undefined;
  onMultiSelectChange?: ((ids: Set<string>) => void) | undefined;
  onSortChange?: ((columnId: string, direction: 'asc' | 'desc' | null) => void) | undefined;
  onRowDoubleClick?: ((nodeId: string, node: TreeNode<T>) => void) | undefined;
  onRowContextMenu?:
    | ((nodeId: string, node: TreeNode<T>, event: React.MouseEvent) => void)
    | undefined;
  rowVirtualizer: { measureElement: (el: HTMLTableRowElement | null) => void };
}

export interface UseTreeTableHandlersResult<T> {
  handleRowClick: (nodeId: string, event: React.MouseEvent) => void;
  handleRowDoubleClick: (nodeId: string) => void;
  handleRowContextMenu: (nodeId: string, event: React.MouseEvent) => void;
  handleSortClick: (columnId: string) => void;
  getRowClassName: (node: TreeNode<T>) => string;
  measureRow: (element: HTMLTableRowElement | null) => void;
}

export function useTreeTableHandlers<T>({
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
}: UseTreeTableHandlersOptions<T>): UseTreeTableHandlersResult<T> {
  const fallbackMultiSelectAnchor = React.useMemo<string | undefined>(() => {
    // Use the first selected row as shift-range anchor when focus/selectedId are absent.
    // This is Set insertion order, not visual row order.
    // This hook expects selection updates to replace the Set instance.
    return multiSelectedIds.values().next().value;
  }, [multiSelectedIds]);

  const handleRangeSelect = React.useCallback(
    (nodeId: string) => {
      const anchor = keyboard.state.focusedId ?? selectedId ?? fallbackMultiSelectAnchor;
      if (anchor === undefined) {
        return;
      }

      const fromIndex = rows.findIndex((r) => r.node.id === anchor);
      const toIndex = rows.findIndex((r) => r.node.id === nodeId);
      if (fromIndex === -1 || toIndex === -1) {
        return;
      }

      const start = Math.min(fromIndex, toIndex);
      const end = Math.max(fromIndex, toIndex);
      const rangeIds = new Set(rows.slice(start, end + 1).map((r) => r.node.id));
      onMultiSelectChange?.(rangeIds);
    },
    [rows, onMultiSelectChange, keyboard.state.focusedId, selectedId, fallbackMultiSelectAnchor]
  );

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

  const handleRowClick = React.useCallback(
    (nodeId: string, event: React.MouseEvent) => {
      keyboard.actions.setFocus(nodeId);

      if (selectionMode === 'none') {
        return;
      }
      if (selectionMode === 'single') {
        onSelect?.(nodeId);
        return;
      }

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

  const handleRowDoubleClick = React.useCallback(
    (nodeId: string) => {
      const node = nodes.find((n) => n.id === nodeId);
      if (node) {
        onRowDoubleClick?.(nodeId, node);
      }
    },
    [nodes, onRowDoubleClick]
  );

  const handleRowContextMenu = React.useCallback(
    (nodeId: string, event: React.MouseEvent) => {
      const node = nodes.find((n) => n.id === nodeId);
      if (node) {
        onRowContextMenu?.(nodeId, node, event);
      }
    },
    [nodes, onRowContextMenu]
  );

  const handleSortClick = React.useCallback(
    (columnId: string) => {
      if (!onSortChange) {
        return;
      }

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

  const getRowClassName = React.useCallback(
    (node: TreeNode<T>): string => {
      if (typeof rowClassName === 'function') {
        return rowClassName(node);
      }
      return rowClassName ?? '';
    },
    [rowClassName]
  );

  const measureRow = React.useCallback(
    (element: HTMLTableRowElement | null) => {
      if (element) {
        rowVirtualizer.measureElement(element);
      }
    },
    [rowVirtualizer]
  );

  return {
    handleRowClick,
    handleRowDoubleClick,
    handleRowContextMenu,
    handleSortClick,
    getRowClassName,
    measureRow,
  };
}
