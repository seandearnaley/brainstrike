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
  /** Number of direct children (optional, for display purposes) */
  childCount?: number;
  /** Custom data payload for this node */
  data: T;
  /** Depth level in the tree (0 = root) */
  depth: number;
  /** Whether this node has children that can be expanded */
  hasChildren: boolean;
  /** Unique identifier for this node */
  id: string;
  /** Whether children are currently being loaded */
  isLoading?: boolean;
  /** Parent node ID, or null for root nodes */
  parentId: string | null;
  /** Type discriminator for different node kinds (e.g., 'file', 'chunk', 'vector') */
  type: string;
}

/**
 * ARIA attributes for a tree row, computed from tree structure.
 * Follows WAI-ARIA treegrid pattern.
 */
export interface TreeRowAriaAttributes {
  /** Depth in hierarchy (1-based, per ARIA spec) */
  ariaLevel: number;
  /** Position among siblings (1-based) */
  ariaPosInSet: number;
  /** 1-based row index within the full grid (for virtualized grids) */
  ariaRowIndex: number;
  /** Number of siblings at the same level under the same parent */
  ariaSetSize: number;
}

/**
 * A flattened representation of a tree node for rendering.
 * Includes visual state information (expanded, selected, highlighted).
 */
export interface FlattenedRow<T = unknown> {
  /** ARIA attributes computed from tree structure */
  aria: TreeRowAriaAttributes;
  /** Index in the flattened array */
  index: number;
  /** Whether this node is currently expanded */
  isExpanded: boolean;
  /** Whether this node is highlighted (e.g., from search results) */
  isHighlighted: boolean;
  /** Whether this node is in the active context (e.g., selected in file explorer) */
  isInContext: boolean;
  /** Whether this node is currently selected */
  isSelected: boolean;
  /** Whether this node matches current filters */
  matchesFilter: boolean;
  /** The tree node data */
  node: TreeNode<T>;
}

/**
 * Column definition for TreeTable.
 * Each column defines how to render header and cells.
 */
export interface TreeTableColumn<T> {
  /** Accessor function for sorting */
  accessorFn?: (node: TreeNode<T>) => unknown;
  /** Cell renderer function */
  cell: (props: TreeTableCellProps<T>) => React.ReactNode;
  /** Additional CSS class for the column */
  className?: string;
  /** Optional cell colSpan for a given row. Use sparingly for structural rows that should span adjacent columns. */
  colSpan?: (props: TreeTableCellProps<T>) => number | undefined;
  /**
   * Default pixel width applied when no controlled `columnSizes` value and no
   * persisted width exist. Used by the uncontrolled sizing path.
   */
  defaultWidth?: number;
  /** Header content (string or React element) */
  header?: React.ReactNode;
  /** Additional CSS class for the header */
  headerClassName?: string;
  /** Additional CSS class for the header content wrapper inside the header cell. */
  headerContentClassName?: string;
  /** Unique column identifier */
  id: string;
  /** Override indentation width for this tree column. */
  indentWidth?: number;
  /**
   * When true, this column receives tree indentation, expand/collapse toggle,
   * and checkbox rendering. Defaults to true for the first column only.
   * Set to false on utility columns (e.g., a standalone checkbox column) to
   * prevent the tree layout from being applied.
   */
  isTreeColumn?: boolean;
  /** Maximum width in pixels */
  maxWidth?: number;
  /** Minimum width in pixels */
  minWidth?: number;
  /** When false, leaf rows do not reserve empty expand-toggle space in the tree column. */
  reserveToggleSpace?: boolean;
  /**
   * Whether this column can be resized. Defaults to `true` for any column that
   * is not pinned (i.e. when `width === minWidth === maxWidth` the column is
   * inherently non-resizable and the handle is suppressed regardless of this
   * flag). Set to `false` to explicitly opt out for resizable-width columns.
   */
  resizable?: boolean;
  /** Whether TreeTable should render its built-in sort indicator. Defaults to true. */
  showSortIndicator?: boolean;
  /** Whether this column is sortable */
  sortable?: boolean;
  /** Fixed width in pixels or CSS string */
  width?: number | string;
}

/**
 * Props passed to cell renderer functions.
 */
