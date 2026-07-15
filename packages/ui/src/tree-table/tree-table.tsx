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

import { useEventCallback, usePagination } from '@brainstrike/hooks';
import { observeElementRect, useVirtualizer } from '@tanstack/react-virtual';
import * as React from 'react';

import { warnCycleOnce } from '../lib/cycle-warning';
import { cn } from '../lib/utils';
import { Table, TableBody, TableHead, TableHeader, TableRow } from '../table';
import { TablePagination } from '../table-pagination';
import { ColumnResizeHandle } from './column-resize-handle';
import { DEFAULT_ROW_HEIGHTS, TreeTableRow } from './tree-table-row';
import {
  createChildrenGetter,
  flattenPreFlattenedTreeRows,
  flattenTreeRecursive,
  getDescendantIds,
  reuseEqualFlattenedRows,
} from './tree-utils';
import type {
  CheckboxState,
  FlattenedRow,
  TreeNode,
  TreeTableProps,
  TreeTableRowProps,
} from './types';
import { computeColumnBounds, useColumnSizing } from './use-column-sizing';
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
const KEYBOARD_FOCUS_KEYS = new Set([
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'End',
  'Home',
]);
export const DEFAULT_AUTO_PAGED_ROW_THRESHOLD = 200;
const MIN_FALLBACK_VIRTUAL_ROWS = 1;
// Performance-only fallback cache keyed by table container element.
// WeakMap ensures container entries are reclaimed after unmount.
// Shared module-level cache is intentional: container keying isolates instances
// while avoiding per-instance fallback map allocation churn.
// Each inner map is fully rebuilt from currently rendered rows on fallback miss,
// and invalidated on displayed-row updates to bound stale detached row refs.
const rowFallbackLookupCache = new WeakMap<HTMLElement, Map<string, HTMLTableRowElement>>();

interface EmptyVirtualRowMeasureProps {
  measureRef?: never;
}

type VirtualRowMeasureProps<T> =
  | Pick<TreeTableRowProps<T>, 'measureRef'>
  | EmptyVirtualRowMeasureProps;

function resolveVirtualRowMeasureProps<T>(
  hasFixedRowHeight: boolean,
  measureRow: NonNullable<TreeTableRowProps<T>['measureRef']>
): VirtualRowMeasureProps<T> {
  if (hasFixedRowHeight) {
    return {};
  }

  return { measureRef: measureRow };
}

/**
 * Maps our SortDirection to ARIA sort values.
 */
