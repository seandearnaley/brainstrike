/**
 * TreeTableRow Component
 *
 * Renders a single row in the TreeTable with indentation, expansion toggle,
 * and support for selection/highlighting/context states.
 *
 * Follows WAI-ARIA treegrid pattern with proper aria-level, aria-setsize,
 * aria-posinset, aria-rowindex, and aria-expanded attributes.
 */

import { ChevronDown, ChevronRight, Layers, Loader2 } from 'lucide-react';
import * as React from 'react';
import { Button } from '../button';
import { Checkbox } from '../checkbox';
import { cn } from '../lib/utils';
import { TableCell, TableRow } from '../table';
import type { FlattenedRow, TreeNode, TreeTableColumn, TreeTableRowProps } from './types';

/**
 * Default indentation width per depth level in pixels.
 */
const INDENT_WIDTH = 20;

interface TreeTableGroupHeaderData {
  groupLabel: string;
  itemCount: number;
}

// Compile-time guard: fails here if TreeTableGroupHeaderData gains required fields.
const GROUP_HEADER_DATA_SHAPE = { groupLabel: '', itemCount: 0 } satisfies TreeTableGroupHeaderData;

/**
 * Props for the GroupHeaderCell component.
 */
interface GroupHeaderCellProps<T> {
  columns: TreeTableColumn<T>[];
  insetTreeControls: boolean;
  isExpanded: boolean;
  node: TreeNode<TreeTableGroupHeaderData>;
  onExpandClick: (event: React.MouseEvent) => void;
}

/**
 * GroupHeaderCell renders a single spanning cell for group header rows.
 * Displays an expand/collapse toggle, group icon, label, and item count.
 */
function GroupHeaderCell<T>({
  node,
  isExpanded,
  onExpandClick,
  columns,
  insetTreeControls,
}: GroupHeaderCellProps<T>) {
  return (
    <TableCell className="p-0" colSpan={columns.length} role="gridcell">
      <div className={cn('flex items-center', insetTreeControls && 'pl-1')}>
        {/* Indentation spacer */}
        <span className="flex-shrink-0" style={{ width: node.depth * INDENT_WIDTH }} />

        {/* Expand/Collapse toggle */}
        <Button
          aria-expanded={isExpanded}
          aria-label={isExpanded ? 'Collapse group' : 'Expand group'}
          className="flex-shrink-0"
          disabled={node.isLoading}
          onClick={onExpandClick}
          size="icon-xs"
          variant="ghost"
        >
          {node.isLoading ? (
            <Loader2 className="size-3 animate-spin" />
          ) : isExpanded ? (
            <ChevronDown className="size-3" />
          ) : (
            <ChevronRight className="size-3" />
          )}
        </Button>

        {/* Group icon */}
        <Layers className="ml-1.5 h-4 w-4 flex-shrink-0 text-muted-foreground" />

        {/* Group label and item count */}
        <span className="ml-1.5 font-semibold text-sm">{node.data.groupLabel}</span>
        <span className="ml-1 text-muted-foreground text-xs">({node.data.itemCount})</span>
      </div>
    </TableCell>
  );
}

/**
 * Type guard for runtime-safe group header rendering.
 */
function isGroupHeaderData(data: unknown): data is TreeTableGroupHeaderData {
  if (typeof data !== 'object' || data === null) {
    return false;
  }

  const record = data as Record<string, unknown>;
  const groupLabel = record['groupLabel'];
  const itemCount = record['itemCount'];

  if (
    typeof groupLabel !== typeof GROUP_HEADER_DATA_SHAPE.groupLabel ||
    typeof itemCount !== typeof GROUP_HEADER_DATA_SHAPE.itemCount
  ) {
    return false;
  }

  // Keep this runtime guard aligned with required fields on TreeTableGroupHeaderData.
  return true;
}

function isGroupHeaderNode(node: TreeNode<unknown>): node is TreeNode<TreeTableGroupHeaderData> {
  return node.type === 'group' && isGroupHeaderData(node.data);
}

