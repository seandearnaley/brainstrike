import { TableCell, TableRow } from '@brainstrike/ui';
import { flexRender, type Row } from '@tanstack/react-table';
import type { VirtualItem } from '@tanstack/react-virtual';
import { memo } from 'react';
import type { LogTableFeatures } from './log-table-features';
import type { LogRecordRow } from './log-utils';

interface LogRowProps {
  measureRow: (node: HTMLTableRowElement | null) => void;
  row: Row<LogTableFeatures, LogRecordRow>;
  virtualRow: VirtualItem;
  wrapLines: boolean;
}

export const LogRow = memo(function LogRow({
  row,
  virtualRow,
  measureRow,
  wrapLines,
}: LogRowProps) {
  const cellClassName = wrapLines
    ? 'px-3 py-2 align-top min-w-0 break-words whitespace-normal overflow-hidden first:pl-4 last:pr-4'
    : 'px-3 py-2 align-top min-w-0 truncate whitespace-nowrap overflow-hidden first:pl-4 last:pr-4';

  return (
    <TableRow
      className="group align-top transition-colors duration-200 hover:bg-muted/40"
      data-index={virtualRow.index}
      ref={measureRow}
      style={{ height: `${virtualRow.size}px` }}
    >
      {row.getVisibleCells().map((cell) => (
        <TableCell className={cellClassName} key={cell.id}>
          {flexRender(cell.column.columnDef.cell, cell.getContext())}
        </TableCell>
      ))}
    </TableRow>
  );
});
