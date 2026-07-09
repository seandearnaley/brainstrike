/**
 * useTreeKeyboard Hook
 *
 * Provides keyboard navigation for the TreeTable component.
 * Supports arrow key navigation, expand/collapse, selection, and multi-select.
 */

import * as React from 'react';
import { getFirstChildNodeId, getParentNodeId } from './tree-utils';
import type {
  FlattenedRow,
  KeyboardNavigationActions,
  KeyboardNavigationState,
  SelectionMode,
  TreeNode,
  UseTreeKeyboardResult,
} from './types';

const EMPTY_MULTI_SELECTED_IDS = new Set<string>();

/**
 * Options for the useTreeKeyboard hook.
 */
export interface UseTreeKeyboardOptions<T> {
  /** Set of expanded node IDs */
  expandedIds: Set<string>;
  /** Function to get children of a node */
  getChildren: (node: TreeNode<T>) => TreeNode<T>[];
  /** Whether the tree table is focused */
  isTableFocused?: boolean;
  /** Currently selected node IDs (multi-select) */
  multiSelectedIds?: Set<string>;
  /** All tree nodes (for parent/child lookup) */
  nodes: TreeNode<T>[];
  /**
   * Optional Space handler for pluggable checkboxes.
   * Return true when the key was handled so the default multi-select
   * Space toggle is skipped.
   */
  onCheckboxSpace?: (nodeId: string) => boolean;
  /** Callback when multi-selection changes */
  onMultiSelectChange?: (ids: Set<string>) => void;
  /** Callback when a node should be scrolled into view */
  onScrollToNode?: (nodeId: string) => void;
  /** Callback when selection changes (single select) */
  onSelect?: (nodeId: string | null) => void;
  /** Callback to toggle expansion */
  onToggleExpand: (nodeId: string) => void;
  /** Row index lookup keyed by node id */
  rowIndexById: Map<string, number>;
  /** Flattened rows for navigation */
  rows: FlattenedRow<T>[];
  /** Currently selected node ID (single select) */
  selectedId?: string | null;
  /** Selection mode */
  selectionMode: SelectionMode;
}

/**
 * useTreeKeyboard provides full keyboard navigation for TreeTable.
 *
 * Supported keys:
 * - ArrowUp/ArrowDown: Navigate between visible rows
 * - ArrowLeft: Collapse current node or move to parent
 * - ArrowRight: Expand current node or move to first child
 * - Enter/Space: Select current node
 * - Shift+ArrowUp/Down: Extend multi-selection
 * - Ctrl/Cmd+A: Select all visible
 * - Home: Jump to first row
 * - End: Jump to last row
 * - Escape: Clear selection
 */