function getAriaSortValue(
  columnId: string,
  sortState?: { columnId: string | null; direction: 'asc' | 'desc' | null }
): 'ascending' | 'descending' | 'none' | undefined {
  if (!sortState || sortState.columnId !== columnId) {
    return;
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
  autoPagedRowThreshold: number;
  autoWindowingContext: NonNullable<TreeTableProps<unknown>['autoWindowingContext']>;
  rowCount: number;
  strategy: TreeTableProps<unknown>['windowingStrategy'];
}

/**
 * Resolves runtime row-windowing mode.
 *
 * Auto strategy is intentionally conservative:
 * - `browse` context always stays virtual (smooth sequential navigation).
 * - `search` context can switch to paged mode once row count crosses the threshold.
 * - Threshold values are clamped to >= 1 to avoid invalid paging math.
 */
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

function buildFallbackRowLookup(container: HTMLElement): Map<string, HTMLTableRowElement> {
  const lookup = new Map<string, HTMLTableRowElement>();
  const rows = container.querySelectorAll<HTMLTableRowElement>('[data-node-id]');
  for (const row of rows) {
    const nodeId = row.getAttribute('data-node-id');
    if (nodeId) {
      lookup.set(nodeId, row);
    }
  }
  return lookup;
}

function findRowElementByNodeId(
  container: HTMLElement,
  nodeId: string
): HTMLTableRowElement | null {
  const escapedNodeId = CSS.escape(nodeId);
  let directMatch: HTMLTableRowElement | null = null;
  try {
    directMatch = container.querySelector<HTMLTableRowElement>(`[data-node-id=${escapedNodeId}]`);
  } catch {
    directMatch = null;
  }
  if (directMatch) {
    return directMatch;
  }

  // JSDOM and browser selector engines can diverge on edge-case escapes.
  // Keep a fallback for correctness, but cache scan results by container so
  // paged keyboard navigation avoids repeated O(n) DOM traversal.
  const cachedRows = rowFallbackLookupCache.get(container);
  const cachedMatch = cachedRows?.get(nodeId);
  if (cachedMatch?.isConnected) {
    return cachedMatch;
  }
  if (cachedMatch && cachedRows) {
    cachedRows.delete(nodeId);
  }

  const refreshedLookup = buildFallbackRowLookup(container);
  rowFallbackLookupCache.set(container, refreshedLookup);
  return refreshedLookup.get(nodeId) ?? null;
}

interface BuildTablePaginationPropsOptions {
  currentPage: number;
  onPageChange: (nextPage: number) => void;
  onPageSizeChange: (nextPageSize: number) => void;
  pageSize: number;
  paginationOptions: TreeTableProps<unknown>['pagination'];
  totalItems: number;
  totalPages: number;
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
    onPageSizeChange,
    pageSize,
    totalItems,
    totalPages,
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
  columns: TreeTableProps<T>['columns'];
  getResolvedWidth: (columnId: string) => number | undefined;
  isColumnResizable: (columnId: string) => boolean;
  onResize: (columnId: string, nextWidth: number) => void;
  onSortChange: TreeTableProps<T>['onSortChange'];
  onSortClick: (columnId: string) => void;
  showHeader: boolean;
  sortState: TreeTableProps<T>['sortState'];
}

function resolveColumnHeaderLabel<T>(column: TreeTableProps<T>['columns'][number]): string {
  if (typeof column.header === 'string') {
    return column.header;
  }
  return column.id;
}

function renderTableHeader<T>({
  showHeader,
  columns,
  sortState,
  onSortChange,
  onSortClick,
  getResolvedWidth,
  isColumnResizable,
  onResize,
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
          const resolvedWidth = getResolvedWidth(column.id);
          const showHandle = isColumnResizable(column.id) && resolvedWidth !== undefined;

          return (
            <TableHead
              aria-sort={ariaSortValue}
              className={cn(
                'relative',
                column.headerClassName,
                column.sortable && onSortChange && 'cursor-pointer select-none'
              )}
              key={column.id}
              onClick={() => column.sortable && onSortClick(column.id)}
              role="columnheader"
              style={{
                maxWidth: column.maxWidth,
                minWidth: column.minWidth,
                width: resolvedWidth ?? column.width,
              }}
            >
              <div className={cn('flex items-center gap-1', column.headerContentClassName)}>
                {column.header ?? column.id}
                {column.sortable &&
                  column.showSortIndicator !== false &&
                  sortState?.columnId === column.id && (
                    <span aria-hidden="true" className="text-xs">
                      {sortState.direction === 'asc'
                        ? '\u2191'
                        : sortState.direction === 'desc'
                          ? '\u2193'
                          : ''}
                    </span>
                  )}
              </div>
              {showHandle && resolvedWidth !== undefined ? (
                <ColumnResizeHandle
                  bounds={computeColumnBounds(column)}
                  columnId={column.id}
                  columnLabel={resolveColumnHeaderLabel(column)}
                  currentWidth={resolvedWidth}
                  onResize={onResize}
                />
              ) : null}
            </TableHead>
          );
        })}
      </TableRow>
    </TableHeader>
  );
}

interface TreeTableColgroupProps<T> {
  columns: TreeTableProps<T>['columns'];
  getResolvedWidth: (columnId: string) => number | undefined;
}

/**
 * Propagates header widths to body cells via a colgroup. The shared
 * `<Table>` component already sets `table-fixed`, so per-column `<col>`
 * widths apply uniformly to every row without touching cell renderers.
 *
 * Memoized over (columns, resolved sizes) so the colgroup does not rebuild
 * on unrelated tree-state changes (selection, expand/collapse, focus).
 */
function TreeTableColgroupInner<T>({
  columns,
  getResolvedWidth,
}: TreeTableColgroupProps<T>): React.ReactElement | null {
  const hasAnyWidth = columns.some(
    (column) => getResolvedWidth(column.id) !== undefined || column.width !== undefined
  );
  if (!hasAnyWidth) {
    return null;
  }
  return (
    <colgroup>
      {columns.map((column) => {
        const resolved = getResolvedWidth(column.id);
        const width = resolved === undefined ? column.width : `${resolved}px`;
        return <col key={column.id} style={width === undefined ? undefined : { width }} />;
      })}
    </colgroup>
  );
}
const TreeTableColgroup = React.memo(TreeTableColgroupInner) as typeof TreeTableColgroupInner;

