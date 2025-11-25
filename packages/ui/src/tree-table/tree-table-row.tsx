/**
 * TreeTableRow Component
 *
 * Renders a single row in the TreeTable with indentation, expansion toggle,
 * and support for selection/highlighting states.
 */

import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import * as React from 'react';
import { Button } from '../button';
import { cn } from '../lib/utils';
import { TableCell, TableRow } from '../table';
import type { FlattenedRow, TreeTableColumn, TreeTableRowProps } from './types';

/**
 * Default indentation width per depth level in pixels.
 */
const INDENT_WIDTH = 20;

/**
 * TreeTableRow renders a single row with:
 * - Indentation based on depth
 * - Expand/collapse toggle for nodes with children
 * - Loading indicator when children are being loaded
 * - Visual states for selection and highlighting
 */
function TreeTableRowInner<T>(
  {
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
  }: TreeTableRowProps<T>,
  ref: React.Ref<HTMLTableRowElement>
) {
  const { node, isSelected, isHighlighted, matchesFilter } = row;

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

  // Combine external ref with measure ref
  const combinedRef = React.useCallback(
    (element: HTMLTableRowElement | null) => {
      // Call measure ref for virtualization
      measureRef?.(element);

      // Forward ref
      if (typeof ref === 'function') {
        ref(element);
      } else if (ref) {
        (ref as React.MutableRefObject<HTMLTableRowElement | null>).current = element;
      }
    },
    [ref, measureRef]
  );

  return (
    <TableRow
      ref={combinedRef}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
      style={style}
      className={cn(
        'cursor-pointer transition-colors',
        isSelected && 'bg-accent',
        isHighlighted && !isSelected && 'bg-yellow-50 dark:bg-yellow-950/20',
        isFocused && 'ring-2 ring-inset ring-primary',
        !matchesFilter && 'opacity-50',
        className
      )}
      data-node-id={node.id}
      data-node-type={node.type}
      data-depth={node.depth}
      data-selected={isSelected}
      data-highlighted={isHighlighted}
      data-focused={isFocused}
      aria-selected={isSelected}
      tabIndex={isFocused ? 0 : -1}
    >
      {columns.map((column, columnIndex) => (
        <TreeTableCell
          key={column.id}
          row={row}
          column={column}
          columnIndex={columnIndex}
          onExpandClick={handleExpandClick}
        />
      ))}
    </TableRow>
  );
}

/**
 * TreeTableCell renders a single cell, with special handling for the first column
 * which includes indentation and the expand/collapse toggle.
 */
interface TreeTableCellProps<T> {
  row: FlattenedRow<T>;
  column: TreeTableColumn<T>;
  columnIndex: number;
  onExpandClick: (event: React.MouseEvent) => void;
}

function TreeTableCell<T>({ row, column, columnIndex, onExpandClick }: TreeTableCellProps<T>) {
  const { node, isExpanded, isSelected, isHighlighted, index } = row;
  const isFirstColumn = columnIndex === 0;

  // Render cell content using the column's cell renderer
  const cellContent = column.cell({
    node,
    depth: node.depth,
    isExpanded,
    isSelected,
    isHighlighted,
    rowIndex: index,
  });

  // For the first column, add indentation and expand toggle
  if (isFirstColumn) {
    return (
      <TableCell className={cn('p-0', column.className)}>
        <div className="flex items-center">
          {/* Indentation spacer */}
          <span style={{ width: node.depth * INDENT_WIDTH }} className="flex-shrink-0" />

          {/* Expand/Collapse toggle or spacer */}
          {node.hasChildren ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={onExpandClick}
              className="h-6 w-6 p-0 flex-shrink-0"
              aria-label={isExpanded ? 'Collapse' : 'Expand'}
              aria-expanded={isExpanded}
            >
              {node.isLoading ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : isExpanded ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
            </Button>
          ) : (
            // Spacer to align leaf nodes with expandable nodes
            <span className="h-6 w-6 flex-shrink-0" />
          )}

          {/* Cell content */}
          <div className="flex-1 min-w-0 px-2">{cellContent}</div>
        </div>
      </TableCell>
    );
  }

  // Regular cell for non-first columns
  return <TableCell className={cn('px-2', column.className)}>{cellContent}</TableCell>;
}

/**
 * Memoized TreeTableRow to prevent unnecessary re-renders.
 * Only re-renders when the row's visual state changes.
 */
export const TreeTableRow = React.memo(React.forwardRef(TreeTableRowInner)) as <T>(
  props: TreeTableRowProps<T> & { ref?: React.Ref<HTMLTableRowElement> }
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
  collection: 48,
  file: 44,
  chunk: 60,
  vector: 80,
  default: 40,
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