export interface TreeTableCellProps<T> {
  /** Depth level for indentation */
  depth: number;
  /** Whether the node is expanded */
  isExpanded: boolean;
  /** Whether the node is highlighted */
  isHighlighted: boolean;
  /** Whether the node is in the active context */
  isInContext: boolean;
  /** Whether the node is selected */
  isSelected: boolean;
  /** The tree node being rendered */
  node: TreeNode<T>;
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
 * - virtual: react-virtual renders only visible rows
 * - paged: renders current page slice with pagination controls
 * - auto: chooses virtual/paged based on context
 * - none: renders all rows without virtual or paged slicing
 */
export type TreeTableWindowingStrategy = 'virtual' | 'paged' | 'auto' | 'none';

/**
 * Context hint used by auto windowing strategy.
 */
export type TreeTableAutoWindowingContext = 'browse' | 'search';

/**
 * Pagination options used when paged windowing is active.
 */
export interface TreeTablePaginationOptions {
  /** Callback when page changes (0-based) */
  onPageChange?: (page: number) => void;
  /** Callback when page size changes */
  onPageSizeChange?: (pageSize: number) => void;
  /** Optional additional page info text */
  pageInfo?: string;
  /** Items per page */
  pageSize?: number;
  /** Available page size options */
  pageSizeOptions?: readonly number[];
  /** Whether to show pagination controls */
  showControls?: boolean;
  /** Whether to show item range summary */
  showItemRange?: boolean;
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
 * Checkbox state for tri-state parent checkboxes.
 */
export type CheckboxState = 'checked' | 'unchecked' | 'indeterminate';

/**
 * Next state requested by a user checkbox interaction.
 * Indeterminate always resolves to `'checked'` (check) on activation.
 */
export type TreeTableCheckboxNextState = 'checked' | 'unchecked';

/**
 * Visible checkbox states plus an explicit hide sentinel.
 * `undefined` from `getCheckboxState` is treated the same as `'hidden'`.
 */
export type TreeTableCheckboxRenderState = CheckboxState | 'hidden';

/**
 * Main props for the TreeTable component.
 */
export interface TreeTableProps<T> {
  // Accessibility
  /** Accessible label for the table */
  ariaLabel?: string;
  /** ARIA role for the table container */
  ariaRole?: 'treegrid' | 'grid';
  /**
   * Row threshold for auto strategy to switch to paged mode.
   * Values < 1 are clamped to 1.
   * Auto mode only considers this threshold in `search` context.
   * In search mode, pass `0` to force paged mode whenever at least one row is present.
   */
  autoPagedRowThreshold?: number;
  /** Context hint used by auto strategy */
  autoWindowingContext?: TreeTableAutoWindowingContext;

  // Styling
  /** Additional CSS class for the container */
  className?: string;
  /**
   * Controlled map of column id → pixel width.
   *
   * When present, TreeTable renders the supplied widths and routes user
   * resizing through `onColumnSizesChange`. When absent, sizing is
   * uncontrolled and falls back to `column.defaultWidth` / `column.width`.
   */
  columnSizes?: Record<string, number>;
  /** Column definitions */
  columns: TreeTableColumn<T>[];

  // Context awareness
  /** Set of node IDs that are in the active context (e.g., selected in file explorer) */
  contextNodeIds?: Set<string>;

  // Empty state
  /** Content to show when there are no nodes */
  emptyState?: React.ReactNode;

  // Expansion state
  /** Set of expanded node IDs */
  expandedIds: Set<string>;

  // Checkbox
  /**
   * Pluggable per-node checkbox state. When provided, TreeTable renders a
   * checkbox for each node whose return value is a visible CheckboxState. Return
   * `'hidden'` or `undefined` to omit the checkbox for that row (e.g. match
   * leaves under a chunk). Takes precedence over the built-in
   * `multiSelectedIds` cascade when resolving visual state.
   */
  getCheckboxState?: (node: TreeNode<T>) => TreeTableCheckboxRenderState | undefined;

  // Highlighting (e.g., search results)
  /** Set of highlighted node IDs */
  highlightedIds?: Set<string>;
  /** Adds a small inset before tree controls in the tree column. */
  insetTreeControls?: boolean;
  /** Set of node IDs currently loading children */
  loadingNodeIds?: Set<string>;
  /** Maximum height of the table container */
  maxHeight?: string;
  /** Set of selected node IDs (multi-selection mode) */
  multiSelectedIds?: Set<string>;
  /** Tree nodes to display (can be nested via hasChildren) */
  nodes: TreeNode<T>[];
  /**
   * Treat `nodes` as an already-expanded, visible flat row model.
   * This skips TreeTable's recursive expansion flattening while preserving
   * row virtualization, keyboard navigation, and ARIA row metadata.
   */
  nodesArePreFlattened?: boolean;
  /**
   * Pluggable checkbox change handler. Receives the node and the next
   * checked/unchecked state. When provided, replaces the built-in
   * select-descendants cascade from `onMultiSelectChange` for checkbox
   * clicks (and Space when the pluggable path is active).
   */
  onCheckboxChange?: (node: TreeNode<T>, nextState: TreeTableCheckboxNextState) => void;
  /** Callback to collapse all nodes */
  onCollapseAll?: () => void;
  /**
   * Called with the next full sizes map after every pointer or keyboard
   * resize. Values are pre-clamped to each column's `[minWidth, maxWidth]`.
   */
  onColumnSizesChange?: (next: Record<string, number>) => void;
  /** Callback to expand all nodes */
  onExpandAll?: () => void;

  // Lazy loading
  /** Callback to load children for a node */
  onLoadChildren?: (nodeId: string) => Promise<void>;
  /** Callback when multi-selection changes */
  onMultiSelectChange?: (ids: Set<string>) => void;
  /** Callback when a row is right-clicked (context menu) */
  onRowContextMenu?: (nodeId: string, node: TreeNode<T>, event: React.MouseEvent) => void;

