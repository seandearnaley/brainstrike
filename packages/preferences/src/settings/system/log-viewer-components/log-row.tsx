import { TableCell, TableRow } from '@brainstrike/ui';
import { flexRender, type Row } from '@tanstack/react-table';
import type { VirtualItem } from '@tanstack/react-virtual';
import { memo } from 'react';
import type { LogRecordRow } from './log-utils';

type LogRowProps = {
  row: Row<LogRecordRow>;
  virtualRow: VirtualItem;
  measureRow: (node: HTMLTableRowElement | null) => void;
};

export const LogRow = memo(function LogRow({ row, virtualRow, measureRow }: LogRowProps) {
  return (
    <TableRow
      className="group align-top transition-colors duration-200 hover:bg-muted/40"
      data-index={virtualRow.index}
      ref={measureRow}
      style={{ height: `${virtualRow.size}px` }}
    >
      {row.getVisibleCells().map((cell) => (
        <TableCell className="px-3 py-2 align-top first:pl-4 last:pr-4" key={cell.id}>
          {flexRender(cell.column.columnDef.cell, cell.getContext())}
        </TableCell>
      ))}
    </TableRow>
  );
});