function resolveRowIndexOffset(showHeader: boolean): number {
  return showHeader ? 2 : 1;
}

function resolveTotalRowCount(rowCount: number, showHeader: boolean): number {
  return rowCount + (showHeader ? 1 : 0);
}

function resolveTableAriaRole(ariaRole: TreeTableProps<unknown>['ariaRole']): 'treegrid' | 'grid' {
  return ariaRole === 'grid' ? 'grid' : 'treegrid';
}

function resolvePaginationTotalItems(isPagedWindowing: boolean, rowCount: number): number {
  return isPagedWindowing ? rowCount : 0;
}

interface TreeTableViewportProps {
  children: React.ReactNode;
  className?: string | undefined;
  maxHeight: string;
  parentRef: React.RefObject<HTMLDivElement | null>;
}

function TreeTableViewport({
  className,
  maxHeight,
  parentRef,
  children,
}: TreeTableViewportProps): React.ReactElement {
  return (
    <div
      className={cn('relative min-h-0 min-w-0 flex-1 overflow-auto', className)}
      ref={parentRef}
      style={{ maxHeight }}
    >
      {children}
    </div>
  );
}

interface TreeTableVirtualItem {
  end?: number;
  index: number;
  start?: number;
}

function buildFallbackVirtualItems(rowCount: number, overscan: number): TreeTableVirtualItem[] {
  const fallbackCount = Math.min(rowCount, Math.max(MIN_FALLBACK_VIRTUAL_ROWS, overscan * 2));
  return Array.from({ length: fallbackCount }, (_, index) => ({ index }));
}

function resolveRenderedVirtualItems(
  isVirtualWindowing: boolean,
  virtualItems: TreeTableVirtualItem[],
  rowCount: number,
  overscan: number
): TreeTableVirtualItem[] {
  if (!isVirtualWindowing) {
    return [];
  }
  const validVirtualItems = virtualItems.filter(
    (virtualItem) => virtualItem.index >= 0 && virtualItem.index < rowCount
  );
  if (validVirtualItems.length > 0 || rowCount === 0) {
    return validVirtualItems;
  }
  // During first paint react-virtual can briefly report zero measured items.
  // It can also briefly report stale indexes after a row-count collapse.
  // Render a small fallback slice to avoid an empty table flash until measurement settles.
  return buildFallbackVirtualItems(rowCount, overscan);
}