export function useTreeKeyboard<T>(options: UseTreeKeyboardOptions<T>): UseTreeKeyboardResult {
  const {
    rows,
    rowIndexById,
    nodes,
    getChildren,
    onToggleExpand,
    selectionMode,
    onSelect,
    multiSelectedIds = EMPTY_MULTI_SELECTED_IDS,
    onMultiSelectChange,
    onCheckboxSpace,
    isTableFocused = true,
    onScrollToNode,
  } = options;
  // `rows` and `rowIndexById` are derived from the same memoized flatten pass in TreeTable,
  // so index lookups stay in sync for a given render snapshot.

  // Track focused node (separate from selection)
  const [focusedId, setFocusedId] = React.useState<string | null>(null);
  const [isActive, setIsActive] = React.useState(false);
  const focusedIdRef = React.useRef<string | null>(null);

  // Track the anchor point for range selection
  const rangeAnchorRef = React.useRef<string | null>(null);
  const suppressAutoFocusRef = React.useRef(false);

  React.useEffect(() => {
    focusedIdRef.current = focusedId;
  }, [focusedId]);

  const getRowById = React.useCallback(
    (nodeId: string): FlattenedRow<T> | null => {
      const index = rowIndexById.get(nodeId);
      if (index === undefined) {
        return null;
      }
      return rows[index] ?? null;
    },
    [rowIndexById, rows]
  );

  const selectRangeByIndexes = React.useCallback(
    (fromId: string, toId: string): Set<string> => {
      const fromIndex = rowIndexById.get(fromId);
      const toIndex = rowIndexById.get(toId);
      if (fromIndex === undefined || toIndex === undefined) {
        return new Set<string>();
      }

      const start = Math.min(fromIndex, toIndex);
      const end = Math.max(fromIndex, toIndex);
      const ids = new Set<string>();
      for (let index = start; index <= end; index += 1) {
        const row = rows[index];
        if (row) {
          ids.add(row.node.id);
        }
      }
      return ids;
    },
    [rowIndexById, rows]
  );

  const getNextNodeId = React.useCallback(
    (direction: 'up' | 'down', currentId: string | null): string | null => {
      if (rows.length === 0) {
        return null;
      }

      if (currentId === null) {
        const firstRow = rows[0];
        const lastRow = rows.at(-1);
        return direction === 'down' ? (firstRow?.node.id ?? null) : (lastRow?.node.id ?? null);
      }

      const currentIndex = rowIndexById.get(currentId);
      if (currentIndex === undefined) {
        const firstRow = rows[0];
        return firstRow?.node.id ?? null;
      }

      const nextIndex = direction === 'down' ? currentIndex + 1 : currentIndex - 1;
      if (nextIndex < 0 || nextIndex >= rows.length) {
        return null;
      }

      const nextRow = rows[nextIndex];
      return nextRow?.node.id ?? null;
    },
    [rowIndexById, rows]
  );

  // Sync focused state with table focus
  React.useEffect(() => {
    if (!isTableFocused) {
      setIsActive(false);
      suppressAutoFocusRef.current = false;
    }
  }, [isTableFocused]);

  // Keep focus in sync with row changes while avoiding refocus races after filtering.
  React.useEffect(() => {
    if (!isActive) {
      return;
    }

    const currentFocusedId = focusedIdRef.current;

    if (rows.length === 0) {
      if (currentFocusedId !== null) {
        focusedIdRef.current = null;
        setFocusedId(null);
      }
      suppressAutoFocusRef.current = false;
      return;
    }

    if (currentFocusedId !== null) {
      const stillExists = rowIndexById.has(currentFocusedId);
      if (!stillExists) {
        suppressAutoFocusRef.current = true;
        focusedIdRef.current = null;
        setFocusedId(null);
      }
      return;
    }

    if (suppressAutoFocusRef.current) {
      suppressAutoFocusRef.current = false;
      return;
    }

    const firstRow = rows[0];
    if (firstRow) {
      focusedIdRef.current = firstRow.node.id;
      setFocusedId(firstRow.node.id);
    }
  }, [isActive, rows, rowIndexById]);

  // Navigation actions
  const moveUp = React.useCallback(() => {
    const nextId = getNextNodeId('up', focusedId);
    if (nextId) {
      setFocusedId(nextId);
      onScrollToNode?.(nextId);
    }
  }, [getNextNodeId, focusedId, onScrollToNode]);

  const moveDown = React.useCallback(() => {
    const nextId = getNextNodeId('down', focusedId);
    if (nextId) {
      setFocusedId(nextId);
      onScrollToNode?.(nextId);
    }
  }, [getNextNodeId, focusedId, onScrollToNode]);

  const expandOrMoveRight = React.useCallback(() => {
    if (!focusedId) {
      return;
    }

    const row = getRowById(focusedId);
    if (!row) {
      return;
    }

    const { node, isExpanded } = row;

    if (node.hasChildren) {
      if (isExpanded) {
        // Already expanded, move to first child
        const firstChildId = getFirstChildNodeId(node, getChildren);
        if (firstChildId) {
          setFocusedId(firstChildId);
          onScrollToNode?.(firstChildId);
        }
      } else {
        // Expand the node
        onToggleExpand(node.id);
      }
    }
  }, [focusedId, getRowById, onToggleExpand, getChildren, onScrollToNode]);

  const collapseOrMoveLeft = React.useCallback(() => {
    if (!focusedId) {
      return;
    }

    const row = getRowById(focusedId);
    if (!row) {
      return;
    }

    const { node, isExpanded } = row;

    if (node.hasChildren && isExpanded) {
      // Collapse the node
      onToggleExpand(node.id);
    } else {
      // Move to parent
      const parentId = getParentNodeId(nodes, node.id, getChildren);
      if (parentId) {
        setFocusedId(parentId);
        onScrollToNode?.(parentId);
      }
    }
  }, [focusedId, getRowById, nodes, onToggleExpand, getChildren, onScrollToNode]);

  const selectFocused = React.useCallback(() => {
    if (!focusedId || selectionMode === 'none') {
      return;
    }

    if (selectionMode === 'single') {
      onSelect?.(focusedId);
    } else if (selectionMode === 'multi') {
      // In multi-select, single select replaces selection
      onMultiSelectChange?.(new Set([focusedId]));
      rangeAnchorRef.current = focusedId;
    }
  }, [focusedId, selectionMode, onSelect, onMultiSelectChange]);

  const toggleFocused = React.useCallback(() => {
    if (!focusedId || selectionMode !== 'multi') {
      return;
    }

    const newSelection = new Set(multiSelectedIds);
    if (newSelection.has(focusedId)) {
      newSelection.delete(focusedId);
    } else {
      newSelection.add(focusedId);
    }
    onMultiSelectChange?.(newSelection);
    rangeAnchorRef.current = focusedId;
  }, [focusedId, selectionMode, multiSelectedIds, onMultiSelectChange]);

  const setFocus = React.useCallback((nodeId: string | null) => {
    setFocusedId(nodeId);
    if (nodeId) {
      setIsActive(true);
    }
  }, []);

  const reset = React.useCallback(() => {
    setFocusedId(null);
    setIsActive(false);
    rangeAnchorRef.current = null;
  }, []);

  // Extend selection (for Shift+Arrow)
  const extendSelection = React.useCallback(
    (direction: 'up' | 'down') => {
      if (selectionMode !== 'multi' || !focusedId) {
        return;
      }

      const nextId = getNextNodeId(direction, focusedId);
      if (!nextId) {
        return;
      }

      // If no anchor, set current as anchor
      if (!rangeAnchorRef.current) {
        rangeAnchorRef.current = focusedId;
      }

      // Calculate range selection
      const rangeIds = selectRangeByIndexes(rangeAnchorRef.current, nextId);
      onMultiSelectChange?.(rangeIds);

      // Move focus
      setFocusedId(nextId);
      onScrollToNode?.(nextId);
    },
    [
      selectionMode,
      focusedId,
      getNextNodeId,
      selectRangeByIndexes,
      onMultiSelectChange,
      onScrollToNode,
    ]
  );

  // Select all visible
  const selectAll = React.useCallback(() => {
    if (selectionMode !== 'multi') {
      return;
    }

    const allIds = new Set(rows.map((r) => r.node.id));
    onMultiSelectChange?.(allIds);
  }, [selectionMode, rows, onMultiSelectChange]);

  // Clear selection
  const clearSelection = React.useCallback(() => {
    if (selectionMode === 'single') {
      onSelect?.(null);
    } else if (selectionMode === 'multi') {
      onMultiSelectChange?.(new Set());
    }
    rangeAnchorRef.current = null;
  }, [selectionMode, onSelect, onMultiSelectChange]);

  // Jump to first/last
  const jumpToFirst = React.useCallback(() => {
    if (rows.length > 0) {
      const firstRow = rows[0];
      if (firstRow) {
        const firstId = firstRow.node.id;
        setFocusedId(firstId);
        onScrollToNode?.(firstId);
      }
    }
  }, [rows, onScrollToNode]);

  const jumpToLast = React.useCallback(() => {
    if (rows.length > 0) {
      const lastRow = rows.at(-1);
      if (lastRow) {
        const lastId = lastRow.node.id;
        setFocusedId(lastId);
        onScrollToNode?.(lastId);
      }
    }
  }, [rows, onScrollToNode]);

  // Handle arrow key with optional shift for selection extension
  const handleArrowKey = React.useCallback(
    (direction: 'up' | 'down', shiftKey: boolean) => {
      if (shiftKey && selectionMode === 'multi') {
        extendSelection(direction);
      } else if (direction === 'up') {
        moveUp();
      } else {
        moveDown();
      }
    },
    [selectionMode, extendSelection, moveUp, moveDown]
  );

  // Handle space key action
  const handleSpaceKey = React.useCallback(() => {
    if (focusedId && onCheckboxSpace?.(focusedId)) {
      return;
    }
    if (selectionMode === 'multi') {
      toggleFocused();
    } else {
      selectFocused();
    }
  }, [focusedId, onCheckboxSpace, selectionMode, toggleFocused, selectFocused]);

  // Activate navigation on first arrow key press
  const activateNavigation = React.useCallback(() => {
    setIsActive(true);
    if (!focusedId && rows.length > 0) {
      const firstRow = rows[0];
      if (firstRow) {
        setFocusedId(firstRow.node.id);
      }
    }
  }, [focusedId, rows]);

  // Keyboard event handler
  const onKeyDown = React.useCallback(
    (event: React.KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
        return;
      }

      const { key, shiftKey, ctrlKey, metaKey } = event;
      const modKey = ctrlKey || metaKey;
      const arrowKeys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];

      if (!isActive && arrowKeys.includes(key)) {
        activateNavigation();
        event.preventDefault();
        return;
      }

      // Handle 'a'/'A' for select all with modifier
      if ((key === 'a' || key === 'A') && modKey) {
        event.preventDefault();
        selectAll();
        return;
      }

      switch (key) {
        case 'ArrowUp':
          event.preventDefault();
          handleArrowKey('up', shiftKey);
          return;
        case 'ArrowDown':
          event.preventDefault();
          handleArrowKey('down', shiftKey);
          return;
        case 'ArrowLeft':
          event.preventDefault();
          collapseOrMoveLeft();
          return;
        case 'ArrowRight':
          event.preventDefault();
          expandOrMoveRight();
          return;
        case 'Enter':
          event.preventDefault();
          selectFocused();
          return;
        case ' ':
          event.preventDefault();
          handleSpaceKey();
          return;
        case 'Home':
          event.preventDefault();
          jumpToFirst();
          return;
        case 'End':
          event.preventDefault();
          jumpToLast();
          return;
        case 'Escape':
          event.preventDefault();
          clearSelection();
          return;
        default:
          return;
      }
    },
    [
      isActive,
      activateNavigation,
      handleArrowKey,
      collapseOrMoveLeft,
      expandOrMoveRight,
      selectFocused,
      handleSpaceKey,
      jumpToFirst,
      jumpToLast,
      clearSelection,
      selectAll,
    ]
  );

  // State
  const state: KeyboardNavigationState = {
    focusedId,
    isActive,
  };

  // Actions
  const actions: KeyboardNavigationActions = {
    collapseOrMoveLeft,
    expandOrMoveRight,
    moveDown,
    moveUp,
    reset,
    selectFocused,
    setFocus,
    toggleFocused,
  };

  return {
    actions,
    onKeyDown,
    state,
  };
}

export default useTreeKeyboard;
