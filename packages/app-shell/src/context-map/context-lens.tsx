import { formatTokenCount } from '@brainstrike/tokenization';
import { memo, type ReactElement } from 'react';
import { ChunkStrip } from './chunk-strip';
import { FRESHNESS_LABEL, KIND_COLOR_CLASS, KIND_LABEL, STATE_LABEL } from './context-map-kinds';
import type { ChunkCell, ContextFileRow, ContextFileSpan } from './context-map-model';
import type { SpanFreshness } from './span-freshness';
import type { RowFreshness } from './use-row-freshness';

function tokens(value: number | null): string {
  return value === null ? 'not recorded' : `~${formatTokenCount(value)}`;
}

function linesLabel(span: ContextFileRow['spans'][number]['span']): string {
  if (span.startLine !== undefined) {
    return `L${span.startLine}–${span.endLine}`;
  }
  return span.wholeFile ? 'whole file' : 'chunk';
}

const FILE_STATUS_LABEL: Readonly<Record<RowFreshness['status'], string>> = {
  checked: 'Compared with the current file',
  checking: 'Reading the current file…',
  unavailable: 'Current file unavailable: changes are unknown',
};

/** One file: its strip, and every call that delivered part of it, in turn order. */
export const ContextLens = memo(function ContextLens({
  cells,
  folderLabel,
  freshness,
  row,
}: {
  readonly cells: readonly ChunkCell[];
  readonly folderLabel: string;
  readonly freshness?: RowFreshness | undefined;
  readonly row: ContextFileRow;
}): ReactElement {
  const freshnessBySpan = new Map<ContextFileSpan, SpanFreshness>();
  if (freshness?.status === 'checked') {
    row.spans.forEach((entry, index) => {
      freshnessBySpan.set(entry, freshness.bySpan[index] ?? 'unknown');
    });
  }
  const spans = [...row.spans].sort(
    (a, b) => a.at.turn - b.at.turn || (a.span.startLine ?? 0) - (b.span.startLine ?? 0)
  );
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="context-map-lens">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="break-all font-medium font-mono text-sm">{row.path}</span>
        <span className="text-muted-foreground text-xs">
          {folderLabel} · in window {tokens(row.windowTokens)} · delivered{' '}
          {tokens(row.deliveredTokens)}
        </span>
        {freshness && (
          <span className="text-muted-foreground text-xs" data-testid="context-map-lens-freshness">
            {FILE_STATUS_LABEL[freshness.status]}
          </span>
        )}
      </div>
      <ChunkStrip cells={cells} label={`${row.path}: delivered chunks`} />
      <table className="w-full table-fixed border-collapse text-xs">
        <caption className="sr-only">Calls that delivered this file</caption>
        <thead>
          <tr className="text-left text-muted-foreground">
            <th className="w-10 py-1 font-normal" scope="col">
              Turn
            </th>
            <th className="py-1 font-normal" scope="col">
              Delivered
            </th>
            <th className="w-20 py-1 text-right font-normal" scope="col">
              Tokens
            </th>
          </tr>
        </thead>
        <tbody>
          {spans.map((entry) => {
            const { at, span, deliveredTokens } = entry;
            const fresh = freshnessBySpan.get(entry);
            return (
              <tr
                className="border-border/60 border-t align-top"
                data-freshness={fresh ?? 'unknown'}
                key={`${at.call.toolCallId}:${span.startLine ?? 'all'}:${span.chunkId ?? ''}`}
              >
                <td className="py-1.5 font-mono text-muted-foreground">T{at.turn}</td>
                <td className="min-w-0 py-1.5">
                  <span className="flex items-center gap-1.5">
                    <span
                      aria-hidden="true"
                      className={`h-2 w-2 shrink-0 rounded-[2px] bg-current ${KIND_COLOR_CLASS[span.kind]}`}
                    />
                    {KIND_LABEL[span.kind]} {linesLabel(span)}
                    {span.partial ? ' (part)' : ''}
                    {span.repeat ? ' (unchanged repeat)' : ''}
                  </span>
                  <span className="block truncate font-mono text-[11px] text-muted-foreground">
                    {at.call.toolName} · {STATE_LABEL[at.state]}
                    {fresh && fresh !== 'unknown' ? ` · ${FRESHNESS_LABEL[fresh]}` : ''}
                  </span>
                </td>
                <td className="py-1.5 text-right tabular-nums">{tokens(deliveredTokens)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
});
