/**
 * Panel-level column header for FOREST mode (BST-1208).
 *
 * A forest renders N section TreeTables inside ONE scroller. A sticky header
 * per section would stack N headers against the same scrollport, so the
 * sanctioned shape is a single header rendered ABOVE the shared scroller
 * (docs/agents/ui-conventions.md, TreeGrid contract). Single-root mode does not
 * use this: it owns its viewport and uses TreeTable's own sticky header.
 *
 * ALIGNMENT is the whole job, and it rests on three things:
 *
 * 1. The same `<table class="table-fixed">` + `<colgroup>` layout algorithm the
 *    section tables use, so identical column widths produce identical columns.
 * 2. The same width source — `explorer-column-sizes-store` — read by both.
 * 3. Subtracting the scroller's scrollbar gutter. The header sits OUTSIDE the
 *    scroller, so on a platform with classic (space-consuming) scrollbars it
 *    would otherwise be exactly one scrollbar wider than the tables inside, and
 *    every metadata column would sit that far right of its cells. Overlay
 *    scrollbars measure 0 and the compensation is a no-op.
 *
 * The Name column carries no width in either place: `table-fixed` gives it
 * whatever the metadata columns leave, on both sides of the boundary.
 */

import {
  type TreeTableColumnSizesStoreState,
  useExplorerColumnSizesStore,
} from '@brainstrike/app-state/stores/explorer-column-sizes-store';
import type { ExplorerMetadataColumnId } from '@brainstrike/app-state/stores/explorer-column-visibility-store';
import {
  isExplorerMetadataSortField,
  isExplorerSortField,
} from '@brainstrike/app-state/stores/explorer-sort-state-store';
import {
  ColumnResizeHandle,
  cn,
  getNextTreeTableSortDirection,
  getTreeTableAriaSortValue,
  getTreeTableSortButtonLabel,
  useResizeObserver,
} from '@brainstrike/ui';
import { type RefObject, useCallback, useState } from 'react';
import { useOptionalFileRowMetadata } from '../indexing/file-row-metadata-context';
import {
  EXPLORER_METADATA_COLUMN_CONFIGS,
  EXPLORER_METADATA_HEADER_CLASS,
  EXPLORER_NAME_HEADER_CLASS,
  getExplorerColumnResizeBounds,
} from '../tree/file-tree-columns';
import { useOptionalExplorerSort } from './explorer-sort-context';

/**
 * Width the scroller's vertical scrollbar takes from its content box. 0 on
 * overlay-scrollbar platforms; ~15px with classic scrollbars.
 */
function useScrollbarGutterWidth(scrollerRef: RefObject<HTMLElement | null>): number {
  const [gutterWidth, setGutterWidth] = useState(0);

  // A scrollbar appearing shrinks the scroller's CONTENT box while its border
  // box is unchanged, which is exactly what a contentRect observer reports —
  // so content growth is covered without polling layout every render.
  useResizeObserver(
    scrollerRef,
    useCallback(() => {
      const scroller = scrollerRef.current;
      if (!scroller) {
        return;
      }
      const nextGutter = Math.max(0, scroller.offsetWidth - scroller.clientWidth);
      setGutterWidth((previous) => (Math.abs(previous - nextGutter) < 1 ? previous : nextGutter));
    }, [scrollerRef])
  );

  return gutterWidth;
}

export interface ExplorerColumnHeaderProps {
  /**
   * RENDER widths from `useExplorerColumns` — already shrunk to fit the panel.
   * Reading the raw store here instead would let the header and the section
   * tables disagree the moment the persisted widths outgrew the panel.
   */
  columnWidths: Record<string, number>;
  /** The forest sections scroller whose gutter this header must clear. */
  scrollerRef: RefObject<HTMLElement | null>;
  visibleMetadataColumnIds: readonly ExplorerMetadataColumnId[];
}

