/**
 * TreeTable Types
 *
 * Type definitions for the virtualized hierarchical TreeTable component.
 * Supports generic data types, multi-level expansion, selection, and highlighting.
 */

import type * as React from 'react';

/**
 * Represents a node in the tree structure.
 * Generic type T allows custom data payloads for different use cases.
 */
export interface TreeNode<T = unknown> {
  /** Unique identifier for this node */
  id: string;
  /** Type discriminator for different node kinds (e.g., 'file', 'chunk', 'vector') */
  type: string;
  /** Depth level in the tree (0 = root) */
  depth: number;
  /** Custom data payload for this node */
  data: T;
  /** Parent node ID, or null for root nodes */
  parentId: string | null;
  /** Whether this node has children that can be expanded */
  hasChildren: boolean;
  /** Number of direct children (optional, for display purposes) */
  childCount?: number;
  /** Whether children are currently being loaded */
  isLoading?: boolean;
}

/**
 * ARIA attributes for a tree row, computed from tree structure.
 * Follows WAI-ARIA treegrid pattern.
 */
export interface TreeRowAriaAttributes {
  /** Depth in hierarchy (1-based, per ARIA spec) */
  ariaLevel: number;
  /** Number of siblings at the same level under the same parent */
  ariaSetSize: number;
  /** Position among siblings (1-based) */
  ariaPosInSet: number;
  /** 1-based row index within the full grid (for virtualized grids) */
  ariaRowIndex: number;
}

/**
 * A flattened representation of a tree node for rendering.
 * Includes visual state information (expanded, selected, highlighted).
 */
export interface FlattenedRow<T = unknown> {
  /** The tree node data */
  node: TreeNode<T>;
  /** Index in the flattened array */
  index: number;
  /** Whether this node is currently expanded */
  isExpanded: boolean;
  /** Whether this node is currently selected */
  isSelected: boolean;
  /** Whether this node is highlighted (e.g., from search results) */
  isHighlighted: boolean;
  /** Whether this node matches current filters */
  matchesFilter: boolean;
  /** Whether this node is in the active context (e.g., selected in file explorer) */
  isInContext: boolean;
  /** ARIA attributes computed from tree structure */
  aria: TreeRowAriaAttributes;
}

/**
 * Column definition for TreeTable.
 * Each column defines how to render header and cells.
 */
export interface TreeTableColumn<T> {
  /** Unique column identifier */
  id: string;
  /** Header content (string or React element) */
  header?: React.ReactNode;
  /** Fixed width in pixels or CSS string */
  width?: number | string;
  /** Minimum width in pixels */
  minWidth?: number;
  /** Maximum width in pixels */
  maxWidth?: number;
  /** Cell renderer function */
  cell: (props: TreeTableCellProps<T>) => React.ReactNode;
  /** Additional CSS class for the column */
  className?: string;
  /** Additional CSS class for the header */
  headerClassName?: string;
  /** Whether this column is sortable */
  sortable?: boolean;
  /** Accessor function for sorting */
  accessorFn?: (node: TreeNode<T>) => unknown;
}

/**
 * Props passed to cell renderer functions.
 */
export interface TreeTableCellProps<T> {
  /** The tree node being rendered */
  node: TreeNode<T>;
  /** Depth level for indentation */
  depth: number;
  /** Whether the node is expanded */
  isExpanded: boolean;
  /** Whether the node is selected */
  isSelected: boolean;
  /** Whether the node is highlighted */
  isHighlighted: boolean;
  /** Whether the node is in the active context */
  isInContext: boolean;
  /** Row index in the flattened array */
  rowIndex: number;
}

/**
 * Row height configuration.
 * Can be a fixed number, a record mapping node types to heights,
 * or a function that returns height per node.
 */
export type RowHeightConfig<T> = number | Record<string, number> | ((node: TreeNode<T>) => number);

/**
 * Selection mode for the tree table.
 */
export type SelectionMode = 'none' | 'single' | 'multi';

/**
 * Sort direction for columns.
 */
