import { cn } from '@brainstrike/ui';
import { memo, type ReactElement } from 'react';
import { GONE_FILL_CLASS, KIND_COLOR_CLASS, KIND_LABEL, STATE_LABEL } from './context-map-kinds';
import type { ChunkCell } from './context-map-model';

function cellTitle(cell: ChunkCell): string {
  const { chunk } = cell;
  const lines = `Lines ${chunk.startLine}–${chunk.endLine}`;
  if (cell.spans.length === 0) {
    return `${lines}: not delivered in this thread`;
  }
  const parts = cell.spans.map(
    ({ at, span }) =>
      `T${at.turn} ${KIND_LABEL[span.kind]}${span.partial ? ' (part)' : ''}, ${STATE_LABEL[at.state].toLowerCase()}`
  );
  return `${lines}: ${parts.join('; ')}`;
}

/** One file's index chunks as cells sized by line count and filled by delivered share. */
export const ChunkStrip = memo(function ChunkStrip({
  cells,
  label,
}: {
  readonly cells: readonly ChunkCell[];
  readonly label: string;
}): ReactElement {
  return (
    <div aria-label={label} className="flex h-4 min-w-0 gap-0.5" role="img">
      {cells.map((cell) => (
        <div
          className="relative flex min-w-[3px] items-end overflow-hidden rounded-[2px] bg-muted"
          data-kind={cell.kind ?? 'none'}
          data-state={cell.gone ? 'gone' : 'live'}
          key={cell.chunk.chunkId}
          style={{ flexGrow: cell.chunk.endLine - cell.chunk.startLine + 1 }}
          title={cellTitle(cell)}
        >
          {cell.kind && (
            <div
              className={cn(
                'w-full',
                KIND_COLOR_CLASS[cell.kind],
                cell.gone ? GONE_FILL_CLASS : 'bg-current'
              )}
              style={{ height: `${Math.max(28, Math.round(cell.coverage * 100))}%` }}
            />
          )}
        </div>
      ))}
    </div>
  );
});