/**
 * TreeTableRow renders a single row with:
 * - Indentation based on depth
 * - Expand/collapse toggle for nodes with children
 * - Loading indicator when children are being loaded
 * - Visual states for selection, highlighting, and context
 * - ARIA attributes for treegrid accessibility
 * - Optional checkbox for multi-select
 */
function TreeTableRowInner<T>({
  row,
  columns,
  onToggleExpand,
  onClick,
  onDoubleClick,
  onContextMenu,
  className,
  style,
  isFocused = false,
  measureRef,
  virtualIndex,
  showCheckbox = false,
  insetTreeControls = false,
  checkboxState,
  checkboxAriaLabel,
  onCheckboxChange,
  totalRowCount,
  ariaRole = 'treegrid',
}: TreeTableRowProps<T>) {
  const { node, isExpanded, isSelected, isHighlighted, isInContext, matchesFilter, aria, index } =
    row;
  const isTreegrid = ariaRole === 'treegrid';

  // Handle row click
  const handleClick = React.useCallback(
    (event: React.MouseEvent) => {
      onClick?.(node.id, event);
    },
    [node.id, onClick]
  );

  // Handle row double-click
  const handleDoubleClick = React.useCallback(() => {
    onDoubleClick?.(node.id);
  }, [node.id, onDoubleClick]);

  // Handle context menu
  const handleContextMenu = React.useCallback(
    (event: React.MouseEvent) => {
      onContextMenu?.(node.id, event);
    },
    [node.id, onContextMenu]
  );

  // Handle expand toggle click (stop propagation to prevent row selection)
  const handleExpandClick = React.useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      onToggleExpand(node.id);
    },
    [node.id, onToggleExpand]
  );

  // Handle checkbox click (stop propagation to prevent row selection)
  const handleCheckboxChange = React.useCallback(() => {
    onCheckboxChange?.(node.id);
  }, [node.id, onCheckboxChange]);

  const isGroupHeader = isGroupHeaderNode(node);

  // Determine which column gets tree indentation: the first column that doesn't
  // explicitly opt out via isTreeColumn: false.
  const treeColumnIndex = columns.findIndex((col) => col.isTreeColumn !== false);

  return (
    <TableRow
      aria-expanded={isTreegrid && node.hasChildren ? row.isExpanded : undefined}
      aria-level={isTreegrid ? aria.ariaLevel : undefined}
      aria-posinset={isTreegrid ? aria.ariaPosInSet : undefined}
      aria-rowindex={totalRowCount ? aria.ariaRowIndex : undefined}
      aria-selected={isSelected}
      aria-setsize={isTreegrid ? aria.ariaSetSize : undefined}
      className={cn(
        'cursor-pointer',
        isGroupHeader && 'bg-muted/50',
        isSelected && !isGroupHeader && 'bg-accent',
        isHighlighted && !isSelected && !isGroupHeader && 'bg-yellow-50 dark:bg-yellow-950/20',
        isInContext && !isSelected && !isHighlighted && 'border-l-2 border-l-primary/60',
        'outline-none focus-visible:outline-2 focus-visible:outline-foreground/50 focus-visible:outline-solid focus-visible:-outline-offset-2',
        !matchesFilter && 'opacity-50',
        className
      )}
      data-context={isInContext || undefined}
      data-depth={node.depth}
      data-focused={isFocused}
      data-highlighted={isHighlighted}
      data-index={virtualIndex}
      data-node-id={node.id}
      data-node-type={node.type}
      data-selected={isSelected}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      onDoubleClick={handleDoubleClick}
      ref={measureRef}
      style={style}
      tabIndex={isFocused ? 0 : -1}
    >
      {isGroupHeader ? (
        <GroupHeaderCell
          columns={columns}
          insetTreeControls={insetTreeControls}
          isExpanded={row.isExpanded}
          node={node}
          onExpandClick={handleExpandClick}
        />
      ) : (
        (() => {
          const renderedCells: React.ReactNode[] = [];
          let columnIndex = 0;

          while (columnIndex < columns.length) {
            const column = columns[columnIndex];
            if (!column) {
              break;
            }

            const cellProps = {
              depth: node.depth,
              isExpanded,
              isHighlighted,
              isInContext,
              isSelected,
              node,
              rowIndex: index,
            };
            const requestedColSpan = column.colSpan?.(cellProps) ?? 1;
            const colSpan = Number.isFinite(requestedColSpan)
              ? Math.max(1, Math.min(columns.length - columnIndex, Math.trunc(requestedColSpan)))
              : 1;

            renderedCells.push(
              <TreeTableCellComponent
                checkboxAriaLabel={checkboxAriaLabel}
                checkboxState={checkboxState ?? 'unchecked'}
                colSpan={colSpan}
                column={column}
                columnIndex={columnIndex}
                insetTreeControls={insetTreeControls}
                isTreeColumn={columnIndex === treeColumnIndex}
                key={column.id}
                onCheckboxChange={showCheckbox ? handleCheckboxChange : undefined}
                onExpandClick={handleExpandClick}
                row={row}
                showCheckbox={showCheckbox}
              />
            );

            columnIndex += colSpan;
          }

          return renderedCells;
        })()
      )}
    </TableRow>
  );
}

