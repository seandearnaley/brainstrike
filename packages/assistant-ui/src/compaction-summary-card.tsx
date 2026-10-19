import type { CompactionSummaryPayload } from '@brainstrike/assistant-contract/compaction-summary';
import { ArchiveRestore } from 'lucide-react';
import type { ReactNode } from 'react';
import type { HostContextCompaction } from './compaction-summary-message';

/** A host compaction's committed facts beside its summary (BST-2201). */
export type CompactionSummaryDetails = Omit<HostContextCompaction, 'kind' | 'summary'>;

export interface CompactionSummaryCardProps {
  readonly children: ReactNode;
  /** The committed reason, turns, summarizer model and usage; absent on a legacy marker. */
  readonly details?: CompactionSummaryDetails;
  /** Bookkeeping copy; the durable message body remains the display authority. */
  readonly droppedSummaryLine?: string;
  readonly fallbackKind: CompactionSummaryPayload['fallbackKind'];
}

/** The agent host's code for a summary outside the required five sections. */
const SUMMARY_INVALID_CODE = 'compaction.summary-invalid';

const REASON_LABELS: Record<CompactionSummaryDetails['reason'], string> = {
  'context-overflow': 'After the provider reported a context overflow',
  'pre-request': 'Before the request, to keep it inside the context budget',
};

function kindLabel(
  fallbackKind: CompactionSummaryPayload['fallbackKind'],
  details: CompactionSummaryDetails | undefined
): string {
  if (fallbackKind === 'agentic') {
    return 'AI-generated summary';
  }
  const failure = details?.summarizerFailure;
  if (failure?.code === SUMMARY_INVALID_CODE) {
    return 'Deterministic compaction (the summarizer’s answer did not match the required format)';
  }
  if (failure) {
    return 'Deterministic compaction (the summarizer failed)';
  }
  // A fallback committed before its failure was recorded: a receipt means the answer was refused.
  return details?.modelId === undefined
    ? 'Deterministic compaction (no summarization model ran)'
    : 'Deterministic compaction (the summarizer’s answer did not match the required format)';
}

function CompactionDetails({ details }: { readonly details: CompactionSummaryDetails }) {
  const rows: { id: string; label: string; value: string }[] = [
    { id: 'reason', label: 'Reason', value: REASON_LABELS[details.reason] },
    {
      id: 'turns',
      label: 'Compacted',
      value: `${details.turnsCompacted} ${details.turnsCompacted === 1 ? 'turn' : 'turns'}`,
    },
    ...(details.modelId === undefined
      ? []
      : [{ id: 'model', label: 'Summarizer', value: details.modelId }]),
    ...(details.summarizerFailure === undefined
      ? []
      : [
          {
            id: 'summarizer-failure',
            label: 'Summarizer failure',
            value:
              details.summarizerFailure.correlationId === undefined
                ? details.summarizerFailure.code
                : `${details.summarizerFailure.code} · Reference: ${details.summarizerFailure.correlationId}`,
          },
        ]),
    ...(details.usage === undefined
      ? []
      : [
          {
            id: 'usage',
            label: 'Usage',
            value: `${details.usage.inputTokens.toLocaleString('en-US')} in · ${details.usage.outputTokens.toLocaleString('en-US')} out`,
          },
        ]),
  ];
  return (
    <dl className="mb-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-px text-xs">
      {rows.map((row) => (
        <div className="contents" data-testid={`compaction-summary-${row.id}`} key={row.id}>
          <dt className="text-muted-foreground">{row.label}</dt>
          <dd className="break-words text-foreground/80 tabular-nums">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Full-width system treatment for the durable assistant message that replaces
 * older provider context. Its children are the message's real content parts,
 * so the summary stays selectable, copyable, and model-visible instead of
 * being replaced by metadata-derived display text.
 */
export function CompactionSummaryCard(props: CompactionSummaryCardProps) {
  const { children, details, fallbackKind } = props;

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
        <p className="mb-2 font-medium text-foreground/80 text-xs">
          {kindLabel(fallbackKind, details)}
        </p>
        {details && <CompactionDetails details={details} />}
        <div className="break-words text-sm leading-6">{children}</div>
      </div>
    </section>
  );
}

CompactionSummaryCard.displayName = 'CompactionSummaryCard';
