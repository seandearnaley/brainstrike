import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  useResizeObserver,
} from '@brainstrike/ui';
import { flexRender, type Table as ReactTableInstance, type Row } from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronDown } from 'lucide-react';
import { useCallback, useEffect, useRef } from 'react';
import { LogRow } from './log-row';
import type { LogTableFeatures } from './log-table-features';
import type { LogRecordRow } from './log-utils';

interface LogListProps {
  autoScroll: boolean;
  autoScrollAnchor: 'start' | 'end';
  emptyStateText?: string;
  logsLoading: boolean;
  rows: Row<LogTableFeatures, LogRecordRow>[];
  table: ReactTableInstance<LogTableFeatures, LogRecordRow>;
  wrapLines: boolean;
}

const DEFAULT_EMPTY_STATE_TEXT = 'No logs recorded for the current session.';

export function LogList({
  table,
  rows,
  logsLoading,
  autoScroll,
  autoScrollAnchor,
  wrapLines,
  emptyStateText = DEFAULT_EMPTY_STATE_TEXT,
}: LogListProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    estimateSize: () => 40, // Reduced estimate for tighter packing
    getScrollElement: () => parentRef.current,
    overscan: 20, // Increased overscan for smoother scrolling
    // Avoid react-virtual calling ReactDOM.flushSync during layout updates.
    useFlushSync: false,
  });

  // ResizeObserver to handle dynamic container sizing and fix "dead space" bug
  // Uses RAF debouncing to prevent "ResizeObserver loop completed with undelivered notifications" errors
  // Explicitly tells the virtualizer to remeasure when container size changes
  useResizeObserver(parentRef, () => {
    rowVirtualizer.measure();
  });

  const virtualRows = rowVirtualizer.getVirtualItems();
  const totalSize = rowVirtualizer.getTotalSize();
  const paddingTop = virtualRows.length > 0 ? virtualRows[0]?.start || 0 : 0;
  const paddingBottom = virtualRows.length > 0 ? totalSize - (virtualRows.at(-1)?.end || 0) : 0;

  // Auto-scroll logic
  useEffect(() => {
    if (!autoScroll || rows.length === 0) {
      return;
    }

    const targetIndex = autoScrollAnchor === 'start' ? 0 : rows.length - 1;
    // Use setTimeout to ensure render cycle is complete before scrolling
    const timeoutId = setTimeout(() => {
      try {
        rowVirtualizer.scrollToIndex(targetIndex, {
          align: autoScrollAnchor,
          behavior: 'auto',
        });
      } catch {
        // Ignore scroll errors during rapid updates
      }
    }, 0);

    return () => clearTimeout(timeoutId);
  }, [autoScroll, autoScrollAnchor, rows.length, rowVirtualizer]);

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
      className="w-full flex-1 overflow-auto bg-muted/5"
      data-testid="log-list-scroll-container"
      ref={parentRef}
      style={{ height: '100%', minHeight: '300px' }} // Ensure it takes full height of container
    >
      {logsLoading && rows.length === 0 ? (
        <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
          <div className="flex flex-col items-center gap-2">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            Loading logs...
          </div>
        </div>
      ) : rows.length === 0 ? (
        <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
          {emptyStateText}
        </div>
      ) : (
        <table className="w-full min-w-[800px] table-fixed border-collapse text-sm">
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
          <TableHeader className="sticky top-0 z-10 bg-background shadow-sm">
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow
                className="border-border/60 border-b hover:bg-transparent"
                key={headerGroup.id}
              >
                {headerGroup.headers.map((header) => (
                  <TableHead
                    className="h-9 truncate py-2 font-semibold text-foreground/80"
                    key={header.id}
                  >
                    {header.isPlaceholder ? null : header.column.getCanSort() ? (
                      <button
                        className="flex w-full items-center justify-between gap-2 text-left text-xs uppercase tracking-wider transition-colors hover:text-primary"
                        onClick={header.column.getToggleSortingHandler()}
                        type="button"
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
              if (!row) {
                return null;
              }
              return (
                <LogRow
                  key={row.id}
                  measureRow={measureRow}
                  row={row}
                  virtualRow={virtualRow}
                  wrapLines={wrapLines}
                />
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
