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
import { ColumnResizeHandle, cn, useResizeObserver } from '@brainstrike/ui';
import { type RefObject, useCallback, useState } from 'react';
import {
  EXPLORER_METADATA_COLUMN_CONFIGS,
  EXPLORER_METADATA_HEADER_CLASS,
  EXPLORER_NAME_HEADER_CLASS,
  getExplorerColumnResizeBounds,
} from '../tree/file-tree-columns';

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
  /** The forest sections scroller whose gutter this header must clear. */
  scrollerRef: RefObject<HTMLElement | null>;
  visibleMetadataColumnIds: readonly ExplorerMetadataColumnId[];
}

export function ExplorerColumnHeader({
  scrollerRef,
  visibleMetadataColumnIds,
}: ExplorerColumnHeaderProps) {
  const sizes = useExplorerColumnSizesStore((state: TreeTableColumnSizesStoreState) => state.sizes);
  const setColumn = useExplorerColumnSizesStore(
    (state: TreeTableColumnSizesStoreState) => state.setColumn
  );
  const gutterWidth = useScrollbarGutterWidth(scrollerRef);

  if (visibleMetadataColumnIds.length === 0) {
    // Name-only: a header row that says nothing the tree does not already say
    // is pure vertical cost in the app's narrowest panel.
    return null;
  }

  const visible = new Set(visibleMetadataColumnIds);
  const columns = EXPLORER_METADATA_COLUMN_CONFIGS.filter((config) =>
    visible.has(config.id as ExplorerMetadataColumnId)
  );

  return (
    <div
      className="shrink-0 border-b bg-panel-surface"
      data-testid="explorer-column-header"
      style={{ paddingRight: gutterWidth }}
    >
      <table aria-label="Explorer columns" className="w-full table-fixed caption-bottom text-sm">
        <colgroup>
          {/* No width: table-fixed hands Name the remainder, exactly as in the
              section tables' colgroup. */}
          <col />
          {columns.map((config) => (
            <col key={config.id} style={{ width: `${sizes[config.id] as number | undefined}px` }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th className={cn('text-left text-muted-foreground', EXPLORER_NAME_HEADER_CLASS)}>
              Name
            </th>
            {columns.map((config) => {
              const columnId = config.id as ExplorerMetadataColumnId;
              const width = sizes[columnId];
              return (
                <th
                  className={cn(
                    'relative text-left text-muted-foreground',
                    EXPLORER_METADATA_HEADER_CLASS
                  )}
                  data-column-id={columnId}
                  key={columnId}
                  style={{ width }}
                >
                  <div
                    className={cn(
                      'flex items-center gap-1',
                      config.align === 'right' && 'justify-end'
                    )}
                  >
                    {config.label}
                  </div>
                  {width === undefined ? null : (
                    <ColumnResizeHandle
                      bounds={getExplorerColumnResizeBounds(columnId)}
                      columnId={columnId}
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
