import {
  cn,
  getNextTreeTableSortDirection,
  getTreeTableAriaSortValue,
  getTreeTableSortButtonLabel,
  type SortState,
} from '@brainstrike/ui';
import type { RefObject } from 'react';
import type { CatalogColumnLayout } from './catalog-columns';
import type { CatalogSort, CatalogSortColumn } from './catalog-sections';
import { useScrollbarGutterWidth } from './use-scrollbar-gutter-width';

export interface CatalogColumnHeaderProps {
  readonly layout: readonly CatalogColumnLayout[];
  readonly onSortChange: (next: CatalogSort | null) => void;
  readonly scrollerRef: RefObject<HTMLElement | null>;
  readonly sort: CatalogSort | null;
}

const ALIGN_CLASS: Record<CatalogColumnLayout['align'], string> = {
  center: 'text-center',
  left: 'text-left',
  right: 'text-right',
};

/**
 * ONE header above the shared scroller: the catalog renders N provider
 * treegrids in one scroll owner, so N sticky table headers would stack
 * (Explorer forest precedent, docs/agents/ui-conventions.md → Explorer tree
 * GRID). `role="presentation"` because one header cannot be ARIA-associated
 * with N grids; the sort buttons stay real controls, and every cell describes
 * itself with sr-only text. It aligns by construction: the same `table-fixed` +
 * `<colgroup>` widths and the cell padding, minus the scroller's gutter.
 */
export function CatalogColumnHeader({
  layout,
  onSortChange,
  scrollerRef,
  sort,
}: CatalogColumnHeaderProps) {
  const gutterWidth = useScrollbarGutterWidth(scrollerRef);
  const sortState: SortState = {
    columnId: sort?.column ?? null,
    direction: sort?.direction ?? null,
  };

  const handleSort = (column: CatalogSortColumn): void => {
    const current = sort?.column === column ? sort.direction : null;
    const next = getNextTreeTableSortDirection(current);
    onSortChange(next === null ? null : { column, direction: next });
  };

  return (
    <div
      className="shrink-0 border-b bg-muted/30"
      data-testid="model-catalog-column-header"
      style={{ paddingRight: gutterWidth }}
    >
      <table className="w-full table-fixed" role="presentation">
        <colgroup>
          {layout.map((column) => (
            <col
              key={column.id}
              style={column.width === null ? undefined : { width: `${column.width}px` }}
            />
          ))}
        </colgroup>
        <thead>
          <tr>
            {layout.map((column) => {
              const sortColumn = column.sortColumn;
              return (
                <th
                  aria-sort={
                    sortColumn ? getTreeTableAriaSortValue(sortColumn, sortState) : undefined
                  }
                  className={cn(
                    'h-8 px-2 font-medium text-[11px] text-muted-foreground uppercase tracking-wide',
                    ALIGN_CLASS[column.align]
                  )}
                  data-column-id={column.id}
                  key={column.id}
                >
                  {sortColumn ? (
                    <button
                      aria-label={getTreeTableSortButtonLabel(column.name, sortColumn, sortState)}
                      className={cn(
                        'inline-flex h-full cursor-pointer items-center gap-1 uppercase tracking-wide',
                        column.align === 'right' && 'justify-end'
                      )}
                      onClick={() => handleSort(sortColumn)}
                      type="button"
                    >
                      {column.label}
                      {sortState.columnId === sortColumn && sortState.direction ? (
                        <span aria-hidden="true">{sortState.direction === 'asc' ? '↑' : '↓'}</span>
                      ) : null}
                    </button>
                  ) : (
                    <span aria-hidden="true" className="truncate">
                      {column.label}
                    </span>
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