export function ExplorerColumnHeader({
  columnWidths,
  scrollerRef,
  visibleMetadataColumnIds,
}: ExplorerColumnHeaderProps) {
  const setColumn = useExplorerColumnSizesStore(
    (state: TreeTableColumnSizesStoreState) => state.setColumn
  );
  const gutterWidth = useScrollbarGutterWidth(scrollerRef);
  const explorerSort = useOptionalExplorerSort();
  // Capability gating (docs/agents/ui-conventions.md): Type/Tokens/Size can
  // only be ordered where the metadata seam is mounted, so a surface without it
  // does not OFFER those sorts at all rather than offering one that throws.
  // Name never needs the seam.
  const canSortByMetadata = useOptionalFileRowMetadata() !== null;
  const treeTableSortState = explorerSort?.sortState
    ? {
        columnId: explorerSort.sortState.field,
        direction: explorerSort.sortState.direction,
      }
    : { columnId: null, direction: null };
  const handleSort = useCallback(
    (columnId: string): void => {
      if (!explorerSort) {
        return;
      }
      if (!isExplorerSortField(columnId)) {
        throw new Error(`Unsupported Explorer sort column: ${columnId}`);
      }
      if (isExplorerMetadataSortField(columnId) && !canSortByMetadata) {
        throw new Error(
          `Explorer sort column "${columnId}" was activated without the file-row metadata seam`
        );
      }
      const currentDirection =
        treeTableSortState.columnId === columnId ? treeTableSortState.direction : null;
      const direction = getNextTreeTableSortDirection(currentDirection);
      explorerSort.setSortState(direction === null ? null : { direction, field: columnId });
    },
    [canSortByMetadata, explorerSort, treeTableSortState.columnId, treeTableSortState.direction]
  );

  const visible = new Set(visibleMetadataColumnIds);
  const columns = EXPLORER_METADATA_COLUMN_CONFIGS.filter((config) => visible.has(config.id));

  return (
    <div
      className="shrink-0 border-b bg-panel-surface"
      data-testid="explorer-column-header"
      style={{ paddingRight: gutterWidth }}
    >
      {/*
        a11y: role="presentation" strips the TABLE semantics, because this
        header belongs to N sibling treegrids and ARIA has no way to associate
        one header with several grids — announcing a stray one-row table is
        worse than announcing nothing.

        Consequence, and the reason `aria-sort` below is markup only: on a
        presentational `th` `aria-sort` is INERT — nothing announces it. The
        sort state reaches assistive tech through each sort button's
        `aria-label` ("Tokens: sorted descending; restore default order"),
        which is a real control in a real accessibility tree. The attribute
        stays because the tests assert the markup contract shared with
        TreeTable's own header, where it is NOT inert.

        NON-interactive labels are aria-hidden: they are decoration next to
        cells that already self-describe (each metadata cell's sr-only text
        carries the column's meaning, e.g. "1,234 tokens"). Sort buttons and
        resize handles deliberately stay in the accessibility tree — never bury
        a focusable control under aria-hidden.
      */}
      <table className="w-full table-fixed caption-bottom text-sm" role="presentation">
        <colgroup>
          {/* No width: table-fixed hands Name the remainder, exactly as in the
              section tables' colgroup. */}
          <col />
          {columns.map((config) => {
            const width = columnWidths[config.id];
            return (
              <col
                key={config.id}
                style={width === undefined ? undefined : { width: `${width}px` }}
              />
            );
          })}
        </colgroup>
        <thead>
          <tr>
            <th
              aria-sort={getTreeTableAriaSortValue('name', treeTableSortState)}
              className={cn('text-left text-muted-foreground', EXPLORER_NAME_HEADER_CLASS)}
              data-column-id="name"
            >
              <button
                aria-label={getTreeTableSortButtonLabel('Name', 'name', treeTableSortState)}
                className="flex h-full w-full cursor-pointer items-center gap-1 text-left"
                onClick={() => handleSort('name')}
                type="button"
              >
                Name
                {treeTableSortState.columnId === 'name' ? (
                  <span aria-hidden="true">
                    {treeTableSortState.direction === 'asc' ? '↑' : '↓'}
                  </span>
                ) : null}
              </button>
            </th>
            {columns.map((config) => {
              const width = columnWidths[config.id];
              // "This thread" has no order to sort by; it keeps a plain label.
              const sortable = canSortByMetadata && isExplorerSortField(config.id);
              return (
                <th
                  {...(sortable
                    ? { 'aria-sort': getTreeTableAriaSortValue(config.id, treeTableSortState) }
                    : {})}
                  className={cn(
                    'relative text-left text-muted-foreground',
                    EXPLORER_METADATA_HEADER_CLASS
                  )}
                  data-column-id={config.id}
                  key={config.id}
                  style={{ width }}
                >
                  {sortable ? (
                    <button
                      aria-label={getTreeTableSortButtonLabel(
                        config.label,
                        config.id,
                        treeTableSortState
                      )}
                      className={cn(
                        'flex h-full w-full cursor-pointer items-center gap-1',
                        config.align === 'right' && 'justify-end'
                      )}
                      onClick={() => handleSort(config.id)}
                      type="button"
                    >
                      {config.label}
                      {treeTableSortState.columnId === config.id ? (
                        <span aria-hidden="true">
                          {treeTableSortState.direction === 'asc' ? '↑' : '↓'}
                        </span>
                      ) : null}
                    </button>
                  ) : (
                    <span
                      // Non-interactive: decoration beside cells that already
                      // self-describe. See the a11y note above.
                      aria-hidden="true"
                      className={cn(
                        'flex h-full w-full items-center gap-1',
                        config.align === 'right' && 'justify-end'
                      )}
                    >
                      {config.label}
                    </span>
                  )}
                  {width === undefined ? null : (
                    <ColumnResizeHandle
                      bounds={getExplorerColumnResizeBounds(config.id)}
                      columnId={config.id}
                      columnLabel={config.label}
                      currentWidth={width}
                      onResize={setColumn}
                    />
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
      </table>
    </div>
  );
}