export type SortDirection = 'asc' | 'desc' | null;

/**
 * Windowing strategy for tree rows.
 */
export type TreeTableWindowingStrategy = 'virtual' | 'paged' | 'auto';

/**
 * Context hint used by auto windowing strategy.
 */
export type TreeTableAutoWindowingContext = 'browse' | 'search';

/**
 * Pagination options used when paged windowing is active.
 */
export interface TreeTablePaginationOptions {
  /** Items per page */
  pageSize?: number;
  /** Callback when page changes (0-based) */
  onPageChange?: (page: number) => void;
  /** Callback when page size changes */
  onPageSizeChange?: (pageSize: number) => void;
  /** Available page size options */
  pageSizeOptions?: readonly number[];
  /** Optional additional page info text */
  pageInfo?: string;
  /** Whether to show item range summary */
  showItemRange?: boolean;
  /** Whether to show pagination controls */
  showControls?: boolean;
}

/**
 * Sort state for the tree table.
 */
export interface SortState {
  /** Currently sorted column ID */
  columnId: string | null;
  /** Sort direction */
  direction: SortDirection;
}

/**
 * Main props for the TreeTable component.
 */
export interface TreeTableProps<T> {
  /** Tree nodes to display (can be nested via hasChildren) */
  nodes: TreeNode<T>[];
  /** Column definitions */
  columns: TreeTableColumn<T>[];

  // Expansion state
  /** Set of expanded node IDs */
  expandedIds: Set<string>;
  /** Callback when a node is toggled */
  onToggleExpand: (nodeId: string) => void;
  /** Callback to expand all nodes */
  onExpandAll?: () => void;
  /** Callback to collapse all nodes */
  onCollapseAll?: () => void;

  // Selection state
  /** Currently selected node ID (single selection mode) */
  selectedId?: string | null;
  /** Callback when a node is selected */
  onSelect?: (nodeId: string | null) => void;
  /** Set of selected node IDs (multi-selection mode) */
  multiSelectedIds?: Set<string>;
  /** Callback when multi-selection changes */
  onMultiSelectChange?: (ids: Set<string>) => void;
  /** Selection mode */
  selectionMode?: SelectionMode;

  // Highlighting (e.g., search results)
  /** Set of highlighted node IDs */
  highlightedIds?: Set<string>;

  // Context awareness
  /** Set of node IDs that are in the active context (e.g., selected in file explorer) */
  contextNodeIds?: Set<string>;

  // Virtualization
  /** Row height (fixed number or function) */
  rowHeight?: RowHeightConfig<T>;
  /** Number of rows to render outside visible area */
  overscan?: number;
  /** Windowing strategy for row rendering */
  windowingStrategy?: TreeTableWindowingStrategy;
  /** Context hint used by auto strategy */
  autoWindowingContext?: TreeTableAutoWindowingContext;
  /** Row threshold for auto strategy to switch to paged mode (values < 1 are clamped to 1) */
  autoPagedRowThreshold?: number;
  /** Pagination options used by paged strategy */
  pagination?: TreeTablePaginationOptions;
  /** Maximum height of the table container */
  maxHeight?: string;

  // Sorting
  /** Current sort state */
  sortState?: SortState;
  /** Callback when sort changes */
  onSortChange?: (columnId: string, direction: SortDirection) => void;

  // Lazy loading
  /** Callback to load children for a node */
  onLoadChildren?: (nodeId: string) => Promise<void>;
  /** Set of node IDs currently loading children */
  loadingNodeIds?: Set<string>;

  // Styling
  /** Additional CSS class for the container */
  className?: string;
  /** Additional CSS class for rows */
  rowClassName?: string | ((node: TreeNode<T>) => string);

  // Empty state
  /** Content to show when there are no nodes */
  emptyState?: React.ReactNode;

  // Accessibility
  /** Accessible label for the table */
  ariaLabel?: string;

  // Checkbox
  /** Whether to show checkboxes for row selection */
  showCheckbox?: boolean;

