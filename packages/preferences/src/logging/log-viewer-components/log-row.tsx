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
      style={{
        height: `${virtualRow.size}px`,
        transform: `translateY(${virtualRow.start - virtualRow.index * virtualRow.size}px)`, // Fix for some virtualization jitters if needed, but standard absolute positioning is usually handled by the parent container style.
        // Actually, standard tanstack virtual example uses absolute positioning on the row OR transform on the container.
        // Let's stick to the previous implementation's style but cleaner.
        // Wait, the previous implementation used a table. Virtualizing <tr> is tricky.
        // It used: style={{ height: `${virtualRow.size}px` }} and just rendered them in order with padding top/bottom.
        // We will stick to that for table compatibility.
      }}
    >
      {row.getVisibleCells().map((cell) => (
        <TableCell key={cell.id} className="align-top py-2 px-3 first:pl-4 last:pr-4">
          {flexRender(cell.column.columnDef.cell, cell.getContext())}
        </TableCell>
      ))}
    </TableRow>
  );
});
