import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@brainstrike/ui';
import { flexRender, type Table as ReactTableInstance, type Row } from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronDown } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { LogRow } from './log-row';
import type { LogRecordRow } from './log-utils';

interface LogListProps {
  table: ReactTableInstance<LogRecordRow>;
  rows: Row<LogRecordRow>[];
  logsLoading: boolean;
  autoScroll: boolean;
}

export function LogList({ table, rows, logsLoading, autoScroll }: LogListProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [, setParentHeight] = useState(0);

  // ResizeObserver to handle dynamic container sizing and fix "dead space" bug
  useEffect(() => {
    if (!parentRef.current) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setParentHeight(entry.contentRect.height);
      }
    });
    observer.observe(parentRef.current);
    return () => observer.disconnect();
  }, []);

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 40, // Reduced estimate for tighter packing
    overscan: 20, // Increased overscan for smoother scrolling
  });

  const virtualRows = rowVirtualizer.getVirtualItems();
  const totalSize = rowVirtualizer.getTotalSize();
  const paddingTop = virtualRows.length > 0 ? virtualRows[0]?.start || 0 : 0;
  const paddingBottom =
    virtualRows.length > 0 ? totalSize - (virtualRows[virtualRows.length - 1]?.end || 0) : 0;

  // Auto-scroll logic
  useEffect(() => {
    if (!autoScroll || rows.length === 0) return;

    const lastIndex = rows.length - 1;
    // Use setTimeout to ensure render cycle is complete before scrolling
    const timeoutId = setTimeout(() => {
      try {
        rowVirtualizer.scrollToIndex(lastIndex, { align: 'end', behavior: 'auto' });
      } catch {
        // Ignore scroll errors during rapid updates
      }
    }, 0);

    return () => clearTimeout(timeoutId);
  }, [autoScroll, rows.length, rowVirtualizer]);

  const measureRow = useCallback(
    (node: HTMLTableRowElement | null) => {
      if (node) {
        rowVirtualizer.measureElement(node);
      }
    },
    [rowVirtualizer]
  );

  return (
    <div
      ref={parentRef}
      className="flex-1 w-full overflow-auto bg-muted/5"
      style={{ height: '100%', minHeight: '300px' }} // Ensure it takes full height of container
    >
      {logsLoading && rows.length === 0 ? (
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          <div className="flex flex-col items-center gap-2">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            Loading logs...
          </div>
        </div>
      ) : rows.length === 0 ? (
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          No logs recorded for the current session.
        </div>
      ) : (
        <table className="w-full min-w-[800px] table-fixed text-sm border-collapse">
          <colgroup>
            {table.getVisibleLeafColumns().map((column) => (
              <col
                key={column.id}
                style={{
                  width: column.getSize() ? `${column.getSize()}px` : undefined,
                }}
              />
            ))}
          </colgroup>
          <TableHeader className="sticky top-0 z-10 bg-background/95 backdrop-blur shadow-sm">
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow
                key={headerGroup.id}
                className="hover:bg-transparent border-b border-border/60"
              >
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id} className="h-9 py-2 font-semibold text-foreground/80">
                    {header.isPlaceholder ? null : header.column.getCanSort() ? (
                      <button
                        type="button"
                        className="flex w-full items-center justify-between gap-2 text-left text-xs uppercase tracking-wider hover:text-primary transition-colors"
                        onClick={header.column.getToggleSortingHandler()}
                      >
                        <span>
                          {flexRender(header.column.columnDef.header, header.getContext())}
                        </span>
                        {{
                          asc: '↑',
                          desc: '↓',
                        }[header.column.getIsSorted() as string] ?? (
                          <ChevronDown className="h-3 w-3 opacity-50" />
                        )}
                      </button>
                    ) : (
                      <div className="text-xs uppercase tracking-wider">
                        {flexRender(header.column.columnDef.header, header.getContext())}
                      </div>
                    )}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {paddingTop > 0 && (
              <TableRow>
                <TableCell
                  colSpan={table.getVisibleLeafColumns().length}
                  style={{ height: `${paddingTop}px`, padding: 0 }}
                />
              </TableRow>
            )}
            {virtualRows.map((virtualRow) => {
              const row = rows[virtualRow.index];
              if (!row) return null;
              return (
                <LogRow key={row.id} row={row} virtualRow={virtualRow} measureRow={measureRow} />
              );
            })}
            {paddingBottom > 0 && (
              <TableRow>
                <TableCell
                  colSpan={table.getVisibleLeafColumns().length}
                  style={{ height: `${paddingBottom}px`, padding: 0 }}
                />
              </TableRow>
            )}
          </TableBody>
        </table>
      )}
    </div>
  );
}