function useResolvedPageSize(
  pagination: TreeTableProps<unknown>['pagination']
): [number, React.Dispatch<React.SetStateAction<number>>] {
  const [internalPageSize, setInternalPageSize] = React.useState<number>(
    () => pagination?.pageSize ?? DEFAULT_PAGE_SIZE
  );
  return [pagination?.pageSize ?? internalPageSize, setInternalPageSize];
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
    // Cap warning memory instead of clearing it; avoids repeated warnings for the same IDs.
    maxWarnings: MAX_WARNED_CYCLE_NODE_IDS,
    nodeId,
    warnedNodeIds: warnedCycleNodeIds,
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
 * Resolve the effective Space handler: a consumer-provided one wins; otherwise
 * the internal pluggable-checkbox handler when that visual path is active.
 */
function resolveCheckboxSpaceHandler(
  consumerHandler: ((nodeId: string) => boolean) | undefined,
  pluggablePathActive: boolean,
  pluggableHandler: (nodeId: string) => boolean
): ((nodeId: string) => boolean) | undefined {
  if (consumerHandler !== undefined) {
    return consumerHandler;
  }
  return pluggablePathActive ? pluggableHandler : undefined;
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
  selectOnRowClick = true,
  highlightedIds = DEFAULT_HIGHLIGHTED,
  contextNodeIds = DEFAULT_CONTEXT_NODE_IDS,
  nodesArePreFlattened = false,
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
  viewportClassName,
  rowClassName,
  emptyState,
  ariaLabel = 'Tree table',
  ariaRole = 'treegrid',
  showHeader = true,
  showCheckbox = false,
  getCheckboxState,
  getCheckboxAriaLabel,
  onCheckboxChange,
  onCheckboxSpace,
  insetTreeControls = false,
  onRowDoubleClick,
  onRowContextMenu,
  columnSizes,
  onColumnSizesChange,
}: TreeTableProps<T>) {
  const tableAriaRole = resolveTableAriaRole(ariaRole);
  const parentRef = React.useRef<HTMLDivElement>(null);
  const [keyboardFocusVisible, setKeyboardFocusVisible] = React.useState(false);
  // Diagnostic-only cycle warning cache. This is intentionally mutable and
  // excluded from memo deps because it does not affect rendered output.
  const warnedCycleNodeIdsRef = React.useRef<Set<string>>(new Set());

  const columnSizing = useColumnSizing({
    columns,
    controlledSizes: columnSizes,
    onSizesChange: onColumnSizesChange,
  });

  const getChildren = React.useMemo(() => createChildrenGetter(nodes), [nodes]);

  const previousRowsByIdRef = React.useRef<ReadonlyMap<string, FlattenedRow<T>>>(new Map());
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

    const flattened = nodesArePreFlattened
      ? flattenPreFlattenedTreeRows(nodesWithLoading, {
          contextNodeIds,
          expandedIds,
          highlightedIds,
          multiSelectedIds,
          rowIndexOffset: resolveRowIndexOffset(showHeader),
          selectedId,
        })
      : flattenTreeRecursive(
          nodesWithLoading.filter((n) => n.parentId === null),
          {
            contextNodeIds,
            expandedIds,
            highlightedIds,
            multiSelectedIds,
            rowIndexOffset: resolveRowIndexOffset(showHeader),
            selectedId,
          },
          createChildrenGetter(nodesWithLoading)
        );

    // Structural sharing keyed by node id (see TREEGRID contract): a
    // selection/highlight change re-flattens, but only rows whose computed
    // fields changed get new identities — memo'd rows for the rest bail out.
    // The render-phase cache write is safe: reuse is by value-equality, so a
    // discarded concurrent render cannot make a later result incorrect.
    const stabilizedRows = reuseEqualFlattenedRows(previousRowsByIdRef.current, flattened.rows);
    previousRowsByIdRef.current = new Map(stabilizedRows.map((row) => [row.node.id, row]));
    return { indexMap: flattened.indexMap, rows: stabilizedRows };
  }, [
    nodes,
    expandedIds,
    selectedId,
    multiSelectedIds,
    highlightedIds,
    contextNodeIds,
    loadingNodeIds,
    nodesArePreFlattened,
    showHeader,
  ]);

  const resolvedWindowingStrategy = React.useMemo(
    () =>
      resolveWindowingStrategy({
        autoPagedRowThreshold,
        autoWindowingContext,
        rowCount: rows.length,
        strategy: windowingStrategy,
      }),
    [windowingStrategy, autoWindowingContext, rows.length, autoPagedRowThreshold]
  );
  const isVirtualWindowing = resolvedWindowingStrategy === 'virtual';
  const isPagedWindowing = resolvedWindowingStrategy === 'paged';

  const [pageSize, setInternalPageSize] = useResolvedPageSize(pagination);
  // Keep pagination state dormant when not in paged mode.
  // This avoids page-bound recalculation churn for virtual/none strategies
  // while preserving hook ordering and stable page state when mode flips.
  const paginationTotalItems = resolvePaginationTotalItems(isPagedWindowing, rows.length);

  const { currentPage, totalPages, startIndex, endIndex, goToPage, resetToFirstPage } =
    usePagination({
      pageSize,
      totalItems: paginationTotalItems,
    });

  const totalRowCount = resolveTotalRowCount(rows.length, showHeader);
  const hasFixedRowHeight = typeof rowHeight === 'number';

  // O(1) node lookup map — avoids O(N) nodes.find() per row
  const nodeById = React.useMemo(() => {
    const map = new Map<string, TreeNode<T>>();
    for (const node of nodes) {
      map.set(node.id, node);
    }
    return map;
  }, [nodes]);

  const usesPluggableCheckbox = getCheckboxState !== undefined;

  // Built-in cascade: compute checkbox states in a single bottom-up pass.
  // Skipped when a pluggable getCheckboxState is provided (or checkboxes are off).
  const checkboxStates = React.useMemo((): Map<string, CheckboxState> => {
    if (!showCheckbox || usesPluggableCheckbox) {
      return new Map();
    }
    return buildCheckboxStateMap(
      nodes,
      getChildren,
      multiSelectedIds,
      warnedCycleNodeIdsRef.current
    );
  }, [showCheckbox, usesPluggableCheckbox, nodes, multiSelectedIds, getChildren]);

  const resolveRowCheckboxState = React.useCallback(
    (node: TreeNode<T>): CheckboxState | null => {
      if (getCheckboxState) {
        const state = getCheckboxState(node);
        if (state === undefined || state === 'hidden') {
          return null;
        }
        return state;
      }
      if (!showCheckbox) {
        return null;
      }
      return checkboxStates.get(node.id) ?? 'unchecked';
    },
    [getCheckboxState, showCheckbox, checkboxStates]
  );

  const resolveNextCheckboxState = React.useCallback(
    (current: CheckboxState | null): 'checked' | 'unchecked' => {
      // Indeterminate and unchecked both activate to checked (standard tri-state UX).
      return current === 'checked' ? 'unchecked' : 'checked';
    },
    []
  );

  // Handle checkbox toggle. Pluggable path wins over the built-in cascade.
  // Identity-stable (useEventCallback): this is passed to every row, and a
  // selection-dependent useCallback re-rendered all visible rows per toggle.
  const handleCheckboxChange = useEventCallback((nodeId: string) => {
    const node = nodeById.get(nodeId);
    if (!node) {
      return;
    }

    if (onCheckboxChange) {
      const current = resolveRowCheckboxState(node);
      if (current === null) {
        return;
      }
      onCheckboxChange(node, resolveNextCheckboxState(current));
      return;
    }

    // Getter-only pluggable mode: do not mix with the built-in cascade.
    // checkboxStates is empty when getCheckboxState is set, so falling through
    // would treat every click as "unchecked → select".
    if (getCheckboxState !== undefined) {
      return;
    }

    if (!onMultiSelectChange) {
      return;
    }

    const descendants = getDescendantIds(node, getChildren);
    const currentState = checkboxStates.get(nodeId);
    const newSelection = new Set(multiSelectedIds);

    if (currentState === 'checked') {
      newSelection.delete(nodeId);
      for (const descId of descendants) {
        newSelection.delete(descId);
      }
    } else {
      newSelection.add(nodeId);
      for (const descId of descendants) {
        newSelection.add(descId);
      }
    }

    onMultiSelectChange(newSelection);
  });

  const resolveRowCheckboxAriaLabel = React.useCallback(
    (node: TreeNode<T>): string => getCheckboxAriaLabel?.(node) ?? `Select ${node.id}`,
    [getCheckboxAriaLabel]
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

  React.useEffect(() => {
    const container = parentRef.current;
    if (!container) {
      return;
    }
    // Invalidate fallback lookups when rendered rows change so detached row refs
    // do not linger across page/window transitions.
    rowFallbackLookupCache.delete(container);
  }, [displayedRows]);

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

  // Height-only observer: react-virtual's default observeElementRect fires on ANY
  // dimension change (including width), causing a full React re-render per frame during
  // horizontal panel resize. Override it to skip width-only changes since vertical
  // virtualization only depends on container height.
  const observedHeightRef = React.useRef<number>(0);
  const heightOnlyObserveRect: typeof observeElementRect = React.useCallback(
    (instance, cb) =>
      observeElementRect(instance, (rect) => {
        if (rect.height !== observedHeightRef.current) {
          observedHeightRef.current = rect.height;
          cb(rect);
        }
      }),
    []
  );

  // Setup virtualizer
  const rowVirtualizer = useVirtualizer({
    count: isVirtualWindowing ? rows.length : 0,
    estimateSize: (index) => {
      const row = rows[index];
      return row ? getRowHeight(row.node) : 40;
    },
    getScrollElement: () => parentRef.current,
    observeElementRect: heightOnlyObserveRect,
    overscan,
    // Avoid react-virtual calling ReactDOM.flushSync during layout updates.
    useFlushSync: false,
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
  const handlePluggableCheckboxSpace = React.useCallback(
    (nodeId: string): boolean => {
      // Getter-only pluggable mode: swallow Space so multi-select toggle does
      // not run (parity with the click path's early return).
      if (getCheckboxState !== undefined && onCheckboxChange === undefined) {
        return true;
      }
      if (!onCheckboxChange) {
        return false;
      }
      const node = nodeById.get(nodeId);
      if (!node) {
        return false;
      }
      const current = resolveRowCheckboxState(node);
      if (current === null) {
        return false;
      }
      onCheckboxChange(node, resolveNextCheckboxState(current));
      return true;
    },
    [
      getCheckboxState,
      onCheckboxChange,
      nodeById,
      resolveRowCheckboxState,
      resolveNextCheckboxState,
    ]
  );

  const keyboardOptions: UseTreeKeyboardOptions<T> = {
    expandedIds,
    getChildren,
    isTableFocused: true,
    nodes,
    onScrollToNode: scrollToNode,
    onToggleExpand,
    rowIndexById: indexMap,
    rows,
    selectionMode,
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
  // A consumer-provided Space handler (for in-cell checkboxes) wins; otherwise
  // the internal pluggable handler is used whenever that visual path is active.
  const resolvedCheckboxSpace = resolveCheckboxSpaceHandler(
    onCheckboxSpace,
    getCheckboxState !== undefined || onCheckboxChange !== undefined,
    handlePluggableCheckboxSpace
  );
  if (resolvedCheckboxSpace !== undefined) {
    keyboardOptions.onCheckboxSpace = resolvedCheckboxSpace;
  }
  const keyboard = useTreeKeyboard(keyboardOptions);
  const handleTreeKeyDown = useEventCallback((event: React.KeyboardEvent) => {
    if (
      KEYBOARD_FOCUS_KEYS.has(event.key) &&
      !(event.target instanceof HTMLInputElement) &&
      !(event.target instanceof HTMLTextAreaElement)
    ) {
      setKeyboardFocusVisible(true);
    }
    keyboard.onKeyDown(event);
  });
  const handleTreePointerDown = React.useCallback(() => {
    setKeyboardFocusVisible(false);
  }, []);
  const handleTreeBlur = React.useCallback((event: React.FocusEvent<HTMLTableElement>) => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) {
      return;
    }
    setKeyboardFocusVisible(false);
  }, []);

  // The TanStack virtualizer instance is identity-stable, so this adapter
  // (and the measure callback ref derived from it) only changes when the
  // windowing strategy flips. An inline object here re-attached the measure
  // ref on every render — one synchronous layout read per visible row per
  // render (see tree-table-render-stability.test.tsx).
  const measureAdapter = React.useMemo(
    () => ({
      measureElement: (element: HTMLTableRowElement | null) => {
        if (isVirtualWindowing && element) {
          rowVirtualizer.measureElement(element);
        }
      },
    }),
    [isVirtualWindowing, rowVirtualizer]
  );

  const {
    handleRowClick,
    handleRowDoubleClick,
    handleRowContextMenu,
    handleSortClick,
    getRowClassName,
    measureRow,
  } = useTreeTableHandlers({
    keyboard,
    multiSelectedIds,
    nodeById,
    onMultiSelectChange,
    onRowContextMenu,
    onRowDoubleClick,
    onSelect,
    onSortChange,
    rowClassName,
    rowIndexById: indexMap,
    rows,
    rowVirtualizer: measureAdapter,
    selectedId,
    selectionMode,
    selectOnRowClick,
    sortState,
  });
  const getResolvedRowClassName = React.useCallback(
    (node: TreeNode<T>): string =>
      cn(
        getRowClassName(node),
        keyboardFocusVisible &&
          keyboard.state.focusedId === node.id &&
          'outline-2 outline-foreground/50 outline-solid -outline-offset-2'
      ),
    [getRowClassName, keyboard.state.focusedId, keyboardFocusVisible]
  );

  const handlePaginationPageChange = React.useCallback(
    (nextPage: number) => {
      goToPage(nextPage);
      pagination?.onPageChange?.(nextPage);
    },
    [goToPage, pagination]
  );

  const handlePageSizeChange = React.useCallback(
    (nextPageSize: number) => {
      setInternalPageSize(nextPageSize);
      resetToFirstPage();
      pagination?.onPageSizeChange?.(nextPageSize);
    },
    [pagination, resetToFirstPage, setInternalPageSize]
  );

  const virtualItems = isVirtualWindowing ? rowVirtualizer.getVirtualItems() : [];
  const virtualRowMeasureProps = resolveVirtualRowMeasureProps(hasFixedRowHeight, measureRow);
  const renderedVirtualItems = resolveRenderedVirtualItems(
    isVirtualWindowing,
    virtualItems as TreeTableVirtualItem[],
    rows.length,
    overscan
  );
  const totalSize = isVirtualWindowing ? rowVirtualizer.getTotalSize() : 0;
  const firstRenderedVirtualItem = renderedVirtualItems[0];
  const lastRenderedVirtualItem = renderedVirtualItems.at(-1);
  const paddingTop = firstRenderedVirtualItem?.start ?? 0;
  const paddingBottom =
    lastRenderedVirtualItem?.end === undefined
      ? 0
      : Math.max(0, totalSize - lastRenderedVirtualItem.end);
  const shouldShowPagination = isPagedWindowing ? (pagination?.showControls ?? true) : false;
  const tablePaginationProps = React.useMemo(
    () =>
      buildTablePaginationProps({
        currentPage,
        onPageChange: handlePaginationPageChange,
        onPageSizeChange: handlePageSizeChange,
        pageSize,
        paginationOptions: pagination,
        totalItems: rows.length,
        totalPages,
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
        columns,
        getResolvedWidth: columnSizing.getWidth,
        isColumnResizable: columnSizing.isResizable,
        onResize: columnSizing.setWidth,
        onSortChange,
        onSortClick: handleSortClick,
        showHeader,
        sortState,
      }),
    [
      showHeader,
      columns,
      sortState,
      onSortChange,
      handleSortClick,
      columnSizing.getWidth,
      columnSizing.isResizable,
      columnSizing.setWidth,
    ]
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
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <TreeTableViewport className={viewportClassName} maxHeight={maxHeight} parentRef={parentRef}>
        <Table
          aria-colcount={columns.length}
          aria-label={ariaLabel}
          aria-multiselectable={selectionMode === 'multi' || undefined}
          aria-rowcount={totalRowCount}
          className={className}
          onBlur={handleTreeBlur}
          onKeyDown={handleTreeKeyDown}
          onPointerDownCapture={handleTreePointerDown}
          role={tableAriaRole}
          scrollContainer={false}
          tabIndex={0}
        >
          <TreeTableColgroup columns={columns} getResolvedWidth={columnSizing.getWidth} />
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

                  const rowCheckboxState = resolveRowCheckboxState(row.node);
                  const rowShowsCheckbox = rowCheckboxState !== null;
                  return (
                    <TreeTableRow
                      {...virtualRowMeasureProps}
                      ariaRole={tableAriaRole}
                      checkboxAriaLabel={resolveRowCheckboxAriaLabel(row.node)}
                      checkboxState={rowCheckboxState ?? 'unchecked'}
                      className={getResolvedRowClassName(row.node)}
                      columns={columns}
                      insetTreeControls={insetTreeControls}
                      isFocused={keyboard.state.focusedId === row.node.id}
                      key={row.node.id}
                      onCheckboxChange={rowShowsCheckbox ? handleCheckboxChange : undefined}
                      onClick={handleRowClick}
                      onContextMenu={handleRowContextMenu}
                      onDoubleClick={handleRowDoubleClick}
                      onToggleExpand={onToggleExpand}
                      row={row}
                      showCheckbox={rowShowsCheckbox}
                      totalRowCount={totalRowCount}
                      virtualIndex={virtualRow.index}
                    />
                  );
                })
              : displayedRows.map((row) => {
                  const rowCheckboxState = resolveRowCheckboxState(row.node);
                  const rowShowsCheckbox = rowCheckboxState !== null;
                  return (
                    <TreeTableRow
                      ariaRole={tableAriaRole}
                      checkboxAriaLabel={resolveRowCheckboxAriaLabel(row.node)}
                      checkboxState={rowCheckboxState ?? 'unchecked'}
                      className={getResolvedRowClassName(row.node)}
                      columns={columns}
                      insetTreeControls={insetTreeControls}
                      isFocused={keyboard.state.focusedId === row.node.id}
                      key={row.node.id}
                      onCheckboxChange={rowShowsCheckbox ? handleCheckboxChange : undefined}
                      onClick={handleRowClick}
                      onContextMenu={handleRowContextMenu}
                      onDoubleClick={handleRowDoubleClick}
                      onToggleExpand={onToggleExpand}
                      row={row}
                      showCheckbox={rowShowsCheckbox}
                      totalRowCount={totalRowCount}
                      virtualIndex={row.index}
                    />
                  );
                })}

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
