/**
 * useTreeKeyboard Hook
 *
 * Provides keyboard navigation for the TreeTable component.
 * Supports arrow key navigation, expand/collapse, selection, and multi-select.
 */

import * as React from 'react';
import {
  getFirstChildNodeId,
  getNextVisibleNodeId,
  getParentNodeId,
  getRangeSelection,
} from './tree-utils';
import type {
  FlattenedRow,
  KeyboardNavigationActions,
  KeyboardNavigationState,
  SelectionMode,
  TreeNode,
  UseTreeKeyboardResult,
} from './types';

/**
 * Options for the useTreeKeyboard hook.
 */
export interface UseTreeKeyboardOptions<T> {
  /** Flattened rows for navigation */
  rows: FlattenedRow<T>[];
  /** All tree nodes (for parent/child lookup) */
  nodes: TreeNode<T>[];
  /** Function to get children of a node */
  getChildren: (node: TreeNode<T>) => TreeNode<T>[];
  /** Set of expanded node IDs */
  expandedIds: Set<string>;
  /** Callback to toggle expansion */
  onToggleExpand: (nodeId: string) => void;
  /** Selection mode */
  selectionMode: SelectionMode;
  /** Currently selected node ID (single select) */
  selectedId?: string | null;
  /** Callback when selection changes (single select) */
  onSelect?: (nodeId: string | null) => void;
  /** Currently selected node IDs (multi-select) */
  multiSelectedIds?: Set<string>;
  /** Callback when multi-selection changes */
  onMultiSelectChange?: (ids: Set<string>) => void;
  /** Whether the tree table is focused */
  isTableFocused?: boolean;
  /** Callback when a node should be scrolled into view */
  onScrollToNode?: (nodeId: string) => void;
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
    nodes,
    getChildren,
    expandedIds: _expandedIds,
    onToggleExpand,
    selectionMode,
    selectedId: _selectedId = null,
    onSelect,
    multiSelectedIds = new Set<string>(),
    onMultiSelectChange,
    isTableFocused = true,
    onScrollToNode,
  } = options;

  // These are used by the tree navigation but not directly in this hook
  void _expandedIds;
  void _selectedId;

  // Track focused node (separate from selection)
  const [focusedId, setFocusedId] = React.useState<string | null>(null);
  const [isActive, setIsActive] = React.useState(false);

  // Track the anchor point for range selection
  const rangeAnchorRef = React.useRef<string | null>(null);

  // Sync focused state with table focus
  React.useEffect(() => {
    if (!isTableFocused) {
      setIsActive(false);
    }
  }, [isTableFocused]);

  // Initialize focus to first row when activating
  React.useEffect(() => {
    if (isActive && focusedId === null && rows.length > 0) {
      const firstRow = rows[0];
      if (firstRow) {
        setFocusedId(firstRow.node.id);
      }
    }
  }, [isActive, focusedId, rows]);

  // Reset focusedId when the focused node disappears from rows (filtered/deleted)
  React.useEffect(() => {
    if (focusedId !== null && rows.length > 0) {
      const stillExists = rows.some((r) => r.node.id === focusedId);
      if (!stillExists) {
        setFocusedId(null);
      }
    }
  }, [focusedId, rows]);

  // Navigation actions
  const moveUp = React.useCallback(() => {
    const nextId = getNextVisibleNodeId(rows, focusedId, 'up');
    if (nextId) {
      setFocusedId(nextId);
      onScrollToNode?.(nextId);
    }
  }, [rows, focusedId, onScrollToNode]);

  const moveDown = React.useCallback(() => {
    const nextId = getNextVisibleNodeId(rows, focusedId, 'down');
    if (nextId) {
      setFocusedId(nextId);
      onScrollToNode?.(nextId);
    }
  }, [rows, focusedId, onScrollToNode]);

  const expandOrMoveRight = React.useCallback(() => {
    if (!focusedId) {
      return;
    }

    const row = rows.find((r) => r.node.id === focusedId);
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
  }, [focusedId, rows, onToggleExpand, getChildren, onScrollToNode]);

  const collapseOrMoveLeft = React.useCallback(() => {
    if (!focusedId) {
      return;
    }

    const row = rows.find((r) => r.node.id === focusedId);
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
  }, [focusedId, rows, nodes, onToggleExpand, getChildren, onScrollToNode]);

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

      const nextId = getNextVisibleNodeId(rows, focusedId, direction);
      if (!nextId) {
        return;
      }

      // If no anchor, set current as anchor
      if (!rangeAnchorRef.current) {
        rangeAnchorRef.current = focusedId;
      }

      // Calculate range selection
      const rangeIds = getRangeSelection(rows, rangeAnchorRef.current, nextId);
      onMultiSelectChange?.(rangeIds);

      // Move focus
      setFocusedId(nextId);
      onScrollToNode?.(nextId);
    },
    [selectionMode, focusedId, rows, onMultiSelectChange, onScrollToNode]
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
    if (selectionMode === 'multi') {
      toggleFocused();
    } else {
      selectFocused();
    }
  }, [selectionMode, toggleFocused, selectFocused]);

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

      // Key handlers map using KeyboardEvent.key values (PascalCase matches the spec)
      const handlers = new Map<string, () => void>([
        ['ArrowUp', () => handleArrowKey('up', shiftKey)],
        ['ArrowDown', () => handleArrowKey('down', shiftKey)],
        ['ArrowLeft', collapseOrMoveLeft],
        ['ArrowRight', expandOrMoveRight],
        ['Enter', selectFocused],
        [' ', handleSpaceKey],
        ['Home', jumpToFirst],
        ['End', jumpToLast],
        ['Escape', clearSelection],
      ]);

      // Handle 'a'/'A' for select all with modifier
      if ((key === 'a' || key === 'A') && modKey) {
        event.preventDefault();
        selectAll();
        return;
      }

      const handler = handlers.get(key);
      if (handler) {
        event.preventDefault();
        handler();
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
    moveUp,
    moveDown,
    expandOrMoveRight,
    collapseOrMoveLeft,
    selectFocused,
    toggleFocused,
    setFocus,
    reset,
  };

  return {
    state,
    actions,
    onKeyDown,
  };
}

export default useTreeKeyboard;