  // Callbacks
  /** Callback when a row is double-clicked */
  onRowDoubleClick?: (nodeId: string, node: TreeNode<T>) => void;
  /** Callback when a node is selected */
  onSelect?: (nodeId: string | null) => void;
  /** Callback when sort changes */
  onSortChange?: (columnId: string, direction: SortDirection) => void;
  /** Callback when a node is toggled */
  onToggleExpand: (nodeId: string) => void;
  /** Number of rows to render outside visible area */
  overscan?: number;
  /** Pagination options used by paged strategy */
  pagination?: TreeTablePaginationOptions;
  /** Additional CSS class for rows */
  rowClassName?: string | ((node: TreeNode<T>) => string);

  // Virtualization
  /** Row height (fixed number or function) */
  rowHeight?: RowHeightConfig<T>;

  // Selection state
  /** Currently selected node ID (single selection mode) */
  selectedId?: string | null;
  /** Selection mode */
  selectionMode?: SelectionMode;
  /** Whether to show checkboxes for row selection */
  showCheckbox?: boolean;
  /** Whether to render the header row. Prefer this prop over CSS-only header hiding. */
  showHeader?: boolean;

  // Sorting
  /** Current sort state */
  sortState?: SortState;
  /** Windowing strategy for row rendering */
  windowingStrategy?: TreeTableWindowingStrategy;
}

/**
 * Props for the TreeTableRow component.
 */
export interface TreeTableRowProps<T> {
  /** ARIA role inherited from the table container */
  ariaRole?: 'treegrid' | 'grid' | undefined;
  /** Checkbox state (for tri-state parent logic) */
  checkboxState?: CheckboxState | undefined;
  /** Additional CSS class */
  className?: string;
  /** Column definitions */
  columns: TreeTableColumn<T>[];
  /** Adds a small inset before tree controls in the tree column. */
  insetTreeControls?: boolean | undefined;
  /** Whether this row is focused for keyboard navigation */
  isFocused?: boolean;
  /** Ref callback for measuring element */
  measureRef?: (node: HTMLTableRowElement | null) => void;
  /**
   * Callback when checkbox is toggled.
   * Built-in path passes nodeId only; pluggable path is wired at TreeTable.
   */
  onCheckboxChange?: ((nodeId: string) => void) | undefined;
  /** Callback when row is clicked */
  onClick?: (nodeId: string, event: React.MouseEvent) => void;
  /** Callback when row is right-clicked */
  onContextMenu?: (nodeId: string, event: React.MouseEvent) => void;
  /** Callback when row is double-clicked */
  onDoubleClick?: (nodeId: string) => void;
  /** Callback to toggle expansion */
  onToggleExpand: (nodeId: string) => void;
  /** Flattened row data */
  row: FlattenedRow<T>;
  /** Whether to show checkbox for multi-select */
  showCheckbox?: boolean | undefined;
  /** Style object (for virtual positioning) */
  style?: React.CSSProperties;
  /** Total number of rows for ARIA rowcount */
  totalRowCount?: number | undefined;
  /** Virtual index for @tanstack/react-virtual measureElement */
  virtualIndex?: number;
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
  /** Collapse focused node (or move to parent) */
  collapseOrMoveLeft: () => void;
  /** Expand focused node (or move into children) */
  expandOrMoveRight: () => void;
  /** Move focus down */
  moveDown: () => void;
  /** Move focus up */
  moveUp: () => void;
  /** Reset keyboard navigation */
  reset: () => void;
  /** Select focused node */
  selectFocused: () => void;
  /** Focus a specific node */
  setFocus: (nodeId: string | null) => void;
  /** Toggle selection of focused node (multi-select) */
  toggleFocused: () => void;
}

/**
 * Result of the useTreeKeyboard hook.
 */
export interface UseTreeKeyboardResult {
  /** Navigation actions */
  actions: KeyboardNavigationActions;
  /** Event handler for keydown events */
  onKeyDown: (event: React.KeyboardEvent) => void;
  /** Current navigation state */
  state: KeyboardNavigationState;
}

/**
 * Options for tree flattening utilities.
 */
export interface FlattenOptions {
  /** Set of node IDs that are in the active context */
  contextNodeIds?: Set<string>;
  /** Set of expanded node IDs */
  expandedIds: Set<string>;
  /** Filter function to determine which nodes match current filters */
  filterFn?: (node: TreeNode<unknown>) => boolean;
  /** Set of highlighted node IDs */
  highlightedIds?: Set<string>;
  /** Set of selected node IDs (multi-selection) */
  multiSelectedIds?: Set<string>;
  /** 1-based offset for aria-rowindex (2 when header row is present, 1 otherwise) */
  rowIndexOffset?: number;
  /** Selected node ID (single selection) */
  selectedId?: string | null;
}

/**
 * Result of tree flattening.
 */
export interface FlattenResult<T> {
  /** Map of node ID to row index for quick lookup */
  indexMap: Map<string, number>;
  /** Flattened rows in display order */
  rows: FlattenedRow<T>[];
  /** Total count of visible rows */
  visibleCount: number;
}
