import type { Table } from '@tanstack/react-table';
import { flexRender } from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { memo, useRef, useMemo } from 'react';
import { cn } from './lib/utils';

interface VirtualizedDataTableProps<TData> {
  table: Table<TData>;
  className?: string;
  estimateRowHeight?: number;
  overscan?: number;
  onRowClick?: (row: TData) => void;
}


export const VirtualizedDataTable = memo(function VirtualizedDataTable<TData>({
  table,
  className,
  estimateRowHeight = 52,
  overscan = 10,
  onRowClick,
}: VirtualizedDataTableProps<TData>) {
  const tableContainerRef = useRef<HTMLDivElement>(null);

  const { rows } = table.getRowModel();

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => tableContainerRef.current,
    estimateSize: () => estimateRowHeight,
    overscan,
  });

  const virtualRows = rowVirtualizer.getVirtualItems();
  const totalSize = rowVirtualizer.getTotalSize();

  const paddingTop = virtualRows.length > 0 ? virtualRows[0]?.start || 0 : 0;
  const paddingBottom =
    virtualRows.length > 0 ? totalSize - (virtualRows[virtualRows.length - 1]?.end || 0) : 0;

  // Memoize header calculations
  const headers = useMemo(() => {
    const headerGroups = table.getHeaderGroups();
    const headerGroup = headerGroups[0];
    return headerGroup?.headers || [];
  }, [table]);

  return (
    <div className={cn('h-full w-full', className)}>
      <div ref={tableContainerRef} className="h-full overflow-auto">
        <table className="w-full" style={{ tableLayout: 'fixed' }}>
          {/* Sticky Header */}
          <thead className="sticky top-0 z-10 bg-background border-b">
            <tr>
              {headers.map((header) => (
                <th
                  key={header.id}
                  className={`h-12 px-4 text-left align-middle font-medium text-muted-foreground relative border-b ${
                    header.id === 'select' ? 'pr-0' : ''
                  }`}
                  style={{
                    width: `${header.getSize()}px`,
                  }}
                >
                  {header.isPlaceholder
                    ? null
                    : flexRender(header.column.columnDef.header, header.getContext())}
                  {header.column.getCanResize() && (
                    <div
                      onMouseDown={header.getResizeHandler()}
                      onTouchStart={header.getResizeHandler()}
                      onDoubleClick={() => header.column.resetSize()}
                      className={cn(
                        'absolute right-0 top-0 h-full w-1 cursor-col-resize select-none touch-none bg-border hover:bg-primary/50',
                        header.column.getIsResizing() && 'bg-primary'
                      )}
                    />
                  )}
                </th>
              ))}
            </tr>
          </thead>

          {/* Virtualized Body */}
          <tbody style={{ position: 'relative', height: `${totalSize}px` }}>
            {paddingTop > 0 && (
              <tr style={{ height: paddingTop }}>
                <td colSpan={headers.length} />
              </tr>
            )}

            {virtualRows.map((virtualRow) => {
              const row = rows[virtualRow.index];
              if (!row) return null;

              return (
                <tr
                  key={row.id}
                  data-state={row.getIsSelected() && 'selected'}
                  className={cn(
                    'border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted',
                    onRowClick && 'cursor-pointer'
                  )}
                  onClick={() => onRowClick?.(row.original)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onRowClick?.(row.original);
                    }
                  }}
                  tabIndex={onRowClick ? 0 : undefined}
                  style={{
                    height: `${virtualRow.size}px`,
                    transform: `translateY(${virtualRow.start - paddingTop}px)`,
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                  }}
                >
                  {row.getVisibleCells().map((cell, cellIndex) => {
                    const header = headers[cellIndex];
                    return (
                      <td
                        key={cell.id}
                        className={`p-4 align-middle ${
                          cell.column.id === 'select' ? 'pr-0' : ''
                        }`}
                        style={{
                          width: `${header?.getSize()}px`,
                        }}
                      >
                        <div className="truncate">
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              );
            })}

            {paddingBottom > 0 && (
              <tr style={{ height: paddingBottom }}>
                <td colSpan={headers.length} />
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}) as <TData>(props: VirtualizedDataTableProps<TData>) => React.JSX.Element;
