import { TableCell, TableRow } from '@brainstrike/ui';
import { flexRender, type Row } from '@tanstack/react-table';
import type { VirtualItem } from '@tanstack/react-virtual';
import { memo } from 'react';
import type { LogRecordRow } from './log-utils';

interface LogRowProps {
  row: Row<LogRecordRow>;
  virtualRow: VirtualItem;
  measureRow: (node: HTMLTableRowElement | null) => void;
}

export const LogRow = memo(function LogRow({ row, virtualRow, measureRow }: LogRowProps) {
  return (
    <TableRow
      data-index={virtualRow.index}
      ref={measureRow}
      className="align-top hover:bg-muted/40 transition-colors duration-200 group"
      style={{ height: `${virtualRow.size}px` }}
    >
      {row.getVisibleCells().map((cell) => (
        <TableCell key={cell.id} className="align-top py-2 px-3 first:pl-4 last:pr-4">
          {flexRender(cell.column.columnDef.cell, cell.getContext())}
        </TableCell>
      ))}
    </TableRow>
  );
});