/**
 * TreeTableCell renders a single cell, with special handling for the first column
 * which includes indentation, checkbox, and the expand/collapse toggle.
 */
interface TreeTableCellInternalProps<T> {
  checkboxAriaLabel: string | undefined;
  checkboxState: 'checked' | 'unchecked' | 'indeterminate';
  colSpan: number;
  column: TreeTableColumn<T>;
  columnIndex: number;
  insetTreeControls: boolean;
  isTreeColumn: boolean;
  onCheckboxChange: (() => void) | undefined;
  onExpandClick: (event: React.MouseEvent) => void;
  row: FlattenedRow<T>;
  showCheckbox: boolean;
}

interface TreeExpandControlProps {
  isExpanded: boolean;
  isLoading: boolean | undefined;
  onExpandClick: (event: React.MouseEvent) => void;
  pinnedToTop: boolean;
}

function TreeExpandControl({
  isExpanded,
  isLoading,
  onExpandClick,
  pinnedToTop,
}: TreeExpandControlProps): React.ReactElement {
  return (
    <Button
      aria-expanded={isExpanded}
      aria-label={isExpanded ? 'Collapse' : 'Expand'}
      className={cn('flex-shrink-0', pinnedToTop && 'mt-1.5')}
      disabled={isLoading}
      onClick={onExpandClick}
      size="icon-xs"
      variant="ghost"
    >
      {isLoading ? (
        <Loader2 className="size-3 animate-spin" />
      ) : isExpanded ? (
        <ChevronDown className="size-3" />
      ) : (
        <ChevronRight className="size-3" />
      )}
    </Button>
  );
}

interface TreeCheckboxControlProps {
  ariaLabel: string;
  checkboxState: 'checked' | 'unchecked' | 'indeterminate';
  onCheckboxChange: (() => void) | undefined;
  pinnedToTop: boolean;
  reserveSpace: boolean;
  showCheckbox: boolean;
}

function TreeCheckboxControl({
  ariaLabel,
  checkboxState,
  onCheckboxChange,
  pinnedToTop,
  reserveSpace,
  showCheckbox,
}: TreeCheckboxControlProps): React.ReactElement | null {
  const className = cn('ml-1.5 h-4 w-4 flex-shrink-0', pinnedToTop && 'mt-3');
  if (showCheckbox) {
    return (
      <Checkbox
        aria-label={ariaLabel}
        checked={checkboxState === 'indeterminate' ? 'indeterminate' : checkboxState === 'checked'}
        className={className}
        data-state={checkboxState}
        onCheckedChange={() => onCheckboxChange?.()}
        onClick={(event) => event.stopPropagation()}
      />
    );
  }
  if (!reserveSpace) {
    return null;
  }
  return <span aria-hidden="true" className={className} data-testid="tree-checkbox-spacer" />;
}

