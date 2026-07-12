/**
 * useTreeTableHandlers
 *
 * Extracts row interaction handlers for TreeTable into a dedicated hook
 * to keep the main component focused on layout and virtualization.
 */

import { useEventCallback } from '@brainstrike/hooks';
import * as React from 'react';
import type { FlattenedRow, SortState, TreeNode, UseTreeKeyboardResult } from './types';

interface UseTreeTableHandlersOptions<T> {
  keyboard: UseTreeKeyboardResult;
  multiSelectedIds: Set<string>;
  nodeById: Map<string, TreeNode<T>>;
  onMultiSelectChange?: ((ids: Set<string>) => void) | undefined;
  onRowContextMenu?:
    | ((nodeId: string, node: TreeNode<T>, event: React.MouseEvent) => void)
    | undefined;
  onRowDoubleClick?: ((nodeId: string, node: TreeNode<T>) => void) | undefined;
  onSelect?: ((id: string | null) => void) | undefined;
  onSortChange?: ((columnId: string, direction: 'asc' | 'desc' | null) => void) | undefined;
  rowClassName?: string | ((node: TreeNode<T>) => string) | undefined;
  rowIndexById: Map<string, number>;
  rows: FlattenedRow<T>[];
  rowVirtualizer: { measureElement: (el: HTMLTableRowElement | null) => void };
  selectedId: string | null;
  selectionMode: 'single' | 'multi' | 'none';
  sortState?: SortState | undefined;
}

export interface UseTreeTableHandlersResult<T> {
  getRowClassName: (node: TreeNode<T>) => string;
  handleRowClick: (nodeId: string, event: React.MouseEvent) => void;
  handleRowContextMenu: (nodeId: string, event: React.MouseEvent) => void;
  handleRowDoubleClick: (nodeId: string) => void;
  handleSortClick: (columnId: string) => void;
  measureRow: (element: HTMLTableRowElement | null) => void;
}

export function useTreeTableHandlers<T>({
  rows,
  rowIndexById,
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
  rowVirtualizer,
}: UseTreeTableHandlersOptions<T>): UseTreeTableHandlersResult<T> {
  const fallbackMultiSelectAnchor = React.useMemo<string | undefined>(() => {
    // Use the selected row with the smallest rendered index as the shift-range
    // anchor when focus/selectedId are absent. This avoids scanning all rows.
    let anchorId: string | undefined;
    let bestIndex = Number.POSITIVE_INFINITY;

    for (const candidateId of multiSelectedIds) {
      const index = rowIndexById.get(candidateId);
      if (index === undefined || index >= bestIndex) {
        continue;
      }
      bestIndex = index;
      anchorId = candidateId;
    }

    return anchorId;
  }, [multiSelectedIds, rowIndexById]);

  const handleRangeSelect = React.useCallback(
    (nodeId: string) => {
      const anchor = keyboard.state.focusedId ?? selectedId ?? fallbackMultiSelectAnchor;
      if (anchor === null || anchor === undefined) {
        return;
      }

      const fromIndex = rowIndexById.get(anchor);
      const toIndex = rowIndexById.get(nodeId);
      if (fromIndex === undefined || toIndex === undefined) {
        return;
      }

      const start = Math.min(fromIndex, toIndex);
      const end = Math.max(fromIndex, toIndex);
      const rangeIds = new Set<string>();
      for (let index = start; index <= end; index += 1) {
        const row = rows[index];
        if (row) {
          rangeIds.add(row.node.id);
        }
      }
      onMultiSelectChange?.(rangeIds);
    },
    [
      rows,
      rowIndexById,
      onMultiSelectChange,
      keyboard.state.focusedId,
      selectedId,
      fallbackMultiSelectAnchor,
    ]
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

  // Row-facing handlers are identity-stable (useEventCallback) so the
  // React.memo on TreeTableRow actually bails out: with plain useCallback,
  // selection/focus changes minted fresh handlers and re-rendered every
  // visible row (see tree-table-render-stability.test.tsx).
  const handleRowClick = useEventCallback((nodeId: string, event: React.MouseEvent) => {
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
  });

  const handleRowDoubleClick = useEventCallback((nodeId: string) => {
    const node = nodeById.get(nodeId);
    if (node) {
      onRowDoubleClick?.(nodeId, node);
    }
  });

  const handleRowContextMenu = useEventCallback((nodeId: string, event: React.MouseEvent) => {
    const node = nodeById.get(nodeId);
    if (node) {
      onRowContextMenu?.(nodeId, node, event);
    }
  });

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
    getRowClassName,
    handleRowClick,
    handleRowContextMenu,
    handleRowDoubleClick,
    handleSortClick,
    measureRow,
  };
}
