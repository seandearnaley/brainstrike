import type { CompactionSummaryPayload } from '@brainstrike/assistant-contract/compaction-summary';
import { ArchiveRestore } from 'lucide-react';
import type { ReactNode } from 'react';

export interface CompactionSummaryCardProps {
  readonly children: ReactNode;
  /** Bookkeeping copy; the durable message body remains the display authority. */
  readonly droppedSummaryLine?: string;
  readonly fallbackKind: CompactionSummaryPayload['fallbackKind'];
}

/**
 * Full-width system treatment for the durable assistant message that replaces
 * older provider context. Its children are the message's real content parts,
 * so the summary stays selectable, copyable, and model-visible instead of
 * being replaced by metadata-derived display text.
 */
export function CompactionSummaryCard(props: CompactionSummaryCardProps) {
  const { children, fallbackKind } = props;
  const kindLabel =
    fallbackKind === 'deterministic'
      ? 'Deterministic compaction (no summarization model ran)'
      : 'AI-generated summary';

  return (
    <section
      aria-label="Conversation compacted"
      className="w-full max-w-2xl text-muted-foreground"
      data-compaction-fallback={fallbackKind}
      data-testid="compaction-summary-card"
    >
      <div className="flex items-center gap-3">
        <span aria-hidden="true" className="flex-1 border-border border-t" />
        <span className="flex shrink-0 items-center gap-1.5 font-medium text-xs">
          <ArchiveRestore aria-hidden="true" className="size-3.5" />
          Conversation compacted
        </span>
        <span aria-hidden="true" className="flex-1 border-border border-t" />
      </div>

      <div className="mt-3 rounded-lg border border-border bg-muted/60 px-4 py-3">
        <p className="mb-2 font-medium text-foreground/80 text-xs">{kindLabel}</p>
        <div className="break-words text-sm leading-6">{children}</div>
      </div>
    </section>
  );
}

CompactionSummaryCard.displayName = 'CompactionSummaryCard';