  // Callbacks
  /** Callback when a row is double-clicked */
  onRowDoubleClick?: (nodeId: string, node: TreeNode<T>) => void;
  /** Callback when a row is right-clicked (context menu) */
  onRowContextMenu?: (nodeId: string, node: TreeNode<T>, event: React.MouseEvent) => void;
}

/**
 * Checkbox state for tri-state parent checkboxes.
 */
export type CheckboxState = 'checked' | 'unchecked' | 'indeterminate';

/**
 * Props for the TreeTableRow component.
 */
export interface TreeTableRowProps<T> {
  /** Flattened row data */
  row: FlattenedRow<T>;
  /** Column definitions */
  columns: TreeTableColumn<T>[];
  /** Callback to toggle expansion */
  onToggleExpand: (nodeId: string) => void;
  /** Callback when row is clicked */
  onClick?: (nodeId: string, event: React.MouseEvent) => void;
  /** Callback when row is double-clicked */
  onDoubleClick?: (nodeId: string) => void;
  /** Callback when row is right-clicked */
  onContextMenu?: (nodeId: string, event: React.MouseEvent) => void;
  /** Additional CSS class */
  className?: string;
  /** Style object (for virtual positioning) */
  style?: React.CSSProperties;
  /** Whether this row is focused for keyboard navigation */
  isFocused?: boolean;
  /** Ref callback for measuring element */
  measureRef?: (node: HTMLTableRowElement | null) => void;
  /** Virtual index for @tanstack/react-virtual measureElement */
  virtualIndex?: number;
  /** Whether to show checkbox for multi-select */
  showCheckbox?: boolean | undefined;
  /** Checkbox state (for tri-state parent logic) */
  checkboxState?: CheckboxState | undefined;
  /** Callback when checkbox is toggled */
  onCheckboxChange?: ((nodeId: string) => void) | undefined;
  /** Total number of rows for ARIA rowcount */
  totalRowCount?: number | undefined;
}

/**
 * Keyboard navigation state.
 */
export interface KeyboardNavigationState {
  /** Currently focused node ID */
  focusedId: string | null;
  /** Whether keyboard navigation is active */
  isActive: boolean;
}

/**
 * Keyboard navigation actions.
 */
export interface KeyboardNavigationActions {
  /** Move focus up */
  moveUp: () => void;
  /** Move focus down */
  moveDown: () => void;
  /** Expand focused node (or move into children) */
  expandOrMoveRight: () => void;
  /** Collapse focused node (or move to parent) */
  collapseOrMoveLeft: () => void;
  /** Select focused node */
  selectFocused: () => void;
  /** Toggle selection of focused node (multi-select) */
  toggleFocused: () => void;
  /** Focus a specific node */
  setFocus: (nodeId: string | null) => void;
  /** Reset keyboard navigation */
  reset: () => void;
}

/**
 * Result of the useTreeKeyboard hook.
 */
export interface UseTreeKeyboardResult {
  /** Current navigation state */
  state: KeyboardNavigationState;
  /** Navigation actions */
  actions: KeyboardNavigationActions;
  /** Event handler for keydown events */
  onKeyDown: (event: React.KeyboardEvent) => void;
}

/**
 * Options for tree flattening utilities.
 */
export interface FlattenOptions {
  /** Set of expanded node IDs */
  expandedIds: Set<string>;
  /** Selected node ID (single selection) */
  selectedId?: string | null;
  /** Set of selected node IDs (multi-selection) */
  multiSelectedIds?: Set<string>;
  /** Set of highlighted node IDs */
  highlightedIds?: Set<string>;
  /** Set of node IDs that are in the active context */
  contextNodeIds?: Set<string>;
  /** Filter function to determine which nodes match current filters */
  filterFn?: (node: TreeNode<unknown>) => boolean;
}

/**
 * Result of tree flattening.
 */
export interface FlattenResult<T> {
  /** Flattened rows in display order */
  rows: FlattenedRow<T>[];
  /** Map of node ID to row index for quick lookup */
  indexMap: Map<string, number>;
  /** Total count of visible rows */
  visibleCount: number;
}