function TreeTableCellComponent<T>({
  row,
  colSpan,
  column,
  columnIndex: _columnIndex,
  isTreeColumn,
  insetTreeControls,
  onExpandClick,
  showCheckbox,
  checkboxState,
  checkboxAriaLabel,
  onCheckboxChange,
}: TreeTableCellInternalProps<T>) {
  const { node, isExpanded, isSelected, isHighlighted, isInContext, index } = row;
  const isFirstColumn = isTreeColumn;

  // Render cell content using the column's cell renderer
  const cellContent = column.cell({
    depth: node.depth,
    isExpanded,
    isHighlighted,
    isInContext,
    isSelected,
    node,
    rowIndex: index,
  });

  // For the first column, add indentation, checkbox, and expand toggle
  if (isFirstColumn) {
    const shouldReserveToggleSpace = column.reserveToggleSpace !== false;
    const indentWidth = column.indentWidth ?? INDENT_WIDTH;
    const controlsPinnedToTop = column.treeControlsPosition === 'top';

    return (
      <TableCell className={cn('p-0', column.className)} colSpan={colSpan} role="gridcell">
        <div
          className={cn(
            'flex',
            controlsPinnedToTop ? 'items-start self-start' : 'items-center',
            insetTreeControls && 'pl-1'
          )}
          data-tree-controls-position={controlsPinnedToTop ? 'top' : 'center'}
        >
          {/* Indentation spacer */}
          <span className="flex-shrink-0" style={{ width: node.depth * indentWidth }} />

          {/* Expand/Collapse toggle or spacer */}
          {node.hasChildren ? (
            <TreeExpandControl
              isExpanded={isExpanded}
              isLoading={node.isLoading}
              onExpandClick={onExpandClick}
              pinnedToTop={controlsPinnedToTop}
            />
          ) : shouldReserveToggleSpace ? (
            <span className="h-7 w-7 flex-shrink-0" />
          ) : null}

          <TreeCheckboxControl
            ariaLabel={checkboxAriaLabel ?? `Select ${node.id}`}
            checkboxState={checkboxState}
            onCheckboxChange={onCheckboxChange}
            pinnedToTop={controlsPinnedToTop}
            reserveSpace={column.reserveCheckboxSpace === true}
            showCheckbox={showCheckbox}
          />

          {/* Context indicator dot */}
          {isInContext && (
            <span
              aria-label="In context"
              className="ml-1.5 h-2 w-2 flex-shrink-0 rounded-full bg-primary/70"
              role="img"
              title="In context"
            />
          )}

          {/* Cell content */}
          <div className="min-w-0 flex-1 pl-1.5">{cellContent}</div>
        </div>
      </TableCell>
    );
  }

  // Regular cell for non-first columns
  return (
    <TableCell className={cn('px-2', column.className)} colSpan={colSpan} role="gridcell">
      {cellContent}
    </TableCell>
  );
}

/**
 * Memoized TreeTableRow to prevent unnecessary re-renders.
 * Only re-renders when the row's visual state changes.
 */
export const TreeTableRow = React.memo(TreeTableRowInner) as <T>(
  props: TreeTableRowProps<T>
) => React.ReactElement;

/**
 * Type guard to check if a value is a TreeTableRowProps
 */
export function isTreeTableRowProps<T>(value: unknown): value is TreeTableRowProps<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'row' in value &&
    'columns' in value &&
    'onToggleExpand' in value
  );
}

/**
 * Default row height estimates by node type.
 * Can be customized via the rowHeight prop on TreeTable.
 */
export const DEFAULT_ROW_HEIGHTS: Record<string, number> = {
  chunk: 60,
  collection: 48,
  default: 40,
  file: 44,
  group: 40,
  vector: 80,
};

/**
 * Gets the estimated row height for a node.
 *
 * @param node - Tree node
 * @param customHeights - Optional custom height overrides
 * @returns Estimated row height in pixels
 */
export function getEstimatedRowHeight(
  node: { type: string },
  customHeights?: Record<string, number>
): number {
  const heights = customHeights ?? DEFAULT_ROW_HEIGHTS;
  return heights[node.type] ?? heights['default'] ?? 40;
}
